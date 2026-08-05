/* ============================================================
 * desktop-launcher.js — 乒乓对决桌面应用启动器
 * 1) 启动本地游戏服务器（若端口已被占用则复用现有服务器）
 * 2) 用 Edge/Chrome 的“应用窗口模式”打开游戏（无地址栏，像独立应用）
 * 3) 关闭游戏窗口后自动关闭由本应用启动的服务器
 * 测试钩子：PP_APP_TEST=1 时以无头模式截图并自动退出（开发用）
 * ============================================================ */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = Number(process.env.PORT || 8765);
const ROOT = __dirname;
const TEST = !!process.env.PP_APP_TEST;

function log(msg) {
  try {
    fs.appendFileSync(path.join(ROOT, 'app.log'), new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) { /* ignore */ }
}

function pickBrowser() {
  const list = [
    process.env.PP_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  return list.find((p) => fs.existsSync(p));
}

function serverReady(port, tries) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const once = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 600 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (++n >= tries) reject(new Error('游戏服务器启动超时'));
        else setTimeout(once, 200);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    once();
  });
}

// 端口上的服务是否就是本游戏（用新版独有资源 js/ai.js 识别）
function isOurGame(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/js/ai.js', timeout: 600 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function main() {
  const browser = pickBrowser();
  if (!browser) {
    log('未找到 Edge/Chrome，无法打开游戏窗口');
    return;
  }

  let server = null;
  let alreadyRunning = false;
  let urlPort = PORT;
  try {
    await serverReady(PORT, 1);
    if (await isOurGame(PORT)) {
      alreadyRunning = true;
      log('端口 ' + PORT + ' 已有本游戏服务器，直接复用');
    } else {
      urlPort = await findFreePort();
      log('端口 ' + PORT + ' 被其他程序占用，自动改用空闲端口 ' + urlPort);
    }
  } catch (e) { /* 服务器未运行，需要自己启动 */ }

  if (!alreadyRunning) {
    server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(urlPort) },
      stdio: 'ignore',
    });
    server.on('error', (err) => log('服务器进程错误: ' + err.message));
    try {
      await serverReady(urlPort, 25);
    } catch (err) {
      log('服务器启动失败: ' + err.message);
      if (server) { try { server.kill(); } catch (e) { /* ignore */ } }
      return;
    }
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ppd-app-'));
  const args = [
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-http-cache',
  ];
  if (TEST) {
    args.push(
      '--headless=new', '--no-sandbox', '--disable-gpu',
      '--disable-software-rasterizer', '--in-process-gpu',
      '--screenshot=' + path.join(os.tmpdir(), 'ppd-app-test.png')
    );
    args.push('http://127.0.0.1:' + urlPort + '/');
  } else {
    args.unshift('--app=http://127.0.0.1:' + urlPort + '/');
  }

  log('启动浏览器: ' + browser + '  URL=http://127.0.0.1:' + urlPort + '/');
  const appWin = spawn(browser, args, { stdio: 'ignore' });
  appWin.on('error', (err) => log('浏览器进程错误: ' + err.message));

  const cleanup = () => {
    if (server) { try { server.kill(); } catch (e) { /* ignore */ } }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  };

  appWin.on('exit', (code) => {
    log('游戏窗口已关闭 code=' + code);
    cleanup();
    process.exit(0);
  });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

main().catch((err) => { log('启动器异常: ' + (err && err.message)); });
