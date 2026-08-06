/* 真人(脚本)蹲下+推球 反击"引擎求解的真实扣杀" 实测
 * 用 T.computeShot(engine, 1, 2) 生成 AI 扣杀(与 AI 同求解器, 含真实下坠/旋转),
 * 注入后真人(下蹲+推球)防守反击; 记录: 反击过网/漏接/进网/出界 + 来球在箱面高度分布
 * 对照: 下蹲 vs 站立推球
 * 用法: node tools/smash-counter-probe.js
 */
'use strict';
const path = require('path');
const T = require(path.join(process.cwd(), 'public', 'js', 'engine.js'));
const R = T.RULES;
const STEP = 1 / 120;

function predictCrossing(ball, zc, maxT) {
  const steps = Math.ceil(maxT / 0.02);
  let prevZ = ball.pos.z, prevPos = ball.pos;
  for (let i = 1; i <= steps; i++) {
    const t = i * 0.02;
    const p = T.predictBall(ball, t);
    if ((prevZ - zc) * (p.z - zc) <= 0) {
      const f = Math.abs(p.z - zc) / (Math.abs(p.z - zc) + Math.abs(prevZ - zc) + 1e-9);
      return { t: t - 0.02 * f, x: prevPos.x + (p.x - prevPos.x) * (1 - f), y: prevPos.y + (p.y - prevPos.y) * (1 - f) };
    }
    prevZ = p.z;
    prevPos = p;
  }
  return null;
}

// 真人控制; crouch=false 对照站立; mode: 'pre'=提前起拍(同 AI preSwing), 'reaction'=反应式(球进箱才按)
// 引擎命中窗: 扣杀来球 [0, 0.28]s(免起拍延迟), 普通来球 [0.08, 0.28]s
function humanControl(engine, crouch, mode) {
  const p = engine.players[0], b = engine.ball, f = p.facing;
  const zc = p.z + f * 0.42;
  let l = 0, r = 0, pu = 0;
  const incoming = engine.phase === 'play' && !b.inHand && b.vel.z * f < 0;
  let targetX = p.x;
  if (incoming) {
    const c = predictCrossing(b, zc, 1.2);
    if (c) targetX = Math.max(-2.3, Math.min(2.3, c.x));
  }
  const dx = targetX - p.x;
  if (dx > 0.02) r = 1; else if (dx < -0.02) l = 1;
  if (incoming) {
    if (mode === 'reaction') {
      // 反应式: 球已进箱(本方弹台后)才按——旧引擎 0.08s 起拍延迟必漏, 新引擎扣杀来球免延迟即时命中
      const inBox = Math.abs(b.pos.x - p.x) < R.HITBOX_HX &&
        Math.abs(b.pos.z - zc) < R.HITBOX_HZ &&
        b.pos.y > 0.03 && b.pos.y < 1.40;
      if (engine.mayHit[0] && inBox) pu = 1;
    } else {
      // 提前起拍: 球将在命中窗内进箱即按, 不等本方弹台
      const c = predictCrossing(b, zc, 1.0);
      if (c && c.t > 0.04 && c.t < 0.24 && Math.abs(c.x - p.x) < 0.85 && c.y > 0.03 && c.y < 1.40) pu = 1;
    }
  }
  T.setInput(engine, 0, { l, r, f: 0, b: 0, pu, sm: 0, lp: 0, lb: 0, crouch: crouch ? 1 : 0, run: 0 });
  return pu;
}

// 生成一次 AI 扣杀并注入: 返回 null=该高度解不出快扣(撞网, 非可接)
function injectSmash(aimX, hitY) {
  const engine = T.createEngine();
  T.resetMatch(engine);
  const b = engine.ball;
  // AI(P1, z>0 面向-z) 站在 aimX 附近, 球在拍前高点
  const p1 = engine.players[1];
  p1.x = aimX; p1.padX = aimX;
  b.pos = { x: aimX, y: hitY, z: 1.25 };
  b.vel = { x: 0, y: 0, z: 0 };
  b.spin = { x: 0, y: 0, z: 0 };
  b.inHand = false; b.hitType = -1; b.hitBy = -1; b.lastBounce = -1; b.netTouched = false;
  engine.phase = 'play'; engine.mayHit = [false, false];
  // 用引擎同一求解器生成扣杀
  const shot = T.computeShot(engine, 1, 2);
  if (!shot || shot.netHit) return null;
  b.vel = { ...shot.vel };
  b.spin = { ...shot.spin };
  b.hitType = 2; b.hitBy = 1;
  return engine;
}

function trial(aimX, hitY, crouch, mode) {
  const engine = injectSmash(aimX, hitY);
  if (!engine) return null;
  const b = engine.ball;
  const diag = { crossY: null, crossT: null, outcome: null };
  let prevZ = b.pos.z;
  for (let i = 0; i < 300; i++) {
    humanControl(engine, crouch, mode);
    T.step(engine, STEP);
    if (prevZ > 0 && b.pos.z <= 0) { /* 越过网 */ }
    prevZ = b.pos.z;
    for (const ev of engine.events) {
      if (ev.c === 'bounce' && b.pos.z < 0) {
        const p0 = engine.players[0];
        const c = predictCrossing(b, p0.z + p0.facing * 0.42, 0.9);
        if (c) { diag.crossY = +c.y.toFixed(3); diag.crossT = +c.t.toFixed(3); }
      }
      if (ev.c === 'hit' && ev.s === 0) diag.outcome = 'hit';
      if (ev.c === 'net' && diag.outcome === null) diag.outcome = 'net';
      if (ev.c === 'point' && diag.outcome === null) diag.outcome = 'point:' + (engine.pointReason || '');
    }
    engine.events.length = 0;
    if (diag.outcome === 'hit') {
      for (let j = 0; j < 200; j++) {
        humanControl(engine, crouch, mode);
        T.step(engine, STEP);
        for (const ev of engine.events) {
          if (ev.c === 'net') diag.outcome = 'retNet';
          if (ev.c === 'point') diag.outcome = 'retPoint:' + (engine.pointReason || '');
          if (ev.c === 'floor') diag.outcome = 'retFloor';
        }
        engine.events.length = 0;
        if (diag.outcome !== 'hit') break;
        if (b.pos.z > 0.1) { diag.outcome = 'over'; break; }
        if (b.pos.y < 0.03) { diag.outcome = 'retFloor'; break; }
      }
      break;
    }
    if (diag.outcome && diag.outcome !== 'hit') break;
  }
  if (diag.outcome === null) diag.outcome = 'timeout';
  return diag;
}

function run(label, crouch, mode, n) {
  const agg = { total: 0, over: 0, whiff: 0, retNet: 0, retOut: 0, ys: [] };
  let seed = 4242 + (crouch ? 7 : 3) + (mode === 'reaction' ? 11 : 0);
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let t = 0, attempts = 0;
  while (t < n && attempts < 2000) {
    attempts++;
    const aimX = (rnd() * 2 - 1) * 0.7;
    const hitY = 1.10 + rnd() * 0.35; // 扣杀起点高度 1.10~1.45
    const d = trial(aimX, hitY, crouch, mode);
    if (!d || d.crossY == null) continue; // 未落本方台/解不出 → 非可接
    agg.total++;
    agg.ys.push(d.crossY);
    if (d.outcome === 'over') agg.over++;
    else if (d.outcome === 'retNet') agg.retNet++;
    else if (d.outcome === 'retPoint:out' || d.outcome === 'retFloor') agg.retOut++;
    else agg.whiff++;
    t++;
  }
  const pct = (x) => (x / agg.total * 100).toFixed(1);
  const ys = agg.ys.slice().sort((a, b) => a - b);
  console.log('=== ' + label + ' ===');
  console.log('可接扣杀 ' + agg.total + ' | 反击过网 ' + agg.over + '(' + pct(agg.over) + '%) 漏接 ' + agg.whiff + '(' + pct(agg.whiff) + '%) 接进网 ' + agg.retNet + '(' + pct(agg.retNet) + '%) 接出界 ' + agg.retOut + '(' + pct(agg.retOut) + '%)');
  console.log('  来球箱面高度 中位 ' + ys[Math.floor(ys.length / 2)].toFixed(2) + 'm 最低 ' + ys[0].toFixed(2) + 'm 最高 ' + ys[ys.length - 1].toFixed(2) + 'm <0.42m(需下蹲够到) ' + (ys.filter((y) => y < 0.42).length) + ' 个');
}

console.log('命中窗: 扣杀来球 [0,0.28]s(免起拍延迟) / 普通来球 [0.08,0.28]s');
run('蹲下+推球 提前起拍', true, 'pre', 250);
run('站立推球 提前起拍(对照)', false, 'pre', 250);
run('蹲下+推球 反应式按压(球进箱才按)', true, 'reaction', 250);
run('站立推球 反应式按压(对照)', false, 'reaction', 250);
