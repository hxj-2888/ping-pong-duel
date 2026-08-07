/* ============================================================
 * check-engine-sync.js — 引擎镜像一致性校验
 * 乒乓对决的物理引擎有双份部署：public/js/engine.js + public/js/engine/
 * （浏览器/本地服务器用，UMD）与 src/engine.js + src/engine/（Cloudflare DO 用，ESM）。
 * 协议一致性要求两侧字节完全一致——任何一侧被改而另一侧没改，联机双方行为就会漂移。
 * 本脚本逐字节对比全部引擎文件，不一致时逐文件列出并 exit 1（接入 npm test:all 做回归守护）。
 * 用法：node tools/check-engine-sync.js
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAIRS = [
  ['public/js/engine.js', 'src/engine.js'],
  ['public/js/engine/rules.js', 'src/engine/rules.js'],
  ['public/js/engine/math.js', 'src/engine/math.js'],
  ['public/js/engine/state.js', 'src/engine/state.js'],
  ['public/js/engine/physics.js', 'src/engine/physics.js'],
  ['public/js/engine/shots.js', 'src/engine/shots.js'],
  ['public/js/engine/strokes.js', 'src/engine/strokes.js'],
];

let failed = 0;
for (const [p, s] of PAIRS) {
  const pa = path.join(ROOT, p);
  const sa = path.join(ROOT, s);
  if (!fs.existsSync(pa) || !fs.existsSync(sa)) {
    console.log(`MISS ${p} / ${s}`);
    failed++;
    continue;
  }
  const same = fs.readFileSync(pa).equals(fs.readFileSync(sa));
  console.log(`${same ? 'OK  ' : 'DIFF'} ${p}  vs  ${s}`);
  if (!same) failed++;
}

if (failed === 0) {
  console.log(`\n引擎镜像一致 ✓（${PAIRS.length} 对文件字节级相同）`);
  process.exitCode = 0;
} else {
  console.log(`\n${failed} 对文件不一致 ✗ —— 请同步 public/js/engine 与 src/engine（联机协议会漂移！）`);
  process.exitCode = 1;
}
