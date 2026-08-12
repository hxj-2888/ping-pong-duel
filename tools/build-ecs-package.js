/* ============================================================
 * tools/build-ecs-package.js — 生成 ECS 部署包 dist/ecs（等价 打包部署ECS.cmd,
 * 但避免 cmd 中文编码问题;只含当前版本内容,不残留历史 APK）
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'ecs');
const PUB = path.join(OUT, 'public');

// 1. 删除旧包(可能残留历史 APK)
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(PUB, { recursive: true });

// 2. 复制根文件
for (const f of ['server.js', 'package.json']) {
  fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
}
for (const [src, dst] of [
  ['tools/部署到ECS.sh', '部署到ECS.sh'],
  ['tools/部署到ECS.txt', '部署说明.txt'],
]) {
  fs.copyFileSync(path.join(ROOT, src), path.join(OUT, dst));
}

// 3. 全量复制 public(仅当前版本文件,旧 APK 已不在源头)
function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (rel === '' && (e.name === 'records.json' || e.name === 'app.log')) continue;
    const s = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      fs.mkdirSync(path.join(PUB, r), { recursive: true });
      walk(s, r);
    } else {
      fs.copyFileSync(s, path.join(PUB, r));
    }
  }
}
walk(path.join(ROOT, 'public'), '');

// 4. 报告
const apks = fs.readdirSync(PUB).filter((f) => f.endsWith('.apk'));
const files = [];
(function cnt(d, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) cnt(path.join(d, e.name), rel + '/' + e.name);
    else files.push(rel + '/' + e.name);
  }
})(OUT, 'dist/ecs');
console.log('ECS 部署包已生成: dist/ecs');
console.log('public APK: ' + (apks.join(', ') || '(无)'));
console.log('总文件数: ' + files.length);
