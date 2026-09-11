/* ============================================================
 * 把源码的 UI 文件同步到桌面应用安装目录（安装目录是仓库的独立副本）。
 * 安全约束：
 *   - 只覆盖 UI 文件，绝不触碰 records.json（真实战绩）、node/（运行时）、edge-profile/
 *   - 覆盖前把安装版原文件备份到 ui-backup-<时间戳>/
 *   - 逐个校验：字节数一致 + 关键标记存在
 * 安装目录解析顺序：环境变量 PP_INSTALL_DIR → %LOCALAPPDATA%\PingPongDuel
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

// 源码根目录：本脚本位于 <repo>/tools/，上一级即仓库根
const SRC = path.join(__dirname, '..');
// 桌面应用安装目录（可用 PP_INSTALL_DIR 覆盖）
const INST = process.env.PP_INSTALL_DIR
  || path.join(process.env.LOCALAPPDATA || process.env.HOME || '.', 'PingPongDuel');
const FILES = [
  'public/index.html',
  'public/css/style.css',
  'public/js/app/records.js',
  'public/js/app/main.js',
  'public/js/app/state.js',
  'public/js/app/training.js',
  'public/js/app/dressup.js',
];

// 每个文件同步后必须存在的关键标记，用于确认写入的是新版内容
const MARKERS = {
  'public/index.html': ['btn-group', 'btn-group-primary', 'group-divider', 'menu-nick', 'setup-group', 'btn-ico',
    'btnPrimaryAction', 'recentMatch', 'btnSetupToggle', 'dashTrend', 'dashGuide', 'dashEntry',
    'shell-card', 'shell-head', 'shell-body', 'shell-foot', 'points-capsule', 'segmented-host'],
  'public/css/style.css': ['--ui-accent', '.stat-ring', '.btn-group-primary', '.group-divider',
    '--primary-100', '--primary-40', '--primary-15', '--accent', '.btn-primary-action', '.recent-match',
    '.shell-card', '.shell-head', '.shell-foot', '.points-capsule', '.segmented', '.state-max',
    '.sticky-group', '.lv-dot', '.t-item', '.item-preview', '.setting-row', '.dash-cell'],
  'public/js/app/records.js': ['statBarsHtml', 'statTrendHtml', 'trendCellHtml', 'guideCellHtml',
    'renderRecentMatch', 'paintDashboard', 'btnRecentReplay'],
  'public/js/app/main.js': ['setBtnAIText', '.btn-main', 'refreshPrimaryAction', 'refreshSetupSummary',
    'syncRangeFill', 'buildSegmented', '快速开始'],
  'public/js/app/state.js': ['btnPrimaryAction', 'recentMatch', 'btnSetupToggle', 'setupGroup', 'btnRecentReplay'],
  'public/js/app/training.js': ['rollDownPoints', 'points-capsule', 'lv-dot', 'state-max'],
  'public/js/app/dressup.js': ['previewHtml', 'item-preview', 'state-active', 'state-owned', 'sticky-group'],
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = path.join(INST, 'ui-backup-' + stamp);

// 0) 运行中检查：8765 被占用则拒绝同步
const net = require('net');
function portBusy(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', (e) => res(e.code === 'EADDRINUSE'));
    s.once('listening', () => s.close(() => res(false)));
    s.listen(port, '127.0.0.1');
  });
}

(async () => {
  if (await portBusy(8765)) {
    console.log('中止：桌面应用正在运行（8765 被占用），请先关闭游戏窗口再同步。');
    process.exit(1);
  }
  console.log('检查通过：应用未运行\n');

  fs.mkdirSync(backupDir, { recursive: true });
  console.log('备份目录:', backupDir, '\n');

  let fail = 0;
  for (const f of FILES) {
    const sp = path.join(SRC, f);
    const ip = path.join(INST, f);
    if (!fs.existsSync(sp)) { console.log('MISS 源文件不存在:', f); fail++; continue; }

    // 1) 备份安装版原文件
    if (fs.existsSync(ip)) {
      const bp = path.join(backupDir, f);
      fs.mkdirSync(path.dirname(bp), { recursive: true });
      fs.copyFileSync(ip, bp);
    }

    // 2) 覆盖
    fs.mkdirSync(path.dirname(ip), { recursive: true });
    fs.copyFileSync(sp, ip);

    // 3) 校验：字节一致 + 关键标记
    const sb = fs.readFileSync(sp);
    const ib = fs.readFileSync(ip);
    const bytesOk = sb.equals(ib);
    const text = ib.toString('utf8');
    const missing = (MARKERS[f] || []).filter((m) => !text.includes(m));
    const ok = bytesOk && missing.length === 0;
    if (!ok) fail++;
    console.log(
      (ok ? 'OK   ' : 'FAIL '),
      f.padEnd(28),
      ib.length + 'b',
      bytesOk ? '字节一致' : '字节不一致!',
      missing.length ? '缺少标记: ' + missing.join(',') : ''
    );
  }

  console.log('\n=== 保护性检查（必须原样保留） ===');
  const rp = path.join(INST, 'records.json');
  if (fs.existsSync(rp)) {
    const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
    const wins = r.filter((x) => x && x.winner === 0).length;
    console.log('records.json 记录数:', r.length, '| 胜:', wins, '| 未被改动（本次未写入该文件）');
  }
  console.log('node/ 运行时存在:', fs.existsSync(path.join(INST, 'node', 'node.exe')));
  console.log('edge-profile/ 存在:', fs.existsSync(path.join(INST, 'edge-profile')));

  console.log('\n结果:', fail === 0 ? '全部 ' + FILES.length + ' 个文件同步成功' : fail + ' 个文件同步失败');
  process.exit(fail ? 1 : 0);
})();
