/* 性能探针：量「观众席静态层重建」的真实耗时（这是本轮把人数翻 4 倍后最需要盯的指标）。
 * 用法：node tools/arena-perf.cjs
 * 依赖 playwright-core（同其它工具）；找不到就 SKIP。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const { createRequire } = require('module');
const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
function loadChromium() {
  const cands = [
    path.join(ROOT, 'node_modules'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'cli', 'node_modules'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules'),
  ];
  for (const c of cands) {
    try { return createRequire(path.join(c, 'index.js'))('playwright-core').chromium; } catch (e) { /* next */ }
  }
  return null;
}
const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
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
(async () => {
  const chromium = loadChromium();
  if (!chromium) { console.log('SKIP：未找到 playwright-core'); return; }
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const br = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const pg = await br.newPage({ viewport: { width: 1280, height: 720 } });
    await pg.goto(base + '/index.html?auto=ai', { waitUntil: 'load' });
    await pg.waitForTimeout(2500);
    await pg.evaluate(() => {
      const el = document.getElementById('setNoCrowd');
      if (el) { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await pg.waitForTimeout(1200);
    const res = await pg.evaluate(() => {
      const W = PPD.app.resizeW, H = PPD.app.resizeH;
      const TTG = PPD.TTG;
      const ctx = PPD.ctx;
      const cam = PPD.makeCam(0, 0, 0, 0, W, H);
      const bench = (label, fan, density) => {
        const N = 12;
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
          TTG.clearCrowdCache();
          TTG.drawFloor(ctx, cam, W, H, i * 0.05, 0, fan, false, density, false, false);
        }
        return { label, ms: +((performance.now() - t0) / N).toFixed(2) };
      };
      const out = [];
      out.push(bench('rebuild density=0.8', null, 0.62));
      out.push(bench('rebuild density=0.5', null, 0.5));
      out.push(bench('anim-bake density=0.8', { cheer: [1, 0], shake: [0, 1] }, 0.62));
      // 帧率：静止 60 帧 + 横向移动 120 帧（移动会不断触发观众席重建，是最坏情况）
      const sample = (n, move) => new Promise((res) => {
        const ts = []; let i = 0;
        const tick = (t) => {
          ts.push(t);
          if (move) {
            const pl = PPD.app.engine.players[0];
            pl.x = Math.sin(i * 0.12) * 1.2;
            pl.vx = Math.cos(i * 0.12) * 1.2 * 0.12 * 60;
          }
          if (++i < n) requestAnimationFrame(tick); else res(ts);
        };
        requestAnimationFrame(tick);
      });
      return sample(60, false).then((idle) => sample(120, true).then((move) => ({ out, idle, move })));
    });
    const stat = (a) => {
      const d = a.slice(1).map((t, i) => t - a[i]).sort((a, b) => a - b);
      return {
        fps: +(1000 / (d.reduce((x, y) => x + y, 0) / d.length)).toFixed(1),
        p50: +d[d.length >> 1].toFixed(2),
        p95: +d[Math.floor(d.length * 0.95)].toFixed(2),
      };
    };
    console.log(JSON.stringify({ rebuild: res.out, idle: stat(res.idle), moving: stat(res.move) }, null, 1));
  } finally {
    await br.close(); srv.close();
  }
})();
