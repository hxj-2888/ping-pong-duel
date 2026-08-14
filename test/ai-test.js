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
  // 接扣杀概率：仅困难/地狱可应对（0/0/0.55/0.95，等级递增；配合位置门定标有效反击率 困难~50%/地狱~80%）
  const sd = AIC.LEVELS.map((l) => l.smashDef || 0);
  check('接扣杀 smashDef：简单0/中等0/困难0.55/地狱0.95（递增）',
    sd[0] === 0 && sd[1] === 0 && sd[2] === 0.55 && sd[3] === 0.95 && sd[2] < sd[3]);
  // 变招基础概率：中等(数值=1)=20%，随难度递增
  const tb = AIC.LEVELS.map((l) => l.trickBase || 0);
  check('变招基础概率：中等=0.2 且随难度递增', tb[1] === 0.2 && tb[0] <= tb[1] && tb[1] < tb[2] && tb[2] < tb[3]);
  // 无法扣杀放弃概率：困难 80%、地狱 90%（10% 冒险出手降级扣杀，强化扣杀展示）
  check('无法扣杀放弃：困难0.8/地狱0.9', (AIC.LEVELS[2].failSkip || 0) === 0.8 && AIC.LEVELS[3].failSkip === 0.9);
  // 地狱 100% 不刻意漏球：catchProb=1.0；smashY 0.95（扣杀更低球更激进）
  check('地狱 0% 刻意漏球：catchProb=1.0 / smashY=0.95',
    AIC.LEVELS[3].catchProb === 1.0 && AIC.LEVELS[3].smashY === 0.95);
  // 蹲下速度：0.40 基础、最低 0.20、转换延迟上限 0.5s
  check('蹲下速度 0.40/最低0.20/延迟上限0.5s',
    TT.RULES.CROUCH_SPEED_MUL === 0.40 && TT.RULES.CROUCH_MIN_SPEED_MUL === 0.20 &&
    TT.RULES.CROUCH_TOGGLE_MAX === 0.5 && TT.RULES.CROUCH_TOGGLE_WINDOW === 3.0);
}

// ---------- 7. 扣杀求解：右键只出快扣杀，解不出=撞网（netHit），不再降级成慢速球 ----------
{
  const e = TT.createEngine();
  e.phase = 'play'; e.serveStage = 'rally'; e.mayHit = [true, false];
  e.ball.inHand = false;
  let lowNet = 0, highOk = 0, detail = '';
  for (const y of [0.80, 0.92]) {          // 低接触：快扣不可过网 → 撞网
    e.ball.pos = { x: 0, y, z: -1.2 };
    e.ball.vel = { x: 0, y: 0.5, z: -3.0 };
    e.ball.spin = { x: 0, y: 0, z: 0 };
    e.ball.hitBy = 1; e.ball.lastBounce = 1;
    const shot = TT.computeShot(e, 0, 2);
    if (shot && shot.netHit) lowNet++;
    else detail += ` y=${y}→${shot ? '快扣' : 'null'}`;
  }
  for (const y of [1.10, 1.25]) {          // 高接触：真快扣可解
    e.ball.pos = { x: 0, y, z: -1.2 };
    e.ball.vel = { x: 0, y: 0.5, z: -3.0 };
    e.ball.spin = { x: 0, y: 0, z: 0 };
    e.ball.hitBy = 1; e.ball.lastBounce = 1;
    const shot = TT.computeShot(e, 0, 2);
    if (shot && !shot.netHit && shot.vel) highOk++;
    else detail += ` y=${y}→${shot ? 'netHit' : 'null'}`;
  }
  check(`扣杀求解：低接触=撞网(netHit) ${lowNet}/2、高接触=快扣 ${highOk}/2`, lowNet === 2 && highOk === 2 && detail === '');
  // 低球右键整局：挥拍命中但打进网 → 对方得分
  {
    const e2 = TT.createEngine();
    e2.phase = 'play'; e2.serveStage = 'rally'; e2.mayHit = [true, false];
    e2.ball.inHand = false;
    e2.ball.pos = { x: 0, y: 0.92, z: -1.25 };
    e2.ball.vel = { x: 0, y: 0.5, z: 3.0 };
    e2.ball.spin = { x: 0, y: 0, z: 0 };
    e2.ball.hitBy = 1; e2.ball.lastBounce = 1;
    let smHeld = 0, netSeen = false, pWinner = -1;
    for (let i = 0; i < 120 * 4; i++) {
      const p0 = e2.players[0], b = e2.ball;
      const zc0 = p0.z + p0.facing * 0.42;
      const inBox0 = Math.abs(b.pos.x - p0.x) < TT.RULES.HITBOX_HX && Math.abs(b.pos.z - zc0) < TT.RULES.HITBOX_HZ &&
        b.pos.y > TT.RULES.HITBOX_Y_BOTTOM && b.pos.y < TT.RULES.HITBOX_Y_TOP;
      let sm = 0;
      if (e2.mayHit[0] && inBox0 && !smHeld) { sm = 1; smHeld = 10; }
      if (smHeld > 0) { sm = 1; smHeld--; }
      TT.setInput(e2, 0, { sm });
      TT.step(e2, 1 / 120);
      for (const ev of e2.events) {
        if (ev.c === 'net') netSeen = true;
        if (ev.c === 'point') pWinner = e2.pointWinner;
      }
      e2.events.length = 0;
      if (e2.phase !== 'play') break;
    }
    check('低球右键=撞网判负（net 事件 → 对方得分）', netSeen && pWinner === 1);
  }
}

// ---------- 8. 玩家可反击扣杀（蹲下+推球+预判起拍，一定角度内可接） ----------
{
  const R = TT.RULES;
  const predictCrossing = (ball, zc, maxT) => {
    const steps = Math.ceil(maxT / 0.02);
    let prevZ = ball.pos.z, prevPos = ball.pos;
    for (let i = 1; i <= steps; i++) {
      const t = i * 0.02;
      const p = TT.predictBall(ball, t);
      if ((prevZ - zc) * (p.z - zc) <= 0) {
        const f = Math.abs(p.z - zc) / (Math.abs(p.z - zc) + Math.abs(prevZ - zc) + 1e-9);
        return { t: t - 0.02 * f, y: prevPos.y + (p.y - prevPos.y) * (1 - f) };
      }
      prevZ = p.z; prevPos = p;
    }
    return null;
  };
  const e = TT.createEngine();
  let smashIn = 0, returned = 0, pending = false, injected = 0, lastInject = -240, counterFlagged = 0;
  for (let i = 0; i < 120 * 600; i++) {
    // 脚本化玩家(side0)防守
    const p0 = e.players[0], b = e.ball;
    const zc0 = p0.z + p0.facing * 0.42;
    const incoming0 = e.phase === 'play' && !b.inHand && (b.vel.z * p0.facing < 0);
    const inBox0 = Math.abs(b.pos.x - p0.x) < R.HITBOX_HX && Math.abs(b.pos.z - zc0) < R.HITBOX_HZ &&
      b.pos.y > R.HITBOX_Y_BOTTOM && b.pos.y < R.HITBOX_Y_TOP;
    const cross0 = incoming0 ? predictCrossing(b, zc0, 1.4) : null;
    const smashIn0 = incoming0 && b.hitType === 2;
    const preSwing = smashIn0 && cross0 && cross0.t < 0.18 && !inBox0;
    const crouch0 = incoming0 && ((cross0 && cross0.t < 0.45 && cross0.y < 0.95) ||
      (b.pos.y < 0.95 && Math.hypot(b.pos.x - p0.x, b.pos.z - zc0) < 1.6));
    const pu = preSwing || (incoming0 && e.mayHit[0] && inBox0);
    let servePu = 0;
    if (e.phase === 'serve' && e.server === 0 && b.inHand && p0.hitCd <= 0 && i % 48 < 3) servePu = 1;
    TT.setInput(e, 0, { pu: (pu || servePu) ? 1 : 0, crouch: crouch0 ? 1 : 0 });
    if (smashIn0 && !pending) { pending = true; smashIn++; }
    AIC.control(e, 1, DT, 2);
    const before = e.rallyCount;
    TT.step(e, DT);
    if (pending && e.rallyCount > before && e.ball.hitBy === 0) { returned++; counterFlagged += e.ball.counterSmash === 1 ? 1 : 0; pending = false; }
    if (pending && e.phase !== 'play') pending = false;
    const p1 = e.players[1];
    if (e.phase === 'play' && !e.ball.inHand && injected < 14 && i - lastInject > 240 &&
        !p1.stroke.active && p1.hitCd <= 0 && e.mayHit[1]) {
      e.ball.pos = { x: p1.x, y: 1.15, z: p1.z + p1.facing * 0.60 };
      e.ball.vel = { x: 0, y: 1.2, z: -p1.facing * 3.0 };
      e.ball.spin = { x: 0, y: 0, z: 0 };
      e.ball.hitBy = 0; e.ball.lastBounce = 0;
      e.mayHit = [false, true];
      injected++; lastInject = i;
    }
    e.events.length = 0;
    if (e.phase === 'over') break;
  }
  check(`玩家反击扣杀可解（困难AI扣杀${smashIn}次玩家接住${returned}次）`, smashIn >= 5 && returned >= 1);
  // 操作奖励：人类推球反击 AI 扣杀的回球标记 counterSmash（视为扣杀、AI 应对概率减半）
  check(`反击扣杀回球标记 counterSmash（${counterFlagged}/${returned} 次）`, returned >= 1 && counterFlagged >= 1);
}

// ---------- 8b. 反击低平快球奖励（更高档）：视为扣杀 + 更高球速 + 刁钻落位 ----------
{
  const R = TT.RULES;
  const e = TT.createEngine();
  const oppX = 0.4; // 对手站在右侧（x>0）
  e.players[1].x = oppX;
  // 模拟人类（side0，非 AI）蹲下推球反击一颗低平快球（hitType 3）
  const p0 = e.players[0];
  p0.x = 0; p0.padX = 0; p0.z = -1.65; p0.vx = 0; p0.vz = 0; p0.crouch = 1;
  e.phase = 'play'; e.serveStage = 'rally'; e.mayHit = [true, false];
  e.ball.inHand = false;
  e.ball.pos = { x: 0, y: 1.05, z: -1.2 };
  e.ball.vel = { x: 0, y: 0, z: 3.0 };
  e.ball.spin = { x: 0, y: 0, z: 0 };
  e.ball.hitType = 3; e.ball.counterSmash = 0; // 来球=低平快球
  e.ball.hitBy = 1; e.ball.lastBounce = 1;
  const before = e.rallyCount;
  let n = 0;
  while (e.phase === 'play' && e.rallyCount === before && n < 120) {
    TT.setInput(e, 0, { pu: 1, crouch: 1 });
    TT.step(e, 1 / 120);
    n++;
  }
  const hit = e.rallyCount > before && e.ball.hitBy === 0;
  const spd = Math.hypot(e.ball.vel.x, e.ball.vel.y, e.ball.vel.z);
  check('反击低平快球：回球标记 counterSmash（视为扣杀）', hit && e.ball.counterSmash === 1);
  check('反击低平快球：回球速度明显高于普通推球（更高球速）', hit && spd > 5.5);
  check('反击低平快球：回球打向对手反方向边角（刁钻落位）', hit && Math.sign(e.ball.vel.x) === -Math.sign(oppX));
  // 对照：普通推球回球（来球非扣杀/低平）不应触发奖励
  const e2 = TT.createEngine();
  const p2 = e2.players[0];
  p2.x = 0; p2.padX = 0; p2.z = -1.65; p2.vx = 0; p2.vz = 0;
  e2.players[1].x = oppX;
  e2.phase = 'play'; e2.serveStage = 'rally'; e2.mayHit = [true, false];
  e2.ball.inHand = false;
  e2.ball.pos = { x: 0, y: 1.05, z: -1.2 };
  e2.ball.vel = { x: 0, y: 0, z: 3.0 };
  e2.ball.spin = { x: 0, y: 0, z: 0 };
  e2.ball.hitType = 1; e2.ball.counterSmash = 0; // 普通来球
  e2.ball.hitBy = 1; e2.ball.lastBounce = 1;
  const before2 = e2.rallyCount;
  let m = 0;
  while (e2.phase === 'play' && e2.rallyCount === before2 && m < 120) {
    TT.setInput(e2, 0, { pu: 1 });
    TT.step(e2, 1 / 120);
    m++;
  }
  const hit2 = e2.rallyCount > before2 && e2.ball.hitBy === 0;
  check('普通推球回球：不触发反击奖励（counterSmash=0）', hit2 && e2.ball.counterSmash === 0);
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

// ---------- 7. 无尽人机配置：无尽-1 基线正确，攻击/敏捷随关卡线性增长 ----------
{
  const i1 = AIC.endlessConfig(1);
  const i2 = AIC.endlessConfig(2);
  const i3 = AIC.endlessConfig(3);
  check('无尽-1：反应 0 秒 / 防扣 95% / 攻击敏捷与地狱一致',
    i1.react === 0 && i1.smashDef === 0.95 && i1.attackMul === 1 && i1.agilityMul === 1 && i1.infinite === true);
  check('无尽关卡：攻击与敏捷线性增长且上不封顶',
    i2.attackMul > i1.attackMul && i3.attackMul > i2.attackMul &&
    i2.agilityMul > i1.agilityMul && i3.agilityMul > i2.agilityMul);
  check('无尽难度标识解析（inf-N / 对象 / 普通档位）',
    AIC.levelName('inf-2') === '无尽-2' && AIC.isInfiniteLevel('inf-1') && !AIC.isInfiniteLevel(3));
}

console.log(failures === 0 ? '\n人机对手测试全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
