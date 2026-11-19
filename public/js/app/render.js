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

  // ---------- 镜头物理反馈（击球/得分的一过性震屏 + 推近） ----------
  // 纯视觉状态：不参与引擎与联机协议，不发包、不影响判定。
  // hud.js / net.js 在事件回调里调 fxKick；loop.js 每帧调 fxStep 按真实时间衰减。
  const juice = { shake: 0, punch: 0 };
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const KICKS = {
    hit: [0.42, 0.50],    // 普通击球
    smash: [1.00, 1.00],  // 扣杀（含反击扣杀）
    bounce: [0.20, 0.10], // 落台
    net: [0.32, 0.12],    // 触网
    score: [0.50, 0.60],  // 得分
    over: [0.80, 0.90],   // 终局
  };
  function fxKick(kind, strength) {
    const s = clamp01(strength == null ? 1 : strength);
    const k = KICKS[kind] || KICKS.hit;
    juice.shake = Math.min(1.15, Math.max(juice.shake, k[0] * s));
    juice.punch = Math.min(1, Math.max(juice.punch, k[1] * s));
  }
  function fxStep(dt) {
    if (!(dt > 0)) return;
    juice.shake = Math.max(0, juice.shake - dt * 3.2);
    juice.punch = Math.max(0, juice.punch - dt * 4.0);
  }
  const juiceLevel = () => ({ shake: juice.shake, punch: juice.punch });
  // 把震屏/推近合成到画布变换：围绕视口中心缩放 + 位移；额外底噪缩放保证抖动不露出画布边缘。
  // 返回是否施加了变换（调用方决定是否传 plate 保持当前变换）。
  function juiceTransform(ctx, vx, vy, w, h) {
    const fxShow = PPD.app.fxShow || {};
    if (fxShow.shake === false) return false; // 设置面板「镜头震动」关闭
    if (juice.shake <= 0 && juice.punch <= 0) return false;
    const low = !!(PPD.app.quality && PPD.app.quality.low);
    const q = low ? 0.5 : 1;
    const ref = Math.max(240, Math.min(w, h));
    const amp = juice.shake * q * ref * 0.006;
    const overscan = amp > 0.05 ? (amp * 2.2) / ref : 0;
    const zoom = 1 + juice.punch * (low ? 0.008 : 0.016) + overscan;
    const now = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) / 1000;
    const dx = amp * (Math.sin(now * 91.7) * 0.62 + Math.sin(now * 37.3 + 1.3) * 0.38);
    const dy = amp * (Math.sin(now * 77.3 + 0.8) * 0.55 + Math.sin(now * 47.9) * 0.45);
    const cx = vx + w / 2, cy = vy + h / 2;
    ctx.translate(cx + dx, cy + dy);
    ctx.scale(zoom, zoom);
    ctx.translate(-cx, -cy);
    return true;
  }

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
        // v2.1 特效分离：战斗奖励仅尾影/溅射特效，球衣与拍面主色恒=队服（旗帜队色），不再注入 paddleSkin/shirtSkin
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
      // 尾影：设置面板「尾影特效」开关控制显隐（v2.7.0），颜色随玩家装配（2026-09-27 修复：
      // 原先 aivai 观战强制默认色，与同模式溅射已应用玩家装备的行为不一致）
      trailStyle: PPD.app.equip.trail || null,
      trailHidden: !fxShow.trail,
      low: !!(PPD.app.quality && PPD.app.quality.low), // 低画质：跳过观众席/看台/尾影
      showHitRanges: PPD.app.showHitRanges && !(PPD.app.quality && PPD.app.quality.low), // 低画质临时关闭虚线（不改用户勾选）
      /* 〔2026-10-23 忠于原图 + 性能〕观众密度：电脑 0.62 / 手机 0.42。
         曾按"原图是密排光海"调到 0.8，但实测静态层重建 9.8ms、动画层 30Hz 烘焙 9.2ms，
         边跑边重建会明显掉帧；0.62 时重建约 6.8ms，密度观感与原图仍属同一档。 */
      density: PPD.isTouch ? 0.42 : 0.62,
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
      // v2.1 特效分离：战斗奖励仅尾影/溅射，球衣与拍面恒=队服；联机无队伍，默认红蓝
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
      /* 〔2026-10-23 忠于原图 + 性能〕观众密度：电脑 0.62 / 手机 0.42。
         曾按"原图是密排光海"调到 0.8，但实测静态层重建 9.8ms、动画层 30Hz 烘焙 9.2ms，
         边跑边重建会明显掉帧；0.62 时重建约 6.8ms，密度观感与原图仍属同一档。 */
      density: PPD.isTouch ? 0.42 : 0.62,
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
        // v2.1 特效分离：战斗奖励仅尾影/溅射，球衣与拍面恒=队服；联机无队伍，默认红蓝
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
      /* 〔2026-10-23 忠于原图 + 性能〕观众密度：电脑 0.62 / 手机 0.42。
         曾按"原图是密排光海"调到 0.8，但实测静态层重建 9.8ms、动画层 30Hz 烘焙 9.2ms，
         边跑边重建会明显掉帧；0.62 时重建约 6.8ms，密度观感与原图仍属同一档。 */
      density: PPD.isTouch ? 0.42 : 0.62,
      noCrowd: PPD.app.mode === 'online' || !!(PPD.app.noCrowd), // 联机自动关 / 用户勾选关闭环境观众
    };
  }

  // ---------- 渲染 ----------
  function makeCam(side, followX, vx, vy, vw, vh) {
    const cam = new PPD.TTG.Camera();
    // 死区跟随：角色在台面中部 ±0.62m 内时相机不动，避免"按左球往右跑"的反直觉感
    const camX = followX - PPD.TTG.clamp(followX, -0.62, 0.62);
    /* 〔2026-10-23 参考图底板〕机位**标定到底板**，不是手调：
       底板 public/assets/arena/arena_plate.jpg 里已经画死球台，
       用 tools/solve-arena-camera.cjs 把真实球台四角投影对齐到底板上量出的四角，
       解得 eyeY 3.20 / |z| 3.35 / lookY 1.70 / focal 0.50×vw（残差 4e-4）。
       这样用同一相机画的球员会正好站在底板的球台上，不会错位。 */
    /* 〔2026-10-23 新参考图机位反解 v8〕目标地标（tools/measure-ref2.py 实测，
       参考图 1450×1085）：
       台远边 y 0.545 / 台近边 y 0.70 / 台宽（中线）0.284W /
       己方头顶 0.58、脚 0.91 / 对方头顶 0.40。
       ⚠ v7 及以前的最大坑：求解器把「世界 +x 投到屏幕左侧」搞反了
       （Camera.right = cross(fwd, up)，相机朝 +z 看时 right 指向 -x），
       台宽约束全程反向 ⇒ 误判"参考图透视无解、只能折中"，机位被压到
       0.86×W / 6.5m（台宽只有 0.19W、球员显小）。修正符号后加权拟合
       cost 0.0077（v7 为 0.14+），六个地标同时命中。
       〔v8b 用户指定俯角 30°〕相机高度上抬：eyeY 3.80 → **7.43**、lookY 1.30 → **1.60**、
       focal 1.75 → **2.00×vw**。俯角 = atan((eyeY-lookY)/|eyeZ|) = **30.0°**（原 13.9°）。
       俯角加大后台面透视压缩、显小，故焦距同步 1.75→2.00 补回台宽
       （0.224W → 0.252W，参考图 0.284W）。
       ⇒ farY 0.509 / nearY 0.846 / 台宽 0.252W / 己方头顶 0.715、脚 1.036（出画）
          / 对方头顶 0.332。
       副作用是好的：分屏竖屏时纵向视野反而比旧机位窄（旧 0.86× 在 195×844
       视口里纵向 FOV 151°，新 2.00× 只有 92°），不会照进一堆地板。 */
    const eye = PPD.TTG.v3(camX, 7.43, (side === 0 ? -10.10 : 10.10) + camX * 0.05);
    const look = PPD.TTG.v3(camX * 0.55, 1.60, 0);
    const focal = vw * 2.00;
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
        // 右半屏不镜像：相机 cx 含半屏偏移，必须用画布绝对坐标
        // （旧实现 ctxX=clientX-half 会让 P2 落点整体偏到台外）
        ctxX = clientX;
      }
      const fp = PPD.app.cameraView === 'first' && PPD.app.fpCams ? PPD.app.fpCams[side] : null;
      cam = fp || makeCam(side, eng ? eng.players[side].x : 0, side === 0 ? 0 : half, 0, half, h);
    } else if (PPD.app.mode === 'ai') {
      clientX = clampN(clientX, 0, w);
      ctxX = w - clientX; // 红方视口已镜像
      // 第一人称：复用本帧渲染相机（视线在发球相锁定，反投影稳定）；无帧时退回第三人称
      const fp = PPD.app.cameraView === 'first'
        ? (PPD.app.fpCams ? PPD.app.fpCams[0] : null) || PPD.app.fpCam
        : null;
      cam = fp || makeCam(0, PPD.app.engine ? PPD.app.engine.players[0].x : 0, 0, 0, w, h);
    } else {
      clientX = clampN(clientX, 0, w);
      ctxX = side === 0 ? w - clientX : clientX;
      const snap = PPD.app.snapB;
      const myX = snap && snap.p && snap.p[side] ? snap.p[side].x : 0;
      const fp = PPD.app.cameraView === 'first' && PPD.app.fpCams ? PPD.app.fpCams[side] : null;
      cam = fp || makeCam(side, myX, 0, 0, w, h);
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
  /* 铺参考图底板：必须在 applyViewMirror **之前**调用（镜像会把它左右翻反）。
     底板里已经画好球台/球网/光海/光锥/地板/看台，所以后面不再画这些。 */
  function paintArenaPlate(w, h, keepTransform) {
    const T = PPD.TTG;
    if (T && T.plateReady && T.plateReady()) {
      PPD.ctx.save();
      // keepTransform：震屏/推近时底片必须与球员一起动，否则球员会在静态底片上"滑动"
      if (!keepTransform) PPD.ctx.setTransform(1, 0, 0, 1, 0, 0);
      T.drawArenaPlate(PPD.ctx, w, h);
      PPD.ctx.restore();
    }
  }

  function applyViewMirror(ctx, w, vx) {
    // 视口镜像：绕视口右边界翻；vx=0 时与原来的 translate(w) 等价
    ctx.translate(2 * (vx || 0) + w, 0);
    ctx.scale(-1, 1);
  }

  function renderLocal() {
    const w = PPD.app.resizeW, h = PPD.app.resizeH;
    const half = Math.floor(w / 2);
    PPD.ctx.clearRect(0, 0, w, h);
    if (PPD.app.cameraView === 'first') {
      // 本地分屏第一人称：两半各一台 FP 相机 + 各自的视线平滑/视图模型/3D HUD
      const view0 = viewModelFromEngine(PPD.app.engine, 0);
      updateTrail(view0);
      const view1 = viewModelFromEngine(PPD.app.engine, 1);
      view1.trail = view0.trail;
      renderFirstPersonView(view0, 0, 0, 0, half, h, { key: PPD.app.engine, slot: 'local:0' });
      renderFirstPersonView(view1, 1, half, 0, w - half, h, { key: PPD.app.engine, slot: 'local:1' });
      // 分隔线画在视口渲染之外（否则会被各自的镜像/裁剪吃掉）。
      // P1/P2 的“视角”小字在 FP 下省略：DOM 比分栏已标名字，且顶部左右角被
      // netInfo 与设置/退出按钮占用，硬放会压字。
      PPD.ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      PPD.ctx.lineWidth = 2;
      PPD.ctx.beginPath();
      PPD.ctx.moveTo(half, 0); PPD.ctx.lineTo(half, h); PPD.ctx.stroke();
      return;
    }
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
      juiceTransform(PPD.ctx, side === 0 ? 0 : half, 0, half, h);
      if (side === 0) applyViewMirror(PPD.ctx, half);
      // 底片不跟着镜像（否则左橙右青会反），球员/球仍跟着镜像
      view.plateFlip = side === 0;
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
    if (PPD.app.cameraView === 'first') {
      // 联机第一人称：view 用快照插值/本地预测，其余与 AI/本地共用视口渲染
      renderFirstPersonView(view, PPD.app.side, 0, 0, w, h, { key: 'online', slot: 'online:' + PPD.app.side });
      return;
    }
    const myX = PPD.app.pred ? PPD.app.pred.x : snap.p[PPD.app.side].x;
    const cam = makeCam(PPD.app.side, myX, 0, 0, w, h);
    view.cam = cam;
    PPD.ctx.save();
    juiceTransform(PPD.ctx, 0, 0, w, h);
    PPD.ctx.save();
    if (PPD.app.side === 0) applyViewMirror(PPD.ctx, w);
    view.plateFlip = PPD.app.side === 0;
    PPD.TTG.drawScene(PPD.ctx, view, w, h);
    PPD.ctx.restore();
    PPD.ctx.restore();
  }

  function renderSingle() {
    // 人机模式：单人全屏视角（自己=红方）；第一人称走独立渲染入口
    if (PPD.app.cameraView === 'first') { renderFirstPerson(0); return; }
    const w = PPD.app.resizeW, h = PPD.app.resizeH;
    PPD.ctx.clearRect(0, 0, w, h);
    PPD.ctx.save();
    const juiced = juiceTransform(PPD.ctx, 0, 0, w, h);
    paintArenaPlate(w, h, juiced); // 底片在镜像之外铺；震屏时随画面一起动
    const view = viewModelFromEngine(PPD.app.engine, 0);
    updateTrail(view);
    const cam = makeCam(0, PPD.app.engine.players[0].x, 0, 0, w, h);
    view.cam = cam;
    PPD.ctx.save();
    applyViewMirror(PPD.ctx, w);
    PPD.TTG.drawScene(PPD.ctx, view, w, h);
    PPD.ctx.restore();
    PPD.ctx.restore();
  }

  // ---------- 主页菜单场景（P0 垂直切片 2026-10-24） ----------
  // 主页复用比赛美术资产的渲染路径：合成 view（不依赖引擎实例）画「预备球场」——
  // 两名球员按引擎默认站位（±PLAYER_Z）站预备位、各一束聚光灯（drawScene 尾部
  // 的 overlay 灯光按 players 画锥形光），无球、无观众（noCrowd）、无比分 HUD。
  // 队色取主页当前敌我配置（resolveMatchTeams('ai') 只读 teams.js 槽位，无副作用）。
  // P1 将把待机姿势扩成动作集、并让相机参数随视觉稿精调；此处先给可跑的底线版本。
  function makeMenuCam(vw, vh) {
    const cam = new PPD.TTG.Camera();
    // 对局机位（makeCam：eyeY 7.43 / |z| 10.10 / focal 2.00×vw）的「拉远」变体。
    // 〔2026-10-25 用户反馈〕1.4× 放大（focal 1.30→1.82）：球台约占屏宽 0.30，
    // 消除空旷感、聚光灯光束更有存在感。
    const eye = PPD.TTG.v3(0, 8.2, -12.6);
    const look = PPD.TTG.v3(0, 0.95, 0.2);
    cam.set(eye, look, vw / 2, vh / 2, vw * 1.82);
    return cam;
  }

  // 待机动作集（P1-b 轻量姿势动作，纯时间驱动、零新美术）：
  // 14s 一轮的动作时间表，两人错相 7s 避免同步机械感——
  //   0–6s    呼吸 + 重心微摆（横移 ±4cm、侧倾 ±0.06）
  //   6–7.2s  空挥拍（推球/扣杀逐轮交替：走既有 stroke 动画，球拍随弧线前送上抬）
  //   8.5–9.6s 蹲起弹跳（0.6s 蹲姿 + 起身，预演低球防守）
  //   10.5–12s 横向移位还原（±0.14m 往返，步法重心转移）
  //   12–14s  回中站定
  // stroke.t/dur 交给 drawCharacter 既有缓动；crouch 为 0/1 二值，平滑由其躯干 lerp 完成。
  function idleAction(side, t) {
    const off = side === 0 ? 0 : 7;
    const T = (t + off) % 14;
    const cycle = Math.floor((t + off) / 14);
    let x = 0, lean = 0, crouch = 0, paddleArc = 0;
    let stroke = { active: false, type: 0, t: 0, dur: 0.5, hit: false };
    if (T < 6) {
      const s = Math.sin(T * 1.1);
      x = s * 0.04;
      lean = s * 0.06;
    } else if (T < 7.2) {
      const p = (T - 6) / 1.2;
      stroke = { active: true, type: cycle % 2 === 0 ? 0 : 2, t: (T - 6), dur: 1.2, hit: false };
      paddleArc = Math.sin(p * Math.PI);
      lean = -0.05 * paddleArc;
    } else if (T >= 8.5 && T < 9.6) {
      crouch = (T - 8.5) < 0.6 ? 1 : 0;
      lean = 0.04;
    } else if (T >= 10.5 && T < 12) {
      const p = (T - 10.5) / 1.5;
      x = Math.sin(p * Math.PI * 2) * 0.14;
      lean = x * 0.5;
    }
    return { x, lean, crouch, stroke, paddleArc };
  }

  // 待机球员（合成）：与 viewModelFromEngine 的 player 字段同构，
  // stroke 驱动挥拍动画、idleAction 提供整套待机小动作（P1-b）。
  function menuIdlePlayer(side, t, teamColor) {
    const f = side === 0 ? 1 : -1;
    const R = PPD.TT.RULES;
    const z = side === 0 ? -R.PLAYER_Z : R.PLAYER_Z;
    const a = idleAction(side, t);
    // 球拍：静止在持拍位；空挥拍时随弧线前送 + 上抬（视觉腕点，非判定）
    const arc = a.paddleArc;
    return {
      side,
      x: a.x,
      z,
      vx: 0, vz: 0,
      lean: a.lean,
      facing: f,
      stroke: a.stroke,
      paddle: {
        p: { x: a.x + 0.26 - 0.10 * arc, y: 1.02 + 0.18 * arc, z: z + f * (0.34 + 0.30 * arc) },
        n: { x: 0, y: 1, z: 0 },
        v: { x: 0, y: 0, z: 0 },
      },
      sb: 0.35 * arc, // 挥拍回摆动量（drawCharacter 用作击球后的手臂回摆权重）
      crouch: a.crouch,
      run: 0,
      teamColor: teamColor || null,
      warnSmash: 0, warnT: 0, exclaimT: 0,
    };
  }

  function renderMenuScene(nowMs) {
    const w = PPD.app.resizeW, h = PPD.app.resizeH;
    if (!w || !h) return; // 测试桩/未 resize：跳过（NaN/0 都为 falsy）
    PPD.ctx.clearRect(0, 0, w, h);
    const t = ((nowMs || Date.now()) % 3600000) / 1000;
    let teams = null;
    try { teams = PPD.resolveMatchTeams ? PPD.resolveMatchTeams('ai') : null; } catch (e) { teams = null; }
    const view = {
      side: 0,
      players: [
        menuIdlePlayer(0, t, teams && teams[0] && teams[0].color),
        menuIdlePlayer(1, t, teams && teams[1] && teams[1].color),
      ],
      ball: null,
      ballInHand: null,
      time: t,
      phase: 'idle',
      score: [0, 0],
      server: 0,
      pointReason: null,
      fx: [],
      fan: PPD.app.fan,
      servePath: null,
      trail: null,
      trailHidden: true,
      low: !!(PPD.app.quality && PPD.app.quality.low),
      showHitRanges: false,
      density: PPD.isTouch ? 0.42 : 0.62,
      noCrowd: true,   // 主页洁净：暂略观众席（观众在对局画面出现）
      teamFixed: true,
    };
    view.cam = makeMenuCam(w, h);
    // 名字牌投影（2026-10-25 再修）：head=头顶上方 8cm（1.80m，tag 底边贴此点——透视自动让
    // 远端/近端都紧贴头顶）、body=躯干 0.95m（点击热区中心）。
    try {
      const cam = view.cam;
      PPD.app.menuProj = view.players.map((p) => {
        const head = cam.project(PPD.TTG.v3(p.x, 1.8, p.z));
        const body = cam.project(PPD.TTG.v3(p.x, 0.95, p.z));
        if (!head || !body) return null;
        return { x: head.x, y: head.y, bx: body.x, by: body.y, s: head.s };
      });
    } catch (e) { PPD.app.menuProj = null; /* 桩环境无投影 */ }
    // 菜单场景提亮：对局暗场灯光按参考图标定（上缘压暗 0.58 / 四角暗角 0.45），
    // 主页要「洁净明亮、球员完整可读」——渲染期间临时调低压暗与暗角，finally 恢复。
    // 菜单走 noCrowd 直绘路径（不进观众席缓存），改值只影响本帧，不污染对局画面。
    const LA = PPD.TTG.LIGHT_AMB;
    const saved = {
      darkTop: LA.darkTop, darkMid: LA.darkMid, darkBottom: LA.darkBottom,
      vigSide: LA.vigSide, vigCorner: LA.vigCorner,
    };
    try {
      LA.darkTop = 0.30; LA.darkMid = 0.10; LA.darkBottom = 0.12;
      LA.vigSide = 0.10; LA.vigCorner = 0.26;
      // 〔2026-10-25 用户反馈〕与对局同管线镜像视口（红方视角约定「屏幕左=己方红」）——
      // 此前漏镜像导致主页环境色左蓝右红、与正式画面相反，转场时两边颜色互换。
      PPD.ctx.save();
      applyViewMirror(PPD.ctx, w);
      PPD.TTG.drawScene(PPD.ctx, view, w, h);
      PPD.ctx.restore();
      // 画布已镜像：投影 x 同步翻转，名字牌/热区 DOM 才与画面中的球员对齐
      if (PPD.app.menuProj) {
        for (const pr of PPD.app.menuProj) {
          if (!pr) continue;
          pr.x = w - pr.x;
          pr.bx = w - pr.bx;
        }
      }
    } finally {
      LA.darkTop = saved.darkTop; LA.darkMid = saved.darkMid; LA.darkBottom = saved.darkBottom;
      LA.vigSide = saved.vigSide; LA.vigCorner = saved.vigCorner;
    }
  }


  // ---------- P3 看台视角：边线高位机位（电视转播位） ----------
  // 球台纵向摆向不变（甲近乙远）；机位从球场侧面看台高处取景：沿台面宽度方向（x）拉出、
  // 升高、镜头对准球台中心——成画面：两名球员一左一右、球台横向铺满、球网竖在中央、
  // 对面看台做背景。参数标定后经浏览器截图校验（P3）。
  function makeSideCam(vw, vh) {
    const cam = new PPD.TTG.Camera();
    const eye = PPD.TTG.v3(5.6, 4.6, 0);      // 台宽（±0.76m）外右侧看台高位
    const look = PPD.TTG.v3(0, 0.55, 0);      // 台面中心略低（视线俯角覆盖全场）
    cam.set(eye, look, vw / 2, vh / 2, vw * 1.05);
    return cam;
  }

  // AI对打·看台视角渲染：与 renderSingle 同源 view（无镜像、不铺参考图底板——侧面机位与底板机位不符）
  function renderSide() {
    const w = PPD.app.resizeW, h = PPD.app.resizeH;
    if (!w || !h) return;
    PPD.ctx.clearRect(0, 0, w, h);
    const view = viewModelFromEngine(PPD.app.engine, 0);
    updateTrail(view);
    view.cam = makeSideCam(w, h);
    PPD.ctx.save();
    juiceTransform(PPD.ctx, 0, 0, w, h);
    PPD.TTG.drawScene(PPD.ctx, view, w, h);
    PPD.ctx.restore();
  }

  // AI对打·球员视角（跟随某一方）：借用该方现有第三人称机位（红方视角镜像、蓝方不镜像）
  function renderWatch() {
    const s = PPD.app.aiFollowSide === 1 ? 1 : 0;
    if (PPD.app.cameraView === 'first') { renderFirstPerson(s); return; }
    const w = PPD.app.resizeW, h = PPD.app.resizeH;
    if (!w || !h) return;
    PPD.ctx.clearRect(0, 0, w, h);
    const view = viewModelFromEngine(PPD.app.engine, s);
    updateTrail(view);
    const cam = makeCam(s, PPD.app.engine.players[s].x, 0, 0, w, h);
    view.cam = cam;
    PPD.ctx.save();
    juiceTransform(PPD.ctx, 0, 0, w, h);
    PPD.ctx.save();
    if (s === 0) applyViewMirror(PPD.ctx, w);
    PPD.TTG.drawScene(PPD.ctx, view, w, h);
    PPD.ctx.restore();
    PPD.ctx.restore();
  }

  // ---------- 第一人称（人机 / 本地分屏 / 联机 / AI 观战 / 回放） ----------
  /* 只切渲染机位，不动物理/联机协议。三个关键取舍：
     1. 视线：眼高 ~1.62m，注视点固定落在网后 2.6m、台面高度附近；球在台上时轻微跟球。
        发球相锁定固定视线——发球瞄准靠 unprojectToTable 反投影，相机一跟球准星就会漂。
     2. 视野：主视口是 2.0×屏宽长焦，第一人称必须换广角（约 80° 水平 FOV），否则对手/台面只剩一条。
     3. 己方身体：drawScene 前过滤掉己方球员（世界空间火柴人近看会穿帮），
        手臂/球拍改由 drawFirstPersonView 在镜像之外画；文字 HUD 同理不镜像。 */
  const FP = {
    eyeY: 1.86,       // 眼位抬高：能同时看到近端台沿与对手
    back: 1.15,       // 眼位在球员身后（不是贴着脸/台面）
    ahead: 2.6,
    gazeY: 1.05,
    leanMax: 0.10,    // W/S 上身/球拍前倾幅度（过大易晕）
    follow: 0.06,     // 跟球权重（1.0=完全追球；越小越稳）
  };

  function fpDamp(cur, target, rate, dt) {
    return cur + (target - cur) * Math.min(1, Math.max(0, dt) * rate);
  }

  function makeFirstPersonCam(side, player, viewCtx, vx, vy, vw, vh, slot) {
    const T = PPD.TTG;
    const f = side === 0 ? 1 : -1;
    const now = (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) / 1000;
    if (!PPD.app.fpGaze) PPD.app.fpGaze = {};
    const key = viewCtx.key;
    let st = PPD.app.fpGaze[slot];
    const fresh = !st || st.key !== key || st.side !== side;
    const dt = fresh ? 0.016 : Math.min(0.05, Math.max(0.001, now - st.t));
    const crouch = player.crouch || 0;
    const speed = Math.hypot(player.vx || 0, player.vz || 0);
    const t = Number.isFinite(viewCtx.time) ? viewCtx.time : now;
    const bob = Math.sin(t * 2.3) * 0.002 + Math.sin(t * 8.7) * 0.0012 * Math.min(1, speed / 3);
    // 发球方持球：视线锁定（不跟球、不跟瞄准），保证反投影落点稳定
    const serving = viewCtx.phase === 'serve' && viewCtx.server === side;
    /* W/S 上身/球拍前倾：脚仍受台面禁区限制，只让眼位与接球点前探/后坐。
       vz 是引擎/快照里的前后速度（side 0 向网为 +，side 1 向网为 -），乘 f 统一成“向网前”为正。
       发球相锁定为 0，避免准星随移动漂；幅度压小，减少晕 3D。 */
    const fwdLean = T.clamp((player.vz || 0) * f / 3.2, -1, 1);
    const lean = serving ? 0 : fwdLean;
    const leanZ = lean * FP.leanMax;
    const eyeY = FP.eyeY - 0.16 * crouch + bob - 0.02 * Math.max(0, lean);
    // 眼位在球员身后 FP.back（保留原来 +0.08 的前移修正），前倾时向网前挪 leanZ
    const eyeZ = player.z + f * (0.08 - FP.back + leanZ);
    const ex = fresh ? player.x : fpDamp(st.ex, player.x, 22, dt);
    let tx = player.x, ty = FP.gazeY, tz = eyeZ + f * FP.ahead;
    const ball = viewCtx.ball;
    if (!serving && ball && viewCtx.phase === 'play') {
      // 轻微跟球（权重 0.10）：只做提示，不再大幅甩头
      tx = tx * (1 - FP.follow) + ball.x * FP.follow;
      ty = ty + T.clamp(ball.y - 1.0, -0.35, 1.0) * 0.12;
      tz = tz + (ball.z - tz) * FP.follow;
    }
    ty = T.clamp(ty, 0.72, 1.45);
    if (fresh) {
      st = { key, side, ex, ey: eyeY, ez: eyeZ, tx, ty, tz, t: now };
      PPD.app.fpGaze[slot] = st;
    } else {
      st.ex = ex;
      st.ey = eyeY;
      st.ez = eyeZ;
      // 发球相直接吸附（视线固定）；对打/得分相平滑跟球
      st.tx = serving ? tx : fpDamp(st.tx, tx, 4.2, dt);
      st.ty = serving ? ty : fpDamp(st.ty, ty, 4.2, dt);
      st.tz = serving ? tz : fpDamp(st.tz, tz, 4.2, dt);
      st.t = now;
    }
    const cam = new T.Camera();
    const eye = T.v3(st.ex, st.ey, st.ez);
    const look = T.v3(st.tx, st.ty, st.tz);
    // 视野略收窄（约 84° 水平），减少广角边缘的眩晕感
    const focal = Math.max(vw * 0.56, Math.min(vh * 0.95, vw * 0.95));
    cam.set(eye, look, vx + vw / 2, vy + vh / 2, focal);
    return cam;
  }

  function fpRoundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function fpTextW(ctx, text, fs) {
    try {
      const m = ctx.measureText ? ctx.measureText(String(text)) : null;
      if (m && Number.isFinite(m.width)) return m.width;
    } catch (e) { /* 测试桩无 measureText 返回值 */ }
    return String(text).length * fs * 0.6;
  }

  // 第一人称手臂 + 球拍：屏幕空间视图模型，不参与世界投影/碰撞判定。
  // 位置/挥拍幅度由 paddle.p / stroke / sb 驱动——与第三人称看到的是同一套动作。
  function drawFirstPersonView(ctx, side, pl, view, vx, vy, vw, vh) {
    if (!pl) return;
    const T = PPD.TTG;
    const mirrored = side === 0;
    const team = pl.teamColor || (side === 0 ? '#d0321e' : '#2563eb');
    const st = pl.stroke || { active: false, type: 0, t: 0, dur: 0.4, hit: false };
    const prog = st.active ? T.clamp(st.t / (st.dur || 0.4), 0, 1) : 0;
    const sw = st.active ? Math.sin(prog * Math.PI) : 0;
    const drive = st.type === 2 || st.type === 3;
    const back = T.clamp(pl.sb || 0, 0, 1.2);
    // W/S 上身/球拍前倾：脚不动，视图模型前探/后坐（发球相不倾，保持持球稳定）
    const fwd = (view && view.phase === 'serve')
      ? 0
      : T.clamp((pl.vz || 0) * (mirrored ? 1 : -1) / 3.2, -1, 1);
    const leanLift = fwd * 0.018 * vh;
    /* 两名球员都是右手持拍：第一人称手位统一在各自半屏的右侧，与第三人称右臂一致。
       旧代码按 side 镜像（P2 手在左），分屏时两只手都挤在分隔线附近，且 P2 看起来是左手持拍。 */
    const baseX = vx + vw * 0.64;
    const baseY = vy + vh * 0.84 - leanLift;
    const scale = Math.min(vw, vh) / 720;
    const sizeBase = 128 * scale * (1 + fwd * 0.03);
    const dir = -1; // 挥拍时向身体中线收（右手持拍：向左收）
    let px = baseX + dir * sw * (drive ? 0.035 : 0.018) * vw;
    let py = baseY + T.clamp(pl.crouch || 0, 0, 1) * 0.035 * vh -
      sw * (drive ? 0.10 : 0.055) * vh + back * 0.02 * vh;

    /* 视觉接触：球在接球箱内或挥拍命中时，球拍/手臂追到球的屏幕投影。
       判定仍是引擎的接球箱（不改物理）；这里只补“手碰到球”的视觉。
       reach 做平滑：挥拍时快速伸手，收拍后缓慢收回，避免一帧大跳。 */
    let targetReach = 0;
    let rtx = px, rty = py;
    const ball = view && view.ball;
    if (ball && view.phase === 'play' && view.cam) {
      const R = PPD.TT.RULES;
      const hz = pl.z + (pl.facing || 0) * R.HITBOX_Z_OFF;
      const yTop = pl.crouch ? R.CROUCH_HITBOX_Y_TOP : R.HITBOX_Y_TOP;
      const yBottom = pl.crouch ? R.CROUCH_HITBOX_Y_BOTTOM : R.HITBOX_Y_BOTTOM;
      const inBox = Math.abs(ball.pos.x - pl.x) < R.HITBOX_HX &&
        Math.abs(ball.pos.z - hz) < R.HITBOX_HZ &&
        ball.pos.y > yBottom && ball.pos.y < yTop;
      if (inBox || (st.active && st.hit)) {
        const q = view.cam.project(ball.pos);
        if (q) {
          const sx = fpAnchorX(mirrored, vx, vw, q.x);
          const sy = q.y;
          rtx = T.clamp(sx, vx + vw * 0.16, vx + vw * 0.84);
          rty = T.clamp(sy, vy + vh * 0.50, vy + vh * 0.82);
          targetReach = st.hit ? 1 : (st.active ? T.clamp(prog * 1.6, 0, 0.85) : 0.45);
        }
      }
    }
    if (!PPD.app.fpReach) PPD.app.fpReach = [0, 0];
    const prevReach = PPD.app.fpReach[side] || 0;
    const reach = prevReach + (targetReach - prevReach) * (targetReach > prevReach ? 0.35 : 0.18);
    PPD.app.fpReach[side] = reach;
    px += (rtx - px) * reach;
    py += (rty - py) * reach;
    // 手伸到球附近时按距离缩小拍面：128px 是“贴近镜头”的尺寸，伸到台面中部只用约 60%
    const size = sizeBase * (1 - reach * 0.42);
    const rot = -0.22 + sw * (drive ? 0.55 : 0.30) + back * 0.10;
    const handleD = size * 0.52;
    const hx = px - Math.sin(rot) * handleD;
    const hy = py + Math.cos(rot) * handleD;
    const armX = baseX + vw * 0.30;
    const armY = vy + vh * 1.10 - leanLift;
    const ctrlX = hx + (armX - hx) * 0.45 - vw * 0.03;
    const ctrlY = hy + (armY - hy) * 0.42;

    ctx.save();
    // 前臂：深色骨线 + 浅色轮廓，暗场里也能看清
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(armX, armY);
    ctx.quadraticCurveTo(ctrlX, ctrlY, hx, hy);
    ctx.strokeStyle = 'rgba(8,12,18,0.96)';
    ctx.lineWidth = size * 0.20;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = Math.max(1, size * 0.035);
    ctx.stroke();

    // 球拍：背向玩家 → 深色底 + 队色边缘/内圈；手柄朝手臂方向
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rot);
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = size * 0.22;
    ctx.shadowOffsetY = size * 0.10;
    ctx.beginPath();
    ctx.ellipse(0, 0, size * 0.50, size * 0.42, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,26,34,0.96)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(240,246,255,0.20)';
    ctx.lineWidth = Math.max(1, size * 0.022);
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    // 队色内面（背向玩家时仍能一眼认出这是谁的拍）
    ctx.beginPath();
    ctx.ellipse(0, 0, size * 0.41, size * 0.33, 0, 0, Math.PI * 2);
    ctx.globalAlpha = 0.24;
    ctx.fillStyle = team;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = team;
    ctx.lineWidth = Math.max(2, size * 0.055);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0, size * 0.40, size * 0.32, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = Math.max(1, size * 0.018);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-size * 0.14, -size * 0.12, size * 0.20, Math.PI * 1.05, Math.PI * 1.62);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = Math.max(1, size * 0.025);
    ctx.stroke();
    fpRoundRect(ctx, -size * 0.075, size * 0.36, size * 0.15, size * 0.30, size * 0.05);
    ctx.fillStyle = '#8a5a34';
    ctx.fill();
    ctx.strokeStyle = 'rgba(15,20,30,0.65)';
    ctx.lineWidth = Math.max(1, size * 0.018);
    ctx.stroke();
    // 握拍手：拍柄末端一个深色拳点，避免手臂像一根悬空的杆
    ctx.beginPath();
    ctx.arc(0, size * 0.70, size * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(12,16,22,0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = Math.max(1, size * 0.02);
    ctx.stroke();
    ctx.restore();

    // 持球（发球）：只有己方发球时，球才在自己拍面上方（对手持球不画到自己手里）
    if (view && view.ballInHand && view.server === side) {
      const bx = px - size * 0.05;
      const by = py - size * 0.58;
      ctx.beginPath();
      ctx.arc(bx, by, size * 0.072, 0, Math.PI * 2);
      ctx.fillStyle = '#f4f7fb';
      ctx.fill();
      ctx.strokeStyle = 'rgba(15,20,30,0.35)';
      ctx.lineWidth = Math.max(1, size * 0.012);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(bx - size * 0.02, by - size * 0.025, size * 0.022, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fill();
    }
    // 击球瞬间的拍面闪光
    if (st.active && st.hit && prog < 0.55) {
      ctx.beginPath();
      ctx.arc(px, py, size * 0.62, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,220,150,${(0.22 * (1 - prog / 0.55)).toFixed(3)})`;
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------- 世界锚定 3D HUD ----------
  /* 世界层（红方）是镜像绘制的，文字层在镜像之外画 → 锚点 x 要按镜像翻一次。
     HUD 只读 view/cam，不参与判定；原型阶段固定开启。 */
  function fpAnchorX(mirrored, vx, vw, x) {
    return mirrored ? (2 * vx + vw - x) : x;
  }

  function fpPill(ctx, x, y, text, fs, dotColor, alpha) {
    const padX = fs * 0.7, padY = fs * 0.38;
    const tw = fpTextW(ctx, text, fs);
    const pw = tw + padX * 2 + (dotColor ? fs * 1.05 : 0);
    const ph = fs + padY * 2;
    const left = x - pw / 2, top = y - ph / 2;
    ctx.globalAlpha = alpha == null ? 0.9 : alpha;
    fpRoundRect(ctx, left, top, pw, ph, ph / 2);
    ctx.fillStyle = 'rgba(8,12,20,0.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();
    let tx = left + padX;
    if (dotColor) {
      ctx.beginPath();
      ctx.arc(tx + fs * 0.30, y, fs * 0.30, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
      tx += fs * 1.05;
    }
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#eaf1ff';
    ctx.fillText(text, tx, y + 0.5);
    ctx.globalAlpha = 1;
    return pw;
  }

  function fpNameTag(ctx, x, y, text, color, fs, dim) {
    const padX = fs * 0.7, h = fs * 1.9;
    const tw = fpTextW(ctx, text, fs);
    const w = tw + padX * 2 + fs * 0.95;
    const left = x - w / 2, top = y - h;
    ctx.globalAlpha = dim;
    fpRoundRect(ctx, left, top, w, h, h * 0.34);
    ctx.fillStyle = 'rgba(8,12,20,0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // 指向头顶的小三角
    ctx.beginPath();
    ctx.moveTo(x - fs * 0.32, top + h);
    ctx.lineTo(x + fs * 0.32, top + h);
    ctx.lineTo(x, top + h + fs * 0.34);
    ctx.closePath();
    ctx.fillStyle = 'rgba(8,12,20,0.78)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(left + padX + fs * 0.28, top + h / 2, fs * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f2f7ff';
    ctx.fillText(text, left + padX + fs * 0.95, top + h / 2 + 0.5);
    ctx.globalAlpha = 1;
  }

  function fpBallReadout(ctx, x, y, spin, fs) {
    const spinY = spin ? spin.y : 0;
    if (Math.abs(spinY) <= 1.5) return;
    fpPill(ctx, x, y, spinY > 0 ? '↻' : '↺', fs, null, 0.78);
  }

  function fpLandingReticle(ctx, cam, vx, vy, vw, vh, mirrored, pt) {
    if (!pt) return;
    const R = PPD.TT.RULES;
    const y = R.TABLE_HEIGHT + 0.004;
    const rad = 0.09;
    const N = 24;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const p = cam.project(PPD.TTG.v3(pt.x + Math.cos(a) * rad, y, pt.z + Math.sin(a) * rad));
      if (!p) return;
      pts.push({ x: fpAnchorX(mirrored, vx, vw, p.x), y: p.y });
    }
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,196,120,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.setLineDash([]);
    const c = cam.project(PPD.TTG.v3(pt.x, y, pt.z));
    if (c) {
      const cx = fpAnchorX(mirrored, vx, vw, c.x);
      ctx.beginPath();
      ctx.arc(cx, c.y, Math.max(2, 0.018 * c.s), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,196,120,0.95)';
      ctx.fill();
      // 落点上方竖起一小段，帮助判断落点纵深（第一人称最缺深度线索）
      const top = cam.project(PPD.TTG.v3(pt.x, y + 0.22, pt.z));
      if (top) {
        ctx.beginPath();
        ctx.moveTo(cx, c.y);
        ctx.lineTo(fpAnchorX(mirrored, vx, vw, top.x), top.y);
        ctx.strokeStyle = 'rgba(255,196,120,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // 球出画（或钻到相机身后）时，在屏幕边缘给方向箭头——第一人称没有这个会完全丢失球
  function fpOffscreenBall(ctx, cam, vx, vy, vw, vh, mirrored, ball, time) {
    if (!ball) return false;
    const T = PPD.TTG;
    const p = cam.project(ball.pos);
    const margin = 18;
    if (p && p.x > vx - margin && p.x < vx + vw + margin && p.y > vy - margin && p.y < vy + vh + margin) return false;
    const d = T.vsub(ball.pos, cam.eye);
    let ux = T.vdot(d, cam.right);
    let uy = -T.vdot(d, cam.up);
    const z = T.vdot(d, cam.fwd);
    if (z <= 0.12) {
      // 球在身后：只指向最近的一侧，避免箭头绕圈
      ux = ux >= 0 ? 1 : -1;
      uy = 0.15;
    }
    if (Math.abs(ux) < 1e-6 && Math.abs(uy) < 1e-6) return false;
    const len = Math.hypot(ux, uy) || 1;
    ux /= len; uy /= len;
    if (mirrored) ux = -ux;
    const rx = Math.min(vw, vh) * 0.44;
    const sx = T.clamp(vx + vw / 2 + ux * rx, vx + 26, vx + vw - 26);
    const sy = T.clamp(vy + vh / 2 + uy * rx, vy + 80, vy + vh - 26);
    const ang = Math.atan2(uy, ux);
    const pulse = 0.72 + 0.28 * Math.sin((time || 0) * 8);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(ang);
    ctx.globalAlpha = pulse;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-9, -9);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-9, 9);
    ctx.closePath();
    ctx.fillStyle = 'rgba(235,246,255,0.92)';
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
    // 外圈脉冲：球在画面外时也足够醒目（第一人称最怕不知道球在哪）
    ctx.beginPath();
    ctx.arc(sx, sy, 21, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(235,246,255,${(0.18 + 0.16 * pulse).toFixed(3)})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx - ux * 20, sy - uy * 20, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(235,246,255,0.85)';
    ctx.fill();
    return true;
  }

  function drawFirstPersonHud(ctx, side, view, cam, vx, vy, vw, vh) {
    ctx.save();
    const mirrored = side === 0;
    const phase = view.phase; // AI/本地=引擎相位；联机/回放=快照相位
    const opp = view.players && view.players.length ? view.players[0] : null;
    // 对手名牌（世界锚定在头顶上方；放在头部右侧，避开顶部比分栏与阶段横幅）
    if (opp) {
      const q = cam.project(PPD.TTG.v3(opp.x, 1.88, opp.z));
      if (q && q.x > vx - 40 && q.x < vx + vw + 40 && q.y > vy - 40 && q.y < vy + vh + 40) {
        const headX = fpAnchorX(mirrored, vx, vw, q.x);
        const headY = q.y + Math.max(2, 0.02 * q.s);
        const tagX = PPD.TTG.clamp(headX + 52, vx + 150, vx + vw - 150);
        // 下限按 DOM 顶部 HUD（比分栏 ~64px + 提示条 ~76~100px）留出空间，
        // 否则跟球俯视时对手上移，名牌会钻到提示条后面
        const tagY = Math.max(vy + 136, q.y - Math.max(4, 0.02 * q.s));
        const fs = PPD.TTG.clamp(0.075 * q.s, 11, 19);
        const name = (PPD.app.names && PPD.app.names[1 - side]) || '对手';
        // 头部到名牌的引线（名牌会盖住末端）
        ctx.beginPath();
        ctx.moveTo(headX, headY);
        ctx.lineTo(tagX, tagY);
        ctx.strokeStyle = 'rgba(235,246,255,0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
        fpNameTag(ctx, tagX, tagY, name, opp.teamColor || (side === 0 ? '#2563eb' : '#d0321e'), fs, 0.9);
      }
    }
    // 球旋转 + 球外圈（世界锚定；不显示球速）
    if (view.ball && phase === 'play') {
      const q = cam.project(view.ball.pos);
      if (q && q.x > vx && q.x < vx + vw && q.y > vy && q.y < vy + vh) {
        const sx = fpAnchorX(mirrored, vx, vw, q.x);
        const fs = PPD.TTG.clamp(0.045 * q.s, 9, 12);
        fpBallReadout(ctx, sx + Math.max(16, 0.05 * q.s), q.y - Math.max(18, 0.06 * q.s), view.ball.spin, fs);
        ctx.beginPath();
        ctx.arc(sx, q.y, Math.max(7, 0.035 * q.s), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(235,246,255,0.28)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // 球贴脸时会被视图模型球拍遮住：HUD 层补一个亮核，保证最后一段仍能看到球
        ctx.beginPath();
        ctx.arc(sx, q.y, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(10,16,24,0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    // 发球落点环：世界锚定在台面上
    if (view.servePath && view.servePath.length > 1) {
      fpLandingReticle(ctx, cam, vx, vy, vw, vh, mirrored, view.servePath[view.servePath.length - 1]);
    }
    // 球出画箭头
    if (view.ball && phase === 'play') {
      fpOffscreenBall(ctx, cam, vx, vy, vw, vh, mirrored, view.ball, view.time);
    }
    ctx.restore();
  }

  /* 视口级第一人称渲染：AI/本地/联机/回放共用。
     vx/vy/vw/vh 是画布绝对坐标；本地分屏两半各调一次，各自独立相机与视线平滑。
     opts.key 变化（换局/换模式）自动重置视线；opts.slot 区分同一帧里的多个视角。 */
  function renderFirstPersonView(view, side, vx, vy, vw, vh, opts) {
    const ctx = PPD.ctx;
    if (!ctx || !view || !vw || !vh) return null;
    const s = side === 1 ? 1 : 0;
    const own = view.players ? view.players.find((p) => p.side === s) : null;
    if (!own) return null;
    const o = opts || {};
    const cam = makeFirstPersonCam(s, own, {
      ball: view.ball ? view.ball.pos : null,
      phase: view.phase,
      server: view.server,
      time: view.time,
      key: o.key == null ? 'view' : o.key,
    }, vx, vy, vw, vh, o.slot || ('fp:' + s));
    view.cam = cam;
    view.side = s;
    view.fp = true;
    view.noCrowd = true;   // 观众席缓存 key 不含相机朝向，第一人称先关观众
    view.noPlate = true;   // 底板按主视口标定，第一人称强制程序化场景
    view.plateFlip = false;
    // 己方发球时，世界层的持球由视图模型画在自己拍面上；隐藏世界层那颗，避免一球两画
    view.hideBallInHand = view.server === s;
    // 只让发球方的视口显示发球轨迹/落点环（分屏/观战两边都不该替对手看落点）
    if (view.servePath && view.server !== s) view.servePath = null;
    // 己方身体过滤掉（世界空间火柴人贴脸会穿帮）；手臂/球拍由视图模型接管
    view.players = view.players.filter((p) => p.side !== s);
    PPD.app.fpCam = cam;
    if (!PPD.app.fpCams) PPD.app.fpCams = [null, null];
    PPD.app.fpCams[s] = cam;
    /* 地板/灯光用固定站位的 floorCam：相机 x 不跟球员，drawFloor 的静态缓存
       （key 含 eye.x 桶）才不会被横移每 0.06m 打掉。地板是柔和径向渐变，
       固定站位与真实眼位的差别不可见；球台/球员/球仍用真实 cam。 */
    const floorCam = new PPD.TTG.Camera();
    const fEye = PPD.TTG.v3(0, FP.eyeY, s === 0 ? -(1.65 + FP.back - 0.08) : (1.65 + FP.back - 0.08));
    const fLook = PPD.TTG.v3(0, FP.gazeY, fEye.z + (s === 0 ? FP.ahead : -FP.ahead));
    floorCam.set(fEye, fLook, vx + vw / 2, vy + vh / 2, cam.f);
    view.floorCam = floorCam;
    ctx.save();
    ctx.beginPath();
    ctx.rect(vx, vy, vw, vh);
    ctx.clip();
    juiceTransform(ctx, vx, vy, vw, vh);
    ctx.save();
    if (s === 0) applyViewMirror(ctx, vw, vx);
    PPD.TTG.drawScene(ctx, view, vw, vh);
    ctx.restore();
    // 视图模型与 3D HUD 画在镜像之外：文字不反、球拍保持在惯用手一侧
    drawFirstPersonView(ctx, s, {
      ...own,
      teamColor: own.teamColor || ((PPD.app.matchTeams && PPD.app.matchTeams[s]) ? PPD.app.matchTeams[s].color : null),
    }, view, vx, vy, vw, vh);
    drawFirstPersonHud(ctx, s, view, cam, vx, vy, vw, vh);
    ctx.restore();
    return cam;
  }

  function renderFirstPersonFromEngine(side) {
    const w = PPD.app.resizeW, h = PPD.app.resizeH;
    const eng = PPD.app.engine;
    if (!w || !h || !eng) return null;
    const s = side === 1 ? 1 : 0;
    PPD.ctx.clearRect(0, 0, w, h);
    const view = viewModelFromEngine(eng, s);
    updateTrail(view);
    return renderFirstPersonView(view, s, 0, 0, w, h, { key: eng, slot: 'solo:' + s });
  }

  // 兼容旧入口（AI 人机 / AI 观战球员视角）
  function renderFirstPerson(side) {
    return renderFirstPersonFromEngine(side);
  }

  PPD.renderLocal = renderLocal;
  PPD.renderOnline = renderOnline;
  PPD.renderSingle = renderSingle;
  PPD.renderMenuScene = renderMenuScene; // 主页菜单场景（P0）
  PPD.makeMenuCam = makeMenuCam;
  PPD.renderSide = renderSide;           // P3 AI对打·看台边线机位
  PPD.makeSideCam = makeSideCam;
  PPD.renderWatch = renderWatch;         // P3 AI对打·球员视角（跟随甲/乙）
  PPD.updateTrail = updateTrail;       // 回放（replay.js）复用尾影
  PPD.applyViewMirror = applyViewMirror; // 回放复用红方视角镜像
  PPD.fxKick = fxKick;                 // 事件层（hud/net）触发震屏/推近
  PPD.fxStep = fxStep;                 // 主循环按真实时间衰减
  PPD.juiceLevel = juiceLevel;         // 测试/诊断：当前强度
  PPD.juiceTransform = juiceTransform; // 测试/诊断：变换计算
  PPD.viewModelFromEngine = viewModelFromEngine;
  PPD.viewModelFromSnap = viewModelFromSnap;
  PPD.viewModelFromSnapInterp = viewModelFromSnapInterp;
  PPD.servePathFromSnap = servePathFromSnap;
  PPD.makeCam = makeCam;
  PPD.unprojectToTable = unprojectToTable;
  PPD.serveAimFromPointer = serveAimFromPointer;
  PPD.renderFirstPerson = renderFirstPerson;
  PPD.renderFirstPersonFromEngine = renderFirstPersonFromEngine;
  PPD.renderFirstPersonView = renderFirstPersonView;
  PPD.makeFirstPersonCam = makeFirstPersonCam;
})();
