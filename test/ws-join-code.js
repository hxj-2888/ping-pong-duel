/* 交叉验证：从公网端点加入指定房间码，确认房间在 Cloudflare 服务器上 */
'use strict';
const code = process.argv[2];
if (!code) { console.log('用法: node test/ws-join-code.js <房间码>'); process.exit(1); }
const ws = new WebSocket('wss://ping-pong-duel.pages.dev/ws');
const t = setTimeout(() => { console.log('超时'); process.exit(1); }, 10000);
ws.onopen = () => { ws.send(JSON.stringify({ t: 'join', room: code, name: '验证者' })); };
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  console.log('公网服务器回复:', JSON.stringify(m).slice(0, 140));
  if (m.t === 'room') { clearTimeout(t); console.log('✓ 房间在公网服务器上（side=' + m.side + '）'); process.exit(0); }
  if (m.t === 'error') { clearTimeout(t); console.log('✗ ' + m.e); process.exit(1); }
};
ws.onerror = () => { console.log('✗ 连接失败'); clearTimeout(t); process.exit(1); };
