/* 临时诊断：地狱快球预判 —— 高速球打向地狱 AI，能否接住 */
const TT = require('../public/js/engine.js');
const AIC = require('../public/js/ai.js');
const DT = 1 / 120;

function tryCatch(ballY, ballZ, velZ, label) {
  const e = TT.createEngine();
  e.phase = 'play'; e.serveStage = 'rally';
  e.mayHit = [true, true];
  e.ball.inHand = false;
  e.ball.pos = { x: 0, y: ballY, z: ballZ };
  e.ball.vel = { x: 0, y: -0.5, z: velZ };
  e.ball.spin = { x: 0, y: 0, z: 0 };
  e.ball.hitBy = 0; e.ball.lastBounce = 0;
  let hit = false, swung = false;
  for (let i = 0; i < 60; i++) {
    AIC.control(e, 1, DT, 3); // 地狱 AI side1 接球
    TT.step(e, DT);
    if (e.ball.hitBy === 1) { hit = true; break; }
    if (e.players[1].stroke.active) swung = true;
    if (e.phase !== 'play') break;
  }
  console.log(label, '-> hit', hit, 'swung', swung, 'phase', e.phase);
}

// 各类快球
tryCatch(1.35, -0.5, 18, '高球快攻(18m/s,y1.35)');
tryCatch(1.10, -0.5, 18, '中高快攻(18m/s,y1.10)');
tryCatch(1.35, -0.5, 22, '扣球级(22m/s,y1.35)');
tryCatch(1.10, -0.5, 22, '扣球级(22m/s,y1.10)');
tryCatch(0.95, -0.5, 22, '低快球(22m/s,y0.95 需蹲)');
tryCatch(0.85, -0.5, 22, '低快球(22m/s,y0.85 需蹲)');
tryCatch(1.10, -0.9, 18, '远距快攻(18m/s,y1.10,z-0.9)');

// 对照：困难（无预判）接同球
function tryCatchLv(level, ballY, velZ, label) {
  const e = TT.createEngine();
  e.phase = 'play'; e.serveStage = 'rally';
  e.mayHit = [true, true];
  e.ball.inHand = false;
  e.ball.pos = { x: 0, y: ballY, z: -0.5 };
  e.ball.vel = { x: 0, y: -0.5, z: velZ };
  e.ball.spin = { x: 0, y: 0, z: 0 };
  e.ball.hitBy = 0; e.ball.lastBounce = 0;
  let hit = false, swung = false;
  for (let i = 0; i < 60; i++) {
    AIC.control(e, 1, DT, level);
    TT.step(e, DT);
    if (e.ball.hitBy === 1) { hit = true; break; }
    if (e.players[1].stroke.active) swung = true;
    if (e.phase !== 'play') break;
  }
  console.log(label, '-> hit', hit, 'swung', swung);
}
tryCatchLv(2, 1.35, 18, '困难(无预判) 高快攻 18m/s');
tryCatchLv(2, 1.35, 22, '困难(无预判) 扣球级 22m/s');
