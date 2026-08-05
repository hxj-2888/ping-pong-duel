/* 临时对比：地狱强化前后 AI vs AI 表现（同场次、同种子） */
'use strict';
const TT = require('../public/js/engine.js');
const AICnew = require('../public/js/ai.js');
const AICold = require('../public/js/_old_ai.js');
const STEP = 1 / 120;
const LVL = ['简单', '中等', '困难', '地狱'];

function runMatch(AIC, lvlA, lvlB, maxSteps = 120 * 600) {
  const e = TT.createEngine();
  const st = { score: [0, 0], points: 0, hits: 0, serves: 0, reasons: {}, maxRally: 0, rallyHits: 0, deuce: false, completed: false, steps: 0 };
  for (let i = 0; i < maxSteps; i++) {
    AIC.control(e, 0, STEP, lvlA);
    AIC.control(e, 1, STEP, lvlB);
    TT.step(e, STEP);
    for (const ev of e.events) {
      if (ev.c === 'hit') { st.hits++; st.rallyHits++; }
      else if (ev.c === 'serve') st.serves++;
      else if (ev.c === 'point') {
        st.points++; st.score = [e.score[0], e.score[1]];
        st.reasons[e.pointReason] = (st.reasons[e.pointReason] || 0) + 1;
        st.maxRally = Math.max(st.maxRally, st.rallyHits); st.rallyHits = 0;
        if (e.score[0] >= 10 && e.score[1] >= 10) st.deuce = true;
      } else if (ev.c === 'let') st.reasons.let = (st.reasons.let || 0) + 1;
    }
    e.events.length = 0;
    st.steps = i + 1;
    if (e.phase === 'over') { st.completed = true; st.score = [e.score[0], e.score[1]]; break; }
  }
  return st;
}

function fmt(st) {
  const r = Object.keys(st.reasons).map((k) => `${k}:${st.reasons[k]}`).join(' ');
  return `完成=${st.completed} 比分=${st.score[0]}:${st.score[1]} 局点=${st.points} 击球=${st.hits} 最长回合=${st.maxRally} 抢七=${st.deuce} [${r}]`;
}

const cases = [[3, 2], [3, 1], [3, 3], [2, 3], [1, 3], [2, 2]];
console.log('=== 旧地狱 vs 新地狱（同场次） ===');
for (const [a, b] of cases) {
  const o = runMatch(AICold, a, b);
  const n = runMatch(AICnew, a, b);
  console.log(`${LVL[a]} vs ${LVL[b]}:`);
  console.log(`  旧: ${fmt(o)}`);
  console.log(`  新: ${fmt(n)}`);
}
