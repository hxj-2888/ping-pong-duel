/* ============================================================
 * engine/strokes.js — 挥拍与击球：发球挥拍/对打挥拍/球拍碰撞（拆分自 engine.js）
 * 本模块通过共享上下文 ctx 使用其他模块的接口，不直接改动其他文件。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.TTStrokes = factory;
})(typeof self !== 'undefined' ? self : this, function (ctx) {
  'use strict';

  function startServeStroke(state, pi, type) {
    const p = state.players[pi];
    // 瞄准目标解不出合法发球：发不出球（轨迹已消失）
    if (p.serveAimBlocked) { p.hitCd = 0.25; return; }
    // 瞄准模式：直接使用鼠标/手指瞄准时求解好的方案（预览即实发）；
    // 未瞄准（AI 自动发球/键盘发球）时按原逻辑搜索默认轨迹。
    const plan = (p.serveAimSet && p.servePlan)
      ? p.servePlan
      : ctx.solveServe(state, pi, type === 2);
    if (!plan) { p.hitCd = 0.3; return; }
    p.servePlan = plan;
    const dir = ctx.vnorm(plan.vel);
    const launch = ctx.serveBallPos(p); // 球位于球拍正前方
    const start = ctx.vsub(launch, ctx.vscale(dir, 0.22));
    const pathLen = Math.max(0.3, ctx.vlen(plan.vel) * 0.18);
    const dur = ctx.clamp(pathLen / (plan.speed * 0.8), 0.10, 0.24);
    const spd = pathLen / dur;
    // 精确计算球拍接触静止发球球的时刻
    const d0 = ctx.vsub(start, launch);
    const aq = spd * spd;
    const bq = 2 * ctx.vdot(d0, ctx.vscale(dir, spd));
    const cq = ctx.vdot(d0, d0) - 0.022 * 0.022;
    const disc = bq * bq - 4 * aq * cq;
    let ct = -1;
    if (disc >= 0) {
      const t1 = (-bq - Math.sqrt(disc)) / (2 * aq);
      if (t1 >= 0 && t1 <= dur) ct = t1;
      else { const t2 = (-bq + Math.sqrt(disc)) / (2 * aq); if (t2 >= 0 && t2 <= dur) ct = t2; }
    }
    p.stroke = {
      active: true, type, t: 0, dur,
      speed: spd,
      start,
      end: ctx.vadd(start, ctx.vscale(dir, pathLen)),
      dir,
      n: dir,
      hit: false, ct,
    };
  }

  function applyPaddleHit(state, pi) {
    const p = state.players[pi], b = state.ball, st = p.stroke;
    if (st.validVel) {
      // 采用求解器验证过的精确出球（方向+速度+旋转均一致）
      b.vel = { ...st.validVel };
      b.spin = { ...st.validSpin };
      b.hitBy = pi;
      b.lastBounce = pi;
      b.netTouched = false;
      state.mayHit = [false, false];
      st.hit = true;
      state.rallyCount++;
      p.swingBack = 1;
      ctx.pushEvent(state, 'hit', pi);
      return true;
    }
    const vrel = ctx.vsub(b.vel, p.paddle.v);
    const vn = ctx.vdot(vrel, st.n);
    if (vn >= -0.01) return false;
    if (!state.mayHit[pi]) {
      ctx.endPoint(state, 1 - pi, 'volley');
      st.hit = true;
      return true;
    }
    const e = st.type === 1 ? 0.20 : st.type === 3 ? 0.50 : 0.85; // 推球卸力 / 低平快球中等 / 扣球硬碰
    const vr2 = ctx.vsub(vrel, ctx.vscale(st.n, (1 + e) * vn));
    const vn2 = ctx.vdot(vr2, st.n);
    const vt = ctx.vsub(vr2, ctx.vscale(st.n, vn2));
    const vr3 = ctx.vadd(ctx.vscale(vt, 0.84), ctx.vscale(st.n, vn2));
    const physical = ctx.vadd(vr3, p.paddle.v);
    const speedOut = ctx.vlen(physical);
    // 反弹方向 = 出球方向为主，融合挥拍瞬时速度矢量（避免固定角度，随挥速自然变化）
    let outDir = st.n;
    const pvLen = ctx.vlen(p.paddle.v);
    if (pvLen > 0.3) {
      const k = ctx.clamp(pvLen / Math.max(1, st.speed), 0, 0.35);
      outDir = ctx.vnorm(ctx.vadd(ctx.vscale(st.n, 1 - k), ctx.vscale(ctx.vnorm(p.paddle.v), k)));
    }
    b.vel = ctx.vscale(outDir, Math.max(speedOut, (st.outSpeed || 0) * 0.95));
    // 旋转：推球=下旋，扣球=强上旋
    const f = p.facing;
    const targetSpin = st.type === 1 ? -f * 34 : f * 95;
    b.spin.x = ctx.lerp(b.spin.x, targetSpin, 0.88);
    b.spin.y = 0; b.spin.z = 0;
    b.hitBy = pi;
    b.lastBounce = pi;
    b.netTouched = false;
    state.mayHit = [false, false];
    st.hit = true;
    state.rallyCount++;
    p.swingBack = 1;
    ctx.pushEvent(state, 'hit', pi);
    return true;
  }

  function startRallyStroke(state, pi, type) {
    const p = state.players[pi], b = state.ball, f = p.facing;
    const shot = ctx.computeShot(state, pi, type);
    const dir = ctx.vnorm(shot ? shot.vel : ctx.vec(0, 0.18, f));
    // 视觉挥拍：从球后方挥向球前方（跟随出球方向）
    const start = ctx.vsub(b.pos, ctx.vscale(dir, 0.36));
    const end = ctx.vadd(b.pos, ctx.vscale(dir, 0.36));
    const dur = type === 2 ? 0.30 : type === 3 ? 0.32 : 0.40;
    p.stroke = {
      active: true, type, t: 0, dur,
      speed: ctx.vlen(ctx.vsub(end, start)) / dur,
      start, end, dir,
      n: ctx.vnorm(shot ? shot.vel : ctx.vec(0, 0.18, f)),
      hit: false, ct: -1, outSpeed: shot ? shot.outSpeed : 0,
      windup: 0.08, live: 0.20,
      // 球员接球碰撞箱（进箱即命中）：球在箱内 + 窗口内按键即判定击中；
      // 蹲下时箱体下探（可接贴地球）、箱顶略降
      box: {
        x: p.x,
        z: p.z + f * 0.42,
        hx: ctx.RULES.HITBOX_HX,
        hz: ctx.RULES.HITBOX_HZ,
        yTop: p.crouch ? ctx.RULES.CROUCH_HITBOX_Y_TOP : ctx.RULES.HITBOX_Y_TOP,
        yBottom: p.crouch ? ctx.RULES.CROUCH_HITBOX_Y_BOTTOM : ctx.RULES.HITBOX_Y_BOTTOM,
      },
    };
  }

  function applyServeHit(state, pi) {
    const p = state.players[pi], b = state.ball;
    const plan = p.servePlan;
    if (!plan) return;
    b.vel = { ...plan.vel };
    b.spin = { ...plan.spin };
    b.inHand = false;
    b.hitBy = pi;
    b.lastBounce = -1;
    b.netTouched = false;
    state.phase = 'play';
    state.phaseT = 0;
    state.serveStage = 'waitOwn';
    state.mayHit = [false, false];
    state.rallyCount = 0;
    p.servePlan = null;
    p.serveAimSet = false;
    p.serveAim = null;
    ctx.pushEvent(state, 'serve', pi);
  }

  function updateStroke(state, pi, dt) {
    const p = state.players[pi], st = p.stroke;
    st.t += dt;
    const prog = st.t / st.dur;
    // 对打挥拍用 easeOutQuad（力度感），发球保持匀速（接触时刻按匀速求根，不能改）
    const rallyEased = st.windup > 0;
    const posT = rallyEased ? ctx.easeOutQuad(Math.min(1, prog)) : Math.min(1, prog);
    const velT = rallyEased ? ctx.easeOutQuadDeriv(Math.min(1, prog)) : 1;
    p.paddle.p = {
      x: ctx.lerp(st.start.x, st.end.x, posT),
      y: ctx.lerp(st.start.y, st.end.y, posT),
      z: ctx.lerp(st.start.z, st.end.z, posT),
    };
    p.paddle.n = { ...st.n };
    p.paddle.v = ctx.vscale(st.dir, st.speed * velT);

    if (!st.hit && state.phase === 'serve' && state.server === pi &&
        state.ball.inHand && st.ct >= 0 && st.t >= st.ct) {
      applyServeHit(state, pi);
    } else if (!st.hit && state.phase === 'play' && !state.ball.inHand &&
               st.windup > 0 && st.t >= st.windup && st.t <= st.windup + st.live) {
      // 进箱即命中：球进入球员接球碰撞箱（跟随球员当前位置，蹲下时箱体下探）
      const b = state.ball;
      st.box.x = p.x;
      st.box.z = p.z + p.facing * 0.42;
      st.box.yTop = p.crouch ? ctx.RULES.CROUCH_HITBOX_Y_TOP : ctx.RULES.HITBOX_Y_TOP;
      st.box.yBottom = p.crouch ? ctx.RULES.CROUCH_HITBOX_Y_BOTTOM : ctx.RULES.HITBOX_Y_BOTTOM;
      const inBox = Math.abs(b.pos.x - st.box.x) < st.box.hx &&
        Math.abs(b.pos.z - st.box.z) < st.box.hz &&
        b.pos.y > st.box.yBottom && b.pos.y < st.box.yTop;
      if (inBox && state.mayHit[pi]) {
        // 球拍自动伸向球（仅作击球动画，不再是命中门槛）
        const reach = ctx.vadd(b.pos, ctx.vscale(st.n, 0.04));
        const k = 1 - Math.exp(-40 * dt);
        p.paddle.p = ctx.vlerp(p.paddle.p, reach, k);
        st.end = reach;
        st.start = { ...p.paddle.p }; // 锚点跟随，避免插值把球拍拉回原挥拍路线
        const shot = ctx.computeShot(state, pi, st.type);
        if (shot) {
          // 击球瞬间球拍真实触球：拍面落到球上（略越过球），而不是隔空挥空
          p.paddle.p = reach;
          st.end = reach;
          st.n = ctx.vnorm(shot.vel);
          st.outSpeed = shot.outSpeed;
          st.validVel = shot.vel;
          st.validSpin = shot.spin;
          applyPaddleHit(state, pi);
        }
      }
    }

    if (prog >= 1) {
      st.active = false;
      p.hitCd = 0.22;
      // 回到准备姿势
      const f = p.facing;
      const z = f > 0 ? Math.min(p.z + f * 0.42, -0.1) : Math.max(p.z + f * 0.42, 0.1);
      p.paddle.p = ctx.vec(p.padX, p.crouch ? ctx.RULES.CROUCH_PADDLE_Y : 0.98, z);
      p.paddle.n = ctx.vec(0, 0, f);
      p.paddle.v = ctx.vec(0, 0, 0);
    }
  }

  return { startServeStroke, applyPaddleHit, startRallyStroke, applyServeHit, updateStroke };
});
