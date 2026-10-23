/* 直接验证"翻转分支"是否真的把图翻回去。
   把 drawArenaPlate 分别放在 scale(-1,1) 与不缩放的画布上各画一次，比较左右暖度。 */
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
    await pg.waitForTimeout(2200);
    const out = await pg.evaluate(async () => {
      const T = PPD.TTG;
      const W = 200, H = 140;
      const measure = (g) => {
        const d = g.getImageData(0, 0, W, H).data;
        const warm = (x0, x1) => {
          let r = 0, b = 0, n = 0;
          for (let y = 40; y < 70; y++) {
            for (let x = x0; x < x1; x++) {
              const i = (y * W + x) * 4;
              r += d[i]; b += d[i + 2]; n++;
            }
          }
          return Math.round(r / n - b / n);
        };
        return { left: warm(10, 40), right: warm(160, 190) };
      };
      // A) 不缩放
      const cA = document.createElement('canvas'); cA.width = W; cA.height = H;
      const gA = cA.getContext('2d');
      T.setArenaPlate('plate');
      T.drawArenaPlate(gA, W, H);
      const A = measure(gA);
      // B) 模拟红方镜像
      const cB = document.createElement('canvas'); cB.width = W; cB.height = H;
      const gB = cB.getContext('2d');
      gB.translate(W, 0); gB.scale(-1, 1);
      T.drawArenaPlate(gB, W, H);
      const B = measure(gB);
      return { noMirror: A, mirrored: B };
    });
    console.log(JSON.stringify(out, null, 1));
  } finally {
    await br.close(); srv.close();
  }
})();
