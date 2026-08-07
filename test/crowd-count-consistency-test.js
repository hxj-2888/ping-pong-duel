/* 静态层/动画层观众人数一致性验证
 * 核心：drawPerson 的屏幕外剔除改用「座位坐标」（姿态无关）——
 * 动画层观众 cheer/shake 时 head/hips 位移，若按姿态坐标剔除，
 * 动画期边界观众可能与静态层（rest 姿态）可见性不同 → 人数不一致。
 * 验证：同一相机下，静态层（time=0, 无欢呼）与动画层（不同 time/cheer/shake）
 * 绘制的观众个数完全一致。
 * 用法: node test/crowd-count-consistency-test.js
 */
'use strict';

const path = require('path');
const TTG = require(path.join(__dirname, '..', 'public', 'js', 'render.js'));

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' [' + extra + ']' : ''}`);
  if (!cond) failures++;
}

// 计数型 ctx：arc=头部个数（每位观众 1 个头 → 人数）
function makeCountingCtx(canvas, scale) {
  const counters = { arc: 0 };
  const ctx = {
    canvas,
    counters,
    getTransform() { return { a: scale || 1, d: scale || 1, e: 0, f: 0 }; },
    setTransform() {}, clearRect() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {},
    arc() { counters.arc++; },
    ellipse() {},
    drawImage() {},
    setLineDash() {},
  };
  return ctx;
}

const VW = 1280, VH = 720;
const cam = new TTG.Camera();
cam.set(TTG.v3(0, 4.8, -5.2), TTG.v3(0, 1.7, 0), VW / 2, VH / 2, VW * 0.9);

function countAt(ctx, time, cheer, shake) {
  ctx.counters.arc = 0;
  TTG.drawCrowd(ctx, cam, time, 0, { cheer: [cheer, cheer], shake: [shake, shake] }, 1);
  return ctx.counters.arc;
}

// ---------- 1. 静态层（rest）与动画层（欢呼中）人数一致 ----------
{
  const staticCtx = makeCountingCtx({ width: VW, height: VH }, 1);
  const animCtx = makeCountingCtx({ width: VW, height: VH }, 1);
  // 静态层：time=0, 无欢呼（fan=null → rest 姿态）
  staticCtx.counters.arc = 0;
  TTG.drawCrowd(staticCtx, cam, 0, 0, null, 1);
  const staticCount = staticCtx.counters.arc;

  // 动画层：欢呼中（不同 time/cheer）——人数应完全相同
  const t1 = countAt(animCtx, 0.1, 1.0, 0);
  const t2 = countAt(animCtx, 0.5, 0.6, 0.4);
  const t3 = countAt(animCtx, 1.2, 0.0, 1.0);
  const t4 = countAt(animCtx, 2.0, 0.3, 0.0);
  const t5 = countAt(animCtx, 0.03, 1.0, 1.0);

  check('静态层人数 = 动画层(欢呼) 人数', t1 === staticCount && t2 === staticCount && t3 === staticCount && t4 === staticCount && t5 === staticCount,
    'static=' + staticCount + ', anim=[' + t1 + ',' + t2 + ',' + t3 + ',' + t4 + ',' + t5 + ']');
  check('人数 > 0（确有人数）', staticCount > 0, String(staticCount));
}

// ---------- 2. 半分辨率动画层（scale=0.5）剔除口径仍一致 ----------
{
  const staticCtx = makeCountingCtx({ width: VW, height: VH }, 1);
  const animCtxHalf = makeCountingCtx({ width: Math.round(VW * 0.5), height: Math.round(VH * 0.5) }, 0.5);
  staticCtx.counters.arc = 0;
  TTG.drawCrowd(staticCtx, cam, 0, 0, null, 1);
  const staticCount = staticCtx.counters.arc;
  animCtxHalf.counters.arc = 0;
  TTG.drawCrowd(animCtxHalf, cam, 0.3, 0, { cheer: [1, 1], shake: [0, 0] }, 1);
  check('半分辨率动画层与静态层人数一致', animCtxHalf.counters.arc === staticCount,
    'static=' + staticCount + ', animHalf=' + animCtxHalf.counters.arc);
}

console.log(failures === 0 ? '\n静态/动画人数一致性全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
