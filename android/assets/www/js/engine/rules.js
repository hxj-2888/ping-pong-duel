/* ============================================================
 * engine/rules.js — ITTF 规则与物理常量（拆分自 engine.js）
 * 本模块通过共享上下文 ctx 使用其他模块的接口，不直接改动其他文件。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.TTRules = factory;
})(typeof self !== 'undefined' ? self : this, function (ctx) {
  'use strict';

  const RULES = Object.freeze({
    TABLE_LENGTH: 2.74,
    TABLE_WIDTH: 1.525,
    TABLE_HEIGHT: 0.76,
    TABLE_THICK: 0.035,
    NET_HEIGHT: 0.1525,
    NET_WIDTH: 1.525,          // 按用户要求：球网两端与台面边缘相切（原 ITTF 1.83m）
    BALL_RADIUS: 0.02,
    BALL_MASS: 0.0027,
    BLADE_LEN: 0.15,
    BLADE_WID: 0.15,
    HANDLE_LEN: 0.085,
    PLAYER_HEIGHT: 1.75,
    PLAYER_Z: 1.65,          // 球员站位距球台中心（球台半长 1.37，站其后方，双腿不置于球台上）
    PLAYER_SPEED: 3.2,       // 横向移动速度 m/s
    MAX_X: 2.30,             // 活动范围
    ARENA_HALF_X: 3.4,       // 球场横向边界（再往外进入两侧观众席/场外）
    ARENA_HALF_Z: 4.6,       // 球场纵向边界（再往外进入端线观众席/场外）
    Z_FWD: 0.18,             // 向前（近网）极限：网前留 18cm 净空，避免身体压到网柱
    Z_BACK: 2.20,            // 向后（远离球台）极限：距球台中心 2.20m
    SERVE_Z_SAFE: 1.25,      // v2.7.0-fix:发球阶段站位钳制——发球方持球期间身体钳到 |z|≥此值（发球点距网≥0.73m）。
                             // 实测：边线绕行逼近球网后 z≥~-0.6 即解不出合法发球、持球点 bh 越过网面（对方看到球飘很远），
                             // 钳到 |z|≥1.25 时任意站位/落点均可解（全站位矩阵实测校准）
    PLAYER_BODY_W: 0.32,     // 人物整体半宽（脚距 0.16 + 步幅 0.14 + 净空）：台面禁区横向按此外扩，保证脚不上桌
    PLAYER_BODY_D: 0.15,     // 人物整体半深（脚前伸 0.04 + 脚趾 0.09 + 余量）：台面禁区纵向按此外扩
    // 接球碰撞箱（进箱即命中）：以球员为球心的长方体，中心向网前偏移 HITBOX_Z_OFF，
    // 蹲下（Ctrl）时箱体下探，可接贴地球
    HITBOX_HX: 0.60,             // x 半宽（左右）
    HITBOX_HZ: 0.40,             // z 半深（前后）
    HITBOX_Z_OFF: 0.42,          // 箱体中心向网前偏移
    HITBOX_Y_TOP: 1.40,          // 站立箱顶（最高可接球高）
    HITBOX_Y_BOTTOM: 0.70,       // 站立箱底（最低可接球高）
    CROUCH_HITBOX_Y_TOP: 1.30,   // 蹲下箱顶
    CROUCH_HITBOX_Y_BOTTOM: 0.02,// 蹲下箱底（贴地：任何还在空中的低球都能接，落地球已判分）
    RUN_SPEED_MUL: 1.30,     // 跑步（Shift）速度倍率
    CROUCH_SPEED_MUL: 0.40,  // 蹲下（Ctrl）速度倍率（蹲得越久越慢，最低 CROUCH_MIN_SPEED_MUL）
    CROUCH_MIN_SPEED_MUL: 0.20, // 蹲下速度下限（蹲满 CROUCH_DECAY_TIME 秒后达到）
    CROUCH_DECAY_TIME: 2.0,  // 蹲下从 0.40 衰减到 0.20 所需秒数
    CROUCH_TOGGLE_MAX: 0.5,  // 蹲↔站转换延迟上限（3 秒内反复蹲站会累积到该值）
    CROUCH_TOGGLE_STEP: 0.15,// 3 秒内每次蹲/站翻转额外增加的转换延迟（秒）
    CROUCH_TOGGLE_WINDOW: 3.0, // 反复蹲站判定窗口（秒）：窗口内连续翻转才累积延迟
    CROUCH_PADDLE_Y: 0.80,   // 蹲下时球拍待机高度
    GRAVITY: 9.81,
    SERVE_TIME_LIMIT: 6,     // 发球时限：6 秒内未发球判对方得分，并消耗本次发球机会
    WIN_SCORE: 11,
    MAX_SCORE: 99,
  });

  const PHASE_ID = { serve: 0, play: 1, point: 2, over: 3 };
  const PHASE_NAME = ['发球', '对打', '得分', '比赛结束'];

  // 物理系数（Magnus 升力 / 空气阻力 / 台面反弹 / 摩擦）
  const K_MAG = 0.0042;      // a = K * (ω × v)
  const K_DRAG = 0.10;       // a = -K * |v|² 方向
  const E_TABLE = 0.905;     // 台面恢复系数
  const E_PADDLE = 0.82;     // 球拍恢复系数
  const TABLE_FRICTION = 0.93;
  const SPIN_BOUNCE = 0.010; // 旋转在台面反弹时对水平速度的影响
  const SUBSTEP = 1 / 240;

  return { RULES, PHASE_ID, PHASE_NAME, K_MAG, K_DRAG, E_TABLE, E_PADDLE, TABLE_FRICTION, SPIN_BOUNCE, SUBSTEP };
});
