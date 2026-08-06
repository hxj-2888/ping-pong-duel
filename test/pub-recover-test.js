// DO 驱逐恢复测试：A 建房 → 静默 45s（触发 DO 驱逐）→ B 加入 → 对打 → 观察快照
// 用法: node test/pub-recover-test.js [ws url]
'use strict';
const url = process.argv[2] || 'wss://ping-pong-duel.pages.dev/ws';
const SILENCE_MS = 45000;
const t0 = Date.now();

const A = new WebSocket(url);
let code = null, AState = 'connecting', AMsgs = 0, ALastT = 0, played = false;
const B = new WebSocket(url);
let BMsgs = 0, BLastT = 0, BJoined = false;

A.onopen = () => { AState = 'open'; console.log('[A] connected, create'); A.send(JSON.stringify({ t: 'create', name: '恢复测试房主' })); };
A.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.t === 'room' && !code) {
    code = m.code;
    console.log('[A] 房号=' + code + '（此后静默 45s 触发 DO 驱逐…）');
  } else if (m.t === 'state') { AMsgs++; ALastT = Date.now(); if (played && AMsgs % 20 === 0) console.log('[A] 恢复后快照 #' + AMsgs); }
};
A.onerror = () => { AState = 'error'; };
A.onclose = () => { AState = 'closed'; };

setTimeout(() => {
  console.log('[join] 45s 后 B 加入 ' + code);
  B.onopen = () => B.send(JSON.stringify({ t: 'join', room: code, name: '恢复测试加入' }));
  B.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'room') {
      BJoined = true;
      console.log('[B] 加入 side=' + m.side);
      played = true;
      setInterval(() => { try { B.send(JSON.stringify({ t: 'in', i: { l: 0, r: 1, f: 0, b: 0, pu: 1, sm: 0, c: 0, rn: 0 } })); } catch (err) {} }, 100);
    } else if (m.t === 'state') { BMsgs++; BLastT = Date.now(); if (BMsgs % 20 === 0) console.log('[B] 快照 #' + BMsgs); }
    else if (m.t === 'err' || m.t === 'error') console.log('[B] err', JSON.stringify(m));
  };
  B.onerror = () => console.log('[B] error');
}, SILENCE_MS);

setTimeout(() => {
  const gap = (last) => (last ? Math.round(Date.now() - last) : -1);
  console.log('--- summary ---');
  console.log('A: ' + AState + ' 快照=' + AMsgs + ' 间隔=' + gap(ALastT) + 'ms');
  console.log('B: joined=' + BJoined + ' 快照=' + BMsgs + ' 间隔=' + gap(BLastT) + 'ms');
  const ok = AState !== 'closed' && (AMsgs > 20 || (BJoined && BMsgs > 20));
  console.log(ok ? 'OK：驱逐恢复后对局正常' : '!!! 恢复失败/卡死');
  process.exit(0);
}, SILENCE_MS + 15000);
