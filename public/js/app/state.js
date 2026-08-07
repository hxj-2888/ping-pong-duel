/* ============================================================
 * app/state.js — 共享状态与 DOM 引用（拆分自 main.js）
 * 所有 app/ 模块通过 window.PPD 访问公共状态、界面元素与接口，
 * 模块之间不直接调用彼此的私有实现。
 * ============================================================ */
(function () {
  'use strict';

  const TT = window.TT;
  const TTG = window.TTG;
  const GameAudio = window.GameAudio;
  const NetClient = window.NetClient;
  const AIC = window.AIController;

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const ui = {
    menu: document.getElementById('menu'),
    gameScreen: document.getElementById('gameScreen'),
    nameInput: document.getElementById('nameInput'),
    btnLocal: document.getElementById('btnLocal'),
    btnAI: document.getElementById('btnAI'),
    aiLevel: document.getElementById('aiLevel'),
    btnAIVsAI: document.getElementById('btnAIVsAI'),
    aiLevelA: document.getElementById('aiLevelA'),
    aiLevelB: document.getElementById('aiLevelB'),
    pauseAiLevelA: document.getElementById('pauseAiLevelA'),
    pauseAiLevelB: document.getElementById('pauseAiLevelB'),
    pauseAiNameA: document.getElementById('pauseAiNameA'),
    pauseAiNameB: document.getElementById('pauseAiNameB'),
    pauseAIVsAI: document.getElementById('pauseAIVsAI'),
    tuneAReact: document.getElementById('tuneAReact'),
    tuneACatch: document.getElementById('tuneACatch'),
    tuneASmash: document.getElementById('tuneASmash'),
    tuneAAgility: document.getElementById('tuneAAgility'),
    tuneBReact: document.getElementById('tuneBReact'),
    tuneBCatch: document.getElementById('tuneBCatch'),
    tuneBSmash: document.getElementById('tuneBSmash'),
    tuneBAgility: document.getElementById('tuneBAgility'),
    tuneOppReact: document.getElementById('tuneOppReact'),
    tuneOppCatch: document.getElementById('tuneOppCatch'),
    tuneOppSmash: document.getElementById('tuneOppSmash'),
    tuneOppAgility: document.getElementById('tuneOppAgility'),
    btnHost: document.getElementById('btnHost'),
    btnJoin: document.getElementById('btnJoin'),
    btnNetMode: document.getElementById('btnNetMode'),
    joinInput: document.getElementById('joinInput'),
    // 设置（主页与比赛页右上角 ⚙）：判定虚线 / 背景音乐 / 游戏音效
    btnSettings: document.getElementById('btnSettings'),
    btnSettingsGame: document.getElementById('btnSettingsGame'),
    settingsPanel: document.getElementById('settingsPanel'),
    btnSettingsClose: document.getElementById('btnSettingsClose'),
    setShowHitRanges: document.getElementById('setShowHitRanges'),
    setMusic: document.getElementById('setMusic'),
    setSound: document.getElementById('setSound'),
    setMusicVol: document.getElementById('setMusicVol'),
    setSfxVol: document.getElementById('setSfxVol'),
    roomPanel: document.getElementById('roomPanel'),
    roomCode: document.getElementById('roomCode'),
    roomHint: document.getElementById('roomHint'),
    lanUrls: document.getElementById('lanUrls'),
    btnRoomBack: document.getElementById('btnRoomBack'),
    statusBar: document.getElementById('statusBar'),
    overlay: document.getElementById('overlay'),
    overlayTitle: document.getElementById('overlayTitle'),
    overlayText: document.getElementById('overlayText'),
    overlayBtn: document.getElementById('overlayBtn'),
    gameOver: document.getElementById('gameOver'),
    gameOverTitle: document.getElementById('gameOverTitle'),
    btnAgain: document.getElementById('btnAgain'),
    btnMenu: document.getElementById('btnMenu'),
    btnQuit: document.getElementById('btnQuit'),
    hud: document.getElementById('hud'),
    hudP1: document.getElementById('hudP1'),
    hudP2: document.getElementById('hudP2'),
    phaseBanner: document.getElementById('phaseBanner'),
    pointToast: document.getElementById('pointToast'),
    hintBar: document.getElementById('hintBar'),
    netInfo: document.getElementById('netInfo'),
    hitRangeInfo: document.getElementById('hitRangeInfo'),
    hitBallVal: document.getElementById('hitBallVal'),
    hitPaddleVal: document.getElementById('hitPaddleVal'),
    ballHeight: document.getElementById('ballHeight'),
    inBoxStatus: document.getElementById('inBoxStatus'),
    smashStatus: document.getElementById('smashStatus'),
    lobStatus: document.getElementById('lobStatus'),
    quality: document.getElementById('quality'),
    setNoCrowd: document.getElementById('setNoCrowd'),
    frameRate: document.getElementById('frameRate'),
    fpsMeter: document.getElementById('fpsMeter'),
    serveDot: document.getElementById('serveDot'),
    tips: document.getElementById('tips'),
    recordsPanel: document.getElementById('recordsPanel'),
    // 个人生涯单开页（主菜单小方框点击展开，分页）
    careerPanel: document.getElementById('careerPanel'),
    careerStats: document.getElementById('careerStats'),
    careerList: document.getElementById('careerList'),
    careerPageLabel: document.getElementById('careerPageLabel'),
    btnCareerPrev: document.getElementById('btnCareerPrev'),
    btnCareerNext: document.getElementById('btnCareerNext'),
    btnCareerBack: document.getElementById('btnCareerBack'),
    touchControls: document.getElementById('touchControls'),
    btnLeft: document.getElementById('btnLeft'),
    btnRight: document.getElementById('btnRight'),
    btnFwd: document.getElementById('btnFwd'),
    btnBack: document.getElementById('btnBack'),
    joyBase: document.getElementById('joyBase'),
    joyKnob: document.getElementById('joyKnob'),
    btnCrouch: document.getElementById('btnCrouch'),
    btnSmash: document.getElementById('btnSmash'),
    btnPause: document.getElementById('btnPause'),
    btnExit: document.getElementById('btnExit'),
    pausePanel: document.getElementById('pausePanel'),
    pauseAITune: document.getElementById('pauseAITune'), // 人机：地狱通关后的电脑 AI 数值调控
    btnResume: document.getElementById('btnResume'),
    btnPauseExit: document.getElementById('btnPauseExit'),
  };

  // 联机服务器选择：
  // - 本地 localhost + 选"本地" → node server.js（ws://localhost:端口，局域网可用）
  // - 本地 localhost + 选"公网" → Cloudflare 联机端点（wss://ping-pong-duel.pages.dev/ws）
  // - 网页版（pages.dev）→ 同域 /ws（即公网联机端点；workers.dev 在国内被 DNS 污染，不走）
  const isLocalHost = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  function wsUrl() {
    if (isLocalHost && !app.publicServer) {
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    }
    if (isLocalHost) {
      return 'wss://ping-pong-duel.pages.dev/ws'; // 桌面端切公网：直连 Cloudflare
    }
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }
  // 触屏设备检测（触控按钮只在这些设备上显示）：
  // 以「主指针为粗指针」(手机/平板)为准；或 支持触摸但主输入非细指针（无鼠标的触屏设备/旧安卓）。
  // 触屏笔记本/台式机主指针仍是鼠标（pointer:fine）→ 判定为桌面，避免把手机端
  // 摇杆/蹲/扣按钮与触屏提示带到电脑上；?touch=1 强制手机端（桌面调试）、?desktop=1 强制桌面端
  const q = (s) => !!(window.matchMedia && window.matchMedia(s).matches);
  const coarse = q('(pointer: coarse)') ||
    (!q('(pointer: fine)') && ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0));
  const phoneSize = window.innerWidth <= 1024;
  const isTouch = /[?&]touch=1/.test(location.search)
    ? !/[?&]desktop=1/.test(location.search)
    : coarse && phoneSize && !/[?&]desktop=1/.test(location.search);

  const app = {
    mode: null,          // 'local' | 'ai' | 'aivai' | 'online'
    aiLevel: 1,
    aiLevelA: 1,         // AI 观战：红方 AI 难度
    aiLevelB: 1,         // AI 观战：蓝方 AI 难度
    // AI 观战：在难度基准上的参数微调倍率（暂停面板滑杆，默认 ×1 = 基准）
    aiTuneA: { reactMul: 1, catchMul: 1, smashMul: 1, agilityMul: 1 },
    aiTuneB: { reactMul: 1, catchMul: 1, smashMul: 1, agilityMul: 1 },
    side: 0,             // 联机时我的方位
    sideSet: false,      // 联机 side 是否已确立（房主=创建响应，加入方=首条非等待 room）
    heartbeatTimer: null,
    // 联机数据看门狗（1s 检查 state/pong 新鲜度，超时触发自动重连）
    watchdogTimer: null,
    lastStateAt: 0,      // 最近一次收到 state 快照的时刻（Date.now()）
    lastPongAt: 0,       // 最近一次收到 pong 的时刻（Date.now()）
    reconnecting: false, // 是否正在自动重连（防并发触发）
    reconnectAttempt: 0, // 已自动重连次数（超过上限回菜单）
    reconnectStartedAt: 0, // 本轮重连开始时刻（超时判定）
    publicServer: false, // 联机服务器：false=本地（node server.js）/ true=公网（Cloudflare）
    lanInfo: null,        // GET /api/info 返回的局域网联机信息（房主等待面板显示用）
    serverVersion: null,  // 本地服务器版本（心跳 pong 带 ver；用于识别旧服务器）
    serverStaleWarned: false, // 是否已提示过"服务器版本过旧"（只提示一次）
    engine: null,
    net: null,
    roomCode: '',
    names: ['玩家1', '玩家2'],
    keys: { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, crouch: 0, run: 0 },
    keyP1: { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, crouch: 0, run: 0 },
    keyP2: { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, crouch: 0, run: 0 },
    snapA: null, snapB: null, tA: 0, tB: 0,
    interpClock: null,   // 联机插值显示时钟（引擎时间 ms，见 renderOnline）
    _interpLast: null,   // 插值时钟上次推进时刻（performance.now）
    lastInputSent: 0,
    lastPhase: -1,
    lastEventKeys: new Set(),
    lastPoint: '',
    serveAim: null,        // 当前瞄准的目标落点（世界坐标 {x, z}）
    serveAiming: false,    // 手机端：第一下点按后进入瞄准状态，第二下点按发球
    lastPointerX: null,    // 最近一次指针位置（新发球开始时用于恢复瞄准）
    lastPointerY: null,
    countdown: -1,
    resizeW: 0, resizeH: 0,
    fx: [],
    paused: false,
    // 红/蓝双方观众状态：得分方欢呼量 cheer、对方摇头量 shake（0..1，主循环每帧衰减）
    fan: { cheer: [0, 0], shake: [0, 0] },
    showHitRanges: false, // 判定范围虚线（设置面板开关，默认关闭）
    dpr: 1,              // 当前画布像素比（DPR 上限 2；低画质=1）
    resizeDirty: false,  // 暂停/结算期间窗口尺寸变化 → 需要补一帧渲染
    // 画质：mode='high'（默认高画质）/ 'low'（低画质省电）；low=当前低画质标记；
    // frameRate=渲染帧率上限（30/45/60/无上限，物理仍 120Hz 步进）
    quality: { mode: 'high', low: false, frameMs: 16.67, frameRate: 60 },
    noCrowd: true, // 关闭环境观众（设置面板勾选框，默认关闭；低画质/联机恒为无观众）
  };

  // ---------- 工具 ----------
  function $id(id) { return document.getElementById(id); }
  function show(el, v) { if (el) el.style.display = v ? '' : 'none'; }

  function resize() {
    app.resizeW = window.innerWidth;
    app.resizeH = window.innerHeight;
    // 分辨率档位：渲染物理像素封顶到目标分辨率（超出的屏按比例降 DPR，避免无谓填充率）——
    // 高画质=电脑 2560×1440 / 手机 800p（渲染宽），低画质=电脑 1080p / 手机 400p。
    // 渲染坐标仍用 CSS 像素（setTransform 缩放）；dpr<1（如 4K 屏选低画质）→ 1080p 放大显示，属预期省电
    const rw = Math.max(1, app.resizeW), rh = Math.max(1, app.resizeH);
    const cap = app.quality && app.quality.low
      ? (isTouch ? 400 / rw : Math.min(1920 / rw, 1080 / rh))   // 低：手机 400p / 电脑 1080p
      : (isTouch ? 800 / rw : Math.min(2560 / rw, 1440 / rh));  // 高：手机 800p / 电脑 2560×1440
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    app.dpr = dpr;
    canvas.width = Math.max(1, Math.round(app.resizeW * dpr));
    canvas.height = Math.max(1, Math.round(app.resizeH * dpr));
    if (ctx && ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    app.resizeDirty = true; // 尺寸/DPR 变化后即使暂停/结算也要补一帧
  }

  // ---------- 地狱模式解锁（localStorage 持久化） ----------
  const HELL_KEY = 'ppd_hell_unlocked';
  const HIT_RANGE_KEY = 'ppd_show_hit_ranges';

  // 内存兜底：localStorage 不可用（如测试沙盒/隐私模式）时仍可本次会话解锁
  let hellUnlockedMem = false;
  try {
    hellUnlockedMem = typeof localStorage !== 'undefined' && localStorage.getItem(HELL_KEY) === '1';
  } catch (e) { /* ignore */ }

  function isHellUnlocked() { return hellUnlockedMem; }

  // 判定范围虚线开关（设置面板，localStorage 持久化；默认关闭）
  let showHitRanges = false;
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(HIT_RANGE_KEY) : null;
    showHitRanges = v === null ? false : v === '1';
  } catch (e) { /* ignore */ }
  app.showHitRanges = showHitRanges;

  // ---------- 画质（高/低两档，默认高；localStorage 记忆） ----------
  const QUALITY_KEY = 'ppd_quality';
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(QUALITY_KEY) : null;
    if (v === 'low' || v === 'high') app.quality.mode = v;
  } catch (e) { /* ignore */ }
  app.quality.low = app.quality.mode === 'low';
  if (ui.quality) ui.quality.value = app.quality.mode;

  // ---------- 关闭环境观众（默认关闭；localStorage 记忆） ----------
  const NO_CROWD_KEY = 'ppd_no_crowd';
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(NO_CROWD_KEY) : null;
    if (v === '0' || v === '1') app.noCrowd = v === '1';
  } catch (e) { /* ignore */ }
  if (ui.setNoCrowd) {
    ui.setNoCrowd.checked = app.noCrowd;
    ui.setNoCrowd.disabled = app.quality.low; // 低画质观众恒关，勾选框置灰
  }

  // ---------- 帧率上限（30/45/60/无上限，默认 60；localStorage 记忆） ----------
  const FRAME_RATE_KEY = 'ppd_frame_rate';
  try {
    const raw = localStorage.getItem(FRAME_RATE_KEY);
    if (raw === 'unlimited') app.quality.frameRate = 'unlimited';
    else {
      const v = parseInt(raw, 10);
      if (v === 30 || v === 45 || v === 60) app.quality.frameRate = v;
    }
  } catch (e) { /* ignore */ }
  if (ui.frameRate) ui.frameRate.value = String(app.quality.frameRate);

  // ---------- 玩家昵称（主菜单 #nameInput）：取名生效 + 本地记忆 ----------
  const NAME_KEY = 'ppd_name';
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(NAME_KEY) : null;
    if (saved && ui.nameInput) ui.nameInput.value = saved;
  } catch (e) { /* ignore */ }
  function getPlayerName() {
    return ui.nameInput ? ui.nameInput.value.trim() : '';
  }
  // AI 观战双方名字（暂停面板可改，本地记忆，各截断 12 字）
  const AI_NAMES_KEY = 'ppd_ai_names';
  function loadAINames() {
    try {
      const v = localStorage.getItem(AI_NAMES_KEY);
      if (v) {
        const arr = JSON.parse(v);
        if (Array.isArray(arr) && arr.length === 2) {
          return arr.map((s) => String(s).slice(0, 12));
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveAINames(names) {
    try { localStorage.setItem(AI_NAMES_KEY, JSON.stringify(names)); } catch (e) { /* ignore */ }
  }

  // 手动切换画质（高/低）：写回记忆 + 立即生效（低画质 → 分辨率降档 + 清观众席缓存）
  function setQuality(mode) {
    app.quality.mode = mode === 'low' ? 'low' : 'high';
    app.quality.low = app.quality.mode === 'low';
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(QUALITY_KEY, app.quality.mode); } catch (e) { /* ignore */ }
    if (PPD.TTG && PPD.TTG.clearCrowdCache) PPD.TTG.clearCrowdCache();
    if (PPD.ui.setNoCrowd) PPD.ui.setNoCrowd.disabled = app.quality.low; // 低画质观众恒关，勾选框置灰
    PPD.resize();
  }

  // 关闭环境观众（勾选框）：写回记忆 + 立即生效（清观众席缓存，避免旧缓存带观众）
  function setNoCrowd(v) {
    app.noCrowd = !!v;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(NO_CROWD_KEY, app.noCrowd ? '1' : '0'); } catch (e) { /* ignore */ }
    if (PPD.TTG && PPD.TTG.clearCrowdCache) PPD.TTG.clearCrowdCache();
  }

  // 切换帧率上限（30/45/60/无上限）：渲染门控即时生效（物理仍 120Hz；无上限=每帧 RAF 都渲染）
  function setFrameRate(f) {
    app.quality.frameRate = f === 30 || f === 45 || f === 'unlimited' ? f : 60;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(FRAME_RATE_KEY, String(app.quality.frameRate)); } catch (e) { /* ignore */ }
  }

  // 单个难度下拉的地狱选项：按解锁状态显示（人机 + AI 观战主页/暂停面板共用）
  function syncHellOption(sel) {
    const opt = sel && sel.querySelector ? sel.querySelector('option[value="3"]') : null;
    if (!opt) return;
    opt.disabled = !isHellUnlocked();
    opt.textContent = isHellUnlocked() ? '地狱' : '地狱 🔒（击败困难解锁）';
  }
  // 全量同步 5 个难度下拉（主页人机 + AI观战红/蓝 + 暂停面板红/蓝）
  function syncHellOptions() {
    syncHellOption(PPD.ui.aiLevel);
    syncHellOption(PPD.ui.aiLevelA);
    syncHellOption(PPD.ui.aiLevelB);
    syncHellOption(PPD.ui.pauseAiLevelA);
    syncHellOption(PPD.ui.pauseAiLevelB);
  }

  // 解锁地狱模式并全量同步所有难度下拉框状态
  function unlockHell() {
    if (hellUnlockedMem) return;
    hellUnlockedMem = true;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(HELL_KEY, '1'); } catch (e) { /* ignore */ }
    syncHellOptions();
  }

  // ---------- 地狱通关（人机击败地狱难度，localStorage 持久化） ----------
  // 与「解锁地狱」不同：解锁=击败困难；通关=击败地狱。通关后解锁人机暂停的电脑 AI 数值调控。
  const HELL_CLEARED_KEY = 'ppd_hell_cleared';
  let hellClearedMem = false;
  try {
    hellClearedMem = typeof localStorage !== 'undefined' && localStorage.getItem(HELL_CLEARED_KEY) === '1';
  } catch (e) { /* ignore */ }

  function isHellCleared() { return hellClearedMem; }
  function markHellCleared() {
    if (hellClearedMem) return;
    hellClearedMem = true;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(HELL_CLEARED_KEY, '1'); } catch (e) { /* ignore */ }
  }

  // 得分后触发观众反应：得分方（winner 0=红 1=蓝）欢呼，对方观众摇头
  function triggerCheer(winner) {
    app.fan.cheer[winner] = 1;
    app.fan.shake[1 - winner] = 1;
    // 强制下一帧渲染：确保 fan 非零后动画层立即烘焙（30Hz 烘焙的 animDue 依赖渲染帧，
    // 若本帧渲染已过/被跳过，下一帧必须补上，否则动画期观众消失——"一欢呼人少一半"）
    app.resizeDirty = true;
  }

  // 按比分更新背景音乐紧张强度：
  // 0=常规，1=胶着（总分 ≥6），2=赛点/局点/10 平（紧张感拉满）
  function updateMusicIntensity(score) {
    let lvl = 0;
    if (score) {
      const a = score[0] | 0, b = score[1] | 0;
      const win = PPD.TT.RULES.WIN_SCORE;
      const max = Math.max(a, b), diff = Math.abs(a - b);
      if ((a >= win - 1 && b >= win - 1) || (max >= win - 1 && diff <= 1)) lvl = 2;
      else if (a + b >= 6) lvl = 1;
    }
    PPD.GameAudio.setIntensity(lvl);
  }

  window.PPD = {
    app, ui, canvas, ctx,
    TT, TTG, GameAudio, NetClient, AIC,
    $id, show, resize,
    wsUrl, isLocalHost, isTouch,
    isHellUnlocked, unlockHell, syncHellOptions,
    isHellCleared, markHellCleared, syncHellOptions,
    setQuality, setFrameRate, setNoCrowd,
    getPlayerName, loadAINames, saveAINames,
    triggerCheer, updateMusicIntensity,
  };
})();
