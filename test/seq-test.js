/* ============================================================
 * test/seq-test.js — 输入帧序号（seq）乱序/重放校验
 * v2.7.0-fix:客户端输入帧带自增 seq，服务器按 per-connection 水印丢弃
 * 乱序/重放帧；无 seq 的旧客户端照常处理（兼容）。
 * 验证点：
 *   1. 递增 seq 正常生效（右移）
 *   2. 重放旧 seq（≤已处理）被丢弃（输入不生效）
 *   3. 乱序 seq（跳大再回小）被丢弃
 *   4. 无 seq 的旧客户端帧照常处理（兼容）
 * 用法：node test/seq-test.js
 * ============================================================ */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const SERVER = path.join(__dirname, '..', 'server.js');
// 动态取空闲端口：固定端口会被机器上的常驻程序占用（实测本机 8901 被 douyin_tray.exe
// 占用导致测试误报"连接失败"），listen(0) 由系统分配后再释放给服务器使用
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}
let PORT = 0;
let URL = '';

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
        const t = setTimeout(() => rej(new Error('等待消息超时')), timeout || 8000);
        const check = () => {
          const i = inbox.findIndex((m) => !pred || pred(m));
          if (i >= 0) {
            const idx = waiters.indexOf(check);
            if (idx >= 0) waiters.splice(idx, 1);
            const m = inbox.splice(i, 1)[0];
            clearTimeout(t);
            res(m);
          }
        };
        waiters.push(check);
        check();
      }),
    });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      latest = m;
      inbox.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) waiters[i]();
    };
    ws.onerror = (e) => reject(e);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!cond) failures++;
};

// 等待 A 的最新快照满足条件
async function waitSnapCond(A, cond, timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (A.latest && A.latest.s && cond(A.latest.s)) return true;
    await sleep(25);
  }
  return false;
}

async function main() {
  PORT = await freePort();
  URL = `ws://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await sleep(700);

  try {
    const A = await wsClient();
    const B = await wsClient();
    A.send({ t: 'create', name: '甲', skin: null });
    const roomEv = await A.next((m) => m.t === 'room' && m.side === 0, 8000);
    B.send({ t: 'join', room: roomEv.code, name: '乙', skin: null });
    await B.next((m) => m.t === 'room' && m.side === 1, 8000);
    await waitSnapCond(A, () => true, 8000);
    const side = A.latest.s.my === undefined ? 0 : 0; // my=-1，本地用 side 0 为房主
    const x0 = A.latest.s.p[0].x;
    await sleep(200);

    // 1) 递增 seq：右移生效
    A.send({ t: 'in', k: 2, seq: 1 });
    const movedR = await waitSnapCond(A, (s) => s.p[0].x > x0 + 0.1, 3000);
    check('seq 递增帧生效（seq=1 右移）', movedR, `x ${x0.toFixed(2)} → ${A.latest.s.p[0].x.toFixed(2)}`);

    // 停住
    A.send({ t: 'in', k: 0, seq: 2 });
    await sleep(300);
    const xStop = A.latest.s.p[0].x;

    // 2) 重放旧 seq（1 ≤ 已处理 2）→ 丢弃，不产生左移
    A.send({ t: 'in', k: 1, seq: 1 }); // 左移意图 + 旧 seq → 应被丢弃
    await sleep(500);
    const xAfterStale = A.latest.s.p[0].x;
    check('重放旧 seq 被丢弃（未左移）', Math.abs(xAfterStale - xStop) < 0.08, `x ${xStop.toFixed(2)} → ${xAfterStale.toFixed(2)}`);

    // 3) 乱序 seq（跳 10 再回 8）→ 8 被丢弃
    A.send({ t: 'in', k: 2, seq: 10 });
    await waitSnapCond(A, (s) => s.p[0].x > xAfterStale + 0.1, 3000);
    const xJ = A.latest.s.p[0].x;
    A.send({ t: 'in', k: 1, seq: 8 }); // 乱序（< 10）→ 丢弃
    await sleep(400);
    const xAfterJ = A.latest.s.p[0].x;
    check('乱序 seq（8<10）被丢弃', xAfterJ >= xJ - 0.08, `x ${xJ.toFixed(2)} → ${xAfterJ.toFixed(2)}`);
    A.send({ t: 'in', k: 0, seq: 11 });
    await sleep(300);

    // 4) 无 seq 的旧客户端帧照常处理（兼容）
    const xOld0 = A.latest.s.p[0].x;
    A.send({ t: 'in', k: 1 }); // 无 seq → 直接生效左移
    const movedOld = await waitSnapCond(A, (s) => s.p[0].x < xOld0 - 0.1, 3000);
    check('无 seq 旧客户端帧照常处理（兼容）', movedOld, `x ${xOld0.toFixed(2)} → ${A.latest.s.p[0].x.toFixed(2)}`);
    A.send({ t: 'in', k: 0 });

    A.ws.close();
    B.ws.close();
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
  }

  console.log(failures === 0 ? '\nseq 校验全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('异常:', e); process.exit(1); });
