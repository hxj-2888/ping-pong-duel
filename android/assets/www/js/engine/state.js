/* ============================================================
 * engine/state.js — 比赛状态：创建引擎/发球流程/事件（拆分自 engine.js）
 * 本模块通过共享上下文 ctx 使用其他模块的接口，不直接改动其他文件。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.TTState = factory;
})(typeof self !== 'undefined' ? self : this, function (ctx) {
  'use strict';

  function createPlayer(side) {
    const f = side === 0 ? 1 : -1;
    return {
      side,
      x: 0,
      // 球拍定位坐标：按键直接移动它，身体跟随（球拍带动人，而不是人带动球拍）
      padX: f * 0.18,
      z: side === 0 ? -ctx.RULES.PLAYER_Z : ctx.RULES.PLAYER_Z,
      vx: 0,
      vz: 0,
      lean: 0,
      facing: f,
      hitCd: 0,
      stroke: {
        active: false, type: 0, t: 0, dur: 0.2, speed: 5,
        start: ctx.vec(0, 0, 0), end: ctx.vec(0, 0, 0), dir: ctx.vec(0, 0, 0),
        n: ctx.vec(0, 0, 0), hit: false, ct: -1,
      },
      paddle: { p: ctx.vec(f * 0.18, 0.98, side === 0 ? -0.88 : 0.88), n: ctx.vec(0, 0, f), v: ctx.vec(0, 0, 0) },
      servePlan: null,
      serveAimSet: false,  // 鼠标/手指瞄准是否已生效（发球时直接复用 servePlan）
      serveAim: null,      // 瞄准的目标落点（世界坐标）
      serveAimBlocked: false, // 瞄准目标解不出合法发球（轨迹消失、发不出球）
      crouch: 0,           // 蹲下（Ctrl）：0~1 连续值（转换延迟见 crouchTarget/toggleLag），越低接球点越低
      crouchTarget: 0,     // 蹲下目标（按键输入）
      toggleLast: -10,     // 上次蹲/站翻转时刻（用于 3 秒内反复蹲站累积延迟判定）
      toggleLag: 0,        // 当前蹲↔站转换延迟（初始 0，反复蹲站累积，最多 0.5s）
      crouchDur: 0,        // 本次持续蹲下时长（蹲越久移动越慢，站起后恢复）
      aimBias: 0,          // 回球目标 x 偏移（刁钻方向射球，人机按技巧概率设定；±0.72 内）
      run: 0,              // 跑步（Shift）：速度变快
      swingBack: 0,
      counterLowBonus: 0,  // 反击低平快球奖励：本次击球是否按"更高球速+刁钻落位"求解（击球前设置、求解后清除）
      isAI: 0,             // 是否 AI 控制（AI 控制时反击奖励不触发，见 ai.js control / strokes.js）
      speedMul: 1,         // 移动速度倍率（敏捷>1 时 AI 加成，最大 1.25；玩家恒为 1）
      // 养成能力等级（v1.8.0）：{ speed, windup, dur, hitbox } 各 0~5 级。
      // 仅本地/人机模式在 createEngine 后注入；联机服务器用默认值(恒 0)、不进快照 → 真人对战天然隔离。
      ability: { speed: 0, windup: 0, dur: 0, hitbox: 0 },
    };
  }

  function createEngine() {
    const s = {
      t: 0,
      phase: 'serve',
      phaseT: 0,
      score: [0, 0],
      server: 0,
      serveNum: 0,
      startServer: 0,
      pointWinner: -1,
      pointReason: '',
      rallyCount: 0,
      serveStage: 'ready', // ready → waitOwn → waitOpp → rally
      mayHit: [false, false],
      ball: {
        vis: true, inHand: true,
        pos: ctx.vec(0, 0.8, 0), vel: ctx.vec(0, 0, 0), spin: ctx.vec(0, 0, 0),
        hitBy: -1, hitType: -1, lastBounce: -1, netTouched: false, netBlocked: false,
      },
      players: [createPlayer(0), createPlayer(1)],
      inputs: [
        { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, lp: 0, lb: 0, crouch: 0, run: 0 },
        { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, lp: 0, lb: 0, crouch: 0, run: 0 },
      ],
      prev: [
        { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, lp: 0, lb: 0, crouch: 0, run: 0 },
        { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, lp: 0, lb: 0, crouch: 0, run: 0 },
      ],
      events: [],
    };
    resetBallToServer(s);
    return s;
  }

  function setInput(state, side, keys) {
    const k = state.inputs[side];
    k.l = keys.l ? 1 : 0; k.r = keys.r ? 1 : 0;
    k.f = keys.f ? 1 : 0; k.b = keys.b ? 1 : 0;
    k.pu = keys.pu ? 1 : 0; k.sm = keys.sm ? 1 : 0; k.lp = keys.lp ? 1 : 0;
    k.lb = keys.lb ? 1 : 0;
    k.crouch = keys.crouch ? 1 : 0;
    k.run = keys.run ? 1 : 0;
  }

  function pushEvent(state, code, side) {
    state.events.push({ t: state.t, c: code, s: side === undefined ? -1 : side });
    if (state.events.length > 8) state.events.shift();
  }

  // 发球持球点：球位于球拍正前方（与拍面中心同高，拍面法线前方 0.10m）；
  // 蹲伏值需 ≥0.5 才按蹲下发球高度（浮点残值不算，避免发球点高度抖动）
  function serveBallPos(p) {
    const f = p.facing;
    // 球始终位于球拍正前方 0.10m（不随站位被钳到奇怪位置）；
    // 若站位导致发球解不出合法轨迹，则按”无法发球”处理，需调整站位后再发
    return ctx.vec(p.padX, p.crouch >= 0.5 ? ctx.RULES.CROUCH_PADDLE_Y : 0.98, p.z + f * (0.42 + 0.10));
  }

  function resetBallToServer(state) {
    const p = state.players[state.server];
    const b = state.ball;
    b.inHand = true; b.vis = true;
    b.pos = serveBallPos(p);
    b.vel = ctx.vec(0, 0, 0); b.spin = ctx.vec(0, 0, 0);
    b.hitBy = -1; b.hitType = -1; b.lastBounce = -1; b.netTouched = false; b.netBlocked = false;
    // 新一轮发球：清空上一轮的瞄准方案，等待玩家重新瞄准
    p.servePlan = null;
    p.serveAimSet = false;
    p.serveAim = null;
    p.serveAimBlocked = false;
  }

  function nextServerIndex(state) {
    const [a, b] = state.score;
    if (a >= 10 && b >= 10) {
      return ((state.startServer + (state.serveNum - 20)) % 2 + 2) % 2;
    }
    return (state.startServer + Math.floor(state.serveNum / 2)) % 2;
  }

  function resetMatch(state) {
    state.score = [0, 0];
    state.serveNum = 0;
    state.server = 0;
    state.startServer = 0;
    state.pointWinner = -1;
    state.pointReason = '';
    state.rallyCount = 0;
    state.phase = 'serve';
    state.phaseT = 0;
    state.serveStage = 'ready';
    state.mayHit = [false, false];
    state.events.length = 0; // 清空旧事件，避免残留 over 在重开后再次触发结算屏
    // 复位挥拍与冷却，避免上一局残留动作影响新一局
    for (const p of state.players) {
      p.stroke.active = false;
      p.hitCd = 0;
    }
    resetBallToServer(state);
    pushEvent(state, 'reset');
  }

  function startNextServe(state) {
    if (state.phase === 'over') return;
    if (state.pointWinner >= 0) {
      state.score[state.pointWinner]++;
      const diff = Math.abs(state.score[0] - state.score[1]);
      const maxS = Math.max(state.score[0], state.score[1]);
      if (maxS >= ctx.RULES.WIN_SCORE && diff >= 2) {
        state.phase = 'over';
        state.phaseT = 0;
        pushEvent(state, 'over', state.pointWinner);
        return;
      }
      state.serveNum++;
    }
    state.server = nextServerIndex(state);
    state.phase = 'serve';
    state.phaseT = 0;
    state.pointWinner = -1;
    state.pointReason = '';
    state.serveStage = 'ready';
    state.mayHit = [false, false];
    state.rallyCount = 0;
    resetBallToServer(state);
    pushEvent(state, 'serve-ready', state.server);
  }

  function endPoint(state, winner, reason) {
    if (state.pointWinner !== -1) return;
    state.pointWinner = winner;
    state.pointReason = reason || '';
    state.phase = 'point';
    state.phaseT = 0;
    pushEvent(state, 'point', winner);
  }

  return { createPlayer, createEngine, setInput, pushEvent, serveBallPos, resetBallToServer, nextServerIndex, resetMatch, startNextServe, endPoint };
});
