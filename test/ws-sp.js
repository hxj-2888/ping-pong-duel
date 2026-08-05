/* 公网端到端：发球瞬间服务端快照带 sp（联机发球预测轨迹的数据源） */
'use strict';
const WS_URL = 'wss://ping-pong-duel.pages.dev/ws';

function client(tag) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const msgs = [];
    const waiters = [];
    ws.onopen = () => resolve({
      ws, msgs,
      send(o) { ws.send(JSON.stringify(o)); },
      next(t, timeout = 8000) {
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
  A.send({ t: 'create', name: '房主' });
  const room = await A.next('room');
  console.log('房间:', room.code);

  // 发球（pu 边沿触发）
  A.send({ t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 1, sm: 0 } });
  await new Promise((r) => setTimeout(r, 30));
  A.send({ t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0 } });

  // 持续发中性输入驱动模拟，捕获发球瞬间的 sp
  let sawSp = null;
  for (let i = 0; i < 60; i++) {
    A.send({ t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0 } });
    await new Promise((r) => setTimeout(r, 50));
    for (const m of A.msgs) {
      if (m.t === 'state' && m.s && m.s.sp) { sawSp = m.s.sp; break; }
    }
    if (sawSp) break;
  }
  if (sawSp) {
    console.log('✓ 发球瞬间快照 sp =', JSON.stringify(sawSp));
    const hasSp = Array.isArray(sawSp) && sawSp.length === 6 && sawSp.every(Number.isFinite);
    console.log(hasSp ? '✓ 公网发球预测轨迹数据源正常（6 个数字）' : '✗ sp 格式错误');
    process.exit(hasSp ? 0 : 1);
  } else {
    console.log('✗ 未捕获到带 sp 的快照（发球方案未生成或传输失败）');
    process.exit(1);
  }
})();
