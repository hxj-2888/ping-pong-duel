/* 结构性验证：观众坐姿火柴人骨架必须符合坐姿 + 欢呼姿态
 * 用法: node test/seated-crowd-test.js
 */
'use strict';
const path = require('path');
const TTG = require(path.join(__dirname, '..', 'public', 'js', 'render.js'));
const { v3, vlen, vsub, vdot } = TTG;

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

const near = (a, b, eps) => Math.abs(a - b) < eps;

// 侧看台观众（x=4, z=2）：应朝向球场中心（大致 -x 方向）
const side = { x: 4.2, y: 0.73, z: 2.0, ph: 0.3, c: 0.5 };
// 端看台观众（z=6.35）：应朝向中心（大致 -z 方向）
const end = { x: 0.5, y: 0.73, z: 6.35, ph: 1.2, c: 0.7 };

const pSide = TTG.seatedPose(side, 1.0, 0);
const pEnd = TTG.seatedPose(end, 1.0, 0);
const pSideCheer = TTG.seatedPose(side, 1.0, 1);

// --- 朝向 ---
check('侧看台观众朝向球场中心（-x 为主）', pSide.f.x < -0.7 && Math.abs(pSide.f.z) < 0.6);
check('端看台观众朝向球场中心（-z 为主）', pEnd.f.z < -0.7 && Math.abs(pEnd.f.x) < 0.6);

// --- 坐姿几何 ---
check('髋在座位上方（y > 站位）', pSide.hips.y > side.y + 0.2);
check('肩在髋上方', pSide.shoulder.y > pSide.hips.y);
check('头在肩上方', pSide.head.y > pSide.shoulder.y);
// 大腿前伸：膝在髋的朝向方向前方
check('左膝前伸（沿朝向）', vdot(vsub(pSide.kneeL, pSide.hips), pSide.f) > 0.15);
check('右膝前伸（沿朝向）', vdot(vsub(pSide.kneeR, pSide.hips), pSide.f) > 0.15);
// 膝比髋略低（坐姿大腿略下倾）
check('膝低于髋', pSide.kneeL.y < pSide.hips.y && pSide.kneeR.y < pSide.hips.y);
// 双腿分开
check('双腿分开（横向距离 > 0.2m）', Math.abs(pSide.kneeL.x - pSide.kneeR.x) > 0.2 || Math.abs(pSide.kneeL.z - pSide.kneeR.z) > 0.2);
// 小腿下落：脚低于膝、且位于膝的朝向方向前方
check('脚低于膝', pSide.footL.y < pSide.kneeL.y && pSide.footR.y < pSide.kneeR.y);
check('脚在膝前方', vdot(vsub(pSide.footL, pSide.kneeL), pSide.f) > 0.1);
// 脚接近地面
check('脚接近地面（< 0.15m）', pSide.footL.y - side.y < 0.15 && pSide.footR.y - side.y < 0.15);

// --- 手：常态搭在膝上 ---
check('常态左手接近左膝', vlen(vsub(pSide.handL, pSide.kneeL)) < 0.12);
check('常态右手接近右膝', vlen(vsub(pSide.handR, pSide.kneeR)) < 0.12);

// --- 手：欢呼时举起（高于肩） ---
check('欢呼时左手高于肩', pSideCheer.handL.y > pSideCheer.shoulder.y);
check('欢呼时右手高于肩', pSideCheer.handR.y > pSideCheer.shoulder.y);
check('欢呼时手明显高于常态', pSideCheer.handL.y > pSide.handL.y + 0.25);

// --- 欢呼起跳浮动 ---
check('欢呼时髋有起伏（不同相位不同高度）',
  TTG.seatedPose(side, 1.0, 1).hips.y !== TTG.seatedPose({ ...side, ph: side.ph + Math.PI }, 1.0, 1).hips.y);

// --- 摇头（失望）：头部左右快速摆动，手仍搭膝 ---
const pShake = TTG.seatedPose(side, 1.0, 0, 1);
check('摇头：头部左右偏移', Math.abs(pShake.head.x - side.x) > 0.01);
check('摇头：不同相位头部位置不同',
  TTG.seatedPose(side, 1.0, 0, 1).head.x !== TTG.seatedPose({ ...side, ph: side.ph + Math.PI }, 1.0, 0, 1).head.x);
check('摇头时手不举起（仍搭膝）', vlen(vsub(pShake.handL, pShake.kneeL)) < 0.12);

// --- 朝向在欢呼时保持不变 ---
check('欢呼时朝向不变', Math.abs(pSideCheer.f.x - pSide.f.x) < 0.01 && Math.abs(pSideCheer.f.z - pSide.f.z) < 0.01);

console.log(failures === 0 ? '\n坐姿火柴人骨架验证全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
