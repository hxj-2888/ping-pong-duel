/* ============================================================
 * tools/sim-match.js — 模拟球赛（AI vs AI，平衡迭代工具）
 * 用法：
 *   node tools/sim-match.js            # 默认：地狱vs地狱 + 地狱vs困难×N + 困难vs中等×N + 低球注入
 *   node tools/sim-match.js <lvlA> <lvlB> <种子数>
 * 说明：
 *   - 引擎与 AI 均可在 Node 中直接运行（AI 状态已按 (engine, side) 区分，
 *     因此支持双方同时用 AI 控制；第 6 参 seed 可换种子取平均）。
 *   - 统计：比分、击球类型分布（推/扣/低）、接扣杀（来球是扣杀 → 接住/漏接）、
 *     回合长度、判分原因。
 * ============================================================ */
'use strict';

const TT = require('../public/js/engine.js');
const AIC = require('../public/js/ai.js');
const STEP = 1 / 120;
const LVL_NAME = ['简单', '中等', '困难', '地狱'];

// ---------- 完整对局 ----------
function runMatch({ lvlA = 3, lvlB = 3, maxSteps = 120 * 600, seed } = {}) {
  const e = TT.createEngine();
  const st = {
    completed: false, steps: 0, score: [0, 0], points: 0, hits: 0, serves: 0,
    reasons: {}, maxRally: 0, rallyHits: 0, deuceSeen: false, nan: false,
    hitType: [{ 1: 0, 2: 0, 3: 0 }, { 1: 0, 2: 0, 3: 0 }],
    smashIn: [0, 0], smashReturned: [0, 0],
  };
  const smashPending = [false, false];
  for (let i = 0; i < maxSteps; i++) {
    AIC.control(e, 0, STEP, lvlA, undefined, seed);
    AIC.control(e, 1, STEP, lvlB, undefined, seed);
    TT.step(e, STEP);
    if (![e.ball.pos.x, e.ball.pos.y, e.ball.pos.z, e.players[0].x, e.players[1].x].every(Number.isFinite)) st.nan = true;
    for (const ev of e.events) {
      if (ev.c === 'hit') {
        st.hits++; st.rallyHits++;
        const t = e.players[ev.s].stroke.type;
        if (t >= 1 && t <= 3) st.hitType[ev.s][t]++;
        // 接扣杀统计：来球是扣杀（上一拍 type2）→ 本拍命中则"接住"
        if (smashPending[ev.s]) { st.smashReturned[ev.s]++; smashPending[ev.s] = false; }
        if (t === 2) { smashPending[1 - ev.s] = true; st.smashIn[1 - ev.s]++; }
      } else if (ev.c === 'serve') {
        st.serves++;
        smashPending[0] = smashPending[1] = false;
      } else if (ev.c === 'point') {
        st.points++; st.score = [e.score[0], e.score[1]];
        st.reasons[e.pointReason] = (st.reasons[e.pointReason] || 0) + 1;
        st.maxRally = Math.max(st.maxRally, st.rallyHits); st.rallyHits = 0;
        if (e.score[0] >= 10 && e.score[1] >= 10) st.deuceSeen = true;
        smashPending[0] = smashPending[1] = false;
      } else if (ev.c === 'let') st.reasons.let = (st.reasons.let || 0) + 1;
    }
    e.events.length = 0;
    st.steps = i + 1;
    if (e.phase === 'over') { st.completed = true; st.score = [e.score[0], e.score[1]]; break; }
  }
  return st;
}

function fmt(st, label) {
  const reasonStr = Object.keys(st.reasons).map((k) => `${k}:${st.reasons[k]}`).join(' ');
  const ht = (s) => `推${st.hitType[s][1]} 扣${st.hitType[s][2]} 低${st.hitType[s][3]}`;
  const sd = (s) => (st.smashIn[s] ? `${st.smashReturned[s]}/${st.smashIn[s]}` : '0/0');
  return `[${label}] ${st.score[0]}:${st.score[1]} 击球=${st.hits} 红[${ht(0)}] 蓝[${ht(1)}] 接扣杀红=${sd(0)} 蓝=${sd(1)} 最长回合=${st.maxRally}${st.deuceSeen ? ' 抢七' : ''}${st.nan ? ' NaN!' : ''}${reasonStr ? ' 原因[' + reasonStr + ']' : ''}`;
}

// 多种子取平均：打印每局 + 平均分（"≈11:5" 式目标可稳定复现）
function runSeeds(lvlA, lvlB, n = 6, maxSteps = 120 * 600) {
  let sa = 0, sb = 0, done = 0;
  console.log(`--- ${LVL_NAME[lvlA]} vs ${LVL_NAME[lvlB]}（${n} 局多种子） ---`);
  for (let k = 0; k < n; k++) {
    const st = runMatch({ lvlA, lvlB, seed: 20260802 + k * 1000, maxSteps });
    console.log(fmt(st, `#${k + 1}`));
    sa += st.score[0]; sb += st.score[1]; if (st.completed) done++;
  }
  console.log(`平均 ${(sa / n).toFixed(1)}:${(sb / n).toFixed(1)}（完成 ${done}/${n}）\n`);
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
    const p1 = e.players[1];
    if (e.phase === 'play' && !e.ball.inHand && st.injected < nInj && i - injectedTick > 240 &&
        !p1.stroke.active && p1.hitCd <= 0) {
      const p = e.players[1];
      e.ball.pos = { x: p.x, y: 0.30, z: p.z + p.facing * 0.15 };
      e.ball.vel = { x: 0, y: 0.2, z: -p.facing * 1.0 };
      e.ball.spin = { x: 0, y: 0, z: 0 };
      e.ball.hitBy = 0; e.ball.lastBounce = 0;
      e.mayHit = [false, true];
      st.injected++; injectedTick = i; pressThisBall = false;
    }
  }
  st.missed = st.injected - st.caught;
  return st;
}

console.log('=== 乒乓对决 · 模拟球赛（AI 难度平衡 + 扣杀机制） ===\n');

const argv = process.argv.slice(2);
if (argv.length >= 2) {
  // 自定义对阵：node tools/sim-match.js <lvlA> <lvlB> [种子数]
  const n = argv[2] ? +argv[2] : 6;
  runSeeds(+argv[0], +argv[1], n);
} else {
  runSeeds(3, 3, 3);                       // 地狱vs地狱（确定性回归）
  runSeeds(3, 2, 6);                       // 地狱vs困难 → 目标 ≈ 11:5
  runSeeds(2, 1, 6);                       // 困难vs中等 → 目标 ≈ 11:6
  runSeeds(2, 0, 3);                       // 困难vs简单（阶梯观察）
  const without = runLowBallInjection({ crouchSide1: false });
  const withC = runLowBallInjection({ crouchSide1: true });
  console.log(`[低球注入 纯AI]   注入=${without.injected} 接住=${without.caught} 漏接=${without.missed}`);
  console.log(`[低球注入 蹲伏AI] 注入=${withC.injected} 接住=${withC.caught} 漏接=${withC.missed}`);
}
console.log('\n=== 结束 ===');
