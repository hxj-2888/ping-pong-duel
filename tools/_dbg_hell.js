/* 临时诊断：地狱 24 回球的低球占比 + 发球速度对比 */
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
let aiHits = 0, aiLow = 0, aiSmash = 0, aiPush = 0;
for (let i = 0; i < 120000; i++) {
  if (e.phase === 'serve' && e.server === 0 && e.ball.inHand && e.players[0].hitCd <= 0) hold[0] = 12;
  const want = e.phase === 'play' && e.mayHit[0] && ballNear(0) && aiHits < 24;
  if (want && !wasWanting[0]) hold[0] = 45;
  wasWanting[0] = want;
  TT.setInput(e, 0, { pu: hold[0] > 0 });
  hold[0] = Math.max(0, hold[0] - 1);
  AIC.control(e, 1, DT, 3);
  const before = e.rallyCount;
  TT.step(e, DT);
  if (e.rallyCount > before && e.ball.hitBy === 1) {
    aiHits++;
    const tp = e.players[1].stroke.type;
    if (tp === 3) aiLow++;
    else if (tp === 2) aiSmash++;
    else aiPush++;
  }
  if (aiHits >= 24) break;
}
console.log(`24回球: 低平快球=${aiLow} 扣球=${aiSmash} 推球=${aiPush}`);

// 发球速度对比：地狱 vs 困难（同一站位）
function serveSpeed(lv) {
  const e2 = TT.createEngine();
  e2.server = 1; e2.startServer = 1;
  e2.ball.pos = { x: 0, y: 1.0, z: e2.players[1].z + e2.players[1].facing * 0.22 };
  for (let i = 0; i < 2400; i++) {
    AIC.control(e2, 1, DT, lv);
    TT.step(e2, DT);
    if (e2.phase === 'play') return Math.hypot(e2.ball.vel.x, e2.ball.vel.y, e2.ball.vel.z);
  }
  return -1;
}
console.log('发球速度 地狱=' + serveSpeed(3).toFixed(2) + ' 困难=' + serveSpeed(2).toFixed(2));
