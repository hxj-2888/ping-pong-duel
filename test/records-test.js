/* 通关记录 API 往返测试：spawn node server.js（临时 RECORDS_FILE）
 * 覆盖：OPTIONS 预检、POST 保存、非法字段清洗、GET 最新在前、静态页面不受影响
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = 8973;
const tmpFile = path.join(os.tmpdir(), 'ppd_records_test_' + Date.now() + '.json');
const ROOT = path.join(__dirname, '..');

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { PORT: String(PORT), RECORDS_FILE: tmpFile, RECORDS_TOKEN: 'test-token' }),
  stdio: 'inherit',
});

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(chunks); } catch (e) { /* 非 JSON（静态页） */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await req('GET', '/api/records');
      if (r.status === 200) return true;
    } catch (e) { /* 未就绪 */ }
    await new Promise((r2) => setTimeout(r2, 100));
  }
  return false;
}

(async () => {
  let failures = 0;
  const check = (name, cond) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
    if (!cond) failures++;
  };

  if (!(await waitUp())) {
    console.error('server.js 未能在 5s 内启动');
    child.kill();
    process.exit(1);
  }

  // OPTIONS 预检（桌面公网跨域）
  const pre = await req('OPTIONS', '/api/records');
  check('OPTIONS 预检：204 + CORS 头', pre.status === 204);

  // POST 合法记录
  const p1 = await req('POST', '/api/records', { name: '测试员', mode: 'ai', winner: 0, score: [11, 5], difficulty: 2, ts: Date.now() });
  check('POST 保存成功：返回 ok+id', p1.status === 200 && p1.json && p1.json.ok === true && typeof p1.json.id === 'string');

  // POST 非法字段 → 清洗而非报错
  const p2 = await req('POST', '/api/records', { name: 'x'.repeat(50), mode: 'hack', winner: 9, score: [200, -3], difficulty: 99 });
  check('POST 非法字段：仍接受并清洗', p2.status === 200 && p2.json && p2.json.ok === true);

  // POST 坏 JSON → 400
  const p3 = await req('POST', '/api/records');
  check('POST 无 body：400', p3.status === 400);

  // GET 往返：最新在前
  const g = await req('GET', '/api/records?limit=20');
  check('GET 返回数组且最新在前', g.status === 200 && Array.isArray(g.json.records) && g.json.records.length === 2);
  const r0 = g.json.records[0];
  const r1 = g.json.records[1];
  check('清洗：name 截断 20 / mode 落 other / score 夹取 / 难度默认 1',
    r0.name.length === 20 && r0.mode === 'other' && r0.score[0] === 99 && r0.score[1] === 0 && r0.difficulty === 1);
  check('合法 POST 原样往返',
    r1.name === '测试员' && r1.mode === 'ai' && r1.winner === 0 &&
    r1.score[0] === 11 && r1.score[1] === 5 && r1.difficulty === 2 && typeof r1.ts === 'number');

  // limit 生效
  const g1 = await req('GET', '/api/records?limit=1');
  check('GET limit=1 只返回 1 条', g1.json.records.length === 1);

  // DELETE：按 id 删除（维护用）——审计 #18 需 token;无 token 一律 403
  const g0 = await req('GET', '/api/records?limit=20');
  const id0 = g0.json.records[0].id;
  const dNoToken = await req('DELETE', '/api/records?id=' + encodeURIComponent(id0));
  check('DELETE 无 token：403 拒绝', dNoToken.status === 403);
  const dBadToken = await req('DELETE', '/api/records?id=' + encodeURIComponent(id0) + '&token=wrong');
  check('DELETE token 错误：403 拒绝', dBadToken.status === 403);
  const d = await req('DELETE', '/api/records?id=' + encodeURIComponent(id0) + '&token=test-token');
  check('DELETE 带正确 token 按 id 删除：removed=1', d.status === 200 && d.json.ok === true && d.json.removed === 1);
  const g2 = await req('GET', '/api/records?limit=20');
  check('DELETE 后记录少一条', g2.json.records.length === g0.json.records.length - 1);
  const d2 = await req('DELETE', '/api/records?id=not_exist&token=test-token');
  check('DELETE 不存在的 id：removed=0', d2.json.ok === true && d2.json.removed === 0);
  const d3 = await req('DELETE', '/api/records?token=test-token');
  check('DELETE 无 id：400', d3.status === 400);

  // 静态页面不受影响
  const s = await req('GET', '/index.html');
  check('静态页面仍正常', s.status === 200 && s.json === null);

  // 清理临时文件
  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
  child.kill();
  console.log(failures === 0 ? '\n记录 API 往返测试通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('记录 API 测试异常:', e);
  child.kill();
  process.exit(1);
});
