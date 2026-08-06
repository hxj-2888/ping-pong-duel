/* 浏览器冒烟测试：在 DOM/Canvas 桩中运行全部前端脚本
 * 覆盖：本地双人启动、四键映射、发球、渲染循环、联机建房/加入、HUD 视角调换
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const TT = require('../public/js/engine.js');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'public', 'js');
const SCRIPTS = [
  'engine/rules.js', 'engine/math.js', 'engine/state.js', 'engine/physics.js',
  'engine/shots.js', 'engine/strokes.js', 'engine.js',
  'render.js', 'characters.js', 'network.js', 'audio.js', 'ai.js',
  'app/state.js', 'app/records.js', 'app/input.js', 'app/render.js', 'app/hud.js',
  'app/net.js', 'app/modes.js', 'app/loop.js', 'app/main.js',
];

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

function makeCtx2d() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      return () => {};
    },
    set() { return true; },
  });
}

function makeElement(id) {
  const handlers = {};
  const classes = new Set();
  const el = {
    id,
    style: {},
    value: '',
    width: 0,
    height: 0,
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    dispatch(type, ev) { for (const fn of handlers[type] || []) fn(ev); },
    getContext: () => makeCtx2d(),
    // 难度下拉的地狱 option 桩（syncHellOption 查询 option[value="3"]）
    querySelector(sel) {
      if (sel === 'option[value="3"]') {
        if (!this._hellOpt) this._hellOpt = { disabled: true, textContent: '地狱 🔒（击败困难解锁）' };
        return this._hellOpt;
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 100, top: 500, width: 132, height: 132, right: 232, bottom: 632 };
    },
  };
  // 与浏览器一致：textContent/innerHTML 赋值自动转字符串
  for (const prop of ['textContent', 'innerHTML']) {
    Object.defineProperty(el, prop, {
      get() { return this['_' + prop]; },
      set(v) { this['_' + prop] = v == null ? '' : String(v); },
    });
  }
  el.textContent = '';
  el.innerHTML = '';
  return el;
}

const ELEMENT_IDS = [
  'game', 'menu', 'gameScreen', 'nameInput', 'btnLocal', 'btnHost', 'btnJoin', 'btnNetMode',
  'joinInput', 'btnSettings', 'btnSettingsGame', 'settingsPanel', 'btnSettingsClose',
  'setShowHitRanges', 'setMusic', 'setSound', 'setMusicVol', 'setSfxVol', 'roomPanel', 'roomCode', 'roomHint', 'btnRoomBack', 'statusBar',
  'overlay', 'overlayTitle', 'overlayText', 'overlayBtn', 'hud', 'hudP1', 'hudP2',
  'phaseBanner', 'pointToast', 'hintBar', 'netInfo', 'hitRangeInfo', 'hitBallVal', 'hitPaddleVal', 'ballHeight', 'inBoxStatus', 'serveDot', 'tips',
  'score1', 'score2', 'btnAI', 'aiLevel', 'btnAIVsAI', 'aiLevelA', 'aiLevelB', 'pauseAiLevelA', 'pauseAiLevelB', 'pauseAiNameA', 'pauseAiNameB', 'pauseAIVsAI',
  'tuneAReact', 'tuneACatch', 'tuneASmash', 'tuneAAgility', 'tuneBReact', 'tuneBCatch', 'tuneBSmash', 'tuneBAgility',
  'gameOver', 'gameOverTitle', 'btnAgain', 'btnMenu', 'btnQuit',
  'touchControls', 'joyBase', 'joyKnob', 'btnCrouch', 'btnSmash',
  'gameTools', 'btnPause', 'btnExit', 'fpsMeter',
  'pausePanel', 'btnResume', 'btnPauseExit',
  'pauseAITune', 'tuneOppReact', 'tuneOppCatch', 'tuneOppSmash', 'tuneOppAgility', // 人机：地狱通关后的电脑 AI 数值调控
  'quality', 'frameRate', // 画质(高/低) + 帧率上限(30/45/60)
  'bgmAudio', // raw 游戏音乐 <audio> 元素（audio.js loadBGM 挂接）
  'recordsPanel', // 个人生涯小方框（records.js 渲染摘要，点击展开整页）
  'careerPanel', 'careerStats', 'careerList', 'careerPageLabel', 'btnCareerPrev', 'btnCareerNext', 'btnCareerBack', // 个人生涯单开页（分页）
];

function boot(opts) {
  opts = opts || {};
  const elements = new Map();
  for (const id of ELEMENT_IDS) elements.set(id, makeElement(id));
  elements.get('nameInput').value = '测试员';
  // bgmAudio：<audio> 元素桩（play/pause/paused/src/volume/loop）
  const bgm = elements.get('bgmAudio');
  Object.assign(bgm, {
    _paused: true, src: '', volume: 0, loop: false, preload: '',
    play() { this._paused = false; },
    pause() { this._paused = true; },
  });
  // paused 用访问器（Object.assign 会把 getter 求值成粘滞的数据属性，导致
  // play()/pause() 后 paused 不变——真实 <audio> 的 paused 是随播放状态实时变化的）
  Object.defineProperty(bgm, 'paused', {
    get() { return this._paused; },
    set(v) { this._paused = v; },
  });

  const winHandlers = {};
  const rafQueue = [];
  const sentMessages = [];
  let fakeWS = null;
  const perf = { t: 1000, now() { return this.t; } };

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      fakeWS = this;
      setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 0);
    }
    send(data) { this.sent.push(data); sentMessages.push(JSON.parse(data)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    static get OPEN() { return 1; }
  }

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: perf,
    location: { protocol: 'http:', host: '127.0.0.1:8781', search: opts.search || '' },
    document: { getElementById: (id) => elements.get(id) },
    navigator: { userAgent: 'smoke', maxTouchPoints: opts.touch ? 5 : 0 },
    matchMedia: opts.matchMedia ? opts.matchMedia : (opts.touch ? () => ({ matches: true }) : undefined),
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: () => {},
    WebSocket: FakeWebSocket,
    innerWidth: opts.width || 1280,
    innerHeight: opts.height || 720,
    devicePixelRatio: 2, // 高分屏：验证 DPR 上限（高画质=2、低画质=1）
    addEventListener(type, fn) { (winHandlers[type] = winHandlers[type] || []).push(fn); },
    Math, JSON, Object, Array, Number, String, Boolean, Date, RegExp, Error, Promise,
    isFinite, isNaN, parseInt, parseFloat,
    // 通关记录 fetch 桩：默认无后端（ok:false），测试可注入 opts.fetch 捕获请求
    fetch: opts.fetch || (() => Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false, records: [] }) })),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  for (const f of SCRIPTS) {
    const code = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    vm.runInContext(code, context, { filename: f });
  }

  const api = {
    elements,
    winHandlers,
    rafQueue,
    sentMessages,
    get fakeWS() { return fakeWS; },
    get app() { return sandbox.__PPD.app; },
    get ppd() { return sandbox.__PPD; },
    runFrames(n, stepMs = 16.67) {
      for (let i = 0; i < n; i++) {
        const fns = rafQueue.splice(0);
        perf.t += stepMs;
        for (const fn of fns) fn(perf.t);
      }
    },
    key(code, down = true) {
      const ev = { code, preventDefault() {} };
      for (const fn of winHandlers[down ? 'keydown' : 'keyup'] || []) fn(ev);
    },
    click(id) { elements.get(id).dispatch('click', {}); },
    tap(x, y) {
      const ev = { pointerType: 'mouse', button: 0, clientX: x, clientY: y, preventDefault() {} };
      elements.get('game').dispatch('pointerdown', ev);
    },
    tapTouch(x, y) {
      const ev = { pointerType: 'touch', button: 0, clientX: x, clientY: y, preventDefault() {} };
      elements.get('game').dispatch('pointerdown', ev);
    },
    tapRight(x, y) {
      const ev = { pointerType: 'mouse', button: 2, clientX: x, clientY: y, preventDefault() {} };
      elements.get('game').dispatch('pointerdown', ev);
    },
    joyDown(x, y) {
      const ev = { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, preventDefault() {} };
      elements.get('joyBase').dispatch('pointerdown', ev);
    },
    joyMove(x, y) {
      const ev = { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y, preventDefault() {} };
      elements.get('joyBase').dispatch('pointermove', ev);
    },
    joyUp() {
      const ev = { pointerId: 7, pointerType: 'touch', clientX: 0, clientY: 0, preventDefault() {} };
      elements.get('joyBase').dispatch('pointerup', ev);
    },
    move(x, y) {
      const ev = { clientX: x, clientY: y, preventDefault() {} };
      elements.get('game').dispatch('pointermove', ev);
    },
    feed(msg) { if (fakeWS && fakeWS.onmessage) fakeWS.onmessage({ data: JSON.stringify(msg) }); },
  };
  return api;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSnap(score0, score1, server, overrides) {
  const e = TT.createEngine();
  e.score = [score0, score1];
  e.server = server;
  const snap = TT.snapshot(e);
  return Object.assign({}, snap, overrides || {});
}

async function main() {
  // ---------- 1. 本地双人 ----------
  {
    const t = await boot();
    check('菜单启动：模式为空', t.app.mode === null);
    t.click('btnLocal');
    check('本地模式已启动', t.app.mode === 'local' && !!t.app.engine);
    check('左上角显示接球箱尺寸', t.elements.get('hitBallVal').textContent === `${(TT.RULES.HITBOX_HX * 2).toFixed(1)}×${(TT.RULES.HITBOX_HZ * 2).toFixed(1)}×${(TT.RULES.HITBOX_Y_TOP - TT.RULES.HITBOX_Y_BOTTOM).toFixed(1)}m`);
    check('左上角显示蹲下最低接球', t.elements.get('hitPaddleVal').textContent === `低至 ${TT.RULES.CROUCH_HITBOX_Y_BOTTOM}m`);
    check('判定范围虚线默认关闭', t.app.showHitRanges === false);
    t.runFrames(3);
    check('默认关闭：左上角判定面板隐藏', t.elements.get('hitRangeInfo').style.display === 'none');
    // 设置面板：打开 → 开启虚线 → 立即生效；再关闭
    t.elements.get('btnSettings').dispatch('click', {});
    check('设置面板打开', t.elements.get('settingsPanel').style.display !== 'none');
    t.elements.get('setShowHitRanges').checked = true;
    t.elements.get('setShowHitRanges').dispatch('change', {});
    t.runFrames(3);
    check('设置开启虚线后立即显示', t.app.showHitRanges === true &&
      t.ppd.viewModelFromEngine(t.app.engine, 0).showHitRanges === true);
    check('开启后：左上角判定面板显示', t.elements.get('hitRangeInfo').style.display === '');
    t.elements.get('setShowHitRanges').checked = false;
    t.elements.get('setShowHitRanges').dispatch('change', {});
    t.runFrames(3);
    check('设置关闭虚线后立即隐藏', t.app.showHitRanges === false &&
      t.ppd.viewModelFromEngine(t.app.engine, 0).showHitRanges === false);
    check('关闭后：左上角判定面板整体隐藏', t.elements.get('hitRangeInfo').style.display === 'none');
    t.elements.get('btnSettingsClose').dispatch('click', {});
    check('设置面板关闭', t.elements.get('settingsPanel').style.display === 'none');
    // 画质：默认高；切低 → 生效标记 + 视图模型 low/虚线临时关闭（用户勾选不变）；帧率默认 60
    check('画质默认高（DPR 上限 2）', t.app.quality.mode === 'high' && t.app.quality.low === false && t.app.dpr === 2);
    check('帧率上限默认 60', t.app.quality.frameRate === 60);
    check('右上角帧数元素存在', !!t.elements.get('fpsMeter'));
    t.elements.get('quality').value = 'low';
    t.elements.get('quality').dispatch('change', {});
    t.runFrames(3);
    check('切低画质生效（low 标记 + DPR→1）', t.app.quality.low === true && t.app.dpr === 1);
    const vmLow = t.ppd.viewModelFromEngine(t.app.engine, 0);
    check('低画质视图模型：low=true 且虚线临时关闭', vmLow.low === true && vmLow.showHitRanges === false);
    t.elements.get('quality').value = 'high';
    t.elements.get('quality').dispatch('change', {});
    t.runFrames(3);
    check('切回高画质恢复（low 清除 + DPR 回 2）', t.app.quality.low === false && t.app.quality.mode === 'high' && t.app.dpr === 2);
    t.elements.get('frameRate').value = '30';
    t.elements.get('frameRate').dispatch('change', {});
    t.runFrames(2);
    check('切帧率上限 30 生效', t.app.quality.frameRate === 30);
    // 无上限：每帧 RAF 都渲染（shouldRender 恒真）
    t.elements.get('frameRate').value = 'unlimited';
    t.elements.get('frameRate').dispatch('change', {});
    t.runFrames(2);
    check('切无上限帧率生效', t.app.quality.frameRate === 'unlimited');
    t.runFrames(8);
    check('无上限渲染 8 帧无异常', true);
    // 无上限：右上角显示真实帧率（8ms/帧步长 → ~125fps，不再封顶 60；130 帧冲掉 60 帧滚动窗）
    t.runFrames(130, 8);
    check('无上限显示真实帧率（>60，8ms 步长≈125）',
      Number(t.elements.get('fpsMeter').textContent) > 60 && t.app.quality.frameMs < 12);
    t.elements.get('frameRate').value = '60';
    t.elements.get('frameRate').dispatch('change', {});
    t.runFrames(2);
    check('切回帧率上限 60', t.app.quality.frameRate === 60);
    t.runFrames(80);
    check('60 档帧率显示恢复封顶 60', t.elements.get('fpsMeter').textContent === '60');
    t.runFrames(10);
    check('本地渲染 10 帧无异常', true);
    check('左上角实时显示球高', /^\d+\.\d{2}m$/.test(t.elements.get('ballHeight').textContent));
    check('左上角进箱状态有颜色标记', t.elements.get('inBoxStatus').className === 'on' || t.elements.get('inBoxStatus').className === 'off');

    // 四键：P1
    t.key('KeyD'); t.runFrames(30);
    check('P1 按 D 向右移动', t.app.engine.players[0].x > 0.2);
    t.key('KeyD', false);
    t.key('KeyA'); t.runFrames(60);
    check('P1 按 A 向左移动', t.app.engine.players[0].x < -0.2);
    t.key('KeyA', false);

    // 四键：P2
    t.key('ArrowRight'); t.runFrames(30);
    check('P2 按 → 向右移动', t.app.engine.players[1].x > 0.2);
    t.key('ArrowRight', false);
    t.key('ArrowLeft'); t.runFrames(60);
    check('P2 按 ← 向左移动', t.app.engine.players[1].x < -0.2);
    t.key('ArrowLeft', false);

    // 触控摇杆 + 蹲下按钮：桌面环境应隐藏；摇杆拖动应正确驱动 P1（全方位）
    check('桌面环境：触控控件隐藏', t.elements.get('touchControls').style.display === 'none');
    t.app.engine.players[0].x = 0;
    t.app.engine.players[0].vx = 0;
    t.app.engine.players[0].padX = 0;
    t.joyDown(210, 566); // 摇杆右推
    t.runFrames(30);
    check('摇杆右推：P1 向右移动', t.app.engine.players[0].x > 0.2);
    t.joyUp();
    const zBeforeFwd = t.app.engine.players[0].z;
    t.joyDown(166, 510); // 摇杆上推（向前）
    t.runFrames(30);
    check('摇杆上推：P1 向前移动', t.app.engine.players[0].z > zBeforeFwd + 0.05);
    t.joyUp();
    t.runFrames(20);
    const zAfterFwd = t.app.engine.players[0].z;
    t.joyDown(166, 620); // 摇杆下推（向后）
    t.runFrames(30);
    check('摇杆下推：P1 向后移动', t.app.engine.players[0].z < zAfterFwd - 0.05);
    t.joyUp();
    // 斜向：右+上 同时生效（全方位移动）
    t.app.engine.players[0].x = 0; t.app.engine.players[0].padX = 0;
    const zDiag = t.app.engine.players[0].z;
    t.joyDown(210, 510);
    t.runFrames(30);
    check('摇杆斜推：右+前同时生效', t.app.engine.players[0].x > 0.1 && t.app.engine.players[0].z > zDiag + 0.02);
    t.joyUp();
    // 蹲下按钮（手机端）：按住蹲下 / 松开恢复
    t.elements.get('btnCrouch').dispatch('pointerdown', { preventDefault() {} });
    t.runFrames(2);
    check('蹲下按钮：P1 蹲下生效', t.app.engine.players[0].crouch === 1);
    t.elements.get('btnCrouch').dispatch('pointerup', { preventDefault() {} });
    // 蹲站转换有延迟（3秒内反复蹲站会累计，首次松开也需 0.15s），多跑几帧等过渡完成
    t.runFrames(24);
    check('松开蹲下按钮：恢复站立（转换延迟后）', t.app.engine.players[0].crouch === 0);
    // 扣球按钮（手机端）：单按=扣球（进入扣球挥拍 type2；替代原双击扣球）
    {
      const e = t.app.engine;
      TT.resetMatch(e);
      e.phase = 'play'; e.serveStage = 'rally'; e.mayHit = [true, false];
      e.ball.inHand = false;
      e.ball.pos = { x: 0, y: 1.20, z: -1.55 };
      e.ball.vel = { x: 0, y: 0.4, z: 3.0 };
      e.ball.spin = { x: 0, y: 0, z: 0 };
      e.ball.hitBy = 1; e.ball.lastBounce = 1;
      t.runFrames(2);
      t.elements.get('btnSmash').dispatch('pointerdown', { preventDefault() {} });
      t.runFrames(3);
      check('扣球按钮：P1 进入扣球挥拍', t.app.engine.players[0].stroke.active && t.app.engine.players[0].stroke.type === 2);
      t.elements.get('btnSmash').dispatch('pointerup', { preventDefault() {} });
    }

    // Shift 跑步加速 / Ctrl 蹲下减速（电脑端按键）
    const p0 = t.app.engine.players[0];
    const moveDist = (run, crouch) => {
      p0.x = 0; p0.padX = 0; p0.z = -1.65; p0.vx = 0; p0.vz = 0;
      t.runFrames(2);
      if (run) t.key('ShiftLeft');
      if (crouch) t.key('ControlLeft');
      t.key('KeyD');
      t.runFrames(20);
      const d = p0.x;
      t.key('KeyD', false);
      if (run) t.key('ShiftLeft', false);
      if (crouch) t.key('ControlLeft', false);
      return d;
    };
    const dN = moveDist(false, false);
    const dR = moveDist(true, false);
    const dC = moveDist(false, true);
    check('Shift 跑步：移动速度明显变快', dR > dN * 1.25);
    check('Ctrl 蹲下：移动速度明显变慢且蹲姿生效', dC < dN * 0.8 && t.app.engine.players[0].crouch === 1);
    // Ctrl+W：浏览器“关闭窗口”快捷键应被拦截，游戏内表现为蹲下+向前移动
    let pdW = false;
    t.app.keyP1.crouch = 0; t.app.keyP1.f = 0;
    for (const fn of t.winHandlers.keydown || []) fn({ code: 'ControlLeft', ctrlKey: false, preventDefault() {} });
    const evW = { code: 'KeyW', ctrlKey: true, preventDefault() { pdW = true; } };
    for (const fn of t.winHandlers.keydown || []) fn(evW);
    check('Ctrl+W 被拦截（不会关闭游戏窗口）', pdW);
    check('Ctrl+W 触发蹲下+向前', t.app.keyP1.crouch === 1 && t.app.keyP1.f === 1);
    for (const fn of t.winHandlers.keyup || []) fn({ code: 'KeyW', ctrlKey: true, preventDefault() {} });
    for (const fn of t.winHandlers.keyup || []) fn({ code: 'ControlLeft', ctrlKey: false, preventDefault() {} });

    // 蹲下能接远台低球（不蹲下接不到）
    const lowBallSetup = (crouch) => {
      const eng = t.app.engine;
      TT.resetMatch(eng);
      const p = eng.players[0];
      p.x = 0; p.padX = 0; p.z = -1.65; p.vx = 0; p.vz = 0; p.crouch = crouch ? 1 : 0;
      eng.phase = 'play'; eng.serveStage = 'rally'; eng.mayHit = [true, true];
      eng.ball.inHand = false;
      eng.ball.pos = { x: 0.2, y: 0.82, z: -1.3 };
      eng.ball.vel = { x: 0, y: -0.3, z: -1.2 };
      eng.ball.spin = { x: 0, y: 0, z: 0 };
      eng.ball.hitBy = 1; eng.ball.lastBounce = 1;
      t.app.keyP1 = { l: 0, r: 0, f: 0, b: 0, pu: 1, sm: 0, crouch: crouch ? 1 : 0, run: 0 };
      t.runFrames(60);
      return eng.ball.hitBy === 0;
    };
    const lowHitCrouch = lowBallSetup(true);
    const lowHitNormal = lowBallSetup(false);
    check('蹲下可接远台低球', lowHitCrouch);
    check('不蹲下接不到远台低球', !lowHitNormal);
    t.app.keyP1 = { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, crouch: 0, run: 0 };

    // 把 P1 站位恢复到台面中路附近，再测发球瞄准
    const setStance = (side, padX, z) => {
      const p = t.app.engine.players[side];
      p.padX = padX; p.x = padX - p.facing * 0.18; p.z = z; p.vx = 0; p.vz = 0;
    };
    TT.resetMatch(t.app.engine);
    setStance(0, 0, -1.65);
    t.runFrames(5);

    // 发球瞄准（鼠标）：移动鼠标 → 发球轨迹跟随，落点始终在对方半台台面上
    t.move(500, 300);
    t.runFrames(2);
    check('鼠标移动：P1 进入发球瞄准', t.app.engine.players[0].serveAimSet && !!t.app.engine.players[0].servePlan);
    const aim0 = t.app.serveAim;
    check('瞄准落点位于对方半台', !!aim0 && aim0.z > 0 && Math.abs(aim0.z) <= 1.23 && Math.abs(aim0.x) <= 0.67);
    t.move(300, 360);
    t.runFrames(2);
    check('瞄准落点随鼠标移动而改变',
      t.app.serveAim && (Math.abs(t.app.serveAim.x - aim0.x) + Math.abs(t.app.serveAim.z - aim0.z) > 0.02));
    check('瞄准方案轨迹末端在对方半台台面上', (() => {
      const p = t.app.engine.players[0];
      const H = { x: Math.max(-1.35, Math.min(1.35, p.padX)), y: 0.98, z: p.z + p.facing * 0.52 };
      const land = TT.serveLanding(H, p.servePlan.vel, p.servePlan.spin, 0);
      return !!land && land.z > 0.001 &&
        Math.abs(land.z) <= TT.RULES.TABLE_LENGTH / 2 + 1e-6 &&
        Math.abs(land.x) <= TT.RULES.TABLE_WIDTH / 2 + 1e-6;
    })());
    check('发球预览轨迹已生成（末端=对方半台落点）', (() => {
      const view = t.ppd.viewModelFromEngine(t.app.engine, 0);
      const pts = view.servePath;
      if (!pts || pts.length < 2) return false;
      const last = pts[pts.length - 1];
      return last.z > 0 &&
        Math.abs(last.z) <= TT.RULES.TABLE_LENGTH / 2 + 1e-6 &&
        Math.abs(last.x) <= TT.RULES.TABLE_WIDTH / 2 + 1e-6;
    })());

    // 屏幕点击（鼠标）：单击（左半屏）→ 直接发球
    t.tap(300, 360);
    t.runFrames(3);
    check('单击发球：P1 进入发球挥拍', t.app.engine.players[0].stroke.active && t.app.engine.players[0].stroke.type === 1);
    t.runFrames(40);
    check('发球后进入对打', t.app.engine.phase === 'play' && !t.app.engine.ball.inHand);
    await sleep(90); // 真实时间等待发球按键脉冲清除

    // 站到台面最外侧：瞄准远角解不出合法发球 → 轨迹消失、发不出球
    TT.resetMatch(t.app.engine);
    setStance(0, 1.6, -2.2);
    t.runFrames(5);
    t.move(500, 300);
    t.runFrames(2);
    check('无法求解的瞄准：标记发球被阻止', t.app.engine.players[0].serveAimBlocked &&
      !t.app.engine.players[0].serveAimSet && !t.app.engine.players[0].servePlan);
    check('无法求解的瞄准：预览轨迹消失', (() => {
      const view = t.ppd.viewModelFromEngine(t.app.engine, 0);
      return view.servePath === null;
    })());
    t.tap(500, 300);
    t.runFrames(3);
    check('被阻止时单击发不出球', !t.app.engine.players[0].stroke.active && t.app.engine.phase === 'serve');

    // 手机端：点两下屏幕发球（第一下进入瞄准，移动手指调整轨迹，第二下发球）
    TT.resetMatch(t.app.engine);
    setStance(0, 0, -1.65);
    t.runFrames(5);
    t.tapTouch(300, 360);
    t.runFrames(2);
    check('手机第一下点按：进入瞄准不发球', t.app.serveAiming && !t.app.engine.players[0].stroke.active);
    t.move(520, 280);
    t.runFrames(2);
    check('手机瞄准：移动手指更新落点', t.app.engine.players[0].serveAimSet && !!t.app.serveAim);
    t.tapTouch(300, 360);
    t.runFrames(3);
    check('手机第二下点按：P1 发球', t.app.engine.players[0].stroke.active &&
      t.app.engine.players[0].stroke.type === 1 && !t.app.serveAiming);
    t.runFrames(40);
    check('手机发球后进入对打', t.app.engine.phase === 'play' && !t.app.engine.ball.inHand);
    await sleep(90);

    // 对打：单击立即推球 / 双击升级扣球（输入零延迟方案）
    TT.resetMatch(t.app.engine);
    setStance(0, 0, -1.65);
    t.runFrames(5);
    t.tap(300, 360); // 发球（瞄准可解）
    t.runFrames(3);
    t.runFrames(45);
    await sleep(90); // 发球脉冲清除
    t.runFrames(2);  // 引擎同步 prev，确保下一次单击产生上升沿
    t.tap(400, 360);
    t.runFrames(3);  // 零延迟：单击后下一帧立即出拍（无 280ms 双击判定等待）
    check('对打单击：P1 立即进入推球挥拍', t.app.engine.players[0].stroke.active && t.app.engine.players[0].stroke.type === 1);
    t.runFrames(20);
    await sleep(90);
    t.runFrames(2);
    TT.resetMatch(t.app.engine);
    setStance(0, 0, -1.65);
    t.runFrames(5);
    t.tap(300, 360); // 发球
    t.runFrames(3);
    t.runFrames(45);
    await sleep(90);
    t.runFrames(2);
    t.tap(400, 360); t.runFrames(1); // 左键推球，立即出拍（蓄力期）
    t.tapRight(400, 360);            // 右键扣球边沿 → 引擎把推球挥拍升级为扣球
    t.runFrames(3);
    check('右键扣球：推球挥拍升级为扣球', t.app.engine.players[0].stroke.active && t.app.engine.players[0].stroke.type === 2);
    t.runFrames(40);
    await sleep(90);
    // 右键单独扣球：直接进入扣球挥拍
    TT.resetMatch(t.app.engine);
    setStance(0, 0, -1.65);
    t.runFrames(5);
    t.tap(300, 360); // 发球
    t.runFrames(3);
    t.runFrames(45);
    await sleep(90);
    t.runFrames(2);
    t.tapRight(400, 360);
    t.runFrames(3);
    check('右键单独扣球：进入扣球挥拍', t.app.engine.players[0].stroke.active && t.app.engine.players[0].stroke.type === 2);
    t.runFrames(40);
    await sleep(90);

    // 方案四：感知辅助（仅判定范围显示开启时）——球进人类控制方箱体 → 提示音（上升沿一次）
    {
      const t2 = await boot();
      t2.ppd.app.showHitRanges = true; // 本测试聚焦提示音：显式开启判定显示（默认已关闭）
      t2.click('btnLocal');
      const eng2 = t2.app.engine;
      TT.resetMatch(eng2);
      const p2 = eng2.players[0];
      p2.x = 0; p2.padX = 0; p2.z = -1.65; p2.vx = 0; p2.vz = 0;
      eng2.phase = 'play'; eng2.serveStage = 'rally'; eng2.mayHit = [true, true];
      eng2.ball.inHand = false;
      eng2.ball.pos = { x: 0, y: 1.2, z: -1.5 };  // 台外、P1 箱内（箱心 z=-1.23）
      eng2.ball.vel = { x: 0, y: 0, z: 0 };
      eng2.ball.spin = { x: 0, y: 0, z: 0 };
      const readyCalls = { n: 0 };
      const origReady = t2.ppd.GameAudio.ready;
      t2.ppd.GameAudio.ready = () => { readyCalls.n++; };
      t2.runFrames(3);
      check('进箱提示：球在箱内时开启显示 → 响一次', readyCalls.n === 1);
      t2.runFrames(10);
      check('进箱提示：持续在箱内不重复响', readyCalls.n === 1);
      eng2.ball.pos = { x: 3, y: 1.2, z: -1.5 }; // 移出箱体
      t2.runFrames(3);
      check('进箱提示：球出箱后不响', readyCalls.n === 1);
      eng2.ball.pos = { x: 0, y: 1.2, z: -1.5 };
      t2.runFrames(3);
      check('进箱提示：再次进箱再响一次', readyCalls.n === 2);
      t2.ppd.app.showHitRanges = false; // 关闭显示 → 无提示
      eng2.ball.pos = { x: 3, y: 1.2, z: -1.5 };
      t2.runFrames(3);
      eng2.ball.pos = { x: 0, y: 1.2, z: -1.5 };
      t2.runFrames(3);
      check('进箱提示：关闭判定范围显示后不提示', readyCalls.n === 2);
      t2.ppd.GameAudio.ready = origReady;
    }

    // raw 游戏音乐：挂接 <audio> 元素 + 设置面板音乐/音效开关切换（无 AudioContext 环境走元素路径）
    {
      const t3 = await boot();
      const G = t3.ppd.GameAudio;
      G.ensure();
      check('raw 音乐：挂接 bgmAudio 元素（musicMode=raw）', G.musicMode() === 'raw');
      const bgm = t3.elements.get('bgmAudio');
      check('raw 音乐：元素 src 指向 music.mp4', /music\.mp4$/.test(bgm.src));
      const on0 = G.isMusicOn();
      t3.elements.get('setMusic').checked = !on0;
      t3.elements.get('setMusic').dispatch('change', {});
      check('设置-音乐开关：关闭 → 音乐暂停', G.isMusicOn() === false && bgm.paused === true);
      t3.elements.get('setMusic').checked = on0;
      t3.elements.get('setMusic').dispatch('change', {});
      check('设置-音乐开关：恢复 → 音乐播放', G.isMusicOn() === on0 && bgm.paused === false);
      t3.elements.get('setSound').checked = false;
      t3.elements.get('setSound').dispatch('change', {});
      check('设置-音效开关：关闭 → muted', G.isMuted() === true);
      check('独立性：关闭音效后音乐照常播放（音量不变）', bgm.paused === false && bgm.volume === 0.3);
      t3.elements.get('setSound').checked = true;
      t3.elements.get('setSound').dispatch('change', {});
      check('设置-音效开关：恢复 → 音效开启', G.isMuted() === false);
      t3.elements.get('setMusic').checked = false;
      t3.elements.get('setMusic').dispatch('change', {});
      check('独立性：关闭音乐不影响音效开关', G.isMusicOn() === false && G.isMuted() === false);
      t3.elements.get('setMusic').checked = true;
      t3.elements.get('setMusic').dispatch('change', {});
      // 音量滑杆：音乐/音效默认 30%/50%，拖动即生效且互不影响
      check('音量：默认音乐 30% / 音效 50%', G.getMusicVol() === 0.3 && G.getSfxVol() === 0.5);
      t3.elements.get('setMusicVol').value = '70';
      t3.elements.get('setMusicVol').dispatch('input', {});
      check('音量：音乐调到 70%', G.getMusicVol() === 0.7);
      t3.elements.get('setSfxVol').value = '20';
      t3.elements.get('setSfxVol').dispatch('change', {});
      check('音量：音效调到 20%', G.getSfxVol() === 0.2);
      check('音量：调音效不影响音乐音量', G.getMusicVol() === 0.7);
      check('音量：调音乐不影响音效音量', G.getSfxVol() === 0.2);
    }

    // 页面打开即播：主菜单加载后自动尝试播放；被自动播放策略拦截（沙盒无 AudioContext
    // 等价于浏览器拦截）时，挂接首次交互立即恢复出声，无需再点 🎵
    {
      const t4 = await boot();
      check('页面打开即播：尝试播放被拦截时保持待播（等首次交互）', t4.elements.get('bgmAudio').paused === true);
      for (const fn of t4.winHandlers.pointerdown || []) fn({ preventDefault() {} }); // 模拟首次点击
      check('页面打开即播：首次交互立即恢复播放', t4.elements.get('bgmAudio').paused === false);
    }

    // 键盘 W/S 已改为前后移动（推球/扣球改用鼠标单击/双击）
    TT.resetMatch(t.app.engine);
    t.runFrames(40);
    const zBeforeW = t.app.engine.players[0].z;
    t.key('KeyW'); t.runFrames(30);
    check('P1 按 W 向前移动（不触发挥拍）',
      t.app.engine.players[0].z > zBeforeW + 0.05 && !t.app.engine.players[0].stroke.active);
    t.key('KeyW', false);
    t.runFrames(30);
    const zAfterW = t.app.engine.players[0].z;
    t.key('KeyS'); t.runFrames(30);
    check('P1 按 S 向后移动', t.app.engine.players[0].z < zAfterW - 0.3);
    t.key('KeyS', false);
    t.runFrames(30);
    check('前后移动后渲染无异常', true);

    // 键盘推球/扣球：P1 用鼠标单击发球（W/S 已不再触发挥拍）
    TT.resetMatch(t.app.engine);
    t.runFrames(40);
    t.tap(300, 360);
    t.runFrames(3);
    check('单击推球发球仍可用', t.app.engine.players[0].stroke.active && t.app.engine.players[0].stroke.type === 1);
    t.runFrames(40);
    check('发球后进入对打', t.app.engine.phase === 'play' && !t.app.engine.ball.inHand);
    t.runFrames(180);
    check('对打渲染 180 帧无异常', true);

    // 一局结束：本地结算屏 + 再来一局
    const eng = t.app.engine;
    eng.score = [10, 9];
    eng.phase = 'point';
    eng.pointWinner = 0;
    eng.phaseT = 2.0;
    t.runFrames(1);
    t.runFrames(3); // 处理渐入动画的 requestAnimationFrame
    check('本地结算屏：黑屏显示「测试员 获胜」（P1 用主菜单昵称）',
      t.elements.get('gameOver').style.display !== 'none' &&
      t.elements.get('gameOverTitle').textContent === '测试员 获胜');
    check('结算屏渐入类已加（黑屏渐变）', t.elements.get('gameOver').classList.contains('show'));
    t.elements.get('btnAgain').dispatch('click', {});
    check('再来一局：比赛重置', eng.phase === 'serve' && eng.score[0] === 0 && eng.score[1] === 0);
    check('再来一局：结算屏关闭', !t.elements.get('gameOver').classList.contains('show'));

    // 右上角退出按钮
    t.elements.get('btnExit').dispatch('click', {});
    check('右上角退出：返回主菜单', t.app.mode === null && t.elements.get('menu').style.display !== 'none');
  }

  // ---------- 2. 人机对战 ----------
  {
    const t = await boot();
    t.click('btnAI');
    check('AI 模式启动', t.app.mode === 'ai' && !!t.app.engine);
    // 让电脑先发球
    const eng = t.app.engine;
    eng.server = 1;
    eng.startServer = 1;
    eng.ball.pos = { x: 0, y: 1.0, z: eng.players[1].z + eng.players[1].facing * 0.22 };
    let served = false;
    for (let i = 0; i < 600 && !served; i++) {
      t.runFrames(1);
      if (eng.phase === 'play' && !eng.ball.inHand) served = true;
    }
    check('AI 模式：电脑自动发球', served);
    t.runFrames(300);
    check('AI 模式渲染 300 帧无异常', true);
    check('AI 模式难度显示', t.elements.get('netInfo').textContent.indexOf('人机对战') === 0);
    // 桌面操作说明：极简键位说明（移动/推球/扣球/蹲下），且不含手机端"摇杆/按钮"
    check('桌面操作说明：极简键位且无摇杆/蹲按钮',
      t.elements.get('hintBar').innerHTML.indexOf('左键') !== -1 &&
      t.elements.get('hintBar').innerHTML.indexOf('推球') !== -1 &&
      t.elements.get('hintBar').innerHTML.indexOf('右键') !== -1 &&
      t.elements.get('hintBar').innerHTML.indexOf('扣球') !== -1 &&
      t.elements.get('hintBar').innerHTML.indexOf('蹲下') !== -1 &&
      t.elements.get('hintBar').innerHTML.indexOf('摇杆') === -1 &&
      t.elements.get('hintBar').innerHTML.indexOf('按钮') === -1);
    t.key('KeyD'); t.runFrames(30);
    check('AI 模式：P1 按键移动', t.app.engine.players[0].x > 0.2);
    t.key('KeyD', false);

    // 设备判定矩阵：触屏+大窗口=桌面；手机尺寸+触屏=手机端；?touch=1 强制手机；?desktop=1 强制桌面
    {
      const enterAI = (tt) => { tt.click('btnAI'); return tt.elements.get('hintBar').innerHTML; };
      const hA = enterAI(await boot({ touch: true })); // 触屏但 1280px 宽窗口 → 桌面
      check('触屏+大窗口：按桌面判定（键位齐全、无摇杆/蹲按钮）',
        hA.indexOf('摇杆') === -1 && hA.indexOf('按钮') === -1 && hA.indexOf('左键') !== -1 && hA.indexOf('推球') !== -1);
      const hB = enterAI(await boot({ touch: true, search: '?touch=1' })); // 强制手机端
      check('?touch=1 强制手机端：显示摇杆/蹲按钮', hB.indexOf('摇杆') !== -1 && hB.indexOf('蹲') !== -1);
      const hC = enterAI(await boot({ touch: true, search: '?desktop=1' })); // 触屏+强制桌面
      check('?desktop=1 强制桌面端：无摇杆', hC.indexOf('摇杆') === -1 && hC.indexOf('左键') !== -1 && hC.indexOf('推球') !== -1);
      const hD = enterAI(await boot({ width: 390, height: 844, touch: true })); // 手机尺寸+触屏 → 手机端
      check('手机尺寸+触屏：显示手机端说明', hD.indexOf('摇杆') !== -1);
      // 回归：触屏笔记本/Windows 触摸设备（有触摸能力但主指针是鼠标 pointer:fine）+ 窄窗口
      // 不得出现手机端按钮与触屏提示（曾因 maxTouchPoints>0 误判为手机）
      const tE = await boot({
        width: 900, height: 700, touch: true,
        matchMedia: (q) => ({ matches: q.indexOf('fine') !== -1 }), // 主指针=鼠标(fine)，仅具备触摸能力
      });
      const hE = enterAI(tE);
      check('触屏能力+主指针鼠标+窄窗口：按桌面处理（无摇杆/蹲按钮）',
        hE.indexOf('摇杆') === -1 && hE.indexOf('左键') !== -1 && hE.indexOf('推球') !== -1);
      check('触屏能力+主指针鼠标+窄窗口：触控按钮不显示',
        tE.elements.get('touchControls').style.display === 'none');
    }

    // 右上角工具：暂停 / 继续（人机难度开局锁定，无局内切换按钮）
    check('AI 模式：局内难度按钮已移除（难度锁定）', !t.elements.get('btnDiff'));
    t.elements.get('btnPause').dispatch('click', {});
    check('暂停：状态与面板', t.app.paused === true && t.elements.get('pausePanel').style.display !== 'none');
    const xWhilePaused = t.app.engine.players[0].x;
    t.runFrames(30);
    check('暂停：游戏物理冻结', Math.abs(t.app.engine.players[0].x - xWhilePaused) < 1e-9);
    t.elements.get('btnResume').dispatch('click', {});
    check('继续：恢复游戏', t.app.paused === false && t.elements.get('pausePanel').style.display === 'none');

    // 人机结算屏：您赢了 / 返回主界面
    const eng2 = t.app.engine;
    eng2.score = [10, 9];
    eng2.phase = 'point';
    eng2.pointWinner = 0;
    eng2.phaseT = 2.0;
    t.runFrames(1);
    t.runFrames(3);
    check('人机结算屏：您赢了', t.elements.get('gameOverTitle').textContent === '您赢了');
    t.elements.get('btnMenu').dispatch('click', {});
    check('返回主界面：回到菜单', t.app.mode === null && t.elements.get('menu').style.display !== 'none');
  }

  // ---------- 2.5 AI 观战（AI vs AI） ----------
  {
    const t = await boot();
    check('主页出现 AI 观战入口', !!t.elements.get('btnAIVsAI'));
    // 设定红=困难(2)、蓝=中等(1) 后开始
    t.elements.get('aiLevelA').value = '2';
    t.elements.get('aiLevelB').value = '1';
    t.click('btnAIVsAI');
    check('AI 观战启动', t.app.mode === 'aivai' && !!t.app.engine);
    check('AI 观战读取双方难度', t.app.aiLevelA === 2 && t.app.aiLevelB === 1);
    t.runFrames(2); // netInfo 在帧循环内刷新
    check('AI 观战 netInfo 显示', t.elements.get('netInfo').textContent.indexOf('AI 观战') === 0);
    // 双方 AI 自动对打：跑到出现对打阶段的击球
    const eng = t.app.engine;
    let played = false;
    for (let i = 0; i < 600 && !played; i++) {
      t.runFrames(1);
      if (eng.phase === 'play' && eng.rallyCount > 0) played = true;
    }
    check('AI 观战：双方 AI 自动对打', played);
    t.runFrames(300);
    check('AI 观战渲染 300 帧无异常', true);
    // 暂停 → 面板显示双方难度 → 调整红方难度生效
    t.elements.get('btnPause').dispatch('click', {});
    check('暂停：面板与双方难度显示', t.app.paused === true &&
      t.elements.get('pausePanel').style.display !== 'none' &&
      t.elements.get('pauseAIVsAI').style.display !== 'none');
    t.elements.get('pauseAiLevelA').value = '0';
    t.elements.get('pauseAiLevelA').dispatch('change', {});
    check('暂停中调整红方难度生效', t.app.aiLevelA === 0);
    // 参数微调：把红方「反应」拉到 ×1.2、「接球率」拉到 ×0.5 → 写回 aiTuneA
    t.elements.get('tuneAReact').value = '120';
    t.elements.get('tuneAReact').dispatch('change', {});
    t.elements.get('tuneACatch').value = '50';
    t.elements.get('tuneACatch').dispatch('change', {});
    check('暂停中微调反应/接球率生效', t.app.aiTuneA.reactMul === 1.2 && t.app.aiTuneA.catchMul === 0.5);
    t.elements.get('btnResume').dispatch('click', {});
    check('继续：恢复观战', t.app.paused === false);
    t.runFrames(30);
    check('微调后 netInfo 显示 ⚙ 标记', t.elements.get('netInfo').textContent.indexOf('⚙') !== -1);
    // 返回主页面
    t.elements.get('btnExit').dispatch('click', {});
    check('AI 观战退出返回主页面', t.app.mode === null && t.elements.get('menu').style.display !== 'none');
  }

  // ---------- 2.6 地狱解锁：全量同步 5 个难度下拉 ----------
  {
    const t = await boot();
    const selects = ['aiLevel', 'aiLevelA', 'aiLevelB', 'pauseAiLevelA', 'pauseAiLevelB'];
    const opt = (id) => t.elements.get(id).querySelector('option[value="3"]');
    check('地狱未解锁：5 个难度下拉初始均锁定', selects.every((id) => opt(id).disabled === true && opt(id).textContent.indexOf('🔒') !== -1));
    t.ppd.unlockHell();
    check('解锁后：5 个下拉全部解锁且文字=地狱', selects.every((id) => opt(id).disabled === false && opt(id).textContent === '地狱'));
  }

  // ---------- 2.7 通关记录：人机获胜 → 后端保存 + 主菜单渲染 ----------
  {
    let posted = null;
    let getCalls = 0;
    const t = await boot({
      fetch: (url, init) => {
        if (init && init.method === 'POST') {
          posted = JSON.parse(init.body);
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: 'r1' }) });
        }
        getCalls++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, records: [] }) });
      },
    });
    check('通关记录：启动时已 GET 拉取', getCalls >= 1);
    await sleep(10); // refreshRecords 异步：等微任务完成渲染
    check('通关记录：面板显示「暂无」占位', t.elements.get('recordsPanel').innerHTML.indexOf('暂无') !== -1);
    t.elements.get('aiLevel').value = '2'; // 困难
    t.click('btnAI');
    check('通关记录：困难 AI 模式启动', t.app.mode === 'ai' && t.app.aiLevel === 2);
    const eng = t.app.engine;
    eng.server = 0; eng.startServer = 0;
    eng.score = [10, 9];
    eng.phase = 'point'; eng.pointWinner = 0; eng.phaseT = 2.0;
    t.runFrames(1);
    t.runFrames(3);
    check('通关记录：人机获胜触发后端保存', !!posted);
    if (posted) {
      check('保存内容：ai/获胜/困难/比分/玩家名/时间戳',
        posted.mode === 'ai' && posted.winner === 0 && posted.difficulty === 2 &&
        posted.score[0] === 11 && posted.score[1] === 9 &&
        typeof posted.name === 'string' && typeof posted.ts === 'number');
    }
    check('通关记录：困难获胜同时解锁地狱', t.ppd.isHellUnlocked());
    // 返回主菜单：面板应重新拉取渲染（fetch 桩现在返回 1 条记录）
    getCalls = 0;
    t.elements.get('btnMenu').dispatch('click', {});
    await sleep(10);
    check('返回主菜单：记录面板重新拉取', getCalls >= 1);
  }

  // ---------- 2.75 解锁判定兜底：从持久化记录推导（localStorage 被清也不上锁） ----------
  {
    const t = await boot({
      fetch: () => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ok: true,
          records: [
            { id: 'a1', name: '你', mode: 'ai', winner: 0, score: [11, 5], difficulty: 2, ts: Date.now() },
            { id: 'a2', name: '你', mode: 'ai', winner: 0, score: [11, 7], difficulty: 3, ts: Date.now() },
          ],
        }),
      }),
    });
    check('启动：localStorage 被清（初始未解锁）', t.ppd.isHellUnlocked() === false && t.ppd.isHellCleared() === false);
    await sleep(10); // 等待 syncUnlocksFromRecords 异步完成
    check('记录含困难获胜 → 地狱解锁', t.ppd.isHellUnlocked() === true);
    check('记录含地狱获胜 → 地狱通关', t.ppd.isHellCleared() === true);
    const opts = ['aiLevel', 'aiLevelA', 'aiLevelB', 'pauseAiLevelA', 'pauseAiLevelB']
      .map((id) => t.elements.get(id).querySelector('option[value="3"]'));
    check('解锁后：5 个难度下拉全部可用', opts.every((o) => o.disabled === false));
  }

  // ---------- 2.8 地狱通关 → 人机暂停变「电脑 AI 数值调控」 ----------
  {
    const t = await boot();
    t.click('btnAI');
    // 未通关地狱：暂停面板不显示调控块
    t.elements.get('btnPause').dispatch('click', {});
    check('未通关地狱：人机暂停无数值调控', t.app.paused === true && t.elements.get('pauseAITune').style.display === 'none');
    t.elements.get('btnResume').dispatch('click', {});
    // 模拟通关地狱（人机击败地狱难度）→ 再暂停：调控块出现
    t.ppd.markHellCleared();
    check('通关地狱标记生效', t.ppd.isHellCleared());
    t.elements.get('btnPause').dispatch('click', {});
    check('通关地狱后：人机暂停显示数值调控', t.elements.get('pauseAITune').style.display !== 'none');
    // 滑杆写入 aiTuneB（对手=蓝方）并即时生效
    t.elements.get('tuneOppReact').value = '120';
    t.elements.get('tuneOppReact').dispatch('input', {});
    check('调控滑杆：反应 ×1.2 写入 aiTuneB', t.app.aiTuneB.reactMul === 1.2);
    t.elements.get('tuneOppCatch').value = '50';
    t.elements.get('tuneOppCatch').dispatch('change', {});
    check('调控滑杆：接球 ×0.5 写入 aiTuneB', t.app.aiTuneB.catchMul === 0.5);
    t.runFrames(30); // 暂停中物理冻结，调控值不触发异常
    check('调控后暂停中渲染无异常', true);
    t.elements.get('btnResume').dispatch('click', {});
    check('调控后继续：暂停面板关闭', t.app.paused === false && t.elements.get('pausePanel').style.display === 'none');
  }

  // ---------- 3. 联机建房（side 0） ----------
  {
    const t = await boot();
    t.click('btnHost');
    await sleep(10);
    check('建房请求已发送', t.sentMessages.some((m) => m.t === 'create'));
    t.feed({ t: 'room', code: 'AB12', side: 0, name: '房主', wait: true });
    check('等待面板显示房间码', t.elements.get('roomPanel').style.display !== 'none' && t.elements.get('roomCode').textContent === 'AB12');
    t.feed({ t: 'room', code: 'AB12', side: 0, name: '房主', wait: false });
    check('建房方进入游戏', t.app.mode === 'online' && t.app.side === 0);
    const snap0 = makeSnap(3, 7, 0, { n: ['房主', '小红'] });
    t.feed({ t: 'state', s: snap0, n: ['房主', '小红'], my: -1 });
    t.runFrames(10);
    check('联机渲染 10 帧无异常', true);
    check('HUD 显示双方昵称', t.elements.get('hudP1').textContent === '房主' && t.elements.get('hudP2').textContent === '小红');
    check('HUD 比分按服务器侧显示', t.elements.get('score1').textContent === '3' && t.elements.get('score2').textContent === '7');

    t.key('KeyD'); t.runFrames(5);
    check('联机输入已发送', t.sentMessages.some((m) => m.t === 'in' && m.i.r === 1));
    t.key('KeyD', false);

    // 联机结算屏：您赢了 / 再来一局（发送 rematch 并收到广播）
    const e3 = TT.createEngine();
    e3.score = [10, 9];
    e3.phase = 'point';
    e3.pointWinner = 0;
    e3.phaseT = 2.0;
    TT.step(e3, 1 / 60);
    t.feed({ t: 'state', s: TT.snapshot(e3), n: ['房主', '小红'] });
    t.runFrames(3);
    check('联机结算屏：您赢了',
      t.elements.get('gameOver').style.display !== 'none' &&
      t.elements.get('gameOverTitle').textContent === '您赢了');
    t.elements.get('btnAgain').dispatch('click', {});
    check('联机再来一局：发送 rematch', t.sentMessages.some((m) => m.t === 'rematch'));
    t.feed({ t: 'rematch' });
    t.runFrames(1);
    check('联机重开：结算屏关闭', !t.elements.get('gameOver').classList.contains('show'));
  }

  // ---------- 4. 联机加入（side 1，HUD 视角调换） ----------
  {
    const t = await boot();
    t.elements.get('joinInput').value = 'XY99';
    t.click('btnJoin');
    await sleep(10);
    check('加入请求已发送', t.sentMessages.some((m) => m.t === 'join' && m.room === 'XY99'));
    t.feed({ t: 'room', code: 'XY99', side: 1, name: '小蓝', wait: false });
    check('加入方 side=1 进入游戏', t.app.mode === 'online' && t.app.side === 1);
    const snap1 = makeSnap(2, 9, 0, { n: ['房主', '小蓝'] });
    t.feed({ t: 'state', s: snap1, n: ['房主', '小蓝'], my: -1 });
    t.runFrames(10);
    check('加入方 HUD 昵称调换（自己=小蓝）', t.elements.get('hudP1').textContent === '小蓝' && t.elements.get('hudP2').textContent === '房主');
    check('加入方 HUD 比分调换（自己=9）', t.elements.get('score1').textContent === '9' && t.elements.get('score2').textContent === '2');
    check('发球点显示在对方（房主）一侧', t.elements.get('serveDot').style.left.indexOf('+') >= 0);

    t.key('Comma'); t.runFrames(5);
    check('加入方按 , 推球已发送', t.sentMessages.some((m) => m.t === 'in' && m.i.pu === 1));
    t.key('Comma', false);

    // 联机结算屏：您输了（对方获胜）
    const e4 = TT.createEngine();
    e4.score = [10, 9];
    e4.phase = 'point';
    e4.pointWinner = 0; // 房主（side 0）获胜 → 加入方（side 1）输
    e4.phaseT = 2.0;
    TT.step(e4, 1 / 60);
    t.feed({ t: 'state', s: TT.snapshot(e4), n: ['房主', '小蓝'] });
    t.runFrames(3);
    check('联机结算屏：您输了', t.elements.get('gameOverTitle').textContent === '您输了');
  }

  console.log(failures === 0 ? '\n浏览器冒烟测试全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('冒烟测试异常:', e);
  process.exit(1);
});
