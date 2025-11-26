// =====================
// 基本設定
// =====================

const noteNames12 = ["C","C#","D","Eb","E","F","F#","G","G#","A","Bb","B"];
const noteNames7  = ["C","D","E","F","G","A","B"];

let scaleMode = "12";          // "12" or "7"
let playMode  = "normal";      // "normal", "12tet", "chord"
let octave    = 4;             // オクターブ
const maxCent = 100;           // ±100cent

// ノートごとの現在の cent 値（chord モードで保持するため）
const noteCentState = {};      // { "C": 0, "C#": 12.3, ... }

// =====================
// Web Audio 初期化
// =====================

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.gain.value = 0.25;
masterGain.connect(audioCtx.destination);

// iPhone / スマホ対策：最初のタッチ / クリックで AudioContext を必ず有効化
function enableAudio() {
  if (audioCtx.state !== "running") {
    audioCtx.resume();
  }
}
document.addEventListener("touchstart", enableAudio, { passive: true });
document.addEventListener("mousedown", enableAudio);

// =====================
// WAV レコーダ（16bit PCM mono）
// =====================

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
    const bytesPerSample = 2;
    const dataSize = samples * bytesPerSample;

    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    let offset = 0;
    const writeString = (s) => {
      for (let i = 0; i < s.length; i++) {
        view.setUint8(offset++, s.charCodeAt(i));
      }
    };

    // RIFF header
    writeString("RIFF");
    view.setUint32(offset, 36 + dataSize, true); offset += 4;
    writeString("WAVE");

    // fmt chunk
    writeString("fmt ");
    view.setUint32(offset, 16, true); offset += 4;   // chunk size
    view.setUint16(offset, 1, true);  offset += 2;   // PCM
    view.setUint16(offset, 1, true);  offset += 2;   // mono
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, sampleRate * bytesPerSample, true); offset += 4;
    view.setUint16(offset, bytesPerSample, true); offset += 2;
    view.setUint16(offset, 8 * bytesPerSample, true); offset += 2;

    // data chunk
    writeString("data");
    view.setUint32(offset, dataSize, true); offset += 4;

    this.buffer.forEach(block => {
      for (let i = 0; i < block.length; i++) {
        const s = Math.max(-1, Math.min(1, block[i]));
        const v = s < 0 ? s * 0x8000 : s * 0x7fff;
        view.setInt16(offset, v, true);
        offset += 2;
      }
    });

    return new Blob([view], { type: "audio/wav" });
  }
}

const recorder = new WavRecorder(audioCtx);
masterGain.connect(recorder.input);

// =====================
// ボイス管理
// =====================

const activeVoices = {};  // noteName -> { osc, gain, cent }

const semitoneMap = {
  "C":0, "C#":1, "D":2, "Eb":3, "E":4, "F":5,
  "F#":6, "G":7, "G#":8, "A":9, "Bb":10, "B":11
};

function noteToFreq(noteName, oct, cent = 0) {
  const semi = semitoneMap[noteName];
  const midi = 12 * (oct + 1) + semi;   // C4 = 60
  let c = cent;

  // 12TET モードは microtonal 無効（見た目だけ動いて音程は平均律）
  if (playMode === "12tet") {
    c = 0;
  }

  const base = 440 * Math.pow(2, (midi - 69) / 12);
  return base * Math.pow(2, c / 1200);
}

function startNote(noteName, cent) {
  if (activeVoices[noteName]) return;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.value = noteToFreq(noteName, octave, cent);
  gain.gain.value = 0.0;

  osc.connect(gain).connect(masterGain);

  const now = audioCtx.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(0.0, now);
  gain.gain.linearRampToValueAtTime(0.3, now + 0.02);

  osc.start();

  activeVoices[noteName] = { osc, gain, cent };
}

function stopNote(noteName) {
  const v = activeVoices[noteName];
  if (!v) return;

  const now = audioCtx.currentTime;
  v.gain.gain.cancelScheduledValues(now);
  v.gain.gain.linearRampToValueAtTime(0.0, now + 0.05);
  v.osc.stop(now + 0.06);

  delete activeVoices[noteName];
}

function setNoteCent(noteName, cent) {
  const v = activeVoices[noteName];
  if (!v) return;
  v.cent = cent;
  v.osc.frequency.value = noteToFreq(noteName, octave, cent);
}

// =====================
// キーボード生成
// =====================

function centToT(cent) {
  // cent: -maxCent〜+maxCent を 0〜1 に
  const ratio = cent / maxCent;     // -1〜+1
  const t = 0.5 - 0.5 * ratio;      // -1→1 に対して 1→0, 中央=0.5
  return Math.min(1, Math.max(0, t));
}

function rebuildKeyboard() {
  const area = document.getElementById("keyboard-area");
  area.innerHTML = "";

  const notes = (scaleMode === "12") ? noteNames12 : noteNames7;
  document.documentElement.style.setProperty("--columns", notes.length);

  notes.forEach(noteName => {
    if (noteCentState[noteName] == null) {
      noteCentState[noteName] = 0;
    }

    const col = document.createElement("div");
    col.className = "key-column";

    const track = document.createElement("div");
    track.className = "slider-track";

    const thumb = document.createElement("div");
    thumb.className = "slider-thumb";
    thumb.textContent = noteName;

    const centLabel = document.createElement("div");
    centLabel.className = "cent-label";
    centLabel.textContent = `${noteCentState[noteName].toFixed(1)} cent`;

    // cent の状態に合わせて thumb の位置を初期化
    const t0 = centToT(noteCentState[noteName]);
    thumb.style.top = `${t0 * 100}%`;

    track.appendChild(thumb);
    col.appendChild(track);
    col.appendChild(centLabel);
    area.appendChild(col);

    setupThumbInteraction(noteName, thumb, track, centLabel);
  });
}

// =====================
// スライダー型ボタンの挙動
//
// normal / 12tet:
//   ・押している間だけ鳴る
//   ・離したら止まり、0 cent に戻る
//
// chord:
//   ・押すたびに ON/OFF トグル
//   ・ON の間はドラッグでピッチベンド（centを保持）
//   ・指を離しても音は止まらない（もう一度押して止める）
// =====================

function setupThumbInteraction(noteName, thumb, track, centLabel) {
  let dragging = false;
  let pointerId = null;
  let trackRect = null;

  function calcFromClientY(clientY) {
    const rect = trackRect || track.getBoundingClientRect();
    trackRect = rect;

    let y = clientY;
    if (y < rect.top) y = rect.top;
    if (y > rect.bottom) y = rect.bottom;

    const t = (y - rect.top) / rect.height;  // 0〜1
    const ratio = (0.5 - t) / 0.5;           // -1〜+1
    let cent = ratio * maxCent;

    if (cent >  maxCent) cent =  maxCent;
    if (cent < -maxCent) cent = -maxCent;

    return { t, cent };
  }

  function applyVisualAndPitch(t, cent) {
    thumb.style.top = `${t * 100}%`;
    centLabel.textContent = `${cent.toFixed(1)} cent`;
    noteCentState[noteName] = cent;
    setNoteCent(noteName, cent);
  }

  // pointerdown: 押し始め
  thumb.addEventListener("pointerdown", (e) => {
    enableAudio();
    trackRect = track.getBoundingClientRect();

    if (playMode === "chord") {
      // chord モード：ON/OFFトグル
      if (activeVoices[noteName]) {
        // 既に鳴っていれば OFF
        stopNote(noteName);
        thumb.style.background = "#9ad8ff";
        dragging = false;
        return;
      } else {
        // 現在の cent で ON
        const c = noteCentState[noteName] || 0;
        startNote(noteName, c);
        thumb.style.background = "#66b6ff";
        // この状態でドラッグすればピッチベンド
      }
    } else {
      // normal / 12TET：0 centからスタート
      noteCentState[noteName] = 0;
      centLabel.textContent = "0.0 cent";
      thumb.style.top = "50%";

      startNote(noteName, 0);
      thumb.style.background = "#66b6ff";
    }

    dragging = true;
    pointerId = e.pointerId;
    thumb.setPointerCapture(pointerId);
  });

  // pointermove: 全モードでピッチ変更（12TETは見た目だけ）
  thumb.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const { t, cent } = calcFromClientY(e.clientY);
    applyVisualAndPitch(t, cent);
  });

  // pointerup / cancel: finger 離したとき
  function endDrag(e) {
    if (e.pointerId !== pointerId) return;
    dragging = false;
    thumb.releasePointerCapture(pointerId);
    pointerId = null;

    if (playMode === "chord") {
      // chordモードでは、離しても音は鳴りっぱなし
      return;
    }

    // normal / 12TET：音を止めて0 centへ戻す
    stopNote(noteName);
    noteCentState[noteName] = 0;
    centLabel.textContent = "0.0 cent";

    thumb.style.transition = "top 0.15s ease-out";
    thumb.style.top = "50%";
    setTimeout(() => {
      thumb.style.transition = "";
    }, 180);
    thumb.style.background = "#9ad8ff";
  }

  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);

  // トラックを直接タップしたとき（normal / 12TETのみ短く鳴らす）
  track.addEventListener("pointerdown", (e) => {
    if (playMode === "chord") {
      // chordモードでは trackタップは無効（誤操作防止）
      return;
    }

    enableAudio();
    trackRect = track.getBoundingClientRect();

    const { t, cent } = calcFromClientY(e.clientY);
    applyVisualAndPitch(t, cent);

    startNote(noteName, cent);
    thumb.style.background = "#66b6ff";

    const endShort = () => {
      stopNote(noteName);
      noteCentState[noteName] = 0;
      centLabel.textContent = "0.0 cent";

      thumb.style.transition = "top 0.15s ease-out";
      thumb.style.top = "50%";
      setTimeout(() => {
        thumb.style.transition = "";
      }, 180);
      thumb.style.background = "#9ad8ff";

      track.removeEventListener("pointerup", endShort);
      track.removeEventListener("pointerleave", endShort);
      track.removeEventListener("pointercancel", endShort);
    };

    track.addEventListener("pointerup", endShort);
    track.addEventListener("pointerleave", endShort);
    track.addEventListener("pointercancel", endShort);
  });
}

// =====================
// モード切替 / オクターブ / フルスクリーン
// =====================

function setPlayMode(mode) {
  playMode = mode;
}

function setScaleMode(mode) {
  scaleMode = mode;  // "12" or "7"
  rebuildKeyboard();
}

function octUp() {
  octave++;
  document.getElementById("oct-label").textContent = octave;
}

function octDown() {
  octave--;
  document.getElementById("oct-label").textContent = octave;
}

function toggleFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement) {
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (el.msRequestFullscreen) el.msRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    else if (document.msExitFullscreen) document.msExitFullscreen();
  }
}

// =====================
// WAV録音制御
// =====================

function startRecording() {
  recorder.start();
  console.log("WAV録音開始");
}

function stopRecording() {
  const blob = recorder.stop();
  console.log("WAV録音停止");

  const url = URL.createObjectURL(blob);
  const link = document.getElementById("downloadLink");
  link.href = url;
  link.download = "recording.wav";
  link.style.display = "inline-block";
  link.textContent = "recording.wav を保存";
}

// =====================
// 初期化
// =====================

document.getElementById("oct-label").textContent = octave;
rebuildKeyboard();
