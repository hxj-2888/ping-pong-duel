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
  'app/state.js', 'app/input.js', 'app/render.js', 'app/hud.js',
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
  'joinInput', 'btnMute', 'btnMusic', 'btnMusicGame', 'roomPanel', 'roomCode', 'roomHint', 'btnRoomBack', 'statusBar',
  'overlay', 'overlayTitle', 'overlayText', 'overlayBtn', 'hud', 'hudP1', 'hudP2',
  'phaseBanner', 'pointToast', 'hintBar', 'netInfo', 'hitRangeInfo', 'hitBallVal', 'hitPaddleVal', 'ballHeight', 'inBoxStatus', 'serveDot', 'tips',
  'score1', 'score2', 'btnAI', 'aiLevel', 'btnAIVsAI', 'aiLevelA', 'aiLevelB', 'pauseAiLevelA', 'pauseAiLevelB', 'pauseAIVsAI',
  'tuneAReact', 'tuneACatch', 'tuneASmash', 'tuneAAgility', 'tuneBReact', 'tuneBCatch', 'tuneBSmash', 'tuneBAgility',
  'gameOver', 'gameOverTitle', 'btnAgain', 'btnMenu', 'btnQuit',
  'touchControls', 'btnLeft', 'btnRight', 'btnFwd', 'btnBack',
  'gameTools', 'btnDiff', 'btnPause', 'btnExit', 'showHitRanges',
  'pausePanel', 'btnResume', 'btnPauseExit',
  'bgmAudio', // raw 游戏音乐 <audio> 元素（audio.js loadBGM 挂接）
];

function boot() {
  const elements = new Map();
  for (const id of ELEMENT_IDS) elements.set(id, makeElement(id));
  elements.get('nameInput').value = '测试员';
  // bgmAudio：<audio> 元素桩（play/pause/paused/src/volume/loop）
  const bgm = elements.get('bgmAudio');
  Object.assign(bgm, {
    _paused: true, src: '', volume: 0, loop: false, preload: '',
    get paused() { return this._paused; },
    set paused(v) { this._paused = v; },
    play() { this._paused = false; },
    pause() { this._paused = true; },
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
    location: { protocol: 'http:', host: '127.0.0.1:8781' },
    document: { getElementById: (id) => elements.get(id) },
    navigator: { userAgent: 'smoke' },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: () => {},
    WebSocket: FakeWebSocket,
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener(type, fn) { (winHandlers[type] = winHandlers[type] || []).push(fn); },
    Math, JSON, Object, Array, Number, String, Boolean, Date, RegExp, Error, Promise,
    isFinite, isNaN, parseInt, parseFloat,
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
    runFrames(n) {
      for (let i = 0; i < n; i++) {
        const fns = rafQueue.splice(0);
        perf.t += 16.67;
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
    check('判定范围虚线开关默认开启', t.app.showHitRanges === true && t.elements.get('showHitRanges').checked === true);
    t.elements.get('showHitRanges').checked = false;
    t.elements.get('showHitRanges').dispatch('change', {});
    t.runFrames(3);
    check('关闭开关后判定范围虚线隐藏', t.app.showHitRanges === false &&
      t.ppd.viewModelFromEngine(t.app.engine, 0).showHitRanges === false);
    t.elements.get('showHitRanges').checked = true;
    t.elements.get('showHitRanges').dispatch('change', {});
    t.runFrames(3);
    check('重新开启后判定范围虚线显示', t.app.showHitRanges === true &&
      t.ppd.viewModelFromEngine(t.app.engine, 0).showHitRanges === true);
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

    // 触控按钮：桌面环境应隐藏，按下/抬起应正确驱动 P1
    check('桌面环境：触控按钮隐藏', t.elements.get('touchControls').style.display === 'none');
    t.app.engine.players[0].x = 0;
    t.app.engine.players[0].vx = 0;
    t.app.engine.players[0].padX = 0;
    t.elements.get('btnRight').dispatch('pointerdown', { preventDefault() {} });
    t.runFrames(30);
    check('触控按钮 ◀▶：按右移动', t.app.engine.players[0].x > 0.2);
    t.elements.get('btnRight').dispatch('pointerup', { preventDefault() {} });

    // 前后触控按钮：▲ 向前移动 / ▼ 向后移动（与左右键围成方向键）
    const zBeforeFwd = t.app.engine.players[0].z;
    t.elements.get('btnFwd').dispatch('pointerdown', { preventDefault() {} });
    t.runFrames(30);
    check('触控按钮 ▲▼：按▲向前移动', t.app.engine.players[0].z > zBeforeFwd + 0.05);
    t.elements.get('btnFwd').dispatch('pointerup', { preventDefault() {} });
    t.runFrames(20);
    const zAfterFwd = t.app.engine.players[0].z;
    t.elements.get('btnBack').dispatch('pointerdown', { preventDefault() {} });
    t.runFrames(30);
    check('触控按钮 ▲▼：按▼向后移动', t.app.engine.players[0].z < zAfterFwd - 0.05);
    t.elements.get('btnBack').dispatch('pointerup', { preventDefault() {} });

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
    t.tap(400, 360); t.runFrames(1); // 单击推球，立即出拍（蓄力期）
    t.tap(400, 360);                 // 280ms 内同侧第二击 → 扣球边沿
    t.runFrames(3);                  // 引擎把推球挥拍升级为扣球
    check('对打双击：推球挥拍升级为扣球', t.app.engine.players[0].stroke.active && t.app.engine.players[0].stroke.type === 2);
    t.runFrames(40);
    await sleep(90);

    // 方案四：感知辅助（仅判定范围显示开启时）——球进人类控制方箱体 → 提示音（上升沿一次）
    {
      const t2 = await boot();
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

    // raw 游戏音乐：挂接 <audio> 元素 + 音乐按钮切换播放/暂停（无 AudioContext 环境走元素路径）
    {
      const t3 = await boot();
      const G = t3.ppd.GameAudio;
      G.ensure();
      check('raw 音乐：挂接 bgmAudio 元素（musicMode=raw）', G.musicMode() === 'raw');
      const bgm = t3.elements.get('bgmAudio');
      check('raw 音乐：元素 src 指向 music.mp4', /music\.mp4$/.test(bgm.src));
      const on0 = G.isMusicOn();
      G.setMusicOn(!on0);
      check('raw 音乐：音乐按钮切换 → ' + (on0 ? '暂停' : '播放'), bgm.paused === on0);
      G.setMusicOn(on0);
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
    check('本地结算屏：黑屏显示「玩家1 获胜」',
      t.elements.get('gameOver').style.display !== 'none' &&
      t.elements.get('gameOverTitle').textContent === '玩家1 获胜');
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
    t.key('KeyD'); t.runFrames(30);
    check('AI 模式：P1 按键移动', t.app.engine.players[0].x > 0.2);
    t.key('KeyD', false);

    // 右上角工具：难度切换 / 暂停 / 继续
    check('AI 模式：难度按钮显示', t.elements.get('btnDiff').style.display !== 'none');
    const beforeLevel = t.app.aiLevel;
    t.elements.get('btnDiff').dispatch('click', {});
    check('AI 模式：难度切换生效', t.app.aiLevel === (beforeLevel + 1) % 3);
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

    t.key('ArrowUp'); t.runFrames(5);
    check('加入方按 ↑ 推球已发送', t.sentMessages.some((m) => m.t === 'in' && m.i.pu === 1));
    t.key('ArrowUp', false);

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
