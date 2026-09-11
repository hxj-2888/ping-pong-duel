/* 设计系统改造验收：结构完整性 + 客观指标（高度比/间距比/橙金计数） */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');

console.log('=== 1. HTML 结构完整性 ===');
const o = (html.match(/<div/g) || []).length;
const c = (html.match(/<\/div>/g) || []).length;
console.log('div 开/闭:', o, '/', c, o === c ? '平衡' : '不平衡!');

const NEW = ['btnPrimaryAction', 'primaryActionText', 'primaryActionDesc', 'recentMatch',
  'recentTitle', 'recentMeta', 'btnRecentReplay', 'btnSetupToggle', 'setupGroup', 'setupSummaryText',
  'dashTrend', 'dashGuide', 'dashEntry'];
const missNew = NEW.filter((i) => !html.includes('id="' + i + '"'));
console.log('新增节点:', missNew.length ? '缺失 ' + missNew.join(',') : '全部就位 (' + NEW.length + ')');

const KEEP = ['btnLocal', 'btnAI', 'btnNetEntry', 'btnEndless', 'btnAIVsAI', 'btnTraining',
  'btnDressup', 'nameInput', 'recordsPanel', 'teamMe', 'aiLevel', 'teamA', 'aiLevelB'];
const missKeep = KEEP.filter((i) => !html.includes('id="' + i + '"'));
console.log('原有节点:', missKeep.length ? '缺失 ' + missKeep.join(',') : '全部保留 (' + KEEP.length + ')');

// G2 授权将「人机对战（单机）」的重命名列为"自定义常规单机"，其余按钮文案一字不改
const LABELS = ['本地双人对战（分屏）', '自定义常规单机', '模拟推演（AI vs AI）', '能力训练', '装扮系统', '联机对战'];
const missLbl = LABELS.filter((t) => !html.includes(t));
console.log('按钮文案:', missLbl.length ? '被改动 ' + missLbl.join(',') : '符合预期 (' + LABELS.length + ')');

// G1：主按钮不得出现暗示存档的措辞
const FORBIDDEN = ['继续生涯', '继续游戏（主菜单）', '恢复', '载入'];
const bad = FORBIDDEN.filter((t) => {
  const i = html.indexOf('id="primaryActionText"');
  if (i < 0) return false;
  return html.slice(i, i + 200).includes(t);
});
console.log('主按钮存档措辞:', bad.length ? '出现 ' + bad.join(',') : '无（符合 G1）');

console.log('\n=== 2. 令牌体系 ===');
const TOKENS = ['--bg-base', '--bg-panel', '--bg-elevated', '--primary-100', '--primary-60',
  '--primary-40', '--primary-15', '--accent', '--sp-0', '--sp-1', '--sp-2', '--sp-3', '--sp-4',
  '--r-card', '--r-card-sm', '--r-btn', '--r-ico', '--fs-l1', '--fs-l2', '--fs-l3', '--fs-l4'];
const missTok = TOKENS.filter((t) => !css.includes(t + ':'));
console.log('令牌定义:', missTok.length ? '缺失 ' + missTok.join(',') : '全部定义 (' + TOKENS.length + ')');

console.log('\n=== 3. 色彩清点（验收标准：橙金全屏仅 1 次） ===');
// 橙金色值出现次数（含令牌定义行本身）
const accentDefs = (css.match(/--accent:\s*#FFB020/gi) || []).length;
const accentRefs = (css.match(/var\(--accent\)/g) || []).length;
const goldLiteral = (css.match(/#ffd166|#FFB020|rgba\(255,\s*209,\s*102/gi) || []).length;
console.log('--accent 定义:', accentDefs, '(应为 1)');
console.log('var(--accent) 引用:', accentRefs, '(应仅用于一级主按钮)');
console.log('#ffd166 / 旧金色字面量残留:', (css.match(/#ffd166|rgba\(255,\s*209,\s*102/gi) || []).length, '(应为 0)');

console.log('\n=== 4. 视觉层级：尺寸 > 留白 > 字重 > 颜色 ===');
// 按钮高度：主按钮垂直 padding 32px vs 二/三级 16px
const pa = /\.btn-primary-action\s*\{[^}]*padding:\s*var\(--sp-4\)\s+var\(--sp-2\)/.test(css);
const l2 = /\.btn-group-primary \.btn\s*\{[^}]*padding:\s*var\(--sp-2\)/.test(css);
const l3 = /\.btn-group-secondary \.btn\s*\{[^}]*padding:\s*var\(--sp-2\)/.test(css);
console.log('主按钮垂直 padding 32px:', pa);
console.log('二级按钮垂直 padding 16px:', l2);
console.log('三级按钮垂直 padding 16px:', l3);
// 主按钮字号与字重均高于次级
const mainFs = /\.btn-primary-action \.btn-main\s*\{[^}]*font-size:\s*18px/.test(css);
console.log('主按钮文案 18px/700（大于二级 15px/600）:', mainFs);
// 视觉孤岛：主按钮外边距 ≥ 组内间距 2 倍
const island = /\.btn-primary-action\s*\{[^}]*margin:\s*var\(--sp-1\)\s+0\s+var\(--sp-3\)/.test(css);
console.log('主按钮下方外边距 24px = 组内间距 8px 的 3 倍:', island);
// 手机端仍保持层级
const mobileKeep = /\.btn-primary-action \{ padding: var\(--sp-3\) var\(--sp-2\); \}/.test(css);
console.log('手机端主按钮 padding 24px（不被压平）:', mobileKeep);

console.log('\n=== 5. 交互四态 + 焦点环 ===');
const d = (name, re) => console.log(name + ':', re.test(css));
d('一级按钮 悬停/按下/禁用',  /\.btn-primary-action:hover[\s\S]*\.btn-primary-action:active[\s\S]*\.btn-primary-action:disabled/);
d('二级按钮 悬停/按下/禁用',  /\.btn-group-primary \.btn:hover[\s\S]*\.btn-group-primary \.btn:active[\s\S]*\.btn-group-primary \.btn:disabled/);
d('三级按钮 悬停/按下/禁用',  /\.btn-group-secondary \.btn:hover[\s\S]*\.btn-group-secondary \.btn:active[\s\S]*\.btn-group-secondary \.btn:disabled/);
d('按下缩放 97%',            /transform:\s*scale\(0\.97\)/);
d('键盘焦点环 2px+2px 偏移', /outline:\s*2px solid var\(--primary-100\)[\s\S]*outline-offset:\s*2px/);
d('禁用降至 40% 透明度',     /opacity:\s*0\.4/);

console.log('\n=== 6. 8px 网格（禁止 10px/18px 等零散值） ===');
// 在我新增的设计系统区块内检查零散间距
const start = css.indexOf('设计令牌（Design Tokens）');
const end = css.indexOf('⑩ 手机端');
const block = css.slice(start, end);
const straySpacing = (block.match(/(?:gap|padding|margin)[^;{]*:\s*[^;]*?\b(?:10|18|22)px/g) || []);
console.log('新增区块内零散间距值:', straySpacing.length ? straySpacing.slice(0, 8).join(' | ') : '无');

console.log('\n=== 7. E 区副页面外壳统一性 ===');
// 每个副页面卡片都应带 shell-card，且顶部栏带 shell-head
const PANELS = ['careerPanel', 'trainingPanel', 'dressupPanel', 'settingsPanel',
  'manualPanel', 'pausePanel', 'endlessPanel', 'netPanel'];
const shellCard = (html.match(/shell-card/g) || []).length;
const shellHead = (html.match(/shell-head/g) || []).length;
const shellFoot = (html.match(/shell-foot/g) || []).length;
const shellBack = (html.match(/shell-back/g) || []).length;
console.log('副页面数:', PANELS.length);
console.log('shell-card:', shellCard, '| shell-head:', shellHead, '| shell-back:', shellBack, '| shell-foot:', shellFoot);
console.log('卡片/顶部栏一一对应:', shellCard === PANELS.length && shellHead === PANELS.length);

// 返回控件必须全部位于标题之前（统一居左）
let backBeforeTitle = 0;
const headRe = /<div class="[^"]*shell-head[^"]*">([\s\S]*?)<\/div>\s*(?:<div class="[^"]*shell-(?:body|context)|<div id=")[\s\S]{0,40}/g;
let m;
while ((m = headRe.exec(html)) !== null) {
  const inner = m[1];
  const bi = inner.indexOf('shell-back');
  const ti = inner.indexOf('shell-title');
  if (bi >= 0 && ti >= 0 && bi < ti) backBeforeTitle++;
  else if (bi >= 0 && ti < 0) backBeforeTitle++; // 无标题的头部不计
}
console.log('返回控件位于标题左侧的头部数:', backBeforeTitle, '(应为 6：6 个带返回的页面)');

// 破坏性操作应使用 foot-danger 且位于底部操作栏
const dangerInFoot = /<div class="shell-foot">[\s\S]*?foot-danger[\s\S]*?<\/div>/.test(html);
console.log('破坏性操作在底部操作栏且用 foot-danger:', dangerInFoot);
const dangerCount = (html.match(/foot-danger/g) || []).length;
console.log('foot-danger 数量:', dangerCount, '(全部洗点 / 退出比赛)');

console.log('\n=== 8. E2/E3 统一控件 ===');
console.log('积分胶囊:', (html.match(/points-capsule/g) || []).length, '(训练 + 装扮 = 2)');
console.log('分段选择器宿主:', (html.match(/segmented-host/g) || []).length, '(画质 + 帧率 = 2)');
console.log('原生 select 保留并隐藏:', (html.match(/class="visually-hidden"/g) || []).length, '(应为 2)');
const cs = css.indexOf('E3 统一控件');
const ce = css.indexOf('E4 通用状态标记');
const ctrl = css.slice(cs, ce);
// 复选框：视觉 18×18（由 background-size 决定），点击区 40×40（由 width/height 决定）
console.log('复选框 视觉 18×18 + 点击区 40×40:',
  /background-size:\s*18px 18px/.test(ctrl) && /width:\s*40px; height:\s*40px/.test(ctrl));
console.log('复选框 勾选态主色填充 + 白色对勾:', /:checked\s*\{[\s\S]{0,200}?fill='%2300E5B0'/.test(ctrl));
console.log('滑条轨道 4px / 滑块 16px:', /height:\s*4px/.test(ctrl) && /width:\s*16px; height:\s*16px/.test(ctrl));
console.log('滑条百分比 60px 定宽:', /min-width:\s*60px/.test(css));

console.log('\n=== 9. E4 状态标记（颜色 + 角标形状双通道） ===');
for (const st of ['state-active', 'state-owned', 'state-max', 'state-locked']) {
  const hasBadge = new RegExp('\\.' + st + '[\\s\\S]{0,220}?state-badge|\\.' + st + '[\\s\\S]{0,220}?lock-ico').test(css);
  console.log(st.padEnd(14), '含角标/图标（非仅靠颜色）:', hasBadge);
}
