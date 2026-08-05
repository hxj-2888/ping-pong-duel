/* 人机对手测试：自动发球 / 回球回合 / 追球移动 / 比赛推进 / 难度档位 */
'use strict';

const TT = require('../public/js/engine.js');
const AIC = require('../public/js/ai.js');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

const DT = 1 / 120;

// ---------- 1. AI 自动发球 ----------
{
  const e = TT.createEngine();
  e.server = 1;
  e.startServer = 1;
  e.ball.pos = { x: 0, y: 1.0, z: e.players[1].z + e.players[1].facing * 0.22 };
  let served = false;
  for (let i = 0; i < 2400; i++) {
    AIC.control(e, 1, DT, 1);
    TT.step(e, DT);
    if (e.phase === 'play') { served = true; break; }
  }
  check('AI 自动发球进入对打', served && !e.ball.inHand && Number.isFinite(e.ball.pos.x));
}

// ---------- 2. 脚本化人类 vs AI（困难）多拍回合 ----------
{
  const e = TT.createEngine();
  const hold = [0, 0];
  const wasWanting = [false, false];
  const ballNear = (side) => {
    const p = e.players[side], b = e.ball;
    if (b.inHand) return false;
    const zc = p.z + p.facing * 0.42;
    return Math.hypot(b.pos.x - p.x, b.pos.z - zc) < 1.0 &&
           b.pos.y > 0.80 && b.pos.y < 1.45;
  };
  let aiHits = 0;
  let winner = -1;
  // 困难 AI 有 10% 刻意漏接（catchProb=0.90），单回合可能漏——跨多回合累计回球数
  for (let i = 0; i < 60000; i++) {
    // 人类（P0）：发球 + 推球回击（边沿触发）
    if (e.phase === 'serve' && e.server === 0 && e.ball.inHand && e.players[0].hitCd <= 0) {
      hold[0] = 12;
    }
    const want = e.phase === 'play' && e.mayHit[0] && ballNear(0) && aiHits < 5;
    if (want && !wasWanting[0]) hold[0] = 45;
    wasWanting[0] = want;
    TT.setInput(e, 0, { pu: hold[0] > 0 });
    hold[0] = Math.max(0, hold[0] - 1);

    AIC.control(e, 1, DT, 2);
    const before = e.rallyCount;
    TT.step(e, DT);
    if (e.rallyCount > before && e.ball.hitBy === 1) aiHits++;
    // 完成若干拍后人类停手，让回合自然结束（推球抬高过网后，完美回球回合不会自行终止）
    if (aiHits >= 5) { hold[0] = 0; wasWanting[0] = false; }
    if (e.phase === 'over') { winner = e.pointWinner; break; }
  }
  check(`困难AI 多拍回合（AI回球${aiHits}次）`, e.phase === 'over' && aiHits >= 3);
}

// ---------- 3. AI 追球移动 ----------
{
  const e = TT.createEngine();
  e.phase = 'play';
  e.serveStage = 'rally';
  e.mayHit = [false, false];
  e.ball.inHand = false;
  e.ball.pos = { x: 1.1, y: 1.0, z: 0.5 };
  e.ball.vel = { x: 0.8, y: -0.2, z: 1.6 };
  e.ball.spin = { x: 0, y: 0, z: 0 };
  e.ball.hitBy = 0;
  e.ball.lastBounce = 0;
  for (let i = 0; i < 240; i++) {
    AIC.control(e, 1, DT, 1);
    TT.step(e, DT);
    if (e.phase !== 'play') break;
  }
  check(`AI 向球落点移动（x=${e.players[1].x.toFixed(2)}）`, e.players[1].x > 0.15);
}

// ---------- 4. 比赛推进：AI 发球连得分 ----------
{
  const e = TT.createEngine();
  e.server = 1;
  e.startServer = 1;
  e.ball.pos = { x: 0, y: 1.0, z: e.players[1].z + e.players[1].facing * 0.22 };
  let bad = false;
  for (let i = 0; i < 7200; i++) {
    AIC.control(e, 1, DT, 1);
    TT.step(e, DT);
    const snap = TT.snapshot(e);
    if (!snap.sc.every((v) => Number.isFinite(v))) { bad = true; break; }
  }
  check(`比赛推进：AI 得分 ${e.score[1]} 分`, !bad && e.score[1] >= 2);
}

// ---------- 2b. 地狱 AI 刻意打低球（lowShotProb=0.5 → type 3 低平快球）----------
{
  const e = TT.createEngine();
  const hold = [0, 0];
  const wasWanting = [false, false];
  const ballNear = (side) => {
    const p = e.players[side], b = e.ball;
    if (b.inHand) return false;
    const zc = p.z + p.facing * 0.42;
    return Math.hypot(b.pos.x - p.x, b.pos.z - zc) < 1.0 &&
           b.pos.y > 0.80 && b.pos.y < 1.45;
  };
  let aiHits = 0, aiLow = 0;
  for (let i = 0; i < 60000; i++) {
    if (e.phase === 'serve' && e.server === 0 && e.ball.inHand && e.players[0].hitCd <= 0) hold[0] = 12;
    const want = e.phase === 'play' && e.mayHit[0] && ballNear(0) && aiHits < 12;
    if (want && !wasWanting[0]) hold[0] = 45;
    wasWanting[0] = want;
    TT.setInput(e, 0, { pu: hold[0] > 0 });
    hold[0] = Math.max(0, hold[0] - 1);
    AIC.control(e, 1, DT, 3); // 地狱：50% 刻意低球
    const before = e.rallyCount;
    TT.step(e, DT);
    if (e.rallyCount > before && e.ball.hitBy === 1) {
      aiHits++;
      if (e.players[1].stroke.type === 3) aiLow++;
    }
    if (aiHits >= 12) break;
  }
  check(`地狱AI 刻意低球（回球${aiHits}次中低平快球${aiLow}次）`, aiLow >= 3 && aiLow <= aiHits);
}

// ---------- 2c. 地狱强化：数值拉满 + 快球预判（修"快球必漏"，仅地狱生效） ----------
{
  const L3 = AIC.LEVELS[3];
  check('地狱数值拉满：catch 0.95 / react 0.01 / smashY 0.95 / err 0.01',
    L3.catchProb === 0.95 && L3.react === 0.01 && L3.smashY === 0.95 && L3.err === 0.01);
  // 高速扣球级来球（22m/s）：地狱能接住（预判起手 + 蹲下），困难（无预判）接不住
  const fastCatch = (level, ballY) => {
    const e = TT.createEngine();
    e.phase = 'play'; e.serveStage = 'rally';
    e.mayHit = [true, true];
    e.ball.inHand = false;
    e.ball.pos = { x: 0, y: ballY, z: -0.5 };
    e.ball.vel = { x: 0, y: -0.5, z: 22 };
    e.ball.spin = { x: 0, y: 0, z: 0 };
    e.ball.hitBy = 0; e.ball.lastBounce = 0;
    let hit = false;
    for (let i = 0; i < 60; i++) {
      AIC.control(e, 1, DT, level);
      TT.step(e, DT);
      if (e.ball.hitBy === 1) { hit = true; break; }
      if (e.phase !== 'play') break;
    }
    return hit;
  };
  check('地狱快球预判：22m/s 高球接住', fastCatch(3, 1.35));
  check('地狱快球预判：22m/s 低球（蹲下）接住', fastCatch(3, 0.95));
  check('困难无预判：22m/s 高球接不住', !fastCatch(2, 1.35));
  // 地狱快速发球：发球即抢攻（fast serve）
  const e2 = TT.createEngine();
  e2.server = 1; e2.startServer = 1;
  e2.ball.pos = { x: 0, y: 1.0, z: e2.players[1].z + e2.players[1].facing * 0.22 };
  let fastServe = false, served2 = false;
  for (let i = 0; i < 2400; i++) {
    AIC.control(e2, 1, DT, 3);
    TT.step(e2, DT);
    if (e2.phase === 'play') {
      served2 = true;
      fastServe = Math.hypot(e2.ball.vel.x, e2.ball.vel.y, e2.ball.vel.z) > 6.0;
      break;
    }
  }
  check(`地狱快速发球（出球速度${served2 ? Math.hypot(e2.ball.vel.x, e2.ball.vel.y, e2.ball.vel.z).toFixed(1) : '未发'}m/s > 6）`, served2 && fastServe);
}

// ---------- 5. 难度档位配置 ----------
{
  const names = AIC.LEVELS.map((l) => l.name).join('/');
  const ordered = AIC.LEVELS[0].react > AIC.LEVELS[1].react &&
    AIC.LEVELS[1].react > AIC.LEVELS[2].react &&
    AIC.LEVELS[2].react > AIC.LEVELS[3].react &&
    AIC.LEVELS[0].agility < AIC.LEVELS[1].agility &&
    AIC.LEVELS[1].agility < AIC.LEVELS[2].agility &&
    AIC.LEVELS[0].smashProb < AIC.LEVELS[1].smashProb &&
    AIC.LEVELS[1].smashProb < AIC.LEVELS[2].smashProb;
  check(`四档难度（${names}）参数递增有序`, AIC.LEVELS.length === 4 && ordered);
  // 刻意低球概率：简单/中等不低球，困难 1/5、地狱 1/2
  const lowProbs = AIC.LEVELS.map((l) => l.lowShotProb || 0);
  check('刻意低球概率：简单0/中等0/困难0.2/地狱0.5',
    lowProbs[0] === 0 && lowProbs[1] === 0 && lowProbs[2] === 0.2 && lowProbs[3] === 0.5);
}

// ---------- 6. AI 与玩家条件同步（蹲下/跑步/前后移动/同一碰撞箱） ----------
{
  // 贴地球（台端线后方，避免先弹台）：AI 应像玩家按 Ctrl 一样自动蹲下，
  // 球进入蹲下箱（可接范围）；成功回球由物理边界 9e 覆盖（引擎级）
  const e = TT.createEngine();
  e.phase = 'play'; e.serveStage = 'rally'; e.mayHit = [true, true];
  e.ball.inHand = false;
  e.ball.pos = { x: 0.2, y: 0.50, z: e.players[1].z - 0.15 };
  e.ball.vel = { x: 0, y: 0.2, z: 0.6 };
  e.ball.spin = { x: 0, y: 0, z: 0 };
  e.ball.hitBy = 0; e.ball.lastBounce = 0;
  let crouched = false, inCrouchBox = false;
  for (let i = 0; i < 90; i++) {
    const inp = AIC.control(e, 1, DT, 2);
    if (inp.crouch) crouched = true;
    const R = TT.RULES;
    if (crouched &&
        Math.abs(e.ball.pos.x - e.players[1].x) < R.HITBOX_HX &&
        Math.abs(e.ball.pos.z - (e.players[1].z + e.players[1].facing * 0.42)) < R.HITBOX_HZ &&
        e.ball.pos.y > R.CROUCH_HITBOX_Y_BOTTOM && e.ball.pos.y < R.CROUCH_HITBOX_Y_TOP) {
      inCrouchBox = true;
    }
    TT.step(e, DT);
    if (e.phase === 'point' || e.phase === 'over') break;
  }
  check('AI 贴地球自动蹲下且球进入蹲下箱（与玩家蹲下同步）', crouched && inCrouchBox);

  // 多拍回合中 AI 会使用前/后移动与跑步（与玩家移动范围/跑步同步）
  const e2 = TT.createEngine();
  const stats = { f: 0, b: 0, run: 0, hits: 0 };
  let want = false;
  for (let i = 0; i < 8000 && stats.hits < 20; i++) {
    if (e2.phase === 'serve' && e2.server === 0 && e2.ball.inHand && e2.players[0].hitCd <= 0) {
      TT.setInput(e2, 0, { pu: 1 }); TT.step(e2, DT); TT.setInput(e2, 0, {});
      continue;
    }
    const p0 = e2.players[0];
    const zc0 = p0.z + p0.facing * 0.42;
    const near = e2.phase === 'play' && e2.mayHit[0] && !e2.ball.inHand &&
      Math.abs(e2.ball.pos.x - p0.x) < TT.RULES.HITBOX_HX &&
      Math.abs(e2.ball.pos.z - zc0) < TT.RULES.HITBOX_HZ &&
      e2.ball.pos.y > TT.RULES.HITBOX_Y_BOTTOM && e2.ball.pos.y < TT.RULES.HITBOX_Y_TOP;
    if (near && !want) TT.setInput(e2, 0, { pu: 1 });
    else if (!near) TT.setInput(e2, 0, {});
    want = near;
    const inp = AIC.control(e2, 1, DT, 2);
    if (inp.f) stats.f++;
    if (inp.b) stats.b++;
    if (inp.run) stats.run++;
    const before = e2.rallyCount;
    TT.step(e2, DT);
    if (e2.rallyCount > before && e2.ball.hitBy === 1) stats.hits++;
    if (e2.phase === 'point' || e2.phase === 'over') break;
  }
  check('AI 使用前/后移动与跑步（与玩家移动范围同步）', stats.f > 0 && stats.b > 0 && stats.run > 0);
}

console.log(failures === 0 ? '\n人机对手测试全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
