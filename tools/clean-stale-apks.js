/* ============================================================
 * tools/clean-stale-apks.js — 清理下游副本中的历史 APK（审计 #17）
 * autosync 只复制变更文件、不删除目标多余文件；源头 public/ 删除旧 APK 后,
 * 安装包/桌面副本的 public 仍残留 v150~v171 等 16 个旧 APK（~50MB 随包分发）。
 * 本脚本把各 pub 副本 public/ 下除 PingPongDuel-v172.apk 外的全部 .apk 删除。
 * 用法: node tools/clean-stale-apks.js
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEEP = 'PingPongDuel-v300.apk';

// 与 autosync.js TARGETS 中含 public 的目标一致（android 资产不内嵌 APK,跳过）；
// 本机目录由环境变量推导，源码不含用户名路径
const HOME = process.env.USERPROFILE || '';
const LOCALAPP = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const DESKTOP = path.join(HOME, 'Desktop');
const TARGETS = [
  'dist/installer/package/乒乓对决_安装包/game',
  '%PKG%/game',
  path.join(LOCALAPP, 'PingPongDuel'),
  path.join(LOCALAPP, 'Programs', 'PingPongDuel'),
  path.join(DESKTOP, '乒乓对决'),
  path.join(DESKTOP, '乒乓对决_安装包', 'game'),
];

let removed = 0;
for (const t of TARGETS) {
  const abs = path.isAbsolute(t) ? t : path.join(ROOT, t);
  const pub = path.join(abs, 'public');
  if (!fs.existsSync(pub)) continue;
  for (const f of fs.readdirSync(pub)) {
    if (f.endsWith('.apk') && f !== KEEP) {
      try {
        fs.unlinkSync(path.join(pub, f));
        removed++;
        console.log('删除 ' + path.join(t, 'public', f));
      } catch (e) { /* 只读/占用:跳过 */ }
    }
  }
}
console.log('清理完成,共删除 ' + removed + ' 个旧 APK(各副本保留 ' + KEEP + ')');
