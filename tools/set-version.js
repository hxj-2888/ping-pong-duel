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
      // 不再同步字节数与 SHA 指纹：APK 由 CI 每次推送重建，同一份源码两次构建的产物
      // 字节数就会变（JDK/d8 版本、签名时间戳、压缩差异），写死的数值在 push 之后
      // 立刻失真，反而误导排障。页面改为运行时向服务器读实际大小（apkSize /
      // apkSizeLi 两个占位由 fetch HEAD 填充），并在点击下载时把整包长度与该值比对，
      // 截断即当场报错。`var EXPECTED` 早已被这套 HEAD 校验取代，是死代码。
      fixes: [
        [(/PingPongDuel-v\d+\.apk/g), () => `PingPongDuel-v${short}.apk`],
        [(/v\d+\.\d+\.\d+/g), () => `v${ver}`],
        [(/版本 [\d.]+/g), () => `版本 ${ver}`],
      ],
      checks: [
        (c) => ({ ok: c.includes(`PingPongDuel-v${short}.apk`), actual: (c.match(/PingPongDuel-v(\d+)\.apk/) || [])[1], expect: short }),
        (c) => ({ ok: c.includes(`版本 ${ver}`), actual: (c.match(/版本 ([\d.]+)/) || [])[1], expect: ver }),
        // 不得残留写死的包大小/指纹：运行时校验已取代，写死必然随 CI 重建而失真
        (c) => {
          const stale = [...c.matchAll(/(?:\d{1,3}(?:,\d{3})+\s*字节|SHA-256\s*[0-9A-F]{8})/g)].map((m) => m[0]);
          return { ok: stale.length === 0, actual: stale.length ? stale.join(' / ') : '无写死数值', expect: '无写死数值' };
        },
      ],
    },
    {
      file: 'public/index.html',
      // 主菜单里的「下载安卓版」按钮（main.js 在触屏且非 file:// 时显示它）。
      // 这个文件名此前手工写成 v300 就再没动过：按钮照常显示，链接却指向早已不存在的
      // 文件 —— 请求落到 SPA 回退返回 200 + HTML，用户下到一个改名为 .apk 的网页。
      // 与 download.html / _headers 同一类漂移，必须由本脚本一起收口。
      fixes: [[(/PingPongDuel-v\d+\.apk/g), () => `PingPongDuel-v${short}.apk`]],
      checks: [
        (c) => ({ ok: c.includes(`PingPongDuel-v${short}.apk`), actual: (c.match(/PingPongDuel-v(\d+)\.apk/) || [])[1], expect: short }),
        // 不得残留任何其它版本的 APK 文件名（只允许当前版本一个）
        (c) => {
          const all = [...new Set([...c.matchAll(/PingPongDuel-v(\d+)\.apk/g)].map((m) => m[1]))];
          const stray = all.filter((v) => v !== short);
          return { ok: stray.length === 0, actual: stray.length ? `残留 ${stray.join(',')}` : `仅 ${short}`, expect: `仅 ${short}` };
        },
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

let failed = 0;
// 不再需要 env.apkSize：本脚本不再向 download.html 写死字节数（见该目标上的说明）
const env = {};

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
    // 注意：replace 回调实参 = (match, p1..pn, offset, string)，捕获组数量随正则变化，
    // 不能按固定位置传 env——用 rest 收集，fn(m, g1, content, env) 恒定映射。
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
  console.log('\n同步完成。建议再跑 --check 复核。');
  console.log('注：APK 文件名已随版本同步；包体积/指纹不在此维护 —— APK 由 CI 每次推送重建，');
  console.log('    写死的数值在 push 之后即失真，下载页改为运行时向服务器读取实际大小。');
} else {
  console.log('用法: node tools/set-version.js --check | --sync | <新版本> [versionCode]');
  process.exitCode = 1;
}
if (failed > 0 && MODE === '--check') process.exitCode = 1;
