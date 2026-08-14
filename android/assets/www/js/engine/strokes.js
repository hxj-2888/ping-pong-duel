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
    // 瞄准模式：直接使用鼠标/手指瞄准时求解好的方案（预览即实发）；
    // 未瞄准（AI 自动发球/键盘发球）时按原逻辑搜索默认轨迹。
    // 修复"有时无法发球"：瞄准目标解不出合法发球（站位偏离中心等，serveAimBlocked）时
    // 不再硬性禁止发球——回退到默认合法发球轨迹（solveServe），
    // 避免"无法发球 → 6s 发球超时丢分"的卡死体验（轨迹预览仍按 sb 标志隐藏，按下发球键能正常发出）。
    let plan = (p.serveAimSet && p.servePlan && !p.serveAimBlocked)
      ? p.servePlan
      : ctx.solveServe(state, pi, type === 2);
    // v1.6.1：修复"发球无法落到对方球台"——瞄准后移动站位会使旧 plan 失效（按新发球点发射轨迹出界）。
    // 用当前发球点复验（serveLanding），失效则回退默认求解，保证实发与预览轨迹一致。
    if (plan && p.serveAimSet) {
      const H = ctx.serveBallPos(p);
      if (!ctx.serveLanding(H, plan.vel, plan.spin, pi)) {
        plan = ctx.solveServe(state, pi, type === 2);
      }
    }
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
      const inCounter = b.hitType === 2 || b.hitType === 3; // 来球是扣杀或低平快球（反击奖励判定用）
      // v2.0:记录"反击"标记(推球回击扣杀/低平,AI 也记录)——人机/观战感叹号触发依据
      const isCounterHit = inCounter && st.type !== 2;
      b.wasCounter = isCounterHit ? 1 : 0;
      // 采用求解器验证过的精确出球（方向+速度+旋转均一致）
      b.vel = { ...st.validVel };
      b.spin = { ...st.validSpin };
      b.hitBy = pi;
      b.hitType = st.type;
      // 操作奖励：人类（非 AI）以推球回击扣杀/低平快球成功 → 该回球视为扣杀（AI 应对概率减半，见 ai.js）
      b.counterSmash = (isCounterHit && !state.players[pi].isAI) ? 1 : 0;
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
    // 补全合法回球校验（修复偶像/变招球未过网却判得分）：物理兜底路径（无求解验证）的出球
    // 用 rallyFlightOk 校验合法过网；若球会以非法高度（擦网顶下缘低于合法净空）越过球网，
    // 强制改打撞网（对方得分，判分显示「未过网」）；短球/正常落地不受影响
    if (!ctx.rallyFlightOk(b.pos, b.vel, b.spin, 1 - pi, 0.01, 100)) {
      const sim = { pos: { ...b.pos }, vel: { ...b.vel }, spin: { ...b.spin } };
      let clipped = false;
      for (let i = 0; i < 40; i++) {
        ctx.physicsStep(sim, 0.02, (ev) => { if (ev.type === 'netclip') clipped = true; });
        if (clipped) break;
        if (sim.pos.y - ctx.RULES.BALL_RADIUS <= 0.004) break; // 落地（短球/出界）：不干预
        if (Math.sign(b.pos.z) !== 0 && Math.sign(b.pos.z) !== Math.sign(sim.pos.z)) break; // 已自然撞网/正常跨越
      }
      if (clipped) {
        // 非法擦网顶过网 → 改打撞网：球打到网上弹回本方 → 对方得分（未过网）
        const tN = Math.max(0.08, Math.abs(b.pos.z) / 6);
        const vyN = (0.82 - b.pos.y + 0.5 * ctx.RULES.GRAVITY * tN * tN) / tN;
        b.vel = ctx.vec(0, ctx.clamp(vyN, -2, 4), f * 6);
        b.spin = ctx.vec(0, 0, 0);
      }
    }
    const inCounter = b.hitType === 2 || b.hitType === 3; // 来球是扣杀或低平快球（反击奖励判定用）
    // v2.0:记录"反击"标记(推球回击扣杀/低平,AI 也记录)——人机/观战感叹号触发依据
    const isCounterHit = inCounter && st.type !== 2;
    b.wasCounter = isCounterHit ? 1 : 0;
    b.hitBy = pi;
    b.hitType = st.type;
    // 操作奖励：人类（非 AI）以推球回击扣杀/低平快球成功 → 该回球视为扣杀（AI 应对概率减半，见 ai.js）
    b.counterSmash = (isCounterHit && !state.players[pi].isAI) ? 1 : 0;
    b.lastBounce = pi;
    b.netTouched = false;
    b.netBlocked = false;
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
    const ok = shot && !shot.netHit; // netHit（撞网）无出球方向，用默认挥拍方向
    const dir = ctx.vnorm(ok ? shot.vel : ctx.vec(0, 0.18, f));
    // 视觉挥拍：从球后方挥向球前方（跟随出球方向）
    const start = ctx.vsub(b.pos, ctx.vscale(dir, 0.36));
    const end = ctx.vadd(b.pos, ctx.vscale(dir, 0.36));
    // 养成能力(仅本地/人机注入,联机恒 0)：dur 每级 -6% / windup 每级 -10% / 碰撞箱 hx·hz 每级 +3%
    const abi = p.ability || {};
    const durMul = 1 - 0.06 * (abi.dur || 0);
    const hitboxMul = 1 + 0.03 * (abi.hitbox || 0);
    const dur = (type === 2 ? 0.30 : type === 3 ? 0.32 : 0.40) * durMul;
    p.stroke = {
      active: true, type, t: 0, dur,
      speed: ctx.vlen(ctx.vsub(end, start)) / dur,
      start, end, dir,
      n: ctx.vnorm(ok ? shot.vel : ctx.vec(0, 0.18, f)),
      hit: false, ct: -1, outSpeed: ok ? shot.outSpeed : 0,
      windup: 0.08 * (1 - 0.10 * (abi.windup || 0)), live: 0.20,
      // 球员接球碰撞箱（进箱即命中）：球在箱内 + 窗口内按键即判定击中；
      // 蹲下时箱体下探（可接贴地球）、箱顶略降；hx/hz 随训练等级放大（AI 对手 ability 恒 0，不放大）
      box: {
        x: p.x,
        z: p.z + f * 0.42,
        hx: ctx.RULES.HITBOX_HX * hitboxMul,
        hz: ctx.RULES.HITBOX_HZ * hitboxMul,
        yTop: ctx.RULES.HITBOX_Y_TOP + (ctx.RULES.CROUCH_HITBOX_Y_TOP - ctx.RULES.HITBOX_Y_TOP) * p.crouch,
        yBottom: ctx.RULES.HITBOX_Y_BOTTOM + (ctx.RULES.CROUCH_HITBOX_Y_BOTTOM - ctx.RULES.HITBOX_Y_BOTTOM) * p.crouch,
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
    b.hitType = -1; // 发球不算扣杀
    b.counterSmash = 0; // 发球不是反击扣杀回球
    b.lastBounce = -1;
    b.netTouched = false;
    b.netBlocked = false;
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
               st.windup > 0 && st.t <= st.windup + st.live &&
               // 扣杀(type2)判箱从挥拍开始(t=0)即生效：球已入箱就按入箱瞬间的高度击球——
               // 避免 0.08s 起拍延迟把高空球压到过低位置(仅高于网顶 1.75cm 时解不出高速扣球而被迫降级成推球)；
               // 反击扣杀/反击低平快球(来球 hitType 2/3)：同样从 t=0 起判箱（免起拍延迟命中窗 [0, 0.28]s）——
               // 快球接触窗极短(10~15m/s 过箱仅 0.04~0.1s)，起拍延迟会让"反应式按压/弹台后按"错过命中窗
               // (否则必须提前 0.15~0.2s 预判起拍)；普通来球保留起拍延迟(挥拍蓄力动画 + 时机感)
               (st.type === 2 || state.ball.hitType === 2 || state.ball.hitType === 3 || st.t >= st.windup)) {
      const b = state.ball;
      st.box.x = p.x;
      st.box.z = p.z + p.facing * 0.42;
      st.box.yTop = ctx.RULES.HITBOX_Y_TOP + (ctx.RULES.CROUCH_HITBOX_Y_TOP - ctx.RULES.HITBOX_Y_TOP) * p.crouch;
      st.box.yBottom = ctx.RULES.HITBOX_Y_BOTTOM + (ctx.RULES.CROUCH_HITBOX_Y_BOTTOM - ctx.RULES.HITBOX_Y_BOTTOM) * p.crouch;
      const inBox = Math.abs(b.pos.x - st.box.x) < st.box.hx &&
        Math.abs(b.pos.z - st.box.z) < st.box.hz &&
        b.pos.y > st.box.yBottom && b.pos.y < st.box.yTop;
      if (inBox && state.mayHit[pi]) {
        // 反击低平快球奖励（更高档）：人类（非 AI）以推球接回低平快球（hitType 3）→
        // 该回球更高球速 + 刁钻落位（见 shots.js computeShot fastCounter）；每次击球前设置、求解后清除
        p.counterLowBonus = (state.ball.hitType === 3 && st.type === 1 && !p.isAI) ? 1 : 0;
        // 球拍自动伸向球（仅作击球动画，不再是命中门槛）
        const reach = ctx.vadd(b.pos, ctx.vscale(st.n, 0.04));
        const k = 1 - Math.exp(-40 * dt);
        p.paddle.p = ctx.vlerp(p.paddle.p, reach, k);
        st.end = reach;
        st.start = { ...p.paddle.p }; // 锚点跟随，避免插值把球拍拉回原挥拍路线
        const shot = ctx.computeShot(state, pi, st.type);
        p.counterLowBonus = 0;
        if (shot) {
          // 击球瞬间球拍真实触球：拍面落到球上（略越过球），而不是隔空挥空
          p.paddle.p = reach;
          st.end = reach;
          if (shot.netHit) {
            // 扣杀解不出合法过网轨迹 → **球直接撞网**：挥拍命中但把球打进网，
            // 物理 net 事件 → 球弹回本方 → 对方得分（右键=快扣杀或撞网）
            const f = p.facing;
            const tN = Math.max(0.08, Math.abs(b.pos.z) / 6);   // 到网时间（出球 6m/s）
            const vyN = (0.82 - b.pos.y + 0.5 * ctx.RULES.GRAVITY * tN * tN) / tN;
            st.n = ctx.vec(0, 0.2, f);
            st.outSpeed = 6;
            st.validVel = ctx.vec(0, ctx.clamp(vyN, -2, 4), f * 6);
            st.validSpin = ctx.vec(0, 0, 0);
          } else {
            st.n = ctx.vnorm(shot.vel);
            st.outSpeed = shot.outSpeed;
            st.validVel = shot.vel;
            st.validSpin = shot.spin;
          }
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
