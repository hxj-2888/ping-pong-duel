// 公网 DO 联机测试：A 建房 → B 加入 → 双方对打 → 观察快照是否持续
// 用法: node test/pub-test.js [ws url]
'use strict';
const url = process.argv[2] || 'wss://ping-pong-duel.pages.dev/ws';
const dur = 15000;

function client(name) {
  const c = { ws: new WebSocket(url), name, msgs: 0, lastT: 0, state: 'connecting', sides: [] };
  c.ws.onopen = () => { c.state = 'open'; };
  c.ws.onerror = () => { c.state = 'error'; };
  c.ws.onclose = () => { c.state = 'closed'; };
  return c;
}

const A = client('房主A');
const B = client('加入B');
const t0 = Date.now();
let joinedB = false, created = false;

A.ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.t === 'room' && !created) {
    created = true;
    console.log('[A] 建房成功 code=' + m.code);
    B.ws.send(JSON.stringify({ t: 'join', room: m.code, name: '加入B' }));
  } else if (m.t === 'state') {
    A.msgs++; A.lastT = Date.now();
  } else if (m.t === 'peer_left') { console.log('[A] peer_left'); }
};
B.ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.t === 'room') {
    joinedB = true;
    console.log('[B] 加入 side=' + m.side + ' wait=' + m.wait);
    setInterval(() => {
      B.ws.send(JSON.stringify({ t: 'in', i: { l: 0, r: 1, f: 0, b: 0, pu: 1, sm: 0, c: 0, rn: 0 } }));
    }, 100);
  } else if (m.t === 'state') {
    B.msgs++; B.lastT = Date.now();
  }
};

A.ws.onopen = () => { A.ws.send(JSON.stringify({ t: 'create', name: '房主A' })); };

setTimeout(() => {
  const gap = (c) => (c.lastT ? Math.round(Date.now() - c.lastT) : -1);
  console.log('--- summary ---');
  console.log('A(房主): state=' + A.state + ' 快照=' + A.msgs + ' 最近间隔=' + gap(A) + 'ms');
  console.log('B(加入): state=' + B.state + ' 快照=' + B.msgs + ' 最近间隔=' + gap(B) + 'ms joined=' + joinedB);
  const okA = A.msgs > 20 && gap(A) < 3000;
  const okB = joinedB && B.msgs > 20 && gap(B) < 3000;
  console.log(okA && okB ? 'OK：双方快照持续，无卡死' : '!!! 存在卡死/停滞');
  process.exit(0);
}, dur);
