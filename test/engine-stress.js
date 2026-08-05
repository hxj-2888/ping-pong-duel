/* 引擎无头压力测试：随机输入 + 脚本化回合（推球/扣球，两侧各测） */
'use strict';

const TT = require('../public/js/engine.js');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

function isFiniteVec(v) {
  return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

// ---------- 1. 随机输入冒烟：40 秒 2400 帧 ----------
{
  const e = TT.createEngine();
  let bad = false;
  let lastScore = [0, 0];
  let points = 0;
  let rng = 42;
  const rnd = () => (rng = (rng * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 2400; i++) {
    for (let s = 0; s < 2; s++) {
      TT.setInput(e, s, {
        l: rnd() < 0.12, r: rnd() < 0.12,
        pu: rnd() < 0.012, sm: rnd() < 0.008,
      });
    }
    TT.step(e, 1 / 120);
    const snap = TT.snapshot(e);
    const num = snap.b ? snap.b.slice(0, 9).every((v) => Number.isFinite(v)) : true;
    const pls = snap.p.every((p) =>
      Number.isFinite(p.x) && p.pc.every((v) => Number.isFinite(v)));
    if (!num || !pls) { bad = true; break; }
    if (e.phase === 'point') {
      // 等结算
    }
    if (snap.sc[0] + snap.sc[1] > lastScore[0] + lastScore[1]) {
      points++;
      lastScore = snap.sc;
    }
  }
  check('随机输入 40s 无 NaN', !bad);
  check('随机输入产生得分', points >= 3);
}

// ---------- 2. 脚本化对打 ----------
function scriptedRally(serveSide, returnType) {
  const e = TT.createEngine();
  e.server = serveSide;
  e.startServer = serveSide;
  let hits = 0;
  let serves = 0;
  let winner = -1;
  const hold = [0, 0, 0, 0]; // [side*2+0=pu, side*2+1=sm] 剩余保持帧
  let wasWanting = [false, false]; // 边沿检测
  // 扣球回合：从高空球直接开始（扣球要求球弹得足够高，低球/发球回球扣不过网）
  if (returnType === 'smash') {
    e.phase = 'play';
    e.serveStage = 'rally';
    e.mayHit = [true, true];
    e.ball.inHand = false;
    e.ball.pos = { x: 0, y: 1.35, z: serveSide === 0 ? -1.2 : 1.2 };
    e.ball.vel = { x: 0, y: 0, z: serveSide === 0 ? 1.5 : -1.5 };
    e.ball.spin = { x: 0, y: 0, z: 0 };
    e.ball.hitBy = 1 - serveSide;
    e.ball.lastBounce = 1 - serveSide;
  }

  const ballNear = (side) => {
    const p = e.players[side], b = e.ball;
    if (e.ball.inHand) return false;
    const zc = p.z + p.facing * 0.42;
    return Math.hypot(b.pos.x - p.x, b.pos.z - zc) < 1.00 &&
           b.pos.y > 0.80 && b.pos.y < 1.45;
  };

  let gaveUp = false; // 完成若干拍后双方停手，让回合自然结束
  for (let i = 0; i < 20000; i++) {
    // 发球
    if (e.phase === 'serve' && e.server === serveSide && e.ball.inHand &&
        e.players[serveSide].hitCd <= 0 && serves < 8) {
      hold[serveSide * 2] = 12;
      serves++;
    }
    // 接球：球到自己半台且可击 → 用指定动作
    for (let s = 0; s < 2; s++) {
      if (e.phase !== 'play') break;
      const should = e.mayHit[s] && ballNear(s) && !gaveUp;
      if (should && !wasWanting[s]) {
        hold[s * 2 + (returnType === 'smash' ? 1 : 0)] = 45;
      }
      wasWanting[s] = should;
    }
    // 将当前输入写入引擎（按 hold 表）
    for (let s = 0; s < 2; s++) {
      TT.setInput(e, s, {
        pu: hold[s * 2] > 0,
        sm: hold[s * 2 + 1] > 0,
      });
      hold[s * 2] = Math.max(0, hold[s * 2] - 1);
      hold[s * 2 + 1] = Math.max(0, hold[s * 2 + 1] - 1);
    }
    const before = e.rallyCount;
    TT.step(e, 1 / 120);
    if (e.rallyCount > before) hits++;
    if (hits >= 8 && !gaveUp) { gaveUp = true; wasWanting[0] = false; wasWanting[1] = false; }
    if (e.phase === 'point' || e.phase === 'over') {
      winner = e.pointWinner;
      break;
    }
    // 超过 60 拍还没有结果就算异常（正常回合应能自然结束）
    if (hits > 60) break;
  }
  return { hits, serves, winner, phase: e.phase, score: [...e.score], reason: e.pointReason };
}

for (const serveSide of [0, 1]) {
  for (const type of ['push', 'smash']) {
    const r = scriptedRally(serveSide, type);
    // 得分在 point 阶段结束后才写入比分，这里以“回合决出胜负 + 至少完成击球”为准
    const minHits = type === 'smash' ? 1 : 3;
    const valid = r.winner !== -1 && r.hits >= minHits;
    check(`P${serveSide + 1} ${type === 'smash' ? '高空球' : '发球 + '}双方${type} 有效回合(击球${r.hits}次, 胜方${r.winner + 1})`, valid);
  }
}

// ---------- 3. 扣球质量：两侧都能扣出高速球 ----------
for (const side of [0, 1]) {
  const e = TT.createEngine();
  // 直接把球放到该侧半台上方并允许击球
  e.phase = 'play';
  e.serveStage = 'rally';
  e.mayHit = [true, true];
  const f = e.players[side].facing;
  e.ball.inHand = false;
  e.ball.pos = { x: e.players[side].x, y: 1.05, z: e.players[side].z + f * 0.3 };
  e.ball.vel = { x: 0, y: -1.2, z: f * 2.0 };
  e.ball.spin = { x: 0, y: 0, z: 0 };
  e.ball.hitBy = 1 - side;
  e.ball.lastBounce = 1 - side;
  TT.setInput(e, side, { sm: true });
  let hit = false;
  for (let i = 0; i < 120; i++) {
    const prev = e.rallyCount;
    TT.step(e, 1 / 120);
    if (e.rallyCount > prev) { hit = true; break; }
  }
  const spd = hit ? Math.hypot(e.ball.vel.x, e.ball.vel.y, e.ball.vel.z) : 0;
  check(`P${side + 1} 扣球出球速度 ${spd.toFixed(1)}m/s (≥6.0)`, hit && spd >= 6.0);
}

// ---------- 4. ITTF 尺寸 ----------
const r = TT.RULES;
check('球台 2.74×1.525m', Math.abs(r.TABLE_LENGTH - 2.74) < 1e-9 && Math.abs(r.TABLE_WIDTH - 1.525) < 1e-9);
check('台高 0.76m / 网高 0.1525m', Math.abs(r.TABLE_HEIGHT - 0.76) < 1e-9 && Math.abs(r.NET_HEIGHT - 0.1525) < 1e-9);
check('球 40mm / 2.7g', Math.abs(r.BALL_RADIUS - 0.02) < 1e-9 && Math.abs(r.BALL_MASS - 0.0027) < 1e-9);
check('拍面 15cm×15cm / 柄 8.5cm', Math.abs(r.BLADE_LEN - 0.15) < 1e-9 && Math.abs(r.BLADE_WID - 0.15) < 1e-9 && Math.abs(r.HANDLE_LEN - 0.085) < 1e-9);

console.log(failures === 0 ? '\n引擎压力测试全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
