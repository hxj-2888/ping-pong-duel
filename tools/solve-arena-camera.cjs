/* 把相机标定到底板里"烘死"的球台。
   底板 public/assets/arena/arena_plate.jpg 里已经画好球台（去掉了球员/HUD）。
   只要真实球台（2.74×1.525，台高 0.76）投影到这四个角，后面用同一相机画的
   球员就会正好站在底板的球台上，不会错位。

   实测四角（归一化，tools/probe-table-corners.py 输出）：
     远边  y=0.5481  xL=0.4274  xR=0.5624
     近边  y=0.9492  xL=0.3720  xR=0.6521

   用法：node tools/solve-arena-camera.cjs
*/
'use strict';
const path = require('path');
const TTG = require(path.join(__dirname, '..', 'public', 'js', 'render.js'));
const R = require(path.join(__dirname, '..', 'public', 'js', 'engine.js')).RULES;
const W = 1280, H = 720;
const TH = R.TABLE_HEIGHT, L = R.TABLE_LENGTH / 2, TW = R.TABLE_WIDTH / 2;

// 目标四角（屏幕归一化）
const T = {
  farL: { x: 0.4274, y: 0.5481 },
  farR: { x: 0.5624, y: 0.5481 },
  nearL: { x: 0.3720, y: 0.9492 },
  nearR: { x: 0.6521, y: 0.9492 },
};

function probe(eyeY, eyeZ, lookY, f) {
  const cam = new TTG.Camera();
  cam.set(TTG.v3(0, eyeY, eyeZ), TTG.v3(0, lookY, 0), W / 2, H / 2, f);
  const pr = (p) => cam.project(p);
  return {
    // 世界 -x 投到屏幕右侧（相机朝 +z 看），所以 farL 对应世界 x=+TW
    farL: pr(TTG.v3(TW, TH, L)),
    farR: pr(TTG.v3(-TW, TH, L)),
    nearL: pr(TTG.v3(TW, TH, -L)),
    nearR: pr(TTG.v3(-TW, TH, -L)),
  };
}

function cost(m) {
  if (!m.farL || !m.farR || !m.nearL || !m.nearR) return 1e9;
  let c = 0;
  const add = (q, t, w) => {
    c += w * (Math.pow(q.x / W - t.x, 2) + Math.pow(q.y / H - t.y, 2));
  };
  add(m.farL, T.farL, 1.0);
  add(m.farR, T.farR, 1.0);
  add(m.nearL, T.nearL, 1.0);
  add(m.nearR, T.nearR, 1.0);
  return c;
}

let best = null;
for (let eyeY = 2.0; eyeY <= 9.0; eyeY += 0.05) {
  for (let eyeZ = -10.0; eyeZ <= -3.0; eyeZ += 0.05) {
    for (let lookY = 0.4; lookY <= 2.6; lookY += 0.05) {
      for (let fm = 0.5; fm <= 2.4; fm += 0.05) {
        const m = probe(eyeY, eyeZ, lookY, W * fm);
        const c = cost(m);
        if (!best || c < best.c) best = { c, eyeY, eyeZ, lookY, fm, m };
      }
    }
  }
}

const r4 = (v) => +v.toFixed(4);
console.log(JSON.stringify({
  cost: +best.c.toFixed(6),
  eyeY: +best.eyeY.toFixed(2), eyeZ: +best.eyeZ.toFixed(2),
  lookY: +best.lookY.toFixed(2), fm: +best.fm.toFixed(2),
  got: {
    farL: [r4(best.m.farL.x / W), r4(best.m.farL.y / H)],
    farR: [r4(best.m.farR.x / W), r4(best.m.farR.y / H)],
    nearL: [r4(best.m.nearL.x / W), r4(best.m.nearL.y / H)],
    nearR: [r4(best.m.nearR.x / W), r4(best.m.nearR.y / H)],
  },
  want: T,
}, null, 1));

// 当前产品机位对照
const cur = probe(4.30, -5.60, 1.48, W * 1.10);
console.log('当前机位 4.30/-5.60/1.48/1.10:', JSON.stringify({
  farL: [r4(cur.farL.x / W), r4(cur.farL.y / H)],
  farR: [r4(cur.farR.x / W), r4(cur.farR.y / H)],
  nearL: [r4(cur.nearL.x / W), r4(cur.nearL.y / H)],
  nearR: [r4(cur.nearR.x / W), r4(cur.nearR.y / H)],
}));
