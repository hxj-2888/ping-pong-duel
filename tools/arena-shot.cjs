/* 开发工具：用无头浏览器给 tools/arena-harness.html 批量出图（离线对比用）
 *
 * 用法：node tools/arena-shot.cjs <输出目录> [QueryString ...]
 *   例：node tools/arena-shot.cjs %TEMP%\shots "eye=0,5.6,-5.6&f=1240" [--file:density=0.5&fan=cheer]
 *
 * 依赖 playwright-core（优先仓库 node_modules，其次借全局 @playwright/cli）；找不到就 SKIP。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
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
const exe = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

(async () => {
  const args = process.argv.slice(2);
  const OUT = path.resolve(args[0] || path.join(os.tmpdir(), 'arena-shot'));
  const list = args.slice(1).filter((a) => !a.startsWith('--')).length ? args.slice(1) : ['default'];
  /* 画幅：--size=WxH（默认 1280×720）。视口、截图 clip 与 harness 画布
     三者必须同步——harness 默认画布 1280×720，若只放大视口/clip 而 URL
     不带 w/h，画布仍是 720 行，底部多出来的是页面背景（纯黑），
     验收指标（band 亮度/直方图）会被这条黑边严重污染。 */
  const sizeArg = args.find((a) => a.startsWith('--size='));
  const [VW, VH] = sizeArg ? sizeArg.slice(7).split('x').map(Number) : [1280, 720];
  const sizeQuery = 'w=' + VW + '&h=' + VH;
  fs.mkdirSync(OUT, { recursive: true });
  const chromium = loadChromium();
  if (!chromium) { console.log('SKIP：未找到 playwright-core'); return; }
  const br = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await br.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });
  const base = pathToFileURL(path.join(__dirname, 'arena-harness.html')).href;
  for (const q of list) {
    const name = (q === 'default' ? 'free' : q.replace(/[^a-z0-9]+/gi, '_')).slice(0, 90);
    const url = q === 'default'
      ? base + '?' + sizeQuery
      : base + '?' + sizeQuery + '&' + q;
    errs.length = 0;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(700);   // 光棒贴图加载
    if (await page.evaluate(() => typeof window.__draw === 'function')) await page.evaluate(() => window.__draw());
    const f = path.join(OUT, name + '.png');
    await page.screenshot({ path: f, clip: { x: 0, y: 0, width: VW, height: VH } });
    const bad = await page.evaluate(() => document.getElementById('bad').textContent);
    console.log(f + (bad ? '  ⚠ ' + bad : '') + (errs.length ? '  ⚠ ' + errs.join(' | ') : ''));
  }
  await br.close();
})();
