/* 临时诊断：地狱 AI 决策 vs 实际回球类型（区分 lowThisBall 决策 / 引擎 fallback / 挥空） */
const TT = require('../public/js/engine.js');
const AIC = require('../public/js/ai.js');
const DT = 1 / 120;

const e = TT.createEngine();
const hold = [0, 0];
const wasWanting = [false, false];
const ballNear = (side) => {
  const p = e.players[side], b = e.ball;
  if (b.inHand) return false;
  const zc = p.z + p.facing * 0.42;
  return Math.hypot(b.pos.x - p.x, b.pos.z - zc) < 1.0 && b.pos.y > 0.80 && b.pos.y < 1.45;
};
// 与 ai.js predictCrossing 相同算法（探针复刻，读决策瞬间的 cross 值）
function predictCrossing(ball, zc, maxT) {
  const steps = Math.ceil(maxT / 0.02);
  let prevZ = ball.pos.z;
  let prevPos = ball.pos;
  for (let i = 1; i <= steps; i++) {
    const t = i * 0.02;
    const p = TT.predictBall(ball, t);
    if ((prevZ - zc) * (p.z - zc) <= 0) {
      const f = Math.abs(p.z - zc) / (Math.abs(p.z - zc) + Math.abs(prevZ - zc) + 1e-9);
      return { t: t - 0.02 * f, x: prevPos.x + (p.x - prevPos.x) * (1 - f), y: prevPos.y + (p.y - prevPos.y) * (1 - f) };
    }
    prevZ = p.z;
    prevPos = p;
  }
  return null;
}

// 决策统计
const dec = { lp: 0, sm: 0, pu: 0 };
// 命中后实际类型（记录 AI 侧每次成功回球）
const hitType = { 1: 0, 2: 0, 3: 0 };
let pressedThisBall = false, ballPressType = -1, aiHits = 0;
const seen = new Set();
// 起手决策细节采样（前 8 次）
const decSamples = [];
for (let i = 0; i < 120000; i++) {
  if (e.phase === 'serve' && e.server === 0 && e.ball.inHand && e.players[0].hitCd <= 0) hold[0] = 12;
  const want = e.phase === 'play' && e.mayHit[0] && ballNear(0) && aiHits < 24;
  if (want && !wasWanting[0]) hold[0] = 45;
  wasWanting[0] = want;
  TT.setInput(e, 0, { pu: hold[0] > 0 });
  hold[0] = Math.max(0, hold[0] - 1);

  const inp = AIC.control(e, 1, DT, 3);
  // 本帧 AI 起手决策（lp/sm/pu 上升沿）
  if (!pressedThisBall) {
    if (inp.lp) { dec.lp++; ballPressType = 3; pressedThisBall = true; }
    else if (inp.sm) { dec.sm++; ballPressType = 2; pressedThisBall = true; }
    else if (inp.pu) { dec.pu++; ballPressType = 1; pressedThisBall = true; }
    if (inp.lp || inp.sm || inp.pu) {
      const b = e.ball;
      const zc = e.players[1].z + e.players[1].facing * 0.42;
      const cr = predictCrossing(b, zc, 1.4);
      const cn = !!(cr && cr.t < 0.14);
      decSamples.push(`y=${b.pos.y.toFixed(2)} vy=${b.vel.y.toFixed(2)} 估=${(b.pos.y + b.vel.y * 0.08).toFixed(2)} cross.t=${cr ? cr.t.toFixed(2) : 'null'} cross.y=${cr ? cr.y.toFixed(2) : 'null'} cn=${cn} 判定y=${cn && cr ? cr.y.toFixed(2) : (b.pos.y + b.vel.y * 0.08).toFixed(2)} dec=${inp.lp ? 'lp' : inp.sm ? 'sm' : 'pu'}`);
    }
  }

  const before = e.rallyCount;
  TT.step(e, DT);
  if (e.rallyCount > before && e.ball.hitBy === 1) {
    aiHits++;
    const tp = e.players[1].stroke.type;
    hitType[tp]++;
    if (ballPressType === 3 && tp !== 3) seen.add('LP决策→结果type' + tp);
  }
  if (!inp.lp && !inp.sm && !inp.pu) pressedThisBall = false;
  if (aiHits >= 24) break;
}
console.log(`决策: lp=${dec.lp} sm=${dec.sm} pu=${dec.pu}`);
console.log(`命中类型: type1推=${hitType[1]} type2扣=${hitType[2]} type3低=${hitType[3]}`);
console.log(`LP决策但命中非type3: ${[...seen].join(',') || '无'}`);
console.log('起手决策采样（前8次）:'); decSamples.slice(0, 8).forEach((s) => console.log('  ' + s));
