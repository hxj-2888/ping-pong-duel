/* 测试 WebSocket 连接（本地 wrangler dev 或公网） */
'use strict';
const url = process.argv[2] || 'ws://127.0.0.1:8799';
console.log('连接:', url);
const ws = new WebSocket(url);
const t = setTimeout(() => { console.log('FAIL: 15s 未连接成功（onopen 未触发）'); process.exit(1); }, 15000);
ws.onopen = () => {
  clearTimeout(t);
  console.log('✓ 连接成功');
  ws.send(JSON.stringify({ t: 'create', name: '测试' }));
};
ws.onmessage = (ev) => {
  console.log('收到消息:', ev.data);
  ws.close();
  setTimeout(() => process.exit(0), 200);
};
ws.onerror = (e) => {
  clearTimeout(t);
  console.log('✗ 连接错误:', e.message || JSON.stringify(e));
  process.exit(1);
};
ws.onclose = (e) => {
  console.log('连接关闭 code=', e.code, 'reason=', e.reason);
};
