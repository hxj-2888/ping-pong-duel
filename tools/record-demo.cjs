/* ============================================================
 * tools/record-demo.cjs — 录制「AI 对打 · 侧视角」演示视频（作品集 demo）
 *
 * 为什么走 CDP Page.startScreencast：
 *   游戏自带的回放导出用 canvas.captureStream，只能拿到 canvas 像素——比分 HUD、
 *   提示条、暂停按钮这些 DOM 浮层不在画面里，作为"游玩演示"信息量不够。
 *   CDP 的 screencast 抓的是整页合成结果（canvas + DOM），实测 1280×720 下
 *   可达 ~90fps，足够裁成 30fps 的成片。
 *
 * 录制脚本（一条连续镜头，含真实转场，不做任何剪辑拼接）：
 *   1) 场景化主页：两球员预备 + 聚光灯 + 待机动作
 *   2) 点「AI对打」→ 观看视角弹层 → 选「看台视角」（侧视角 / 边线高位）
 *   3) 拨开式转场 → 正式对局：观众席 + 比分 HUD + 真实物理回合
 *   4) 侧视角打满若干回合（发球 / 推挡 / 扣杀 / 得分 / 观众欢呼）
 *
 * 产物（默认 docs/demo/）：
 *   ping-pong-ai-demo.mp4        H.264 成片（作品集首屏用，兼容性最好）
 *   ping-pong-ai-demo.webm       VP9 备份（体积更小）
 *   ping-pong-ai-demo.poster.jpg 封面帧（视频 poster / 首屏回退图）
 *   ping-pong-ai-demo-card.mp4   卡片短版（从 5.4s 起截到结尾：直接看到球在飞）
 *   ping-pong-ai-demo-card.poster.jpg
 *
 * 用法：
 *   node tools/record-demo.cjs                    # 默认 24s
 *   node tools/record-demo.cjs --seconds=30
 *   node tools/record-demo.cjs --name=xxx
 * ============================================================ */
'use strict';
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'public');
const argOf = (k, d) => {
  const m = process.argv.slice(2).find((a) => a.startsWith('--' + k + '='));
  return m ? m.slice(k.length + 3) : d;
};
const SECONDS = Number(argOf('seconds', 26));
// 产物默认落在 docs/demo/：成片要随仓库走（作品集从仓库取用），不放 gitignored 的临时目录
const OUTDIR = path.resolve(argOf('outdir', path.join(__dirname, '..', 'docs', 'demo')));
const NAME = argOf('name', 'ping-pong-ai-demo');
const W = Number(argOf('w', 1280));
const H = Number(argOf('h', 720));
const FPS = Number(argOf('fps', 30));

// playwright-core 不在本仓依赖里（仓库零依赖）；借用桌面「太空杀」工程已装的副本
const PW_CANDIDATES = [
  'C:/Users/ASUS/Desktop/太空杀游戏-完整版/node_modules/playwright-core',
  'playwright-core',
];
function loadPW() {
  for (const c of PW_CANDIDATES) {
    try { return require(c); } catch (e) { /* 试下一个 */ }
  }
  throw new Error('找不到 playwright-core（试过：' + PW_CANDIDATES.join(' / ') + '）');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.wav': 'audio/wav', '.svg': 'image/svg+xml',
};
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

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error'].concat(args), { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg 失败：' + (r.stderr || '').slice(0, 400));
  return r;
}

(async () => {
  const { chromium } = loadPW();
  const exe = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => fs.existsSync(p));
  if (!exe) throw new Error('未找到 Chrome / Edge');

  const framesDir = path.join(os.tmpdir(), 'pp-demo-frames');
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(OUTDIR, { recursive: true });

  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const br = await chromium.launch({
    executablePath: exe,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--hide-scrollbars'],
  });
  const ctx = await br.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

  // 初始偏好：高画质、开观众席（赛场氛围）、不弹首访气泡、不画判定虚线
  await pg.addInitScript(() => {
    try {
      localStorage.setItem('ppd_quality', 'high');
      localStorage.setItem('ppd_no_crowd', '0');
      localStorage.setItem('ppd_home_hint_seen', '1');
      localStorage.setItem('ppd_show_hit_ranges', '0');
    } catch (e) { /* ignore */ }
  });

  console.log('打开主页 …');
  await pg.goto(base + '/index.html', { waitUntil: 'load' });
  await pg.waitForTimeout(1600);

  // 成片不需要右上角的调试帧率表（那是给开发看性能的，出现在作品集 demo 里像没做完）
  await pg.addStyleTag({ content: '.fps-meter, .stat-stack { display: none !important; }' });

  // ---------- 开录 ----------
  const cdp = await ctx.newCDPSession(pg);
  const frames = [];
  let seq = 0;
  const t0 = Date.now();
  cdp.on('Page.screencastFrame', async (f) => {
    const t = Date.now() - t0;
    const file = 'f' + String(++seq).padStart(5, '0') + '.jpg';
    fs.writeFileSync(path.join(framesDir, file), Buffer.from(f.data, 'base64'));
    frames.push({ file, t });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch (e) { /* ignore */ }
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  console.log('开始录制 …');

  const wait = (ms) => pg.waitForTimeout(ms);

  // 1) 主页停留（聚光灯 + 待机动作入镜）
  await wait(2600);
  // 2) AI对打 → 观看视角弹层
  await pg.click('#btnAIVsAI');
  await wait(1400);
  // 3) 选「看台视角」（侧视角：边线高位，两名球员一左一右）
  await pg.click('#aiwSide');
  await wait(1400); // 拨开式转场：220ms 黑屏 + 560ms 拨开
  // 4) 侧视角对局
  const gameMs = Math.max(8000, SECONDS * 1000 - 5400);
  await wait(gameMs);

  // 收尾自检：确实在 AI 对打 + 侧视角（否则录出来是主页，白录）
  const st = await pg.evaluate(() => ({
    mode: PPD.app.mode, view: PPD.app.aiView, follow: PPD.app.aiFollowSide,
    score: PPD.app.engine ? PPD.app.engine.score : null,
    phase: PPD.app.engine ? PPD.app.engine.phase : null,
  }));
  await cdp.send('Page.stopScreencast');
  const dur = (Date.now() - t0) / 1000;
  console.log('录制时状态：' + JSON.stringify(st));
  console.log('抓帧 ' + frames.length + ' 张 / ' + dur.toFixed(2) + 's → 平均 ' + (frames.length / dur).toFixed(1) + ' fps');

  if (st.mode !== 'aivai' || st.view !== 'side') {
    throw new Error('未进入「AI对打 · 看台视角」，拒绝产出（mode=' + st.mode + ', view=' + st.view + '）');
  }
  if (frames.length < 100) throw new Error('抓帧过少（' + frames.length + '），录制可能失败');

  await br.close();
  srv.close();

  // ---------- 合成：按真实帧间隔写 concat 时长，再转 30fps CFR ----------
  // 用 concat demuxer 的 duration 保留真实时间轴，避免 screencast 变速导致动作忽快忽慢
  const listPath = path.join(framesDir, 'list.txt');
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : frames[i].t + 1000 / FPS;
    const d = Math.max(0.001, (next - frames[i].t) / 1000);
    lines.push("file '" + frames[i].file + "'");
    lines.push('duration ' + d.toFixed(4));
  }
  lines.push("file '" + frames[frames.length - 1].file + "'"); // concat 末尾需重复末帧
  fs.writeFileSync(listPath, lines.join('\n'), 'utf8');

  const mp4 = path.join(OUTDIR, NAME + '.mp4');
  const webm = path.join(OUTDIR, NAME + '.webm');
  console.log('编码 MP4 …');
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vf', 'scale=' + W + ':' + H + ':flags=lanczos,fps=' + FPS,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4,
  ]);
  console.log('编码 WebM …');
  ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vf', 'scale=' + W + ':' + H + ':flags=lanczos,fps=' + FPS,
    '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', '-an', webm,
  ]);

  // ---------- 封面帧：取对局开始后的一帧（第 6s，此时已在侧视角回合中） ----------
  const poster = path.join(OUTDIR, NAME + '.poster.jpg');
  ffmpeg(['-ss', '6', '-i', mp4, '-frames:v', '1', '-q:v', '3', poster]);

  // ---------- 卡片短版：从「进对局之后」开始截到结尾 ----------
  // 作品卡的媒体区只有 ~16:10 一小块，前 5s 的主页/选视角在卡片里看不出「在打球」，
  // 所以另出一条从对局开始起的短版，卡片与合集页用它。
  const cardMp4 = path.join(OUTDIR, NAME + '-card.mp4');
  const cardPoster = path.join(OUTDIR, NAME + '-card.poster.jpg');
  ffmpeg(['-ss', '5.4', '-i', mp4, '-c:v', 'libx264', '-preset', 'slow', '-crf', '22',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', cardMp4]);
  ffmpeg(['-ss', '1.2', '-i', cardMp4, '-frames:v', '1', '-q:v', '3', cardPoster]);

  for (const f of [mp4, webm, poster, cardMp4, cardPoster]) {
    console.log('  ' + f + '  ' + (fs.statSync(f).size / 1024 / 1024).toFixed(2) + ' MB');
  }
  if (errs.length) console.log('页面错误：' + errs.join(' | '));
  console.log('完成 ✓');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
