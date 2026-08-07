// 开发工具：验证欢呼动画期观众无"复制体/叠影"（CDP 驱动真实游戏）
// 用法: node tools/probe-crowd-dup.js
// 显式开启观众（noCrowd=false）+ 清缓存，统计上半屏观众色像素（排除木地板/球台/座椅色）：
// 常态（rest 单份）→ 蓝方得分 → 欢呼动画期多点采样。
// 判定：修复前动画期 = 静态层 rest 观众 + 动画层动势观众叠影，像素数约为常态的 1.3 倍（复制体）；
//       修复后动画期只有动画层一份（半分辨率），像素数稳定约常态一半、无翻倍。
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const PORT = 8784;
const CDP_PORT = 9900 + Math.floor(Math.random() * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function killTree(p) { if (!p || p.killed) return; try { require('child_process').execSync(`taskkill /F /T /PID ${p.pid}`, { stdio: 'ignore' }); } catch (e) { /* ignore */ } }
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.end();
  });
}
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve; this.ws.onerror = reject;
      this.ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
    });
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}
// 观众色判定（排除木地板 #7c4a21/#a06a33、球台蓝 #1e6fd9、座椅钢蓝 #67809f 等）：
// 红粉丝 rgba(240,110,92)：r>180 且明显高于 g/b；蓝粉丝 rgba(110,160,246)：b>200 且明显高于 r/g
const STATS = `(() => {
  const c = document.getElementById('game');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const W = c.width;
  let red = 0, blue = 0;
  for (let y = 40; y < 320; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      if (r > 180 && r > g + 80 && r > b + 80) red++;
      else if (b > 200 && b > r + 60 && b > g + 60) blue++;
    }
  }
  return JSON.stringify({ red, blue, total: red + blue });
})()`;
async function main() {
  try {
    for (let i = 0; i < 30; i++) { await sleep(100); await getJson(`http://127.0.0.1:${PORT}/`).catch(() => {}); }
    const BROWSERS = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ];
    const BROWSER = BROWSERS.find((p) => fs.existsSync(p));
    if (!BROWSER) throw new Error('未找到浏览器');
    const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ppd-probe-'));
    const browser = spawn(BROWSER, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
      '--in-process-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`,
      `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
      '--window-size=1280,720', 'about:blank',
    ], { stdio: 'ignore' });
    let target;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      try { target = await getJson(`http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PORT}/?auto=ai`, 'PUT'); break; } catch (e) { /* retry */ }
    }
    if (!target) throw new Error('CDP 目标创建失败');
    const cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?auto=ai` });
    await sleep(3500);
    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.exceptionDetails) throw new Error('页面执行出错: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
      return r.result.value;
    };
    // 显式开启观众（默认关闭）+ 清缓存强制重建（观众进入静态层）
    await evalJs('PPD.setNoCrowd(false); window.TTG && window.TTG.clearCrowdCache(); true');
    await sleep(600);
    const normal = JSON.parse(await evalJs(STATS));
    console.log('normal crowd px :', JSON.stringify(normal));
    // 蓝方得分 → 蓝方球迷欢呼（举手+起身）、红方球迷摇头
    await evalJs(`(() => { const a = window.__PPD.app; a.engine.events.push({ t: a.engine.t, c: 'point', s: 1 }); return true; })()`);
    const samples = [];
    let prev = 0;
    for (const ms of [100, 200, 300, 450, 600, 800]) {
      await sleep(ms - prev); prev = ms;
      const s = JSON.parse(await evalJs(STATS));
      samples.push({ ms, red: s.red, blue: s.blue, total: s.total });
    }
    console.log('cheer samples    :', JSON.stringify(samples));
    cdp.close(); killTree(browser);
  } catch (e) {
    console.error('探针失败:', e.message);
    process.exit(1);
  } finally { killTree(server); }
}
main();
