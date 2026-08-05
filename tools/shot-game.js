/* 开发工具：截取真实游戏（AI 模式）画面并统计观众席像素 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8783;
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(p) {
  return new Promise((resolve) => {
    const http = require('http');
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }).on('error', () => resolve(-1));
  });
}

(async () => {
  try {
    for (let i = 0; i < 30; i++) { await sleep(100); if ((await get('/')) === 200) break; }
    const OUT = path.join(__dirname, 'shots', 'game-crowd.png');
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const BROWSERS = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ];
    const BROWSER = BROWSERS.find((p) => fs.existsSync(p));
    if (!BROWSER) throw new Error('未找到浏览器');
    const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ppd-game-'));
    const child = spawn(BROWSER, [
      '--headless=new', '--no-sandbox', '--disable-gpu',
      '--disable-software-rasterizer', '--in-process-gpu', '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      '--window-size=1280,720',
      `--screenshot=${OUT}`,
      `http://127.0.0.1:${PORT}/?auto=ai`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => { child.kill(); throw new Error('截图超时'); }, 30000);
    await new Promise((resolve, reject) => {
      child.on('exit', () => {
        clearTimeout(timer);
        fs.existsSync(OUT) ? resolve() : reject(new Error('未生成截图\n' + err.slice(0, 500)));
      });
    });
    console.log('游戏截图:', OUT);
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    server.kill();
  }
})();
