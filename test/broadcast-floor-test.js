'use strict';
// 验证保底广播：建房后不发送任何输入（静默相位），统计 1.2s 内收到的 state 快照数，
// 应 ≥20Hz（修复后），修复前去重会压到个位数。
const { spawn } = require('child_process');
const path = require('path');
const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 8977;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await sleep(700);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.send(JSON.stringify({ t: 'create', name: '测试' }));
  await sleep(400);
  // 静默期：不发输入，数 state 快照
  let count = 0;
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'state') count++; };
  await sleep(1200);
  const hz = count / 1.2;
  console.log('静默期 1.2s 收到 state 快照:', count, '条 →', hz.toFixed(1), 'Hz');
  console.log(hz >= 18 ? 'PASS 保底广播 ≥20Hz ✓' : 'FAIL 保底广播不足');
  ws.close();
  child.kill();
  process.exit(hz >= 18 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
