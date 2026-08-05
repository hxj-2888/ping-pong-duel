/* ============================================================
 * engine/shots.js — 弹道求解：发球/回球搜索与校验（拆分自 engine.js）
 * 本模块通过共享上下文 ctx 使用其他模块的接口，不直接改动其他文件。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.TTShots = factory;
})(typeof self !== 'undefined' ? self : this, function (ctx) {
  'use strict';

  function solveShot(p0, target, speed) {
    const dx = target.x - p0.x, dy = target.y - p0.y, dz = target.z - p0.z;
    const dh = Math.hypot(dx, dz);
    if (dh < 0.02 || speed <= 0.1) return null;
    const A = (ctx.RULES.GRAVITY * dh * dh) / (2 * speed * speed);
    // dy = dh*u - A(1+u²)  →  A·u² - dh·u + (A + dy) = 0
    const a = A, b = -dh, c = A + dy;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const cands = [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]
      .filter((u) => Number.isFinite(u))
      .sort((u, v) => Math.abs(u) - Math.abs(v));
    if (!cands.length) return null;
    for (const u of cands) {
      const vh = speed / Math.sqrt(1 + u * u);
      const vel = { x: (vh * dx) / dh, y: vh * u, z: (vh * dz) / dh };
      if (clearsNet(p0, vel)) return vel;
    }
    const u = cands[0];
    const vh = speed / Math.sqrt(1 + u * u);
    return { x: (vh * dx) / dh, y: vh * u, z: (vh * dz) / dh };
  }

  function clearsNet(p0, vel) {
    if (Math.abs(vel.z) < 0.05) return false;
    const t = -p0.z / vel.z;
    if (t <= 0.02 || t > 2.5) return false;
    const y = p0.y + vel.y * t - 0.5 * ctx.RULES.GRAVITY * t * t;
    return y > ctx.RULES.TABLE_HEIGHT + ctx.RULES.NET_HEIGHT + 0.018;
  }

  // ---------- 发球求解：直接搜索速度/角度/旋转并模拟验证 ----------
  const serveCache = new Map();

  // 模拟一次发球：合法时返回对方半台第一次落台的位置（轨迹末端），否则返回 null
  function serveLanding(launch, vel, spin, pi) {
    const b = { pos: { ...launch }, vel: { ...vel }, spin: { ...spin } };
    let ownBounce = false, oppBounce = false, bad = false;
    let land = null;
    ctx.physicsStep(b, 1.8, (ev) => {
      if (bad || oppBounce) return;
      if (ev.type === 'bounce') {
        const side = b.pos.z > 0 ? 1 : 0;
        if (side === pi) {
          if (ownBounce) { bad = true; return; }
          ownBounce = true;
        } else {
          if (!ownBounce) { bad = true; return; }
          oppBounce = true;
          land = { x: b.pos.x, y: b.pos.y, z: b.pos.z };
        }
      } else if (ev.type === 'net' || ev.type === 'netclip' || ev.type === 'floor') {
        bad = true;
      }
    });
    return (ownBounce && oppBounce && !bad && land) ? land : null;
  }

  // 沿“发球点→目标点”的水平方向搜索速度/角度/旋转，取最接近目标点的合法轨迹。
  // coarseOnly=true 时只用稀疏候选（快速兜底用）。
  function searchServeTo(state, pi, tx0, tz0, fast, coarseOnly) {
    const p = state.players[pi], f = p.facing;
    const H = ctx.serveBallPos(p); // 发球点位于球拍正前方
    const hx = tx0 - H.x, hz = tz0 - H.z;
    const hlen = Math.hypot(hx, hz);
    if (hlen < 0.12) return null;
    const speeds = fast
      ? [5.6, 5.4, 5.8, 5.2, 6.0, 6.2, 6.4, 6.6]
      : [4.6, 4.4, 4.8, 4.2, 5.0, 5.2, 5.4, 5.6];
    const angles = fast
      ? [-6, -8, -10, -12, -14, -16, -18, -20, -22, -24, -26, -28, -30, -32]
      : [-6, -8, -10, -12, -14, -16, -18, -20, -22, -24, -26, -28];
    const spins = fast
      ? [-50, -30, -10, 10, 30, 50, 70, 90]
      : [15, 25, 35, 45, 55, 65, 75, 85];
    const TOL = 0.10; // 实际落点与瞄准点足够接近即接受
    const trySearch = (speedList, angleList, spinList) => {
      let best = null, bestD = Infinity;
      for (const speed of speedList) {
        for (const deg of angleList) {
          for (const s of spinList) {
            const th = (deg * Math.PI) / 180;
            const vh = speed * Math.cos(th);
            const vel = {
              x: (vh * hx) / hlen,
              y: speed * Math.sin(th),
              z: (vh * hz) / hlen,
            };
            const spin = ctx.vec(fast ? f * s : -f * s, 0, 0);
            const land = serveLanding(H, vel, spin, pi);
            if (!land) continue;
            const d = Math.hypot(land.x - tx0, land.z - tz0);
            if (d < bestD) { bestD = d; best = { vel, spin, speed, land }; }
            if (d <= TOL) return { plan: best, done: true };
          }
        }
      }
      return { plan: best, done: false };
    };
    // 粗搜（快）→ 细搜（全覆盖）
    let r = trySearch(
      speeds.slice(0, 4),
      fast ? angles.filter((a) => a % 4 === 0) : angles.filter((a) => a % 5 === 0),
      spins.slice(0, 4)
    );
    if (!r.done && !coarseOnly) r = trySearch(speeds, angles, spins);
    return r.plan;
  }

  // 瞄准式发球：把目标落点（对方半台）夹取到台面安全区后沿该方向求解。
  // 轨迹末端始终落在对方半台台面上（serveLanding 验证先本方后对方、不过网不出界）。
  function solveServeTo(state, pi, tx, tz, fast) {
    const f = state.players[pi].facing;
    const TW = ctx.RULES.TABLE_WIDTH / 2, TL = ctx.RULES.TABLE_LENGTH / 2;
    const mx = TW - 0.10, mz = TL - 0.14;
    const tx0 = ctx.clamp(tx, -mx, mx);
    const tz0 = f > 0 ? ctx.clamp(tz, 0.10, mz) : ctx.clamp(tz, -mz, -0.10);
    return searchServeTo(state, pi, tx0, tz0, fast, false);
  }

  // 客户端/服务端在待发期间把鼠标或手指瞄准的目标落点写进持拍手：
  // 求解后存为 servePlan，渲染层据此画预览轨迹，发球时直接复用（所见即所得）。
  function setServeAim(state, pi, tx, tz) {
    const p = state.players[pi];
    if (state.phase !== 'serve' || !state.ball.inHand || state.server !== pi) return false;
    const plan = ctx.solveServeTo(state, pi, tx, tz, false);
    if (plan) {
      p.servePlan = plan;
      p.serveAimSet = true;
      p.serveAim = { x: tx, z: tz };
      p.serveAimBlocked = false;
      return true;
    }
    // 解不出合法发球（球员站位太偏导致目标不可达）：轨迹消失，同时发不出球
    p.servePlan = null;
    p.serveAimSet = false;
    p.serveAim = null;
    p.serveAimBlocked = true;
    return false;
  }

  function solveServe(state, pi, fast) {
    const p = state.players[pi], f = p.facing, opp = state.players[1 - pi];
    const H = ctx.serveBallPos(p); // 发球点位于球拍正前方
    // 缓存必须区分发球方：两侧朝向相反，共用缓存会把 P1 的轨迹给 P2
    // 缓存必须包含发球点 z（球员可前后移动，站位不同发球轨迹不同）
    const cacheKey = `${pi}:${f > 0 ? 1 : 0}:${Math.round(H.x * 2)}:${Math.round(opp.x * 2)}:${fast ? 1 : 0}:${Math.round(H.z * 4)}`;
    if (serveCache.has(cacheKey)) return serveCache.get(cacheKey);
    const speeds = fast
      ? [5.6, 5.4, 5.8, 5.2, 6.0, 6.2, 6.4, 6.6]
      : [4.6, 4.4, 4.8, 4.2, 5.0, 5.2, 5.4, 5.6];
    const angles = fast
      ? [-6, -8, -10, -12, -14, -16, -18, -20, -22, -24, -26, -28, -30, -32]
      : [-6, -8, -10, -12, -14, -16, -18, -20, -22, -24, -26, -28];
    const spins = fast
      ? [-50, -30, -10, 10, 30, 50, 70, 90]
      : [15, 25, 35, 45, 55, 65, 75, 85];
    // 多个瞄准点：边线斜线 / 中路 / 对手站位
    const aimXs = [
      ctx.clamp(H.x * 0.70, -0.72, 0.72),
      ctx.clamp(H.x * 0.30, -0.72, 0.72),
      ctx.clamp(opp.x * 0.50, -0.72, 0.72),
    ].filter((v, i, a) => a.indexOf(v) === i);
    const hzs = fast ? [0.25, 0.35, 0.50, 0.65] : [0.22, 0.30, 0.42, 0.55];
    const trySearch = (speedList, angleList, spinList) => {
      for (const tx0 of aimXs) {
        for (const hz of hzs) {
          const hx = tx0 - H.x, hzr = f * hz;
          const hlen = Math.hypot(hx, hzr);
          if (hlen < 0.08) continue;
          for (const speed of speedList) {
            for (const deg of angleList) {
              for (const s of spinList) {
                const th = (deg * Math.PI) / 180;
                const vh = speed * Math.cos(th);
                const vel = {
                  x: (vh * hx) / hlen,
                  y: speed * Math.sin(th),
                  z: (vh * hzr) / hlen,
                };
                const spin = ctx.vec(fast ? f * s : -f * s, 0, 0);
                if (serveFlightOk(H, vel, spin, pi)) {
                  return { vel, spin, speed };
                }
              }
            }
          }
        }
      }
      return null;
    };
    // 粗搜（快）→ 细搜（全覆盖）
    let result = trySearch(
      speeds.slice(0, 4),
      fast ? angles.filter((a) => a % 4 === 0) : angles.filter((a) => a % 5 === 0),
      spins.slice(0, 4)
    );
    if (!result) result = trySearch(speeds, angles, spins);
    serveCache.set(cacheKey, result);
    if (serveCache.size > 400) serveCache.clear();
    return result;
  }

  function serveFlightOk(launch, vel, spin, pi) {
    return !!serveLanding(launch, vel, spin, pi);
  }

  function computeShot(state, pi, type) {
    const p = state.players[pi], b = state.ball, f = p.facing;
    const opp = state.players[1 - pi];
    const tz = type === 2 ? f * 1.18 : type === 3 ? f * 1.20 : f * 0.55;
    const tx = ctx.clamp(opp.x * 0.85 + (b.pos.x - p.x) * 0.25, -0.72, 0.72);
    const target = ctx.vec(tx, ctx.RULES.TABLE_HEIGHT + ctx.RULES.BALL_RADIUS, tz);
    const padSpeed = type === 2 ? 10.4 : type === 3 ? 7.5 : 2.8; // 扣球更快、低平快球快而平的抽击
    const e = type === 1 ? 0.20 : type === 3 ? 0.50 : 0.85;
    const outSpeed = (1 + e) * padSpeed + e * ctx.vlen(b.vel);
    const spin = ctx.vec(type === 1 ? -f * 34 : type === 3 ? f * 50 : f * 120, 0, 0); // 扣球强上旋下坠、低平快球中等上旋
    // 推球：按击球高度留净空（网顶上方约 1.2~5.5cm），弧线抬高、干净过网；
    // 扣球：贴网下压更狠（净空 0.6~8cm）+ 更快 + 强上旋——更容易造成低球/快球；
    // 低平快球：贴网平击（净空 0.8~5cm），过网后略下坠、落地深而低
    const minClear = type === 1
      ? ctx.clamp((b.pos.y - (ctx.RULES.TABLE_HEIGHT + ctx.RULES.NET_HEIGHT)) * 0.5, 0.012, 0.055)
      : type === 3 ? 0.008 : 0.006;
    const maxClear = type === 2 ? 0.08 : type === 3 ? 0.05 : null;
    // 蹲下（Ctrl）：用更高弧线、更快的防守性回球（放高球），
    // 球越低越用力（贴地球也能接起），普通低球保持 1.35×
    const defensive = type === 1 && p.crouch;
    const low = defensive ? ctx.clamp(1 - b.pos.y / ctx.RULES.HITBOX_Y_BOTTOM, 0, 1) : 0;
    const defSpeed = 1.35 + 0.55 * low;
    const vel = solveRally(b.pos, target,
      outSpeed * (defensive ? defSpeed : (type === 2 ? 1.10 : type === 3 ? 1.0 : 1.05)),
      spin, minClear, maxClear, defensive, type === 3);
    // 低平快球解不出合法轨迹（站位/球况不佳）时退回高吊推球，保证命中不落空
    if (!vel && type === 3) return computeShot(state, pi, 1);
    return vel ? { vel, outSpeed, spin } : null;
  }

  function solveRally(p0, target, speed, spin, minClear, maxClear, defensive, lowFlat) {
    const strikerSide = p0.z > 0 ? 1 : 0;
    const oppSide = 1 - strikerSide;
    const hx = target.x - p0.x, hz = target.z - p0.z;
    const hlen = Math.hypot(hx, hz);
    if (hlen < 0.05) return null;
    const dx = hx / hlen, dz = hz / hlen;
    // 旋转 x 的符号取决于击球方朝向，判断扣球只看强度
    const isSmash = Math.abs(spin.x) > 50;
    // 推球：从水平偏上开始搜索角度，弧线抬高、干净过网；
    // 扣球：保持下压角度并封顶（去掉高抛“兜底”），低球/矮球更难扣过网；
    //       更快更强的扣球需要更多上仰角度在低球位过网（贴网净空内），同样造成低球/快球；
    // 低平快球：近水平角度贴网平击，配合强上旋过网后下坠
    const angles = lowFlat
      ? [-12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8]
      : isSmash
        ? [-40, -36, -32, -28, -24, -22, -20, -18, -16, -14, -12, -10, -8, -6, -4, -2, 0, 2, 4]
        : defensive
          ? [8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72] // 蹲下接低球：高弧线防守（含极低球陡弧）
          : [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48];
    for (const deg of angles) {
      const th = (deg * Math.PI) / 180;
      const vh = speed * Math.cos(th);
      const vel = { x: vh * dx, y: speed * Math.sin(th), z: vh * dz };
      if (rallyFlightOk(p0, vel, spin, oppSide, minClear, maxClear)) return vel;
    }
    return null;
  }

  function rallyFlightOk(p0, vel, spin, oppSide, minClear, maxClear) {
    const b = { pos: { ...p0 }, vel: { ...vel }, spin: { ...spin } };
    let firstBounce = -1, bad = false, crossed = false;
    const h = ctx.SUBSTEP;
    const netTop = ctx.RULES.TABLE_HEIGHT + ctx.RULES.NET_HEIGHT;
    const lo = netTop + (minClear || 0);
    const hi = netTop + (maxClear == null ? 100 : maxClear);
    let prevZ = b.pos.z, prevY = b.pos.y;
    let t = 0;
    while (t < 2.0 && !bad && firstBounce < 0) {
      ctx.physicsStep(b, h, (ev) => {
        if (ev.type === 'bounce') {
          const side = b.pos.z > 0 ? 1 : 0;
          if (side === oppSide) firstBounce = side;
          else bad = true;
        } else if (ev.type === 'net' || ev.type === 'floor') {
          bad = true;
        }
      });
      // 过网高度检测：球跨越网面时，用插值估算网面处高度，必须落在允许的净空区间内
      // （推球要求明显抬高过网；扣球要求贴网下压，过低/擦网即失败）
      if (!crossed && prevZ !== 0 && Math.sign(prevZ) !== Math.sign(b.pos.z)) {
        crossed = true;
        const f = Math.abs(b.pos.z) / (Math.abs(b.pos.z) + Math.abs(prevZ) + 1e-9);
        const crossY = prevY + (b.pos.y - prevY) * (1 - f);
        if (crossY < lo || crossY > hi) bad = true;
      }
      prevZ = b.pos.z;
      prevY = b.pos.y;
      t += h;
    }
    return firstBounce === oppSide && !bad && crossed;
  }

  return { solveShot, clearsNet, solveServe, solveServeTo, searchServeTo, setServeAim, serveLanding, serveFlightOk, solveRally, rallyFlightOk, computeShot };
});









