//--------------------------------------------------
// 基本設定
//--------------------------------------------------
const noteNames12 = ["C","C#","D","Eb","E","F","F#","G","G#","A","Bb","B"];
const noteNames7  = ["C","D","E","F","G","A","B"];

let scaleMode   = "12";      // "12" or "7"
let playMode    = "normal";  // "normal", "12tet", "chord"
let octave      = 4;
let currentWave = "sine";
const maxCent   = 100;

//--------------------------------------------------
// Audio
//--------------------------------------------------
let audioCtx    = null;
let masterGain  = null;
const active    = {};   // { [noteName]: {osc, g} }

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.3;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

//--------------------------------------------------
// 周波数計算
//--------------------------------------------------
const semi = {
  "C":0,"C#":1,"D":2,"Eb":3,"E":4,"F":5,
  "F#":6,"G":7,"G#":8,"A":9,"Bb":10,"B":11
};

function freq(note, oct, cent) {
  const midi = 12 * (oct + 1) + semi[note];
  if (playMode === "12tet") cent = 0;   // 12平均律モードでは常に cent=0
  return 440 * Math.pow(2, (midi - 69) / 12 + cent / 1200);
}

//--------------------------------------------------
// 音開始・停止
//--------------------------------------------------
function startNote(note, cent = 0) {
  initAudio();
  if (active[note]) return;

  const osc = audioCtx.createOscillator();
  const g   = audioCtx.createGain();

  switch (currentWave) {
    case "softsaw":
      osc.type = "sawtooth";
      g.gain.value = 0.12;
      break;
    case "softsquare":
      osc.type = "square";
      g.gain.value = 0.10;
      break;
    default:
      osc.type = currentWave;
      g.gain.value = 0.18;
      break;
  }

  osc.frequency.value = freq(note, octave, cent);

  g.gain.value = 0;
  g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02);

  osc.connect(g).connect(masterGain);
  osc.start();

  active[note] = { osc, g, cent };
}

function stopNote(note) {
  const v = active[note];
  if (!v) return;

  const t = audioCtx.currentTime;
  v.g.gain.setTargetAtTime(0, t, 0.03);
  v.osc.stop(t + 0.05);
  delete active[note];
}

function updateCent(note, cent) {
  const v = active[note];
  if (!v) return;
  v.cent = cent;
  v.osc.frequency.value = freq(note, octave, cent);
}

//--------------------------------------------------
// UI生成
//--------------------------------------------------
function rebuild() {
  const area = document.getElementById("keyboard-area");
  if (!area) return;

  area.innerHTML = "";

  const notes = (scaleMode === "12") ? noteNames12 : noteNames7;
  document.documentElement.style.setProperty("--columns", notes.length);

  notes.forEach(note => {
    const col   = document.createElement("div");
    const track = document.createElement("div");
    const thumb = document.createElement("div");
    const lab   = document.createElement("div");

    col.className   = "key-column";
    track.className = "slider-track";
    thumb.className = "slider-thumb";
    lab.className   = "cent-label";

    thumb.textContent = note;
    lab.textContent   = "0.0 cent";

    // --- 常にボタン（thumb）は表示する ---
thumb.style.display = "flex";

// --- 12TETのときは thumb を中央固定（スライダー無効化） ---
if (playMode === "12tet") {
    thumb.style.top = "50%";
    label.textContent = "0.0 cent";
}



    track.appendChild(thumb);
    col.appendChild(track);
    col.appendChild(lab);
    area.appendChild(col);

    bindSlider(note, thumb, track, lab);
  });
}

//--------------------------------------------------
// スライダー挙動
//--------------------------------------------------
function bindSlider(note, thumb, track, label) {
  let dragging      = false;
  let draggingTarget = null;   // "thumb" or "track"
  let pid           = null;

  function calc(y) {
    const r = track.getBoundingClientRect();
    y = Math.max(r.top, Math.min(r.bottom, y));
    const t    = (y - r.top) / r.height;
    const cent = (0.5 - t) / 0.5 * maxCent;  // 中央0, 上+maxCent, 下-maxCent
    return { t, cent };
  }

  function apply(t, cent) {
    thumb.style.top = `${t * 100}%`;
    label.textContent = `${cent.toFixed(1)} cent`;
    updateCent(note, cent);
  }

  //------------------------------------------------
  // thumb: pointerdown
  //------------------------------------------------
  thumb.addEventListener("pointerdown", e => {
    // コードモード：ON/OFFトグルのみ（押しっぱなしで鳴り続ける）
    if (playMode === "chord") {
      initAudio();
      if (active[note]) {
        stopNote(note);
        thumb.classList.remove("chord-active");
      } else {
        startNote(note, 0);
        thumb.classList.add("chord-active");
      }
      return;
    }

    // normal / 12tet モード：押している間だけ鳴らす
    initAudio();
    dragging       = true;
    draggingTarget = "thumb";
    pid            = e.pointerId;
    thumb.setPointerCapture(pid);

    if (!active[note]) startNote(note, 0);
  });

  //------------------------------------------------
  // thumb: pointermove（normalでスライダー変更）
  //------------------------------------------------
  thumb.addEventListener("pointermove", e => {
    if (!dragging || pid !== e.pointerId) return;
    if (draggingTarget !== "thumb") return;

    // 12TETモードでは pitch 変化しないのでスライダーも動かさない
    if (playMode === "12tet") return;

    const { t, cent } = calc(e.clientY);
    apply(t, cent);
  });

  //------------------------------------------------
  // thumb: pointerup
  //------------------------------------------------
  thumb.addEventListener("pointerup", e => {
    if (!dragging || pid !== e.pointerId) return;
    if (draggingTarget !== "thumb") return;

    dragging       = false;
    draggingTarget = null;
    thumb.releasePointerCapture(pid);
    pid = null;

    // chord モードは上で return 済みなのでここには来ない

    // normal / 12tet → ボタンを離したらリセット＆停止
    thumb.style.transition = "top .15s";
    thumb.style.top        = "50%";
    setTimeout(() => thumb.style.transition = "", 150);

    label.textContent = "0.0 cent";
    updateCent(note, 0);
    stopNote(note);
  });

  thumb.addEventListener("pointercancel", e => {
    if (!dragging || pid !== e.pointerId) return;
    dragging       = false;
    draggingTarget = null;
    thumb.releasePointerCapture(pid);
    pid = null;

    if (playMode === "chord") return;

    thumb.style.transition = "top .15s";
    thumb.style.top        = "50%";
    setTimeout(() => thumb.style.transition = "", 150);

    label.textContent = "0.0 cent";
    updateCent(note, 0);
    stopNote(note);
  });

  //------------------------------------------------
  // track: pointerdown
  //  - normal/12tet: 押している間だけ鳴る
  //  - chord: ON になっている音のピッチだけ変える
  //------------------------------------------------
  track.addEventListener("pointerdown", e => {
    initAudio();

    if (playMode !== "chord") {
      // normal / 12TET → 押している間だけ鳴らす
      if (!active[note]) startNote(note, 0);
    }
    // chordモードでは、すでにONの時だけ音を鳴らしながら
    // スライダーを動かす（active[note] が無ければ無音で位置だけ変える）

    dragging       = true;
    draggingTarget = "track";
    pid            = e.pointerId;
    track.setPointerCapture(pid);

    if (playMode !== "12tet") {
      const { t, cent } = calc(e.clientY);
      apply(t, cent);
    }
  });

  //------------------------------------------------
  // track: pointermove
  //------------------------------------------------
  track.addEventListener("pointermove", e => {
    if (!dragging || pid !== e.pointerId) return;
    if (draggingTarget !== "track") return;

    if (playMode === "12tet") return; // 12TET は cent を変えない

    const { t, cent } = calc(e.clientY);
    apply(t, cent);
  });

  //------------------------------------------------
  // track: pointerup
  //------------------------------------------------
  track.addEventListener("pointerup", e => {
    if (!dragging || pid !== e.pointerId) return;
    if (draggingTarget !== "track") return;

    dragging       = false;
    draggingTarget = null;
    track.releasePointerCapture(pid);
    pid = null;

    if (playMode === "chord") {
      // chordモードではスライダー位置とcent値は保持したまま
      return;
    }

    // normal / 12TET はボタンを離したらリセット＆停止
    thumb.style.transition = "top .15s";
    thumb.style.top        = "50%";
    setTimeout(() => thumb.style.transition = "", 150);

    label.textContent = "0.0 cent";
    updateCent(note, 0);
    stopNote(note);
  });

  track.addEventListener("pointercancel", e => {
    if (!dragging || pid !== e.pointerId) return;
    if (draggingTarget !== "track") return;

    dragging       = false;
    draggingTarget = null;
    track.releasePointerCapture(pid);
    pid = null;

    if (playMode === "chord") return;

    thumb.style.transition = "top .15s";
    thumb.style.top        = "50%";
    setTimeout(() => thumb.style.transition = "", 150);

    label.textContent = "0.0 cent";
    updateCent(note, 0);
    stopNote(note);
  });
}

//--------------------------------------------------
// モード切替
//--------------------------------------------------
function setPlayMode(m) {
  playMode = m;
  rebuild();
}

function setScaleMode(m) {
  scaleMode = m;
  rebuild();
}

function changeWave() {
  const sel = document.getElementById("waveSelector");
  if (!sel) return;
  currentWave = sel.value;
}

function octUp() {
  octave++;
  const lab = document.getElementById("oct-label");
  if (lab) lab.textContent = octave;
}

function octDown() {
  octave--;
  const lab = document.getElementById("oct-label");
  if (lab) lab.textContent = octave;
}

//--------------------------------------------------
// unlockAudio（Safari / iPhone 用）
//--------------------------------------------------
function unlockAudio() {
  initAudio();
  const unlock = document.getElementById("unlock");
  const topBar = document.getElementById("top-bar");
  if (unlock) unlock.style.display = "none";
  if (topBar) topBar.style.display = "flex";
  rebuild();
}

//--------------------------------------------------
// 初期化
//--------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  const lab = document.getElementById("oct-label");
  if (lab) lab.textContent = octave;
  rebuild();
});
