/* 测试：WebSocket 升级来源校验（CSWSH 防护 + 跨源联机白名单）
 *
 * 背景（ECS 线路「拉不了手」）：
 *   客户端 ECS 线路固定连 wss://searchdelta.online/ws（state.js getServerUrl），
 *   而玩家常从 Cloudflare 托管的 https://ping-pong-duel.pages.dev 打开页面后再切到 ECS 线路。
 *   此时 Origin 是 pages.dev、Host 是 searchdelta.online，二者天然不相等；
 *   若只按「Origin.host === Host」判定，握手阶段即被 socket.destroy()，
 *   表现为联机连不上 / 反复重连（即"拉不了手"）。
 *   修复：新增 WS_ALLOWED_ORIGINS 白名单放行合法联机入口，同时保留 CSWSH 防护。
 *
 * 本测试锁定五个场景，防止修复回退、也防止防护被误关（不能简单放行一切）：
 *   1) 无 Origin（curl / 非浏览器客户端）  → 放行
 *   2) 同源（Origin.host === Host）       → 放行
 *   3) 白名单来源（pages.dev 连 ECS）      → 放行  ← 本次修复核心
 *   4) 未登记的跨站来源（恶意站点 CSWSH）  → 拒绝
 *   5) 安卓 APK 的 file:// Origin         → 放行
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const http = require('http');

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 8917;
const ALLOWED = 'https://ping-pong-duel.pages.dev,https://searchdelta.online';

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 发起一次 WS 升级请求，返回 '101'（放行）或 'rejected'（连接被断开/非 101）
function upgrade(opts) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (e) { /* ignore */ }
      resolve(r);
    };
    s.on('error', () => finish('rejected'));
    s.on('close', () => finish('rejected'));
    s.on('connect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      const lines = [
        'GET /ws HTTP/1.1',
        `Host: ${opts.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      if (opts.origin) lines.push(`Origin: ${opts.origin}`);
      s.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const head = buf.toString('latin1');
      if (head.indexOf('\r\n\r\n') >= 0) {
        finish(/^HTTP\/1\.1\s+101/i.test(head) ? '101' : 'rejected');
      }
    });
    setTimeout(() => finish('timeout'), 3000);
  });
}

function get(pathname) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(b));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(1500, () => { req.destroy(); resolve(''); });
  });
}

(async function main() {
  const child = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      WS_ALLOWED_ORIGINS: ALLOWED,
      RECORDS_FILE: path.join(__dirname, '..', 'test-out-ws-origin.json'),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  // 等待服务器就绪
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(150);
    ready = (await get('/api/info')).indexOf('"ok":true') >= 0;
  }
  if (!ready) {
    console.log('FAIL 服务器启动');
    child.kill();
    process.exit(1);
  }
  check('服务器启动', true);

  // 1) 无 Origin：curl / 非浏览器客户端 → 放行
  check('无 Origin（curl/非浏览器）→ 放行',
    (await upgrade({ host: `127.0.0.1:${PORT}`, origin: null })) === '101');

  // 2) 同源：Origin.host === Host → 放行
  check('同源（Origin.host === Host）→ 放行',
    (await upgrade({ host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` })) === '101');

  // 3) 白名单来源：网页版 pages.dev 跨源连 ECS → 放行（本次修复核心，防"拉不了手"）
  check('白名单来源（pages.dev 连 ECS 线路）→ 放行',
    (await upgrade({ host: 'searchdelta.online', origin: 'https://ping-pong-duel.pages.dev' })) === '101');

  // 4) 未登记的跨站来源 → 拒绝（保留 CSWSH 防护，不能无脑放行）
  check('未登记的跨站来源 → 拒绝',
    (await upgrade({ host: 'searchdelta.online', origin: 'https://evil.example.com' })) === 'rejected');

  // 5) 安卓 APK 的 file:// Origin → 放行
  check('安卓 APK（file:// Origin）→ 放行',
    (await upgrade({ host: `127.0.0.1:${PORT}`, origin: 'file://' })) === '101');

  // 6) 同源判定仍严格：Host 与 Origin 都非白名单且互不相等 → 拒绝
  check('任意第三方站点 → 拒绝',
    (await upgrade({ host: `127.0.0.1:${PORT}`, origin: 'https://another.example.com' })) === 'rejected');

  child.kill();
  try { require('fs').unlinkSync(path.join(__dirname, '..', 'test-out-ws-origin.json')); } catch (e) { /* ignore */ }

  console.log('');
  if (fail === 0) {
    console.log('WS 来源校验测试通过 ✓');
    process.exit(0);
  }
  console.log(`WS 来源校验测试失败：${fail} 项`);
  process.exit(1);
})();
