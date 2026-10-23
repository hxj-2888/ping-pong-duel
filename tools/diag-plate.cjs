/* 诊断：直接在页面里量"底片被画成什么样"，不靠截图猜。 */
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
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
  if (!chromium) { console.log('SKIP'); return; }
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const br = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    const pg = await br.newPage({ viewport: { width: 1280, height: 720 } });
    await pg.goto(base + '/index.html?auto=ai', { waitUntil: 'load' });
    await pg.waitForTimeout(2500);
    const out = await pg.evaluate(() => {
      const T = PPD.TTG;
      const cv = document.querySelector('canvas');
      const g = cv.getContext('2d');
      // 直接调用 drawArenaPlate 到一张干净画布，看它画出来是左暖还是左冷
      const c2 = document.createElement('canvas');
      c2.width = 200; c2.height = 140;
      const g2 = c2.getContext('2d');
      T.drawArenaPlate(g2, 200, 140);
      const d = g2.getImageData(0, 0, 200, 140).data;
      const warm = (x0, x1) => {
        let r = 0, b = 0, n = 0;
        for (let y = 40; y < 70; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * 200 + x) * 4;
            r += d[i]; b += d[i + 2]; n++;
          }
        }
        return Math.round(r / n - b / n);
      };
      // 再测主画布实际内容（左侧 vs 右侧的暖度）
      const mw = cv.width, mh = cv.height;
      const md = g.getImageData(0, 0, mw, mh).data;
      const warmM = (x0, x1) => {
        let r = 0, b = 0, n = 0;
        const y0 = Math.floor(mh * 0.30), y1 = Math.floor(mh * 0.45);
        for (let y = y0; y < y1; y += 2) {
          for (let x = Math.floor(mw * x0); x < Math.floor(mw * x1); x += 2) {
            const i = (y * mw + x) * 4;
            r += md[i]; b += md[i + 2]; n++;
          }
        }
        return Math.round(r / n - b / n);
      };
      return {
        plateDirect: { left: warm(10, 40), right: warm(160, 190) },
        mainCanvas: { left: warmM(0.05, 0.20), right: warmM(0.80, 0.95) },
        flipFlag: T.arenaPlateMode ? 'mode=' + T.arenaPlateMode() : null,
        side: PPD.app.side, mode: PPD.app.mode,
      };
    });
    console.log(JSON.stringify(out, null, 1));
  } finally {
    await br.close(); srv.close();
  }
})();
