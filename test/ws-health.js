/* WS 健康检查：连接公网端点并 ping/pong */
'use strict';
const ws = new WebSocket('wss://ping-pong-duel.pages.dev/ws');
const t = setTimeout(() => { console.log('超时（未收到 pong）'); process.exit(1); }, 10000);
ws.onopen = () => { console.log('✓ 已连接，发送 ping...'); ws.send(JSON.stringify({ t: 'ping' })); };
ws.onmessage = (ev) => { console.log('✓ 收到:', ev.data); clearTimeout(t); ws.close(); process.exit(0); };
ws.onerror = () => { console.log('✗ WS 连接失败'); clearTimeout(t); process.exit(1); };
ws.onclose = (e) => { if (e.code !== 1000) console.log('✗ 关闭 code=' + e.code); };
