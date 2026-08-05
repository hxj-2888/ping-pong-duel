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
    Z_FWD: 0.1,              // 向前（近网）极限：以球网线为界，可走到球网附近（不能上球桌）
    Z_BACK: 2.20,            // 向后（远离球台）极限：距球台中心 2.20m
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
    CROUCH_SPEED_MUL: 0.50,  // 蹲下（Ctrl）速度倍率
    CROUCH_PADDLE_Y: 0.80,   // 蹲下时球拍待机高度
    GRAVITY: 9.81,
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
