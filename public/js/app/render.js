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
  let smoothServeState = null; // 预览轨迹平滑状态：plan 跳变（离散求解 vel 不连续）时弧线每帧向新轨迹插值

  // 轨迹点重采样到目标长度（平滑时长度随落台截断变化，先对齐长度再插值）
  function resamplePts(pts, n) {
    if (pts.length === n) return pts;
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * (pts.length - 1);
      const i0 = Math.floor(t), i1 = Math.min(pts.length - 1, i0 + 1);
      const f = t - i0;
      out.push({
        x: pts[i0].x + (pts[i1].x - pts[i0].x) * f,
        y: pts[i0].y + (pts[i1].y - pts[i0].y) * f,
        z: pts[i0].z + (pts[i1].z - pts[i0].z) * f,
      });
    }
    return out;
  }

  // 预览轨迹指数平滑：每次 plan 变化时向新轨迹插值 25%（~40ms 收敛），消除高速选落点时的弧线抖动；
  // 实发仍用精确 plan，落点不受影响（所见即所得）
  function smoothServePts(target) {
    if (!target || target.length < 2) return target;
    if (!smoothServeState || smoothServeState.length !== target.length) {
      smoothServeState = resamplePts(target, target.length);
      return smoothServeState;
    }
    const prev = resamplePts(smoothServeState, target.length);
    const k = 0.25;
    const out = [];
    for (let i = 0; i < target.length; i++) {
      out.push({
        x: prev[i].x + (target[i].x - prev[i].x) * k,
        y: prev[i].y + (target[i].y - prev[i].y) * k,
        z: prev[i].z + (target[i].z - prev[i].z) * k,
      });
    }
    smoothServeState = out;
    return out;
  }

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
  // dt=0.04（40 点）：视觉平滑足够，比原 0.025/64 点重算省 ~37%（瞄准移动时每帧重算成本）
  function sampleServePath(H, plan, server) {
    const c = { pos: { x: H.x, y: H.y, z: H.z }, vel: { ...plan.vel }, spin: { ...plan.spin } };
    const pts = [];
    const dur = 1.6, dt = 0.04;
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
      smoothServeState = null;
      return null;
    }
    const server = engine.server;
    const p = engine.players[server];
    // 瞄准目标解不出合法发球：轨迹消失
    if (p.serveAimBlocked) {
      servePathKey = null;
      servePathPts = null;
      smoothServeState = null;
      return null;
    }
    const plan = p.servePlan || defaultServePlan(engine, server);
    if (!plan) return null;
    const H = engine.ball.pos; // 发球待发时球已在发球点
    // 键含发球点高度：蹲下发球点更低，轨迹不同，须分开缓存
    const key = `${server}:${Math.round(H.x * 4)}:${Math.round(H.y * 10)}:${plan.vel.z.toFixed(2)}:${plan.vel.x.toFixed(2)}:${plan.vel.y.toFixed(2)}`;
    if (key === servePathKey) return servePathPts;
    servePathKey = key;
    servePathPts = smoothServePts(sampleServePath(H, plan, server));
    return servePathPts;
  }

  // 联机版：客户端只有快照，没有引擎。发球方案由服务端放在快照 sp 字段（精确），
  // 未生成时用默认示意方案；物理采样与本地/人机模式完全一致。
  function servePathFromSnap(snap) {
    if (snap.ph !== 0 || !snap.bh) {
      servePathKey = null;
      smoothServeState = null;
      return null;
    }
    const server = snap.sv;
    const H = { x: snap.bh[0], y: snap.bh[1], z: snap.bh[2] };
    const facing = server === 0 ? 1 : -1;
    // 服务端判定瞄准目标解不出合法发球：轨迹消失（联机）
    if (snap.sb) {
      servePathKey = null;
      servePathPts = null;
      smoothServeState = null;
      return null;
    }
    const plan = snap.sp
      ? { vel: { x: snap.sp[0], y: snap.sp[1], z: snap.sp[2] }, spin: { x: snap.sp[3], y: snap.sp[4], z: snap.sp[5] } }
      : defaultServePlanAt(H, facing);
    if (!plan) return null;
    const key = `${server}:${Math.round(H.x * 4)}:${Math.round(H.y * 10)}:${plan.vel.z.toFixed(2)}:${plan.vel.x.toFixed(2)}:${plan.vel.y.toFixed(2)}`;
    if (key === servePathKey) return servePathPts;
    servePathKey = key;
    servePathPts = smoothServePts(sampleServePath(H, plan, server));
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
      low: !!(PPD.app.quality && PPD.app.quality.low), // 低画质：跳过观众席/看台/尾影
      showHitRanges: PPD.app.showHitRanges && !(PPD.app.quality && PPD.app.quality.low), // 低画质临时关闭虚线（不改用户勾选）
      density: PPD.isTouch ? 0.25 : 0.5, // 观众密度再减半：电脑 0.5 / 手机 0.25（省 DPR 填充率）
      noCrowd: PPD.app.mode === 'online' || !!(PPD.app.noCrowd), // 联机自动关 / 用户勾选关闭环境观众
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
      low: !!(PPD.app.quality && PPD.app.quality.low), // 低画质：跳过观众席/看台/尾影
      showHitRanges: PPD.app.showHitRanges && !(PPD.app.quality && PPD.app.quality.low), // 低画质临时关闭虚线（不改用户勾选）
      density: PPD.isTouch ? 0.25 : 0.5, // 观众密度再减半：电脑 0.5 / 手机 0.25（省 DPR 填充率）
      noCrowd: PPD.app.mode === 'online' || !!(PPD.app.noCrowd), // 联机自动关 / 用户勾选关闭环境观众
    };
  }

  // ---------- 联机双快照插值（服务端 10Hz 广播 → 客户端平滑） ----------
  // 玩家/球拍/持球位置在相邻快照间线性插值（alpha 由显示时钟驱动，见 renderOnline），
  // 球保持速度外推（快球低延迟），状态字段（比分/发球方/阶段/挥拍）取最新快照。
  function viewModelFromSnapInterp(sa, sb, alpha, side, ballExtrap) {
    const lerp = (a, b) => a + (b - a) * alpha;
    const lerpV3 = (a, b) => ({ x: lerp(a[0], b[0]), y: lerp(a[1], b[1]), z: lerp(a[2], b[2]) });
    const players = sb.p.map((p, i) => {
      const a = sa.p[i] || p;
      return {
        side: i,
        x: lerp(a.x, p.x),
        z: lerp(a.z, p.z),
        vx: lerp(a.vx, p.vx),
        vz: lerp(a.vz, p.vz),
        lean: lerp(a.lean, p.lean),
        facing: i === 0 ? 1 : -1,
        stroke: { active: p.st[0] !== 0, type: p.st[0], t: p.st[1], dur: p.st[2], hit: false },
        paddle: {
          p: lerpV3(a.pc, p.pc),
          n: lerpV3(a.pn, p.pn),
          v: { x: lerp(a.pv[0], p.pv[0]), y: lerp(a.pv[1], p.pv[1]), z: lerp(a.pv[2], p.pv[2]) },
        },
        sb: p.sb,
        // 蹲下/跑步钳制 0~1：alpha 负外推（时钟略落后于上一快照）时防止状态值越界
        crouch: Math.max(0, Math.min(1, lerp(a.cq != null ? a.cq : 0, p.cq))),
        run: Math.max(0, Math.min(1, lerp(a.rn != null ? a.rn : 0, p.rn))),
      };
    });
    let ball = null, ballInHand = null;
    if (sb.b) {
      ball = {
        pos: { x: sb.b[0] + (ballExtrap ? ballExtrap.x : 0), y: sb.b[1] + (ballExtrap ? ballExtrap.y : 0), z: sb.b[2] + (ballExtrap ? ballExtrap.z : 0) },
        vel: { x: sb.b[3], y: sb.b[4], z: sb.b[5] },
        spin: { x: sb.b[6], y: sb.b[7], z: sb.b[8] },
        vis: true,
      };
    } else if (sb.bh) {
      // 持球（发球）：球跟随球拍，插值位置（sa 无持球时直接用最新）
      const a = sa && sa.bh ? sa.bh : sb.bh;
      ballInHand = { x: lerp(a[0], sb.bh[0]), y: lerp(a[1], sb.bh[1]), z: lerp(a[2], sb.bh[2]) };
    }
    return {
      side,
      players,
      ball,
      ballInHand,
      time: sb.t / 1000,
      phase: PPD.TT.PHASE_NAME[sb.ph].toLowerCase(),
      score: sb.sc,
      server: sb.sv,
      pointReason: sb.pr,
      fx: PPD.app.fx,
      fan: PPD.app.fan,
      low: !!(PPD.app.quality && PPD.app.quality.low), // 低画质：跳过观众席/看台/尾影
      showHitRanges: PPD.app.showHitRanges && !(PPD.app.quality && PPD.app.quality.low), // 低画质临时关闭虚线（不改用户勾选）
      density: PPD.isTouch ? 0.25 : 0.5, // 手机端观众密度减半（省 DPR3 填充率）
      noCrowd: PPD.app.mode === 'online' || !!(PPD.app.noCrowd), // 联机自动关 / 用户勾选关闭环境观众
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
  // 鼠标指向球桌外（看台/地面/空中）时不计算落点（返回 null，轨迹消失），避免"台外鼠标却瞄准台面边缘"的误导
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
    // 分屏两端背景一致：观众队色统一为"红左蓝右"（P1 主视角）——P1 半屏镜像、
    // P2 半屏未镜像，若按 viewSide 分阵营会让两端观众颜色左右相反
    view0.teamFixed = true;
    view1.teamFixed = true;
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

  // ---------- 联机本地玩家输入预测（消除公网控制延迟） ----------
  // 服务端权威 + 本地即时反馈：自己的位置/球拍按本地按键每帧连续积分（预测），
  // 服务器快照只是滞后于预测、自然追赶（锚定见 app/net.js）；明显偏差才重置。
  // 挥拍中（发球/击球动画由服务端驱动）用服务器插值，避免与挥拍轨迹冲突。
  const predClamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const predDamp = (v, t, rate, dt) => v + (t - v) * Math.min(1, rate * dt);

  function stepPrediction(dt) {
    const pred = PPD.app.pred;
    if (!pred || PPD.app.mode !== 'online') return;
    const k = PPD.app.keys;
    const R = PPD.TT.RULES;
    const side = PPD.app.side;
    const f = side === 0 ? 1 : -1;
    // 蹲姿近似（快照无 crouchDur，用 crouch 作速度衰减代理；切换 ~0.15s）
    const crouchTarget = k.crouch ? 1 : 0;
    pred.crouch += (crouchTarget - pred.crouch) * Math.min(1, dt / 0.15);
    const crouchMul = R.CROUCH_SPEED_MUL -
      (R.CROUCH_SPEED_MUL - R.CROUCH_MIN_SPEED_MUL) * Math.min(1, Math.max(0, pred.crouch) / R.CROUCH_DECAY_TIME);
    const speed = R.PLAYER_SPEED * (k.run ? R.RUN_SPEED_MUL : (1 + (crouchMul - 1) * Math.max(0, pred.crouch)));
    const dir = (k.r ? 1 : 0) - (k.l ? 1 : 0);
    pred.padX = predClamp(pred.padX + dir * speed * dt, -R.MAX_X, R.MAX_X);
    pred.vx = predDamp(pred.vx || 0, dir * speed, 10, dt);
    pred.x = predClamp(predDamp(pred.x, pred.padX - f * 0.18, 16, dt), -R.MAX_X, R.MAX_X);
    const fDir = f * ((k.f ? 1 : 0) - (k.b ? 1 : 0));
    pred.vz = predDamp(pred.vz || 0, fDir * speed, 10, dt);
    const zLo = side === 0 ? -R.Z_BACK : R.Z_FWD;
    const zHi = side === 0 ? -R.Z_FWD : R.Z_BACK;
    pred.z = predClamp(pred.z + pred.vz * dt, zLo, zHi);
    // 台面禁区推出（与引擎一致：人物进不了台面）
    const TW = R.TABLE_WIDTH / 2, TL = R.TABLE_LENGTH / 2;
    const rw = TW + R.PLAYER_BODY_W, rl = TL + R.PLAYER_BODY_D;
    if (Math.abs(pred.x) <= rw && Math.abs(pred.z) <= rl) {
      const dx = rw - Math.abs(pred.x), dz = rl - Math.abs(pred.z);
      if (dx < dz) { pred.x = pred.x >= 0 ? rw : -rw; pred.padX = pred.x + f * 0.18; }
      else pred.z = side === 0 ? -rl : rl;
    }
    pred.t = performance.now();
  }

  function applyLocalPrediction(view, snap) {
    const pred = PPD.app.pred;
    if (!pred || PPD.app.mode !== 'online') return;
    const side = PPD.app.side;
    const me = view.players[side];
    const sp = snap && snap.p && snap.p[side];
    if (!me || !sp) return;
    if (sp.st && sp.st[0] !== 0) return; // 挥拍中：用服务器插值
    const f = side === 0 ? 1 : -1;
    const oldPad = { x: me.paddle.p.x, z: me.paddle.p.z };
    me.x = pred.x; me.z = pred.z; me.vx = pred.vx || 0; me.vz = pred.vz || 0;
    me.crouch = pred.crouch || 0;
    me.paddle.p.x = pred.padX;
    me.paddle.p.y = (pred.crouch || 0) >= 0.5 ? PPD.TT.RULES.CROUCH_PADDLE_Y : 0.98;
    me.paddle.p.z = pred.z + f * 0.42;
    me.paddle.n = { x: 0, y: 0, z: f };
    me.paddle.v = { x: 0, y: 0, z: 0 };
    // 持球（发球）随预测球拍平移
    if (view.ballInHand) {
      view.ballInHand.x += me.paddle.p.x - oldPad.x;
      view.ballInHand.z += me.paddle.p.z - oldPad.z;
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
    const now = performance.now();
    // 插值显示时钟（引擎时间 ms）：游戏时间=墙钟 1x，按真实时间推进；
    // 渲染滞后于最新快照约一个广播间隔（50ms，20Hz），在相邻快照间插值 → 20Hz 广播依然平滑
    if (PPD.app._interpLast != null && PPD.app.interpClock != null) {
      PPD.app.interpClock += (now - PPD.app._interpLast);
    }
    PPD.app._interpLast = now;
    // 球外推平滑（快球低延迟；玩家/球拍等慢速对象走插值）
    let ex = { x: 0, y: 0, z: 0 };
    if (snap.b) {
      const lag = Math.min(0.12, Math.max(0, (now - PPD.app.tB) / 1000 - 0.03));
      ex = { x: snap.b[3] * lag, y: snap.b[4] * lag, z: snap.b[5] * lag };
    }
    // 双快照插值：snapA(上一帧) → snapB(最新)，alpha 由显示时钟驱动
    let view;
    const sa = PPD.app.snapA;
    if (sa && typeof sa.t === 'number' && typeof snap.t === 'number' && snap.t > sa.t) {
      const clock = PPD.app.interpClock != null ? PPD.app.interpClock : snap.t;
      // alpha 不再钳制下限 0：时钟略落后于上一快照时对玩家位置线性外推（lerp alpha<0），
      // 避免"回到上一快照位置"的画面回退/人物回溯（旧版固定 50ms 滞后在 60Hz 广播下 alpha 恒被钳 0）；
      // 上限 1.2 防时钟跑太前跳变。球维持速度外推（快球低延迟）
      const alpha = Math.max(-0.5, Math.min(1.2, (clock - sa.t) / (snap.t - sa.t)));
      view = viewModelFromSnapInterp(sa, snap, alpha, PPD.app.side, ex);
    } else {
      view = viewModelFromSnap(snap, PPD.app.side, ex);
    }
    // 本地玩家输入预测：连续积分 + 覆盖自身视图（消除 ~RTT 控制延迟）
    if (PPD.app.pred) {
      const dt = PPD.app.pred.t ? Math.min(0.05, (now - PPD.app.pred.t) / 1000) : 0;
      stepPrediction(dt);
      applyLocalPrediction(view, snap);
    }
    view.servePath = servePathFromSnap(snap); // 联机发球预测轨迹（与人机/本地一致）
    updateTrail(view); // 联机用插值/外推位置，也能看到尾影
    const myX = PPD.app.pred ? PPD.app.pred.x : snap.p[PPD.app.side].x;
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
  PPD.viewModelFromSnapInterp = viewModelFromSnapInterp;
  PPD.servePathFromSnap = servePathFromSnap;
  PPD.makeCam = makeCam;
  PPD.unprojectToTable = unprojectToTable;
  PPD.serveAimFromPointer = serveAimFromPointer;
})();
