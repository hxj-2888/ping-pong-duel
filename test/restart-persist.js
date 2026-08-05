/* 重启持久化测试：POST → 杀进程 → 重启 → GET 记录仍在（模拟桌面应用重开） */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = 8899;
const tmpFile = path.join(os.tmpdir(), 'ppd_restart_test_' + Date.now() + '.json');
const ROOT = path.join(__dirname, '..');

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => { resolve({ status: res.statusCode, body: chunks }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let child = null;
function startServer() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), RECORDS_FILE: tmpFile }),
    stdio: 'ignore',
  });
}
async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { const r = await req('GET', '/api/records'); if (r.status === 200) return true; } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
function stopServer() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    child.on('exit', resolve);
    child.kill();
    setTimeout(resolve, 800);
  });
}

(async () => {
  let failures = 0;
  const check = (name, cond) => {
    console.log((cond ? 'PASS ' : 'FAIL ') + name);
    if (!cond) failures++;
  };

  startServer();
  if (!(await waitUp())) { console.error('server 1 未启动'); process.exit(1); }

  // 第一次会话：保存一条记录
  const p = await req('POST', '/api/records', { name: '重启测试', mode: 'ai', winner: 0, score: [11, 3], difficulty: 3, ts: Date.now() });
  check('会话1：POST 保存成功', p.status === 200 && JSON.parse(p.body).ok === true);
  check('会话1：records.json 已落盘', fs.existsSync(tmpFile) && JSON.parse(fs.readFileSync(tmpFile, 'utf8')).length === 1);

  // 模拟"关闭桌面应用"：杀服务器
  await stopServer();
  const afterKill = fs.existsSync(tmpFile) ? JSON.parse(fs.readFileSync(tmpFile, 'utf8')).length : 0;
  check('关闭后：记录仍留在磁盘', afterKill === 1);

  // 模拟"重新打开桌面应用"：重启服务器
  startServer();
  if (!(await waitUp())) { console.error('server 2 未启动'); process.exit(1); }
  const g = await req('GET', '/api/records');
  const list = JSON.parse(g.body).records || [];
  check('重启后：GET 返回记录（记录没丢）', g.status === 200 && list.length === 1 && list[0].name === '重启测试' && list[0].difficulty === 3);

  // 清理
  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
  await stopServer();
  console.log(failures === 0 ? '重启持久化测试通过 ✓' : failures + ' 项失败 ✗');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
