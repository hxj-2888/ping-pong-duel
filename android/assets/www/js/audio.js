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
  // 音效开关（设置面板，localStorage 持久化）：muted=true 时游戏音效静音
  let muted = false;
  try { muted = typeof localStorage !== 'undefined' && localStorage.getItem('ppd_sound_on') === '0'; } catch (e) { /* ignore */ }
  let revIR = null; // 观众欢呼：小厅混响脉冲响应（双声道）
  let applauseBuf = null;       // 真实掌声 WAV（audio/applause.wav）解码结果
  let applauseLoading = false;
  let applauseEl = null;        // <audio> 元素兜底（WebView/file:// 下 fetch 被拦截时用）

  // 加载并解码真实掌声 WAV；失败时保持合成掌声兜底。
  // file://（APK WebView）下 fetch 不可用 → 挂接 <audio> 元素直载（与 BGM 同策略）
  function loadApplause() {
    if (!applauseEl) {
      const el = document.getElementById('applauseAudio');
      if (el) { el.src = 'audio/applause.wav'; applauseEl = el; }
    }
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
  // musicOn 持久化（设置面板）：默认开；关闭后下次打开仍保持关闭
  let musicOn = true;
  try { musicOn = typeof localStorage !== 'undefined' && localStorage.getItem('ppd_music_on') === '0' ? false : true; } catch (e) { /* ignore */ }
  // 音量（设置面板滑杆，0~1，localStorage 持久化）：音乐默认 0.3、音效默认 0.5
  let musicVol = 0.3;
  try { musicVol = Math.min(1, Math.max(0, (parseInt(localStorage.getItem('ppd_music_vol'), 10) || 30) / 100)); } catch (e) { /* ignore */ }
  let sfxVol = 0.5;
  try { sfxVol = Math.min(1, Math.max(0, (parseInt(localStorage.getItem('ppd_sfx_vol'), 10) || 50) / 100)); } catch (e) { /* ignore */ }
  let musicGain = null;
  let musicLevel = 0;       // 紧张强度：0=常规 1=胶着 2=赛点/终局（仅用于 raw 音乐音量增益）

  // 按当前状态（开关 + 音量 + 紧张强度）统一刷新音乐总线增益
  function applyMusicGain() {
    if (!musicGain) return;
    musicGain.gain.value = musicOn ? Math.min(1, musicVol * (1 + musicLevel * 0.13)) : 0;
  }

  // raw 游戏音乐（audio/music.mp4，可能含视频轨的视频容器）：
  // 优先 WebAudio 解码 → AudioBufferSourceNode.loop=true（**零间隙无缝循环**）；
  // 解码失败（如带视频轨无法 decodeAudioData）回退 <audio> 元素 loop 播放
  let bgmBuf = null;      // WebAudio 解码缓冲
  let bgmLoading = false;
  let bgmEl = null;       // <audio> 元素兜底
  let bgmSource = null;   // 当前 AudioBufferSourceNode

  // 挂接 raw 音乐：元素兜底 + （ctx 就绪后）WebAudio 解码（幂等，可反复调用）
  function loadBGM() {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    // <audio> 元素兜底（无需 AudioContext，进游戏即可播放）
    if (!bgmEl) {
      try {
        const el = document.getElementById('bgmAudio');
        if (!el) return;
        el.src = 'audio/music.mp4';
        el.loop = true;
        el.volume = musicVol; // 与音乐总线 musicGain 音量一致（音量滑杆）
        el.preload = 'auto';
        bgmEl = el;
      } catch (e) { bgmEl = null; }
    }
    // WebAudio 解码（需要 ctx；成功后 loop=true 零间隙循环，解码完成自动无缝切换）
    if (ctx && !bgmBuf && !bgmLoading && typeof fetch === 'function') {
      bgmLoading = true;
      fetch('audio/music.mp4')
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then((ab) => ctx.decodeAudioData(ab))
        .then((buf) => {
          bgmBuf = buf;
          trimBgmBuffer();   // 首尾相连：裁掉开头/结尾近静音
          computeBgmInfo();
          // 解码完成：停掉元素兜底再启零间隙循环，避免双音
          if (bgmEl && !bgmEl.paused) { try { bgmEl.pause(); } catch (e) { /* ignore */ } }
          startMusic();
        })
        .catch(() => { /* 解码失败：保留 <audio> 兜底 */ })
        .finally(() => { bgmLoading = false; });
    }
  }

  function musicMode() { return 'raw'; }
  // 当前 raw 音乐实际播放路径（调试/验证用）：buffer=WebAudio 无缝循环 / element=<audio> 兜底 / none=尚未加载
  function bgmPath() { return bgmBuf ? 'buffer' : bgmEl ? 'element' : 'none'; }
  // 诊断缓存：解码完成时计算首/尾响度（RMS）与时长（读取 getChannelData 在解码时做，避免调用期被拦）
  let bgmInfoCache = null;
  function bgmInfo() { return bgmInfoCache; }
  function computeBgmInfo() {
    if (!bgmBuf) return;
    const ch = bgmBuf.getChannelData(0);
    const rate = bgmBuf.sampleRate;
    const rms = (start, len) => {
      let s = 0, n = 0;
      for (let i = start; i < Math.min(start + len, ch.length); i += 64) { s += ch[i] * ch[i]; n++; }
      return n ? Math.sqrt(s / n) : 0;
    };
    const sec = (v) => Math.floor(v * rate);
    bgmInfoCache = Object.assign({}, bgmInfoCache, {
      dur: Math.round(bgmBuf.duration * 100) / 100,
      head0_2: +rms(0, sec(0.2)).toFixed(4),
      tail0_5: +rms(ch.length - sec(0.5), sec(0.5)).toFixed(4),
      tail0_2: +rms(ch.length - sec(0.2), sec(0.2)).toFixed(4),
      tail0_05: +rms(ch.length - sec(0.05), sec(0.05)).toFixed(4),
    });
  }
  // 首尾相连：裁掉缓冲开头/结尾的近静音（20ms 窗口 RMS < 0.005），
  // 让循环从响亮结尾直接接上音乐开头（消除开头死寂造成的"断裂"感）
  function trimBgmBuffer() {
    if (!bgmBuf) return;
    const ch0 = bgmBuf.getChannelData(0);
    const rate = bgmBuf.sampleRate;
    const win = Math.max(1, Math.floor(rate * 0.02));
    const rmsAt = (start) => {
      let s = 0, n = 0;
      for (let i = start; i < Math.min(start + win, ch0.length); i += 8) { s += ch0[i] * ch0[i]; n++; }
      return n ? Math.sqrt(s / n) : 0;
    };
    const TH = 0.005;
    let head = 0;
    while (head + win < ch0.length && rmsAt(head) < TH) head += win;
    let tail = ch0.length;
    while (tail - win > head && rmsAt(tail - win) < TH) tail -= win;
    // 安全兜底：整段几乎无声或几乎无静音（开头 <30ms 且结尾无静音）时不裁
    if (head >= ch0.length / 2) return;
    if (head < Math.floor(rate * 0.03) && tail >= ch0.length) return;
    bgmInfoCache = bgmInfoCache || {};
    bgmInfoCache.headTrimMs = Math.round(head / rate * 1000);
    bgmInfoCache.tailTrimMs = Math.round((ch0.length - tail) / rate * 1000);
    if (head === 0 && tail === ch0.length) return;
    const newLen = tail - head;
    const trimmed = ctx.createBuffer(bgmBuf.numberOfChannels, newLen, rate);
    for (let c = 0; c < bgmBuf.numberOfChannels; c++) {
      trimmed.copyToChannel(bgmBuf.getChannelData(c).subarray(head, tail), c);
    }
    bgmBuf = trimmed;
  }

  // （原体育赛事风格合成音乐已移除，背景音乐仅使用真实音频 audio/music.mp4）

  function ensure() {
    loadBGM(); // raw 音乐挂接（元素兜底 + ctx 就绪时触发 WebAudio 解码）
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();          // 游戏音效总线（受「游戏音效」开关与音量控制）
    master.gain.value = sfxVol;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();       // 背景音乐总线（受「背景音乐」开关与音量控制）
    musicGain.gain.value = musicOn ? musicVol : 0;
    // 音乐直连输出，不经过 master——音乐与音效完全独立（关音效不影响音乐）
    musicGain.connect(ctx.destination);
    const len = ctx.sampleRate * 0.5;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    loadBGM();       // ctx 就绪后再触发 WebAudio 解码（零间隙无缝循环路径）
    loadApplause();  // 预加载真实掌声 WAV
    if (musicOn) startMusic();
  }

  function startMusic() {
    // 优先 WebAudio 解码缓冲：AudioBufferSourceNode.loop=true → 零间隙无缝循环
    if (bgmBuf && ctx) {
      if (bgmSource) return;
      const src = ctx.createBufferSource();
      src.buffer = bgmBuf;
      src.loop = true; // 无缝循环（结束时零间隙回到开头）
      src.connect(musicGain);
      src.start();
      bgmSource = src;
      return;
    }
    if (bgmEl) {
      if (!bgmEl.paused) return;
      try {
        const p = bgmEl.play();
        if (p && p.catch) p.catch(() => { /* 自动播放策略拦截：等首次交互后由 autoplayMusic 重试 */ });
      } catch (e) { /* ignore */ }
      return;
    }
    // 无任何音乐源（mp4 缺失）：静默不播（原合成音乐兜底已移除）
  }

  function stopMusic() {
    if (bgmSource) {
      try { bgmSource.stop(); } catch (e) { /* ignore */ }
      bgmSource.disconnect();
      bgmSource = null;
      return;
    }
    if (bgmEl) {
      try { bgmEl.pause(); } catch (e) { /* ignore */ }
      return;
    }
  }

  function setMusicOn(on) {
    musicOn = !!on;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('ppd_music_on', musicOn ? '1' : '0'); } catch (e) { /* ignore */ }
    applyMusicGain();
    if (musicOn) startMusic(); else stopMusic();
  }

  // 音乐音量（0~1，设置面板滑杆）：即时生效 + 持久化；<audio> 元素同步
  function setMusicVol(v) {
    musicVol = Math.min(1, Math.max(0, v));
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('ppd_music_vol', String(Math.round(musicVol * 100))); } catch (e) { /* ignore */ }
    if (bgmEl) bgmEl.volume = musicVol;
    applyMusicGain();
  }
  // 音效音量（0~1，设置面板滑杆）：即时生效 + 持久化
  function setSfxVol(v) {
    sfxVol = Math.min(1, Math.max(0, v));
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('ppd_sfx_vol', String(Math.round(sfxVol * 100))); } catch (e) { /* ignore */ }
    if (master) master.gain.value = muted ? 0 : sfxVol;
  }

  // 紧张强度：比分胶着/赛点时加快节奏、抬高音量（相对用户设定的音乐音量按比例提）
  function setIntensity(level) {
    const lv = Math.max(0, Math.min(2, level | 0));
    if (lv === musicLevel) return;
    musicLevel = lv;
    applyMusicGain();
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
  // 其次 <audio> 元素兜底（file:// 等 fetch 不可用环境）；都没有时用合成掌声（applauseSynth）
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
    if (applauseEl && applauseEl.readyState >= 2) { // HAVE_CURRENT_DATA：元素已载入可播
      try {
        applauseEl.currentTime = 0;
        applauseEl.volume = 0.75;
        applauseEl.play();
      } catch (e) { /* ignore */ }
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

  // 页面打开即播：浏览器「自动播放策略」会拦截带声音的自动播放。
  // 先直接尝试启动；若被拦截（AudioContext 处于 suspended / <audio> 未能播放），
  // 持续挂接用户交互（任意点击/按键/触摸），每次交互都重试恢复出声，
  // 直到音乐真正在播才卸载——避免一次性恢复监听因交互时机过早/被策略拦截而丢失机会。
  function autoplayMusic() {
    ensure(); // 建 AudioContext + 挂接 raw 音乐（musicOn 时内部已尝试启动）
    const playing = () =>
      (bgmSource && ctx && ctx.state === 'running') ||
      (bgmEl && !bgmEl.paused && musicOn);
    const resume = () => {
      if (ctx && ctx.state === 'suspended' && ctx.resume) {
        try { ctx.resume(); } catch (e) { /* ignore */ }
      }
      if (!musicOn) return;
      if (bgmBuf && !bgmSource) startMusic();                        // WebAudio：resume 后补启
      else if (bgmEl && bgmEl.paused) { try { bgmEl.play(); } catch (e) { /* ignore */ } }
    };
    const tryResume = () => {
      resume();
      if (playing()) { // 已出声 → 卸载监听，避免常驻开销
        for (const t of ['pointerdown', 'keydown', 'touchstart', 'click']) {
          try { window.removeEventListener(t, tryResume); } catch (e) { /* ignore */ }
        }
      }
    };
    if (!playing()) {
      for (const t of ['pointerdown', 'keydown', 'touchstart', 'click']) {
        try { window.addEventListener(t, tryResume, { passive: true }); } catch (e) { /* ignore */ }
      }
    }
  }

  return {
    ensure,
    autoplayMusic,
    setMuted(m) {
      muted = m;
      try { if (typeof localStorage !== 'undefined') localStorage.setItem('ppd_sound_on', muted ? '0' : '1'); } catch (e) { /* ignore */ }
      // 只静音游戏音效（master 总线）；背景音乐走独立通路（musicGain 直连 / <audio> 元素），
      // 不受音效开关影响——音乐与音效完全独立
      if (master) master.gain.value = m ? 0 : sfxVol;
    },
    isMuted() { return muted; },
    setMusicOn, isMusicOn() { return musicOn; },
    setMusicVol, getMusicVol() { return musicVol; },
    setSfxVol, getSfxVol() { return sfxVol; },
    musicMode, bgmPath, bgmInfo, // musicMode 恒为 'raw'；bgmPath: buffer/element/none
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
