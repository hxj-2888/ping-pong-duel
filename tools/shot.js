/* 开发工具：无头 Chrome 截取菜单页与静态动作瞬间 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 8782;
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const BROWSER = BROWSERS.find((p) => fs.existsSync(p));
const OUT_DIR = process.argv[2] || path.join(__dirname, 'shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

function shot(url, file) {
  return new Promise((resolve, reject) => {
    const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ppd-chrome-'));
    const args = [
      '--headless=new', '--no-sandbox', '--disable-gpu',
      '--disable-software-rasterizer', '--in-process-gpu', '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      `--window-size=1280,720`, `--screenshot=${file}`, url,
    ];
    let err = '';
    const child = spawn(BROWSER, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Chrome 截图超时: ' + file)); }, 20000);
    child.on('exit', () => {
      clearTimeout(timer);
      fs.existsSync(file) ? resolve(file) : reject(new Error('未生成截图: ' + file + '\n' + err.slice(0, 800)));
    });
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      try { if ((await get('/')) === 200) break; } catch (e) { /* retry */ }
    }
    const menu = path.join(OUT_DIR, 'menu.png');
    await shot(`http://127.0.0.1:${PORT}/`, menu);
    console.log('菜单截图:', menu);

    const action = path.join(OUT_DIR, 'action-stick.png');
    await shot('file:///' + path.join(ROOT, 'tools', 'preview.html').replace(/\\/g, '/'), action);
    console.log('动作截图:', action);
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    server.kill();
  }
}

main();
