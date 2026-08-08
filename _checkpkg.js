const fs = require('fs');
const ROOT = 'C:/Users/ASUS/Desktop/乒乓对决_合并';
const dirs = [
  { n: 'dist/installer/.../game', p: ROOT + '/dist/installer/package/乒乓对决_安装包/game' },
  { n: '%PKG%/game', p: ROOT + '/%PKG%/game' },
  { n: '桌面/乒乓对决_安装包/game', p: 'C:/Users/ASUS/Desktop/乒乓对决_安装包/game' },
  { n: '桌面/乒乓对决_安装包(顶层)', p: 'C:/Users/ASUS/Desktop/乒乓对决_安装包' },
];
const check = (p) => {
  let ver = '?', marks = {};
  try { ver = JSON.parse(fs.readFileSync(p + '/package.json', 'utf8')).version; } catch (e) {}
  try {
    const idx = fs.readFileSync(p + '/public/index.html', 'utf8');
    marks.btnNetEntry = idx.includes('btnNetEntry');
    marks.btnManualMenu = idx.includes('btnManualMenu');
    marks.btnManualTouch = !idx.includes('btnManualTouch'); // 应为 true（已移除）
  } catch (e) { marks = { err: true }; }
  try {
    const css = fs.readFileSync(p + '/public/css/style.css', 'utf8');
    marks.hint124 = css.includes('top: 124px');
  } catch (e) {}
  try {
    const ai = fs.readFileSync(p + '/public/js/ai.js', 'utf8');
    marks.人机不动 = ai.includes('t.hellCatchMul == null');
  } catch (e) {}
  return { ver, marks };
};
for (const d of dirs) {
  if (!fs.existsSync(d.p)) { console.log('SKIP (missing):', d.n); continue; }
  console.log('====', d.n);
  console.log('  ', JSON.stringify(check(d.p)));
}
// 安装包文件夹结构（是否有安装脚本/exe）
console.log('== 桌面/乒乓对决_安装包 顶层 ==');
try { console.log(fs.readdirSync('C:/Users/ASUS/Desktop/乒乓对决_安装包').join(', ')); } catch (e) {}
// 桌面 ZIP
console.log('== 桌面 ZIP ==');
try {
  for (const f of fs.readdirSync('C:/Users/ASUS/Desktop')) {
    if (/乒乓对决.*\.zip/i.test(f)) {
      const st = fs.statSync('C:/Users/ASUS/Desktop/' + f);
      console.log(f, '| size:', st.size, '| mtime:', st.mtime.toLocaleString());
    }
  }
} catch (e) {}
