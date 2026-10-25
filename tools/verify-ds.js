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

const NEW = ['btnWhistle', 'whistleLabel', 'homeChip', 'plMe', 'plFoe', 'tagMeName', 'tagFoeName',
  'chLocal', 'chNet', 'chEndless', 'homeMask', 'sheetTitle', 'rowNameMe', 'rowNameFoe',
  'rowDiff', 'rowEndless', 'homeEndlessList', 'sheetDone', 'homeHint', 'statusBar',
  'honorsRewardTab', 'btnHonorsReward', 'rotateMask'];
const missNew = NEW.filter((i) => !html.includes('id="' + i + '"'));
console.log('新增节点（场景化主页 P1）:', missNew.length ? '缺失 ' + missNew.join(',') : '全部就位 (' + NEW.length + ')');

const KEEP = ['btnAIVsAI', 'btnTraining', 'btnDressup', 'nameInput', 'teamMe', 'aiLevel',
  'teamA', 'aiLevelB', 'teamMeName', 'teamOppName', 'teamOpp', 'btnDownloadApk', 'btnManualMenu'];
const missKeep = KEEP.filter((i) => !html.includes('id="' + i + '"'));
console.log('原有节点（数据宿主与入口契约）:', missKeep.length ? '缺失 ' + missKeep.join(',') : '全部保留 (' + KEEP.length + ')');

// 难度四档固定为 简单 / 中等 / 困难 / 地狱（第四档不是「大师」）
//地狱未解锁时 option 文字带解锁后缀，故只查档位名前缀
const DIFF4 = ['简单', '中等', '困难', '地狱'];
const missDiff = DIFF4.filter((t) => !html.includes('>' + t));
console.log('难度四档:', missDiff.length ? '缺失 ' + missDiff.join(',') : '齐全 (' + DIFF4.length + ')');
console.log('第四档不是「大师」:', /大师/.test(html) ? '仍出现「大师」文案!' : '无');

// 已删除项不得残留：旧主页结构（P1 场景化主页替换）+ 生涯独立页（P1-b 并入战功页）+ 更早删除项
const GONE = ['自定义常规单机', 'id="btnAI"', 'setupGroup', 'btnSetupToggle', 'setupSummaryText',
  'setup-summary', 'pick-row', 'pick-diff',
  'id="btnPrimaryAction"', 'id="quickSummary"', 'id="simPanel"', 'id="btnAIVsAIStart"',
  'id="btnLocal"', 'id="btnNetEntry"', 'id="btnEndless"', 'id="endlessPanel"',
  'id="recordsPanel"', 'id="dashTrend"', 'id="recentMatch"',
  'id="careerPanel"', 'id="btnCareerBack"', 'id="btnHonorsCareer"'];
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const htmlCode = stripComments(html);
const stillThere = GONE.filter((t) => htmlCode.includes(t) || css.includes(t));
console.log('已删除项残留:', stillThere.length ? '仍存在 ' + stillThere.join(',') : '无残留 (' + GONE.length + ' 项已清)');

const LABELS = ['能力训练', 'AI对打', '战功系统', '本地对战', '联机对战', '无尽挑战', '吹哨开始'];
const missLbl = LABELS.filter((t) => !html.includes(t));
console.log('按钮文案:', missLbl.length ? '被改动 ' + missLbl.join(',') : '符合预期 (' + LABELS.length + ')');

// G1：哨子文案不得出现暗示存档的措辞
const FORBIDDEN = ['继续生涯', '继续游戏（主菜单）', '恢复存档', '载入'];
const whistleIdx = html.indexOf('id="whistleLabel"');
const bad = FORBIDDEN.filter((t) => whistleIdx >= 0 && html.slice(whistleIdx, whistleIdx + 120).includes(t));
console.log('哨子存档措辞:', bad.length ? '出现 ' + bad.join(',') : '无（符合 G1）');

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

console.log('\n=== 4. 视觉层级（场景化主页 P1）：哨子唯一强调，铭牌分层 ===');
// 哨子：整页唯一呼吸元素（青绿描边 + 脉冲），通道选中态用同一强调色
const whistleRing = /\.whistle \.ring\s*\{[^}]*border:\s*2px solid var\(--primary-100\)/.test(css);
console.log('哨子环 青绿描边（唯一强调）:', whistleRing);
console.log('哨子脉冲动画:', /@keyframes whistle-pulse/.test(css));
console.log('通道选中态 .on 青绿点亮:', /\.home-side\.right \.plate\.on\s*\{[^}]*var\(--primary-100\)/.test(css));
console.log('铭牌悬停青绿渐变:', /\.plate:hover\s*\{[^}]*rgba\(0, 229, 176, 0\.22\)/.test(css));
console.log('未解锁通道置灰带锁:', /\.plate\.locked[\s\S]{0,200}content:\s*'🔒'/.test(css));
console.log('名字牌悬停/聚焦青绿描边:', /\.home-tag:hover[\s\S]{0,200}border-color:\s*var\(--primary-100\)/.test(css));
console.log('哨子文案 ✎ 角标常驻:', /tag-edit/.test(html) && /\.tag-edit/.test(css));
// 主容器透出画布：不透明背景被掀掉、交互子元素恢复指针事件
console.log('主页容器透明（透出球场画布）:', /\.home-stage\s*\{[^}]*background:\s*none/.test(css));
console.log('容器穿透 + 子元素恢复指针:', /home-stage\s*\{[^}]*pointer-events:\s*none/.test(css) &&
  /home-stage :where\(button, a, input, select, nav, \.home-player, \.home-mask, \.home-hint\)/.test(css));

console.log('\n=== 5. 交互四态 + 焦点环 ===');
const d = (name, re) => console.log(name + ':', re.test(css));
d('铭牌 悬停/选中/锁定',      /\.plate:hover[\s\S]*\.home-side\.right \.plate\.on[\s\S]*\.plate\.locked/);
d('哨子 悬停/按下/禁用',      /\.whistle:hover \.ring[\s\S]*\.whistle:active \.ring[\s\S]*\.whistle:disabled/);
d('弹层 开合过渡',            /\.home-mask\.open[\s\S]*\.home-mask \.open \.home-sheet|\.home-mask\.open \.home-sheet/);
d('按下缩放 95%',            /\.whistle:active \.ring\s*\{[^}]*scale\(0\.95\)/);
d('键盘焦点环 2px+2px 偏移', /outline:\s*2px solid var\(--primary-100\)[\s\S]*outline-offset:\s*2px/);
d('禁用/锁定降透明度',        /opacity:\s*0\.4|\.plate\.locked\s*\{[^}]*opacity:\s*0\.45/);

console.log('\n=== 6. 8px 网格（禁止 10px/18px 等零散值） ===');
// 在我新增的设计系统区块内检查零散间距
const start = css.indexOf('设计令牌（Design Tokens）');
const end = css.indexOf('⑩ 手机端');
const block = css.slice(start, end);
const straySpacing = (block.match(/(?:gap|padding|margin)[^;{]*:\s*[^;]*?\b(?:10|18|22)px/g) || []);
console.log('新增区块内零散间距值:', straySpacing.length ? straySpacing.slice(0, 8).join(' | ') : '无');

console.log('\n=== 7. E 区副页面外壳统一性 ===');
// 每个副页面卡片都应带 shell-card，且顶部栏带 shell-head（P1-b：careerPanel 并入 dressupPanel 战功页）
const PANELS = ['trainingPanel', 'dressupPanel', 'settingsPanel',
  'manualPanel', 'pausePanel', 'netPanel'];
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
console.log('返回控件位于标题左侧的头部数:', backBeforeTitle, '(应为 4：训练/战功/说明书/联机)');

// 破坏性操作应使用 foot-danger 且位于底部操作栏
const dangerInFoot = /<div class="shell-foot">[\s\S]*?foot-danger[\s\S]*?<\/div>/.test(html);
console.log('破坏性操作在底部操作栏且用 foot-danger:', dangerInFoot);
const dangerCount = (html.match(/foot-danger/g) || []).length;
console.log('foot-danger 数量:', dangerCount, '(全部洗点 / 退出比赛)');

console.log('\n=== 8. E2/E3 统一控件 ===');
console.log('积分胶囊:', (html.match(/points-capsule/g) || []).length, '(训练 + 战功 = 2)');
// 分段选择器宿主：画质 + 帧率 + 球员弹层难度 = 3（P1：推演甲/乙直开不再有独立宿主）
console.log('分段选择器宿主:', (html.match(/segmented-host/g) || []).length, '(画质 + 帧率 + 弹层难度 = 3)');
// 原生 select 保留并隐藏：画质 + 帧率 + 难度(3) + 队伍(4) = 9
console.log('原生 select 保留并隐藏:', (html.match(/class="visually-hidden"/g) || []).length, '(应为 9)');
// P1-b 战功合并页：三标签（战斗奖励 + 生涯战绩 + 历史回放）
console.log('战功页三标签:', /id="btnHonorsReward"/.test(html) && /id="btnCareerTab"/.test(html) &&
  /id="btnHistoryTab"/.test(html) && /id="honorsRewardTab"/.test(html));
// P1-b 竖屏旋转遮罩（手机竖屏提示，桌面窄窗不受影响）
console.log('旋转遮罩样式:', /\.rotate-mask[\s\S]{0,400}?orientation: portrait[\s\S]{0,120}?pointer: coarse/.test(css));
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

console.log('\n=== 10. 场景化主页（P1）：难度/配色收敛进球员弹层，开局由哨子承担 ===');
// 配色入口：弹层 我方/敌方 2 行 + 隐藏宿主 甲/乙 2 行（契约保留，不再展示）
const swatchHosts = (html.match(/class="swatch-row"/g) || []).length;
console.log('色块行数:', swatchHosts, '(球员弹层 我方/敌方 2 + 隐藏宿主 甲/乙 2 = 4)');
console.log('旧局前设置面板已移除:', !/id="setupGroup"/.test(html) && !/setup-summary/.test(html));
console.log('模拟推演内嵌展开区已退役（AI对打直开）:', !/id="simPanel"/.test(html) && !/sim-panel/.test(html));
console.log('无尽关卡页已退役（关卡进对方球员弹层）:', !/id="endlessPanel"/.test(html));
// 数据契约：难度与队伍仍读同一批隐藏宿主（开局接口零改动）
console.log('数据宿主齐全（aiLevel/团队 select 恒在）:',
  /id="aiLevel"/.test(html) && /id="teamMe"/.test(html) && /id="teamOpp"/.test(html) &&
  /id="aiLevelA"/.test(html) && /id="aiLevelB"/.test(html));
console.log('隐藏宿主不参与视觉:', /\.home-hosts \{ display: none/.test(css));
// 移动端硬性约束：溢出防护 / 触控下限 / 窄屏降档 / 安全区（沿用竖屏旧规，横屏化在后续批次）
console.log('根容器禁横向溢出:', /#menu\s*\{[^}]*overflow/.test(css) && /home-stage\s*\{[^}]*overflow:\s*hidden/.test(css));
console.log('触控目标 ≥44px（竖屏）:', /\.btn, \.tool-btn, \.seg-btn, \.swatch, \.tbtn \{ min-height: 44px; \}/.test(css));
console.log('色块高度 ≥32px:', /\.swatch\s*\{[^}]*min-height:\s*32px/.test(css) || /\.swatch \{ min-height: 32px; \}/.test(css));
console.log('锁定档位置灰样式:', /\.seg-btn\.locked/.test(css));
console.log('弹层无尽关卡锁定态:', /\.endless-seg button\.lock/.test(css));
console.log('分段控件键盘 ←/→ 支持:', /ArrowLeft/.test(require('fs').readFileSync(path.join(ROOT, 'public/js/app/main.js'), 'utf8')));
console.log('名字牌跟随投影钩子:', /menuProj/.test(require('fs').readFileSync(path.join(ROOT, 'public/js/app/render.js'), 'utf8')) &&
  /updateHomeTags/.test(require('fs').readFileSync(path.join(ROOT, 'public/js/app/loop.js'), 'utf8')));
console.log('主页 toast 落点存在（statusBar 修复）:', /id="statusBar"/.test(html) && /\.home-toast/.test(css));

console.log('\n=== 11. P2 拨开式转场（黑屏 → 纸张从中缝拨开） ===');
console.log('转场结构（cineMask/左右黑幕/中缝线）:', /id="cineMask"/.test(html) &&
  /class="cine-half left"/.test(html) && /class="cine-seam"/.test(html));
console.log('拨开样式（.split 左右滑出）:', /\.cine-mask\.split \.cine-half\.left[\s\S]{0,120}?translateX\(-102%\)/.test(css) &&
  /\.cine-mask\.split \.cine-half\.right[\s\S]{0,120}?translateX\(102%\)/.test(css));
console.log('浮层退场样式（.leaving）:', /\.home-stage\.leaving \.home-side\.left \.plate/.test(css) &&
  /\.home-stage\.leaving \.whistle/.test(css));
console.log('开场页退役（modes 不再调 showTeamIntro）:',
  !/showTeamIntro/.test(require('fs').readFileSync(path.join(ROOT, 'public/js/app/modes.js'), 'utf8')));
console.log('联机进房播转场:', /cineTransition/.test(require('fs').readFileSync(path.join(ROOT, 'public/js/app/modes.js'), 'utf8')));
console.log('编排与快门音:', /cineTransition/.test(require('fs').readFileSync(path.join(ROOT, 'public/js/app/home.js'), 'utf8')) &&
  /shutter\(\)/.test(require('fs').readFileSync(path.join(ROOT, 'public/js/audio.js'), 'utf8')));

console.log('\n=== 12. P3 AI对打·观看视角（看台边线机位 / 球员视角跟随） ===');
console.log('视角选择弹层（三选一+取消）:', /id="aiWatchMask"/.test(html) && /id="aiwSide"/.test(html) &&
  /id="aiwFollowA"/.test(html) && /id="aiwFollowB"/.test(html) && /id="aiwCancel"/.test(html));
console.log('边线机位与视角渲染:', /makeSideCam/.test(require('fs').readFileSync(path.join(ROOT, 'public/js/app/render.js'), 'utf8')) &&
  /renderSide/.test(require('fs').readFileSync(path.join(ROOT, 'public/js/app/loop.js'), 'utf8')) &&
  /renderWatch/.test(require('fs').readFileSync(path.join(ROOT, 'public/js/app/loop.js'), 'utf8')));
console.log('视角状态字段:', /aiView/.test(require('fs').readFileSync(path.join(ROOT, 'public/js/app/state.js'), 'utf8')));
console.log('视角标注进 hint:', /看台视角/.test(require('fs').readFileSync(path.join(ROOT, 'public/js/app/modes.js'), 'utf8')));

console.log('\n=== 13. 联机框重构（2026-10-25）：创建/加入标签 + 四位输入 + 双哨子 + 高级折叠 ===');
console.log('两标签与双视图:', /id="netTabCreate"/.test(html) && /id="netTabJoin"/.test(html) && /id="netCreateView"/.test(html) && /id="netJoinView"/.test(html));
console.log('四位独立输入框:', (html.match(/class="net-digit"/g) || []).length === 4 && /id="netDigits"/.test(html));
console.log('双哨子准备视图:', /id="netReady"/.test(html) && /id="nrWhistleMe"/.test(html) && /id="nrWhistleFoe"/.test(html));
console.log('玻璃卡片+场景背景:', /net-glass/.test(html) && /backdrop-filter: blur\(10px\)/.test(css) && /radial-gradient\(52% 80% at 0% 58%/.test(css));
console.log('Beta 标签替代首屏警告:', /id="netBeta"/.test(html) && /net-beta-note/.test(css));
console.log('高级折叠（开发项收纳）:', /id="netAdvanced"/.test(html) && /id="setServerLine"/.test(html) && /id="btnNetMode"/.test(html) && /id="lanFirewallNote"/.test(html));
console.log('双端 ready 协议镜像:', /msg.t === 'ready'/.test(require('fs').readFileSync(path.join(ROOT, 'src/room-core.js'), 'utf8')) && /msg.t === 'ready'/.test(require('fs').readFileSync(path.join(ROOT, 'server.js'), 'utf8')));
console.log('旧 id 契约保留:', ['btnHost','btnJoin','joinInput','roomCode','roomHint','netWait','netOperate','lanUrls','btnNetMode','netStatus','btnNetBack'].every((id) => html.includes('id="' + id + '"')));
