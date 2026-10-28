/* 物理反馈测试（v3.6.0）：镜头震屏/推近状态机 + 高速球拉伸 + 击球火花。
 * 渲染器部分在 Node 桩 Canvas 上验证"画了什么"（调用序列），
 * app/render.js 的镜头反馈在 vm 沙箱里验证触发/衰减/开关。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const TTG = require(path.join(__dirname, '..', 'public', 'js', 'render.js'));

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
}

// 记录型 Canvas 2D 桩：只关心调用了哪些绘制方法
function makeCtx() {
  const ops = [];
  const proxy = new Proxy({}, {
    get(t, k) {
      if (k === 'ops') return ops;
      if (k === 'createLinearGradient' || k === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      return (...args) => { ops.push([k, ...args]); };
    },
    set() { return true; },
  });
  return proxy;
}
const count = (ops, name) => ops.filter((o) => o[0] === name).length;

// ---------- 1. 渲染器：高速球速度拉伸 ----------
const cam = new TTG.Camera();
cam.set(TTG.v3(0, 7.43, -10.1), TTG.v3(0, 1.6, 0), 640, 360, 2560);
const fast = makeCtx();
TTG.drawBall(fast, cam, TTG.v3(0, 1, 0), { x: 0, y: 0, z: 0 }, 1, false, { x: 0, y: 0, z: 18 }, false);
const slow = makeCtx();
TTG.drawBall(slow, cam, TTG.v3(0, 1, 0), { x: 0, y: 0, z: 0 }, 1, false, { x: 0, y: 0, z: 0 }, false);
check('高速球画速度拉伸（有线段）', count(fast.ops, 'lineTo') >= 1);
check('静止球不画拉伸', count(slow.ops, 'lineTo') === 0);

// 低画质仍保留拉伸（只是缩短），不画任何拉伸才叫回归
const fastLow = makeCtx();
TTG.drawBall(fastLow, cam, TTG.v3(0, 1, 0), { x: 0, y: 0, z: 0 }, 1, false, { x: 0, y: 0, z: 18 }, true);
check('低画质保留速度拉伸', count(fastLow.ops, 'lineTo') >= 1);

// ---------- 2. 渲染器：击球火花（真实球位，不贴台面） ----------
const spark = makeCtx();
TTG.drawEffects(spark, cam, [{ type: 'hit', x: 0, y: 1.2, z: 0, t0: 1, pow: 0.9 }], 1.05, false, null);
check('击球火花：中心闪光 + 放射短线', count(spark.ops, 'arc') >= 1 && count(spark.ops, 'lineTo') >= 6);
const expired = makeCtx();
TTG.drawEffects(expired, cam, [{ type: 'hit', x: 0, y: 1.2, z: 0, t0: 1, pow: 0.9 }], 1.5, false, null);
check('击球火花按时过期', expired.ops.length === 0);

// 既有落台波纹不受新分支影响
const ripple = makeCtx();
TTG.drawEffects(ripple, cam, [{ type: 'bounce', x: 0, z: 0, t0: 1 }], 1.1, false, null);
check('落台波纹保持原绘制', count(ripple.ops, 'ellipse') === 1);

// ---------- 3. 镜头反馈：触发 / 衰减 / 设置开关 ----------
let nowMs = 0;
const PPD = {
  app: {
    fxShow: { trail: true, splash: true, shake: true },
    quality: { low: false, mode: 'high' },
  },
  isTouch: false,
  TTG,
  ui: {},
};
const sandbox = {
  PPD,
  console,
  Date,
  Math,
  performance: { now: () => nowMs },
  localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: () => null },
};
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app', 'render.js'), 'utf8'),
  sandbox,
  { filename: 'app/render.js' }
);
check('镜头反馈接口已导出', typeof PPD.fxKick === 'function' && typeof PPD.fxStep === 'function' && typeof PPD.juiceTransform === 'function');

PPD.fxKick('smash', 1);
let lv = PPD.juiceLevel();
check('扣杀触发震屏+推近', lv.shake > 0.9 && lv.punch > 0.9, JSON.stringify(lv));

const jctx = makeCtx();
const applied = PPD.juiceTransform(jctx, 0, 0, 1280, 720);
check('震屏变换已施加', applied === true && count(jctx.ops, 'scale') === 1 && count(jctx.ops, 'translate') === 2);

PPD.fxStep(0.4);
lv = PPD.juiceLevel();
check('0.4s 后完全平息', lv.shake === 0 && lv.punch === 0, JSON.stringify(lv));

const idle = makeCtx();
check('平息后不再施加变换', PPD.juiceTransform(idle, 0, 0, 1280, 720) === false && idle.ops.length === 0);

PPD.fxKick('hit', 1);
PPD.app.fxShow.shake = false;
const off = makeCtx();
check('设置关闭后不施加变换', PPD.juiceTransform(off, 0, 0, 1280, 720) === false && off.ops.length === 0);
PPD.app.fxShow.shake = true;

// 分身/分屏视口（传 vx 偏移）不应把抖动中心算错：scale 一次、translate 两次、围绕半屏中心
PPD.fxKick('score', 1);
const half = makeCtx();
PPD.juiceTransform(half, 640, 0, 640, 720);
const tr = half.ops.filter((o) => o[0] === 'translate');
check('分屏视口围绕自身中心变换', tr.length === 2 && Math.abs(tr[0][1] - 960) < 40, JSON.stringify(tr[0]));

if (failures) {
  console.log(`\n${failures} 项失败 ✗`);
  process.exitCode = 1;
} else {
  console.log('\n物理反馈测试全部通过 ✓');
}
