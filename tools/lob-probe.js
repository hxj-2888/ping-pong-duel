'use strict';
/* ============================================================
 * tools/lob-probe.js — 高吊球(lob)玩家方实际触发情况探针
 *
 * 验证玩家「蹲下+推球」(输入层自动补 lb) 在高吊触发链路中的实际情况：
 *  1. 普通来球 → 蹲+推球 → 是否真的形成高吊(高净空高弧线, 落点深)
 *  2. 扣杀来球 → 蹲+推球 → 高吊被引擎抑制(p.lob=0), 只走蹲防推球
 *  3. 对照: 仅推球(不蹲) → 普通推球, 非高吊
 *  4. canLobNow 的指示逻辑(UI「可高吊 ✓」)与实际触发的差异
 * ============================================================ */
const path = require('path');
const T = require(path.join(process.cwd(), 'public', 'js', 'engine.js'));
const STEP = 1 / 120;

function predictCrossing(ball, zc, maxT) {
  const steps = Math.ceil(maxT / 0.02);
  let prevZ = ball.pos.z, prevPos = ball.pos;
  for (let i = 1; i <= steps; i++) {
    const t = i * 0.02;
    const p = T.predictBall(ball, t); // 返回 pos
    if ((prevZ >= zc && p.z <= zc) || (prevZ <= zc && p.z >= zc)) {
      const u = Math.abs((zc - prevZ) / (p.z - prevZ));
      return { t, x: prevPos.x + (p.x - prevPos.x) * u, y: prevPos.y + (p.y - prevPos.y) * u };
    }
    prevZ = p.z; prevPos = p;
  }
  return null;
}

// 注入一记来球: 从 P1(z>0, facing -1) 打向 P0(z<0 侧)。mode='normal' 推球 / 'smash' 扣杀
function injectBall(mode) {
  const engine = T.createEngine();
  T.resetMatch(engine);
  const b = engine.ball;
  const p1 = engine.players[1];
  p1.x = 0; p1.padX = 0;
  b.pos = { x: 0, y: mode === 'smash' ? 1.25 : 1.02, z: 1.2 };
  b.vel = { x: 0, y: 0, z: 0 };
  b.spin = { x: 0, y: 0, z: 0 };
  b.inHand = false; b.hitType = -1; b.hitBy = -1; b.lastBounce = -1; b.netTouched = false;
  engine.phase = 'play'; engine.mayHit = [false, false];
  const type = mode === 'smash' ? 2 : 1;
  const shot = T.computeShot(engine, 1, type);
  if (!shot || shot.netHit) return null;
  b.vel = { ...shot.vel };
  b.spin = { ...shot.spin };
  b.hitType = type; b.hitBy = 1;
  return engine;
}

// 玩家 P0 控制: 蹲+推球(高吊) / 仅推球 / 仅蹲
// 真实玩家是"持续按住"推球键(键/钮按下期间 pu 一直为 1), 不是点击脉冲——
// 触发时机: 球进入判箱范围(与引擎 strokes.js 同一 box 判定) 即按下并保持到击球完成
let heldPu = false;
function playerControl(engine, mode) {
  const p = engine.players[0], b = engine.ball, f = p.facing;
  const zc = p.z + f * 0.42;
  let l = 0, r = 0, pu = 0, crouch = 0;
  const incoming = engine.phase === 'play' && !b.inHand && b.vel.z * f < 0;
  if (incoming) {
    const c = predictCrossing(b, zc, 1.8);
    if (c) {
      const tx = Math.max(-2.3, Math.min(2.3, c.x));
      if (tx - p.x > 0.02) r = 1; else if (tx - p.x < -0.02) l = 1;
    }
    // 用引擎同款判箱条件: 球此刻在 P0 箱内(含蹲姿箱) → 按推球(仅推球类模式)
    const box = {
      x: p.x, z: p.z + f * 0.42,
      hx: 0.60, hz: 0.40,
      yTop: 1.40 + (1.30 - 1.40) * p.crouch,
      yBottom: 0.70 + (0.02 - 0.70) * p.crouch,
    };
    const inBox = Math.abs(b.pos.x - box.x) < box.hx &&
      Math.abs(b.pos.z - box.z) < box.hz &&
      b.pos.y > box.yBottom && b.pos.y < box.yTop;
    // 提前量: 球在箱前 0.3m 内也触发(挥拍 windup 0.08s 需提前按, 球还会继续飞进来)
    const ahead = b.pos.z * f > 0 && Math.abs(b.pos.z - zc) < 0.3 && b.vel.z * f < 0;
    if ((inBox || ahead) && (mode === 'crouchPush' || mode === 'pushOnly')) heldPu = true;
  }
  if (mode === 'crouchPush' || mode === 'crouchOnly') crouch = 1;
  if (heldPu && (mode === 'crouchPush' || mode === 'pushOnly')) pu = 1;
  // 输入层转换(loop.js): 蹲下+推球 → 自动补 lb
  const lb = (crouch && pu) ? 1 : 0;
  T.setInput(engine, 0, { l, r, f: 0, b: 0, pu, sm: 0, lp: 0, lb, crouch, run: 0 });
}

// 打一拍, 记录玩家击球细节
function trial(mode, hitMode) {
  heldPu = false;
  const engine = injectBall(mode);
  if (!engine) return null;
  const b = engine.ball, p0 = engine.players[0];
  const diag = { outVel: null, outHitType: null, lobFlag: null, crouchAtHit: null, hit: false, retOut: null };
  for (let i = 0; i < 600; i++) {
    playerControl(engine, hitMode);
    T.step(engine, STEP);
    for (const ev of engine.events) {
      if (ev.c === 'hit' && ev.s === 0) {
        diag.hit = true;
        diag.outVel = { ...b.vel };
        diag.outHitType = b.hitType;
        diag.lobFlag = p0.lob;
        diag.crouchAtHit = p0.crouch;
      }
    }
    engine.events.length = 0;
    if (diag.outVel) {
      // 追踪出球: 落点(过网高度 + 对方台面落点)
      for (let j = 0; j < 600; j++) {
        T.setInput(engine, 0, { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, lp: 0, lb: 0, crouch: 0, run: 0 });
        T.step(engine, STEP);
        for (const ev of engine.events) {
          if (ev.c === 'bounce' && b.pos.z > 0) { diag.retOut = 'oppBounce'; break; }
          if (ev.c === 'floor') { diag.retOut = 'floor'; break; }
          if (ev.c === 'point') { diag.retOut = 'point:' + (engine.pointReason || ''); break; }
          if (ev.c === 'net') { diag.retOut = 'net'; break; }
        }
        engine.events.length = 0;
        if (diag.retOut) break;
        if (b.pos.z < 0 && b.pos.y < 0.02) { diag.retOut = diag.retOut || 'backFloor'; break; }
      }
      break;
    }
  }
  return diag;
}

// 单次详细诊断: 击球瞬间各状态
function diagnose() {
  for (const mode of ['normal', 'smash']) {
    heldPu = false;
    const engine = injectBall(mode);
    if (!engine) { console.log('  ' + mode + ': 注入失败(解不出)'); continue; }
    const b = engine.ball, p0 = engine.players[0];
    const zc = p0.z + p0.facing * 0.42;
    console.log('  [' + mode + ' 来球] 起点 z=' + b.pos.z.toFixed(2) + ' y=' + b.pos.y.toFixed(2) +
      ' vel=(' + b.vel.x.toFixed(2) + ',' + b.vel.y.toFixed(2) + ',' + b.vel.z.toFixed(2) + ')' +
      ' P0 位置 x=' + p0.x.toFixed(2) + ' z=' + p0.z.toFixed(2) + ' zc=' + zc.toFixed(2) +
      ' 来球 hitType=' + b.hitType);
    let prevZ = b.pos.z, prevY = b.pos.y;
    for (let i = 0; i < 90; i++) {
      const p = T.predictBall(b, (i + 1) * 0.02);
      if ((prevZ >= zc && p.z <= zc) || (prevZ <= zc && p.z >= zc)) {
        const u = Math.abs((zc - prevZ) / (p.z - prevZ));
        const yAt = prevY + (p.y - prevY) * u;
        console.log('    穿越 zc 时刻 t=' + ((i + 1) * 0.02).toFixed(2) + 's 高度 y=' + yAt.toFixed(2) + 'm');
        break;
      }
      prevZ = p.z; prevY = p.y;
    }
    let found = false;
    for (let i = 0; i < 600; i++) {
      const prevLb = engine.inputs[0].lb;
      playerControl(engine, 'crouchPush');
      const curLb = engine.inputs[0].lb;
      T.step(engine, STEP);
      for (const ev of engine.events) {
        if (ev.c === 'hit' && ev.s === 0) {
          found = true;
          console.log('    [击球帧] inp.lb(prev=' + prevLb + '->cur=' + curLb + ') p0.lob=' + p0.lob.toFixed(2) +
            ' p0.crouch=' + p0.crouch.toFixed(2) + ' 出球 vel=(' + b.vel.x.toFixed(2) + ',' + b.vel.y.toFixed(2) + ',' + b.vel.z.toFixed(2) + ') ' +
            '速度=' + Math.hypot(b.vel.x, b.vel.y, b.vel.z).toFixed(2) +
            ' st.type=' + (p0.stroke && p0.stroke.type));
        }
      }
      engine.events.length = 0;
      if (found) break;
    }
    if (!found) console.log('    [结果] 未击球');
  }
}
console.log('## 单帧诊断: 蹲下+推球 在普通/扣杀来球下');
diagnose();
console.log('');

function canLobNow(engine) {
  const b = engine && engine.ball;
  if (!b || !engine.players || engine.phase !== 'play' || b.inHand) return false;
  const p = engine.players[0], f = p.facing;
  const zc = p.z + f * 0.42;
  if (b.vel.z * f >= 0) return false;
  if (Math.abs(b.pos.z - zc) > 2.6) return false;
  const shot = T.computeShot(engine, 0, 1, { lob: true });
  return !!(shot && !shot.degraded);
}

function run(label, hitMode, n) {
  let seed = 777 + n;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const stats = { hit: 0, lob: 0, nonLob: 0, outNet: 0, outFloor: 0, outOppBounce: 0, outPoint: 0, noHit: 0, outVyHi: 0, outSpeed: [] };
  const byBall = { normal: { hit: 0, lob: 0, noHit: 0 }, smash: { hit: 0, lob: 0, noHit: 0 } };
  let t = 0, attempts = 0;
  while (t < n && attempts < 3000) {
    attempts++;
    const mode = rnd() < 0.5 ? 'normal' : 'smash';
    const d = trial(mode, hitMode);
    if (!d) continue;
    if (!d.hit) { stats.noHit++; byBall[mode].noHit++; t++; continue; }
    stats.hit++;
    byBall[mode].hit++;
    const v = d.outVel;
    const spd = Math.hypot(v.x, v.y, v.z);
    stats.outSpeed.push(spd);
    // 高吊特征: 出球上飘(vy 大) + 弧线高(落点深); 扣杀来球抑制后 lobFlag=0
    const isLobLike = d.lobFlag === 1 && v.y > 2.0 && spd < 12;
    if (isLobLike) { stats.lob++; byBall[mode].lob++; }
    else stats.nonLob++;
    if (d.retOut === 'net') stats.outNet++;
    else if (d.retOut === 'floor') stats.outFloor++;
    else if (d.retOut === 'oppBounce') stats.outOppBounce++;
    else if (d.retOut && d.retOut.startsWith('point')) stats.outPoint++;
    if (v.y > 2.0) stats.outVyHi++;
    t++;
  }
  const sp = stats.outSpeed.length ? (stats.outSpeed.reduce((a, b) => a + b, 0) / stats.outSpeed.length).toFixed(1) : '—';
  console.log('=== ' + label + ' (命中 ' + stats.hit + ' 未中 ' + stats.noHit + ') ===');
  console.log('  出球均值 ' + sp + ' m/s | vy>2.0(飘高) ' + stats.outVyHi + ' | 高吊特征(vy>2 且慢速) ' + stats.lob + ' / 非高吊 ' + stats.nonLob);
  console.log('  回球: 过网落对方台 ' + stats.outOppBounce + ' | 出界落地 ' + stats.outFloor + ' | 进网 ' + stats.outNet + ' | 得分/其他 ' + stats.outPoint);
  console.log('  分来球: 普通来球 命中 ' + byBall.normal.hit + ' 高吊 ' + byBall.normal.lob + ' 未中 ' + byBall.normal.noHit +
    ' | 扣杀来球 命中 ' + byBall.smash.hit + ' 高吊 ' + byBall.smash.lob + ' 未中 ' + byBall.smash.noHit);
}

// 玩家在不同来球下的实际触发
console.log('## 玩家「蹲下+推球」(输入层自动补 lb) — 普通/扣杀来球混合 250 次');
run('蹲下+推球', 'crouchPush', 250);
console.log('');
console.log('## 对照: 仅推球(不蹲) — 应全部普通推球, 无高吊');
run('仅推球', 'pushOnly', 150);
console.log('');
console.log('## 对照: 仅蹲不推 — 不应击球');
run('仅蹲下', 'crouchOnly', 80);

// UI 指示 vs 实际: 扣杀来球时 canLobNow 是否误报
console.log('');
console.log('## UI 指示(canLobNow)与实际差异 — 扣杀来球时');
let seed = 999;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let lobOk = 0, lobNo = 0, hitCount = 0, hitLob = 0;
for (let k = 0; k < 60; k++) {
  heldPu = false;
  const engine = injectBall('smash');
  if (!engine) continue;
  for (let i = 0; i < 300; i++) {
    playerControl(engine, 'crouchPush');
    T.step(engine, STEP);
    const ind = canLobNow(engine);
    if (ind) lobOk++; else lobNo++;
    for (const ev of engine.events) {
      if (ev.c === 'hit' && ev.s === 0) { hitCount++; if (engine.players[0].lob === 1) hitLob++; }
    }
    engine.events.length = 0;
    if (hitCount) break;
  }
}
console.log('  扣杀来球: 指示可高吊帧 ' + lobOk + ' / 不可 ' + lobNo + ' | 实际击球 ' + hitCount + ' 次中 lobFlag=1 ' + hitLob + ' 次(应接近 0 — 引擎抑制)');
