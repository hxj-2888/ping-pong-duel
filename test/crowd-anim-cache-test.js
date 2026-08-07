/* 观众席双层离屏缓存行为验证（性能回归）
 * 覆盖（render.js drawFloor 缓存路径）：
 *  1. 静止帧零全量重绘：非动画帧只 blit 静态层，不重画 ~376 观众
 *  2. 得分欢呼动画按 30Hz 烘焙进「动画层」（全分辨率 + 描边，与静态层同一画风），60 帧 @60fps 只烘焙 30 次
 *  3. 动画开始即时烘焙、间隔帧零重绘；动画期静态层重建为「无观众」（防复制体叠影），
 *     动画结束静态层重建回 rest 观众、动画层停 blit
 *  4. 动画层全分辨率（与静态层一致，高画质清晰）
 *  5. 相机移动超过缓存桶阈值才重建（0.06m → 实际半桶 0.03m）
 *  6. 低画质 / 无缓存环境回退路径行为不变
 * 用法: node test/crowd-anim-cache-test.js
 */
'use strict';

const path = require('path');
const TTG = require(path.join(__dirname, '..', 'public', 'js', 'render.js'));

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

// ---------- 计数型 ctx / 假 canvas（静态层与动画层各自独立计数） ----------
// scale：当前 ctx 的缩放（静态层=1，动画层=CROWD_ANIM_SCALE=1.0 全分辨率——与静态层一致，高画质清晰）。
// getTransform 让 drawPerson 的屏幕外剔除走真实坐标换算路径（修复：动画层不再误剔右/下半屏观众）
function makeCountingCtx(canvas, scale) {
  const counters = { arc: 0, blit: 0 };
  // 记录当前变换矩阵（setTransform 写入、getTransform 读出，与真实 canvas 一致）
  let tx = { a: scale || 1, d: scale || 1, e: 0, f: 0 };
  const ctx = {
    canvas,
    counters,
    setTransformArgs: [],   // 记录 setTransform(a,b,c,d,e,f)（断言分屏右半 -vx 平移）
    drawImageArgs: [],      // 记录 drawImage(源, dstX, dstY, dstW, dstH)（断言 blit 到视口位置）
    getTransform() { return { a: tx.a, d: tx.d, e: tx.e, f: tx.f }; },
    setTransform(a, b, c, d, e, f) {
      tx = { a: a, d: d, e: e || 0, f: f || 0 };
      ctx.setTransformArgs.push([a, b, c, d, e || 0, f || 0]);
    },
    clearRect() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {},
    arc() { counters.arc++; },
    ellipse() {},
    drawImage() { counters.blit++; ctx.drawImageArgs.push(Array.prototype.slice.call(arguments)); },
    setLineDash() {},
  };
  return ctx;
}
const VW = 1280, VH = 720;
const staticCanvas = { width: VW, height: VH };
const animCanvas = { width: 0, height: 0 };
const staticCtx = makeCountingCtx(staticCanvas, 1);
const animCtx = makeCountingCtx(animCanvas, 1);
staticCanvas.getContext = () => staticCtx;
animCanvas.getContext = () => animCtx;
// viewSide 1（本地双人另一视口）各自独立的缓存 canvas
const static2Canvas = { width: VW, height: VH };
const anim2Canvas = { width: 0, height: 0 };
const static2Ctx = makeCountingCtx(static2Canvas, 1);
const anim2Ctx = makeCountingCtx(anim2Canvas, 1);
static2Canvas.getContext = () => static2Ctx;
anim2Canvas.getContext = () => anim2Ctx;
// createElement 顺序：viewSide0 静态层(1)/动画层(2)，viewSide1 静态层(3)/动画层(4)
// （按 viewSide 懒创建——本地双人分屏才会建第二组；保持既有断言依赖的 1/2 序号不变）
let canvasN = 0;
global.document = { createElement: () => { canvasN++; return canvasN === 1 ? staticCanvas : canvasN === 2 ? animCanvas : canvasN === 3 ? static2Canvas : anim2Canvas; } };
function resetAll() {
  canvasN = 0;
  staticCtx.counters.arc = 0; staticCtx.counters.blit = 0;
  animCtx.counters.arc = 0; animCtx.counters.blit = 0;
  static2Ctx.counters.arc = 0; static2Ctx.counters.blit = 0;
  anim2Ctx.counters.arc = 0; anim2Ctx.counters.blit = 0;
  staticCtx.setTransformArgs = []; staticCtx.drawImageArgs = [];
  animCtx.setTransformArgs = []; animCtx.drawImageArgs = [];
  static2Ctx.setTransformArgs = []; static2Ctx.drawImageArgs = [];
  anim2Ctx.setTransformArgs = []; anim2Ctx.drawImageArgs = [];
  TTG.clearCrowdCache();
}
const sArc = () => staticCtx.counters.arc; // 静态层全量重绘数（≈观众数×次数）
const aArc = () => animCtx.counters.arc;   // 动画层烘焙重绘数
const blits = () => staticCtx.counters.blit; // 主画布 blit 总次数（静态 + 动画）

// ---------- 场景 ----------
const cam = new TTG.Camera();
cam.set(TTG.v3(0, 4.8, -5.2), TTG.v3(0, 1.7, 0), VW / 2, VH / 2, VW * 0.9);
const crowdLen = TTG.crowdLayout().length; // ~376（布局总数）
// 与 drawPerson 屏幕外剔除一致的"可见观众数"：静态层全分辨率 / 动画层半分辨率
// 剔除基准用**座位坐标**（姿态无关，与 drawPerson 一致）——动画层 cheer/shake 时
// head/hips 位移，若按姿态坐标统计会与静态层人数不一致
function visibleCount(cw, ch) {
  return TTG.crowdLayout().filter((s) => {
    const sp = cam.project(TTG.v3(s.x, s.y, s.z));
    if (!sp) return false;
    return !(sp.x < -60 || sp.x > cw + 60 || sp.y < -60 || sp.y > ch + 60);
  }).length;
}
const statLen = visibleCount(VW, VH);
// 动画层覆盖口径：修复后动画层剔除边界经 getTransform 换算回 CSS 像素（scale=0.5 → canvas.width/0.5=vw），
// 与静态层一致覆盖全体可见观众；不再用半分辨率画布尺寸作边界（那会在 dpr=1 时误剔右/下半屏观众）
const animLen = visibleCount(VW, VH);

// 以 1/60 步进画 n 帧（fan=null 静止 / fan 动画），时刻按整数帧索引计算避免浮点漂移
function frames(n, fan, idx0) {
  let idx = idx0 == null ? 1 : idx0;
  for (let i = 0; i < n; i++) {
    TTG.drawFloor(staticCtx, cam, VW, VH, idx / 60, 0, fan, false);
    idx++;
  }
  return idx;
}

// ---------- 1. 静止帧零全量重绘 ----------
resetAll();
frames(1, null);
check('首帧静态层重建（全量观众入静态层）', sArc() === statLen);
check('首帧 1 次 blit', blits() === 1);
frames(9, null);
check('随后 9 帧零全量重绘（仅 blit）', sArc() === statLen && aArc() === 0);
check('10 帧共 10 次 blit', blits() === 10);

// ---------- 2. 得分欢呼动画 30Hz 烘焙（动画期静态层不含观众，防复制体叠影） ----------
resetAll();
const fan = { cheer: [1, 0], shake: [0, 1] };
frames(1, null);              // 静止首帧：静态层含 rest 观众
frames(60, fan);              // 动画 60 帧：静态层重建为无观众 + 动画层全量烘焙
const animRebuilds = Math.round(aArc() / animLen);
check('动画 60 帧烘焙 30 次（30Hz，非每帧）', animRebuilds >= 28 && animRebuilds <= 32);
check('动画期静态层无观众（sArc 不增，防复制体叠影）', sArc() === statLen);
check('动画期间每帧 2 次 blit（静态+动画，共 1+60×2=121）', blits() === 121);

// ---------- 3. 动画开始即时、间隔帧零重绘、结束停 blit ----------
// 注意：动画中观众姿态（举手/摇头/起身起伏）让头/髋在 ±60px 剔除边沿附近 ±10px 抖动，
// 绘制人数与 rest-pose 的 animLen 相差 ±4 以内属正常 → 用容差断言；真重建一次 +~animLen，不会被容差掩盖
resetAll();
let idx = 1; // 显式步进（跨 frames() 调用时刻必须连续递增）
const step = (f) => { TTG.drawFloor(staticCtx, cam, VW, VH, idx / 60, 0, f, false); idx++; };
const near = (v, n) => Math.abs(v - n * animLen) <= 4;
step(null);                     // 静止首帧（静态层含 rest 观众）
step(fan);                      // 动画开始 → 即时烘焙（静态层重建为无观众）
check('动画开始帧即时烘焙', near(aArc(), 1));
step(fan);                      // 动画间隔帧（未到 30Hz）→ 零重绘
check('动画间隔帧零全量重绘', near(aArc(), 1));
step(fan);                      // 到 30Hz 周期 → 再烘焙
check('动画周期帧再烘焙', near(aArc(), 2));
step(null);                     // 动画结束 → 静态层重建含 rest 观众、动画层停 blit
check('动画结束：静态层重建含 rest 观众（sArc=2×statLen）、动画层停', near(aArc(), 2) && sArc() === 2 * statLen);
step(null);
check('动画结束后静止帧零重绘', near(aArc(), 2) && sArc() === 2 * statLen);
check('blit 数=9（1+2+2+2+1+1）', blits() === 9);

// ---------- 4. 动画层全分辨率（与静态层一致，高画质清晰） ----------
resetAll();
frames(1, fan);
check('动画层全分辨率（1280=1280×1.0）', animCanvas.width === Math.round(VW * 1.0) && animCanvas.height === Math.round(VH * 1.0));
check('静态层全分辨率（1280）', staticCanvas.width === VW && staticCanvas.height === VH);
check('动画层覆盖全体可见观众（与静态层同口径，右/下半屏不再被误剔）', animLen === statLen && animLen > 0);

// ---------- 5. 相机移动超过缓存桶阈值才重建（桶 key 用 Math.round，实际阈值为半桶 0.03m） ----------
resetAll();
frames(1, null);                    // 首帧重建
cam.set(TTG.v3(0.02, 4.8, -5.2), TTG.v3(0, 1.7, 0), VW / 2, VH / 2, VW * 0.9); // 移 0.02m < 半桶
frames(1, null);
check('相机移 0.02m 未过桶 → 不重建', sArc() === statLen);
cam.set(TTG.v3(0.05, 4.8, -5.2), TTG.v3(0, 1.7, 0), VW / 2, VH / 2, VW * 0.9); // 移 0.05m ≥ 半桶
frames(1, null);
check('相机移 0.05m 过桶 → 静态层重建', sArc() === statLen + visibleCount(VW, VH));

// ---------- 5b. 分屏回归：viewSide 0/1 各自缓存，互不踢缓存（修复本地双人每帧重建 376 人观众席） ----------
resetAll();
cam.set(TTG.v3(0, 4.8, -5.2), TTG.v3(0, 1.7, 0), VW / 2, VH / 2, VW * 0.9); // 相机归位
TTG.drawFloor(staticCtx, cam, VW, VH, 1 / 60, 0, null, false);  // viewSide 0 首帧 → 建缓存并重建
TTG.drawFloor(static2Ctx, cam, VW, VH, 2 / 60, 1, null, false); // viewSide 1 首帧 → 各自缓存
TTG.drawFloor(staticCtx, cam, VW, VH, 3 / 60, 0, null, false);  // 回到 viewSide 0 → 已缓存，不重建
TTG.drawFloor(static2Ctx, cam, VW, VH, 4 / 60, 1, null, false); // 回到 viewSide 1 → 已缓存，不重建
check('分屏：viewSide 0 首帧重建（全量观众入静态层）', staticCtx.counters.arc === statLen);
check('分屏：viewSide 1 首帧各自重建', static2Ctx.counters.arc === statLen);
	check('分屏：回到 viewSide 0 不重建（缓存保持）', staticCtx.counters.arc === statLen);
	check('分屏：回到 viewSide 1 不重建（缓存保持）', static2Ctx.counters.arc === statLen);

	// ---------- 5c. 分屏右半视口坐标回归：side1 相机投影为**绝对屏幕坐标**（cx=half+half/2），
	// 离屏缓存是视口本地坐标 → 必须平移 -vx 画入、blit 到视口位置，否则右半屏整片空白 ----------
	resetAll();
	// 先画 viewSide 0（整屏相机）占用 createElement 1/2，保证 viewSide 1 用 3/4（static2Ctx/anim2Ctx）
	const fullCam = new TTG.Camera();
	fullCam.set(TTG.v3(0, 4.8, -5.2), TTG.v3(0, 1.7, 0), VW / 2, VH / 2, VW * 0.9);
	TTG.drawFloor(staticCtx, fullCam, VW, VH, 1 / 60, 0, null, false);
	const halfW = Math.floor(VW / 2); // 640
	const rightCam = new TTG.Camera();
	rightCam.set(TTG.v3(0, 4.8, -5.2), TTG.v3(0, 1.7, 0), halfW + halfW / 2, VH / 2, halfW * 0.9); // cx=960 → vx=640
	// 无观众（low）路径：floor 缓存平移 + blit 到位
	TTG.drawFloor(static2Ctx, rightCam, halfW, VH, 2 / 60, 1, null, true);
	check('分屏右半：floor 缓存 setTransform 平移 -vx',
	  static2Ctx.setTransformArgs.length > 0 && static2Ctx.setTransformArgs[static2Ctx.setTransformArgs.length - 1][4] === -halfW * 2);
	check('分屏右半：floor 缓存 blit 到视口 x', static2Ctx.drawImageArgs.length > 0 && static2Ctx.drawImageArgs[0][1] === halfW);
	// 观众路径：右半视口观众不被屏外剔除（arc>0）+ blit 到位
	TTG.drawFloor(static2Ctx, rightCam, halfW, VH, 3 / 60, 1, null, false);
	check('分屏右半：观众路径重建且不剔除（arc>0）', static2Ctx.counters.arc > 0);
	check('分屏右半：观众路径 blit 到视口 x', static2Ctx.drawImageArgs.length >= 2 && static2Ctx.drawImageArgs[1][1] === halfW);

// ---------- 6. 低画质：无观众，但地板+围挡走静态层缓存（首帧烘焙、每帧 1 blit） ----------
resetAll();
TTG.drawFloor(staticCtx, cam, VW, VH, 1 / 60, 0, null, true);
TTG.drawFloor(staticCtx, cam, VW, VH, 2 / 60, 0, null, true);
check('低画质零观众绘制（arc=0）', sArc() === 0 && aArc() === 0);
check('低画质 floor 走静态层缓存（两帧各 1 blit）', blits() === 2);

// ---------- 7. 无缓存环境（无 document）回退逐帧直画 ----------
delete global.document;
resetAll();
frames(3, null);
check('无缓存环境逐帧直画观众（3 帧 = 3×全量）', sArc() === 3 * statLen && aArc() === 0);

// ---------- 8. 密度减半：crowdLayout(0.5) 人数约一半（电脑端新密度）；0.25 再减半（手机端新密度） ----------
const halfList = TTG.crowdLayout(0.5);
check('密度 0.5：观众人数约减半', halfList.length >= Math.floor(crowdLen * 0.35) && halfList.length <= Math.ceil(crowdLen * 0.65));
const quarterList = TTG.crowdLayout(0.25);
check('密度 0.25：观众人数再减半（相对 0.5）', quarterList.length >= Math.floor(halfList.length * 0.35) && quarterList.length <= Math.ceil(halfList.length * 0.65));

console.log(failures === 0 ? '\n观众席双层缓存行为验证全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
