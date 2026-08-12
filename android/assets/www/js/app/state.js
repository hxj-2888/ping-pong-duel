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
    tuneResetA: document.getElementById('tuneResetA'),
    tuneResetB: document.getElementById('tuneResetB'),
    tuneResetOpp: document.getElementById('tuneResetOpp'),
    apkHelpLink: document.getElementById('apkHelpLink'), // 手机端：下载帮助页入口（百度/微信等浏览器拦截时用）
    btnHost: document.getElementById('btnHost'),
    btnJoin: document.getElementById('btnJoin'),
    btnNetMode: document.getElementById('btnNetMode'),
    joinInput: document.getElementById('joinInput'),
    lanTargetRow: document.getElementById('lanTargetRow'),     // 本地联机：对方设备地址输入行（联机框内）
    lanTargetInput: document.getElementById('lanTargetInput'),
    lanFirewallNote: document.getElementById('lanFirewallNote'), // 房主面板：手动放行防火墙提醒
    // 联机框（主页「联机对战」入口打开的全屏面板，等同新开页面；原 roomPanel 合并为内部等待区）
    netPanel: document.getElementById('netPanel'),
    btnNetEntry: document.getElementById('btnNetEntry'),
    btnNetBack: document.getElementById('btnNetBack'),
    btnNetWarn: document.getElementById('btnNetWarn'),
    netWarnNote: document.getElementById('netWarnNote'),
    netWait: document.getElementById('netWait'),
    netStatus: document.getElementById('netStatus'),
    netOperate: document.getElementById('netOperate'), // 建房等待态整体隐藏（无需再输房间号）
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
    roomCode: document.getElementById('roomCode'),
    roomHint: document.getElementById('roomHint'),
    lanUrls: document.getElementById('lanUrls'),
    statusBar: document.getElementById('statusBar'),
    btnDownloadApk: document.getElementById('btnDownloadApk'), // 手机端：下载安卓版 APK
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
    hrSmashRow: document.getElementById('hrSmashRow'), // 可扣杀行（AI 观战隐藏）
    hrLobRow: document.getElementById('hrLobRow'),     // 可高吊行（AI 观战隐藏）
    quality: document.getElementById('quality'),
    setNoCrowd: document.getElementById('setNoCrowd'),
    appVersion: document.getElementById('appVersion'),
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
    // 说明书（独立全屏页面，等同新开页面；电脑/手机统一入口=主页设置按钮下方）
    manualPanel: document.getElementById('manualPanel'),
    btnManualMenu: document.getElementById('btnManualMenu'),
    btnManualBack: document.getElementById('btnManualBack'),
    manualScroll: document.getElementById('manualScroll'),           // 说明书内容滚动区
    manualScrollbar: document.getElementById('manualScrollbar'),     // 说明书滑钮滑轨（手机端）
    manualScrollThumb: document.getElementById('manualScrollThumb'), // 说明书滑钮
  };

  // 联机服务器选择：
  // - 本地 localhost + 选"本地" → node server.js（ws://localhost:端口，局域网可用）
  // - 本地 localhost + 选"公网" → Cloudflare 联机端点（wss://ping-pong-duel.pages.dev/ws）
  // - 局域网页面（http://本机IP:端口，默认"本地"）→ 自动连回当前页面地址即本地服务器
  // - 网页版（https，默认"公网"）→ 同域 /ws（Cloudflare）；浏览器安全策略禁止 https 页面
  //   直连局域网 ws://（混合内容，实测构造即被拦截），此时"本地"仅作为输入/引导用
  const isLocalHost = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  const isHttps = location.protocol === 'https:';
  // 网页版判定：非本机 + https（pages.dev 等；workers.dev 在国内被 DNS 污染，不走）。
  // ?web=1 为调试钩子（与 ?touch=1/?desktop=1 同类）：强制按网页版行为走
  // （本地联机"探索中"暂不开放、个人生涯禁用），便于在局域网页面直接验证网页版 UI。
  const isWebVersion = (!isLocalHost && isHttps) || /[?&]web=1/.test(location.search);
  function wsUrl() {
    if (!app.publicServer) {
      // 本地模式：本地服务器（node server.js）一律是明文 ws；
      // 优先用"对方设备地址"（房主 IP:端口，网页版/局域网页面可手动填），否则自动用当前页面地址
      const t = (app.lanTarget || '').trim();
      const host = t || location.host;
      if (host) return 'ws://' + host;
      // 无 host（内置安卓版 file:// 页面）：本地模式没有可连的服务器，退回公网默认
      return 'wss://ping-pong-duel.pages.dev/ws';
    }
    // 公网模式：桌面端默认 Cloudflare，网页版/局域网页面默认同域 /ws
    if (isLocalHost) {
      return 'wss://ping-pong-duel.pages.dev/ws'; // 桌面端切公网：默认直连 Cloudflare
    }
    return (isHttps ? 'wss://' : 'ws://') + location.host + '/ws';
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
    version: '1.7.0',      // 应用版本（与 package.json / AndroidManifest 一致，设置面板显示）
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
    publicServer: false, // 联机服务器：false=本地（node server.js）/ true=公网（Cloudflare/同域 /ws）
    lanTarget: '',        // 本地联机"对方设备地址"（IP 或 IP:端口；留空=自动用当前页面地址）
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
    _lastKeysSent: -1,   // 最近发送的输入位掩码（loop.js 变化即发 + 50ms 节流用）
    // 联机本地玩家输入预测状态（render.js stepPrediction 每帧按本地按键积分，
    // 消除公网 ~RTT+插值 的自身控制延迟；快照到达时以服务器为锚校正）
    pred: null,
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
    dpr: 1,              // 当前画布像素比（高画质=设备像素比；低画质=1/封顶）
    resizeDirty: false,  // 暂停/结算期间窗口尺寸变化 → 需要补一帧渲染
    // 画质：mode='high'（默认高画质，不封顶）/ 'medium'（中画质：电脑高度 1920p 封顶 / 手机宽 750p）/ 'low'（低画质省电：电脑 1080p / 手机宽 400p）；low=当前低画质标记；
    // frameRate=渲染帧率上限（30/60/无上限，默认无上限自动匹配设备刷新率，物理仍 120Hz 步进）
    quality: { mode: 'high', low: false, frameMs: 16.67, frameRate: 'unlimited' },
    noCrowd: true, // 关闭环境观众（设置面板勾选框，默认关闭；低画质/联机恒为无观众）
  };

  // ---------- 工具 ----------
  function $id(id) { return document.getElementById(id); }
  function show(el, v) { if (el) el.style.display = v ? '' : 'none'; }

  function resize() {
    app.resizeW = window.innerWidth;
    app.resizeH = window.innerHeight;
    // 分辨率档位：高画质**不封顶**——dpr 直接用设备像素比，自动适配设备最高屏幕分辨率；
    // 中/低画质渲染物理像素封顶到目标分辨率（超出的屏按比例降 DPR，避免无谓填充率）——
    // 中画质=电脑高度 1920p 封顶（2K+ 级，16:9 下 ≈3413×1920）/ 手机宽 750p；
    // 低画质=电脑 1920×1080（1080p）双封顶 / 手机宽 400p。
    // 渲染坐标仍用 CSS 像素（setTransform 缩放）；dpr<1（如 4K 屏选中/低画质）→ 降分辨率放大显示，属预期省电
    const rw = Math.max(1, app.resizeW), rh = Math.max(1, app.resizeH);
    const m = (app.quality && app.quality.mode) || 'high';
    let cap = 0;
    if (m === 'low') cap = isTouch ? 400 / rw : Math.min(1920 / rw, 1080 / rh); // 低：手机 400p / 电脑 1080p
    else if (m === 'medium') cap = isTouch ? 750 / rw : 1920 / rh;               // 中：手机 750p / 电脑 1920p（高）
    const dpr = cap > 0 ? Math.min(window.devicePixelRatio || 1, cap) : (window.devicePixelRatio || 1); // 高：不封顶
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

  // ---------- 画质（高/中/低三档，默认高；localStorage 记忆） ----------
  const QUALITY_KEY = 'ppd_quality';
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(QUALITY_KEY) : null;
    if (v === 'low' || v === 'medium' || v === 'high') app.quality.mode = v;
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

  // ---------- 帧率上限（30/60/无上限，默认无上限自动匹配设备刷新率；localStorage 记忆） ----------
  const FRAME_RATE_KEY = 'ppd_frame_rate';
  try {
    const raw = localStorage.getItem(FRAME_RATE_KEY);
    if (raw === 'unlimited') app.quality.frameRate = 'unlimited';
    else {
      const v = parseInt(raw, 10);
      if (v === 30 || v === 60) app.quality.frameRate = v;
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

  // 手动切换画质（高/中/低）：写回记忆 + 立即生效（中/低画质 → 分辨率降档 + 清观众席缓存；低画质观众恒关）
  function setQuality(mode) {
    const m = mode === 'low' || mode === 'medium' ? mode : 'high';
    app.quality.mode = m;
    app.quality.low = m === 'low';
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

  // 切换帧率上限（30/60/无上限）：渲染门控即时生效（物理仍 120Hz；无上限=每帧 RAF 都渲染）
  function setFrameRate(f) {
    app.quality.frameRate = f === 30 || f === 60 || f === 'unlimited' ? f : 'unlimited';
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
    wsUrl, isLocalHost, isHttps, isWebVersion, isTouch,
    isHellUnlocked, unlockHell, syncHellOptions,
    isHellCleared, markHellCleared, syncHellOptions,
    setQuality, setFrameRate, setNoCrowd,
    getPlayerName, loadAINames, saveAINames,
    triggerCheer, updateMusicIntensity,
  };
})();
