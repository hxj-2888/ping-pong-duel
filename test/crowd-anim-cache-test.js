/* 观众席离屏缓存行为验证（性能回归）
 * 覆盖（render.js drawFloor 缓存路径）：
 *  1. 静止帧零全量重绘：非动画帧只 blit 缓存，不重画 ~376 观众（此前每帧全量重绘 = 掉帧主因）
 *  2. 得分欢呼动画按 30Hz 烘焙进缓存：60 帧 @60fps 只全量重绘 30 次
 *  3. 动画开始/结束即时重建一次（回静止位姿），动画间隔帧零重绘
 *  4. 相机移动超过缓存桶阈值才重建（0.06m）
 *  5. 低画质 / 无缓存环境回退路径行为不变
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

// ---------- 场景 ----------
const VW = 1280, VH = 720;
const cam = new TTG.Camera();
cam.set(TTG.v3(0, 4.8, -5.2), TTG.v3(0, 1.7, 0), VW / 2, VH / 2, VW * 0.9);
const crowdLen = TTG.crowdLayout().length; // ~376

// ---------- 计数型 ctx / 假 canvas（与 browser-smoke 同风格，但记录关键操作次数） ----------
let arcCount = 0;   // drawPerson 圆头 = 全量重绘观众数
let blitCount = 0;  // drawImage = 缓存 blit 次数
function makeCountingCtx(canvas) {
  const ctx = {
    canvas,
    setTransform() {}, clearRect() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {},
    arc() { arcCount++; },
    ellipse() {},
    drawImage() { blitCount++; },
    setLineDash() {},
  };
  return ctx;
}
const fakeCanvas = { width: VW, height: VH };
const counting = makeCountingCtx(fakeCanvas);
fakeCanvas.getContext = () => counting;
global.document = { createElement: () => fakeCanvas };
function resetCounters() { arcCount = 0; blitCount = 0; TTG.clearCrowdCache(); }

// 以 1/60 步进画 n 帧（fan=null 静止 / fan 动画），时刻按整数帧索引计算避免浮点漂移
function frames(n, fan, idx0) {
  let idx = idx0 == null ? 1 : idx0;
  for (let i = 0; i < n; i++) {
    TTG.drawFloor(counting, cam, VW, VH, idx / 60, 0, fan, false);
    idx++;
  }
  return idx;
}

// ---------- 1. 静止帧零全量重绘 ----------
resetCounters();
frames(1, null);
const firstArcs = arcCount;
check('首帧重建缓存（全量观众入缓存）', firstArcs === crowdLen);
check('首帧 1 次 blit', blitCount === 1);
frames(9, null);
check('随后 9 帧零全量重绘（仅 blit）', arcCount === firstArcs);
check('10 帧共 10 次 blit', blitCount === 10);

// ---------- 2. 得分欢呼动画 30Hz 烘焙 ----------
resetCounters();
const fan = { cheer: [1, 0], shake: [0, 1] };
frames(60, fan);
const rebuilds = Math.round(arcCount / crowdLen);
check('动画 60 帧全量重绘 30 次（30Hz 烘焙，非每帧）', rebuilds >= 28 && rebuilds <= 32);
check('动画期间每帧仍只 1 次 blit', blitCount === 60);

// ---------- 3. 动画开始即时、间隔帧零重绘、结束回静止 ----------
resetCounters();
let idx = 1; // 显式步进（跨 frames() 调用时刻必须连续递增）
const step = (f) => { TTG.drawFloor(counting, cam, VW, VH, idx / 60, 0, f, false); idx++; };
step(null);                     // 静止首帧
step(fan);                      // 动画开始 → 即时重建（动画位姿）
check('动画开始帧即时烘焙', arcCount === 2 * crowdLen);
step(fan);                      // 动画间隔帧（未到 30Hz）→ 零重绘
check('动画间隔帧零全量重绘', arcCount === 2 * crowdLen);
step(fan);                      // 到 30Hz 周期 → 再烘焙
check('动画周期帧再烘焙', arcCount === 3 * crowdLen);
step(null);                     // 动画结束 → 重建回静止位姿
check('动画结束帧重建回静止', arcCount === 4 * crowdLen);
step(null);
check('动画结束后静止帧零重绘', arcCount === 4 * crowdLen);

// ---------- 4. 相机移动超过缓存桶阈值才重建（桶 key 用 Math.round，实际阈值为半桶 0.03m） ----------
resetCounters();
frames(1, null);                    // 首帧重建
cam.set(TTG.v3(0.02, 4.8, -5.2), TTG.v3(0, 1.7, 0), VW / 2, VH / 2, VW * 0.9); // 移 0.02m < 半桶
frames(1, null);
check('相机移 0.02m 未过桶 → 不重建', arcCount === crowdLen);
cam.set(TTG.v3(0.05, 4.8, -5.2), TTG.v3(0, 1.7, 0), VW / 2, VH / 2, VW * 0.9); // 移 0.05m ≥ 半桶
frames(1, null);
check('相机移 0.05m 过桶 → 重建', arcCount === 2 * crowdLen);

// ---------- 5. 低画质：不建缓存、不画观众 ----------
resetCounters();
TTG.drawFloor(counting, cam, VW, VH, 1 / 60, 0, null, true);
check('低画质零观众绘制（arc=0）', arcCount === 0);
check('低画质零 blit（无缓存）', blitCount === 0);

// ---------- 6. 无缓存环境（无 document）回退逐帧直画 ----------
delete global.document;
resetCounters();
frames(3, null);
check('无缓存环境逐帧直画观众（3 帧 = 3×全量）', arcCount === 3 * crowdLen);

console.log(failures === 0 ? '\n观众席缓存行为验证全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
