/* 验证 DO 驱逐假设：建房后等待 idleMs 再加入，观察是否"房间不存在" */
'use strict';
const WS_URL = 'wss://ping-pong-duel.pages.dev/ws';
const idleMs = Number(process.argv[2] || 35000);

function client(tag) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const msgs = [];
    const waiters = [];
    ws.onopen = () => resolve({
      ws, msgs,
      send(o) { ws.send(JSON.stringify(o)); },
      next(t, timeout = 20000) {
        return new Promise((res, rej) => {
          for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].t === t) return res(msgs[i]);
          const timer = setTimeout(() => rej(new Error('等待 ' + t + ' 超时')), timeout);
          const w = (m) => { if (m.t === t) { clearTimeout(timer); res(m); } };
          waiters.push(w);
        });
      },
    });
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); msgs.push(m); for (const w of [...waiters]) w(m); } catch (e) {} };
    ws.onerror = () => reject(new Error('ws error'));
  });
}

(async () => {
  const A = await client('A');
  A.send({ t: 'create', name: 'R' });
  const room = await A.next('room');
  console.log(`房间 ${room.code} 已创建，等待 ${idleMs / 1000}s 验证驱逐...`);
  await new Promise((r) => setTimeout(r, idleMs));
  const B = await client('B');
  B.send({ t: 'join', room: room.code, name: 'P' });
  try {
    const r = await B.next('room', 8000);
    console.log('✓ 加入成功 side=' + r.side);
    process.exit(0);
  } catch (e) {
    const err = B.msgs.find((m) => m.t === 'error');
    console.log('✗ 加入失败:', err ? err.e : e.message);
    process.exit(1);
  }
})();
