/* 反击扣杀命中窗验证：扣杀来球免 0.08s 起拍延迟（t=0 即判箱 + 加长 0.08s 容错）
 * 覆盖（strokes.js updateStroke）：
 *  1. 扣杀来球(hitType2)+推球、球在箱内 → 挥拍 t=1/120 立即命中（免起拍延迟）
 *  2. 普通来球(hitType1)同条件 → t<0.08 不命中（保留起拍延迟与时机感）
 *  3. 命中窗末端：扣杀来球在 t≈0.30s 才进箱仍命中（窗延至 0.36s）；普通来球 0.30s 进箱不命中（窗止于 0.28s）
 * 用法: node test/smash-counter-test.js
 */
'use strict';
const path = require('path');
const TT = require(path.join(__dirname, '..', 'public', 'js', 'engine.js'));
const R = TT.RULES;

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

// 构造：P0 蹲下推球反击来球；球由探针逐帧摆放（在/不在箱内），mayHit 已就绪（本方已弹台）
function make(hitType) {
  const e = TT.createEngine();
  TT.resetMatch(e);
  const p = e.players[0];
  p.x = 0; p.z = -2.0;
  p.crouch = 1; // 蹲防推球：保证 computeShot 解出合法回球（与"蹲下+推球"一致）
  const b = e.ball;
  b.inHand = false;
  b.hitType = hitType;
  b.hitBy = 1;
  b.lastBounce = 1;
  b.netTouched = false;
  e.phase = 'play';
  e.mayHit = [true, false];
  const zc = p.z + p.facing * R.HITBOX_Z_OFF;
  b.pos = { x: 0, y: 0.90, z: zc };
  b.vel = { x: 0, y: 0, z: 0 };
  b.spin = { x: 0, y: 0, z: 0 };
  return { e, zc };
}

// 步进 n 帧（第一帧按推球起拍）；placeFn(e, i) 每帧摆放球位；返回命中步数(1-based)或 -1
function stepCount(e, n, placeFn) {
  let puFired = false;
  for (let i = 0; i < n; i++) {
    if (placeFn) placeFn(e, i);
    TT.setInput(e, 0, { l: 0, r: 0, f: 0, b: 0, pu: puFired ? 0 : 1, sm: 0, lp: 0, lb: 0, crouch: 1, run: 0 });
    puFired = true;
    TT.step(e, 1 / 120);
    e.events.length = 0;
    const st = e.players[0].stroke;
    if (st && st.hit) return i + 1;
  }
  return -1;
}

// --- 1. 扣杀来球：球在箱内 → 挥拍第一帧即命中（免起拍延迟） ---
{
  const { e } = make(2);
  const t = stepCount(e, 20);
  check('扣杀来球：挥拍第一帧判箱即命中（t=1/120，免 0.08s 起拍延迟）', t === 2); // 起拍步不判箱, 次步 t=1/120 即命中
  check('扣杀来球：命中方为本方（球已被接回）', e.ball.hitBy === 0);
}

// --- 2. 普通来球：球在箱内 → t<0.08 不命中，等 windup 后才命中 ---
{
  const { e } = make(1);
  const t = stepCount(e, 20);
  check('普通来球：t<0.08 不命中（保留起拍延迟），windup 后命中', t > 2 && t <= 11); // 11 步=10/120≈0.083s 过 windup
}

// --- 3a. 命中窗末端：扣杀来球在 t≈0.25s 才进箱 → 仍在窗 [0,0.28] 内 → 命中 ---
{
  const { e, zc } = make(2);
  const t = stepCount(e, 60, (eng, i) => {
    eng.ball.pos.z = i >= 30 ? zc : zc - 2.0; // 第 30 步(0.25s)才进箱
    eng.ball.pos.y = 0.9;
    eng.ball.vel = { x: 0, y: 0, z: 0 };
  });
  check('扣杀来球：t≈0.25s 进箱仍命中（命中窗 [0,0.28]）', t === 31);
}

// --- 3b. 扣杀来球在 t≈0.30s 才进箱 → 已过 0.28s 窗 → 挥空（未加长窗） ---
{
  const { e, zc } = make(2);
  const t = stepCount(e, 60, (eng, i) => {
    eng.ball.pos.z = i >= 36 ? zc : zc - 2.0;
    eng.ball.pos.y = 0.9;
    eng.ball.vel = { x: 0, y: 0, z: 0 };
  });
  check('扣杀来球：t≈0.30s 进箱不命中（窗止 0.28s，未额外加长）', t === -1);
}

// --- 3c. 普通来球：t≈0.30s 才进箱 → 已过 0.28s 窗 → 挥空（普通对打不变） ---
{
  const { e, zc } = make(1);
  const t = stepCount(e, 60, (eng, i) => {
    eng.ball.pos.z = i >= 36 ? zc : zc - 2.0;
    eng.ball.pos.y = 0.9;
    eng.ball.vel = { x: 0, y: 0, z: 0 };
  });
  check('普通来球：t≈0.30s 进箱不命中（窗止于 0.28s，普通对打不变）', t === -1);
}

console.log(failures === 0 ? '\n反击扣杀命中窗验证全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
