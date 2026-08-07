/* 多窗口尺寸：静态/动画人数一致性验证
 * 覆盖手机竖屏(390x844)、手机横屏(844x390)、桌面(1280x720)、
 * 高清(2560x1440)、分屏窄(640x720) 等场景
 */
'use strict';
const path = require('path');
const TTG = require(path.join(__dirname, '..', 'public', 'js', 'render.js'));

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' [' + extra + ']' : ''}`);
  if (!cond) failures++;
}

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

function testSize(VW, VH, dpr, label) {
  TTG.clearCrowdCache();
  allCtx.length = 0; created = 0;
  const mainCanvas = { width: Math.round(VW * dpr), height: Math.round(VH * dpr) };
  const mainCtx = makeCtx(mainCanvas);
  mainCtx.getTransform = () => ({ a: dpr, d: dpr, e: 0, f: 0 });
  mainCanvas.getContext = () => mainCtx;

  const cam = new TTG.Camera();
  cam.set(TTG.v3(0, 4.8, -5.2), TTG.v3(0, 1.7, 0), VW / 2, VH / 2, VW * 0.9);

  // 静止
  TTG.drawFloor(mainCtx, cam, VW, VH, 0.1, 0, null, false);
  const staticN = (allCtx[0] ? allCtx[0].counters.arc : 0) + (allCtx[1] ? allCtx[1].counters.arc : 0);
  // 动画
  TTG.clearCrowdCache();
  allCtx.length = 0; created = 0;
  TTG.drawFloor(mainCtx, cam, VW, VH, 0.2, 0, { cheer: [1, 1], shake: [0, 0] }, false);
  const animN = (allCtx[0] ? allCtx[0].counters.arc : 0) + (allCtx[1] ? allCtx[1].counters.arc : 0);
  // 动画后恢复
  TTG.clearCrowdCache();
  allCtx.length = 0; created = 0;
  TTG.drawFloor(mainCtx, cam, VW, VH, 1.5, 0, null, false);
  const afterN = (allCtx[0] ? allCtx[0].counters.arc : 0) + (allCtx[1] ? allCtx[1].counters.arc : 0);

  const ok = staticN === animN && staticN === afterN && staticN > 0;
  console.log(`${label} (${VW}x${VH} dpr${dpr}): 静止=${staticN} 动画=${animN} 恢复=${afterN}`);
  check(label + ' 三态一致', ok, `static=${staticN} anim=${animN} after=${afterN}`);
}

testSize(1280, 720, 1, '桌面 1280x720');
testSize(1280, 720, 2, '桌面高分 1280x720@2x');
testSize(390, 844, 3, '手机竖屏 390x844@3x');
testSize(844, 390, 3, '手机横屏 844x390@3x');
testSize(2560, 1440, 1, '高清 2560x1440');
testSize(640, 720, 1, '分屏窄 640x720');
testSize(800, 600, 1, '小窗 800x600');
testSize(1920, 1080, 1, '1080p 1920x1080');

console.log(failures === 0 ? '\n多窗口尺寸人数一致性全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
