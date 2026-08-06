/* NetClient 握手失败自动重连测试：
 * 1) 首次握手失败（close 但未 open）→ 自动重试（emit error 提示）
 * 2) 重试成功（open）→ 收到 open 事件，重试计数清零
 * 3) open 后断线走正常 close（不再重试）
 * 4) 全部重试失败 → 最终 close（不无限重试）
 * 5) 手动 close 后不再重连
 * 背景：DO 冷启动/网络瞬断时浏览器可能报「WebSocket opening handshake timed out」，
 * 自动重连可避免用户手动重试
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'network.js'), 'utf8');

// ---------- 模拟 WebSocket（须在 vm 沙箱内可见，network.js 用全局 WebSocket） ----------
let wsInstances = [];
class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.opened = false;
    wsInstances.push(this);
  }
  open() { this.readyState = 1; this.opened = true; if (this.onopen) this.onopen(); }
  fail() { this.readyState = 3; if (this.onerror) this.onerror(); if (this.onclose) this.onclose(); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  send() {}
  static get OPEN() { return 1; }
}

const sandbox = { module: { exports: {} }, exports: {}, WebSocket: FakeWS, setTimeout, clearTimeout, console };
sandbox.self = sandbox; // UMD：typeof self !== 'undefined' → root.NetClient
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const NetClient = sandbox.module.exports;

let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) failures++; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------- 场景 1：首次握手失败 → 自动重试 → 成功 ----------
  wsInstances = [];
  const net = new NetClient('wss://test/ws', { maxRetries: 2, retryDelay: 50 });
  const events = [];
  net.on('open', () => events.push('open'));
  net.on('error', (e) => events.push('err:' + e.e));
  net.on('close', () => events.push('close'));
  net.connect();
  check('首次尝试创建 WebSocket', wsInstances.length === 1);

  // 首次握手失败（未 open 就 close）
  wsInstances[0].fail();
  await sleep(30);
  check('握手失败后发出重试提示（error）', events.some((e) => e.includes('自动重试')));
  await sleep(80); // 等重试定时器
  check('自动创建第 2 个 WebSocket（重试）', wsInstances.length >= 2);

  // 重试成功
  wsInstances[wsInstances.length - 1].open();
  await sleep(30);
  check('重试成功后收到 open 事件', events.filter((e) => e === 'open').length === 1);
  // open 后 close → 走正常断线（不重试、不创建新 ws）
  const nBefore = wsInstances.length;
  wsInstances[wsInstances.length - 1].close();
  await sleep(40);
  check('open 后 close 不再触发重试（无新 ws）', wsInstances.length === nBefore);
  check('正常断线触发 close 事件', events.some((e) => e === 'close'));

  // ---------- 场景 2：全部重试失败 → 最终 close ----------
  wsInstances = [];
  const net2 = new NetClient('wss://test/ws2', { maxRetries: 1, retryDelay: 30 });
  const ev2 = [];
  net2.on('close', () => ev2.push('close'));
  net2.on('error', (e) => ev2.push('err:' + e.e));
  net2.connect();
  wsInstances[0].fail(); // 首次失败 → 计划重试
  await sleep(60);       // 触发重试，创建 ws[1]
  wsInstances[1].fail(); // 第 2 次也失败 → 达到上限 → close
  await sleep(10);
  check('全部重试失败后触发 close（不再无限重试）', (() => {
    const closed = ev2.includes('close');
    const attempts = wsInstances.length;
    return closed && attempts === 2; // 首次 + 1 次重试
  })());

  // ---------- 场景 3：手动 close 后定时器不再重连 ----------
  wsInstances = [];
  const net3 = new NetClient('wss://test/ws3', { maxRetries: 3, retryDelay: 30 });
  const ev3 = [];
  net3.on('close', () => ev3.push('close'));
  net3.connect();
  wsInstances[0].fail(); // 首次失败 → 计划重试
  await sleep(10);
  net3.close(); // 用户在重试前手动关闭
  const nBefore3 = wsInstances.length;
  await sleep(100); // 超过重试间隔
  check('手动 close 后不再创建新连接', wsInstances.length === nBefore3);

  console.log(failures === 0 ? '\nNetClient 重连逻辑全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('异常:', e); process.exit(1); });
