/* 赛场画面截图（真实浏览器，用于人工/脚本验收，零新增依赖）
 *
 * 用法：
 *   node tools/arena-verify.cjs [输出目录] [--free]
 *
 * 模式：
 *   默认   真实对局：静态服务 + 无头浏览器打开 index.html?auto=ai，等对局跑起来后截图。
 *          （与线上一致的相机、观众密度 density=0.5、HUD 全量）
 *   --free 自由相机「验收机位」：直接调用 render.js 的 drawScene，俯角与参考图接近，
 *          用 world 参数复现参考图的视角，便于逐项对照（不是游戏内相机）。
 *
 * 产出：
 *   <输出目录>/*.png            截图
 *   <输出目录>/verify.json      读数（帧率、每帧耗时、亮区占比、应援棒像素统计）
 *
 * 依赖：playwright-core —— 优先用仓库 node_modules，其次借全局 @playwright/cli 的副本；
 *      都找不到时打印 SKIP 并以 0 退出（与 tools/pp-layout-probe.cjs 同策略）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');

function loadChromium() {
  const candidates = [
    path.join(ROOT, 'node_modules'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'cli', 'node_modules'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules'),
  ];
  for (const c of candidates) {
    try { return createRequire(path.join(c, 'index.js'))('playwright-core').chromium; } catch (e) { /* next */ }
  }
  return null;
}
const exe = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webp': 'image/webp',
};
function serve() {
  const srv = http.createServer((q, r) => {
    let u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/') u = '/index.html';
    const f = path.join(PUB, u);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  });
  return new Promise((k) => srv.listen(0, '127.0.0.1', () => k(srv)));
}

// 浏览器内：量一帧里「高亮区（球台上方聚光）」与「应援棒」的像素分布
const MEASURE = () => {
  const cv = document.querySelector('canvas');
  if (!cv) return { err: 'no canvas' };
  const g = cv.getContext('2d', { willReadFrequently: true });
  const W = cv.width, H = cv.height;
  const d = g.getImageData(0, 0, W, H).data;
  let bright = 0, mid = 0, dark = 0, warm = 0, cool = 0, tot = 0;
  // 只统计下半部（球场 + 球员），上半部是看台/应援棒
  for (let y = (H * 0.45) | 0; y < H * 0.92; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      tot++;
      if (l > 120) bright++; else if (l > 55) mid++; else dark++;
      if (r > 90 && r > b * 1.5) warm++;
      if (b > 90 && b > r * 1.5) cool++;
    }
  }
  // 上半部：应援棒亮像素（看台区）
  let stickPx = 0, stickTot = 0;
  for (let y = 0; y < H * 0.45; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      stickTot++;
      if (l > 60) stickPx++;
    }
  }
  return {
    brightPct: +(100 * bright / tot).toFixed(2),
    midPct: +(100 * mid / tot).toFixed(2),
    darkPct: +(100 * dark / tot).toFixed(2),
    warmPct: +(100 * warm / Math.max(1, warm + cool)).toFixed(1),
    upperStickPct: +(100 * stickPx / stickTot).toFixed(2),
  };
};

(async () => {
  const outArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const FREE = process.argv.includes('--free');
  const OUT = path.resolve(outArg || path.join(os.tmpdir(), 'arena-verify'));
  fs.mkdirSync(OUT, { recursive: true });
  const chromium = loadChromium();
  if (!chromium) { console.log('SKIP：本机未找到 playwright-core，跳过真实浏览器截图'); return; }
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const br = await chromium.launch(exe ? { executablePath: exe } : {});
  const report = { mode: FREE ? 'free' : 'game', shots: {}, at: new Date().toISOString() };
  const tmpPage = path.join(PUB, '__arena_free.html');
  try {
    const ctx = await br.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    pg.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });

    if (!FREE) {
      await pg.goto(base + '/index.html?auto=ai', { waitUntil: 'load' });
      await pg.waitForTimeout(3200);            // 等对局与贴图加载
      // 帧率：连续 90 帧的 rAF 间隔
      const fps = await pg.evaluate(() => new Promise((res) => {
        const ts = []; let n = 0;
        const tick = (t) => { ts.push(t); if (++n < 90) requestAnimationFrame(tick); else res(ts); };
        requestAnimationFrame(tick);
      }));
      const dts = fps.slice(1).map((t, i) => t - fps[i]).sort((a, b) => a - b);
      report.fps = +(1000 / (dts.reduce((a, b) => a + b, 0) / dts.length)).toFixed(1);
      report.frameMsMedian = +dts[dts.length >> 1].toFixed(2);
      report.frameMsP95 = +dts[Math.floor(dts.length * 0.95)].toFixed(2);
      // 触发一次得分欢呼：直接给 fan 置 1（与 state.js 得分路径同一字段）
      await pg.evaluate(() => {
        const app = window.PPD && window.PPD.app;
        if (app && app.fan) { app.fan.cheer[0] = 1; app.fan.shake[1] = 1; }
      });
      await pg.waitForTimeout(260);
      await pg.screenshot({ path: path.join(OUT, 'game-cheer-red.png') });
      report.shots['game-cheer-red.png'] = await pg.evaluate(MEASURE);
      await pg.waitForTimeout(2400);            // 等欢呼衰减回待机
      await pg.screenshot({ path: path.join(OUT, 'game-idle.png') });
      report.shots['game-idle.png'] = await pg.evaluate(MEASURE);
    } else {
      // 自由相机：把 render.js / characters.js 单独加载进一张空白页，用与参考图相近的俯角出图
      const html = '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">'
        + '<canvas id="c" width="1280" height="720"></canvas>'
        + '<script src="/js/engine/rules.js"></script><script src="/js/engine/math.js"></script>'
        + '<script src="/js/engine/state.js"></script><script src="/js/engine/physics.js"></script>'
        + '<script src="/js/engine/shots.js"></script><script src="/js/engine/strokes.js"></script>'
        + '<script src="/js/engine.js"></script><script src="/js/render.js"></script>'
        + '<script src="/js/characters.js"></script>'
        + '<script>window.__ready = true;</script></body>';
      fs.writeFileSync(tmpPage, html);
      await pg.goto(base + '/__arena_free.html', { waitUntil: 'load' });
      await pg.waitForFunction(() => window.__ready && window.TTG && window.TTG.drawScene);
      await pg.waitForTimeout(1200);             // 等光棒贴图
      await pg.evaluate(() => {
        const cv = document.getElementById('c');
        const ctx = cv.getContext('2d');
        const cam = new TTG.Camera();
        cam.set(TTG.v3(0, 5.6, -5.6), TTG.v3(0, 0.9, 0.2), 640, 360, 1280 * 0.86);
        const players = [
          { side: 0, x: 0.15, z: 2.35, facing: -1, paddle: { p: { x: 0.55, y: 1.02, z: 2.05 } }, stroke: { active: false, type: 0, t: 0, dur: 0.4 } },
          { side: 1, x: -0.15, z: -2.35, facing: 1, paddle: { p: { x: -0.5, y: 1.0, z: -2.05 } }, stroke: { active: false, type: 0, t: 0, dur: 0.4 } },
        ];
        TTG.drawScene(ctx, { cam, players, ball: { pos: { x: 0, y: 0.9, z: -0.3 }, spin: { x: 0, y: 0, z: 0 }, vis: true }, time: 1.2, side: 0, fan: null, density: 1, low: false, noCrowd: false }, 1280, 720);
      });
      await pg.screenshot({ path: path.join(OUT, 'free-idle.png') });
      report.shots['free-idle.png'] = await pg.evaluate(MEASURE);
    }
    report.jsErrors = errs;
    fs.writeFileSync(path.join(OUT, 'verify.json'), JSON.stringify(report, null, 2));
    console.log('截图输出：' + OUT);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    try { if (fs.existsSync(tmpPage)) fs.unlinkSync(tmpPage); } catch (e) { /* ignore */ }
    await br.close();
    srv.close();
  }
})();
