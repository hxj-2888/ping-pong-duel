/* 乒乓对决 · 移动端布局截图（竖屏/横屏），用于人工复核
   用法：node tools/pp-shots.cjs [输出目录] [mode=menu|game] */
const path = require('path'), http = require('http'), fs = require('fs'), os = require('os');
const ROOT = path.join(__dirname, '..', 'public');
const OUT = process.argv[2] || path.join(os.tmpdir(), 'pp-shots');
const MODE = process.argv[3] || 'menu';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.apk': 'application/vnd.android.package-archive' };
const DEV = [
  { n: 'portrait-390x844', w: 390, h: 844 },
  { n: 'landscape-844x390', w: 844, h: 390 },
  { n: 'small-360x640', w: 360, h: 640 },
];
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
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const br = await chromium.launch(exe ? { executablePath: exe } : {});
  for (const d of DEV) {
    const ctx = await br.newContext({ viewport: { width: d.w, height: d.h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', e => errs.push(String(e).slice(0, 120)));
    await pg.goto(base + '/index.html', { waitUntil: 'load' });
    await pg.waitForTimeout(700);
    if (MODE === 'game') {
      /* 真实开局：填昵称 → 点「快速开始」→ 等对局跑起来（canvas 才有画面） */
      try {
        await pg.fill('#nameInput', '手机玩家');
        await pg.click('#btnPrimaryAction');
        await pg.waitForTimeout(2600);
      } catch (e) { errs.push('开局失败: ' + String(e).slice(0, 90)); }
      const on = await pg.evaluate(() => {
        const m = document.getElementById('menu');
        return { menuHidden: !m || m.style.display === 'none' || getComputedStyle(m).display === 'none',
                 hudShown: !!document.getElementById('hud') && getComputedStyle(document.getElementById('hud')).display !== 'none',
                 tcShown: !!document.getElementById('touchControls') && getComputedStyle(document.getElementById('touchControls')).display !== 'none' };
      });
      console.log('    状态: menu隐藏=' + on.menuHidden + ' hud=' + on.hudShown + ' 触控=' + on.tcShown);
      await pg.waitForTimeout(600);
    }
    const f = path.join(OUT, 'pp-' + MODE + '-' + d.n + '.png');
    await pg.screenshot({ path: f });
    const ov = await pg.evaluate(() => {
      const out = [];
      const w = innerWidth, h = innerHeight;
      ['menu', 'hud', 'hintBar', 'hitRangeInfo', 'serveTimer', 'touchControls', 'game'].forEach(id => {
        const e = document.getElementById(id) || document.querySelector('.' + id);
        if (!e) return;
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (r.right > w + 1 || r.left < -1 || r.bottom > h + 1 || r.top < -1) {
          out.push(id + ' 出界 ' + JSON.stringify({ l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }));
        }
      });
      return { out, w, h, scrollW: document.documentElement.scrollWidth };
    });
    console.log('shot: ' + f + '  视口 ' + d.w + '×' + d.h + (errs.length ? '  JS错误: ' + errs.join(' | ') : ''));
    ov.out.forEach(e => console.log('    · ' + e));
    if (ov.scrollW > ov.w + 1) console.log('    · 横向滚动: scrollWidth=' + ov.scrollW + ' > ' + ov.w);
    await ctx.close();
  }
  await br.close(); srv.close();
})();