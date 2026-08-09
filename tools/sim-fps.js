/* ============================================================
 * tools/sim-fps.js — 帧率模拟：predictCrossing 优化前后 AI 逻辑 CPU 对比
 * 可重复运行复测（node tools/sim-fps.js）：
 *   - 实测当前（优化后）代码的每秒物理 + AI 控制成本（跑真实 AI 对打）
 *   - 旧版 predictCrossing 为 ai.js 重写前的算法副本（O(n²) 重头模拟），
 *     单次调用计时差 × 每秒调用次数 = 旧版额外开销
 * 帧模型：物理 120Hz、AI 控制 60Hz（与 app/loop.js 一致），
 *   60fps 渲染目标 → 每帧 2 物理步 + 1 次 AI 控制批次；
 *   渲染开销（Canvas）另计，本文只模拟物理+AI 逻辑部分。
 * ============================================================ */
'use strict';

const TT = require('../public/js/engine.js');
const AIC = require('../public/js/ai.js');
const STEP = 1 / 120;

// ---------- 旧版 predictCrossing（ai.js 重写前副本） ----------
function oldPC(ball, zc, maxT) {
  const steps = Math.ceil(maxT / 0.02);
  let prevZ = ball.pos.z;
  let prevPos = ball.pos;
  for (let i = 1; i <= steps; i++) {
    const t = i * 0.02;
    const p = TT.predictBall(ball, t);
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

// ---------- 新版 predictCrossing（ai.js 当前实现副本） ----------
function newPC(ball, zc, maxT) {
  const steps = Math.ceil(maxT / 0.02);
  const c = { pos: { ...ball.pos }, vel: { ...ball.vel }, spin: { ...ball.spin } };
  let prevZ = c.pos.z;
  let prevPos = { x: c.pos.x, y: c.pos.y };
  for (let i = 1; i <= steps; i++) {
    const t = i * 0.02;
    TT.physicsStep(c, 0.02, null);
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

// 模拟一秒对打：统计每秒物理步、AI 控制成本、predictCrossing 单次耗时（旧/新）。
// bothAI=true 时双 AI 都计时（AI 观战）；false 时仅 side1 计时（人机模式），side0 用 AI 驱动对打但不计入。
function runSeconds(bothAI, seconds = 5, rounds = 5) {
  // 预热（JIT）
  {
    const e = TT.createEngine();
    let tick = 0;
    for (let i = 0; i < 120; i++) {
      if (tick++ % 2 === 0) { AIC.control(e, 0, STEP * 2, 3); AIC.control(e, 1, STEP * 2, 3); }
      TT.step(e, STEP); e.events.length = 0;
    }
  }
  let stepTotal = 0n, aiTotal = 0n, oldTotal = 0n, newTotal = 0n, pcCalls = 0;
  const sides = bothAI ? [0, 1] : [1]; // 计时的 AI 侧（人机模式仅 side1；side0 用 AI 驱动对打但不计时）
  for (let r = 0; r < rounds; r++) {
    const e = TT.createEngine();
    let tick = 0;
    for (let i = 0; i < seconds * 120; i++) {
      if (tick++ % 2 === 0) {
        const t0 = process.hrtime.bigint();
        if (bothAI) {
          AIC.control(e, 0, STEP * 2, 3);
          AIC.control(e, 1, STEP * 2, 3);
        } else {
          AIC.control(e, 0, STEP * 2, 3); // 驱动对打，不计时（模拟玩家出球）
          AIC.control(e, 1, STEP * 2, 3); // 人机模式的 AI 侧，计时
        }
        aiTotal += process.hrtime.bigint() - t0;
        // 与 ai.js:272-278 一致：play 且 !inHand 时每个 control 调用一次 predictCrossing
        if (e.phase === 'play' && !e.ball.inHand) {
          for (const s of sides) {
            const p = e.players[s], f = p.facing;
            const zc = p.z + f * 0.42;
            const t1 = process.hrtime.bigint();
            oldPC(e.ball, zc, 1.4);
            const t2 = process.hrtime.bigint();
            newPC(e.ball, zc, 1.4);
            const t3 = process.hrtime.bigint();
            oldTotal += t2 - t1;
            newTotal += t3 - t2;
            pcCalls++;
          }
        }
      }
      const t4 = process.hrtime.bigint();
      TT.step(e, STEP);
      stepTotal += process.hrtime.bigint() - t4;
      e.events.length = 0;
    }
  }
  const nSec = seconds * rounds;
  const stepMs = Number(stepTotal) / 1e6 / nSec;               // 每秒物理（120 步）
  const aiMsNew = Number(aiTotal) / 1e6 / nSec;                // 每秒 AI 控制（新版）
  const pcPerSec = pcCalls / nSec;                             // 每秒 predictCrossing 调用
  const oldPCms = Number(oldTotal) / 1e6 / pcCalls;            // 旧版单次
  const newPCms = Number(newTotal) / 1e6 / pcCalls;            // 新版单次
  const oldDiffSec = (oldPCms - newPCms) * pcPerSec;           // 旧版每秒额外耗时
  return { stepMs, aiMsNew, pcPerSec, oldPCms, newPCms, oldDiffSec, ctrlPerSec: 60 };
}

const aivai = runSeconds(true);
const aihum = runSeconds(false);

function report(name, st) {
  const batchOld = (st.aiMsNew + st.oldDiffSec) / st.ctrlPerSec; // 旧版每批次 AI 成本
  const batchNew = st.aiMsNew / st.ctrlPerSec;                   // 新版每批次 AI 成本
  const totalOld = st.stepMs + st.aiMsNew + st.oldDiffSec;
  const totalNew = st.stepMs + st.aiMsNew;
  // 60fps 帧模型：每帧 2 物理步 + 1 次 AI 控制批次（预算 16.67ms）
  const frameOld = 2 * st.stepMs / 120 + batchOld;
  const frameNew = 2 * st.stepMs / 120 + batchNew;
  const renderOld = 16.67 - frameOld, renderNew = 16.67 - frameNew;
  console.log(`\n[${name}]`);
  console.log(`  每秒物理步（120 步）:                ${st.stepMs.toFixed(2)} ms/s`);
  console.log(`  每秒 AI 控制（60 批次）:            优化前 ${(st.aiMsNew + st.oldDiffSec).toFixed(2)} → 优化后 ${st.aiMsNew.toFixed(2)} ms/s`);
  console.log(`  每秒 predictCrossing 调用:          ${st.pcPerSec.toFixed(0)} 次（单次 旧 ${st.oldPCms.toFixed(3)}ms → 新 ${st.newPCms.toFixed(4)}ms）`);
  console.log(`  每秒合计（物理+AI）:                优化前 ${totalOld.toFixed(2)} → 优化后 ${totalNew.toFixed(2)} ms/s（省 ${(totalOld - totalNew).toFixed(2)} ms/s）`);
  console.log(`  60fps 帧模型（每帧 2 物理步 + 1 批次, 预算 16.67ms）:`);
  console.log(`    每帧逻辑 CPU: 优化前 ${frameOld.toFixed(3)} ms → 优化后 ${frameNew.toFixed(3)} ms`);
  console.log(`    渲染余量:      优化前 ${renderOld.toFixed(2)} ms → 优化后 ${renderNew.toFixed(2)} ms（+${((renderNew - renderOld) / renderOld * 100).toFixed(0)}%）`);
}

report('场景 A：AI 观战（双 AI · 最重负载）', aivai);
report('场景 B：人机模式（单 AI）', aihum);

console.log('\n注：以上仅模拟物理+AI 逻辑 CPU；Canvas 渲染开销（投影/观众席/角色）未计入，' +
  '实际帧率还取决于渲染负载。旧版为算法副本计时，非线上代码。');
