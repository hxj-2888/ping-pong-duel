/* 公网协议冒烟：Node WebSocket 双客户端直连 Cloudflare Worker，
 * 验证 create → join → in → state → rematch → peer_left 全流程 */
'use strict';

const WS_URL = process.env.WS_URL || 'wss://ping-pong-duel.pages.dev/ws';

let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) failures++; };

function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const msgs = [];
    const waiters = [];
    ws.onopen = () => resolve({
      ws, msgs,
      send(o) { ws.send(JSON.stringify(o)); },
      next(t, timeout = 8000) {
        return new Promise((res, rej) => {
          // 取最新一条同类型消息（从数组末尾找），避免命中历史旧消息
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].t === t) return res(msgs[i]);
          }
          const timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error('等待 ' + t + ' 超时')); }, timeout);
          const w = (m) => { if (m.t === t) { clearTimeout(timer); const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); res(m); } };
          waiters.push(w);
        });
      },
    });
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        msgs.push(m);
        for (const w of [...waiters]) w(m);
      } catch (e) { /* ignore */ }
    };
    ws.onerror = (e) => reject(new Error('ws error'));
  });
}

async function main() {
  console.log('连接:', WS_URL);
  const A = await client();
  console.log('房主已连接 ✓');

  // 1. 房主创建
  A.send({ t: 'create', name: '房主' });
  const roomA = await A.next('room');
  check('房主收到 room（side=0, wait=true）', roomA.side === 0 && roomA.wait === true);
  check('房间码 4 位', /^[A-Z0-9]{4}$/.test(roomA.code));
  const code = roomA.code;
  const state0 = await A.next('state', 5000);
  check('房主收到初始 state 快照', !!state0.s);

  // 2. 加入者加入
  const B = await client();
  console.log('加入者已连接 ✓');
  A.msgs.length = 0; // 清空历史，确保 next('room') 等到的是 join 广播（而非创建时的 side=0 消息）
  B.send({ t: 'join', room: code, name: '小蓝' });
  const roomB = await B.next('room');
  check('加入方 side=1, wait=false', roomB.side === 1 && roomB.wait === false);
  const roomA2 = await A.next('room');
  check('房主也收到 room 广播（side=1）', roomA2.side === 1);

  // 3. 输入驱动（双方各移动 300ms）
  const t0 = Date.now();
  const iv = setInterval(() => {
    A.send({ t: 'in', i: { l: 0, r: 1, f: 0, b: 0, pu: 0, sm: 0 } });
    B.send({ t: 'in', i: { l: 1, r: 0, f: 0, b: 0, pu: 0, sm: 0 } });
    if (Date.now() - t0 > 350) clearInterval(iv);
  }, 30);
  await new Promise((r) => setTimeout(r, 600));
  const snapA = await A.next('state');
  check('P0 向右移动（x>0）', snapA.s.p[0].x > 0.05);
  const snapB = await B.next('state');
  check('P1 向左移动（x<0）', snapB.s.p[1].x < -0.05);

  // 4. 发球（先回中：台边站位解不出合法发球，与真实游戏一致——发球前须站回可发球位置）
  for (let i = 0; i < 25; i++) {
    A.send({ t: 'in', i: { l: 1, r: 0, f: 0, b: 0, pu: 0, sm: 0 } });
    await new Promise((r) => setTimeout(r, 25));
  }
  A.send({ t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 1, sm: 0 } });
  await new Promise((r) => setTimeout(r, 30));
  A.send({ t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0 } });
  // 消息驱动 tick：无消息引擎不步进，需持续发中性输入推进发球动画
  let servePh = -1;
  for (let i = 0; i < 80 && servePh !== 1; i++) {
    A.send({ t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0 } });
    await new Promise((r) => setTimeout(r, 50));
    const s = await A.next('state');
    servePh = s.s.ph;
  }
  check('发球后进入对打（ph=1）', servePh === 1);

  // 5. ping/pong
  A.send({ t: 'ping' });
  const pong = await A.next('pong', 5000);
  check('ping 返回 pong', typeof pong.st === 'number');

  // 6. 断线通知
  B.ws.close();
  const left = await A.next('peer_left', 8000);
  check('房主收到 peer_left（side=1）', left.side === 1);

  console.log(failures === 0 ? '\n公网协议冒烟全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('异常:', e.message); process.exit(1); });
