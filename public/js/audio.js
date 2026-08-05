/* audio.js — 轻量 WebAudio 音效合成（无外部资源） */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GameAudio = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let muted = false;
  let revIR = null; // 观众欢呼：小厅混响脉冲响应（双声道）
  let applauseBuf = null;       // 真实掌声 WAV（audio/applause.wav）解码结果
  let applauseLoading = false;

  // 加载并解码真实掌声 WAV；失败时保持合成掌声兜底
  function loadApplause() {
    if (applauseBuf || applauseLoading || !ctx || typeof fetch !== 'function') return;
    applauseLoading = true;
    fetch('audio/applause.wav')
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => { applauseBuf = buf; })
      .catch(() => { /* 加载/解码失败：继续用合成掌声 */ })
      .finally(() => { applauseLoading = false; });
  }

  function applauseLoaded() { return !!applauseBuf; }

  // ---------- 背景音乐（独立开关，与音效 muted 分离） ----------
  let musicOn = true;
  let musicGain = null;
  let musicTimer = null;
  let musicStep = 0;        // 当前 1/8 步序号（16 步循环）
  let musicLevel = 0;       // 紧张强度：0=常规 1=胶着 2=赛点/终局

  // raw 游戏音乐（audio/music.mp4，可能含视频轨的视频容器）：
  // 用 <audio> 元素播放其音频轨，作为真实背景音乐，随音乐按钮开始/暂停；
  // 元素缺失（如测试环境/页面未放标签）时回退到下方合成音乐
  let bgmEl = null;

  // 查找并挂接 raw 音乐元素（每次 ensure 调用一次；找不到就继续用合成音乐）
  function loadBGM() {
    if (bgmEl || typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    try {
      const el = document.getElementById('bgmAudio');
      if (!el) return;
      el.src = 'audio/music.mp4';
      el.loop = true;
      el.volume = 0.3; // 与合成音乐 musicGain 音量一致
      el.preload = 'auto';
      bgmEl = el;
    } catch (e) { bgmEl = null; }
  }

  function musicMode() { return bgmEl ? 'raw' : 'synth'; }

  // 体育赛事风格 16 步循环（2 小节，约 115 BPM）：
  // 鼓组：底鼓 1/3 拍，军鼓 2/4 拍，踩镲 八分音符（强度越高越密）
  // 贝斯：A 小调 Am-F-C-G 进行，八分音符踩根音泵动
  // 旋律：A 小调短促琶音，带冲击感
  const STEP_BASE = 0.13;   // 常规每步时长（秒）
  const BASS_SEQ = [55.00, 55.00, 87.31, 87.31, 65.41, 65.41, 98.00, 98.00, 55.00, 55.00, 87.31, 87.31, 65.41, 65.41, 98.00, 98.00];
  const MELODY_SEQ = [220.00, 0, 261.63, 0, 329.63, 0, 392.00, 0, 329.63, 0, 293.66, 0, 261.63, 0, 196.00, 0,
                      293.66, 0, 349.23, 0, 440.00, 0, 349.23, 0, 293.66, 0, 261.63, 0, 220.00, 0, 196.00, 0];

  function stepDur() {
    // 强度越高节奏越快，营造越紧张的临场感
    return STEP_BASE * (1 - musicLevel * 0.07);
  }

  function ensure() {
    loadBGM(); // raw 游戏音乐走 <audio>，不依赖 AudioContext；幂等
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = musicOn ? 0.3 : 0;
    musicGain.connect(master);
    const len = ctx.sampleRate * 0.5;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    loadApplause(); // 预加载真实掌声 WAV
    if (musicOn) startMusic();
  }

  // 播放一个音乐音符（走独立 musicGain，不受音效 muted 影响）
  function musicNote(freq, dur, vol, when, type) {
    if (!ctx || !musicGain || !freq) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'triangle';
    o.frequency.setValueAtTime(freq, when);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(musicGain);
    o.start(when); o.stop(when + dur + 0.02);
  }

  // 底鼓：短促下坠低频正弦
  function musicKick(when, vol) {
    if (!ctx || !musicGain) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, when);
    o.frequency.exponentialRampToValueAtTime(42, when + 0.11);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(vol, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.13);
    o.connect(g); g.connect(musicGain);
    o.start(when); o.stop(when + 0.15);
  }

  // 军鼓/拍手：带通噪声短促脉冲
  function musicSnare(when, vol) {
    if (!ctx || !musicGain || !noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1900;
    f.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.09);
    src.connect(f); f.connect(g); g.connect(musicGain);
    src.start(when); src.stop(when + 0.11);
  }

  // 踩镲：高通噪声短音
  function musicHat(when, vol) {
    if (!ctx || !musicGain || !noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    src.connect(f); f.connect(g); g.connect(musicGain);
    src.start(when); src.stop(when + 0.06);
  }

  function musicTick() {
    if (!ctx || !musicOn) return;
    const now = ctx.currentTime + 0.05;
    const st = musicStep % 16;
    // 鼓组
    if (st % 8 === 0) musicKick(now, 0.42);            // 1、3 拍底鼓
    if (st % 8 === 4) musicSnare(now, 0.22);           // 2、4 拍军鼓
    if (musicLevel >= 1 && st % 4 === 6) musicKick(now, 0.24); // 胶着时加切分底鼓
    if (st % 2 === 0) musicHat(now, musicLevel >= 1 ? 0.13 : 0.09);
    else if (musicLevel >= 2) musicHat(now, 0.08);     // 赛点时踩镲加满十六分
    // 贝斯：八分音符泵动根音（A 小调进行）
    musicNote(BASS_SEQ[st], stepDur() * 0.9, 0.14, now, 'sawtooth');
    // 旋律：短促琶音，强度越高音量越大
    const m = MELODY_SEQ[st + (musicLevel >= 2 ? 16 : 0)];
    if (m) musicNote(m, stepDur() * 0.75, 0.05 + musicLevel * 0.02, now, 'triangle');
    musicStep++;
  }

  function startMusic() {
    if (bgmEl) {
      if (!bgmEl.paused) return;
      try { bgmEl.play(); } catch (e) { /* ignore */ }
      return;
    }
    if (!ctx || musicTimer) return;
    musicTimer = setInterval(musicTick, stepDur() * 1000);
  }

  function stopMusic() {
    if (bgmEl) {
      try { bgmEl.pause(); } catch (e) { /* ignore */ }
      return;
    }
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  }

  function setMusicOn(on) {
    musicOn = !!on;
    if (musicGain) musicGain.gain.value = musicOn ? 0.3 : 0;
    if (musicOn) startMusic(); else stopMusic();
  }

  // 紧张强度：比分胶着/赛点时加快节奏、抬高音量
  function setIntensity(level) {
    const lv = Math.max(0, Math.min(2, level | 0));
    if (lv === musicLevel) return;
    musicLevel = lv;
    if (musicGain) musicGain.gain.value = musicOn ? 0.3 + lv * 0.04 : 0;
    if (musicOn) {
      stopMusic();
      startMusic(); // 按新节奏重启
    }
  }

  function tone(freq, dur, type, vol, slideTo) {
    if (!ctx || muted) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g); g.connect(master);
    o.start(); o.stop(ctx.currentTime + dur + 0.02);
  }

  function noise(dur, vol, freq) {
    if (!ctx || muted || !noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq || 1200;
    f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(); src.stop(ctx.currentTime + dur + 0.02);
  }

  // 得分掌声：优先播放真实录音 WAV（audio/applause.wav，3.2s 立体声）；
  // 未加载/加载失败时用合成掌声兜底（applauseSynth）
  function applause() {
    if (!ctx || muted) return;
    if (applauseBuf) {
      const t0 = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = applauseBuf;
      const g = ctx.createGain();
      // 音量减小 25%（1.0→0.75）；时长减至 1.5s（只播前段，结尾 0.12s 淡出防爆音）
      const VOL = 0.75, DUR = 1.5;
      g.gain.setValueAtTime(VOL, t0);
      g.gain.setValueAtTime(VOL, t0 + DUR - 0.12);
      g.gain.linearRampToValueAtTime(0.0001, t0 + DUR);
      src.connect(g); g.connect(master);
      src.start(t0); src.stop(t0 + DUR);
      return;
    }
    loadApplause(); // 顺带触发加载，下次得分即用真实录音
    applauseSynth();
  }

  // 合成掌声（兜底）：双层鼓掌 + 人群波浪 + 领掌 + 压缩器（响亮感）
  function applauseSynth() {
    if (!ctx || muted || !noiseBuf) return;
    const t0 = ctx.currentTime;

    // ---- 小厅混响：指数衰减双声道脉冲响应（早期反射 + 混响尾） ----
    if (!revIR) {
      const len = Math.floor(ctx.sampleRate * 0.7);
      revIR = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = revIR.getChannelData(ch);
        let last = 0;
        for (let i = 0; i < len; i++) {
          const t = i / ctx.sampleRate;
          const early = t < 0.05 ? 0.5 + 0.5 * Math.sin((t / 0.05) * Math.PI) : Math.exp(-(t - 0.05) * 9);
          const n = Math.random() * 2 - 1;
          last = (last + n) * 0.5;
          d[i] = last * early * 0.55;
        }
      }
    }

    // ---- 混合总线：音量 1.0 + 压缩器（响亮感：密集掌声压成一道结实"声墙"） ----
    const convolver = ctx.createConvolver();
    convolver.buffer = revIR;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.75, t0);
    bus.gain.setValueAtTime(0.75, t0 + 1.25);
    bus.gain.linearRampToValueAtTime(0.0001, t0 + 1.5);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 22;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;
    const dry = ctx.createGain(); dry.gain.value = 0.72;
    const wet = ctx.createGain(); wet.gain.value = 0.45;
    bus.connect(comp);
    comp.connect(dry); dry.connect(master);
    comp.connect(wet); wet.connect(convolver); convolver.connect(master);

    // ---- 空气感底噪：极轻的低频人群噪底，随 0.4Hz 缓慢起伏 ----
    const rumble = ctx.createBufferSource();
    rumble.buffer = noiseBuf;
    rumble.loop = true;
    const rf = ctx.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.value = 420;
    const rg = ctx.createGain();
    rg.gain.value = 0.045;
    const rlfo = ctx.createOscillator();
    rlfo.frequency.value = 0.4;
    const rlg = ctx.createGain();
    rlg.gain.value = 0.025;
    rlfo.connect(rlg); rlg.connect(rg.gain);
    rumble.connect(rf); rf.connect(rg); rg.connect(bus);
    rumble.start(t0); rumble.stop(t0 + 1.6);
    rlfo.start(t0); rlfo.stop(t0 + 1.6);

    // ---- 一声鼓掌（双层）：掌心低频"砰" + 高频拍击"啪" ----
    const clap = (when, pan, vol) => {
      // 身体层：掌心共鸣（约 200Hz 短正弦，结实有力）
      const o = ctx.createOscillator();
      o.type = 'sine';
      const fb = 170 + Math.random() * 70;
      o.frequency.setValueAtTime(fb * 1.15, when);
      o.frequency.exponentialRampToValueAtTime(fb * 0.7, when + 0.07);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, when);
      og.gain.exponentialRampToValueAtTime(vol * 0.65, when + 0.004);
      og.gain.exponentialRampToValueAtTime(0.0001, when + 0.11 + Math.random() * 0.04);
      const op = ctx.createStereoPanner();
      op.pan.value = pan;
      o.connect(og); og.connect(op); op.connect(bus);
      o.start(when); o.stop(when + 0.17);
      // 拍击层：带通噪声极短瞬态（清脆"啪"）
      const s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      const sf = ctx.createBiquadFilter();
      sf.type = 'bandpass';
      sf.frequency.value = 2600 + Math.random() * 1600;
      sf.Q.value = 1.4;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.0001, when);
      sg.gain.exponentialRampToValueAtTime(vol, when + 0.002);
      sg.gain.exponentialRampToValueAtTime(0.0001, when + 0.03 + Math.random() * 0.02);
      const sp = ctx.createStereoPanner();
      sp.pan.value = pan;
      s.connect(sf); sf.connect(sg); sg.connect(sp); sp.connect(bus);
      s.start(when); s.stop(when + 0.06);
    };

    // ---- 掌声调度：包络(起势→高潮→渐弱) × 波浪(人群齐拍)，密度更高更密 ----
    const env = (t) => {
      if (t < 0.25) return 0.3 + 0.7 * (t / 0.25);   // 起势
      if (t < 0.8) return 1;                          // 高潮
      if (t < 1.5) return 1 - (t - 0.8) / 0.7;        // 渐弱
      return 0;
    };
    const wave = (t) => 0.72 + 0.28 * Math.sin((t * 2 * Math.PI) / 1.15); // ~0.9Hz 齐拍波浪
    let t = 0;
    while (t < 1.5) {
      const rate = (40 + 130 * env(t)) * wave(t); // 每秒掌声数（更密集，响亮有气势）
      t += -Math.log(1 - Math.random()) / rate;
      if (t >= 1.5) break;
      const lead = Math.random() < 0.08; // 8% 领掌：更响、更居中
      const vol = lead
        ? 0.46
        : (0.17 + 0.15 * Math.random()) * (0.4 + 0.6 * env(t)) * (0.8 + 0.2 * wave(t));
      clap(t0 + t, lead ? (Math.random() * 2 - 1) * 0.3 : (Math.random() * 2 - 1) * 0.92, vol);
    }
    // 尾声：零星掌声（自然收尾）
    for (let i = 0; i < 4; i++) {
      clap(t0 + 1.34 + i * 0.05 + Math.random() * 0.03, (Math.random() * 2 - 1) * 0.9, 0.045 + Math.random() * 0.03);
    }
  }

  return {
    ensure,
    setMuted(m) {
      muted = m;
      if (master) master.gain.value = m ? 0 : 0.5;
      // raw 游戏音乐（<audio> 元素）同样跟随静音开关（与合成音乐一致）
      if (bgmEl) bgmEl.volume = m ? 0 : 0.3;
    },
    isMuted() { return muted; },
    setMusicOn, isMusicOn() { return musicOn; },
    musicMode, // 'raw'=真实音乐已加载 / 'synth'=合成音乐兜底
    setIntensity,
    hit() { noise(0.06, 0.35, 1800); tone(260, 0.07, 'square', 0.12, 90); },
    bounce() { tone(420, 0.045, 'sine', 0.18, 240); },
    ready() { tone(880, 0.06, 'sine', 0.10, 1320); }, // 进箱提示：柔和短上升音（判定范围显示开启时）
    net() { noise(0.08, 0.3, 500); tone(120, 0.1, 'triangle', 0.2, 60); },
    serve() { noise(0.16, 0.2, 900); },
    fault() { tone(200, 0.22, 'sawtooth', 0.12, 120); },
    score() { tone(660, 0.12, 'sine', 0.2); setTimeout(() => tone(880, 0.18, 'sine', 0.2), 90); },
    applause,
    applauseLoaded,
    cheer: applause,
    letSound() { tone(520, 0.12, 'sine', 0.16, 420); },
    over() { [523, 659, 784, 1047].forEach((fq, i) => setTimeout(() => tone(fq, 0.2, 'sine', 0.2), i * 130)); },
    ui() { tone(700, 0.05, 'sine', 0.12); },
  };
});
