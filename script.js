//--------------------------------------------------
// 基本設定
//--------------------------------------------------
const noteNames12 = ["C","C#","D","Eb","E","F","F#","G","G#","A","Bb","B"];
const noteNames7  = ["C","D","E","F","G","A","B"];

let scaleMode = "12";      // "12" or "7"
let playMode  = "normal";  // "normal" | "chord" | "12tet"
let octave    = 4;
let currentWave = "sine";
const maxCent = 100;

//--------------------------------------------------
// Web Audio & WAVレコーダ
//--------------------------------------------------
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// メイン音量
const masterGain = audioCtx.createGain();
masterGain.gain.value = 0.25;

// --- WAV レコーダ（16bit PCM mono） ---
class WavRecorder {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffer = [];
    this.recording = false;

    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (!this.recording) return;
      const input = e.inputBuffer.getChannelData(0);
      this.buffer.push(new Float32Array(input));
    };

    this.input = this.processor;
    this.processor.connect(ctx.destination);
  }

  start() {
    this.buffer = [];
    this.recording = true;
  }

  stop() {
    this.recording = false;
    return this.exportWav();
  }

  exportWav() {
    const sampleRate = this.ctx.sampleRate;
    const samples = this.buffer.reduce((sum, arr) => sum + arr.length, 0);
    const bytesPerSample = 2; // 16bit
    const dataSize = samples * bytesPerSample;

    const buffer = new ArrayBuffer(44 + dataSize);
    const view   = new DataView(buffer);

    let offset = 0;
    function writeString(s) {
      for (let i = 0; i < s.length; i++) {
        view.setUint8(offset++, s.charCodeAt(i));
      }
    }

    // RIFF
    writeString("RIFF");
    view.setUint32(offset, 36 + dataSize, true); offset += 4;
    writeString("WAVE");

    // fmt
    writeString("fmt ");
    view.setUint32(offset, 16, true); offset += 4;
    view.setUint16(offset, 1, true); offset += 2;   // PCM
    view.setUint16(offset, 1, true); offset += 2;   // mono
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, sampleRate * bytesPerSample, true); offset += 4;
    view.setUint16(offset, bytesPerSample, true); offset += 2;
    view.setUint16(offset, 8 * bytesPerSample, true); offset += 2;

    // data
    writeString("data");
    view.setUint32(offset, dataSize, true); offset += 4;

    // PCM データ
    this.buffer.forEach(block => {
      for (let i = 0; i < block.length; i++) {
        const s = Math.max(-1, Math.min(1, block[i]));
        const v = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(offset, v, true);
        offset += 2;
      }
    });

    return new Blob([view], { type: "audio/wav" });
  }
}

// master → recorder → destination
const recorder = new WavRecorder(audioCtx);
masterGain.connect(recorder.input);

//--------------------------------------------------
// 発音管理
//--------------------------------------------------
const active = {};   // noteName -> { osc, g, cent }

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

function startNote(note, cent) {
  if (active[note]) return;

  const osc = audioCtx.createOscillator();
  const g   = audioCtx.createGain();

  if (currentWave === "softsaw") {
    osc.type = "sawtooth";
    g.gain.value = 0.14;
  } else if (currentWave === "softsquare") {
    osc.type = "square";
    g.gain.value = 0.12;
  } else {
    osc.type = currentWave; // sine / square / sawtooth / triangle
    g.gain.value = 0.20;
  }

  osc.frequency.value = freqOf(note, octave, cent);

  const now = audioCtx.currentTime;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.28, now + 0.03);

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
// スライダー & 鍵盤挙動
//--------------------------------------------------
function attachSlider(note, thumb, track, label) {

  //------------------------------------------------
  // ① 12TETモード → 鍵盤ボタンだけ（ピッチベンドなし）
  //------------------------------------------------
  if (playMode === "12tet") {
    // 見た目はそのまま、中央固定・cent表示なし
    thumb.style.top = "50%";
    label.textContent = "";

    function keyDown(e) {
      audioCtx.resume();
      e.preventDefault();

      if (playMode === "chord") {
        // トグルON/OFF
        if (active[note]) {
          stopNote(note);
          thumb.classList.remove("chord-active");
        } else {
          startNote(note, 0);
          thumb.classList.add("chord-active");
        }
      } else { // normal
        if (!active[note]) startNote(note, 0);
      }
    }

    function keyUp(e) {
      if (playMode === "normal") {
        stopNote(note);
      }
    }

    // thumb & track どちらを押しても同じ
    ["pointerdown"].forEach(ev => {
      thumb.addEventListener(ev, keyDown);
      track.addEventListener(ev, keyDown);
    });
    ["pointerup","pointercancel"].forEach(ev => {
      thumb.addEventListener(ev, keyUp);
      track.addEventListener(ev, keyUp);
    });

    return;
  }

  //------------------------------------------------
  // ② normal / chord モード → スライダーあり
  //------------------------------------------------
  let dragging = false;
  let pointerId = null;

  function calc(eY) {
    const rect = track.getBoundingClientRect();
    let y = Math.min(rect.bottom, Math.max(rect.top, eY));
    const t = (y - rect.top) / rect.height;      // 0〜1
    const cent = (0.5 - t) * 2 * maxCent;        // -100〜+100
    return { t, cent };
  }

  function apply(t, cent) {
    thumb.style.top = `${t * 100}%`;
    label.textContent = `${cent.toFixed(1)} cent`;
    updateCent(note, cent);
  }

  // 初期化
  thumb.style.display = "flex";
  thumb.style.top = "50%";
  label.textContent = "0.0 cent";

  // ---- pointerdown（normal:ドラッグ開始 / chord:トグル＆ドラッグ開始） ----
  thumb.addEventListener("pointerdown", (e) => {
    audioCtx.resume();
    e.preventDefault();

    dragging = true;
    pointerId = e.pointerId;
    thumb.setPointerCapture(pointerId);

    if (playMode === "chord") {
      if (active[note]) {
        stopNote(note);
        thumb.classList.remove("chord-active");
      } else {
        startNote(note, 0);
        thumb.classList.add("chord-active");
      }
    } else { // normal
      if (!active[note]) startNote(note, 0);
    }
  });

  // ---- pointermove（どちらのモードでもピッチベンド） ----
  thumb.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const { t, cent } = calc(e.clientY);
    apply(t, cent);
  });

  // ---- pointerup / cancel ----
  function endDrag(e) {
    if (!dragging || e.pointerId !== pointerId) return;

    dragging = false;
    thumb.releasePointerCapture(pointerId);
    pointerId = null;

    if (playMode === "chord") {
      // chordは音を保持、スライダー位置も保持
      return;
    }

    // normal → 0centへ戻して停止
    thumb.style.transition = "top 0.15s";
    thumb.style.top = "50%";
    setTimeout(() => thumb.style.transition = "", 160);

    label.textContent = "0.0 cent";
    updateCent(note, 0);
    stopNote(note);
  }

  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);

  // ---- trackタップで瞬時にそのcentへ（両モード対応） ----
  track.addEventListener("pointerdown", (e) => {
    audioCtx.resume();
    e.preventDefault();

    if (!active[note]) {
      if (playMode === "chord") {
        startNote(note, 0);
        thumb.classList.add("chord-active");
      } else {
        startNote(note, 0);
      }
    }

    const { t, cent } = calc(e.clientY);
    apply(t, cent);

    // normal のショートタップは短く鳴らして戻す
    if (playMode === "normal") {
      setTimeout(() => {
        thumb.style.transition = "top 0.15s";
        thumb.style.top = "50%";
        setTimeout(() => thumb.style.transition = "", 160);
        label.textContent = "0.0 cent";
        updateCent(note, 0);
        stopNote(note);
      }, 120);
    }
  });
}

//--------------------------------------------------
// モード切り替え / スケール切り替え
//--------------------------------------------------
function setPlayMode(mode) {
  playMode = mode;
  rebuild();
}

function setScaleMode(mode) {
  scaleMode = mode; // "12" or "7"
  rebuild();
}

//--------------------------------------------------
// オクターブ
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
// 波形変更
//--------------------------------------------------
function changeWave() {
  currentWave = document.getElementById("waveSelector").value;
}

//--------------------------------------------------
// フルスクリーン
//--------------------------------------------------
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

//--------------------------------------------------
// WAV録音
//--------------------------------------------------
function startRecording() {
  audioCtx.resume();
  recorder.start();
  console.log("WAV Recording Start");
}

function stopRecording() {
  const blob = recorder.stop();
  console.log("WAV Recording Stop");

  const url  = URL.createObjectURL(blob);
  const link = document.getElementById("downloadLink");
  link.href = url;
  link.download = "recording.wav";
  link.style.display = "inline-block";
  link.textContent = "recording.wav を保存";
}

//--------------------------------------------------
// 初期化
//--------------------------------------------------
document.getElementById("oct-label").textContent = octave;
rebuild();
