/* ============================================================
 * set-version.js — 版本号单一来源同步（审计 #15 根治）
 *
 * 唯一真源：package.json 的 version（安卓 versionCode 用同文件 androidVersionCode 字段）。
 * 背景：版本号此前 4+ 处手工维护，屡次漂移造成实际故障——
 *   _headers 引用 v270 而实际 APK 是 v273（attachment/no-store 失效）、
 *   download.html 页脚残留 1.7.1 等。本脚本把所有副本收归一处生成/校验。
 *
 * 同步目标与规则：
 *   android/AndroidManifest.xml   android:versionCode / versionName
 *   android/build.cmd             --version-code / --version-name
 *   public/js/app/state.js        应用版本常量（值恰为版本串的字符串字面量）
 *   public/download.html          APK 文件名 / 顶部版本 / 页脚"版本 X"/ 期望字节数（自动读 APK 实际大小）
 *   public/_headers               APK 规则路径与 filename
 *   public/sw.js                  缓存名 ppd-vXXX（绑定版本，旧缓存自动清理）
 *
 * 用法：
 *   node tools/set-version.js --check    校验各处版本一致（接入 npm run test:ver / CI）
 *   node tools/set-version.js 2.7.4 23   升版本：bump package.json 并同步全部目标
 *   node tools/set-version.js --sync     不改版本号，按 package.json 重写全部目标（修复漂移）
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const MODE = process.argv[2] || '--check';

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
let ver = pkg.version;
let code = pkg.androidVersionCode;

// 版本紧凑串：2.7.3 → 273（APK 文件名 / SW 缓存名用）
const shortOf = (v) => v.split('.').join('');

// 各目标文件的定义：(相对路径, 替换函数数组 / 校验函数数组)
// 替换函数：内容+环境 → 新内容；校验函数：内容+环境 → { ok, actual }
function targets(ver, code, short) {
  return [
    {
      file: 'android/AndroidManifest.xml',
      fixes: [
        [(/android:versionCode="\d+"/g), () => `android:versionCode="${code}"`],
        [(/android:versionName="[^"]*"/g), () => `android:versionName="${ver}"`],
      ],
      checks: [
        (c) => ({ ok: new RegExp(`android:versionName="${ver}"`).test(c), actual: (c.match(/android:versionName="([^"]*)"/) || [])[1], expect: ver }),
        (c) => ({ ok: new RegExp(`android:versionCode="${code}"`).test(c), actual: (c.match(/android:versionCode="(\d+)"/) || [])[1], expect: String(code) }),
      ],
    },
    {
      file: 'android/build.cmd',
      fixes: [
        [(/--version-code \d+/g), () => `--version-code ${code}`],
        [(/--version-name [\d.]+/g), () => `--version-name ${ver}`],
      ],
      checks: [
        (c) => ({ ok: c.includes(`--version-name ${ver}`), actual: (c.match(/--version-name ([\d.]+)/) || [])[1], expect: ver }),
        (c) => ({ ok: c.includes(`--version-code ${code}`), actual: (c.match(/--version-code (\d+)/) || [])[1], expect: String(code) }),
      ],
    },
    {
      file: 'public/js/app/state.js',
      // 只替换值恰为**旧版本串**的字符串字面量（如 VERSION = '2.7.3'），
      // 不碰其他恰好形如 x.y.z 的数值；同时把过旧/过新的版本字面量统一拉齐
      fixes: [
        [(/(['"])\d+\.\d+\.\d+\1/g), (m, q, _c) => {
          const v = m.slice(1, -1);
          return /^\d+\.\d+\.\d+$/.test(v) ? `${q}${ver}${q}` : m;
        }],
      ],
      checks: [
        (c) => {
          const found = [...c.matchAll(/(['"])(\d+\.\d+\.\d+)\1/g)].map((m) => m[2]);
          const uniq = [...new Set(found)];
          return { ok: uniq.length === 1 && uniq[0] === ver, actual: uniq.join(',') || '(无版本串)', expect: ver };
        },
      ],
    },
    {
      file: 'public/download.html',
      fixes: [
        [(/PingPongDuel-v\d+\.apk/g), () => `PingPongDuel-v${short}.apk`],
        [(/v\d+\.\d+\.\d+/g), () => `v${ver}`],
        [(/版本 [\d.]+/g), () => `版本 ${ver}`],
        // 期望字节数：从实际 APK 读取（不存在则保留并警告，build 后重跑 --sync）
        [(/var EXPECTED = \d+/g), (_m, _c, env) => `var EXPECTED = ${env.apkSize != null ? env.apkSize : _m.slice('var EXPECTED = '.length)}`],
        [(/\d{1,3}(?:,\d{3})+ 字节/g), (_m, _c, env) => env.apkSize != null ? `${env.apkSize.toLocaleString()} 字节` : _m],
        [(/\d+\.\d+ MB/g), (_m, _c, env) => env.apkSize != null ? `${(env.apkSize / 1048576).toFixed(2)} MB` : _m],
      ],
      checks: [
        (c) => ({ ok: c.includes(`PingPongDuel-v${short}.apk`), actual: (c.match(/PingPongDuel-v(\d+)\.apk/) || [])[1], expect: short }),
        (c) => ({ ok: c.includes(`版本 ${ver}`), actual: (c.match(/版本 ([\d.]+)/) || [])[1], expect: ver }),
      ],
    },
    {
      file: 'public/_headers',
      fixes: [[(/PingPongDuel-v\d+\.apk/g), () => `PingPongDuel-v${short}.apk`]],
      checks: [
        (c) => ({ ok: c.includes(`PingPongDuel-v${short}.apk`), actual: (c.match(/PingPongDuel-v(\d+)\.apk/) || [])[1] || '(无 APK 规则)', expect: short }),
      ],
    },
    {
      file: 'public/sw.js',
      fixes: [[(/const CACHE = 'ppd-v[\d.]+';/), () => `const CACHE = 'ppd-v${short}';`]],
      checks: [
        (c) => ({ ok: c.includes(`const CACHE = 'ppd-v${short}';`), actual: (c.match(/const CACHE = 'ppd-v([\d.]+)'/) || [])[1], expect: 'ppd-v' + short }),
      ],
    },
  ];
}

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, c) { fs.writeFileSync(p, c, 'utf8'); }

// APK 实际大小（download.html 期望字节数的依据）
function apkSize(short) {
  const p = path.join(ROOT, 'public', `PingPongDuel-v${short}.apk`);
  try { return fs.statSync(p).size; } catch (e) { return null; }
}

let failed = 0;
const env = { apkSize: apkSize(shortOf(ver)) };
if (env.apkSize == null && MODE !== '--check') {
  console.log(`⚠ 未找到 public/PingPongDuel-v${shortOf(ver)}.apk，download.html 字节数保持原值（构建 APK 后重跑 --sync）`);
}

for (const t of targets(ver, code, shortOf(ver))) {
  const p = path.join(ROOT, t.file);
  if (!fs.existsSync(p)) { console.log(`MISS ${t.file}`); failed++; continue; }
  const c = read(p);
  if (MODE === '--check') {
    for (const chk of t.checks) {
      const r = chk(c, env);
      console.log(`${r.ok ? 'OK    ' : 'DRIFT '} ${t.file}  → ${r.actual} (期望 ${r.expect})`);
      if (!r.ok) failed++;
    }
  } else {
    // 升版本 / 修复漂移：先 --check 发现的漂移直接由正则全量重写
    let n = c;
    for (const [re, fn] of t.fixes) n = n.replace(re, (m, g1, _o, _s) => fn(m, g1, n, env));
    if (n !== c) { write(p, n); console.log(`FIXED ${t.file}`); }
    else console.log(`SAME  ${t.file}`);
  }
}

// --check 的汇总
if (MODE === '--check') {
  console.log(failed === 0
    ? `\n版本一致 ✓（真源 package.json ${ver} / code ${code}）`
    : `\n${failed} 处版本漂移 ✗ —— 运行 node tools/set-version.js --sync 修复`);
} else if (MODE === '--sync' || /^\d+\.\d+\.\d+$/.test(MODE)) {
  if (/^\d+\.\d+\.\d+$/.test(MODE)) {
    // bump：更新真源
    const newVer = MODE;
    const newCode = process.argv[3] ? Number(process.argv[3]) : code;
    pkg.version = newVer;
    pkg.androidVersionCode = newCode;
    write(PKG, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`BUMP  package.json → ${newVer} (code ${newCode})`);
  }
  console.log('\n同步完成。建议再跑 --check 复核；若 APK 已重建请同步更新 public/ 下的 APK 文件名。');
} else {
  console.log('用法: node tools/set-version.js --check | --sync | <新版本> [versionCode]');
  process.exitCode = 1;
}
if (failed > 0 && MODE === '--check') process.exitCode = 1;
