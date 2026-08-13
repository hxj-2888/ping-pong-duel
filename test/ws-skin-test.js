'use strict';
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8933;
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    const waiters = [];
    ws.onopen = () => resolve({
      ws, send: (o) => ws.send(JSON.stringify(o)),
      next: (pred, timeout) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('超时')), timeout || 8000);
        const check = () => {
          const i = inbox.findIndex((m) => !pred || pred(m));
          if (i >= 0) {
            const m = inbox.splice(i, 1)[0];
            clearTimeout(t);
            res(m);
          }
        };
        waiters.push(check); check();
      }),
    });
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); inbox.push(m); for (const w of waiters) w(); };
    ws.onerror = (e) => reject(e);
  });
}
(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  await sleep(600);
  let failures = 0;
  const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + n); if (!c) failures++; };
  try {
    const skinA = { trail: 'red', paddle: 'skinC', shirt: 'green', splash: true };
    const skinB = { paddle: 'skinB', shirt: 'purple' };
    const a = await wsClient();
    a.send({ t: 'create', name: '房主', skin: skinA });
    const roomMsg = await a.next((m) => m.t === 'room' && m.side === 0);
    const b = await wsClient();
    b.send({ t: 'join', room: roomMsg.code, name: '对手', skin: skinB });
    // A 收到加入方 room 广播:skins = [skinA, skinB]
    const roomA = await a.next((m) => m.t === 'room' && m.side === 1);
    check('房主收到 room 广播含双方 skins', !!roomA.skins && roomA.skins[0].trail === 'red' && roomA.skins[1].paddle === 'skinB' && roomA.skins[1].shirt === 'purple');
    // B 收到 state 广播:skins 正确
    const stateB = await b.next((m) => m.t === 'state');
    check('加入方收到 state 含双方 skins', !!stateB.skins && stateB.skins[0].paddle === 'skinC' && stateB.skins[0].shirt === 'green' && stateB.skins[1].splash === false);
    check('splash 白名单(只有 A 装 true)', stateB.skins[0].splash === true);
    // A 也收 state
    const stateA = await a.next((m) => m.t === 'state');
    check('房主收到 state 含对方 skin', !!stateA.skins && stateA.skins[1].paddle === 'skinB');
    a.ws.close(); b.ws.close();
    console.log(failures === 0 ? '\n联机皮肤同步测试通过 ✓' : `\n${failures} 项失败 ✗`);
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (e) {
    console.error('测试异常:', e.message);
    process.exitCode = 1;
  } finally { child.kill(); }
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})();
