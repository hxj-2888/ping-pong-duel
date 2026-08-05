/* ============================================================
 * tools/sim-match.js — 模拟球赛（AI vs AI，功能实现度验证工具）
 * 用法：
 *   node tools/sim-match.js            # 默认：地狱vs地狱×2 + 困难vs地狱 + 低球注入对比
 * 说明：
 *   - 引擎与 AI 均可在 Node 中直接运行（AI 状态已按 (engine, side) 区分，
 *     因此支持双方同时用 AI 控制）。
 *   - AI 的求解回球总是"合法落台"，两个熟练 AI 对打会出现无限回合——
 *     用「地狱」难度（10% 刻意漏接）可让回合自然结束，验证完整对局。
 *   - 低球注入：对局中把低球放到接球方面前，验证「蹲下接任何低球」。
 * ============================================================ */
'use strict';

const TT = require('../public/js/engine.js');
const AIC = require('../public/js/ai.js');
const STEP = 1 / 120;
const LVL_NAME = ['简单', '中等', '困难', '地狱'];

// ---------- 完整对局 ----------
function runMatch({ lvlA = 3, lvlB = 3, maxSteps = 120 * 600 }) {
  const e = TT.createEngine();
  const st = { completed: false, steps: 0, score: [0, 0], points: 0, hits: 0, serves: 0, reasons: {}, maxRally: 0, rallyHits: 0, deuceSeen: false, nan: false };
  for (let i = 0; i < maxSteps; i++) {
    AIC.control(e, 0, STEP, lvlA);
    AIC.control(e, 1, STEP, lvlB);
    TT.step(e, STEP);
    if (![e.ball.pos.x, e.ball.pos.y, e.ball.pos.z, e.players[0].x, e.players[1].x].every(Number.isFinite)) st.nan = true;
    for (const ev of e.events) {
      if (ev.c === 'hit') { st.hits++; st.rallyHits++; }
      else if (ev.c === 'serve') st.serves++;
      else if (ev.c === 'point') {
        st.points++; st.score = [e.score[0], e.score[1]];
        st.reasons[e.pointReason] = (st.reasons[e.pointReason] || 0) + 1;
        st.maxRally = Math.max(st.maxRally, st.rallyHits); st.rallyHits = 0;
        if (e.score[0] >= 10 && e.score[1] >= 10) st.deuceSeen = true;
      } else if (ev.c === 'let') st.reasons.let = (st.reasons.let || 0) + 1;
    }
    e.events.length = 0;
    st.steps = i + 1;
    if (e.phase === 'over') { st.completed = true; st.score = [e.score[0], e.score[1]]; break; }
  }
  return st;
}

// ---------- 低球注入（验证蹲下接任何低球） ----------
function runLowBallInjection({ crouchSide1, nInj = 12, lvl = 2, maxSteps = 120 * 400 }) {
  const e = TT.createEngine();
  const R = TT.RULES;
  const st = { injected: 0, caught: 0, missed: 0 };
  let pressThisBall = false;
  let injectedTick = -1;
  for (let i = 0; i < maxSteps; i++) {
    AIC.control(e, 0, STEP, lvl);
    AIC.control(e, 1, STEP, lvl);
    if (crouchSide1) {
      // 蹲伏 AI：球低且可接时先蹲下再推球
      const p = e.players[1], b = e.ball, f = p.facing;
      const inp = e.inputs[1];
      const lowHit = e.phase === 'play' && !b.inHand && (b.vel.z * f < 0) && e.mayHit[1] &&
        Math.abs(b.pos.x - p.x) < R.HITBOX_HX && Math.abs(b.pos.z - (p.z + f * 0.42)) < R.HITBOX_HZ &&
        b.pos.y > R.CROUCH_HITBOX_Y_BOTTOM && b.pos.y < 0.55;
      if (lowHit) { inp.crouch = 1; if (!pressThisBall) { inp.pu = 1; pressThisBall = true; } }
      else pressThisBall = false;
    }
    TT.step(e, STEP);
    for (const ev of e.events) {
      if (ev.c === 'hit' && ev.s === 1 && injectedTick >= 0 && i - injectedTick < 60) st.caught++;
    }
    e.events.length = 0;
    // 注入低球：对局中、接球方空闲（不在挥拍/冷却）时注入
    const p1 = e.players[1];
    if (e.phase === 'play' && !e.ball.inHand && st.injected < nInj && i - injectedTick > 240 &&
        !p1.stroke.active && p1.hitCd <= 0) {
      const p = e.players[1];
      e.ball.pos = { x: p.x, y: 0.30, z: p.z + p.facing * 0.15 };
      e.ball.vel = { x: 0, y: 0.2, z: -p.facing * 1.0 }; // 朝接球方飞来（incoming）
      e.ball.spin = { x: 0, y: 0, z: 0 };
      e.ball.hitBy = 0; e.ball.lastBounce = 0;
      e.mayHit = [false, true];
      st.injected++; injectedTick = i; pressThisBall = false;
    }
  }
  st.missed = st.injected - st.caught;
  return st;
}

function fmt(st, label) {
  const reasonStr = Object.keys(st.reasons).map((k) => `${k}:${st.reasons[k]}`).join(' ');
  return `[${label}] 完成=${st.completed} 步骤=${st.steps} 比分=${st.score[0]}:${st.score[1]} 局点=${st.points} 击球=${st.hits} 发球=${st.serves} 最长回合=${st.maxRally} 抢七=${st.deuceSeen} NaN=${st.nan}${reasonStr ? ' 原因[' + reasonStr + ']' : ''}`;
}

console.log('=== 乒乓对决 · 模拟球赛（功能实现度） ===\n');
for (let m = 1; m <= 2; m++) console.log(fmt(runMatch({ lvlA: 3, lvlB: 3 }), `地狱vs地狱 #${m}`));
console.log(fmt(runMatch({ lvlA: 2, lvlB: 3 }), '困难vs地狱'));
const without = runLowBallInjection({ crouchSide1: false });
const withC = runLowBallInjection({ crouchSide1: true });
console.log(`[低球注入 纯AI]   注入=${without.injected} 接住=${without.caught} 漏接=${without.missed}`);
console.log(`[低球注入 蹲伏AI] 注入=${withC.injected} 接住=${withC.caught} 漏接=${withC.missed}`);
console.log('\n=== 结束 ===');
