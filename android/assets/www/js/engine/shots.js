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
  // 瞄准式发球缓存（鼠标移动瞄准按 0.04m 网格量化命中，避免每次移动全量搜索求解）：
  // 键含发球方/站位/目标落点；发球实发复用 servePlan，量化误差 <2cm 可忽略
  const serveToCache = new Map();

  // 模拟一次发球：合法时返回对方半台第一次落台的位置（轨迹末端），否则返回 null
  // 回调返回 true 提前中断 physicsStep（落台/出界即停，不再模拟满 1.8s——瞄准求解单次成本大幅下降）
  function serveLanding(launch, vel, spin, pi) {
    const b = { pos: { ...launch }, vel: { ...vel }, spin: { ...spin } };
    let ownBounce = false, oppBounce = false, bad = false;
    let land = null;
    ctx.physicsStep(b, 1.8, (ev) => {
      if (bad || oppBounce) return true;
      if (ev.type === 'bounce') {
        const side = b.pos.z > 0 ? 1 : 0;
        if (side === pi) {
          if (ownBounce) { bad = true; return true; }
          ownBounce = true;
        } else {
          if (!ownBounce) { bad = true; return true; }
          oppBounce = true;
          land = { x: b.pos.x, y: b.pos.y, z: b.pos.z };
          return true; // 对方半台落台 → 结果已定，中断
        }
      } else if (ev.type === 'net' || ev.type === 'netclip' || ev.type === 'floor') {
        bad = true;
        return true;
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
    const TOL = 0.12; // 实际落点与瞄准点足够接近即接受（粗搜更易命中，减少细搜兜底）
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
    // 粗搜（快）→ 细搜（全覆盖）：粗搜 angles 每 5° 一档（3 角，48 次模拟，中断后单次 ~2ms），
    // 发球角度范围窄（-6°~-26°），3 档覆盖高中低抛命中率高；边缘落点才触发细搜兜底
    let r = trySearch(
      speeds.slice(0, 4),
      angles.filter((a) => a % 5 === 0),
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
    // 瞄准缓存：发球方/站位(0.04m)/发球点高度/目标落点(0.04m)量化命中，鼠标连续移动时复用相邻网格解
    // 键含 H.y（蹲下发球点更低，须与站立分开缓存，否则蹲下会复用站立轨迹）
    const H = ctx.serveBallPos(state.players[pi]);
    const hxk = Math.round(H.x * 25), hzk = Math.round(H.z * 25), hyk = Math.round(H.y * 10);
    const txx = Math.round(tx0 * 25), tzz = Math.round(tz0 * 25);
    const ck = `${pi}:${fast ? 1 : 0}:${hxk}:${hzk}:${hyk}:${txx}:${tzz}`;
    let plan = serveToCache.get(ck);
    // 未命中 → 邻近已解加权插值：收集周围 ±1 网格的解，按落点距离 1/d² 加权平均——
    // 高速选落点时轨迹随鼠标连续平滑（避免复用单个网格解导致的落点跳变抖动）
    if (!plan) {
      const near = [];
      const seen = new Set();
      for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
        if (dx === 0 && dz === 0) continue;
        const k2 = `${pi}:${fast ? 1 : 0}:${hxk}:${hzk}:${hyk}:${txx + dx}:${tzz + dz}`;
        if (seen.has(k2)) continue;
        seen.add(k2);
        const c = serveToCache.get(k2);
        if (c && c.land) near.push(c);
      }
      if (near.length) {
        let tw = 0, vx = 0, vy = 0, vz = 0, sx = 0, sp = 0, lx = 0, ly = 0, lz = 0;
        for (const c of near) {
          const d = Math.hypot(c.land.x - tx0, c.land.z - tz0) + 0.02;
          const w = 1 / (d * d);
          tw += w;
          vx += w * c.vel.x; vy += w * c.vel.y; vz += w * c.vel.z;
          sx += w * c.spin.x; sp += w * c.speed;
          lx += w * c.land.x; ly += w * c.land.y; lz += w * c.land.z;
        }
        plan = { vel: { x: vx / tw, y: vy / tw, z: vz / tw }, spin: { x: sx / tw, y: 0, z: 0 }, speed: sp / tw, land: { x: lx / tw, y: ly / tw, z: lz / tw } };
      }
    }
    if (plan) { serveToCache.set(ck, plan); return plan; }
    // 粗搜优先（~48 次物理模拟，毫秒级）：落点够近（≤0.12m）直接用，避免每次瞄准移动触发全量细搜尖峰；
    // 粗搜无解或偏差大（边缘落点）才细搜兜底（结果同样进缓存）
    plan = searchServeTo(state, pi, tx0, tz0, fast, true);
    if (plan && plan.land) {
      const d = Math.hypot(plan.land.x - tx0, plan.land.z - tz0);
      if (d > 0.12) plan = searchServeTo(state, pi, tx0, tz0, fast, false);
    } else {
      plan = searchServeTo(state, pi, tx0, tz0, fast, false);
    }
    serveToCache.set(ck, plan);
    // LRU 淘汰最旧（不整体 clear）：落点区域网格 ~1000+，整体清空会让连续移动重新求解掉帧
    if (serveToCache.size > 2500) serveToCache.delete(serveToCache.keys().next().value);
    return plan;
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
    const cacheKey = `${pi}:${f > 0 ? 1 : 0}:${Math.round(H.x * 8)}:${Math.round(opp.x * 2)}:${fast ? 1 : 0}:${Math.round(H.z * 16)}:${Math.round(H.y * 8)}`;
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

  function computeShot(state, pi, type, opts) {
    const p = state.players[pi], b = state.ball, f = p.facing;
    const opp = state.players[1 - pi];
    const soft = !!(opts && opts.soft) && type === 2;
    // 防守式轻挡（defensiveChip，仅推球无解时的扣杀来球兜底）：减力 + 高弧线 + 落点略深
    const chip = !!(opts && opts.defensiveChip) && type === 1;
    const tz = type === 2 ? f * 1.18 : type === 3 ? f * 1.20 : f * (chip ? 0.75 : 0.55);
    // 反击低平快球奖励（更高档）：更高球速 + 刁钻落位（打向对方站位反方向的边角），
    // 配合 strokes.js 的 counterSmash（视为扣杀、AI 应对概率减半）
    const fastCounter = type === 1 && p.counterLowBonus;
    // 落点 x：默认对准对手站位；人机"刁钻方向射球"通过 p.aimBias 打向对方反方向/边角；
    // 反击低平快球再叠加 0.55m 边角偏置，落点更贴边、更难够到
    const tx = ctx.clamp(opp.x * 0.85 + (b.pos.x - p.x) * 0.25 + (p.aimBias || 0) + (fastCounter ? (opp.x >= 0 ? -0.55 : 0.55) : 0), -0.72, 0.72);
    const target = ctx.vec(tx, ctx.RULES.TABLE_HEIGHT + ctx.RULES.BALL_RADIUS, tz);
    const padSpeed = type === 2 ? (soft ? 8.0 : 10.4) : type === 3 ? 7.5 : fastCounter ? 5.2 : (chip ? 2.0 : 2.8); // 扣球更快（减力扣球稍慢）、低平快球快而平的抽击、反击低平快球更快、轻挡更慢更稳
    const e = type === 1 ? 0.20 : type === 3 ? 0.50 : 0.85;
    const outSpeed = (1 + e) * padSpeed + e * ctx.vlen(b.vel);
    let spin = ctx.vec(type === 1 ? (fastCounter ? f * 55 : -f * 34) : type === 3 ? f * 50 : (soft ? f * 80 : f * 120), 0, 0); // 扣球强上旋下坠（减力扣球略弱）、低平快球中等上旋、反击低平快球带上旋快抽
    // 推球：按击球高度留净空（网顶上方约 1.2~5.5cm），弧线抬高、干净过网；
    // 扣球：贴网下压更狠（净空 0.6~8cm）+ 更快 + 强上旋——更容易造成低球/快球；
    // 低平快球：贴网平击（净空 0.8~5cm），过网后略下坠、落地深而低
    const minClear = type === 1
      ? ctx.clamp((b.pos.y - (ctx.RULES.TABLE_HEIGHT + ctx.RULES.NET_HEIGHT)) * 0.5, 0.012, 0.055)
      : type === 3 ? 0.008 : 0.006;
    const maxClear = type === 2 ? 0.08 : type === 3 ? 0.05 : null;
    // 蹲下（Ctrl）：用更高弧线、更快的防守性回球（放高球），
    // 球越低越用力（贴地球也能接起），普通低球保持 1.35×
    // 高吊球：高净空高弧线——喂给对手制造扣杀机会（到达对方箱体时球高 ≥1.0）。
    //   仅由 lb 输入触发（AI 的 lobProb / 玩家"蹲下+推球"由输入层转成 lb），
    //   自动蹲防（救低球/接扣杀）保持低净空防守路径；opts.lob 供指示判定
    const defensive = type === 1 && (p.crouch >= 0.5 || p.lob);
    const isLob = defensive && (p.lob || (opts && opts.lob));
    const low = defensive ? ctx.clamp(1 - b.pos.y / ctx.RULES.HITBOX_Y_BOTTOM, 0, 1) : 0;
    const defSpeed = 1.35 + 0.55 * low;
    let vel = solveRally(b.pos, target,
      outSpeed * (defensive ? defSpeed : (type === 2 ? 1.10 : type === 3 ? 1.0 : (chip ? 0.90 : 1.05))),
      spin, isLob ? 0.55 : minClear, isLob ? 1.3 : maxClear, defensive || chip, type === 3);
    // 高吊解不出合法轨迹（低球救球等球况）时退回普通蹲防弧线，保证命中不落空
    if (!vel && isLob) {
      vel = solveRally(b.pos, target, outSpeed * defSpeed, spin, minClear, maxClear, defensive, false);
    }
    // 反击低平快球奖励：更高球速+边角落点解不出合法轨迹时，回退普通推球（保证反击不挥空）
    if (!vel && fastCounter) {
      const normalTx = ctx.clamp(opp.x * 0.85 + (b.pos.x - p.x) * 0.25 + (p.aimBias || 0), -0.72, 0.72);
      const normalOut = (1 + 0.20) * 2.8 + 0.20 * ctx.vlen(b.vel);
      spin = ctx.vec(-f * 34, 0, 0);
      vel = solveRally(b.pos, ctx.vec(normalTx, ctx.RULES.TABLE_HEIGHT + ctx.RULES.BALL_RADIUS, tz),
        normalOut * (defensive ? defSpeed : 1.05), spin, minClear, maxClear, defensive || chip, false);
    }
    // 解不出合法轨迹时的处理：
    //   低平快球 → 高吊推球（degraded 标记"非完整击球"）；
    //   推球无解 + 来球是扣杀 → 防守式轻挡（接扣杀不挥空）；
    //   扣杀(type2)解不出合法快扣 → **判定撞网**（不再降级成慢速球）——
    //   由 strokes.js 把球打进网，对方得分（右键=快扣杀或撞网）
    if (!vel) {
      if (type === 3) { const f3 = computeShot(state, pi, 1); if (f3) { f3.degraded = true; return f3; } return null; }
      // 推球无解 + 来球是扣杀（b.hitType===2）：防守式轻挡兜底（!chip 防重入）——
      // 接扣杀不应因求解无解而白白挥空丢分（对 AI 与玩家反击扣杀同路径生效）
      if (type === 1 && b.hitType === 2 && !chip) {
        const chipShot = computeShot(state, pi, 1, { defensiveChip: true });
        if (chipShot) { chipShot.degraded = true; return chipShot; }
        return null;
      }
      if (type === 2) return { netHit: true };
      return null;
    }
    return vel ? { vel, outSpeed, spin, degraded: false } : null;
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









