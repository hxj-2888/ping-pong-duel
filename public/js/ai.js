/* ============================================================
 * ai.js — 人机对手控制器（单机模式）
 * 策略：预测球到达己方击球平面的时间/落点 → 移动到位
 *      击球窗口内按球高选择推球（下旋卸力）或扣球（强上旋）
 *      发球权轮到自己时自动发球
 * 四档难度：简单（反应慢、站位偏、只推球）/ 中等 / 困难（反应快、准、爱扣杀）/ 地狱
 * 扣杀应对：困难/地狱**确定性**接扣杀（站位可达 + 高度/时序成立 → 必接，不再掷骰）
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
  // 变招动作时与球桌的最大距离（m）（v1.6 需求 23：杜绝 AI 远距离异常走位）
  const TRICK_MAX_DIST = 0.7;

  const LEVELS = [
    // catchProb：该难度能接到的来球比例——以"固定间隔必漏 1 球"的计数方式实现
    // （平均概率 ≈ catchProb：0.975 → 每 40 球漏 1、0.97 → 每 33 球漏 1、1.0 → 永不漏），
    // 比每球掷骰更稳定，闯关输赢不被运气左右；是档位间最直观的差距来源。
    // lowShotProb：刻意打低球（低平快球）的概率——困难 1/5、地狱 1/2，逼玩家蹲下或失误。
    // lobProb：刻意放高吊球的概率——高吊球喂给对手制造扣杀机会（也让自己有球可扣）。
    // smashY：扣杀判定阈值（预测命中时刻的球高 ≥ smashY 才扣杀——低于真扣杀求解下限
    //   会退化成软球，所以阈值按"真扣杀可解高度 ~1.00m"设）。
    // smashDef：接扣杀"可接半径"基准（仅困难/地狱可应对，等级越高越强）——
    //   实际值 = 基准 × 接球率微调(catchMul)；扣杀来球时 |预测交叉点-站位| ≤ 半径
    //   且高度可接且时序成立 → 必接（确定性判定，不再掷骰；打边角/骗位才漏）。
    // trickBase：变招基础概率（对打两回合不进球后）——随难度递增，中等(数值=1)为 20%；
    //   实际值 = 基准 × 数值因子 + 未变招回合累积(每回合+0.10)，封顶 100%，变招后清空。
    // failSkip：判定"无法扣杀"（扣杀求解会退化/落空）时放弃扣杀的概率——
    //   困难 80%、地狱 100%，降低无谓失误。
    // trickyProb：刁钻方向射球概率（回球打向对方反方向/边角，逼对方追球）——
    //   等级越高越爱打刁钻角度，是档位间"能力差异"的一部分。
    { name: '简单', react: 0.30, err: 0.26, agility: 0.45, smashY: 1.45, smashProb: 0, catchProb: 0.55, lowShotProb: 0, lobProb: 0, smashDef: 0, trickBase: 0, failSkip: 0, trickyProb: 0 },
    { name: '中等', react: 0.12, err: 0.12, agility: 0.75, smashY: 1.00, smashProb: 0.90, catchProb: 0.95, lowShotProb: 0, lobProb: 0.15, smashDef: 0, trickBase: 0.20, failSkip: 0.5, trickyProb: 0.40 },
    { name: '困难', react: 0.05, err: 0.04, agility: 1.00, smashY: 1.00, smashProb: 1, catchProb: 0.975, lowShotProb: 0.20, lobProb: 0.15, smashDef: 0.55, trickBase: 0.24, failSkip: 0.8, trickyProb: 0.25 },
    // 地狱：反应/站位/扣杀全面拉满，**0% 刻意漏球**（catchProb=1.0）；
    // 与困难的差距全在能力：更快时机把控、高吊球、刁钻方向射球、低平快球、强扣杀与接扣杀。
    // 扣杀激进：smashY 0.95（更低球也能扣）+ failSkip 0.9（10% 时即使无法完美扣杀也出手，降级扣杀）
    { name: '地狱', react: 0.01, err: 0.01, agility: 1.00, smashY: 0.95, smashProb: 1, catchProb: 1.0, lowShotProb: 0.50, lobProb: 0.12, smashDef: 0.95, trickBase: 0.28, failSkip: 0.9, trickyProb: 0.40 },
  ];

  // 无尽关卡：以地狱为基线，反应延迟固定 0 秒、防扣杀率固定 95%；
  // 攻击/敏捷随关卡线性增长，无上限。
  const ENDLESS_ATTACK_STEP = 0.12;
  const ENDLESS_AGILITY_STEP = 0.08;

  function endlessConfig(n) {
    const k = Math.max(1, parseInt(n, 10) || 1);
    const H = LEVELS[3];
    return Object.assign({}, H, {
      name: '无尽-' + k,
      infinite: true,
      react: 0,
      catchProb: 1.0,
      smashDef: 0.95,
      attackMul: 1 + (k - 1) * ENDLESS_ATTACK_STEP,
      agilityMul: 1 + (k - 1) * ENDLESS_AGILITY_STEP,
    });
  }

  // 难度标识兼容三种形态：普通档位 0~3 / 'inf-N' 字符串 / 无尽配置对象。
  function resolveLevel(level) {
    if (level && typeof level === 'object') return level;
    if (typeof level === 'string') {
      const m = /^inf-(\d+)$/.exec(level);
      if (m) return endlessConfig(parseInt(m[1], 10));
    }
    const n = parseInt(level, 10);
    return LEVELS[n] || LEVELS[1];
  }

  function isInfiniteLevel(level) {
    return !!(resolveLevel(level).infinite);
  }

  function levelName(level) {
    return resolveLevel(level).name;
  }

  // 每个引擎实例、每个方位各一份 AI 状态（确定性种子随机，便于测试）。
  // 注意按 (engine, side) 区分：AI vs AI / 观战模式时双方各用各的状态，
  // 单人对战（只有 side 1 用 AI）行为与原来完全一致。
  const stateMap = new Map();
  function getState(engine, side, seedBase) {
    let pair = stateMap.get(engine);
    if (!pair) { pair = { 0: null, 1: null }; stateMap.set(engine, pair); }
    if (!pair[side]) {
      pair[side] = {
        level: 1,
        rng: (seedBase == null ? 20260802 : seedBase) + side * 7919,
        serveCd: 0,
        hitDelay: 0,
        errTarget: 0,
        errT: 0,
        moveT: 0,
        catchRolled: false, // 本次来球是否已决定接/漏（每球一次；普通球按固定间隔计数漏接）
        catchOk: true,
        missEvery: 0,       // 普通球"刻意漏球"间隔（每 missEvery 个可接球漏 1，按 catchProb 换算）
        catchCount: 0,      // 距下次刻意漏球的计数（跨球保留，不随回合重置）
        lowRolled: false,   // 本次来球是否已决定"刻意打低球"（每球只掷一次）
        lowThisBall: false,
        lobRolled: false,   // 本次来球是否已决定"放高吊球"（每球只掷一次）
        lobThisBall: false,
        preSwing: false,    // 扣杀来球已提前起拍（命中窗罩住球进箱时段）
        exch: 0,            // 当前回合本方已回球次数（对打计数）
        trickRolled: false, // 本次回球是否已掷"变招"（每球一次）
        trickAccum: 0,      // 未变招累积概率（每回合 +0.10，变招后清空）
        trickOn: false,     // 本次回球变招（改击球方式）
        trickMove: 0,       // 变招横向位移目标（0.4~0.7m，带符号）
        trickTimer: 0,      // 变招位移持续计时
        failRolled: false,  // 本次来球是否已判定"能否真扣杀"（每球一次）
        cannotSmash: false, // 判定无法扣杀（扣杀求解会退化）
        stuckT: 0,          // 卡位计时（球不在本方且远离基础位/网前时累积）
        trickyRolled: false, // 本次回球是否已掷"刁钻方向"（每球一次）
      };
    }
    return pair[side];
  }

  function rnd(s) {
    s.rng = (s.rng * 16807) % 2147483647;
    return s.rng / 2147483647;
  }

  // 预测球首次到达 z=zc 平面的时间与位置（含反弹/旋转/阻力，步进 20ms）
  // 低端机优化：旧实现每个采样点从当前状态重头模拟 t 秒（predictBall 内部克隆
  // 整球并重放），一次调用约 1.2 万子步；改为克隆一次、physicsStep 连续推进
  // （内部按 SUBSTEP=1/240 细分，与 predictBall 同一物理实现），采样点检测 z
  // 跨越后立即返回，约 350 子步——AI 模式物理模拟开销降一个数量级。
  function predictCrossing(ball, zc, maxT) {
    const steps = Math.ceil(maxT / 0.02);
    const c = { pos: { ...ball.pos }, vel: { ...ball.vel }, spin: { ...ball.spin } };
    let prevZ = c.pos.z;
    let prevPos = { x: c.pos.x, y: c.pos.y };
    for (let i = 1; i <= steps; i++) {
      const t = i * 0.02;
      T.physicsStep(c, 0.02, null);
      const p = c.pos;
      if ((prevZ - zc) * (p.z - zc) <= 0) {
        const f = Math.abs(p.z - zc) / (Math.abs(p.z - zc) + Math.abs(prevZ - zc) + 1e-9);
        return {
          t: t - 0.02 * f,
          x: prevPos.x + (p.x - prevPos.x) * (1 - f),
          y: prevPos.y + (p.y - prevPos.y) * (1 - f),
        };
      }
      prevZ = p.z;
      prevPos = { x: p.x, y: p.y };
    }
    return null;
  }

  // 扣杀判定：用"挥拍风起 0.08s 后命中时刻"的抛物线近似高度（上升段来球该扣杀，
  // 下降段/贴地球推球或低平快球），避免起手瞬间球高误判导致扣杀落空
  function smashReady(b, L) {
    const yHit = b.pos.y + b.vel.y * 0.08 - 0.5 * T.RULES.GRAVITY * 0.08 * 0.08;
    return yHit >= L.smashY;
  }

  // "能否真扣杀"预判（每球一次）：快扣求解无解（netHit=撞网）即判定无法扣杀，
  // 按档位 failSkip 概率放弃扣杀（困难 80%、地狱 90%），降低无谓撞网失误
  function smashAttemptAllowed(s, engine, side, L) {
    if (!s.failRolled) {
      s.failRolled = true;
      const shot = T.computeShot(engine, side, 2);
      s.cannotSmash = !(shot && !shot.netHit);
    }
    if (!s.cannotSmash) return true;
    return rnd(s) >= (L.failSkip || 0);
  }

  // AI 发球目标（v1.6.1 重构）：方向混合——朝对手站位 / 远离对手镜像 / 中路边线，按难度加权；
  // 发球距离由 AI 内部随机（短球贴网 ~ 深球压底线），落点夹取合法区间。
  // 通过 solveServeTo 求解后写入 servePlan/serveAimSet，startServeStroke 复用（预览即实发）。
  function aiServeAim(engine, side, s) {
    const p = engine.players[side], opp = engine.players[1 - side], f = p.facing;
    const TW = T.RULES.TABLE_WIDTH / 2, TL = T.RULES.TABLE_LENGTH / 2;
    const mx = TW - 0.10, mz = TL - 0.14;
    // 方向：50% 朝对手站位、30% 远离对手镜像（反方向）、20% 边线/中路
    const r = rnd(s);
    let tx;
    if (r < 0.5) tx = opp.x * 0.55;
    else if (r < 0.8) tx = -opp.x * 0.55;
    else tx = (rnd(s) < 0.5 ? -1 : 1) * (0.25 + rnd(s) * 0.35);
    tx = Math.max(-mx, Math.min(mx, tx));
    // 距离：AI 内部随机深度（0.30~0.75，距网距离），夹取合法区间
    const depth = Math.max(0.10, Math.min(0.75, 0.30 + rnd(s) * 0.45));
    const tz = f > 0 ? Math.min(mz, depth) : Math.max(-mz, -depth);
    const plan = T.solveServeTo(engine, side, tx, tz, false);
    if (plan) {
      p.servePlan = plan;
      p.serveAimSet = true;
      p.serveAimBlocked = false;
    }
  }

  // 每帧调用：把 AI 的按键意图写入引擎。
  // tune（可选）：难度基准上的参数微调倍率 { reactMul, catchMul, smashMul, agilityMul }，
  // 不传时按难度基准原样运行（人机模式/模拟工具不受影响）。
  // seed（可选）：覆盖确定性随机种子基数（模拟工具用于多种子取平均，默认 20260802）。
  function control(engine, side, dt, level, tune, seed) {
    const s = getState(engine, side, seed);
    // 标记该玩家为 AI：引擎的反击扣杀奖励据此区分"人类击球"（见 strokes.js applyPaddleHit）
    if (engine && engine.players && engine.players[side]) engine.players[side].isAI = 1;
    s.level = level;
    const L = resolveLevel(level);
    const isInf = !!L.infinite;
    const normalLevel = (!isInf && typeof level === 'number') ? level : (isInf ? -1 : 1);
    const t = tune || {};
    // 有效参数：基准 × 倍率（反应越大越快=延迟越小；其余越大越强），并夹取安全范围
    // v1.6.1：地狱反应线性调节——滑块 0.5→0.02s、1.5→0s 均匀递减（×1 仍为基准 0.01s）；其余难度保持 基准/倍率
    const reactMulT = t.reactMul == null ? 1 : t.reactMul;
    const react = isInf
      ? 0
      : (normalLevel === 3
        ? Math.max(0, Math.min(0.02, 0.02 * (1.5 - reactMulT)))
        : L.react / reactMulT);
    // 人机对战专属微调（hellCatchMul，仅地狱生效）：观战保留 catch 1.0 的强版展示，
    // 人机对战默认 ×1（地狱完全不再刻意漏球，与观战一致）——玩家可在暂停面板用 catchMul 覆盖
    const catchBase = L.catchProb * (normalLevel === 3 && t.hellCatchMul != null ? t.hellCatchMul : 1);
    // 漏球率线性模型（修复旧版 1.2 后无变化）：0.5~1.5 全程线性有效——
    // 漏球率 = 基准漏球率 / 倍率（×1.5 漏球减为 2/3、×0.5 漏球翻倍），封顶 80%、下限 0.5%；
    // 地狱基准 1.0 恒不漏球（miss=0），不受倍率影响
    const catchMul = t.catchMul == null ? 1 : t.catchMul;
    const catchMiss = catchBase >= 1 ? 0 : Math.min(0.8, Math.max(0.005, (1 - catchBase) / catchMul));
    const catchProb = 1 - catchMiss;
    // 攻击/敏捷的"溢出"加成（仅调高 >×1 时生效，×1 时恒为 0/系数 1，默认强度不变）：
    // 概率类基准已到顶（困难/地狱 smashProb=1、agility=1）或为 0（简单不扣杀）时，
    // 把多余倍率转成同属性的其他维度，避免滑杆"拖了没反应"的死区
    const smashMul = t.smashMul == null ? (isInf ? L.attackMul : 1) : t.smashMul;
    const smashOver = Math.max(0, smashMul - 1); // 攻击溢出（无尽关卡线性增长）
    const smashProb = clamp(L.smashProb * smashMul, 0, 1);
    // 简单档无扣杀基准（只推球、来球高度也达不到扣杀门）：调高攻击按溢出比例
    // 赋予少量"打刁钻角"能力（×1.5 → 20%）；其余难度概率已满/可夹取时，
    // 溢出统一转为"回球落点更刁钻"（见击球分支的 aimBias 放大）
    const trickyProbEff = (L.trickyProb || 0) + (L.smashProb <= 0 ? smashOver * 0.4 : 0);
    const agilityMul = t.agilityMul == null ? (isInf ? L.agilityMul : 1) : t.agilityMul;
    const agiOver = Math.max(0, agilityMul - 1);
    const agiUnder = Math.max(0, 1 - agilityMul);
    const agility = clamp(L.agility * agilityMul, 0, 1);
    const errScale = isInf
      ? Math.max(0.25, 1 - agiOver * 0.08)
      : 1 - agiOver * 0.6; // 溢出→站位误差缩小
    // 敏捷>1 移动速度加成：普通难度 ×1.5 封顶 +25%；无尽关卡线性无上限——
    // 写入玩家 speedMul（引擎 step 逐帧应用），与惩罚占空比并存
    const speedBonus = isInf
      ? (agilityMul - 1) * 0.5
      : Math.min(0.25, Math.max(0, agilityMul - 1) * 0.5);
    // 敏捷<1 惩罚：占空比额外折扣（mul=0.5 时再打 75 折）+ 前后(z)移动也纳入门控 + 追球死区放大
    const moveDuty = clamp(agility * (1 - agiUnder * 0.5), 0, 1);
    const moveDead = 0.045 * (1 + agiUnder * 1.5);
    // 接扣杀：**位置门 × 概率掷骰**——扣杀来球时 |落点-站位| ≤ 可接半径(0.35) 且高度/时序成立
    // 才算"够得着"，再按 smashDef 概率掷骰（困难0.55/地狱0.95）决定接不接：
    // 定标目标有效反击率 困难~50% / 地狱~80%（打偏/骗位即漏，骰子只作用于够得着的球）
    // v1.6.2：AI 观战地狱「接球」滑杆 → 防扣球 40%（×0.5）~ 90%（×1.5）均匀线性；
    // 人机对战（带 hellCatchMul）地狱 → 防扣率分段线性：×0.5→50%、×1→80%、×1.5→95%（上限封顶）
    let smashDef;
    if (isInf) {
      smashDef = L.smashDef;
    } else if (normalLevel === 3 && t.hellCatchMul == null) {
      smashDef = 0.40 + 0.50 * Math.max(0, Math.min(1, catchMul - 0.5));
    } else if (normalLevel === 3) {
      const m = Math.max(0.5, Math.min(1.5, catchMul));
      smashDef = m <= 1 ? 0.50 + 0.60 * (m - 0.5) : 0.80 + 0.30 * (m - 1);
    } else {
      smashDef = (L.smashDef || 0) <= 0 ? 0 : clamp(1 - (1 - (L.smashDef || 0)) / catchMul, 0, 1);
    }
    const smashReach = 0.35;
    // 非对打阶段（发球/得分/结束）：清空变招计数与位移
    if (engine.phase !== 'play') {
      s.exch = 0;
      s.trickAccum = 0;
      s.trickOn = false;
      s.trickMove = 0;
      s.trickTimer = 0;
    }
    const p = engine.players[side];
    p.speedMul = 1 + speedBonus; // 敏捷>1 移动速度加成（最大 +25%），引擎 step 每帧应用
    // v2.0:AI 预警闪烁(扣杀/低平预告 warnSmash 0.1s)与反击感叹号(exclaimT)计时衰减
    if (p.warnT > 0) { p.warnT -= dt; if (p.warnT <= 0) { p.warnT = 0; p.warnSmash = 0; } }
    if (p.exclaimT > 0) { p.exclaimT -= dt; if (p.exclaimT <= 0) p.exclaimT = 0; }
    const opp = engine.players[1 - side];
    const b = engine.ball;
    const f = p.facing;

    let l = 0, r = 0, fwd = 0, back = 0, pu = 0, sm = 0, lp = 0, lb = 0, crouch = 0, run = 0;

    // 站位误差目标定期刷新（模拟人类判断偏差）
    s.errT -= dt;
    if (s.errT <= 0) {
      s.errT = 0.35 + rnd(s) * 0.25;
      s.errTarget = (rnd(s) - 0.5) * 2 * L.err * errScale;
    }

    if (engine.phase === 'serve') {
      // 发球：z 方向站稳基础位且无速度后再发（发球轨迹对站位 z 极敏感，
      // 求解点与发射点必须一致；残存 vz 惯性也会让发射点漂移触网）
      if (engine.server === side && b.inHand) {
        const baseZ = side === 0 ? -T.RULES.PLAYER_Z : T.RULES.PLAYER_Z;
        const settled = Math.abs(p.z - baseZ) < 0.05 && Math.abs(p.vz) < 0.05;
        if (settled && s.serveCd <= 0) {
          // v1.6.1：AI 发球重构——主动设定发球目标（朝对手/远离对手/中路边线，距离 AI 内部随机）
          aiServeAim(engine, side, s);
          pu = 1;
          s.serveCd = 0.40;
        }
        s.serveCd -= dt;
      }
      // 发球挥拍期间冻结服务器移动：保证求解发球点与实际发射点一致（否则轨迹偏移易触网）
      const servingStroke = engine.server === side && p.stroke.active;
      if (!servingStroke) {
        // 接发站位：跟随对方站位三分偏中
        const tx = clamp(opp.x * 0.45, -1.2, 1.2);
        if (tx < p.x - 0.06) l = 1;
        else if (tx > p.x + 0.06) r = 1;
        // 回位到基础站位（与玩家相同的移动范围；乘 facing 保证两侧方向正确；
        // 死区 0.03 必须比发球站稳阈值 0.05 窄，否则停在死区内永不发球）
        const baseZ = side === 0 ? -T.RULES.PLAYER_Z : T.RULES.PLAYER_Z;
        const dzF = (baseZ - p.z) * f;
        if (dzF > 0.03) fwd = 1;
        else if (dzF < -0.03) back = 1;
      }
    } else if (engine.phase === 'play' && !b.inHand) {
      const zc = p.z + f * 0.42;
      const incoming = b.vel.z * f < 0;
      const counterIn = b.counterSmash === 1; // 玩家反击扣杀回球：视为扣杀、应对概率减半（操作奖励）
      const smashIn = b.hitType === 2 || counterIn; // 来球是扣杀（玩家右键 / AI 扣球 / 反击扣杀回球）
      const defMul = counterIn ? 0.5 : 1;          // 反击扣杀奖励：人机应对概率减半
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
      // 变招横向位移（0.4~0.7m）：持续约 1.2s，向目标方向中幅横移
      if (s.trickTimer > 0) {
        s.trickTimer -= dt;
        targetX = clamp(targetX + s.trickMove, -2.3, 2.3);
      }

      // 前后站位（与玩家相同的移动范围）：来球时迎到球前，球在对方半场时回位；
      // 扣杀来球时**回守本位（站深）**：扣杀深落点弹台后继续前冲，只有站深
      // 才能让反弹球穿过接球箱（前场站位会被深落点绕过箱体而挥空）
      let targetZ = side === 0 ? -T.RULES.PLAYER_Z : T.RULES.PLAYER_Z;
      if (incoming) {
        if (smashIn) targetZ = side === 0 ? -T.RULES.PLAYER_Z : T.RULES.PLAYER_Z;
        else targetZ = clamp(b.pos.z - f * 0.42, -T.RULES.Z_BACK, T.RULES.Z_BACK);
      }
      // 变招距离限制（v1.6 需求 23）：变招动作时与球桌距离不得超过 0.7m——
      // 目标 z 钳制到 ±(台半长+0.7)，杜绝 AI 远距离异常走位
      if (s.trickTimer > 0) {
        const trickZMax = T.RULES.TABLE_LENGTH / 2 + TRICK_MAX_DIST;
        targetZ = clamp(targetZ, side === 0 ? -trickZMax : T.RULES.Z_FWD, side === 0 ? -T.RULES.Z_FWD : trickZMax);
      }
      const dzF = (targetZ - p.z) * f; // 沿朝向的位移（正=向前）
      // 前后(z)移动门控：敏捷<1 惩罚时纳入占空比（否则前后无条件移动，惩罚形同虚设）；
      // 基准/溢出难度保持原样（不受门控，前后响应不变）
      const zDutyOn = agiUnder <= 0 || (s.moveT % 0.12) < 0.12 * moveDuty;
      if (zDutyOn && dzF > 0.10) fwd = 1;
      else if (zDutyOn && dzF < -0.10) back = 1;
      // 半场驱逐（安全机制）：人机卡在网前禁区或远离本方基础位、且球不在本方时，
      // 自动向本方半场方向驱逐回位（防止卡死在中场/网前）；恢复正常后清零
      const baseZ2 = side === 0 ? -T.RULES.PLAYER_Z : T.RULES.PLAYER_Z;
      const tooForward = side === 0 ? p.z > -0.5 : p.z < 0.5;
      if (engine.phase === 'play' && !incoming && (tooForward || Math.abs(p.z - baseZ2) > 0.9)) {
        s.stuckT += dt;
      } else {
        s.stuckT = 0;
      }
      if (s.stuckT > 0.8) {
        const dzF2 = (baseZ2 - p.z) * f;
        if (dzF2 > 0.05) fwd = 1;
        else if (dzF2 < -0.05) back = 1;
        s.stuckT = 0; // 驱逐一次后重新计时（仍在范围则再次触发）
      }

      // 蹲下（与玩家 Ctrl 蹲下相同）：来球很低时压低接球箱，可接贴地球。
      // 蹲↔站有转换延迟（反复蹲站最多 0.5s），须按预测到达时间提前蹲；
      // 阈值 0.80：0.80~0.95 的球站立箱（底 0.70）就能接，不必蹲——
      // 否则蹲着接高球（箱顶 1.30 够不到 1.35+）会因转换延迟挥空
      const ballNear = Math.hypot(b.pos.x - p.x, b.pos.y - 1.0, b.pos.z - zc);
      crouch = incoming && ((cross && cross.t < 0.45 && cross.y < 0.80) || (b.pos.y < 0.80 && ballNear < 1.6)) ? 1 : 0;
      // 移动输出（敏捷度 = 移动占空比，简单难度明显更慢；追远球时跑步加速）
      const dx = targetX - p.x;
      const dz = targetZ - p.z;
      s.moveT += dt;
      // 惩罚时死区放大（更懒散，小偏差不再微调）；占空比用折扣后的 moveDuty
      const wantMove = Math.abs(dx) > moveDead || Math.abs(dz) > 0.10;
      if ((s.moveT % 0.12) < 0.12 * moveDuty && wantMove) {
        if (dx > 0) r = 1;
        else l = 1;
      }
      run = (Math.abs(dx) > 0.9 || Math.abs(dz) > 0.9) ? 1 : 0;

      // 击球判断：与玩家同一碰撞箱（进箱即命中；蹲下箱按实际蹲伏程度 0~1 连续插值）
      const R = T.RULES;
      const yTop = R.HITBOX_Y_TOP + (R.CROUCH_HITBOX_Y_TOP - R.HITBOX_Y_TOP) * p.crouch;
      const yBottom = R.HITBOX_Y_BOTTOM + (R.CROUCH_HITBOX_Y_BOTTOM - R.HITBOX_Y_BOTTOM) * p.crouch;
      const inBox = Math.abs(b.pos.x - p.x) < R.HITBOX_HX &&
        Math.abs(b.pos.z - zc) < R.HITBOX_HZ &&
        b.pos.y > yBottom && b.pos.y < yTop;
      // 扣杀来球需"提前起拍"：球未进箱但预测到达箱体平面 ≤0.18s 时先按推球键，
      // 命中窗口（风起 0.08~0.28s）正好罩住球进箱时段——若等球弹台后 mayHit 开启
      // 再起拍，风起结束时球早已飞出箱体（15~21m/s 扣杀 0.03~0.04s 就穿过箱体）。
      // 接扣杀 = 位置门(落点在站位±可接半径内) × 概率掷骰(smashDef)；每球只掷一次
      if (incoming && smashIn && !inBox && cross && cross.t < 0.18 &&
        Math.abs(cross.x - p.x) <= smashReach && cross.y >= 0.55 && cross.y <= 1.42) {
        if (!s.catchRolled) {
          s.catchRolled = true;
          s.catchOk = rnd(s) < smashDef * defMul;
        }
        if (s.catchOk) { s.preSwing = true; pu = 1; }
      } else if (incoming && engine.mayHit[side] && inBox) {
        // 每球一次"接/漏"：扣杀进箱同样受位置门×概率约束（不叠加刻意漏球）；
        // 普通球 = 固定间隔必漏 1 球（平均概率 ≈ catchProb，比每球掷骰稳定）
        if (!s.catchRolled) {
          s.catchRolled = true;
          if (smashIn) {
            s.catchOk = Math.abs(b.pos.x - p.x) <= smashReach &&
              b.pos.y >= 0.55 && b.pos.y <= 1.42 && rnd(s) < smashDef * defMul;
          } else {
            s.catchOk = true;
            if (catchProb < 1) {
              if (!s.missEvery) s.missEvery = Math.max(2, Math.round(1 / (1 - catchProb)));
              s.catchCount = (s.catchCount || 0) + 1;
              if (s.catchCount >= s.missEvery) { s.catchOk = false; s.catchCount = 0; }
            }
          }
        }
        if (s.catchOk) {
          // 每球只掷一次"是否刻意打低球"（困难 1/5、地狱 1/2）：
          // 低平快球贴网低飞、过网后下坠，逼迫对手蹲下或失误
          if (!s.lowRolled) {
            s.lowRolled = true;
            s.lowThisBall = rnd(s) < (L.lowShotProb || 0);
          }
          // 每球只掷一次"是否放高吊球"（与低球互斥）：
          // 高吊球（lb，高净空高弧线）喂给对手制造扣杀机会
          if (!s.lobRolled) {
            s.lobRolled = true;
            s.lobThisBall = !s.lowThisBall && b.pos.y < 1.30 && rnd(s) < (L.lobProb || 0);
          }
          // 每球只掷一次"刁钻方向射球"：回球打向对方反方向/边角（逼对方追球），
          // 落点 x 偏移写入 p.aimBias，等级越高越爱打刁钻角度
          if (!s.trickyRolled) {
            s.trickyRolled = true;
            if (rnd(s) < trickyProbEff) {
              p.aimBias = (rnd(s) < 0.5 ? -1 : 1) * (0.35 + rnd(s) * 0.35);
            } else {
              p.aimBias = 0;
            }
          }
          s.hitDelay += dt;
          if (s.hitDelay >= react) {
            // 变招判定（每球一次）：对打两回合不进球后开始掷——
            // 概率 = 等级基准 + 未变招回合累积(每回合 +0.10)，封顶 100%，变招后清空
            // （与四属性滑杆解耦：只由难度决定，行为完全可预测）
            if (!s.trickRolled) {
              s.trickRolled = true;
              s.exch++;
              // 变招距离限制（需求 23）：距球桌超过 0.7m 时不触发变招，改打常规球
              if (s.exch >= 2 && Math.abs(p.z) <= T.RULES.TABLE_LENGTH / 2 + TRICK_MAX_DIST) {
                if (rnd(s) < Math.min(1, (L.trickBase || 0) + s.trickAccum)) {
                  s.trickOn = true;
                  s.trickAccum = 0; // 变招后清空
                  s.trickMove = (rnd(s) < 0.5 ? -1 : 1) * (0.4 + rnd(s) * 0.3);
                  s.trickTimer = 1.2;
                } else {
                  s.trickAccum = Math.min(0.9, s.trickAccum + 0.10); // 未变招累积
                }
              }
            }
            if (s.trickOn) {
              s.trickOn = false; // 变招本次回球生效一次
              if (rnd(s) < 0.5) lp = 1;        // 变招一：改打低平快球
              else { lb = 1; pu = 1; }         // 变招二：改放高吊球
            } else if (s.preSwing) pu = 1;
            // 可扣杀优先于低平快球：球够高就扣杀，低球才用低平/高吊技巧（强化扣杀展示）
            else if (smashReady(b, L) && rnd(s) < smashProb && smashAttemptAllowed(s, engine, side, L)) sm = 1;
            else if (s.lowThisBall) lp = 1;
            else if (s.lobThisBall) { lb = 1; pu = 1; }
            else pu = 1;
            // v2.0:AI 决定扣杀/低平快球(含变招低平)时头部「?」预警 0.3s(提前 0.2s 全显 + 0.1s 渐变消失)
            if (sm === 1 || lp === 1) { p.warnSmash = 1; p.warnT = 0.3; }
            // 攻击溢出（概率已满/无基础仍调高）→ 本次回球落点更刁钻（aimBias 放大，对手位置门更难接）
            if (smashOver > 0) p.aimBias *= (1 + smashOver);
          }
        }
      } else {
        s.hitDelay = 0;
        s.catchRolled = false;
        s.lowRolled = false;
        s.lobRolled = false;
        s.preSwing = false;
        s.trickRolled = false;
        s.failRolled = false;
        s.trickyRolled = false;
        p.aimBias = 0; // 刁钻方向只对本拍生效，球离箱后复位
      }
    } else {
      // 得分/结束阶段：回中 + 回位
      if (p.x > 0.15) l = 1;
      else if (p.x < -0.15) r = 1;
      const baseZ = side === 0 ? -T.RULES.PLAYER_Z : T.RULES.PLAYER_Z;
      if (baseZ > p.z + 0.08) fwd = 1;
      else if (baseZ < p.z - 0.08) back = 1;
    }

    T.setInput(engine, side, { l, r, f: fwd, b: back, pu, sm, lp, lb, crouch, run });
    return { l, r, f: fwd, b: back, pu, sm, lp, lb, crouch, run };
  }

  function reset() {
    stateMap.clear();
  }

  return {
    control,
    reset,
    LEVELS,
    resolveLevel,
    isInfiniteLevel,
    levelName,
    endlessConfig,
  };
});
