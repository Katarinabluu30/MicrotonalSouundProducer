//--------------------------------------------------
// 基本設定
//--------------------------------------------------
const noteNames12 = ["C","C#","D","Eb","E","F","F#","G","G#","A","Bb","B"];
const noteNames7  = ["C","D","E","F","G","A","B"];

let scaleMode = "12";      // 7音/12音
let playMode  = "normal";  // normal / chord / 12tet
let octave    = 4;
let currentWave = "sine";
const maxCent = 100;

//--------------------------------------------------
// Audio
//--------------------------------------------------
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.gain.value = 0.25;
masterGain.connect(audioCtx.destination);

// ノート保持
const active = {};   // noteName → {osc, gain, cent}

//--------------------------------------------------
// Freq
//--------------------------------------------------
const semiMap = {
  "C":0,"C#":1,"D":2,"Eb":3,"E":4,"F":5,
  "F#":6,"G":7,"G#":8,"A":9,"Bb":10,"B":11
};

function freqOf(note, oct, cent) {
  const semi = semiMap[note];
  const midi = 12 * (oct + 1) + semi;
  let c = cent;
  if (playMode === "12tet") c = 0;
  return 440 * Math.pow(2, (midi - 69) / 12 + c / 1200);
}

//--------------------------------------------------
// Start / Stop
//--------------------------------------------------
function startNote(note, cent) {
  if (active[note]) return;

  const osc = audioCtx.createOscillator();
  const g   = audioCtx.createGain();

  // 波形
  if (currentWave === "softsaw") {
    osc.type = "sawtooth";
    g.gain.value = 0.15;
  } else if (currentWave === "softsquare") {
    osc.type = "square";
    g.gain.value = 0.12;
  } else {
    osc.type = currentWave; // sine / square / sawtooth / triangle
    g.gain.value = 0.18;
  }

  osc.frequency.value = freqOf(note, octave, cent);

  g.gain.setValueAtTime(0, audioCtx.currentTime);
  g.gain.linearRampToValueAtTime(0.28, audioCtx.currentTime + 0.03);

  osc.connect(g).connect(masterGain);
  osc.start();

  active[note] = { osc, g, cent };
}

function stopNote(note) {
  const v = active[note];
  if (!v) return;

  const now = audioCtx.currentTime;
  v.g.gain.cancelScheduledValues(now);
  v.g.gain.setTargetAtTime(0, now, 0.04);
  v.osc.stop(now + 0.06);

  delete active[note];
}

function updateCent(note, cent) {
  const v = active[note];
  if (!v) return;
  v.cent = cent;
  v.osc.frequency.value = freqOf(note, octave, cent);
}

//--------------------------------------------------
// UI生成
//--------------------------------------------------
function rebuild() {
  const area = document.getElementById("keyboard-area");
  area.innerHTML = "";

  const notes = (scaleMode === "12") ? noteNames12 : noteNames7;
  document.documentElement.style.setProperty("--columns", notes.length);

  notes.forEach(note => {
    const col = document.createElement("div");
    col.className = "key-column";

    const track = document.createElement("div");
    track.className = "slider-track";

    const thumb = document.createElement("div");
    thumb.className = "slider-thumb";
    thumb.textContent = note;

    const label = document.createElement("div");
    label.className = "cent-label";
    label.textContent = "0.0 cent";

    col.appendChild(track);
    track.appendChild(thumb);
    col.appendChild(label);
    area.appendChild(col);

    attachSlider(note, thumb, track, label);
  });
}

//--------------------------------------------------
// スライダー挙動
//--------------------------------------------------
function attachSlider(note, thumb, track, label) {

  //------------------------------------------------
  // ① 12TET モード → スライダー完全無効化
  //------------------------------------------------
  if (playMode === "12tet") {
    track.classList.add("hidden");
    thumb.style.display = "none";
    label.textContent = "";
    return;   // ← ここが最重要
  }

  //------------------------------------------------
  // ② それ以外のモード（normal / chord）の処理
  //------------------------------------------------
  let dragging = false;
  let pointerId = null;

  function calc(eY) {
    const rect = track.getBoundingClientRect();
    let y = Math.min(rect.bottom, Math.max(rect.top, eY));
    const t = (y - rect.top) / rect.height;
    const r = (0.5 - t) / 0.5;
    return { t, cent: r * maxCent };
  }

  function apply(t, cent) {
    thumb.style.top = `${t * 100}%`;
    label.textContent = `${cent.toFixed(1)} cent`;
    updateCent(note, cent);
  }

  // 初期表示復帰
  thumb.style.display = "flex";
  label.textContent = "0.0 cent";

  //------------------------------------------------
  // pointerdown（ドラッグ開始）
  //------------------------------------------------
  thumb.addEventListener("pointerdown", (e) => {
    audioCtx.resume();

    dragging = true;
    pointerId = e.pointerId;
    thumb.setPointerCapture(pointerId);

    if (playMode !== "chord" && !active[note]) {
      startNote(note, 0);
    }
  });

  //------------------------------------------------
  // pointermove（ドラッグ中）
  //------------------------------------------------
  thumb.addEventListener("pointermove", (e) => {
    if (!dragging || pointerId !== e.pointerId) return;

    const { t, cent } = calc(e.clientY);
    apply(t, cent);
  });

  //------------------------------------------------
  // pointerup / pointercancel（ドラッグ終了）
  //------------------------------------------------
  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);

  function endDrag(e) {
    if (!dragging || pointerId !== e.pointerId) return;

    dragging = false;
    thumb.releasePointerCapture(pointerId);
    pointerId = null;

    // chordモード → 音を保持
    if (playMode === "chord") return;

    // normal モード → 0cent に戻す
    thumb.style.transition = "top 0.15s";
    thumb.style.top = "50%";
    setTimeout(() => thumb.style.transition = "", 160);

    label.textContent = "0.0 cent";
    updateCent(note, 0);
    stopNote(note);
  }

  //------------------------------------------------
  // trackタップで音を鳴らす
  //------------------------------------------------
  track.addEventListener("pointerdown", (e) => {
    audioCtx.resume();

    if (!active[note]) {
      startNote(note, 0);
    }

    const { t, cent } = calc(e.clientY);
    apply(t, cent);

    if (playMode === "normal") {
      setTimeout(() => {
        thumb.style.transition = "top 0.15s";
        thumb.style.top = "50%";
        setTimeout(()=> thumb.style.transition="", 160);
        label.textContent = "0.0 cent";
        updateCent(note, 0);
        stopNote(note);
      }, 120);
    }
  });

  //------------------------------------------------
  // chordモード：トグルでON/OFF
  //------------------------------------------------
  thumb.addEventListener("pointerdown", (e) => {
    if (playMode !== "chord") return;

    e.preventDefault();
    audioCtx.resume();

    if (active[note]) {
      stopNote(note);
      thumb.classList.remove("chord-active");
      return;
    }

    startNote(note, 0);
    thumb.classList.add("chord-active");
  });
}

//--------------------------------------------------
// Mode / Scale
//--------------------------------------------------
function setPlayMode(mode) {
  playMode = mode;
  rebuild();
}

function setScaleMode(mode) {
  scaleMode = mode;
  rebuild();
}

//--------------------------------------------------
// octave
//--------------------------------------------------
function octUp() {
  octave++;
  document.getElementById("oct-label").textContent = octave;
}
function octDown() {
  octave--;
  document.getElementById("oct-label").textContent = octave;
}

//--------------------------------------------------
// wave
//--------------------------------------------------
function changeWave() {
  currentWave = document.getElementById("waveSelector").value;
}

//--------------------------------------------------
// fullscreen
//--------------------------------------------------
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

//--------------------------------------------------
// init
//--------------------------------------------------
document.getElementById("oct-label").textContent = octave;
rebuild();
