/* HTTP 健壮性测试：畸形 URL / 路径穿越不应打崩服务器
 * 回归背景：server.js 曾对 /%zz 这类非法百分号编码直接 decodeURIComponent，
 * 抛出的 URIError 是未捕获异常，会让整个服务器进程崩溃（局域网/公网均暴露）。
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 8898; // net-test 用 8899，这里避开
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 发原始路径请求（不经过 URL 规范化，真实验证服务器对 ../ 的防护）
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: rawPath, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));

  let failures = 0;
  function check(name, cond) {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
    if (!cond) failures++;
  }

  try {
    // 等服务起来
    let up = false;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`${BASE}/api/info`);
        if (r.status === 200) { up = true; break; }
      } catch (e) { /* 还没起，继续等 */ }
      await sleep(100);
    }
    check('服务器启动', up);

    // 畸形百分号编码：非法 URL 必须返回 4xx，且不能打崩服务器
    const bad1 = await rawGet('/%zz');
    check('非法编码 /%zz 返回 4xx', bad1 >= 400 && bad1 < 500);
    const bad2 = await rawGet('/%');
    check('非法编码 /% 返回 4xx', bad2 >= 400 && bad2 < 500);

    // 路径穿越：原始路径含 ../ 应被拒绝（403），不能读到仓库外文件
    const trav1 = await rawGet('/../server.js');
    check('路径穿越 /../server.js 被拒(4xx)', trav1 >= 400 && trav1 < 500);
    const trav2 = await rawGet('/%2e%2e/server.js');
    check('编码穿越 /%2e%2e/server.js 被拒(4xx)', trav2 >= 400 && trav2 < 500);

    // 服务器仍存活：畸形请求后正常接口照常工作
    const info = await fetch(`${BASE}/api/info`);
    check('畸形请求后服务器仍存活(/api/info 200)', info.status === 200);
    const infoJson = await info.json();
    check('畸形请求后 /api/info 内容正常', !!(infoJson && infoJson.ok));

    console.log(failures === 0 ? '\nHTTP 健壮性测试通过 ✓' : `\n${failures} 项失败 ✗`);
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (e) {
    console.error('测试异常:', e.message);
    process.exitCode = 1;
  } finally {
    // 必须杀掉子进程再退出（同 net-test：残留服务器会串扰后续运行）
    child.kill();
  }
  setTimeout(() => process.exit(process.exitCode || 0), 300);
}

main();
