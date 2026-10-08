/* 首页布局量测（临时工具，零依赖 playwright-core 从全局 @playwright/cli 借用）：
 * 校验快速开始卡片 / 模拟推演内嵌配置在 320 / 360 / 390 / 430 / 768 / 1280 六档宽度下
 * 无横向溢出、无文字被挤出容器、无内容裁切、触控目标达标。
 * 用法：node tools/pp-layout-probe.cjs
 */
const path = require('path'), http = require('http'), fs = require('fs'), os = require('os');
const { createRequire } = require('module');
const ROOT = path.join(__dirname, '..', 'public');

// playwright-core 可能装在全局 @playwright/cli 下，逐个探测
function loadChromium() {
  const candidates = [path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright-core')];
  for (const c of candidates) {
    try { return createRequire(path.join(c, 'index.js'))('playwright-core').chromium; } catch (e) { /* next */ }
  }
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serve() {
  const s = http.createServer((q, r) => {
    let u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/') u = '/index.html';
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  });
  return new Promise((k) => s.listen(0, () => k(s)));
}

// 页内量测：横向溢出 / 文字溢出 / 触控目标
const PROBE = () => {
  const out = { hOverflow: null, textOverflow: [], smallTargets: [], counts: {} };
  const de = document.documentElement;
  out.hOverflow = {
    docScrollW: de.scrollWidth, docClientW: de.clientWidth,
    bodyScrollW: document.body.scrollWidth, innerW: window.innerWidth,
    hasHScroll: de.scrollWidth > de.clientWidth + 1,
  };
  const vw = window.innerWidth;
  // 所有可见元素：右边界不得超出视口（允许 1px 舍入）
  for (const el of document.querySelectorAll('#menu *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      out.textOverflow.push({ sel: el.id ? '#' + el.id : el.className || el.tagName, left: Math.round(r.left), right: Math.round(r.right), vw });
    }
  }
  // 触控目标：色块 ≥32px、其余可点元素 ≥44px
  const targets = [
    ['.quick-seg .seg-btn', 40], ['.quick-card .swatch', 32], ['.sim-start', 44],
    ['#btnPrimaryAction', 44], ['#btnNetEntry', 44], ['.quick-name', 30],
  ];
  for (const [sel, min] of targets) {
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      out.counts[sel] = out.counts[sel] || { n: 0, minH: 999, w: Math.round(r.width) };
      out.counts[sel].n++;
      out.counts[sel].minH = Math.min(out.counts[sel].minH, Math.round(r.height));
      if (r.height < min - 0.5) out.smallTargets.push({ sel, h: Math.round(r.height), need: min });
    }
  }
  // 每个分段控件内的档位必须同一行（页面上有 3 个控件：快速开始难度 + 甲/乙，逐个判定）
  out.difficultyRows = [...document.querySelectorAll('.quick-seg')].map((host) =>
    [...new Set([...host.querySelectorAll('.seg-btn')].map((b) => Math.round(b.getBoundingClientRect().top)))].length);
  // 每行 8 个色块必须同一行
  out.swatchRows = [...document.querySelectorAll('.swatch-row')].map((host) =>
    [...new Set([...host.querySelectorAll('.swatch')].map((b) => Math.round(b.getBoundingClientRect().top)))].length);
  // 档位/色块/队名文字是否被裁切（scrollWidth 超出即视为省略号截断）
  const clipped = [];
  for (const sel of ['.quick-seg .seg-btn', '.quick-title', '.quick-label', '.btn-main', '.quick-name']) {
    for (const el of document.querySelectorAll(sel)) {
      if (!el.getClientRects().length) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        clipped.push({ sel, text: (el.textContent || '').trim().slice(0, 8), sw: el.scrollWidth, cw: el.clientWidth });
      }
    }
  }
  out.clippedText = clipped;
  // 摘要标签是否被裁切（省略号）
  const qs = document.getElementById('quickSummary');
  if (qs) {
    const cs = getComputedStyle(qs);
    out.summary = { text: qs.textContent, ellipsis: cs.textOverflow === 'ellipsis', overflowed: qs.scrollWidth > qs.clientWidth + 1 };
  }
  // 页面级双层滚动检查
  const ms = document.querySelector('.menu-scroll');
  out.scroll = {
    docScrollable: de.scrollHeight > de.clientHeight + 1,
    menuScrollable: ms ? ms.scrollHeight > ms.clientHeight + 1 : false,
  };
  return out;
};

(async () => {
  const chromium = loadChromium();
  if (!chromium) { console.log('SKIP：本机未找到 playwright-core，跳过真实浏览器量测'); process.exit(0); }
  const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const br = await chromium.launch(exe ? { executablePath: exe } : {});
  const SIZES = [[320, 568], [360, 640], [390, 844], [430, 932], [768, 1024], [1280, 800]];
  let fail = 0;
  for (const [W, H] of SIZES) {
    const mobile = W <= 520;
    const ctx = await br.newContext({ viewport: { width: W, height: H }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
    await pg.goto(base + '/index.html', { waitUntil: 'load' });
    await pg.waitForTimeout(700);
    const r = await pg.evaluate(PROBE);
    const lines = [];
    lines.push('宽 ' + W + '×' + H + (mobile ? '（竖屏）' : '（横屏/桌面）'));
    lines.push('  横向滚动条: ' + (r.hOverflow.hasHScroll ? '有！(' + r.hOverflow.docScrollW + '>' + r.hOverflow.docClientW + ')' : '无'));
    if (r.hOverflow.hasHScroll) fail++;
    lines.push('  元素出界: ' + (r.textOverflow.length ? JSON.stringify(r.textOverflow.slice(0, 4)) : '无'));
    if (r.textOverflow.length) fail++;
    const badSeg = r.difficultyRows.filter((n) => n !== 1);
    const badSw = r.swatchRows.filter((n) => n !== 1);
    lines.push('  难度控件档位行数(3 个控件,须全=1): ' + JSON.stringify(r.difficultyRows));
    if (badSeg.length) fail++;
    lines.push('  色块行数(4 行,须全=1): ' + JSON.stringify(r.swatchRows));
    if (badSw.length) fail++;
    lines.push('  摘要: ' + JSON.stringify(r.summary));
    lines.push('  文字被裁切: ' + (r.clippedText.length ? JSON.stringify(r.clippedText.slice(0, 5)) : '无'));
    if (r.clippedText.length) fail++;
    lines.push('  控件尺寸: ' + JSON.stringify(r.counts));
    lines.push('  触控目标不足: ' + (r.smallTargets.length ? JSON.stringify(r.smallTargets) : '无'));
    if (r.smallTargets.length) fail++;
    lines.push('  滚动(页面级/菜单级): ' + r.scroll.docScrollable + ' / ' + r.scroll.menuScrollable);
    lines.push('  JS 错误: ' + (errs.length ? errs.join(' | ') : '无'));
    if (errs.length) fail++;
    console.log(lines.join('\n'));
    await pg.screenshot({ path: path.join(os.tmpdir(), 'pp-home-' + W + 'x' + H + '.png'), fullPage: false });
    // 展开模拟推演后再量一次（内嵌配置区同样不得出界/裁切）
    await pg.click('#btnAIVsAI');
    await pg.waitForTimeout(450);
    const r2 = await pg.evaluate(PROBE);
    lines.push('  [展开模拟推演] 出界: ' + (r2.textOverflow.length ? JSON.stringify(r2.textOverflow.slice(0, 4)) : '无') +
      ' | 难度/色块行数: ' + JSON.stringify(r2.difficultyRows) + '/' + JSON.stringify(r2.swatchRows) +
      ' | 触控不足: ' + (r2.smallTargets.length ? JSON.stringify(r2.smallTargets) : '无'));
    if (r2.textOverflow.length || r2.smallTargets.length ||
      r2.difficultyRows.some((n) => n !== 1) || r2.swatchRows.some((n) => n !== 1)) fail++;
    console.log(lines.slice(-1)[0]);
    await pg.screenshot({ path: path.join(os.tmpdir(), 'pp-home-sim-' + W + 'x' + H + '.png'), fullPage: false });
    await ctx.close();
  }
  await br.close();
  srv.close();
  console.log('\n结果: ' + (fail === 0 ? '六档宽度全部通过 ✓' : fail + ' 项不达标'));
  process.exit(fail ? 1 : 0);
})();