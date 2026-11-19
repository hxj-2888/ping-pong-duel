/* ============================================================
 * engine/physics.js — 球体物理：子步进/反弹/落点判断（拆分自 engine.js）
 * 本模块通过共享上下文 ctx 使用其他模块的接口，不直接改动其他文件。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.TTPhysics = factory;
})(typeof self !== 'undefined' ? self : this, function (ctx) {
  'use strict';

  function physicsStep(ball, dt, cb) {
    let remaining = dt;
    const R = ctx.RULES.BALL_RADIUS;
    const TW = ctx.RULES.TABLE_WIDTH / 2, TL = ctx.RULES.TABLE_LENGTH / 2;
    while (remaining > 0) {
      const h = Math.min(ctx.SUBSTEP, remaining);
      const a = { x: 0, y: -ctx.RULES.GRAVITY, z: 0 };
      const mag = ctx.vcross(ball.spin, ball.vel);
      a.x += ctx.K_MAG * mag.x; a.y += ctx.K_MAG * mag.y; a.z += ctx.K_MAG * mag.z;
      const sp = ctx.vlen(ball.vel);
      if (sp > 0.05) {
        const k = ctx.K_DRAG * sp;
        a.x -= k * ball.vel.x; a.y -= k * ball.vel.y; a.z -= k * ball.vel.z;
      }
      const prevZ = ball.pos.z;
      ball.vel.x += a.x * h; ball.vel.y += a.y * h; ball.vel.z += a.z * h;
      ball.pos.x += ball.vel.x * h;
      ball.pos.y += ball.vel.y * h;
      ball.pos.z += ball.vel.z * h;

      // 台面反弹（仅上表面；擦边按未中处理）
      if (ball.pos.y - R <= ctx.RULES.TABLE_HEIGHT && ball.vel.y < 0 &&
          Math.abs(ball.pos.x) <= TW && Math.abs(ball.pos.z) <= TL) {
        ball.pos.y = ctx.RULES.TABLE_HEIGHT + R;
        ball.vel.y = -ball.vel.y * ctx.E_TABLE;
        ball.vel.x *= ctx.TABLE_FRICTION;
        ball.vel.z *= ctx.TABLE_FRICTION;
        ball.vel.z += ball.spin.x * ctx.SPIN_BOUNCE; // 上旋加速前冲 / 下旋减速
        ball.spin.x *= 0.78; ball.spin.y *= 0.9; ball.spin.z *= 0.9;
        if (cb) { if (cb({ type: 'bounce' })) return; } // 回调返回 true 可提前中断（如求解已出结果）
      }

      // 球网
      if (Math.abs(ball.pos.x) <= ctx.RULES.NET_WIDTH / 2 + R &&
          ball.pos.y - R < ctx.RULES.TABLE_HEIGHT + ctx.RULES.NET_HEIGHT &&
          Math.sign(prevZ) !== 0 && Math.sign(prevZ) !== Math.sign(ball.pos.z)) {
        if (ball.pos.y > ctx.RULES.TABLE_HEIGHT + ctx.RULES.NET_HEIGHT - 0.008) {
          if (cb) { if (cb({ type: 'netclip' })) return; } // 擦网顶仍过网
        } else {
          ball.pos.z = Math.sign(prevZ) * 0.012;
          ball.vel.z = -ball.vel.z * 0.22;
          ball.vel.x *= 0.70;
          ball.vel.y *= 0.50;
          ball.spin.x *= 0.5;
          if (cb) { if (cb({ type: 'net' })) return; } // 回调返回 true 可提前中断
        }
      }

      // 地面
      if (ball.pos.y - R <= 0.004 && ball.vel.y < 0) {
        ball.pos.y = R;
        ball.vel.y = 0;
        if (cb) { if (cb({ type: 'floor' })) return; } // 回调返回 true 可提前中断
      } else if (ball.pos.y - R <= 0.004 && ball.vel.y <= 0) {
        ball.vel.x *= 1 - 2.5 * h;
        ball.vel.z *= 1 - 2.5 * h;
      }
      remaining -= h;
    }
  }

  function predictBall(ball, t) {
    const c = { pos: { ...ball.pos }, vel: { ...ball.vel }, spin: { ...ball.spin } };
    physicsStep(c, Math.max(0.001, t), null);
    return c.pos;
  }

  function onBallBounce(state) {
    const b = state.ball;
    const side = b.pos.z > 0 ? 1 : 0;
    if (b.lastBounce === side) {
      // 球未过网（触网弹回本方半台）后同半台连弹两次：统一判「未过网」而非「两次弹跳」
      ctx.endPoint(state, 1 - side, b.netBlocked ? 'no-cross' : 'double');
      return;
    }
    // 发球阶段：擦网球（netTouched）落到对方半台 → LET 重发（无论是否先落本方，
    // 擦网过网即重发；未擦网却未先落本方才算 serve-fault）
    if (state.serveStage === 'waitOwn' || state.serveStage === 'waitOpp') {
      if (b.netTouched && side === 1 - state.server) {
        b.lastBounce = side;
        ctx.endPoint(state, -1, 'let');
        return;
      }
    }
    b.lastBounce = side;
    if (state.serveStage === 'waitOwn') {
      if (side !== state.server) { ctx.endPoint(state, 1 - state.server, 'serve-fault'); return; }
      state.serveStage = 'waitOpp';
      state.mayHit = [false, false]; // 发球方已击过一次，不能再击
      ctx.pushEvent(state, 'bounce', side);
      return;
    } else if (state.serveStage === 'waitOpp') {
      if (side !== 1 - state.server) { ctx.endPoint(state, 1 - state.server, 'serve-fault'); return; }
      state.serveStage = 'rally';
      if (b.netTouched) { ctx.endPoint(state, -1, 'let'); return; } // 触网入界 → 重发
    }
    state.mayHit = [side === 0, side === 1];
    ctx.pushEvent(state, 'bounce', side);
  }

  function onBallFloor(state) {
    const b = state.ball;
    const striker = b.hitBy;
    if (striker >= 0 && b.netBlocked) {
      // 击球未过网（触网弹回本方后落地）：判「未过网」，不再误显示 未能回球/出界
      ctx.endPoint(state, 1 - striker, 'no-cross');
    } else if (striker >= 0 && b.lastBounce === 1 - striker) {
      ctx.endPoint(state, striker, 'opp-miss');   // 对方已接球但未回
    } else if (striker >= 0) {
      ctx.endPoint(state, 1 - striker, 'out');    // 击球出界/不过网
    } else {
      ctx.endPoint(state, 1 - state.server, 'fault');
    }
  }

  return { physicsStep, onBallBounce, onBallFloor, predictBall };
});