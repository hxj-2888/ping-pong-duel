/* 竖屏排版量测（临时工具）：dump 关键元素的 rect 与关键计算样式
   用法：node tools/pp-probe.cjs [width] [height] */
const path = require('path'), http = require('http'), fs = require('fs'), os = require('os');
const ROOT = path.join(__dirname, '..', 'public');
const W = Number(process.argv[2] || 390), H = Number(process.argv[3] || 844);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.apk': 'application/vnd.android.package-archive' };
function serve() {
  const s = http.createServer((q, r) => {
    let u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/') u = '/index.html';
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  });
  return new Promise(k => s.listen(0, () => k(s)));
}
(async () => {
  const { chromium } = require('playwright-core');
  const exe = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const br = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await br.newContext({ viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  await pg.goto(base + '/index.html', { waitUntil: 'load' });
  await pg.waitForTimeout(800);

  const dump = async (label, sels) => {
    const out = await pg.evaluate((sels) => {
      return sels.map(sel => {
        const e = document.querySelector(sel);
        if (!e) return sel + ' :: 缺失';
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return `${sel} :: ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`
          + ` disp=${cs.display} pos=${cs.position} z=${cs.zIndex} op=${cs.opacity}`
          + ` fs=${cs.fontSize} lh=${cs.lineHeight}`;
      });
    }, sels);
    console.log('== ' + label);
    out.forEach(l => console.log('   ' + l));
  };

  await dump('菜单', ['#menu .logo', '.menu-nick', '#nameInput', '.menu-scroll', '.menu-card', '.records-block',
    '#btnPrimaryAction', '#btnNetEntry', '#btnLocal', '#btnAI', '#btnAIVsAI', '#btnTraining',
    '#btnDressup', '#btnEndless', '.setup-summary', '.apk-row', '#btnSettings']);
  const scroll = await pg.evaluate(() => ({
    scrollH: document.documentElement.scrollHeight, innerH: innerHeight,
    menuScrollH: document.querySelector('.menu-scroll') ? document.querySelector('.menu-scroll').scrollHeight : -1,
    menuClientH: document.querySelector('.menu-scroll') ? document.querySelector('.menu-scroll').clientHeight : -1,
  }));
  console.log('   滚动: doc=' + scroll.scrollH + '/' + scroll.innerH + '  menu-scroll=' + scroll.menuScrollH + '/' + scroll.menuClientH);

  // 打开队伍配置抽屉
  await pg.click('.setup-summary').catch(e => console.log('   抽屉点击失败: ' + String(e).slice(0, 80)));
  await pg.waitForTimeout(600);
  await dump('队伍配置抽屉', ['.setup-group', '.setup-sheet-head', '.pick-row', '.swatch-row', '.pick-seg .segmented', '.swatch']);
  const sheet = await pg.evaluate(() => {
    const e = document.querySelector('.setup-group');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { bottom: Math.round(r.bottom), innerH: innerHeight, inView: r.bottom <= innerHeight + 1 && r.top >= 0 };
  });
  console.log('   抽屉在视口内: ' + JSON.stringify(sheet));
  await pg.screenshot({ path: path.join(os.tmpdir(), 'pp-probe-sheet-' + W + 'x' + H + '.png') });
  await pg.evaluate(() => { const b = document.getElementById('btnSetupClose'); if (b) b.click(); });
  await pg.waitForTimeout(500);

  // 开局 → 对战 HUD
  await pg.evaluate(() => {
    const el = document.getElementById('nameInput');
    if (el) { el.value = '手机玩家'; el.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await pg.click('#btnPrimaryAction');
  await pg.waitForTimeout(700);
  await dump('开场（准备页）', ['.ti-row', '.ti-flag', '.ti-name', '.ti-vs', '.ti-tag', '.ti-count', '.ti-bar', '.ti-actions']);
  await pg.screenshot({ path: path.join(os.tmpdir(), 'pp-probe-intro-' + W + 'x' + H + '.png') });
  await pg.waitForTimeout(2200);
  await dump('对战 HUD', ['#hud', '#gameTools', '#btnExit', '#serveTimer', '#hitRangeInfo', '.bh-scale', '#hintBar', '.joy-area', '#joyBase', '#btnCrouch']);
  await pg.screenshot({ path: path.join(os.tmpdir(), 'pp-probe-game-' + W + 'x' + H + '.png') });

  // 触摸摇杆（浮动）
  await pg.touchscreen.tap(120, 700).catch(() => {});
  const joy = await pg.evaluate(() => {
    const b = document.getElementById('joyBase');
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return { pos: cs.position, opacity: cs.opacity, left: cs.left, top: cs.top, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
  });
  console.log('   摇杆引导位: ' + JSON.stringify(joy));
  if (errs.length) console.log('JS错误: ' + errs.join(' | '));
  await br.close(); srv.close();
})();