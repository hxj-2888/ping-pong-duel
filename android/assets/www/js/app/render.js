/* ============================================================
 * app/render.js — 视图模型与三种模式渲染（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 对抗尾影（跨帧累积球位置） ----------
  const TRAIL_LIFE = 0.4; // 尾影持续时间（秒）
  const TRAIL_MAX = 64;   // 尾影点数上限（桌面）；手机端减半（v2.4 预算）
  let trailCache = [];

  // ---------- 联机视图安全工具 ----------
  // 阶段用英文 id（与引擎 phase 一致；尾影/判定等依赖 'play'），ph 缺失/越界回退 'serve'
  const PHASE_BY_ID = ['serve', 'play', 'point', 'over'];
  function safePhase(ph) {
    return (ph === 0 || ph === 1 || ph === 2 || ph === 3) ? PHASE_BY_ID[ph] : 'serve';
  }
  // NaN/缺字段安全取值：非有限值时回退到另一侧（或 0），防"静默不画"（NaN 坐标被 Canvas 忽略）
  function safeNum(v, fb) {
    const n = Number(v);
    return Number.isFinite(n) ? n : (Number.isFinite(fb) ? fb : 0);
  }

  // 记录当前球位到尾影缓存；返回裁剪后的点数组（拷贝值，避免引用引擎对象）
  function updateTrail(view) {
    if (view.ball && view.phase === 'play') {
      trailCache.push({ x: view.ball.pos.x, y: view.ball.pos.y, z: view.ball.pos.z, t: view.time });
      const max = (typeof PPD !== 'undefined' && PPD && PPD.isTouch) ? TRAIL_MAX / 2 : TRAIL_MAX;
      while (trailCache.length > max) trailCache.shift();
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
  // v1.6.1：轨迹未合法落到对方半台台面（出界/未过网）→ 返回 null，整条虚线屏蔽、不显示落点标记
  function sampleServePath(H, plan, server) {
    const c = { pos: { x: H.x, y: H.y, z: H.z }, vel: { ...plan.vel }, spin: { ...plan.spin } };
    const pts = [];
    const dur = 1.6, dt = 0.04;
    let t = 0, done = false, landed = false;
    const oppSide = 1 - server; // 对方半台 z 符号：0 号在 z<0，1 号在 z>0
    pts.push({ x: c.pos.x, y: c.pos.y, z: c.pos.z });
    while (t < dur && !done) {
      const h = Math.min(dt, dur - t);
      PPD.TT.physicsStep(c, h, (ev) => {
        if (ev.type === 'floor') done = true; // 落出球台/出界：未合法落台
        else if (ev.type === 'bounce' && ((c.pos.z > 0) === (oppSide === 1))) { done = true; landed = true; } // 对方半台落台
      });
      pts.push({ x: c.pos.x, y: c.pos.y, z: c.pos.z });
      t += h;
    }
    return landed ? pts : null;
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
  // v2.1.1：自己发球时改为"本地即时求解"——瞄准/站位一变就用引擎 solveServeTo 本地算出轨迹，
  // 不再等"瞄准→服务器求解→快照返回"的往返（公网 RTT+快照间隔可达 150~300ms，
  // 是"轨迹有很强延迟、不跟球"的根因）。服务器仍权威，实发时按实际站位复验/回退。
  function servePathFromSnap(snap) {
    if (snap.ph !== 0 || !snap.bh) {
      servePathKey = null;
      smoothServeState = null;
      return null;
    }
    const server = snap.sv;
    const H = { x: snap.bh[0], y: snap.bh[1], z: snap.bh[2] };
    const facing = server === 0 ? 1 : -1;
    let plan = null;
    // 自己发球 + 已有瞄准 → 本地即时求解（跟随鼠标，无往返延迟）。
    // P1-1 节流：瞄准/站位未变或 <50ms 内不重解（solveServeTo 求解含物理搜索，发球期每帧调用是慢设备掉帧源）；
    // 瞄准移动时按 50ms 节流 + 引擎缓存（量化键）仍跟手。
    if (server === PPD.app.side && PPD.app.serveAim) {
      const aim = PPD.app.serveAim;
      const p = snap.p[server];
      const now = performance.now();
      const localKey = `${aim.x.toFixed(2)},${aim.z.toFixed(2)},${(p.pc && p.pc[0]).toFixed(2)},${p.z.toFixed(2)},${(p.cq || 0).toFixed(2)}`;
      if (localKey !== PPD.app._serveLocalKey || now - (PPD.app._serveLocalT || 0) > 50) {
        PPD.app._serveLocalKey = localKey;
        PPD.app._serveLocalT = now;
        // solveServeTo 只需 players[pi] 的 facing/padX/crouch/z（serveBallPos 用），用快照姿态重建即可
        const minPlayer = { facing, padX: p.pc ? p.pc[0] : p.x, crouch: p.cq || 0, z: p.z };
        const lp = PPD.TT.solveServeTo({ players: [minPlayer, minPlayer] }, server, aim.x, aim.z, false);
        PPD.app._serveLocalPlan = lp ? { vel: lp.vel, spin: lp.spin } : null;
      }
      plan = PPD.app._serveLocalPlan;
    }
    if (!plan) {
      // 非自己发球 / 本地无解：用服务器 sp（对手精确轨迹）/ 默认示意方案
      if (snap.sb) {
        servePathKey = null;
        servePathPts = null;
        smoothServeState = null;
        return null;
      }
      plan = snap.sp
        ? { vel: { x: snap.sp[0], y: snap.sp[1], z: snap.sp[2] }, spin: { x: snap.sp[3], y: snap.sp[4], z: snap.sp[5] } }
        : defaultServePlanAt(H, facing);
    }
    if (!plan) return null;
    const key = `${server}:${Math.round(H.x * 4)}:${Math.round(H.y * 10)}:${plan.vel.z.toFixed(2)}:${plan.vel.x.toFixed(2)}:${plan.vel.y.toFixed(2)}`;
    if (key === servePathKey) return servePathPts;
    servePathKey = key;
    servePathPts = smoothServePts(sampleServePath(H, plan, server));
    return servePathPts;
  }

  // ---------- 渲染数据归一化 ----------
  function viewModelFromEngine(engine, side) {
    const isAivai = PPD.app.mode === 'aivai';
    const fxShow = PPD.app.fxShow || {};
    return {
      side,
      players: engine.players.map((p) => ({
        side: p.side, x: p.x, z: p.z, vx: p.vx, vz: p.vz, lean: p.lean, facing: p.facing,
        stroke: p.stroke,
        paddle: p.paddle,
        sb: p.swingBack,
        crouch: p.crouch,  // 蹲下（Ctrl）：渲染层画蹲姿
        run: p.run,        // 跑步（Shift）
        // v2.1 特效分离：装扮仅尾影/溅射特效，球衣与拍面主色恒=队服（旗帜队色），不再注入 paddleSkin/shirtSkin
        // 队伍旗帜队色（本地/人机/AI 观战按本局队伍注入，随旗帜同步球服颜色；联机无 matchTeams → 默认红蓝）
        teamColor: (PPD.app.matchTeams && PPD.app.matchTeams[p.side]) ? PPD.app.matchTeams[p.side].color : null,
        // 问号(扣杀/低平预警)仅在判定指示开启时显示；感叹号(反击成功)始终显示(v2.0)
        warnSmash: PPD.app.showHitRanges ? (p.warnSmash || 0) : 0,
        warnT: p.warnT || 0,   // 问号剩余时长(渐变消失用)
        exclaimT: p.exclaimT || 0,
      })),
      ball: !engine.ball.inHand && engine.ball.vis !== false
        ? { pos: engine.ball.pos, vel: engine.ball.vel, spin: engine.ball.spin, vis: true }
        : null,
      ballInHand: engine.ball.inHand && engine.ball.vis !== false ? engine.ball.pos : null,
      time: engine.t,
      phase: engine.phase,
      score: engine.score,
      server: engine.server,
      pointReason: engine.pointReason,
      // 撞击特效：设置面板「撞击特效」开关全局生效（v2.7.0）
      fx: (!fxShow.splash) ? [] : PPD.app.fx,
      fan: PPD.app.fan,
      servePath: servePath(engine),
      // 尾影：设置面板「尾影特效」开关全局生效（v2.7.0）；观战 AI 不受玩家装扮（默认色）
      trailStyle: isAivai ? null : (PPD.app.equip.trail || null),
      trailHidden: !fxShow.trail,
      low: !!(PPD.app.quality && PPD.app.quality.low), // 低画质：跳过观众席/看台/尾影
      showHitRanges: PPD.app.showHitRanges && !(PPD.app.quality && PPD.app.quality.low), // 低画质临时关闭虚线（不改用户勾选）
      density: PPD.isTouch ? 0.25 : 0.5, // 观众密度再减半：电脑 0.5 / 手机 0.25（省 DPR 填充率）
      noCrowd: PPD.app.mode === 'online' || !!(PPD.app.noCrowd), // 联机自动关 / 用户勾选关闭环境观众
    };
  }

  function viewModelFromSnap(snap, side, ballExtrap) {
    const players = (snap.p || []).map((p, i) => ({
      side: i,
      x: safeNum(p.x, 0),
      z: safeNum(p.z, 0),
      vx: safeNum(p.vx, 0),
      vz: safeNum(p.vz, 0),
      lean: safeNum(p.lean, 0),
      facing: i === 0 ? 1 : -1,
      stroke: { active: !!(p.st && p.st[0]), type: safeNum(p.st && p.st[0], 0), t: safeNum(p.st && p.st[1], 0), dur: safeNum(p.st && p.st[2], 0.2), hit: false },
      paddle: {
        p: { x: safeNum(p.pc && p.pc[0], 0), y: safeNum(p.pc && p.pc[1], 0.98), z: safeNum(p.pc && p.pc[2], 0) },
        n: { x: safeNum(p.pn && p.pn[0], 0), y: safeNum(p.pn && p.pn[1], 0), z: safeNum(p.pn && p.pn[2], 0) },
        v: { x: safeNum(p.pv && p.pv[0], 0), y: safeNum(p.pv && p.pv[1], 0), z: safeNum(p.pv && p.pv[2], 0) },
      },
      sb: p.sb,
      crouch: safeNum(p.cq, 0),  // 蹲下（Ctrl）：渲染层画蹲姿
      run: safeNum(p.rn, 0),     // 跑步（Shift）
      // v2.1 特效分离：装扮仅尾影/溅射，球衣与拍面恒=队服；联机无队伍，默认红蓝
    }));
    let ball = null, ballInHand = null;
    if (snap.b) {
      ball = {
        pos: { x: safeNum(snap.b[0], 0) + (ballExtrap ? ballExtrap.x : 0), y: safeNum(snap.b[1], 0) + (ballExtrap ? ballExtrap.y : 0), z: safeNum(snap.b[2], 0) + (ballExtrap ? ballExtrap.z : 0) },
        vel: { x: safeNum(snap.b[3], 0), y: safeNum(snap.b[4], 0), z: safeNum(snap.b[5], 0) },
        spin: { x: safeNum(snap.b[6], 0), y: safeNum(snap.b[7], 0), z: safeNum(snap.b[8], 0) },
        vis: true,
      };
    } else if (snap.bh) {
      ballInHand = { x: safeNum(snap.bh[0], 0), y: safeNum(snap.bh[1], 0), z: safeNum(snap.bh[2], 0) };
    }
    return {
      side,
      players,
      ball,
      ballInHand,
      time: safeNum(snap.t, 0) / 1000,
      phase: safePhase(snap.ph), // 英文 id：尾影/判定等依赖 'play'
      score: snap.sc,
      server: snap.sv,
      pointReason: snap.pr,
      fx: (PPD.app.fxShow && !PPD.app.fxShow.splash) ? [] : PPD.app.fx, // v2.7.0 撞击特效开关全局生效
      fan: PPD.app.fan,
      trailHidden: !(PPD.app.fxShow && PPD.app.fxShow.trail), // v2.7.0 尾影特效开关全局生效
      trailStyle: PPD.app.equip.trail || null, // 养成尾影特效
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
    // NaN/缺字段安全插值：任一输入非有限值时回退到另一侧（或 0），防插值产生 NaN 静默不画
    const lerp = (a, b) => {
      const an = safeNum(a, b), bn = safeNum(b, an);
      return an + (bn - an) * alpha;
    };
    const lerpV3 = (a, b) => ({ x: lerp(a && a[0], b && b[0]), y: lerp(a && a[1], b && b[1]), z: lerp(a && a[2], b && b[2]) });
    const players = (sb.p || []).map((p, i) => {
      const a = (sa && sa.p && sa.p[i]) || p;
      return {
        side: i,
        x: lerp(a.x, p.x),
        z: lerp(a.z, p.z),
        vx: lerp(a.vx, p.vx),
        vz: lerp(a.vz, p.vz),
        lean: lerp(a.lean, p.lean),
        facing: i === 0 ? 1 : -1,
        stroke: { active: !!(p.st && p.st[0]), type: safeNum(p.st && p.st[0], 0), t: safeNum(p.st && p.st[1], 0), dur: safeNum(p.st && p.st[2], 0.2), hit: false },
        paddle: {
          p: lerpV3(a.pc, p.pc),
          n: lerpV3(a.pn, p.pn),
          v: { x: lerp(a.pv && a.pv[0], p.pv && p.pv[0]), y: lerp(a.pv && a.pv[1], p.pv && p.pv[1]), z: lerp(a.pv && a.pv[2], p.pv && p.pv[2]) },
        },
        sb: p.sb,
        // 蹲下/跑步钳制 0~1：alpha 负外推（时钟略落后于上一快照）时防止状态值越界
        crouch: Math.max(0, Math.min(1, lerp(a.cq != null ? a.cq : 0, p.cq))),
        run: Math.max(0, Math.min(1, lerp(a.rn != null ? a.rn : 0, p.rn))),
        // v2.1 特效分离：装扮仅尾影/溅射，球衣与拍面恒=队服；联机无队伍，默认红蓝
      };
    });
    let ball = null, ballInHand = null;
    if (sb.b) {
      // v2.7.0-fix:发球离手过渡——上一帧持球(sa.bh)、本帧飞行(sb.b)时，球位从持球点按 alpha
      // 插值到飞行点（不再直接画最新飞行位），消除高速发球"球瞬移离手"的观感（50ms 位移 0.3~0.5m）
      const release = sa && sa.bh;
      ball = {
        pos: {
          x: release ? lerp(sa.bh[0], sb.b[0]) : safeNum(sb.b[0], 0) + (ballExtrap ? ballExtrap.x : 0),
          y: release ? lerp(sa.bh[1], sb.b[1]) : safeNum(sb.b[1], 0) + (ballExtrap ? ballExtrap.y : 0),
          z: release ? lerp(sa.bh[2], sb.b[2]) : safeNum(sb.b[2], 0) + (ballExtrap ? ballExtrap.z : 0),
        },
        vel: { x: safeNum(sb.b[3], 0), y: safeNum(sb.b[4], 0), z: safeNum(sb.b[5], 0) },
        spin: { x: safeNum(sb.b[6], 0), y: safeNum(sb.b[7], 0), z: safeNum(sb.b[8], 0) },
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
      time: safeNum(sb.t, 0) / 1000,
      phase: safePhase(sb.ph), // 英文 id：尾影/判定等依赖 'play'
      score: sb.sc,
      server: sb.sv,
      pointReason: sb.pr,
      fx: (PPD.app.fxShow && !PPD.app.fxShow.splash) ? [] : PPD.app.fx, // v2.7.0 撞击特效开关全局生效
      fan: PPD.app.fan,
      trailHidden: !(PPD.app.fxShow && PPD.app.fxShow.trail), // v2.7.0 尾影特效开关全局生效
      trailStyle: PPD.app.equip.trail || null, // 养成尾影特效
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
    // v2.7.0-fix:发球阶段站位钳制（与引擎同步，见 engine.js）：我是发球方且持球时，
    // 不能进入"解不出合法发球"的近网死区（边线绕行逼近球网后 z≥~-0.6 即解不出、bh 越网）
    if (PPD.app.snapB && PPD.app.snapB.ph === 0 && PPD.app.snapB.sv === side) {
      pred.z = predClamp(pred.z, side === 0 ? -R.Z_BACK : R.SERVE_Z_SAFE, side === 0 ? -R.SERVE_Z_SAFE : R.Z_BACK);
    }
    // v2.7.0-fix:消费 net.js 写入的纠偏目标（原 v2.6.0 只写不读=死代码）：
    // 移动中预测合法领先服务器约 RTT×速度，只在偏差超过领先距离时向服务器平滑收敛，
    // 避免"走着走着被拽住"与"漂移无界最终 3m 瞬移"；>3m 严重失步仍由 net.js 硬重置兜底。
    if (PPD.app.serverX != null && PPD.app.serverZ != null) {
      const sx = PPD.app.serverX, sz = PPD.app.serverZ;
      const ex = sx - pred.x, ez = sz - pred.z;
      const dr = Math.hypot(ex, ez);
      const lead = ((PPD.app.rtt != null ? PPD.app.rtt : 60) / 1000) * speed * 1.5 + 0.1;
      if (dr > lead) {
        const k = dr > 2 ? 0.5 : 0.25; // 偏差越大收敛越快，但不瞬间硬跳
        pred.x += ex * Math.min(1, k * dt * 60);
        pred.z += ez * Math.min(1, k * dt * 60);
        pred.padX = pred.x + (side === 0 ? 0.18 : -0.18);
        if (dr < lead * 1.15) { PPD.app.serverX = null; PPD.app.serverZ = null; } // 到位即清
      }
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
    const f = side === 0 ? 1 : -1;
    const swinging = !!(sp.st && sp.st[0] !== 0);
    const isServer = snap.sv === side;
    // v2.7.1-fix:发球阶段（自己持球待发）禁用本地预测——发球点/球拍/持球严格用服务器快照。
    // 发球求解（servePathFromSnap 本地 solveServeTo + 服务器 setServeAim 复验）对站位极敏感：
    // 公网 RTT 下本地预测与服务器发球点哪怕差几厘米，本地"能解出/球在某处"与服务器判定就分叉，
    // 表现为"发球有时无法求解 + 对方看球位置偏移很远"。发球是低频精确操作，不需预测平滑。
    const serving = isServer && snap.ph === 0;
    if (serving) {
      // 同步预测锚点到服务器，避免发球结束切回预测时位置跳变
      pred.x = sp.x; pred.z = sp.z; pred.vx = sp.vx || 0; pred.vz = sp.vz || 0;
      pred.padX = sp.pc ? sp.pc[0] : sp.x; pred.crouch = sp.cq || 0;
      return; // 位置/球拍/持球全部保留服务器快照插值结果（含 ballInHand 贴拍）
    }
    const oldPad = { x: me.paddle.p.x, z: me.paddle.p.z };
    // 位置/速度/蹲姿始终用本地预测：挥拍前后连续，消除"挥拍结束瞬间从服务器插值硬切回预测"
    // 的位置/速度跳变（行走动画抽动主因）。挥拍期间仅球拍保持服务器插值的挥拍轨迹。
    me.x = pred.x; me.z = pred.z; me.vx = pred.vx || 0; me.vz = pred.vz || 0;
    me.crouch = pred.crouch || 0;
    if (!swinging) {
      me.paddle.p.x = pred.padX;
      me.paddle.p.y = (pred.crouch || 0) >= 0.5 ? PPD.TT.RULES.CROUCH_PADDLE_Y : 0.98;
      me.paddle.p.z = pred.z + f * 0.42;
      me.paddle.n = { x: 0, y: 0, z: f };
      me.paddle.v = { x: 0, y: 0, z: 0 };
    }
    // 持球（发球）随预测球拍平移：仅持球方（snap.sv === side）把球贴到自己手上；
    // 非持球方执行会用自己球拍的预测位移去平移持球方的球（球贴着自己漂移）。
    if (view.ballInHand && isServer) {
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
    // 球外推平滑（快球低延迟；玩家/球拍等慢速对象走插值）；NaN 兜底防静默不画
    let ex = { x: 0, y: 0, z: 0 };
    if (snap.b) {
      const lag = Math.min(0.12, Math.max(0, (now - PPD.app.tB) / 1000 - 0.03));
      ex = { x: safeNum(snap.b[3], 0) * lag, y: safeNum(snap.b[4], 0) * lag, z: safeNum(snap.b[5], 0) * lag };
    }
    // 快照缓冲跨帧插值：在缓冲内找跨插值时钟的相邻帧对，alpha ∈ [0,1] 纯插值。
    // 时钟滞后最新帧 1.5 间隔（net.js 锚定）→ 恒有可插值帧对 → 任意广播率平滑，
    // 无外推放大（旧版 alpha 恒 1 只显示最新帧 → 低广播率步进抽动）、无回退重置。
    let view;
    const buf = PPD.app.snapBuf || [];
    const clock = PPD.app.interpClock != null ? PPD.app.interpClock : (buf.length ? buf[buf.length - 1].t : 0);
    let s1 = null, s2 = null, alpha = 0;
    if (buf.length >= 2) {
      for (let i = 1; i < buf.length; i++) {
        if (buf[i - 1].t <= clock && clock <= buf[i].t) {
          s1 = buf[i - 1].s; s2 = buf[i].s;
          alpha = (clock - buf[i - 1].t) / (buf[i].t - buf[i - 1].t);
          break;
        }
      }
      if (!s1) {
        // 时钟超出缓冲范围（首帧/追赶瞬态）：钳到最近帧，不外推
        if (clock < buf[0].t) { s1 = buf[0].s; s2 = buf[1].s; alpha = 0; }
        else { s1 = buf[buf.length - 2].s; s2 = buf[buf.length - 1].s; alpha = 1; }
      }
    }
    if (s1 && s2 && typeof s1.t === 'number' && s2.t > s1.t) {
      view = viewModelFromSnapInterp(s1, s2, alpha, PPD.app.side, ex);
    } else {
      view = viewModelFromSnap(snap, PPD.app.side, ex);
    }
    // 本地玩家输入预测：连续积分 + 覆盖自身视图（消除 ~RTT 控制延迟）
    if (PPD.app.pred) {
      const dt = PPD.app.pred.t ? Math.min(0.05, (now - PPD.app.pred.t) / 1000) : 0;
      stepPrediction(dt);
      applyLocalPrediction(view, snap);
    }
    // 联机发球瞄准线/落点仅持球方（snap.sv === side）显示；非持球方不显示
    // （否则对方半台出现瞄准线/落点标记，观感像"球/点在自己身前"）
    view.servePath = snap.sv === PPD.app.side ? servePathFromSnap(snap) : null;
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
  PPD.updateTrail = updateTrail;       // 回放（replay.js）复用尾影
  PPD.applyViewMirror = applyViewMirror; // 回放复用红方视角镜像
  PPD.viewModelFromEngine = viewModelFromEngine;
  PPD.viewModelFromSnap = viewModelFromSnap;
  PPD.viewModelFromSnapInterp = viewModelFromSnapInterp;
  PPD.servePathFromSnap = servePathFromSnap;
  PPD.makeCam = makeCam;
  PPD.unprojectToTable = unprojectToTable;
  PPD.serveAimFromPointer = serveAimFromPointer;
})();
