/* ============================================================
 * test/join-wait-test.js — 建房/加入 wait 标志验证（v2.7.0-fix）
 * server.js handleJoin 的 wait 与 room-core 对齐：仅双方席位都占用才 wait:false。
 * 1) host 建房 → wait:true
 * 2) host 掐线重连（带 side=0）→ wait:true（单人回等待面板，不再独自开局）
 * 3) guest 加入后双方在位 → wait:false（开局）
 * 用法：node test/join-wait-test.js
 * ============================================================ */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 8902;
const URL = `ws://127.0.0.1:${PORT}`;

function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    const waiters = [];
    let latest = null;
    ws.onopen = () => resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      get latest() { return latest; },
      next: (pred, timeout) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('等待超时')), timeout || 8000);
        const check2 = () => {
          const i = inbox.findIndex((m) => !pred || pred(m));
          if (i >= 0) {
            const idx = waiters.indexOf(check2);
            if (idx >= 0) waiters.splice(idx, 1);
            const m = inbox.splice(i, 1)[0];
            clearTimeout(t);
            res(m);
          }
        };
        waiters.push(check2);
        check2();
      }),
    });
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); latest = m; inbox.push(m); for (let i = waiters.length - 1; i >= 0; i--) waiters[i](); };
    ws.onerror = () => reject(new Error('ws error'));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!cond) failures++;
};

async function main() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await sleep(700);
  try {
    // 1) host 建房 → wait:true
    const A = await wsClient();
    A.send({ t: 'create', name: '甲', skin: null });
    const created = await A.next((m) => m.t === 'room' && m.side === 0, 8000);
    check('host 建房 wait=TRUE（等待面板）', created.wait === true, 'wait=' + created.wait);

    // 2) host 掐线重连（带 side=0）→ wait:true（单人回等待面板）
    A.ws.close();
    await sleep(500);
    const A2 = await wsClient();
    A2.send({ t: 'join', room: created.code, name: '甲', side: 0, skin: null });
    const rejoin = await A2.next((m) => m.t === 'room' && m.side === 0, 8000);
    check('host 单人重连 wait=TRUE（回等待面板，不独自开局）', rejoin.wait === true, 'wait=' + rejoin.wait);

    // 3) guest 加入后双方在位 → wait:false（开局）
    const B = await wsClient();
    B.send({ t: 'join', room: created.code, name: '乙', skin: null });
    const bRoom = await B.next((m) => m.t === 'room' && m.side === 1, 8000);
    check('guest 加入 wait=FALSE（开局）', bRoom.wait === false, 'wait=' + bRoom.wait);
    const a2Room = await A2.next((m) => m.t === 'room' && m.wait === false, 8000);
    check('host 收到双满广播 wait=FALSE', !!a2Room, '');

    A2.ws.close(); B.ws.close();
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
  }
  console.log(failures === 0 ? '\njoin wait 验证全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('异常:', e); process.exit(1); });
