/* ============================================================
 * app/render.js — 视图模型与三种模式渲染（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 对抗尾影（跨帧累积球位置） ----------
  const TRAIL_LIFE = 0.4; // 尾影持续时间（秒）
  let trailCache = [];

  // 记录当前球位到尾影缓存；返回裁剪后的点数组（拷贝值，避免引用引擎对象）
  function updateTrail(view) {
    if (view.ball && view.phase === 'play') {
      trailCache.push({ x: view.ball.pos.x, y: view.ball.pos.y, z: view.ball.pos.z, t: view.time });
      if (trailCache.length > 64) trailCache.shift();
    }
    while (trailCache.length && view.time - trailCache[0].t > TRAIL_LIFE) trailCache.shift();
    view.trail = trailCache;
  }

  // ---------- 发球预计轨迹（真实物理采样） ----------
  let servePathKey = null;
  let servePathPts = null;

  // 待发时（servePlan 未生成）的示意方案：本地弹道学求解，朝对方半台的上旋弧线。
  // 纯函数，不触碰求解器缓存 —— 仅供预览，按键后 startServeStroke 会生成精确方案覆盖。
  function defaultServePlanAt(H, facing) {
    const target = { x: 0, y: 0.76 + 0.02, z: facing * 1.0 }; // 对方半台中心附近
    const speed = 5.0;
    const dx = target.x - H.x, dz = target.z - H.z;
    const dh = Math.hypot(dx, dz);
    if (dh < 0.05) return null;
    const dy = target.y - H.y;
    const A = (9.81 * dh * dh) / (2 * speed * speed);
    const a = A, b = -dh, c = A + dy;
    const disc = b * b - 4 * a * c;
    let u;
    if (disc < 0) u = dy / dh;
    else {
      const sq = Math.sqrt(disc);
      u = (-b - sq) / (2 * a); // 高抛角：过网更稳
      if (!Number.isFinite(u)) u = (-b + sq) / (2 * a);
    }
    const vh = speed / Math.sqrt(1 + u * u);
    return { vel: { x: (vh * dx) / dh, y: vh * u, z: (vh * dz) / dh }, spin: { x: -facing * 40, y: 0, z: 0 } };
  }

  function defaultServePlan(engine, server) {
    const p = engine.players[server];
    return defaultServePlanAt(engine.ball.pos, p.facing);
  }

  // 从发球点采样 1.6s 物理轨迹；第一次落对方半台处截断，落点标记更准确。
  function sampleServePath(H, plan, server) {
    const c = { pos: { x: H.x, y: H.y, z: H.z }, vel: { ...plan.vel }, spin: { ...plan.spin } };
    const pts = [];
    const dur = 1.6, dt = 0.025;
    let t = 0, done = false;
    const oppSide = 1 - server; // 对方半台 z 符号：0 号在 z<0，1 号在 z>0
    pts.push({ x: c.pos.x, y: c.pos.y, z: c.pos.z });
    while (t < dur && !done) {
      const h = Math.min(dt, dur - t);
      PPD.TT.physicsStep(c, h, (ev) => {
        if (ev.type === 'floor') done = true;              // 出界/落地，无需再画
        else if (ev.type === 'bounce' && ((c.pos.z > 0) === (oppSide === 1))) done = true; // 落到对方半台 → 轨迹终点
      });
      pts.push({ x: c.pos.x, y: c.pos.y, z: c.pos.z });
      t += h;
    }
    return pts;
  }

  // 发球待发/挥拍期间：用引擎已生成好的发球方案（p.servePlan）从发球点采样 1.6s 物理轨迹；
  // 待发未按键时用默认方案做示意预览。轨迹在第一次落台处截断，落点标记更准确。
  // 注意：这里只读引擎状态，绝不调用 TT.solveServe —— 求解器有共享缓存，
  // 渲染帧提前填充会污染后续 startServeStroke 的按键求解（拿到过期方案导致出界）。
  function servePath(engine) {
    if (engine.phase !== 'serve' || !engine.ball.inHand) {
      servePathKey = null;
      return null;
    }
    const server = engine.server;
    const p = engine.players[server];
    // 瞄准目标解不出合法发球：轨迹消失
    if (p.serveAimBlocked) {
      servePathKey = null;
      servePathPts = null;
      return null;
    }
    const plan = p.servePlan || defaultServePlan(engine, server);
    if (!plan) return null;
    const H = engine.ball.pos; // 发球待发时球已在发球点
    const key = `${server}:${Math.round(H.x * 4)}:${plan.vel.z.toFixed(2)}:${plan.vel.x.toFixed(2)}:${plan.vel.y.toFixed(2)}`;
    if (key === servePathKey) return servePathPts;
    servePathKey = key;
    servePathPts = sampleServePath(H, plan, server);
    return servePathPts;
  }

  // 联机版：客户端只有快照，没有引擎。发球方案由服务端放在快照 sp 字段（精确），
  // 未生成时用默认示意方案；物理采样与本地/人机模式完全一致。
  function servePathFromSnap(snap) {
    if (snap.ph !== 0 || !snap.bh) {
      servePathKey = null;
      return null;
    }
    const server = snap.sv;
    const H = { x: snap.bh[0], y: snap.bh[1], z: snap.bh[2] };
    const facing = server === 0 ? 1 : -1;
    // 服务端判定瞄准目标解不出合法发球：轨迹消失（联机）
    if (snap.sb) {
      servePathKey = null;
      servePathPts = null;
      return null;
    }
    const plan = snap.sp
      ? { vel: { x: snap.sp[0], y: snap.sp[1], z: snap.sp[2] }, spin: { x: snap.sp[3], y: snap.sp[4], z: snap.sp[5] } }
      : defaultServePlanAt(H, facing);
    if (!plan) return null;
    const key = `${server}:${Math.round(H.x * 4)}:${plan.vel.z.toFixed(2)}:${plan.vel.x.toFixed(2)}:${plan.vel.y.toFixed(2)}`;
    if (key === servePathKey) return servePathPts;
    servePathKey = key;
    servePathPts = sampleServePath(H, plan, server);
    return servePathPts;
  }

  // ---------- 渲染数据归一化 ----------
  function viewModelFromEngine(engine, side) {
    return {
      side,
      players: engine.players.map((p) => ({
        side: p.side, x: p.x, z: p.z, vx: p.vx, vz: p.vz, lean: p.lean, facing: p.facing,
        stroke: p.stroke,
        paddle: p.paddle,
        sb: p.swingBack,
        crouch: p.crouch,  // 蹲下（Ctrl）：渲染层画蹲姿
        run: p.run,        // 跑步（Shift）
      })),
      ball: engine.ball.inHand
        ? null
        : { pos: engine.ball.pos, vel: engine.ball.vel, spin: engine.ball.spin, vis: true },
      ballInHand: engine.ball.inHand ? engine.ball.pos : null,
      time: engine.t,
      phase: engine.phase,
      score: engine.score,
      server: engine.server,
      pointReason: engine.pointReason,
      fx: PPD.app.fx,
      fan: PPD.app.fan,
      servePath: servePath(engine),
      showHitRanges: PPD.app.showHitRanges, // 判定范围虚线（首页开关）
    };
  }

  function viewModelFromSnap(snap, side, ballExtrap) {
    const players = snap.p.map((p, i) => ({
      side: i,
      x: p.x,
      z: p.z,
      vx: p.vx,
      vz: p.vz,
      lean: p.lean,
      facing: i === 0 ? 1 : -1,
      stroke: { active: p.st[0] !== 0, type: p.st[0], t: p.st[1], dur: p.st[2], hit: false },
      paddle: { p: { x: p.pc[0], y: p.pc[1], z: p.pc[2] }, n: { x: p.pn[0], y: p.pn[1], z: p.pn[2] }, v: { x: p.pv[0], y: p.pv[1], z: p.pv[2] } },
      sb: p.sb,
      crouch: p.cq,  // 蹲下（Ctrl）：渲染层画蹲姿
      run: p.rn,     // 跑步（Shift）
    }));
    let ball = null, ballInHand = null;
    if (snap.b) {
      ball = {
        pos: { x: snap.b[0] + (ballExtrap ? ballExtrap.x : 0), y: snap.b[1] + (ballExtrap ? ballExtrap.y : 0), z: snap.b[2] + (ballExtrap ? ballExtrap.z : 0) },
        vel: { x: snap.b[3], y: snap.b[4], z: snap.b[5] },
        spin: { x: snap.b[6], y: snap.b[7], z: snap.b[8] },
        vis: true,
      };
    } else if (snap.bh) {
      ballInHand = { x: snap.bh[0], y: snap.bh[1], z: snap.bh[2] };
    }
    return {
      side,
      players,
      ball,
      ballInHand,
      time: snap.t / 1000,
      phase: PPD.TT.PHASE_NAME[snap.ph].toLowerCase(),
      score: snap.sc,
      server: snap.sv,
      pointReason: snap.pr,
      fx: PPD.app.fx,
      fan: PPD.app.fan,
      showHitRanges: PPD.app.showHitRanges, // 判定范围虚线（首页开关）
    };
  }

  // ---------- 渲染 ----------
  function makeCam(side, followX, vx, vy, vw, vh) {
    const cam = new PPD.TTG.Camera();
    // 死区跟随：角色在台面中部 ±0.62m 内时相机不动，避免"按左球往右跑"的反直觉感
    const camX = followX - PPD.TTG.clamp(followX, -0.62, 0.62);
    // 低机位赛事转播视角：机位贴近球员高度、视线略抬，两侧与远端像素观众席入画，
    // 球员更大更有临场感，看台如围墙环绕球场
    const eye = PPD.TTG.v3(camX, 4.8, (side === 0 ? -5.20 : 5.20) + camX * 0.05);
    const look = PPD.TTG.v3(camX * 0.55, 1.7, 0);
    const focal = vw * 0.9;
    cam.set(eye, look, vx + vw / 2, vy + vh / 2, focal);
    return cam;
  }

  // ---------- 发球瞄准：屏幕坐标 → 对方半台目标落点 ----------
  // 逆投影：把指针位置映射到台面高度平面上（与渲染共用同一相机与镜像规则）
  function unprojectToTable(cam, ctxX, ctxY) {
    const Y = PPD.TT.RULES.TABLE_HEIGHT + PPD.TT.RULES.BALL_RADIUS;
    const Ax = ctxX - cam.cx, Ay = cam.cy - ctxY;
    const dy = Y - cam.eye.y;
    if (Math.abs(dy) < 1e-6) return null;
    const K1 = Ax * cam.right.y + Ay * cam.up.y;
    const t = (cam.f * cam.fwd.y + K1) / dy;
    if (!(t > 0.001)) return null;
    const z = cam.f / t;
    const a = Ax / t, b = Ay / t;
    return {
      x: cam.eye.x + a * cam.right.x + b * cam.up.x + z * cam.fwd.x,
      y: Y,
      z: cam.eye.z + a * cam.right.z + b * cam.up.z + z * cam.fwd.z,
    };
  }

  // 把屏幕指针位置换算为"对方半台上的瞄准落点"（世界坐标，夹取到台面安全区）
  function serveAimFromPointer(clientX, clientY, side) {
    const w = PPD.app.resizeW, h = PPD.app.resizeH;
    const R = PPD.TT.RULES;
    const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    let cam, ctxX;
    if (PPD.app.mode === 'local') {
      const half = Math.floor(w / 2);
      const eng = PPD.app.engine;
      if (side === 0) {
        clientX = clampN(clientX, 0, half);
        ctxX = half - clientX; // 红方视口已镜像
      } else {
        clientX = clampN(clientX, half, w);
        ctxX = clientX - half;
      }
      cam = makeCam(side, eng ? eng.players[side].x : 0, side === 0 ? 0 : half, 0, half, h);
    } else if (PPD.app.mode === 'ai') {
      clientX = clampN(clientX, 0, w);
      ctxX = w - clientX; // 红方视口已镜像
      cam = makeCam(0, PPD.app.engine ? PPD.app.engine.players[0].x : 0, 0, 0, w, h);
    } else {
      clientX = clampN(clientX, 0, w);
      ctxX = side === 0 ? w - clientX : clientX;
      const snap = PPD.app.snapB;
      const myX = snap && snap.p && snap.p[side] ? snap.p[side].x : 0;
      cam = makeCam(side, myX, 0, 0, w, h);
    }
    const world = unprojectToTable(cam, ctxX, clientY);
    if (!world) return null;
    const f = side === 0 ? 1 : -1;
    const mx = R.TABLE_WIDTH / 2 - 0.10;
    const mz = R.TABLE_LENGTH / 2 - 0.14;
    return {
      x: PPD.TTG.clamp(world.x, -mx, mx),
      z: f > 0 ? PPD.TTG.clamp(world.z, 0.10, mz) : PPD.TTG.clamp(world.z, -mz, -0.10),
    };
  }

  // 红方（side 0）的相机位于自己身后（世界 +x 在屏幕左侧），
  // 镜像视口后按键方向与屏幕方向一致；蓝方（side 1）无需镜像
  function applyViewMirror(ctx, w) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }

  function renderLocal() {
    const w = PPD.app.resizeW, h = PPD.app.resizeH;
    const half = Math.floor(w / 2);
    PPD.ctx.clearRect(0, 0, w, h);
    // 两个视角共享同一份尾影（只记录一次）
    const view0 = viewModelFromEngine(PPD.app.engine, 0);
    updateTrail(view0);
    const view1 = viewModelFromEngine(PPD.app.engine, 1);
    view1.trail = view0.trail;
    for (const [side, view] of [[0, view0], [1, view1]]) {
      const cam = makeCam(side, PPD.app.engine.players[side].x, side === 0 ? 0 : half, 0, half, h);
      view.cam = cam;
      PPD.ctx.save();
      PPD.ctx.beginPath();
      PPD.ctx.rect(side === 0 ? 0 : half, 0, half, h);
      PPD.ctx.clip();
      if (side === 0) applyViewMirror(PPD.ctx, half);
      PPD.TTG.drawScene(PPD.ctx, view, half, h);
      PPD.ctx.restore();
      // 分屏分隔线
      PPD.ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      PPD.ctx.lineWidth = 2;
      PPD.ctx.beginPath();
      PPD.ctx.moveTo(half, 0); PPD.ctx.lineTo(half, h); PPD.ctx.stroke();
      // 侧标
      PPD.ctx.fillStyle = 'rgba(255,255,255,0.55)';
      PPD.ctx.font = 'bold 15px system-ui';
      PPD.ctx.textAlign = side === 0 ? 'left' : 'right';
      PPD.ctx.fillText(`P${side + 1} 视角`, side === 0 ? 14 : half - 14, 28);
    }
  }

  function renderOnline() {
    const w = PPD.app.resizeW, h = PPD.app.resizeH;
    PPD.ctx.clearRect(0, 0, w, h);
    const snap = PPD.app.snapB;
    if (!snap) {
      PPD.ctx.fillStyle = 'rgba(255,255,255,0.5)';
      PPD.ctx.font = '18px system-ui';
      PPD.ctx.textAlign = 'center';
      PPD.ctx.fillText('等待服务器数据…', w / 2, h / 2);
      return;
    }
    // 球外推平滑
    let ex = { x: 0, y: 0, z: 0 };
    if (snap.b) {
      const now = performance.now();
      const lag = Math.min(0.12, Math.max(0, (now - PPD.app.tB) / 1000 - 0.03));
      ex = { x: snap.b[3] * lag, y: snap.b[4] * lag, z: snap.b[5] * lag };
    }
    const view = viewModelFromSnap(snap, PPD.app.side, ex);
    view.servePath = servePathFromSnap(snap); // 联机发球预测轨迹（与人机/本地一致）
    updateTrail(view); // 联机用快照外推位置，也能看到尾影
    const myX = snap.p[PPD.app.side].x;
    const cam = makeCam(PPD.app.side, myX, 0, 0, w, h);
    view.cam = cam;
    PPD.ctx.save();
    if (PPD.app.side === 0) applyViewMirror(PPD.ctx, w);
    PPD.TTG.drawScene(PPD.ctx, view, w, h);
    PPD.ctx.restore();
  }

  function renderSingle() {
    // 人机模式：单人全屏视角（自己=红方）
    const w = PPD.app.resizeW, h = PPD.app.resizeH;
    PPD.ctx.clearRect(0, 0, w, h);
    const view = viewModelFromEngine(PPD.app.engine, 0);
    updateTrail(view);
    const cam = makeCam(0, PPD.app.engine.players[0].x, 0, 0, w, h);
    view.cam = cam;
    PPD.ctx.save();
    applyViewMirror(PPD.ctx, w);
    PPD.TTG.drawScene(PPD.ctx, view, w, h);
    PPD.ctx.restore();
  }


  PPD.renderLocal = renderLocal;
  PPD.renderOnline = renderOnline;
  PPD.renderSingle = renderSingle;
  PPD.viewModelFromEngine = viewModelFromEngine;
  PPD.viewModelFromSnap = viewModelFromSnap;
  PPD.servePathFromSnap = servePathFromSnap;
  PPD.makeCam = makeCam;
  PPD.unprojectToTable = unprojectToTable;
  PPD.serveAimFromPointer = serveAimFromPointer;
})();
