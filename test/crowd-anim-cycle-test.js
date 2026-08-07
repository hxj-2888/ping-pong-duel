/* 端到端：动画进行中(每帧烘焙) vs 动画结束后，屏幕上观众总数严格一致
 * 模拟 drawFloor 完整缓存路径：
 * - 静止帧：静态层画全部观众（rest）
 * - 动画帧：静态层无观众 + 动画层画全部（欢呼/摇头）
 * - 动画结束帧：静态层恢复全部观众
 * 任何时刻屏幕上的总人数 = 静止基准人数
 */
'use strict';
const path = require('path');
const TTG = require(path.join(__dirname, '..', 'public', 'js', 'render.js'));

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' [' + extra + ']' : ''}`);
  if (!cond) failures++;
}

const VW = 1280, VH = 720;
const cam = new TTG.Camera();
cam.set(TTG.v3(0, 4.8, -5.2), TTG.v3(0, 1.7, 0), VW / 2, VH / 2, VW * 0.9);

function makeCtx(canvas) {
  const counters = { arc: 0 };
  return {
    canvas, counters,
    getTransform() { return { a: 1, d: 1, e: 0, f: 0 }; },
    setTransform() {}, clearRect() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {},
    arc() { counters.arc++; },
    ellipse() {}, drawImage() {}, setLineDash() {},
  };
}

// document 桩（离屏缓存路径）
let created = 0;
const allCtx = [];
const fakeDocument = {
  createElement() {
    created++;
    const c = { width: 0, height: 0 };
    const ctx = makeCtx(c);
    c.getContext = () => ctx;
    allCtx.push(ctx);
    return c;
  },
};
global.document = fakeDocument;
const mainCtx = makeCtx({ width: VW, height: VH });

function reset() {
  TTG.clearCrowdCache();
  allCtx.length = 0; created = 0;
  mainCtx.counters.arc = 0;
}
// 屏幕上人数 = 静态层 arc（静止时）+ 动画层 arc（动画时）
function onScreen() {
  return (allCtx[0] ? allCtx[0].counters.arc : 0) + (allCtx[1] ? allCtx[1].counters.arc : 0);
}

// 1. 静止基准
reset();
TTG.drawFloor(mainCtx, cam, VW, VH, 0.1, 0, null, false);
const base = onScreen();
console.log('静止基准人数:', base);
check('静止人数 > 0', base > 0, String(base));

// 2. 动画进行中（30Hz 烘焙多帧，模拟得分欢呼 1s）
const fan = { cheer: [1, 1], shake: [0, 0] };
let allAnim = true;
for (let i = 0; i < 30; i++) {
  reset();
  TTG.drawFloor(mainCtx, cam, VW, VH, 0.1 + i / 30, 0, fan, false);
  const n = onScreen();
  if (n !== base) { allAnim = false; console.log('  动画帧', i, '人数:', n, '(基准', base + ')'); }
}
check('动画进行中每帧人数 = 静止基准', allAnim, 'base=' + base);

// 3. 动画结束（fan 衰减到 0）→ 静态层恢复
reset();
TTG.drawFloor(mainCtx, cam, VW, VH, 1.2, 0, null, false);
check('动画结束静态层恢复 = 基准', onScreen() === base, String(onScreen()));

console.log(failures === 0 ? '\n动画全周期人数一致性通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
