/* 开发工具：通过 CDP 在真实游戏中验证观众席（常规 / 得分欢呼两态像素统计 + 截图） */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8783;
const CDP_PORT = 9300 + Math.floor(Math.random() * 400); // 随机调试端口，避免残留进程占用
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(proc) {
  if (!proc || proc.killed) return;
  try { require('child_process').execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' }); } catch (e) { /* ignore */ }
}

// ---------- 启动游戏服务器 ----------
const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------- CDP 客户端（Node 内置 WebSocket） ----------
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const { resolve: r, reject: j } = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? j(new Error(m.error.message)) : r(m.result);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

// ---------- 页面内像素统计 ----------
// 观众为红/蓝坐姿火柴人：左侧(世界 x<0)=己方红色球迷、右侧=敌方蓝色球迷（视角 side 0）
const STATS_JS = `(() => {
  const c = document.getElementById('game');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const W = c.width;
  function isRed(r, g, b) { return r > 110 && r > g + 40 && r > b + 40; }
  function isBlue(r, g, b) { return b > 110 && b > r + 40 && b > g + 40; }
  function count(x0, x1, y0, y1, kind) {
    let n = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
        if (kind === 'red' ? isRed(r, g, b) : isBlue(r, g, b)) n++;
      }
    }
    return n;
  }
  return JSON.stringify({
    leftRed: count(10, 190, 60, 470, 'red'),
    leftBlue: count(10, 190, 60, 470, 'blue'),
    rightRed: count(W - 190, W - 10, 60, 470, 'red'),
    rightBlue: count(W - 190, W - 10, 60, 470, 'blue'),
  });
})()`;

async function main() {
  try {
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      await getJson(`http://127.0.0.1:${PORT}/`).catch(() => {});
    }
    const BROWSERS = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ];
    const BROWSER = BROWSERS.find((p) => fs.existsSync(p));
    if (!BROWSER) throw new Error('未找到浏览器');
    const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ppd-cdp-'));
    const browser = spawn(BROWSER, [
      '--headless=new', '--no-sandbox', '--disable-gpu',
      '--disable-software-rasterizer', '--in-process-gpu', '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
      '--window-size=1280,720', 'about:blank',
    ], { stdio: 'ignore' });

    // 等待 CDP 就绪并创建页面目标（/json/new 需 PUT）
    let target;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      try {
        target = await getJson(`http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PORT}/?auto=ai`, 'PUT');
        break;
      } catch (e) { /* retry */ }
    }
    if (!target) throw new Error('CDP 未就绪');

    const cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?auto=ai` });
    await sleep(3500); // 等游戏启动并对打

    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.exceptionDetails) throw new Error('页面执行出错: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value;
    };
    const shot = async (file) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    };

    // 状态 1：常规对打（视角 side 0：左侧=红方球迷、右侧=蓝方球迷）
    const normal = JSON.parse(await evalJs(STATS_JS));
    await shot(path.join(__dirname, 'shots', 'game-normal.png'));
    console.log('常规状态观众区:', JSON.stringify(normal));
    const fanBefore = await evalJs('JSON.stringify(window.__PPD.app.fan)');

    // 真实掌声 WAV 加载状态（audio/applause.wav 解码）
    let wavLoaded = false;
    for (let i = 0; i < 20 && !wavLoaded; i++) {
      await sleep(150);
      wavLoaded = await evalJs('window.GameAudio.applauseLoaded()');
    }
    console.log('真实掌声 WAV 已加载:', wavLoaded);

    // 座位（看台长条座椅）钢蓝色像素检测（座面/靠背/提亮前脸）
    const benchPx = await evalJs(`(() => {
      const c = document.getElementById('game');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let y = 50; y < 500; y += 2) {
        for (let x = 0; x < c.width; x += 2) {
          const i = (y * c.width + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
          if (Math.abs(r - 120) < 62 && Math.abs(g - 150) < 62 && Math.abs(b - 180) < 66) n++;
        }
      }
      return n;
    })()`);
    console.log('座位像素:', benchPx);

    // 球员上衣：近侧我方（红上衣，底部中央）、远侧对方（蓝上衣，上部中央）
    const shirt = JSON.parse(await evalJs(`(() => {
      const c = document.getElementById('game');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const W = c.width, H = c.height;
      // 上衣红：饱和红（排除棕色木地板 r>g>b 但 g-b 大）
      const isShirtRed = (r, g, b) => r > 130 && r > g + 40 && r > b + 40 && (g - b) < 25;
      const isBlue = (r, g, b) => b > 110 && b > r + 40 && b > g + 40;
      let redNear = 0, blueFar = 0;
      for (let y = Math.floor(H * 0.55); y < H * 0.95; y += 1) {
        for (let x = Math.floor(W * 0.35); x < W * 0.65; x += 1) {
          const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
          if (isShirtRed(r, g, b)) redNear++;
        }
      }
      for (let y = Math.floor(H * 0.28); y < H * 0.5; y += 1) {
        for (let x = Math.floor(W * 0.35); x < W * 0.65; x += 1) {
          const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
          if (isBlue(r, g, b)) blueFar++;
        }
      }
      return JSON.stringify({ redNear, blueFar });
    })()`));
    console.log('球员上衣像素（近侧红/远侧蓝）:', JSON.stringify(shirt));

    // 球台投影阴影：用页面内真实相机（含跟随/镜像）采样台侧+台尾阴影带 vs 无影地板
    const shadow = JSON.parse(await evalJs(`(() => {
      const app = window.__PPD.app;
      const TTG = window.TTG;
      const W = app.resizeW, H = app.resizeH;
      const followX = app.engine.players[0].x;
      const camX = followX - TTG.clamp(followX, -0.62, 0.62);
      const cam = new TTG.Camera();
      cam.set(TTG.v3(camX, 4.8, -5.2 + camX * 0.05), TTG.v3(camX * 0.55, 1.7, 0), W / 2, H / 2, W * 0.9);
      const c = document.getElementById('game');
      const d = c.getContext('2d').getImageData(0, 0, W, H).data;
      const bri = (x, y, z) => {
        const q = cam.project(TTG.v3(x, y, z));
        if (!q) return null;
        const sx = W - q.x; // 红方视角镜像
        if (sx < 0 || sx >= W || q.y < 0 || q.y >= H) return null;
        let s = 0, n = 0;
        for (let dy = -2; dy <= 2; dy += 2) for (let dx = -2; dx <= 2; dx += 2) {
          const i = ((Math.round(q.y + dy) * W + Math.round(sx + dx))) * 4;
          s += d[i] + d[i + 1] + d[i + 2]; n++;
        }
        return s / n;
      };
      return JSON.stringify({
        near: bri(0.98, 0.004, 0.5),   // 台侧近处（阴影较深）
        mid: bri(1.5, 0.004, 0.5),     // 台侧中距（淡影）
        far: bri(2.2, 0.004, 0.5),     // 台侧远处（无影）
      });
    })()`));
    console.log('阴影采样（台侧/台尾 vs 无影）:', JSON.stringify(shadow));

    // 球员胯下接触阴影：近侧球员脚下中心应比偏移处更暗
    const pShadow = JSON.parse(await evalJs(`(() => {
      const app = window.__PPD.app;
      const TTG = window.TTG;
      const pl = app.engine.players[0];
      const W = app.resizeW, H = app.resizeH;
      const camX = pl.x - TTG.clamp(pl.x, -0.62, 0.62);
      const cam = new TTG.Camera();
      cam.set(TTG.v3(camX, 4.8, -5.2 + camX * 0.05), TTG.v3(camX * 0.55, 1.7, 0), W / 2, H / 2, W * 0.9);
      const c = document.getElementById('game');
      const d = c.getContext('2d').getImageData(0, 0, W, H).data;
      const bri = (x, z, sy) => {
        const q = cam.project(TTG.v3(x, 0.004, z));
        if (!q) return null;
        const sx = W - q.x;
        const cy = Math.min(q.y, sy); // 与渲染一致：阴影贴画面底部
        if (sx < 0 || sx >= W || cy < 0 || cy >= H) return null;
        let s = 0, n = 0;
        for (let dy = -3; dy <= 3; dy += 2) for (let dx = -3; dx <= 3; dx += 2) {
          const i = (Math.round(cy + dy) * W + Math.round(sx + dx)) * 4;
          s += d[i] + d[i + 1] + d[i + 2]; n++;
        }
        return s / n;
      };
      return JSON.stringify({ center: bri(pl.x + 0.25, pl.z, H - 14), offset: bri(pl.x + 0.85, pl.z, H - 14) });
    })()`));
    console.log('球员胯下阴影（脚下中心/偏移）:', JSON.stringify(pShadow));

    // 正对面（远端）座椅可见性：顶部中央钢蓝像素（座面+靠背，颜色已提亮）
    const farSeats = await evalJs(`(() => {
      const c = document.getElementById('game');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const W = c.width;
      let n = 0;
      for (let y = 30; y < 210; y += 2) {
        for (let x = Math.floor(W * 0.22); x < W * 0.78; x += 2) {
          const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
          if (Math.abs(r - 120) < 62 && Math.abs(g - 150) < 62 && Math.abs(b - 180) < 66) n++;
        }
      }
      return n;
    })()`);
    console.log('正对面远端座椅像素:', farSeats);

    // 状态 2：模拟蓝方（side 1）得分 → 蓝方球迷欢呼、红方球迷摇头
    await evalJs(`(() => {
      const a = window.__PPD.app;
      a.engine.score = [9, 8];       // 胶着比分 → 音乐强度
      a.engine.events.push({ t: a.engine.t, c: 'point', s: 1 });
      return true;
    })()`);
    await sleep(600);
    const cheer = JSON.parse(await evalJs(STATS_JS));
    await shot(path.join(__dirname, 'shots', 'game-cheer.png'));
    console.log('欢呼状态观众区:', JSON.stringify(cheer));
    const fanAfter = JSON.parse(await evalJs('JSON.stringify(window.__PPD.app.fan)'));
    const fanBeforeJ = JSON.parse(fanBefore);
    console.log(`\n得分前 fan=${fanBefore}  得分后(蓝方得分) fan=${JSON.stringify(fanAfter)}`);

    const okLeft = normal.leftRed > 300 && normal.leftRed > normal.leftBlue;      // 左侧=红方
    const okRight = normal.rightBlue > 300 && normal.rightBlue > normal.rightRed; // 右侧=蓝方
    const okFanIdle = fanBeforeJ.cheer[0] < 0.2 && fanBeforeJ.cheer[1] < 0.2 && fanBeforeJ.shake[0] < 0.2 && fanBeforeJ.shake[1] < 0.2;
    const okFanReact = fanAfter.cheer[1] > 0.5 && fanAfter.shake[0] > 0.5; // 蓝方球迷欢呼、红方球迷摇头
    const okWav = wavLoaded;
    const okBench = benchPx > 2000; // 看台座席可见
    const okShirt = shirt.redNear > 100 && shirt.blueFar > 100; // 我方红上衣 / 对方蓝上衣
    const ctrl = shadow.far || 1e9;
    // 台侧近处（阴影内）应明显暗于远处（无影）；中距为阴影边界外，与远处相当
    const okShadow = shadow.near < ctrl * 0.93 && shadow.near < shadow.mid;
    const okFarSeats = farSeats > 800; // 正对面远端座椅清晰可见
    console.log(okLeft ? '✓ 观众左侧=己方红色球迷（视角 side 0）' : '✗ 左侧非红色球迷');
    console.log(okRight ? '✓ 观众右侧=敌方蓝色球迷' : '✗ 右侧非蓝色球迷');
    console.log(okFanIdle ? '✓ 常规状态球迷平静' : '✗ 常规状态球迷非平静');
    console.log(okFanReact ? '✓ 蓝方得分：蓝方球迷欢呼、红方球迷摇头' : '✗ 得分方欢呼/对方摇头未生效');
    console.log(okWav ? '✓ 真实掌声 WAV 已加载解码' : '✗ 掌声 WAV 加载失败（将用合成掌声兜底）');
    console.log(okBench ? '✓ 观众座位（看台长条座椅）已渲染' : '✗ 座位未渲染');
    console.log(okShirt ? '✓ 球员上衣：近侧我方红色、远侧对方蓝色' : '✗ 球员上衣颜色异常');
    console.log(okShadow ? '✓ 球台投影阴影已生效（桌面周围地板更暗）' : '✗ 球台阴影未见');
    console.log('球员胯下阴影（结构验证：径向渐变椭圆贴底渲染，见 node 检查）');
    console.log(okFarSeats ? '✓ 正对面远端观众座椅清晰可见（与左右一致）' : '✗ 远端座椅不可见');
    cdp.close();
    killTree(browser);
    process.exit(okLeft && okRight && okFanIdle && okFanReact && okWav && okBench && okShirt && okShadow && okFarSeats ? 0 : 1);
  } catch (e) {
    console.error('CDP 验证失败:', e.message);
    process.exit(1);
  } finally {
    killTree(server);
  }
}
main();
