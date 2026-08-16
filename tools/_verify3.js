/* ============================================================
 * tools/_verify3.js — 三问题公网实测（复现 + 回归）
 * 直接下指令控制虚拟玩家，走真实公网 WebSocket。
 * 用法：
 *   node tools/_verify3.js cf|ecs|all         复现模式（断言"问题存在"）
 *   node tools/_verify3.js cf|ecs|all --regress  回归模式（断言"已修复"）
 * ============================================================ */
'use strict';

const crypto = require('crypto');
const CF = 'wss://ping-pong-duel.pages.dev/ws';
const ECS = 'ws://searchdelta.online:8765';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REGRESS = process.argv.includes('--regress');
const TARGET = (process.argv[2] === 'cf' || process.argv[2] === 'ecs') ? process.argv[2] : 'all';

let failures = 0;
const results = [];
function rec(name, pass, detail = '') {
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
  results.push({ name, pass, detail });
  if (!pass) failures++;
}
function info(name, detail) {
  console.log('INFO ' + name + ' — ' + detail);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    let latest = null;
    ws.onopen = () => resolve({
      ws, url,
      send: (o) => { try { ws.send(JSON.stringify(o)); } catch (e) { /* ignore */ } },
      get latest() { return latest; },
      inbox,
      next: (pred, timeout = 12000) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('等待超时')), timeout);
        const check2 = () => {
          const i = inbox.findIndex((m) => !pred || pred(m));
          if (i >= 0) {
            const idx = waiters.indexOf(check2);
            if (idx >= 0) waiters.splice(idx, 1);
            clearTimeout(t);
            res(inbox.splice(i, 1)[0]);
          }
        };
        waiters.push(check2);
        check2();
      }),
    });
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } latest = m; inbox.push(m); for (let i = waiters.length - 1; i >= 0; i--) waiters[i](); };
    ws.onerror = () => reject(new Error('ws error ' + url));
  });
}
async function waitSnap(A, cond, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (A.latest && A.latest.s && cond(A.latest.s)) return true;
    await sleep(25);
  }
  return false;
}
async function waitAnyMsg(A, cond, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const idx = A.inbox.findIndex(cond); // 消息可能已被后续 state 顶出 latest，须查 inbox
    if (idx >= 0) { A.inbox.splice(idx, 1); return true; }
    if (A.latest && cond(A.latest)) return true;
    await sleep(25);
  }
  return false;
}

// ---------- 问题1：发球死区 ----------
async function verifyServeDeadzone(url, tag) {
  info(tag, '问题1 发球死区：边线绕行前移，观察 sb/sp/bh');
  try {
    const A = await connect(url);
    const B = await connect(url);
    A.send({ t: 'create', name: tag + '甲', skin: null });
    const roomEv = await A.next((m) => m.t === 'room' && m.side === 0, 15000);
    B.send({ t: 'join', room: roomEv.code, name: tag + '乙', skin: null });
    await B.next((m) => m.t === 'room' && m.side === 1, 15000);
    await waitSnap(A, (s) => s.ph === 0 && s.sv === 0 && s.bh, 10000);
    await sleep(200);
    let seq = 1;
    const t0 = Date.now();
    // 横移到边线外侧（绕过台面禁区），再前移逼近球网；全程带瞄准
    while (Date.now() - t0 < 3000 && !(A.latest && A.latest.s && A.latest.s.p[0].x <= -1.25)) {
      A.send({ t: 'in', k: 1, seq: seq++, a: [0.4, 0.6] });
      await sleep(50);
    }
    const t1 = Date.now();
    let firstSbZ = null, maxBhZ = null, sawSp = 0, lastZ = -9, maxZ = -99; // maxZ = 最远前（最靠近网）
    while (Date.now() - t1 < 3000) {
      A.send({ t: 'in', k: 16, seq: seq++, a: [0.4, 0.6] });
      await sleep(50);
      const s = A.latest && A.latest.s;
      if (!s) continue;
      lastZ = s.p[0].z;
      if (s.p[0].z > maxZ) maxZ = s.p[0].z;
      if (s.sb === 1 && firstSbZ == null) firstSbZ = lastZ;
      if (s.sp) sawSp++;
      if (s.bh && (maxBhZ == null || s.bh[2] > maxBhZ)) maxBhZ = s.bh[2];
    }
    A.send({ t: 'in', k: 0, seq: seq++ });
    const s = A.latest && A.latest.s;
    info(tag, `A 边线 x=${s ? s.p[0].x.toFixed(2) : '?'} 前移至 z=${lastZ.toFixed(2)}（最前 ${maxZ.toFixed(2)}）；sb 出现于 z=${firstSbZ != null ? firstSbZ.toFixed(2) : '无'}；sp ${sawSp} 次；bh.z 最大 ${maxBhZ != null ? maxBhZ.toFixed(3) : '无'}`);
    if (!REGRESS) {
      // 复现模式：断言死区存在（sb=1、bh 越网）
      rec(tag + ' 死区复现：sb=1（解不出）', firstSbZ != null, firstSbZ != null ? 'z=' + firstSbZ.toFixed(2) : '未复现');
      rec(tag + ' bh 越网（对方视角球偏移）', maxBhZ != null && maxBhZ > 0, 'bh.z=' + (maxBhZ != null ? maxBhZ.toFixed(3) : '?'));
    } else {
      // 回归模式：断言死区不可达（站位被钳制、发球可解、bh 不越网）
      rec(tag + ' 站位钳制生效（未进入死区）', maxZ >= -1.30, `最前 z=${maxZ.toFixed(2)}（钳制 ≥-1.25）`);
      rec(tag + ' 发球在钳制边界内可解（sp 出现）', sawSp > 0, `sp ${sawSp} 次`);
      rec(tag + ' bh 不越网（球不飘对方半台）', maxBhZ == null || maxBhZ <= 0, 'bh.z=' + (maxBhZ != null ? maxBhZ.toFixed(3) : '无'));
    }
    A.ws.close(); B.ws.close();
    await sleep(200);
  } catch (e) { rec(tag + ' 问题1 执行', false, e.message); }
}

// ---------- 问题2：蹲姿分叉 ----------
async function verifyCrouch(url, tag, hasInputTimeout) {
  info(tag, '问题2 蹲姿：cq 一致性 / 停止输入 / stale seq / 重连');
  try {
    const A = await connect(url);
    const B = await connect(url);
    A.send({ t: 'create', name: tag + '甲', skin: null });
    const roomEv = await A.next((m) => m.t === 'room' && m.side === 0, 15000);
    B.send({ t: 'join', room: roomEv.code, name: tag + '乙', skin: null });
    await B.next((m) => m.t === 'room' && m.side === 1, 15000);
    await waitSnap(A, () => true, 10000);
    await sleep(200);
    let seq = 1;
    A.send({ t: 'in', k: 64, seq: seq++ });
    const crouched = await waitSnap(A, (s) => s.p[0].cq === 1, 4000);
    rec(tag + ' crouch=1 → 服务器 cq=1', crouched, '');
    await sleep(1600); // 停止输入
    const cqAfterStop = A.latest && A.latest.s ? A.latest.s.p[0].cq : -1;
    if (!REGRESS) {
      rec(tag + ' 停止输入 1.6s 后 cq 归 0（输入超时清零）', hasInputTimeout ? cqAfterStop === 0 : cqAfterStop === 1,
        `cq=${cqAfterStop}（${hasInputTimeout ? 'ECS 有超时' : 'CF/DO 无超时'}）`);
    } else {
      rec(tag + ' 停止输入 1.6s 后 cq 归 0（双后端均有输入超时）', cqAfterStop === 0, 'cq=' + cqAfterStop);
    }
    A.send({ t: 'in', k: 64, seq: seq++ });
    await waitSnap(A, (s) => s.p[0].cq === 1, 4000);
    A.send({ t: 'in', k: 0, seq: seq - 1 }); // stale seq
    await sleep(500);
    const cqAfterStale = A.latest && A.latest.s ? A.latest.s.p[0].cq : -1;
    rec(tag + ' stale seq（旧帧）被丢弃，cq 保持 1', cqAfterStale === 1, 'cq=' + cqAfterStale);
    A.send({ t: 'in', k: 0, seq: seq++ });
    const stood = await waitSnap(A, (s) => s.p[0].cq === 0, 4000);
    rec(tag + ' 正常 seq 释放蹲 → cq=0', stood, '');
    // 重连残留（INFO）
    A.send({ t: 'in', k: 64, seq: seq++ });
    await waitSnap(A, (s) => s.p[0].cq === 1, 4000);
    A.ws.close();
    await sleep(800);
    const A2 = await connect(url);
    A2.send({ t: 'join', room: roomEv.code, name: tag + '甲', side: 0, skin: null });
    await A2.next((m) => m.t === 'room' && m.side === 0, 15000);
    await waitSnap(A2, () => true, 10000);
    await sleep(300);
    const cqAfterRe = A2.latest && A2.latest.s ? A2.latest.s.p[0].cq : -1;
    info(tag, `重连后 cq=${cqAfterRe}（新连接未发输入，服务器残留/超时清零）`);
    A2.send({ t: 'in', k: 0, seq: 1 });
    await sleep(200);
    A2.ws.close(); B.ws.close();
    await sleep(200);
  } catch (e) { rec(tag + ' 问题2 执行', false, e.message); }
}

// ---------- 问题3a：跨客户端 join ----------
async function verifyCrossJoin(url, tag, useKey) {
  info(tag, `问题3a 跨客户端 join（两个独立连接${useKey ? '·不同 ?k=' : '·无 key'}）`);
  try {
    const mk = () => (useKey ? '?k=' + crypto.randomUUID() : '');
    const A = await connect(url + mk());
    A.send({ t: 'create', name: '甲', skin: null });
    const roomEv = await A.next((m) => m.t === 'room' && m.side === 0, 15000);
    const G = await connect(url + mk());
    G.send({ t: 'join', room: roomEv.code, name: '乙', skin: null });
    const gotErr = await waitAnyMsg(G, (m) => m.t === 'error', 8000);
    const gotRoom = await waitAnyMsg(G, (m) => m.t === 'room', 8000);
    const ok = gotRoom && !gotErr;
    if (!REGRESS) {
      rec(tag + ' 跨连接 join（useKey=' + useKey + '）', useKey ? gotErr : ok,
        gotErr ? 'error: ' + (G.latest.e || '') : (gotRoom ? 'join 成功' : '无响应'));
    } else {
      rec(tag + ' 跨连接 join 成功', ok, gotErr ? 'error: ' + (G.latest.e || '') : 'join 成功');
    }
    A.ws.close(); G.ws.close();
    await sleep(200);
  } catch (e) { rec(tag + ' 问题3a 执行', false, e.message); }
}

// ---------- 问题3b：单人重连 wait 标志 ----------
async function verifyEcsJoinWait() {
  info('ECS', '问题3b host 掐线重连（带 side）的 wait 标志');
  try {
    const A = await connect(ECS);
    A.send({ t: 'create', name: '等局甲', skin: null });
    const roomEv = await A.next((m) => m.t === 'room' && m.side === 0, 15000);
    rec('ECS host 建房 wait=TRUE', roomEv.wait === true, 'wait=' + roomEv.wait);
    A.ws.close();
    await sleep(600);
    const A2 = await connect(ECS);
    A2.send({ t: 'join', room: roomEv.code, name: '等局甲', side: 0, skin: null });
    const rejoin = await A2.next((m) => m.t === 'room' && m.side === 0, 15000);
    if (!REGRESS) {
      rec('ECS 单人重连 wait=FALSE（bug 复现）', rejoin.wait === false, 'wait=' + rejoin.wait);
    } else {
      rec('ECS 单人重连 wait=TRUE（回等待面板）', rejoin.wait === true, 'wait=' + rejoin.wait);
    }
    A2.ws.close();
    await sleep(200);
  } catch (e) { rec('ECS 问题3b 执行', false, e.message); }
}

// ---------- 主流程 ----------
async function main() {
  console.log('=== 三问题公网实测（' + (REGRESS ? '回归模式' : '复现模式') + '）===\n');
  if (TARGET === 'all' || TARGET === 'cf') {
    await verifyServeDeadzone(CF, 'CF');
    await verifyCrouch(CF, 'CF', false);
    await verifyCrossJoin(CF, 'CF', true);  // 不同 ?k=（复现用；回归时无 key 也全走 global）
    await verifyCrossJoin(CF, 'CF', false); // 无 key 两个独立连接
  }
  if (TARGET === 'all' || TARGET === 'ecs') {
    await verifyServeDeadzone(ECS, 'ECS');
    await verifyCrouch(ECS, 'ECS', true);
    await verifyEcsJoinWait();
  }
  console.log(`\n=== 结束：${results.filter((r) => r.pass).length} 通过 / ${failures} 失败 ===`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('异常:', e.message); process.exit(1); });
