/* 手机竖屏 / 横屏实拍（本轮改了机位，必须确认竖屏不裁切、不露出表格边缘）
 * 用法：node tools/arena-portrait-shot.cjs [输出目录]
 * 依赖 playwright-core（同其它工具），找不到就 SKIP。
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
const DEV = [
  { n: 'portrait-390x844', w: 390, h: 844 },
  { n: 'landscape-844x390', w: 844, h: 390 },
];
(async () => {
  const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'arena-portrait'));
  fs.mkdirSync(OUT, { recursive: true });
  const chromium = loadChromium();
  if (!chromium) { console.log('SKIP：未找到 playwright-core'); return; }
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const br = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    for (const d of DEV) {
      const ctx = await br.newContext({ viewport: { width: d.w, height: d.h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const pg = await ctx.newPage();
      const errs = [];
      pg.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
      await pg.goto(base + '/index.html?auto=ai', { waitUntil: 'load' });
      await pg.waitForTimeout(1800);
      await pg.evaluate(() => {
        const el = document.getElementById('setNoCrowd');
        if (el) { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await pg.waitForTimeout(1600);
      await pg.screenshot({ path: path.join(OUT, 'phone-' + d.n + '.png') });
      const ov = await pg.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, w: innerWidth }));
      console.log('shot:', d.n + (ov.scrollW > ov.w + 1 ? '  ⚠ 横向滚动' : '') + (errs.length ? '  ⚠ ' + errs.join(' | ') : ''));
      await ctx.close();
    }
    console.log('输出：' + OUT);
  } finally {
    await br.close(); srv.close();
  }
})();
