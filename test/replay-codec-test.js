/* 赛后回放编解码测试：TT.snapshot → encodeSnap → decodeSnap 往返一致
 * 覆盖：对打快照（含球）、发球快照（含持球/发球方案）、终局快照（含事件）、压缩取整误差
 */
'use strict';

const TT = require('../public/js/engine.js');
const { encodeSnap, decodeSnap } = require('../public/js/app/replay.js');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}
const close = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-3 : eps);

// 1. 对打快照往返
{
  const e = TT.createEngine();
  e.phase = 'play';
  e.ball.inHand = false;
  e.ball.pos = { x: 0.3, y: 0.85, z: -0.2 };
  e.ball.vel = { x: 1.2, y: -0.5, z: 3.4 };
  e.ball.spin = { x: 30.5, y: 0, z: -12.3 };
  e.players[0].x = 0.42; e.players[0].z = -1.2; e.players[0].crouch = 0;
  e.players[1].x = -0.18; e.players[1].z = 1.05; e.players[1].crouch = 1;
  e.score = [5, 3]; e.server = 1;
  const snap = TT.snapshot(e);
  const dec = decodeSnap(encodeSnap(snap));
  check('对打：t/ph/比分/发球方一致', dec.t === snap.t && dec.ph === snap.ph &&
    dec.sc[0] === 5 && dec.sc[1] === 3 && dec.sv === 1);
  check('对打：球位置/速度/旋转往返（取整误差内）',
    close(dec.b[0], 0.3) && close(dec.b[1], 0.85) && close(dec.b[2], -0.2) &&
    close(dec.b[3], 1.2) && close(dec.b[4], -0.5) && close(dec.b[5], 3.4) &&
    close(dec.b[6], 30.5, 0.11) && close(dec.b[8], -12.3, 0.11));
  check('对打：双方站位/蹲姿往返', close(dec.p[0].x, 0.42) && close(dec.p[0].z, -1.2) &&
    close(dec.p[1].x, -0.18) && close(dec.p[1].z, 1.05) && dec.p[1].cq === 1);
  check('对打：挥拍/球拍位置往返', Array.isArray(dec.p[0].pc) && dec.p[0].pc.length === 3 &&
    Array.isArray(dec.p[0].st) && dec.p[0].st.length === 3);
  check('对打：无持球/无发球方案', dec.bh === null && dec.sp === null);
}

// 2. 发球快照（持球 + 发球方案 + 事件）往返
{
  const e = TT.createEngine();
  e.phase = 'serve';
  e.ball.inHand = true;
  e.server = 0;
  e.players[0].servePlan = {
    vel: { x: 0.2, y: 2.1, z: 4.0 },
    spin: { x: -35.2, y: 0, z: 0 },
  };
  e.players[0].serveAimBlocked = false;
  e.events.push({ t: e.t, c: 'serve-ready', s: 0 });
  e.events.push({ t: e.t, c: 'hit', s: 1 });
  const snap = TT.snapshot(e);
  const dec = decodeSnap(encodeSnap(snap));
  check('发球：持球位置往返', dec.bh !== null && close(dec.bh[0], snap.bh[0]) && close(dec.bh[1], snap.bh[1]));
  check('发球：发球方案往返', dec.sp !== null && close(dec.sp[0], 0.2) && close(dec.sp[1], 2.1) &&
    close(dec.sp[2], 4.0) && close(dec.sp[3], -35.2, 0.11));
  check('发球：事件往返（serve-ready/hit）', dec.ev.some((ev) => ev.c === 'serve-ready') &&
    dec.ev.some((ev) => ev.c === 'hit'));
  check('发球：无飞行球', dec.b === null);
}

// 3. 终局快照（over 事件 + 比分）往返
{
  const e = TT.createEngine();
  e.phase = 'over';
  e.score = [11, 9];
  e.events.push({ t: e.t, c: 'over', s: 0 });
  const snap = TT.snapshot(e);
  const dec = decodeSnap(encodeSnap(snap));
  check('终局：phase/比分/事件', dec.ph === 3 && dec.sc[0] === 11 && dec.sc[1] === 9 &&
    dec.ev.some((ev) => ev.c === 'over' && ev.s === 0));
}

// 4. 60Hz 连续快照体积（约 3 分钟比赛应在合理范围内）
{
  const e = TT.createEngine();
  let total = 0;
  for (let i = 0; i < 600; i++) {
    TT.setInput(e, 0, { l: i % 3 === 0 ? 1 : 0, r: i % 2 === 0 ? 1 : 0, pu: i % 97 === 0 ? 1 : 0, crouch: i % 50 === 0 ? 1 : 0 });
    TT.setInput(e, 1, { l: i % 2 === 0 ? 0 : 1, r: 0, pu: i % 89 === 0 ? 1 : 0 });
    TT.step(e, 1 / 120);
    total += JSON.stringify(encodeSnap(TT.snapshot(e))).length;
  }
  const bytesPerFrame = total / 600;
  const est3min = Math.round(bytesPerFrame * 60 * 180);
  check(`压缩效率：单帧约 ${bytesPerFrame.toFixed(0)}B，3 分钟约 ${(est3min / 1024 / 1024).toFixed(1)}MB`, bytesPerFrame < 420);
}

console.log(failures === 0 ? '\n回放编解码测试全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
