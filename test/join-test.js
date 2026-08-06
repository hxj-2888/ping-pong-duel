// 联机复现：加入房间并对打，观察快照是否持续（卡死检查）
// 用法: node test/join-test.js <房号> [服务器ws]
'use strict';
const code = process.argv[2] || 'WT93';
const url = process.argv[3] || 'ws://127.0.0.1:8123/ws';
const ws = new WebSocket(url); // Node 22+ 原生全局 WebSocket
let snaps = 0, lastSnapT = 0, inCount = 0, joined = false;
const t0 = Date.now();

ws.onopen = () => {
  console.log('[open] 发送 join', code);
  ws.send(JSON.stringify({ t: 'join', room: code, name: '联机测试B' }));
};

ws.onmessage = (e) => {
  let m;
  try { m = JSON.parse(e.data); } catch (err) { return; }
  if (m.t === 'room') {
    joined = true;
    console.log('[room] side=' + m.side + ' wait=' + m.wait);
    // 对打输入：推球 + 移动
    const inp = () => {
      if (!joined) return;
      const k = { l: 0, r: inCount % 2, f: 0, b: 0, pu: 1, sm: 0, c: 0, rn: 0 };
      ws.send(JSON.stringify({ t: 'in', i: k }));
      inCount++;
    };
    inp();
    setInterval(inp, 100);
  } else if (m.t === 'state' || m.t === 'snap') {
    snaps++;
    lastSnapT = Date.now();
    if (snaps % 30 === 0) console.log('[state] #' + snaps + ' phase=' + (m.s ? (m.s.ph === 1 ? 'play' : m.s.ph) : m.ph) + ' score=' + (m.s && m.s.sc ? m.s.sc.join(':') : '?'));
  } else if (m.t === 'err' || m.t === 'error') {
    console.log('[err]', m.e || JSON.stringify(m));
  }
};

ws.onclose = () => { console.log('[close]'); process.exit(0); };
ws.onerror = (e) => { console.log('[error]', (e && e.message) || 'ws error'); process.exit(1); };

setTimeout(() => {
  const dur = (Date.now() - t0) / 1000;
  const lastGap = joined ? Math.round(Date.now() - lastSnapT) : -1;
  console.log(`[summary] ${dur}s 快照=${snaps} 输入=${inCount} 最近快照间隔=${lastGap}ms`);
  console.log(lastGap > 0 && lastGap < 3000 && snaps > 10 ? 'OK：快照持续，无卡死' : '!!! 快照停滞/无快照：可能卡死');
  process.exit(0);
}, 12000);
