/* ============================================================
 * engine.js — 共享乒乓球比赛引擎（Workers ESM 版）
 * 与 public/js/engine.js 逻辑一致，但把动态 require 改为静态 import
 * （Cloudflare Workers 打包不支持动态 require）。
 * 各 engine/ 模块为 UMD：wrangler 的 CJS interop 会把 module.exports（factory）
 * 作为默认导出，这里传入共享 ctx 组装。
 * ============================================================ */
'use strict';

import rules from './engine/rules.js';
import math from './engine/math.js';
import state from './engine/state.js';
import physics from './engine/physics.js';
import shots from './engine/shots.js';
import strokes from './engine/strokes.js';

const ctx = {};
const parts = [rules, math, state, physics, shots, strokes];
for (const part of parts) {
  const api = part(ctx);
  for (const key of Object.keys(api)) ctx[key] = api[key];
}

// ---------- 主推进 ----------
function step(state, dt) {
  if (dt <= 0) return;
  dt = Math.min(dt, 0.05);
  state.t += dt;
  state.phaseT += dt;

  if (state.phase === 'over') {
    if (state.phaseT > 8) ctx.resetMatch(state);
    return;
  }

  const prevBall = { ...state.ball.pos };
  for (let i = 0; i < 2; i++) {
    if (state.players[i].stroke.active) {
      state.players[i].stroke.prevPaddle = { ...state.players[i].paddle.p };
    }
  }

  for (let i = 0; i < 2; i++) {
    const p = state.players[i];
    const inp = state.inputs[i], prev = state.prev[i];
    const f = p.facing;
      p.hitCd = Math.max(0, p.hitCd - dt);
      // 球拍定位模式：按键直接移动球拍，人跟随球拍（而不是人带动球拍）
      // 跑步（Shift）加速 / 蹲下（Ctrl）减速
      const moveSpeed = ctx.RULES.PLAYER_SPEED * (inp.run ? ctx.RULES.RUN_SPEED_MUL : (inp.crouch ? ctx.RULES.CROUCH_SPEED_MUL : 1));
      const dir = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
      p.padX = ctx.clamp(p.padX + dir * moveSpeed * dt, -ctx.RULES.MAX_X, ctx.RULES.MAX_X);
      p.vx = ctx.damp(p.vx, dir * moveSpeed, 10, dt);
    p.x = ctx.clamp(ctx.damp(p.x, p.padX - f * 0.18, 16, dt), -ctx.RULES.MAX_X, ctx.RULES.MAX_X);
    // 前后移动（朝向球台为前 / 远离球台为后），范围按各自半场限制
      const fDir = f * ((inp.f ? 1 : 0) - (inp.b ? 1 : 0));
      p.vz = ctx.damp(p.vz, fDir * moveSpeed, 10, dt);
      const zLo = p.side === 0 ? -ctx.RULES.Z_BACK : ctx.RULES.Z_FWD;
      const zHi = p.side === 0 ? -ctx.RULES.Z_FWD : ctx.RULES.Z_BACK;
      p.z = ctx.clamp(p.z + p.vz * dt, zLo, zHi);
      // 台面禁区（含人物整体尺寸）：候选位置若进入台面正投影，就沿“最近的边”平滑推出——
      // 人物从一开始就进不了台面（正面走被端线挡住、侧面切被台边挡住），而不是先进去再被赶出来
      const TW = ctx.RULES.TABLE_WIDTH / 2, TL = ctx.RULES.TABLE_LENGTH / 2;
      const rw = TW + ctx.RULES.PLAYER_BODY_W, rl = TL + ctx.RULES.PLAYER_BODY_D;
      if (Math.abs(p.x) <= rw && Math.abs(p.z) <= rl) {
        const dx = rw - Math.abs(p.x);
        const dz = rl - Math.abs(p.z);
        if (dx < dz) {
          p.x = p.x >= 0 ? rw : -rw;    // 从侧面进入：横向推到台边外（贴边滑动）
          p.padX = p.x + f * 0.18;      // 同步球拍定位坐标，避免球/拍继续飘进台面
        } else {
          p.z = p.side === 0 ? -rl : rl; // 从端线进入：退到端线后
        }
      }
      p.crouch = inp.crouch ? 1 : 0;
      p.run = inp.run ? 1 : 0;
      p.lean = ctx.damp(p.lean, p.vx * 0.055, 8, dt);
    p.swingBack = Math.max(0, p.swingBack - dt * 3.2);

    if (p.stroke.active) {
      // 双击扣球升级：推球挥拍未出球时收到扣球边沿 → 重算为扣球（输入零延迟方案）
      const smEdge = inp.sm && !prev.sm;
      if (smEdge && !p.stroke.hit && p.stroke.type === 1 &&
          p.stroke.t < p.stroke.windup + p.stroke.live &&
          state.phase === 'play' && !state.ball.inHand) {
        ctx.startRallyStroke(state, i, 2);
      }
      ctx.updateStroke(state, i, dt);
    } else if (p.hitCd <= 0) {
      const puEdge = inp.pu && !prev.pu;
      const smEdge = inp.sm && !prev.sm;
      const lpEdge = inp.lp && !prev.lp;
      if (puEdge || smEdge || lpEdge) {
        const type = smEdge ? 2 : lpEdge ? 3 : 1;
        if (state.phase === 'serve' && state.ball.inHand && state.server === i) {
          ctx.startServeStroke(state, i, type);
        } else if (state.phase === 'play' && !state.ball.inHand) {
          ctx.startRallyStroke(state, i, type);
        }
      }
    }
  }

  for (let i = 0; i < 2; i++) {
    state.prev[i] = { ...state.inputs[i] };
  }

  // 发球时球跟随持拍手
  if (state.ball.inHand && state.phase === 'serve') {
    const p = state.players[state.server];
    // 待发时球拍保持准备姿势并跟随球员移动（挥拍过程中不干预）
    if (!p.stroke.active) {
      const f = p.facing;
      // 发球持拍位置跟随球员，球始终在拍前 0.10m（serveBallPos）
      p.paddle.p = ctx.vec(p.padX, p.crouch ? ctx.RULES.CROUCH_PADDLE_Y : 0.98, p.z + f * 0.42);
      p.paddle.n = ctx.vec(0, 0, f);
      p.paddle.v = ctx.vec(0, 0, 0);
    }
    state.ball.pos = ctx.serveBallPos(p);
  }

  // 对打/得分间隙：无挥拍时球拍始终回到定位坐标 padX，
  // 使“按右键球拍先动、身体跟随”的定位模式在实战中同样生效
  if (!state.ball.inHand) {
    for (let i = 0; i < 2; i++) {
      const p = state.players[i];
      if (!p.stroke.active) {
        const f = p.facing;
        // 待机球拍保持在己方半场一侧（不越过球网）
        const z = f > 0 ? Math.min(p.z + f * 0.42, -0.1) : Math.max(p.z + f * 0.42, 0.1);
        p.paddle.p = ctx.vec(p.padX, p.crouch ? ctx.RULES.CROUCH_PADDLE_Y : 0.98, z);
        p.paddle.n = ctx.vec(0, 0, f);
        p.paddle.v = ctx.vec(0, 0, 0);
      }
    }
  }

  if (!state.ball.inHand && (state.phase === 'play' || state.phase === 'point')) {
    stepBall(state, dt);
  }

  if (state.phase === 'point' && state.phaseT > 1.5) ctx.startNextServe(state);
}

function stepBall(state, dt) {
  const wasPlay = state.phase === 'play';
  ctx.physicsStep(state.ball, dt, (ev) => {
    if (!wasPlay) return;
    if (ev.type === 'bounce') ctx.onBallBounce(state);
    else if (ev.type === 'net') {
      state.ball.netTouched = true;
      ctx.pushEvent(state, 'net');
    } else if (ev.type === 'netclip') {
      state.ball.netTouched = true;
    } else if (ev.type === 'floor') {
      ctx.onBallFloor(state);
    }
  });
}

function snapshot(state) {
  return {
    t: Math.round(state.t * 1000),
    ph: ctx.PHASE_ID[state.phase],
    pt: state.phaseT,
    pw: state.pointWinner,
    pr: state.pointReason,
    sc: [state.score[0], state.score[1]],
    sv: state.server,
    sn: state.serveNum,
    rc: state.rallyCount,
    p: state.players.map((pl) => ({
      x: pl.x,
      z: pl.z,
      vx: pl.vx,
      vz: pl.vz,
      lean: pl.lean,
      st: pl.stroke.active ? [pl.stroke.type, pl.stroke.t, pl.stroke.dur] : [0, 0, 0],
      pc: [pl.paddle.p.x, pl.paddle.p.y, pl.paddle.p.z],
      pn: [pl.paddle.n.x, pl.paddle.n.y, pl.paddle.n.z],
        pv: [pl.paddle.v.x, pl.paddle.v.y, pl.paddle.v.z],
        sb: pl.swingBack,
        cq: pl.crouch,  // 蹲下状态（渲染层画蹲姿）
        rn: pl.run,     // 跑步状态
      })),
    b: state.ball.inHand
      ? null
      : [state.ball.pos.x, state.ball.pos.y, state.ball.pos.z,
         state.ball.vel.x, state.ball.vel.y, state.ball.vel.z,
         state.ball.spin.x, state.ball.spin.y, state.ball.spin.z],
    bh: state.ball.inHand
      ? [state.ball.pos.x, state.ball.pos.y, state.ball.pos.z]
      : null,
    // 发球方案（发球待发/挥拍期间持拍手已生成）：客户端据此画精确发球预测轨迹
    sp: state.phase === 'serve' && state.ball.inHand && state.players[state.server].servePlan
      ? [state.players[state.server].servePlan.vel.x,
         state.players[state.server].servePlan.vel.y,
         state.players[state.server].servePlan.vel.z,
         state.players[state.server].servePlan.spin.x,
         state.players[state.server].servePlan.spin.y,
         state.players[state.server].servePlan.spin.z]
      : null,
    // 发球被阻止（瞄准目标解不出合法发球）：客户端据此隐藏轨迹并禁止发球
    sb: state.phase === 'serve' && state.ball.inHand && state.players[state.server].serveAimBlocked ? 1 : 0,
    ev: state.events.slice(-6),
  };
}

export default {
  RULES: ctx.RULES, PHASE_ID: ctx.PHASE_ID, PHASE_NAME: ctx.PHASE_NAME,
    createEngine: ctx.createEngine, step, setInput: ctx.setInput,
    snapshot, resetMatch: ctx.resetMatch,
    solveShot: ctx.solveShot, solveServe: ctx.solveServe,
    solveServeTo: ctx.solveServeTo, setServeAim: ctx.setServeAim,
    serveLanding: ctx.serveLanding,
    solveRally: ctx.solveRally, computeShot: ctx.computeShot,
    serveFlightOk: ctx.serveFlightOk, predictBall: ctx.predictBall,
    physicsStep: ctx.physicsStep, vlen: ctx.vlen,
};
