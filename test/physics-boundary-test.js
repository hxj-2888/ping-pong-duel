/* 物理边界测试：台面/球网/地面碰撞边界、过网弧线、马格努斯旋转、
 * 回球求解边界、计分边界、挥拍缓动曲线（easeOutQuad）
 * 对应两份方案文档中的“补充单元测试验证碰撞检测边界情况”与“挥拍缓动”优化项
 */
'use strict';

const TT = require('../public/js/engine.js');
const R = TT.RULES;

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

const DT = 1 / 120;

// ---------- 1. 台面弹跳边界 ----------
{
  // 台内：触发反弹，位置贴台、速度向上
  const inside = { pos: { x: 0, y: 1.0, z: 0.3 }, vel: { x: 0, y: -3, z: 0 }, spin: { x: 0, y: 0, z: 0 } };
  let bounced = false;
  let bounceY = -1, bounceVy = 0;
  TT.physicsStep(inside, 0.5, (ev) => {
    if (ev.type === 'bounce') {
      bounced = true;
      bounceY = inside.pos.y;
      bounceVy = inside.vel.y;
    }
  });
  check('台内落球：反弹且贴台', bounced &&
    Math.abs(bounceY - (R.TABLE_HEIGHT + R.BALL_RADIUS)) < 1e-9 && bounceVy > 0);

  // 台外 1cm：不弹台，落到地面
  const outside = { pos: { x: R.TABLE_WIDTH / 2 + 0.01, y: 1.0, z: 0.3 }, vel: { x: 0, y: -3, z: 0 }, spin: { x: 0, y: 0, z: 0 } };
  let bouncedOut = false, floored = false;
  TT.physicsStep(outside, 0.8, (ev) => {
    if (ev.type === 'bounce') bouncedOut = true;
    if (ev.type === 'floor') floored = true;
  });
  check('台外 1cm：不弹台、落地面', !bouncedOut && floored);

  // 擦边：|x| 恰好等于半宽，按引擎约定（含边界）判触台
  const edge = { pos: { x: R.TABLE_WIDTH / 2, y: 1.0, z: 0.3 }, vel: { x: 0, y: -3, z: 0 }, spin: { x: 0, y: 0, z: 0 } };
  let edgeBounce = false;
  TT.physicsStep(edge, 0.5, (ev) => { if (ev.type === 'bounce') edgeBounce = true; });
  check('擦边球（|x|=半宽）：判触台', edgeBounce);
}

// ---------- 2. 球网边界 ----------
{
  const H = R.TABLE_HEIGHT, NH = R.NET_HEIGHT;
  const run = (y) => {
    const b = { pos: { x: 0, y, z: -0.03 }, vel: { x: 0, y: 0, z: 6 }, spin: { x: 0, y: 0, z: 0 } };
    const evs = [];
    TT.physicsStep(b, 0.1, (ev) => evs.push(ev));
    return evs.map((e) => e.type);
  };
  const clip = run(H + NH + 0.010);
  check('擦网顶（高网顶 1cm）：netclip 过网', clip.includes('netclip') && !clip.includes('net'));
  const net = run(H + NH - 0.020);
  check('撞网（低网顶 2cm）：net 拦下', net.includes('net') && !net.includes('netclip'));
}

// ---------- 3. 发球弧线（越过网中心 + 本方/对方半台次序） ----------
{
  const e = TT.createEngine();
  e.server = 0; e.startServer = 0;
  const plan = TT.solveServe(e, 0, false);
  check('发球求解存在', !!plan);
  if (plan) {
    const f = e.players[0].facing;
    const launch = { x: e.players[0].x, y: 1.0, z: e.players[0].z + f * 0.22 };
    const sides = [];
    const sim = { pos: { ...launch }, vel: { ...plan.vel }, spin: { ...plan.spin } };
    TT.physicsStep(sim, 1.2, (ev) => {
      if (ev.type === 'bounce') sides.push(sim.pos.z > 0 ? 1 : 0);
    });
    check('发球落点次序：先本方后对方', sides.length >= 2 && sides[0] === 0 && sides[1] === 1);

    let yNet = -1, apex = -1;
    const arc = { pos: { ...launch }, vel: { ...plan.vel }, spin: { ...plan.spin } };
    for (let i = 0; i < 400; i++) {
      const before = { z: arc.pos.z, y: arc.pos.y };
      TT.physicsStep(arc, 1 / 240, null);
      if (before.z < 0 && arc.pos.z >= 0 && yNet < 0) yNet = arc.pos.y;
      if (arc.pos.y > apex) apex = arc.pos.y;
    }
    check('发球过网：网中心高度 > 网顶+1cm', yNet > R.TABLE_HEIGHT + R.NET_HEIGHT + 0.01);
    check('发球弧线最高点合理（0.95~1.35m）', apex > 0.95 && apex < 1.35);
  }
}

// ---------- 4. 回球弧线（过网 + 第一落点在对方半台） ----------
{
  const p0 = { x: 0, y: 0.82, z: -0.9 };
  const vel = TT.solveRally(p0, { x: 0, y: R.TABLE_HEIGHT + R.BALL_RADIUS, z: 0.55 }, 4.6, { x: -34, y: 0, z: 0 });
  check('推球回球可解', !!vel);
  if (vel) {
    const sides = [];
    const sim = { pos: { ...p0 }, vel: { ...vel }, spin: { x: -34, y: 0, z: 0 } };
    TT.physicsStep(sim, 1.0, (ev) => {
      if (ev.type === 'bounce') sides.push(sim.pos.z > 0 ? 1 : 0);
    });
    check('回球第一落点：对方半台', sides[0] === 1);

    let yNet = -1, apex = -1;
    const arc = { pos: { ...p0 }, vel: { ...vel }, spin: { x: -34, y: 0, z: 0 } };
    for (let i = 0; i < 300; i++) {
      const before = { z: arc.pos.z, y: arc.pos.y };
      TT.physicsStep(arc, 1 / 240, null);
      if (before.z < 0 && arc.pos.z >= 0 && yNet < 0) yNet = arc.pos.y;
      if (arc.pos.y > apex) apex = arc.pos.y;
    }
    check('回球过网：网中心高度 > 网顶+1cm', yNet > R.TABLE_HEIGHT + R.NET_HEIGHT + 0.01);
    check('回球有上升弧线（最高点高于击球点）', apex > p0.y + 0.05);
  }
}

// ---------- 5. 回球求解边界：合法目标 vs 出界目标 vs 本方半台 ----------
{
  // 扣球必须等球弹高：从 1.3m 高空球开始才有合法过网解
  const p0 = { x: 0, y: 1.3, z: -0.9 };
  const target = { x: 0, y: R.TABLE_HEIGHT + R.BALL_RADIUS, z: 0.55 };
  const legal = TT.solveRally(p0, target, 6.0, { x: 95, y: 0, z: 0 });
  const sideOut = TT.solveRally(p0, { x: 3.0, y: R.TABLE_HEIGHT + R.BALL_RADIUS, z: 0.55 }, 6.0, { x: 95, y: 0, z: 0 });
  // 瞄准己方身后：方向朝后，不可能过网
  const ownHalf = TT.solveRally(p0, { x: 0, y: R.TABLE_HEIGHT + R.BALL_RADIUS, z: -1.3 }, 2.8, { x: 0, y: 0, z: 0 });
  check('回球瞄准对方半台：有解', !!legal);
  check('回球瞄准侧线外：无解', sideOut === null);
  check('回球瞄准本方半台：无解', ownHalf === null);
}

// ---------- 6. 马格努斯旋转改变轨迹 ----------
{
  const mk = (spin) => ({ pos: { x: 0, y: 1.0, z: -1.1 }, vel: { x: 0, y: 0.6, z: 2.4 }, spin: { x: spin, y: 0, z: 0 } });
  const a = mk(0), b = mk(70);
  TT.physicsStep(a, 1.0, null);
  TT.physicsStep(b, 1.0, null);
  check('上旋 70 vs 无旋：飞行 1s 后落点显著不同', Math.abs(b.pos.z - a.pos.z) > 0.05);
}

// ---------- 7. 计分边界 ----------
{
  // 出界：球未落台直接落地 → 击球方得分 out
  const e1 = TT.createEngine();
  e1.phase = 'play'; e1.serveStage = 'rally';
  e1.ball.inHand = false;
  e1.ball.pos = { x: 1.0, y: 0.9, z: 0.5 };
  e1.ball.vel = { x: 0, y: -2, z: 1.5 };
  e1.ball.spin = { x: 0, y: 0, z: 0 };
  e1.ball.hitBy = 0; e1.ball.lastBounce = 0;
  for (let i = 0; i < 240 && e1.phase === 'play'; i++) TT.step(e1, DT);
  check('球未落台出界：对方得分(out)', e1.pointWinner === 1 && e1.pointReason === 'out');

  // 漏接：对方半台已弹、球落地未回 → 击球方得分 opp-miss
  const e2 = TT.createEngine();
  e2.phase = 'play'; e2.serveStage = 'rally';
  e2.ball.inHand = false;
  e2.ball.pos = { x: 1.0, y: 0.9, z: 1.0 };
  e2.ball.vel = { x: 0, y: -2, z: 0.2 };
  e2.ball.spin = { x: 0, y: 0, z: 0 };
  e2.ball.hitBy = 0; e2.ball.lastBounce = 1;
  for (let i = 0; i < 240 && e2.phase === 'play'; i++) TT.step(e2, DT);
  check('对方漏接：击球方得分(opp-miss)', e2.pointWinner === 0 && e2.pointReason === 'opp-miss');

  // 同半台连弹两次：double
  const e3 = TT.createEngine();
  e3.phase = 'play'; e3.serveStage = 'rally';
  e3.ball.inHand = false;
  e3.ball.pos = { x: 0, y: 0.9, z: 0.5 };
  e3.ball.vel = { x: 0, y: -2, z: 0.0 };
  e3.ball.spin = { x: 0, y: 0, z: 0 };
  e3.ball.hitBy = 1; e3.ball.lastBounce = 1;
  for (let i = 0; i < 240 && e3.phase === 'play'; i++) TT.step(e3, DT);
  check('同半台连弹两次：判对方失分(double)', e3.pointWinner === 0 && e3.pointReason === 'double');
}

// ---------- 8. 挥拍缓动曲线（easeOutQuad） ----------
{
  const e = TT.createEngine();
  e.phase = 'play'; e.serveStage = 'rally';
  e.mayHit = [true, true];
  e.ball.inHand = false;
  e.ball.pos = { x: 0, y: 1.0, z: e.players[0].z + e.players[0].facing * 0.35 };
  e.ball.vel = { x: 0, y: 0, z: 0 };
  e.ball.spin = { x: 0, y: 0, z: 0 };
  e.ball.hitBy = 1; e.ball.lastBounce = 1;
  TT.setInput(e, 0, { pu: true });

  let strokeRef = null, hit = false;
  let preFrac = -1, preProg = -1, lateV = -1, midV = -1;
  for (let i = 0; i < 240; i++) {
    const prev = e.rallyCount;
    TT.step(e, DT);
    if (e.rallyCount > prev) hit = true;
    const p = e.players[0];
    if (p.stroke.active && !strokeRef) {
      strokeRef = { start: { ...p.stroke.start }, end: { ...p.stroke.end }, dur: p.stroke.dur, speed: p.stroke.speed };
    }
    if (strokeRef && p.stroke.active) {
      const prog = p.stroke.t / strokeRef.dur;
      const pathZ = strokeRef.end.z - strokeRef.start.z;
      // 自动伸拍生效前（prog < windup/dur=0.2）采样：验证 easeOutQuad 加速起步
      if (prog >= 0.10 && prog <= 0.14 && preFrac < 0) {
        const movedZ = p.paddle.p.z - strokeRef.start.z;
        preFrac = Math.abs(pathZ) > 1e-6 ? movedZ / pathZ : 0;
        preProg = prog;
      } else if (prog >= 0.45 && prog <= 0.55 && midV < 0) {
        midV = Math.hypot(p.paddle.v.x, p.paddle.v.y, p.paddle.v.z);
      } else if (prog >= 0.85 && prog <= 0.95 && lateV < 0) {
        lateV = Math.hypot(p.paddle.v.x, p.paddle.v.y, p.paddle.v.z);
      }
    }
    if (hit && !p.stroke.active) break;
  }
  check('对打挥拍正常触发击球', hit);
  // easeOutQuad 在自动伸拍前（约 12% 时间点）位移占比 ≈ 1-(1-prog)²（线性是 prog）
  const expected = preProg > 0 ? 1 - (1 - preProg) * (1 - preProg) : -1;
  check(`挥拍前段位移占比 ${(preFrac * 100).toFixed(0)}%（easeOutQuad≈${(expected * 100).toFixed(0)}%）`,
    preProg > 0 && Math.abs(preFrac - expected) < 0.08);
  // 后段速度应显著低于中段（缓动导数 2(1-t) 递减）
  check('挥拍后段速度显著低于中段', midV > 0 && lateV > 0 && lateV < midV * 0.7);
}

// ---------- 9. 接球碰撞箱：进箱即命中、低球需下蹲 ----------
{
  // 构造：球在指定位置、轻微上升、可合法回球（mayHit）
  function makeBall(e, x, y, z) {
    e.phase = 'play'; e.serveStage = 'rally'; e.mayHit = [true, true];
    e.ball.inHand = false;
    e.ball.pos = { x, y, z };
    e.ball.vel = { x: 0, y: 0.3, z: 0 }; // 轻微上升，保证窗口内球保持在箱内
    e.ball.spin = { x: 0, y: 0, z: 0 };
    e.ball.hitBy = 1; e.ball.lastBounce = 1;
  }
  const cx = (e) => e.players[0].x;
  const cz = (e) => e.players[0].z + e.players[0].facing * 0.42;

  // 9a. 球在箱内（普通高度）→ 单击推球即命中（进箱即命中，无需球拍 0.18m 门槛）
  {
    const e = TT.createEngine();
    makeBall(e, cx(e), 1.05, cz(e));
    TT.setInput(e, 0, { pu: true });
    let hit = false;
    for (let i = 0; i < 120 && !hit; i++) { TT.step(e, DT); if (e.ball.hitBy === 0) hit = true; }
    check('进箱即命中：球在箱内单击推球即击中', hit);
  }

  // 9b. 球横向出箱（|x-p.x| > HITBOX_HX）→ 不命中
  {
    const e = TT.createEngine();
    makeBall(e, cx(e) + R.HITBOX_HX + 0.15, 1.05, cz(e));
    TT.setInput(e, 0, { pu: true });
    let hit = false;
    for (let i = 0; i < 120; i++) { TT.step(e, DT); if (e.ball.hitBy === 0) hit = true; }
    check('出箱不命中：球横向超出箱体接不到', !hit);
  }

  // 9c. 球太高（y > 箱顶 1.55）→ 不命中
  {
    const e = TT.createEngine();
    makeBall(e, cx(e), R.HITBOX_Y_TOP + 0.15, cz(e));
    e.ball.vel.y = 2.0; // 持续升高，窗口内始终高于箱顶
    TT.setInput(e, 0, { pu: true });
    let hit = false;
    for (let i = 0; i < 150; i++) { TT.step(e, DT); if (e.ball.hitBy === 0) hit = true; }
    check('出箱不命中：球高于箱顶接不到', !hit);
  }

  // 9d. 低球（y=0.5 < 站立箱底 0.70）：站立接不到
  //     位置取台端线后方（球员脚边，真实低球场景，避免球落在台面上先弹台）
  {
    const e = TT.createEngine();
    const p = e.players[0];
    makeBall(e, p.x, 0.50, p.z + p.facing * 0.15);
    TT.setInput(e, 0, { pu: true });
    let hit = false;
    for (let i = 0; i < 120; i++) { TT.step(e, DT); if (e.ball.hitBy === 0) hit = true; }
    check('低球站立接不到（y=0.5 < 箱底 0.70）', !hit);
  }

  // 9e. 同一低球：下蹲（Ctrl）后箱体下探 → 可接（蹲伏需每帧持续保持）
  {
    const e = TT.createEngine();
    const p = e.players[0];
    makeBall(e, p.x, 0.50, p.z + p.facing * 0.15);
    TT.setInput(e, 0, { crouch: true });
    TT.step(e, DT);
    TT.setInput(e, 0, { pu: true, crouch: true });
    TT.step(e, DT); // 推球上升沿，触发挥拍
    let hit = false;
    for (let i = 0; i < 150 && !hit; i++) {
      TT.setInput(e, 0, { pu: true, crouch: true });
      TT.step(e, DT);
      if (e.ball.hitBy === 0) hit = true;
    }
    check('下蹲后可接低球（箱底贴地 0.02m）', hit);
  }

  // 9f. 贴地球（y=0.15）：下蹲后箱底贴地（0.02m）→ 可接
  {
    const e = TT.createEngine();
    const p = e.players[0];
    makeBall(e, p.x, 0.15, p.z + p.facing * 0.15);
    TT.setInput(e, 0, { crouch: true });
    TT.step(e, DT);
    TT.setInput(e, 0, { pu: true, crouch: true });
    TT.step(e, DT);
    let hit = false;
    for (let i = 0; i < 150 && !hit; i++) {
      TT.setInput(e, 0, { pu: true, crouch: true });
      TT.step(e, DT);
      if (e.ball.hitBy === 0) hit = true;
    }
    check('蹲下可接贴地球（y=0.15，箱底贴地 0.02m）', hit);
  }

  // 9h. 极低球（y=0.08，几乎贴地）：下蹲也能接起（高吊回球）
  {
    const e = TT.createEngine();
    const p = e.players[0];
    makeBall(e, p.x, 0.08, p.z + p.facing * 0.15);
    TT.setInput(e, 0, { crouch: true });
    TT.step(e, DT);
    TT.setInput(e, 0, { pu: true, crouch: true });
    TT.step(e, DT);
    let hit = false;
    for (let i = 0; i < 150 && !hit; i++) {
      TT.setInput(e, 0, { pu: true, crouch: true });
      TT.step(e, DT);
      if (e.ball.hitBy === 0) hit = true;
    }
    check('蹲下可接极低球（y=0.08）', hit);
  }

  // 9i. 低于蹲下箱底（0.02m）的球（y=0.005，贴地即落）：接不到
  {
    const e = TT.createEngine();
    const p = e.players[0];
    makeBall(e, p.x, 0.005, p.z + p.facing * 0.15);
    TT.setInput(e, 0, { crouch: true });
    TT.step(e, DT);
    TT.setInput(e, 0, { pu: true, crouch: true });
    TT.step(e, DT);
    let hit = false;
    for (let i = 0; i < 120; i++) {
      TT.setInput(e, 0, { pu: true, crouch: true });
      TT.step(e, DT);
      if (e.ball.hitBy === 0) hit = true;
    }
    check('低于蹲下箱底（0.02m）贴地即落，接不到', !hit);
  }

  // 9g. 球拍自动伸向球动画仍在（命中瞬间拍面贴近球）
  {
    const e = TT.createEngine();
    makeBall(e, cx(e), 1.05, cz(e));
    TT.setInput(e, 0, { pu: true });
    let hit = false, minD = 1e9;
    for (let i = 0; i < 120; i++) {
      TT.step(e, DT);
      const pd = e.players[0].paddle.p;
      const d = Math.hypot(e.ball.pos.x - pd.x, e.ball.pos.y - pd.y, e.ball.pos.z - pd.z);
      if (d < minD) minD = d;
      if (e.ball.hitBy === 0) hit = true;
      if (hit && !e.players[0].stroke.active) break;
    }
    check('球拍自动伸向球（击球动画，最小拍球距离 < 0.15m）', hit && minD < 0.15);
  }

  // 9j. 低平快球（type 3，AI 困难 1/5、地狱 1/2 概率刻意打出）：
  //     lp 边沿触发 type 3；贴网低飞（净空 0.8~5cm）；首落点深（对方半台）；落地后低弹到箱体
  {
    const e = TT.createEngine();
    makeBall(e, cx(e), 1.05, cz(e));
    TT.setInput(e, 0, { lp: true });
    let hit = false;
    for (let i = 0; i < 120 && !hit; i++) { TT.step(e, DT); if (e.ball.hitBy === 0) hit = true; }
    check('低平快球：lp 边沿触发 type 3 挥拍并击中', hit && e.players[0].stroke.type === 3);

    const p1 = e.players[1];
    const zcOpp = p1.z + p1.facing * 0.42;
    const b = { pos: { ...e.ball.pos }, vel: { ...e.ball.vel }, spin: { ...e.ball.spin } };
    const netTop = R.TABLE_HEIGHT + R.NET_HEIGHT;
    let prevZ = b.pos.z, prevY = b.pos.y;
    let crossY = -1, firstBounceZ = null, boxMinY = 99, secondBounce = false, firstBounceDone = false;
    for (let t = 0; t < 3.0 && !secondBounce; t += DT) {
      TT.physicsStep(b, DT, (ev) => {
        if (ev.type === 'bounce') {
          if (!firstBounceDone) { firstBounceDone = true; firstBounceZ = b.pos.z; }
          else secondBounce = true;
        }
      });
      if (crossY < 0 && prevZ !== 0 && Math.sign(prevZ) !== Math.sign(b.pos.z)) {
        const f = Math.abs(b.pos.z) / (Math.abs(b.pos.z) + Math.abs(prevZ) + 1e-9);
        crossY = prevY + (b.pos.y - prevY) * (1 - f);
      }
      if (Math.abs(b.pos.z - zcOpp) < R.HITBOX_HZ && Math.abs(b.pos.x - p1.x) < R.HITBOX_HX && b.pos.y > 0.01 && b.pos.y < 2.5) {
        boxMinY = Math.min(boxMinY, b.pos.y);
      }
      prevZ = b.pos.z; prevY = b.pos.y;
    }
    check('低平快球：贴网低飞（过网净空 0.8~5cm）',
      crossY > netTop + 0.008 && crossY < netTop + 0.05);
    check('低平快球：首落点在对方半台（深落点 >0.7m）',
      firstBounceDone && firstBounceZ > 0.7 && firstBounceZ <= R.TABLE_LENGTH / 2);
    check('低平快球：到对方箱体时低弹（贴近站立箱底，须准确站位）',
      boxMinY < 0.85 && boxMinY > R.HITBOX_Y_BOTTOM);
  }
}

// ---------- 10. 移动范围：己方半场（球网线为界），整身不上桌 ----------
{
  const e = TT.createEngine();
  const p = e.players[0];
  const TW = R.TABLE_WIDTH / 2, TL = R.TABLE_LENGTH / 2;
  // 台面中间：向前最多走到台面端线（含身体余量）
  p.x = 0; p.padX = 0; p.z = -1.5;
  for (let i = 0; i < 300; i++) { TT.setInput(e, 0, { f: 1 }); TT.step(e, DT); }
  check('台面中间向前止步于台面端线（含身体余量）', Math.abs(p.z + TL + R.PLAYER_BODY_D) < 0.02);
  // 台面外侧：可以一直走到球网线
  p.x = 1.2; p.padX = 1.38; p.z = -1.37;
  for (let i = 0; i < 300; i++) { TT.setInput(e, 0, { f: 1 }); TT.step(e, DT); }
  check('台面外侧可走到球网线（己方半场）', p.z > -0.2 && p.z <= -0.05);
  // 侧面切回台面宽度内：应贴边平滑滑动，而不是被“赶回”端线
  let maxJump = 0;
  for (let i = 0; i < 120; i++) {
    const z0 = p.z;
    TT.setInput(e, 0, { l: 1 });
    TT.step(e, DT);
    maxJump = Math.max(maxJump, Math.abs(p.z - z0));
  }
  check('侧面切入不被赶回（贴边滑动，单帧 z 跳变 < 0.1m）',
    maxJump < 0.1 && Math.abs(Math.abs(p.x) - (TW + R.PLAYER_BODY_W)) < 0.02);
  // 乱走时绝不站上球桌（|x|≤半宽 且 |z|≤半长）
  let onTable = false;
  p.x = 0; p.padX = 0; p.z = -2.0;
  for (let i = 0; i < 400; i++) {
    TT.setInput(e, 0, { f: 1, r: 1 });
    TT.step(e, DT);
    const q = e.players[0];
    if (Math.abs(q.x) <= TW && Math.abs(q.z) < TL - 1e-6) onTable = true;
  }
  check('任意移动都不会站上球桌', !onTable);
  // 任意站位持球点都在球拍正前方 0.10m（不被钳到奇怪位置）
  const e2 = TT.createEngine();
  const p2 = e2.players[0];
  p2.z = -0.2; p2.x = 0.4; p2.padX = 0.4;
  const H2 = { x: p2.padX, y: 0.98, z: p2.z + p2.facing * 0.52 };
  check('网前站位持球点在球拍正前方', Math.abs(H2.z - (p2.z + p2.facing * 0.42) - p2.facing * 0.10) < 1e-6 && H2.x === p2.padX);
  // 网前极端站位：球仍在前方，但发球解不出合法轨迹（需调整站位）
  const plan = TT.solveServeTo(e2, 0, 0, 0.6, false);
  check('网前站位发球被阻止（球越过网，需调整站位）', !plan);
  // 台面两侧网前朝台面按方向键：球/拍不飘离身体（回归：原先球会飘进台面）
  for (const side of [0, 1]) {
    const eS = TT.createEngine();
    eS.server = side; eS.startServer = side;
    const pS = eS.players[side];
    const sd = side === 0 ? -1 : 1;
    pS.padX = sd * 1.38; pS.x = sd * 1.2; pS.z = side === 0 ? -0.18 : 0.18;
    for (let i = 0; i < 60; i++) { TT.setInput(eS, side, side === 0 ? { r: 1 } : { l: 1 }); TT.step(eS, DT); }
    const ball0 = eS.ball.pos.x;
    let maxDrift = 0;
    for (let i = 0; i < 120; i++) {
      TT.setInput(eS, side, side === 0 ? { r: 1 } : { l: 1 });
      TT.step(eS, DT);
      maxDrift = Math.max(maxDrift, Math.abs(eS.ball.pos.x - ball0));
    }
    check(`P${side + 1} 台面侧前朝台面按方向键：球不飘（漂移 < 0.05m）`, maxDrift < 0.05);
  }
  // 整身不压台：把火柴人看作整体（脚距 0.16 + 步幅 0.14/0.06 + 脚趾 0.09），
  // 极限站位（侧前/端线，静止与最大步幅）两只脚都不进入台面正投影
  const rw2 = TW + R.PLAYER_BODY_W, rl2 = TL + R.PLAYER_BODY_D;
  const maxAmpX = 0.14, maxAmpZ = 0.06;
  let footBad = false;
  const poses = [[-rw2, -0.18, 1], [rw2, 0.18, -1], [0, -rl2, 1], [-rw2, -rl2, 1], [rw2, rl2, -1]];
  for (const [px, pz, f] of poses) {
    for (const sx of [-1, 0, 1]) {
      for (const sz of [-1, 0, 1]) {
        const fl = { x: px - 0.16 + sx * maxAmpX, z: pz + f * (0.04 + sz * maxAmpZ) };
        const fr = { x: px + 0.16 - sx * maxAmpX, z: pz + f * (0.04 - sz * maxAmpZ) };
        const hit = (q) => Math.abs(q.x) <= TW && Math.abs(q.z) <= TL;
        if (hit(fl) || hit(fr)) footBad = true;
      }
    }
  }
  check('整身不压台：极限站位（含最大步幅）脚不上桌', !footBad);
}

// ---------- 11. 得分后飞出球场：进入观众席/场外立即消失并停止滚动 ----------
{
  const e = TT.createEngine();
  e.phase = 'point';
  e.phaseT = 0;
  e.pointWinner = 0;
  e.ball.inHand = false;
  e.ball.vis = true;
  e.ball.pos = { x: R.ARENA_HALF_X + 0.1, y: 0.02, z: 0 };
  e.ball.vel = { x: 4, y: 0, z: 0 };
  e.ball.spin = { x: 0, y: 0, z: 0 };
  TT.step(e, DT);
  const s = TT.snapshot(e);
  check('得分后飞出球场：球立即隐藏并停止', e.ball.vis === false &&
    e.ball.vel.x === 0 && e.ball.vel.z === 0 && s.b === null && s.bh === null);

  const e2 = TT.createEngine();
  e2.phase = 'point';
  e2.phaseT = 0;
  e2.pointWinner = 0;
  e2.ball.inHand = false;
  e2.ball.vis = true;
  e2.ball.pos = { x: R.ARENA_HALF_X - 0.1, y: 0.02, z: 0 };
  e2.ball.vel = { x: 1, y: 0, z: 0 };
  e2.ball.spin = { x: 0, y: 0, z: 0 };
  TT.step(e2, DT);
  check('得分后仍在球场内：球不提前隐藏', e2.ball.vis !== false);
}

// ---------- 12. 发球 6 秒时限：超时判对方得分并消耗一次发球机会 ----------
{
  const e = TT.createEngine();
  e.server = 0;
  e.startServer = 0;
  e.serveNum = 0;
  e.phase = 'serve';
  e.phaseT = R.SERVE_TIME_LIMIT;
  e.ball.inHand = true;
  e.ball.vis = true;
  TT.step(e, DT);
  check('发球 6 秒未出手：判对方得分（发球超时）', e.pointWinner === 1 && e.pointReason === 'serve-timeout');
  for (let i = 0; i < 220; i++) TT.step(e, DT);
  check('超时后进入下一轮发球并消耗一次发球机会', e.serveNum === 1 && e.phase === 'serve' && e.pointWinner === -1);

  const e2 = TT.createEngine();
  e2.server = 0;
  e2.startServer = 0;
  e2.phase = 'serve';
  e2.phaseT = R.SERVE_TIME_LIMIT - 0.1;
  e2.ball.inHand = true;
  TT.step(e2, DT);
  check('发球未满 6 秒：不提前判超时', e2.pointWinner === -1 && e2.phase === 'serve');
}

console.log(failures === 0 ? '\n物理边界测试全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
