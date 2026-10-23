/* 开发工具：抓真实对局画面（含观战席）——临时取消「关闭环境观众」勾选后截图
 * 用法：node tools/arena-game-shot.cjs [输出目录]
 * 依赖 playwright-core（优先仓库 node_modules，其次借全局 @playwright/cli）；找不到就 SKIP。 */
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
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
  const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'arena-game'));
  fs.mkdirSync(OUT, { recursive: true });
  const chromium = loadChromium();
  if (!chromium) { console.log('SKIP：未找到 playwright-core'); return; }
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const br = await chromium.launch(exe ? { executablePath: exe } : {});
  try {
    for (const [mode, w, h] of [['desktop', 1280, 720], ['phone', 844, 390]]) {
      const ctx = await br.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mode === 'phone', hasTouch: mode === 'phone' });
      const pg = await ctx.newPage();
      const errs = [];
      pg.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
      pg.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errs.push('console: ' + m.text().slice(0, 160)); });
      await pg.goto(base + '/index.html?auto=ai', { waitUntil: 'load' });
      await pg.waitForTimeout(1500);
      // 打开环境观众（设置面板的「关闭环境观众」默认勾选）
      await pg.evaluate(() => {
        const el = document.getElementById('setNoCrowd');
        if (el) { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await pg.waitForTimeout(1500);
      await pg.screenshot({ path: path.join(OUT, `game-${mode}-idle.png`) });
      // 得分庆祝：给红方 cheer、蓝方 shake 置 1（与 state.js 得分路径同一字段）
      await pg.evaluate(() => { const f = window.PPD && PPD.app && PPD.app.fan; if (f) { f.cheer[0] = 1; f.shake[1] = 1; } });
      await pg.waitForTimeout(300);
      await pg.screenshot({ path: path.join(OUT, `game-${mode}-cheer.png`) });
      // 帧率（庆祝/待机各量 60 帧）
      await pg.waitForTimeout(2200);
      const fps = await pg.evaluate(() => new Promise((res) => {
        const ts = []; let n = 0;
        const tick = (t) => { ts.push(t); if (++n < 60) requestAnimationFrame(tick); else res(ts); };
        requestAnimationFrame(tick);
      }));
      const dts = fps.slice(1).map((t, i) => t - fps[i]).sort((a, b) => a - b);
      const stat = await pg.evaluate(() => {
        const c = document.querySelector('canvas');
        const g = c.getContext('2d');
        const d = g.getImageData(0, 0, c.width, Math.floor(c.height * 0.4)).data;
        let lit = 0, tot = 0;
        for (let i = 0; i < d.length; i += 4 * 3) { tot++; if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > 45) lit++; }
        return { upperLitPct: +(100 * lit / tot).toFixed(2), crowdOff: !!(window.PPD && PPD.app && PPD.app.noCrowd), density: PPD && PPD.app && PPD.app.mode };
      });
      console.log(`${mode} ${w}x${h}: fps≈${(1000 / (dts.reduce((a, b) => a + b, 0) / dts.length)).toFixed(1)} p95ms=${dts[Math.floor(dts.length * 0.95)].toFixed(1)} ` +
        `upperLit=${stat.upperLitPct}% crowdOff=${stat.crowdOff}` + (errs.length ? '  ⚠ ' + errs.join(' | ') : ''));
      await ctx.close();
    }
    console.log('输出：' + OUT);
  } finally {
    await br.close();
    srv.close();
  }
})();
