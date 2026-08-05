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

// 端口上的服务器是否已是"当前版本"：当前版 server.js 才有 /api/records 路由
// （旧版本返回 404）——避免复用旧进程导致通关记录保存静默失败
function isCurrentGame(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/records', timeout: 600 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 杀掉监听指定端口的进程（Windows：netstat 找 PID + taskkill）
function killPort(port) {
  try {
    const { execSync } = require('child_process');
    const out = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true });
    const re = new RegExp(':' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'i');
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(re);
      if (m) execSync('taskkill /PID ' + m[1] + ' /F', { windowsHide: true, stdio: 'ignore' });
    }
  } catch (e) { /* ignore */ }
}

// 等待端口释放（连接被拒绝即视为已释放）
function waitPortFree(port, tries) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const once = () => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => {
        s.destroy();
        if (++n >= tries) reject(new Error('端口 ' + port + ' 释放超时'));
        else setTimeout(once, 150);
      });
      s.once('error', () => { s.destroy(); resolve(); });
    };
    once();
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
      if (await isCurrentGame(PORT)) {
        alreadyRunning = true;
        log('端口 ' + PORT + ' 已有本游戏服务器（当前版本），直接复用');
      } else {
        // 旧版本服务器（无通关记录 API）：杀掉重启，保证记录功能可用
        log('端口 ' + PORT + ' 是本游戏但版本过旧，重启服务器以启用最新功能');
        killPort(PORT);
        try { await waitPortFree(PORT, 20); } catch (e) { log('旧服务器未及时退出: ' + e.message); }
      }
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

  // 浏览器数据（localStorage 等）持久化目录：桌面应用使用**固定**配置目录而非临时目录，
  // 否则每次启动都会清空 localStorage → 地狱解锁/通关、判定虚线、音乐/音效记忆全部丢失。
  // PP_PROFILE 环境变量可覆盖（测试用）。
  const profile = process.env.PP_PROFILE ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'PingPongDuel', 'edge-profile');
  try { fs.mkdirSync(profile, { recursive: true }); } catch (e) { /* 目录创建失败则用系统临时目录兜底 */ }
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

  log('启动浏览器: ' + browser + '  URL=http://127.0.0.1:' + urlPort + '/  profile=' + profile);
  const appWin = spawn(browser, args, { stdio: 'ignore' });
  appWin.on('error', (err) => log('浏览器进程错误: ' + err.message));

  const cleanup = () => {
    if (server) { try { server.kill(); } catch (e) { /* ignore */ } }
    // 持久化配置目录不删除（localStorage 跨会话保留）；仅清理旧的临时配置目录
    try {
      const oldTmp = path.join(os.tmpdir(), 'ppd-app-');
      for (const d of fs.readdirSync(oldTmp)) {
        if (d.startsWith('ppd-app-')) fs.rmSync(path.join(oldTmp, d), { recursive: true, force: true });
      }
    } catch (e) { /* ignore */ }
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
