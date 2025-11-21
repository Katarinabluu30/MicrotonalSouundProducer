// ======================================================
// 設定
// ======================================================

const noteNames12 = ["C","C#","D","Eb","E","F","F#","G","G#","A","Bb","B"];
const noteNames7  = ["C","D","E","F","G","A","B"];

let scaleMode = "12";          // "12" or "7"
let playMode  = "normal";      // "normal", "12tet", "chord"
let octave    = 4;             // 表示用オクターブ
const maxCent = 100;           // ±100 cent

// 現在の音色
let currentWave = "sine";

// ======================================================
// WebAudio 初期化
// ======================================================

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.gain.value = 0.3;

// WAV録音部分は省略（そのまま）=========================================
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
  start(){ this.buffer=[]; this.recording=true; }
  stop(){ this.recording=false; return this.exportWav(); }
  exportWav(){
    const sampleRate = this.ctx.sampleRate;
    const samples = this.buffer.reduce((s,a)=>s+a.length,0);

    const buffer = new ArrayBuffer(44 + samples*2);
    const view = new DataView(buffer);
    let offset=0;
    const w = (s)=>{ for(let i=0;i<s.length;i++) view.setUint8(offset++, s.charCodeAt(i)); };

    w("RIFF");
    view.setUint32(offset, 36 + samples*2, true); offset+=4;
    w("WAVEfmt ");
    view.setUint32(offset,16,true); offset+=4;
    view.setUint16(offset,1,true); offset+=2;
    view.setUint16(offset,1,true); offset+=2;
    view.setUint32(offset,sampleRate,true); offset+=4;
    view.setUint32(offset,sampleRate*2,true); offset+=4;
    view.setUint16(offset,2,true); offset+=2;
    view.setUint16(offset,16,true); offset+=2;
    w("data");
    view.setUint32(offset,samples*2,true); offset+=4;

    this.buffer.forEach(b=>{
      for(let i=0;i<b.length;i++){
        const v=Math.max(-1,Math.min(1,b[i]));
        view.setInt16(offset, v<0?v*0x8000:v*0x7fff,true);
        offset+=2;
      }
    });

    return new Blob([view],{type:"audio/wav"});
  }
}

const recorder = new WavRecorder(audioCtx);
masterGain.connect(recorder.input);
masterGain.connect(audioCtx.destination);

// ======================================================
// ノート管理
// ======================================================

const activeVoices = {}; // noteName -> { nodes…, type…, cent… }

// 半音番号
const semi = { "C":0,"C#":1,"D":2,"Eb":3,"E":4,"F":5,"F#":6,"G":7,"G#":8,"A":9,"Bb":10,"B":11 };

// 周波数計算
function noteToFreq(name,oct,cent=0){
  const midi = 12*(oct+1) + semi[name];
  const base = 440 * Math.pow(2, (midi-69)/12);
  if (["noise_white","noise_pink","noise_brown"].includes(currentWave)) return base; // ピッチ無視
  if (playMode==="12tet") cent = 0;
  return base * Math.pow(2, cent/1200);
}

// ======================================================
// 音色ごとのノード生成
// ======================================================

function createVoice(wave, freq){
  const nodes = {};

  // ----------------------------
  // 1. ノイズ系（ピッチ無関係）
  // ----------------------------
  if (wave === "noise_white" || wave==="noise_pink" || wave==="noise_brown"){
    const bufferSize = 4096;
    const noise = audioCtx.createScriptProcessor(bufferSize,1,1);

    if (wave==="noise_white"){
      noise.onaudioprocess = (e)=>{
        const out = e.outputBuffer.getChannelData(0);
        for(let i=0;i<bufferSize;i++) out[i] = Math.random()*2-1;
      };
    }
    if (wave==="noise_pink"){
      let b0=0,b1=0,b2=0;
      noise.onaudioprocess = (e)=>{
        const out=e.outputBuffer.getChannelData(0);
        for(let i=0;i<bufferSize;i++){
          const w = Math.random()*2-1;
          b0 = 0.997 * b0 + 0.029591 * w;
          b1 = 0.985 * b1 + 0.032534 * w;
          b2 = 0.950 * b2 + 0.048056 * w;
          out[i] = b0 + b1 + b2;
        }
      };
    }
    if (wave==="noise_brown"){
      let last=0;
      noise.onaudioprocess = (e)=>{
        const out=e.outputBuffer.getChannelData(0);
        for(let i=0;i<bufferSize;i++){
          const w=Math.random()*0.2-0.1;
          last = (last + w)/1.02;
          out[i] = last * 3.5;
        }
      };
    }

    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    noise.connect(gain).connect(masterGain);

    nodes.start = ()=>{};
    nodes.stop  = ()=>{};
    nodes.noise = noise;
    nodes.gain  = gain;
    nodes.setFreq = ()=>{}; // 無効

    return nodes;
  }

  // ----------------------------
  // 2. 基本波形
  // ----------------------------
  if (wave==="sine" || wave==="square" || wave==="triangle" || wave==="sawtooth"){
    const osc = audioCtx.createOscillator();
    osc.type = wave;
    osc.frequency.value = freq;

    const gain = audioCtx.createGain();
    gain.gain.value=0;

    osc.connect(gain).connect(masterGain);

    return {
      osc, gain,
      start(){ this.osc.start(); },
      stop(){ this.osc.stop(); },
      setFreq(f){ this.osc.frequency.value=f; }
    };
  }

  // ----------------------------
  // 3. SuperSaw（detune 6本）
  // ----------------------------
  if (wave==="supersaw"){
    const gains=[];
    const oscs=[];
    const rootGain = audioCtx.createGain();
    rootGain.gain.value = 0;

    for(let i=0;i<6;i++){
      const o = audioCtx.createOscillator();
      o.type="sawtooth";
      o.frequency.value=freq;
      o.detune.value = (i-3) * 8; // ±24c

      const g = audioCtx.createGain();
      g.gain.value = 1/6;

      o.connect(g).connect(rootGain);
      oscs.push(o);
      gains.push(g);
    }
    rootGain.connect(masterGain);

    return {
      oscs, rootGain,
      start(){ oscs.forEach(o=>o.start()); },
      stop(){ const t=audioCtx.currentTime+0.05; oscs.forEach(o=>o.stop(t)); },
      setFreq(f){ oscs.forEach(o=>o.frequency.value=f); }
    };
  }

  // ----------------------------
  // 4. PWM（duty modulation）
  // ----------------------------
  if (wave==="pwm"){
    const osc = audioCtx.createOscillator();
    const pwmGain = audioCtx.createGain();
    pwmGain.gain.value = 0.3;

    // PWM: square + LFO
    osc.type="square";
    osc.frequency.value=freq;

    const lfo = audioCtx.createOscillator();
    lfo.frequency.value = 2; // LFO 2Hz

    lfo.connect(pwmGain.gain);
    osc.connect(pwmGain).connect(masterGain);

    return {
      osc, lfo, pwmGain,
      start(){ osc.start(); lfo.start(); },
      stop(){
        const t=audioCtx.currentTime+0.05;
        osc.stop(t); lfo.stop(t);
      },
      setFreq(f){ osc.frequency.value=f; }
    };
  }

  // ----------------------------
  // 5. SoftPad（LPF + slow attack）
  // ----------------------------
  if (wave==="softpad"){
    const osc = audioCtx.createOscillator();
    osc.type="sine";
    osc.frequency.value=freq;

    const gain = audioCtx.createGain();
    gain.gain.value=0;

    const lpf = audioCtx.createBiquadFilter();
    lpf.type="lowpass";
    lpf.frequency.value=1200;

    osc.connect(lpf).connect(gain).connect(masterGain);

    return {
      osc,gain,lpf,
      start(){
        osc.start();
        const now=audioCtx.currentTime;
        gain.gain.linearRampToValueAtTime(0.3, now+0.4);
      },
      stop(){
        const now=audioCtx.currentTime;
        this.gain.gain.linearRampToValueAtTime(0, now+0.3);
        this.osc.stop(now+0.31);
      },
      setFreq(f){ osc.frequency.value=f; }
    };
  }

  // ----------------------------
  // 6. FM系（簡易2OP）
  // ----------------------------
  if (wave.startsWith("fm")){
    const carrier = audioCtx.createOscillator();
    const mod     = audioCtx.createOscillator();
    const modGain = audioCtx.createGain();
    const outGain = audioCtx.createGain();

    carrier.frequency.value=freq;
    modGain.gain.value=0;

    mod.connect(modGain).connect(carrier.frequency);
    carrier.connect(outGain).connect(masterGain);
    outGain.gain.value=0;

    // wave別設定
    if (wave==="fm_bell"){ mod.frequency.value=freq*2; modGain.gain.value=freq*1.5; }
    if (wave==="fm_ep"){   mod.frequency.value=freq;   modGain.gain.value=freq*0.6; }
    if (wave==="fm_bass"){ mod.frequency.value=freq*3; modGain.gain.value=freq*0.8; }
    if (wave==="fm_lead"){ mod.frequency.value=freq;   modGain.gain.value=freq*1.2; }

    return {
      carrier, mod, modGain, outGain,
      start(){ carrier.start(); mod.start(); },
      stop(){
        const t=audioCtx.currentTime+0.05;
        carrier.stop(t); mod.stop(t);
      },
      setFreq(f){
        carrier.frequency.value=f;
        mod.frequency.value = (wave==="fm_bass") ? f*3 : f;
      }
    };
  }

  // ----------------------------
  // 7. 合成音（flute / violin / hollow）
  // ----------------------------
  if (wave==="flute_like"){
    const osc = audioCtx.createOscillator();
    const noiseGain = audioCtx.createGain();
    const oscGain = audioCtx.createGain();
    const band = audioCtx.createBiquadFilter();

    noiseGain.gain.value=0.2;
    oscGain.gain.value=0.8;

    osc.type="sine";
    osc.frequency.value=freq;

    band.type="bandpass";
    band.frequency.value=freq;

    // ノイズ
    const noise = audioCtx.createScriptProcessor(4096,1,1);
    noise.onaudioprocess = (e)=>{
      const out=e.outputBuffer.getChannelData(0);
      for(let i=0;i<4096;i++) out[i] = (Math.random()*2-1)*0.3;
    };

    noise.connect(band).connect(noiseGain).connect(masterGain);
    osc.connect(oscGain).connect(masterGain);

    return {
      osc,noise,oscGain,noiseGain,band,
      start(){ osc.start(); },
      stop(){ const t=audioCtx.currentTime+0.05; osc.stop(t); },
      setFreq(f){ osc.frequency.value=f; band.frequency.value=f; }
    };
  }

  if (wave==="violin_like"){
    const osc = audioCtx.createOscillator();
    osc.type="sawtooth";
    osc.frequency.value=freq;

    const filt = audioCtx.createBiquadFilter();
    filt.type="highpass";
    filt.frequency.value=500;

    const g = audioCtx.createGain();
    g.gain.value=0;

    osc.connect(filt).connect(g).connect(masterGain);

    return{
      osc,g,filt,
      start(){ osc.start(); g.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime+0.1); },
      stop(){ const t=audioCtx.currentTime+0.05; g.gain.linearRampToValueAtTime(0, t); osc.stop(t); },
      setFreq(f){ osc.frequency.value=f; }
    };
  }

  if (wave==="hollow"){
    const s1 = audioCtx.createOscillator();
    const s2 = audioCtx.createOscillator();
    const g  = audioCtx.createGain();

    s1.type="sine";
    s2.type="sine";

    s1.frequency.value=freq;
    s2.frequency.value=freq*1.01;

    g.gain.value=0;

    s1.connect(g).connect(masterGain);
    s2.connect(g);

    return{
      s1,s2,g,
      start(){ s1.start(); s2.start(); g.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime+0.1); },
      stop(){ 
        const t=audioCtx.currentTime+0.05;
        g.gain.linearRampToValueAtTime(0, t);
        s1.stop(t); s2.stop(t);
      },
      setFreq(f){ s1.frequency.value=f; s2.frequency.value=f*1.01; }
    };
  }

  console.error("未対応wave:", wave);
  return null;
}

// ======================================================
// ノート開始・停止
// ======================================================

function startNote(noteName, cent){
  if (activeVoices[noteName]) return;

  const freq = noteToFreq(noteName,octave,cent);
  const voice = createVoice(currentWave, freq);

  activeVoices[noteName] = { voice, cent };

  // Attack
  if (voice.gain){
    const now = audioCtx.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.linearRampToValueAtTime(0.3, now+0.05);
  }

  voice.start();
}

function stopNote(noteName){
  const v = activeVoices[noteName];
  if (!v) return;

  v.voice.stop();
  delete activeVoices[noteName];
}

function setNoteCent(noteName, cent){
  const v = activeVoices[noteName];
  if (!v) return;

  const freq = noteToFreq(noteName, octave, cent);
  if (v.voice.setFreq) v.voice.setFreq(freq);
}


// ======================================================
// キーボード生成（UIは変更なし）
// ======================================================

function rebuildKeyboard(){
  const area=document.getElementById("keyboard-area");
  area.innerHTML="";

  const notes = scaleMode==="12"? noteNames12 : noteNames7;
  document.documentElement.style.setProperty("--columns", notes.length);

  notes.forEach(name=>{
    const col=document.createElement("div");
    col.className="key-column";

    const track=document.createElement("div");
    track.className="slider-track";

    const thumb=document.createElement("div");
    thumb.className="slider-thumb";
    thumb.textContent=name;

    const label=document.createElement("div");
    label.className="cent-label";
    label.textContent="0.0 cent";

    track.appendChild(thumb);
    col.appendChild(track);
    col.appendChild(label);
    area.appendChild(col);

    setupThumb(name, thumb, track, label);
  });
}


// ======================================================
// スライダー型ボタンの挙動
// ======================================================

function setupThumb(noteName, thumb, track, centLabel){
  let dragging=false;
  let pointerId=null;
  let rect=null;

  function calc(eY){
    const r = rect || track.getBoundingClientRect();
    rect=r;
    let y=eY;
    if (y<r.top) y=r.top;
    if (y>r.bottom) y=r.bottom;
    const t=(y-r.top)/r.height;

    const cent = (0.5 - t)/0.5 * maxCent;
    return {t, cent:Math.max(-maxCent,Math.min(maxCent,cent))};
  }

  function updateVisual(t,cent){
    thumb.style.top=(t*100)+"%";
    centLabel.textContent=cent.toFixed(1)+" cent";
    setNoteCent(noteName, cent);
  }

  // pointerdown
  thumb.addEventListener("pointerdown", e=>{
    if (audioCtx.state==="suspended") audioCtx.resume();

    dragging=true;
    pointerId=e.pointerId;
    thumb.setPointerCapture(pointerId);
    rect=track.getBoundingClientRect();

    if (playMode==="chord"){
      // トグル動作
      if (activeVoices[noteName]){
        stopNote(noteName);
        thumb.style.background="#9ad8ff";
        return;
      } else {
        startNote(noteName,0);
        thumb.style.background="#66b6ff";
      }
    } else {
      startNote(noteName,0);
    }
  });

  // pointermove
  thumb.addEventListener("pointermove", e=>{
    if (!dragging || e.pointerId!==pointerId) return;
    if (playMode==="chord") return;

    const {t,cent}=calc(e.clientY);
    updateVisual(t,cent);
  });

  // pointerup
  thumb.addEventListener("pointerup", e=>{
    if (e.pointerId!==pointerId) return;
    dragging=false;
    thumb.releasePointerCapture(pointerId);

    if (playMode!=="chord"){
      stopNote(noteName);
      thumb.style.transition="top .15s";
      thumb.style.top="50%";
      centLabel.textContent="0.0 cent";
      setTimeout(()=>thumb.style.transition="",200);
    }
  });

  // trackタッチ（単音のみ）
  track.addEventListener("pointerdown", e=>{
    if (playMode==="chord") return;
    if (audioCtx.state==="suspended") audioCtx.resume();

    rect=track.getBoundingClientRect();
    const {t,cent}=calc(e.clientY);

    updateVisual(t,cent);
    startNote(noteName,cent);

    const end = ()=>{
      stopNote(noteName);
      thumb.style.transition="top .15s";
      thumb.style.top="50%";
      centLabel.textContent="0.0 cent";
      setTimeout(()=>thumb.style.transition="",200);

      track.removeEventListener("pointerup",end);
      track.removeEventListener("pointerleave",end);
      track.removeEventListener("pointercancel",end);
    };

    track.addEventListener("pointerup",end);
    track.addEventListener("pointerleave",end);
    track.addEventListener("pointercancel",end);
  });
}


// ======================================================
// モード・オクターブ・フルスクリーン
// ======================================================

function setPlayMode(m){ playMode=m; }
function setScaleMode(m){ scaleMode=m; rebuildKeyboard(); }

function octUp(){ octave++; document.getElementById("oct-label").textContent=octave; }
function octDown(){ octave--; document.getElementById("oct-label").textContent=octave; }

function toggleFullscreen(){
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}

// ======================================================
// WAV録音
// ======================================================

function startRecording(){ recorder.start(); }
function stopRecording(){
  const blob=recorder.stop();
  const url=URL.createObjectURL(blob);
  const a=document.getElementById("downloadLink");
  a.href=url;
  a.download="recording.wav";
  a.style.display="inline-block";
  a.textContent="recording.wav を保存";
}

// ======================================================
// 音色セレクト
// ======================================================

document.getElementById("wave-select").addEventListener("change", e=>{
  currentWave=e.target.value;
});

// ======================================================
// 初期化
// ======================================================

document.getElementById("oct-label").textContent=octave;
rebuildKeyboard();
