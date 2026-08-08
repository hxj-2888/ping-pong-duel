/* ============================================================
 * tools/autosync.js — 修改即自动同步（源头 = 乒乓对决_合并）
 *
 * 所有开发修改都以本工程为唯一源头；本脚本轮询源文件的
 * mtime/大小，一旦变化自动把新内容同步到全部下游副本：
 *   - android/assets/www（APK 资产镜像）
 *   - dist/installer/.../game、%PKG%/game（安装包源）
 *   - dist/ecs（ECS 部署副本，仅 public+package.json）
 *   - 桌面已安装应用（AppData\Local\PingPongDuel、Programs\PingPongDuel）
 *   - 桌面\乒乓对决、桌面\乒乓对决_安装包\game
 * 各副本的 records.json（战绩）与 android\release.keystore（签名）保留不动。
 *
 * 用法：
 *   node tools/autosync.js         常驻监听（后台运行，推荐）
 *   node tools/autosync.js --once  立即全量同步一次后退出
 * 或双击 tools\自动同步.cmd 启动。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 下游副本（dir 相对 ROOT 或绝对路径）；stripPub=true 的目标其 public/ 前缀剥掉（APK 资产根即 www）
const TARGETS = [
  { dir: 'android/assets/www', pub: true, stripPub: true },                      // APK 资产：public/X → www/X
  { dir: 'dist/installer/package/乒乓对决_安装包/game', pub: true, root: true, extra: true, android: true },
  { dir: '%PKG%/game', pub: true, root: true, extra: true, android: true },
  { dir: 'dist/ecs', pub: true, ecs: true },                                     // ECS：仅 public + package.json
  { dir: 'C:/Users/ASUS/AppData/Local/PingPongDuel', pub: true, root: true, extra: true, android: true },
  { dir: 'C:/Users/ASUS/AppData/Local/Programs/PingPongDuel', pub: true, root: true, extra: true },
  { dir: 'C:/Users/ASUS/Desktop/乒乓对决', pub: true, root: true, extra: true, android: true },
  { dir: 'C:/Users/ASUS/Desktop/乒乓对决_安装包/game', pub: true, root: true, extra: true, android: true },
];

const ROOT_FILES = ['server.js', 'desktop-launcher.js', 'package.json', 'icon.ico', '使用说明.txt', '修改记录.md', '合并说明.md', '启动乒乓对决.vbs', 'wrangler.toml', 'wrangler.room.toml', 'README.md'];
const EXTRA_DIRS = ['src', 'test'];
const TOOL_FILES = ['tools/局域网放行.cmd'];
const ANDROID_FILES = ['android/AndroidManifest.xml', 'android/build.cmd', 'android/PingPongDuel.apk'];
const PUB_EXCLUDE = new Set(['records.json', 'app.log']);

function walk(dir, out, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (rel === '' && PUB_EXCLUDE.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), out, r);
    else out.push(r);
  }
}
function statOf(p) {
  try { const st = fs.statSync(p); return { m: st.mtimeMs, s: st.size }; } catch (e) { return null; }
}
let snap = new Map(); // 源文件 -> {m,s}
function buildSnap() {
  const m = new Map();
  const pub = [];
  walk(path.join(ROOT, 'public'), pub, '');
  for (const f of pub) m.set('public/' + f, statOf(path.join(ROOT, 'public', f)));
  for (const f of ROOT_FILES) if (fs.existsSync(path.join(ROOT, f))) m.set(f, statOf(path.join(ROOT, f)));
  for (const d of EXTRA_DIRS) {
    const files = [];
    walk(path.join(ROOT, d), files, '');
    for (const f of files) m.set(d + '/' + f, statOf(path.join(ROOT, d, f)));
  }
  for (const f of TOOL_FILES) if (fs.existsSync(path.join(ROOT, f))) m.set(f, statOf(path.join(ROOT, f)));
  for (const f of ANDROID_FILES) if (fs.existsSync(path.join(ROOT, f))) m.set(f, statOf(path.join(ROOT, f)));
  return m;
}
function changed(srcSnap) {
  const out = [];
  for (const [f, st] of srcSnap) {
    const prev = snap.get(f);
    if (!prev || prev.m !== st.m || prev.s !== st.s) out.push(f);
  }
  return out;
}
function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function syncOnce() {
  const srcSnap = buildSnap();
  const ch = changed(srcSnap);
  let n = 0;
  for (const t of TARGETS) {
    const abs = path.isAbsolute(t.dir) ? t.dir : path.join(ROOT, t.dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of ch) {
      const src = path.join(ROOT, f);
      if (!fs.existsSync(src)) continue;
      if (t.ecs && !(f.startsWith('public/') || f === 'package.json')) continue;   // ECS 仅 public+package
      if (f.startsWith('android/') && !t.android) continue;                          // android 专属仅含 android 的目标
      if (!t.root && !f.startsWith('public/')) continue;                             // 非 root 目标仅 public
      // 目标路径映射：stripPub 目标（APK 资产）剥掉 public/ 前缀
      const dstF = (t.stripPub && f.startsWith('public/')) ? f.slice('public/'.length) : f;
      try { copyFile(src, path.join(abs, dstF)); n++; } catch (e) { /* 目标只读/锁定：跳过 */ }
    }
  }
  snap = srcSnap;
  if (n) console.log('[' + new Date().toLocaleTimeString() + '] 自动同步 ' + ch.length + ' 个变更文件 → ' + n + ' 处副本');
  return n;
}
if (process.argv.includes('--once')) { syncOnce(); console.log('一次性同步完成'); process.exit(0); }
syncOnce();
console.log('自动同步监听中（源头=' + ROOT + '，每 1.5s 轮询；Ctrl+C 停止）...');
setInterval(syncOnce, 1500);
