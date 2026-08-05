/* ============================================================
 * ai.js — 人机对手控制器（单机模式）
 * 策略：预测球到达己方击球平面的时间/落点 → 移动到位
 *      击球窗口内按球高选择推球（下旋卸力）或扣球（强上旋）
 *      发球权轮到自己时自动发球
 * 三档难度：简单（反应慢、站位偏、只推球）/ 普通 / 困难（反应快、准、爱扣杀）
 * 纯逻辑无 DOM 依赖，可在 Node 中直接测试
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIController = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const T = (typeof TT !== 'undefined') ? TT : require('./engine.js');
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const LEVELS = [
    // catchProb：该难度能接到的来球比例（其余为"漏接"——不挥拍让球飞过），
    // 是档位间最直观的差距来源（中等明显漏接、困难几乎不漏、地狱故意漏 12% 保持可战胜）。
    // lowShotProb：刻意打低球（低平快球）的概率——困难 1/5、地狱 1/2，逼玩家蹲下或失误。
    { name: '简单', react: 0.30, err: 0.26, agility: 0.45, smashY: 1.45, smashProb: 0, catchProb: 0.55, lowShotProb: 0 },
    { name: '中等', react: 0.18, err: 0.16, agility: 0.75, smashY: 1.22, smashProb: 0.55, catchProb: 0.78, lowShotProb: 0 },
    { name: '困难', react: 0.05, err: 0.04, agility: 1.00, smashY: 1.10, smashProb: 1, catchProb: 0.90, lowShotProb: 0.20 },
    // 地狱：反应/站位/扣杀全面拉满，接球率 88%（有 12% 刻意漏接，保持可战胜）；一半回球是低平快球
    { name: '地狱', react: 0.02, err: 0.015, agility: 1.00, smashY: 1.05, smashProb: 1, catchProb: 0.88, lowShotProb: 0.50 },
  ];

  // 每个引擎实例、每个方位各一份 AI 状态（确定性种子随机，便于测试）。
  // 注意按 (engine, side) 区分：AI vs AI / 观战模式时双方各用各的状态，
  // 单人对战（只有 side 1 用 AI）行为与原来完全一致。
  const stateMap = new Map();
  function getState(engine, side) {
    let pair = stateMap.get(engine);
    if (!pair) { pair = { 0: null, 1: null }; stateMap.set(engine, pair); }
    if (!pair[side]) {
      pair[side] = {
        level: 1,
        rng: 20260802 + side * 7919,
        serveCd: 0,
        hitDelay: 0,
        errTarget: 0,
        errT: 0,
        moveT: 0,
        catchRolled: false, // 本次来球是否已决定接/漏（每球只掷一次）
        catchOk: true,
        lowRolled: false,   // 本次来球是否已决定"刻意打低球"（每球只掷一次）
        lowThisBall: false,
      };
    }
    return pair[side];
  }

  function rnd(s) {
    s.rng = (s.rng * 16807) % 2147483647;
    return s.rng / 2147483647;
  }

  // 预测球首次到达 z=zc 平面的时间与位置（含反弹/旋转/阻力，步进 20ms）
  function predictCrossing(ball, zc, maxT) {
    const steps = Math.ceil(maxT / 0.02);
    let prevZ = ball.pos.z;
    let prevPos = ball.pos;
    for (let i = 1; i <= steps; i++) {
      const t = i * 0.02;
      const p = T.predictBall(ball, t);
      if ((prevZ - zc) * (p.z - zc) <= 0) {
        const f = Math.abs(p.z - zc) / (Math.abs(p.z - zc) + Math.abs(prevZ - zc) + 1e-9);
        return {
          t: t - 0.02 * f,
          x: prevPos.x + (p.x - prevPos.x) * (1 - f),
          y: prevPos.y + (p.y - prevPos.y) * (1 - f),
        };
      }
      prevZ = p.z;
      prevPos = p;
    }
    return null;
  }

  // 每帧调用：把 AI 的按键意图写入引擎。
  // tune（可选）：难度基准上的参数微调倍率 { reactMul, catchMul, smashMul, agilityMul }，
  // 不传时按难度基准原样运行（人机模式/模拟工具不受影响）。
  function control(engine, side, dt, level, tune) {
    const s = getState(engine, side);
    s.level = level;
    const L = LEVELS[level] || LEVELS[1];
    const t = tune || {};
    // 有效参数：基准 × 倍率（反应越大越快=延迟越小；其余越大越强），并夹取安全范围
    const react = L.react / (t.reactMul == null ? 1 : t.reactMul);
    const catchProb = clamp(L.catchProb * (t.catchMul == null ? 1 : t.catchMul), 0.20, 0.99);
    const smashProb = clamp(L.smashProb * (t.smashMul == null ? 1 : t.smashMul), 0, 1);
    const agility = clamp(L.agility * (t.agilityMul == null ? 1 : t.agilityMul), 0, 1);
    const p = engine.players[side];
    const opp = engine.players[1 - side];
    const b = engine.ball;
    const f = p.facing;

    let l = 0, r = 0, fwd = 0, back = 0, pu = 0, sm = 0, lp = 0, crouch = 0, run = 0;

    // 站位误差目标定期刷新（模拟人类判断偏差）
    s.errT -= dt;
    if (s.errT <= 0) {
      s.errT = 0.35 + rnd(s) * 0.25;
      s.errTarget = (rnd(s) - 0.5) * 2 * L.err;
    }

    if (engine.phase === 'serve') {
      if (engine.server === side && b.inHand) {
        // 发球：脉冲按键（引擎要求上升沿触发，失败后 0.4s 重试）
        if (s.serveCd <= 0) {
          pu = 1;
          s.serveCd = 0.40;
        }
        s.serveCd -= dt;
      }
      // 接发站位：跟随对方站位三分偏中
      const tx = clamp(opp.x * 0.45, -1.2, 1.2);
      if (tx < p.x - 0.06) l = 1;
      else if (tx > p.x + 0.06) r = 1;
      // 回位到基础站位（与玩家相同的移动范围）
      const baseZ = side === 0 ? -T.RULES.PLAYER_Z : T.RULES.PLAYER_Z;
      if (baseZ > p.z + 0.08) fwd = 1;
      else if (baseZ < p.z - 0.08) back = 1;
    } else if (engine.phase === 'play' && !b.inHand) {
      const zc = p.z + f * 0.42;
      const incoming = b.vel.z * f < 0;
      const cross = predictCrossing(b, zc, 1.4);

      // 移动目标
      let targetX = p.x;
      if (incoming && cross && cross.y > 0.08) {
        targetX = clamp(cross.x + s.errTarget, -2.3, 2.3);
      } else if (Math.abs(b.pos.z - zc) < 1.0) {
        targetX = clamp(b.pos.x + s.errTarget, -2.3, 2.3);
      }
      if (engine.mayHit[side]) {
        targetX = clamp(b.pos.x + s.errTarget, -2.3, 2.3);
      }

      // 前后站位（与玩家相同的移动范围）：来球时迎到球前，球在对方半场时回位
      let targetZ = side === 0 ? -T.RULES.PLAYER_Z : T.RULES.PLAYER_Z;
      if (incoming) targetZ = clamp(b.pos.z - f * 0.42, -T.RULES.Z_BACK, T.RULES.Z_BACK);
      const dzF = (targetZ - p.z) * f; // 沿朝向的位移（正=向前）
      if (dzF > 0.10) fwd = 1;
      else if (dzF < -0.10) back = 1;

      // 蹲下（与玩家 Ctrl 蹲下相同）：来球很低且接近时压低接球箱，可接贴地球
      const ballNear = Math.hypot(b.pos.x - p.x, b.pos.y - 1.0, b.pos.z - zc);
      crouch = incoming && b.pos.y < 0.95 && ballNear < 1.6 ? 1 : 0;

      // 移动输出（敏捷度 = 移动占空比，简单难度明显更慢；追远球时跑步加速）
      const dx = targetX - p.x;
      const dz = targetZ - p.z;
      s.moveT += dt;
      const wantMove = Math.abs(dx) > 0.045 || Math.abs(dz) > 0.10;
      if ((s.moveT % 0.12) < 0.12 * agility && wantMove) {
        if (dx > 0) r = 1;
        else l = 1;
      }
      run = (Math.abs(dx) > 0.9 || Math.abs(dz) > 0.9) ? 1 : 0;

      // 击球判断：与玩家同一碰撞箱（进箱即命中；蹲下时用蹲下箱，可接贴地球）
      const R = T.RULES;
      const yTop = crouch ? R.CROUCH_HITBOX_Y_TOP : R.HITBOX_Y_TOP;
      const yBottom = crouch ? R.CROUCH_HITBOX_Y_BOTTOM : R.HITBOX_Y_BOTTOM;
      const inBox = Math.abs(b.pos.x - p.x) < R.HITBOX_HX &&
        Math.abs(b.pos.z - zc) < R.HITBOX_HZ &&
        b.pos.y > yBottom && b.pos.y < yTop;
      const hittable = incoming && engine.mayHit[side] && inBox;
      if (hittable) {
        // 每球只掷一次"接/漏"：catchProb 定义的接球概率（地狱=88%，可微调）
        if (!s.catchRolled) {
          s.catchRolled = true;
          s.catchOk = (catchProb == null) || (rnd(s) < catchProb);
        }
        if (s.catchOk) {
          // 每球只掷一次"是否刻意打低球"（困难 1/5、地狱 1/2）：
          // 低平快球贴网低飞、过网后下坠，逼迫对手蹲下或失误
          if (!s.lowRolled) {
            s.lowRolled = true;
            s.lowThisBall = rnd(s) < (L.lowShotProb || 0);
          }
          s.hitDelay += dt;
          if (s.hitDelay >= react) {
            if (s.lowThisBall) lp = 1;
            else if (b.pos.y >= L.smashY && rnd(s) < smashProb) sm = 1;
            else pu = 1;
          }
        }
      } else {
        s.hitDelay = 0;
        s.catchRolled = false;
        s.lowRolled = false;
      }
    } else {
      // 得分/结束阶段：回中 + 回位
      if (p.x > 0.15) l = 1;
      else if (p.x < -0.15) r = 1;
      const baseZ = side === 0 ? -T.RULES.PLAYER_Z : T.RULES.PLAYER_Z;
      if (baseZ > p.z + 0.08) fwd = 1;
      else if (baseZ < p.z - 0.08) back = 1;
    }

    T.setInput(engine, side, { l, r, f: fwd, b: back, pu, sm, lp, crouch, run });
    return { l, r, f: fwd, b: back, pu, sm, lp, crouch, run };
  }

  function reset() {
    stateMap.clear();
  }

  return { control, reset, LEVELS };
});
