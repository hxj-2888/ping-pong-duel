/* 分屏两端观众队色一致性验证（render.js drawCrowd teamFixed）
 * 背景：本地分屏 P1 半屏镜像、P2 半屏未镜像，若按 viewSide 分阵营，
 *       两端观众会「红左蓝右」vs「蓝左红右」左右相反。
 * 修复：本地分屏传 teamFixed=true，两侧统一「红左蓝右」（P1 主视角）；
 *       人机/联机不传该标志，保持「己方球迷在左」原逻辑。
 * 用法: node test/crowd-team-consistency-test.js
 */
'use strict';

const path = require('path');
const TTG = require(path.join(__dirname, '..', 'public', 'js', 'render.js'));

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

const VW = 1280, VH = 720;
const FAN_RED = 'rgba(240,110,92,0.95)';
const FAN_BLUE = 'rgba(110,160,246,0.95)';

// 记录每次 arc 时的 fillStyle（每位观众只画一次头 arc → 得到按观众顺序的队色）
function makeColorCtx() {
  const colors = [];
  const ctx = {
    canvas: { width: VW, height: VH },
    counters: { arc: 0 },
    getTransform() { return { a: 1, d: 1, e: 0, f: 0 }; },
    setTransform() {}, clearRect() {},
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    fill() {}, stroke() {},
    arc() { colors.push(this.fillStyle); this.counters.arc++; },
    ellipse() {}, drawImage() {}, setLineDash() {},
  };
  return { ctx, colors };
}

const cam = new TTG.Camera();
cam.set(TTG.v3(0, 4.8, -5.2), TTG.v3(0, 1.7, 0), VW / 2, VH / 2, VW * 0.9);

// 与 drawPerson 屏幕外剔除同口径：统计按规则应红/蓝的可见观众数
function expectedCounts(viewSide, teamFixed) {
  let red = 0, blue = 0;
  for (const s of TTG.crowdLayout(1.0)) {
    const sp = cam.project(TTG.v3(s.x, s.y, s.z));
    if (!sp) continue;
    if (sp.x < -60 || sp.x > VW + 60 || sp.y < -60 || sp.y > VH + 60) continue;
    const team = teamFixed ? (s.x < 0 ? 0 : 1) : (s.x < 0 ? (viewSide || 0) : 1 - (viewSide || 0));
    if (team === 0) red++; else blue++;
  }
  return { red, blue };
}

function drawCounts(viewSide, teamFixed) {
  const { ctx, colors } = makeColorCtx();
  TTG.drawCrowd(ctx, cam, 0, viewSide, null, 1.0, teamFixed);
  let red = 0, blue = 0;
  for (const c of colors) {
    if (c === FAN_RED) red++;
    else if (c === FAN_BLUE) blue++;
    else { throw new Error('未知观众颜色: ' + c); }
  }
  return { red, blue };
}

// 1) teamFixed=true：viewSide 0 与 viewSide 1 的红蓝数量一致（两端背景相同）
const fixed0 = drawCounts(0, true);
const fixed1 = drawCounts(1, true);
check('teamFixed=true：红蓝观众总数与预期一致', fixed0.red === expectedCounts(0, true).red && fixed0.blue === expectedCounts(0, true).blue);
check('teamFixed=true：两端 viewSide 红蓝数量一致（背景统一红左蓝右）', fixed0.red === fixed1.red && fixed0.blue === fixed1.blue);
check('teamFixed=true：红方观众在左（x<0 为红）', fixed0.red > 0 && fixed0.blue > 0);

// 2) 未传 teamFixed：保持原逻辑（viewSide 0=红左蓝右；viewSide 1=蓝左红右，左右互换）
const old0 = drawCounts(0, false);
const old1 = drawCounts(1, false);
check('原逻辑：viewSide 0 红蓝与预期一致', old0.red === expectedCounts(0, false).red && old0.blue === expectedCounts(0, false).blue);
check('原逻辑：viewSide 1 红蓝与预期一致', old1.red === expectedCounts(1, false).red && old1.blue === expectedCounts(1, false).blue);
check('原逻辑：两端 viewSide 红蓝互换（分屏差异的根因）', old0.red === old1.blue && old0.blue === old1.red);

console.log(failures === 0 ? '\n分屏观众队色一致性验证全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
