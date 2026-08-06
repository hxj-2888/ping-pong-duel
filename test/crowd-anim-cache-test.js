/* 观众席双层离屏缓存行为验证（性能回归）
 * 覆盖（render.js drawFloor 缓存路径）：
 *  1. 静止帧零全量重绘：非动画帧只 blit 静态层，不重画 ~376 观众
 *  2. 得分欢呼动画按 30Hz 烘焙进「动画层」（半分辨率 + 快速绘制），60 帧 @60fps 只烘焙 30 次
 *  3. 动画开始即时烘焙、间隔帧零重绘、结束直接停 blit（静止层呈现，无需重建）
 *  4. 动画层半分辨率（填充率 1/4）
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
function makeCountingCtx(canvas) {
  const counters = { arc: 0, blit: 0 };
  const ctx = {
    canvas,
    counters,
    setTransform() {}, clearRect() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {},
    arc() { counters.arc++; },
    ellipse() {},
    drawImage() { counters.blit++; },
    setLineDash() {},
  };
  return ctx;
}
const VW = 1280, VH = 720;
const staticCanvas = { width: VW, height: VH };
const animCanvas = { width: 0, height: 0 };
const staticCtx = makeCountingCtx(staticCanvas);
const animCtx = makeCountingCtx(animCanvas);
staticCanvas.getContext = () => staticCtx;
animCanvas.getContext = () => animCtx;
// viewSide 1（本地双人另一视口）各自独立的缓存 canvas
const static2Canvas = { width: VW, height: VH };
const anim2Canvas = { width: 0, height: 0 };
const static2Ctx = makeCountingCtx(static2Canvas);
const anim2Ctx = makeCountingCtx(anim2Canvas);
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
function visibleCount(cw, ch) {
  return TTG.crowdLayout().filter((s) => {
    const p = TTG.seatedPose(s, 0, 0, 0);
    const hp = cam.project(p.head), fp = cam.project(p.hips);
    if (!hp || !fp) return false;
    return !(hp.x < -60 || hp.x > cw + 60 || fp.y < -60 || fp.y > ch + 60);
  }).length;
}
const statLen = visibleCount(VW, VH);
const animLen = visibleCount(Math.round(VW * 0.5), Math.round(VH * 0.5));

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

// ---------- 2. 得分欢呼动画 30Hz 烘焙 ----------
resetAll();
const fan = { cheer: [1, 0], shake: [0, 1] };
frames(60, fan);
const animRebuilds = Math.round(aArc() / animLen);
check('动画 60 帧烘焙 30 次（30Hz，非每帧）', animRebuilds >= 28 && animRebuilds <= 32);
check('静态层仅首帧重建（相机未动）', sArc() === statLen);
check('动画期间每帧 2 次 blit（静态+动画）', blits() === 120);

// ---------- 3. 动画开始即时、间隔帧零重绘、结束停 blit ----------
resetAll();
let idx = 1; // 显式步进（跨 frames() 调用时刻必须连续递增）
const step = (f) => { TTG.drawFloor(staticCtx, cam, VW, VH, idx / 60, 0, f, false); idx++; };
step(null);                     // 静止首帧
step(fan);                      // 动画开始 → 即时烘焙
check('动画开始帧即时烘焙', aArc() === animLen);
step(fan);                      // 动画间隔帧（未到 30Hz）→ 零重绘
check('动画间隔帧零全量重绘', aArc() === animLen);
step(fan);                      // 到 30Hz 周期 → 再烘焙
check('动画周期帧再烘焙', aArc() === 2 * animLen);
step(null);                     // 动画结束 → 停止叠加，静止层直接显现
check('动画结束不再重建（静止层直接显现）', aArc() === 2 * animLen && sArc() === statLen);
step(null);
check('动画结束后静止帧零重绘', aArc() === 2 * animLen && sArc() === statLen);
check('blit 数=9（1+2+2+2+1+1）', blits() === 9);

// ---------- 4. 动画层半分辨率（填充率 1/4） ----------
resetAll();
frames(1, fan);
check('动画层半分辨率（640=1280×0.5）', animCanvas.width === Math.round(VW * 0.5) && animCanvas.height === Math.round(VH * 0.5));
check('静态层全分辨率（1280）', staticCanvas.width === VW && staticCanvas.height === VH);

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

// ---------- 8. 手机密度减半：crowdLayout(0.5) 人数约一半（省 DPR3 填充率） ----------
const halfList = TTG.crowdLayout(0.5);
check('密度 0.5：观众人数约减半', halfList.length >= Math.floor(crowdLen * 0.35) && halfList.length <= Math.ceil(crowdLen * 0.65));

console.log(failures === 0 ? '\n观众席双层缓存行为验证全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
