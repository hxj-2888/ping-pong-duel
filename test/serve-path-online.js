/* 联机发球预测轨迹测试：
 * 1) 服务端引擎（src/engine.js）快照在发球方案生成后带 sp 字段
 * 2) 客户端 servePathFromSnap：无 sp 用默认示意方案、有 sp 用精确方案，均返回采样点 */
'use strict';

import { createRequire } from 'node:module';
import TTServer from '../src/engine.js';

const require = createRequire(import.meta.url);
const TTclient = require('../public/js/engine.js'); // 客户端 PPD.TT（physicsStep）

// ---------- 加载客户端 render.js（用 stub PPD） ----------
const PPD = { app: { fx: [] }, TT: TTclient, TTG: {}, $id: () => null };
global.PPD = PPD;
require('../public/js/app/render.js');
const servePathFromSnap = PPD.servePathFromSnap;
if (typeof servePathFromSnap !== 'function') {
  console.log('FAIL 未能加载 servePathFromSnap');
  process.exit(1);
}

let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) failures++; };

// ---------- 1. 服务端快照：发球前（无方案）sp=null；按发球后 sp 出现 ----------
const e = TTServer.createEngine();
const snapBefore = TTServer.snapshot(e);
check('发球前快照 sp=null', snapBefore.sp === null);
check('发球前 bh 存在（球在手中）', Array.isArray(snapBefore.bh) && snapBefore.bh.length === 3);

// 按发球键生成精确方案
TTServer.setInput(e, 0, { l: 0, r: 0, f: 0, b: 0, pu: 1, sm: 0 });
TTServer.step(e, 1 / 60);
TTServer.setInput(e, 0, { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0 });
let snapServing = null;
for (let i = 0; i < 30 && !snapServing; i++) {
  TTServer.step(e, 1 / 60);
  const s = TTServer.snapshot(e);
  if (s.sp) snapServing = s;
}
check('按发球后快照 sp 出现（6 个数字）', snapServing && Array.isArray(snapServing.sp) && snapServing.sp.length === 6 && snapServing.sp.every(Number.isFinite));
check('sp 对应发球方 sv', snapServing && snapServing.sv === 0);

// ---------- 2. 客户端 servePathFromSnap：精确方案 ----------
if (snapServing) {
  const pts = servePathFromSnap(snapServing);
  check('精确方案返回采样点（>10 个）', Array.isArray(pts) && pts.length > 10);
  if (pts && pts.length > 1) {
    const first = pts[0], last = pts[pts.length - 1];
    check('起点在发球点附近', Math.abs(first.x - snapServing.bh[0]) < 0.01 && Math.abs(first.z - snapServing.bh[2]) < 0.01);
    check('终点在对方半台（z>0）', last.z > 0);
    check('轨迹有高度变化（有弧线）', Math.max(...pts.map((p) => p.y)) > 0.8);
  }
}

// ---------- 3. 客户端 servePathFromSnap：无 sp 时的默认示意方案 ----------
const snapNoSp = { ph: 0, sv: 0, bh: [0, 0.98, -1.13], sp: null };
const ptsDef = servePathFromSnap(snapNoSp);
check('默认示意方案返回采样点', Array.isArray(ptsDef) && ptsDef.length > 10);
if (ptsDef && ptsDef.length > 1) {
  check('默认方案终点在对方半台（z>0）', ptsDef[ptsDef.length - 1].z > 0);
}

// ---------- 4. 非发球阶段返回 null ----------
check('对打阶段（ph=1）返回 null', servePathFromSnap({ ph: 1, sv: 0, bh: null, sp: null }) === null);
check('球已出手（无 bh）返回 null', servePathFromSnap({ ph: 0, sv: 1, bh: null, sp: null }) === null);

// ---------- 5. 联机快照经 JSON 序列化后仍可用（模拟服务端→客户端传输） ----------
if (snapServing) {
  const roundTrip = JSON.parse(JSON.stringify(snapServing));
  const ptsRT = servePathFromSnap(roundTrip);
  check('序列化传输后轨迹仍可生成', Array.isArray(ptsRT) && ptsRT.length > 10);
}

// ---------- 6. 联机瞄准：服务端 setServeAim → 快照 sp 带精确方案，轨迹终点在对方半台 ----------
{
  const e2 = TTServer.createEngine();
  check('服务端应用瞄准（可解目标）', TTServer.setServeAim(e2, 0, 0.2, 0.7));
  const s2 = TTServer.snapshot(e2);
  check('瞄准后快照 sp 出现且未阻止', Array.isArray(s2.sp) && s2.sp.length === 6 && s2.sb === 0);
  const pts2 = servePathFromSnap(s2);
  check('瞄准轨迹返回采样点且终点在对方半台',
    Array.isArray(pts2) && pts2.length > 10 && pts2[pts2.length - 1].z > 0);
  TTServer.setInput(e2, 0, { l: 0, r: 0, f: 0, b: 0, pu: 1, sm: 0 });
  let served2 = false;
  for (let i = 0; i < 40 && !served2; i++) {
    TTServer.step(e2, 1 / 60);
    if (e2.phase === 'play' && !e2.ball.inHand) served2 = true;
  }
  check('瞄准后按发球进入对打', served2);
}

// ---------- 7. 联机瞄准：解不出合法发球 → sb=1、无轨迹、发不出球 ----------
{
  const e3 = TTServer.createEngine();
  const p3 = e3.players[0];
  p3.padX = 1.6; p3.x = 1.42; p3.z = -2.2; // 站到台面最外侧
  const ok3 = TTServer.setServeAim(e3, 0, 0.66, 1.23); // 远角不可达
  check('服务端判定瞄准不可达（轨迹消失）', !ok3 && e3.players[0].serveAimBlocked);
  const s3 = TTServer.snapshot(e3);
  check('不可达快照 sb=1 且 sp=null', s3.sb === 1 && s3.sp === null);
  check('不可达时客户端预览轨迹消失', servePathFromSnap(s3) === null);
  TTServer.setInput(e3, 0, { l: 0, r: 0, f: 0, b: 0, pu: 1, sm: 0 });
  for (let i = 0; i < 30; i++) TTServer.step(e3, 1 / 60);
  check('不可达时发不出球（仍待发）',
    e3.phase === 'serve' && e3.ball.inHand && !e3.players[0].stroke.active);
}

console.log(failures === 0 ? '\n联机发球轨迹测试全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
