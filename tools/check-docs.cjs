#!/usr/bin/env node
/* 文档死链检查器（三仓通用）
 * 用法：node tools/check-docs.cjs [仓库根]
 * 判定：Markdown 相对链接 / 图片指向的文件必须存在；缺失即 exit 1。
 * 忽略：http(s)/mailto、纯锚点、代码块与行内代码内的内容（后者常含 [x](y) 形式的示例）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', 'android', 'attachment-site', 'projects', 'public', 'src', '.tmp_shots', '.tmp_pp', '_retired', 'bin', 'obj']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.name.toLowerCase().endsWith('.md')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* 抹掉围栏代码块与行内代码，保留换行以维持行号 */
function mask(src) {
  return src
    .replace(/^```[\s\S]*?^```/gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

const LINK_RE = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;

const files = walk(ROOT, []);
const broken = [];
let checked = 0;

for (const file of files) {
  const src = mask(fs.readFileSync(file, 'utf8'));
  const base = path.dirname(file);
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(src))) {
    let target = m[3].trim();
    if (!target) continue;
    if (/^(https?:|mailto:|tel:|data:|javascript:)/i.test(target)) continue;
    if (target.startsWith('#')) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    let decoded = target;
    try { decoded = decodeURIComponent(target); } catch (_) { /* 保持原样 */ }
    checked++;
    if (!fs.existsSync(path.resolve(base, decoded))) {
      const line = src.slice(0, m.index).split('\n').length;
      broken.push({ file: rel(file), line, target });
    }
  }
}

console.log(`仓库：${ROOT}`);
console.log(`扫描 ${files.length} 个 .md，检查 ${checked} 条相对链接`);

if (!broken.length) {
  console.log('✓ 无死链');
  process.exit(0);
}

const byFile = new Map();
for (const b of broken) {
  if (!byFile.has(b.file)) byFile.set(b.file, []);
  byFile.get(b.file).push(b);
}

console.log(`✗ 死链 ${broken.length} 条，分布在 ${byFile.size} 个文件：\n`);
for (const [f, list] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${f}  (${list.length})`);
  for (const b of list.slice(0, 10)) console.log(`    L${b.line}  ${b.target}`);
  if (list.length > 10) console.log(`    … 另 ${list.length - 10} 条`);
}
process.exit(1);
