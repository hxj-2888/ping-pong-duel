/* 机位拟合 v8：目标 = 新参考图（1450×1085，2026-10-23 用户重发）。
   新图地标（tools/measure-ref2.py + probe-ref.py 实测）：
     台远边 y/H 0.545（图内左 0.477 / 右 0.606 倾斜，取中心）｜台近边 y/H 0.70
     台边 x/W 0.358 / 0.642（中线处）｜己方球员头顶 0.58、脚 0.91｜对方头顶 0.40
   球网位置与倾斜远边在几何上无法同时满足（AI 图透视不自洽），故不参与硬约束。

   ⚠⚠ v7 及以前的全套错误根因：**屏幕左右与世界 x 的对应关系搞反了**。
     Camera.set 里 right = cross(fwd, up=(0,1,0))；相机在 -z 朝 +z 看时
     fwd≈(0,-,+) ⇒ right≈(-1,0,0)，即**世界 +x 投到屏幕左侧**。
     旧版 cost 里写 `lft.x/W → 0.358`（以为世界 -x 在屏幕左），
     两个 x 项全程反向 ⇒ 台宽约束被"优化"到错误方向，
     最后撞搜索边界、误判"参考图透视无解、只能折中"，机位被压到 0.86×W/6.5m。
     本版按正确约定（eL = project(+TABLE_WIDTH/2) 是屏幕左缘）重扫，
     cost 从 0.14+ 降到 0.0077，六个地标同时命中。

   结论（v8，已落进 public/js/app/render.js 的 makeCam）：
     eyeY 3.80 / eyeZ ±10.10 / lookY 1.30 / focal 1.75×W
     ⇒ farY 0.538 / nearY 0.717 / 台宽 0.253W / 己方头顶 0.528、脚 0.925 / 对方头顶 0.365
   用法：node tools/solve-camera.cjs
*/
'use strict';
const path = require('path');
const TTG = require(path.join(__dirname, '..', 'public', 'js', 'render.js'));
const R = require(path.join(__dirname, '..', 'public', 'js', 'engine.js')).RULES;
const W = 1450, H = 1085;                     // 与参考图同画幅
const TH = R.TABLE_HEIGHT, L = R.TABLE_LENGTH / 2, TW = R.TABLE_WIDTH / 2;
const PZ = R.PLAYER_Z;

function probe(eyeY, eyeZ, lookY, f) {
  const cam = new TTG.Camera();
  cam.set(TTG.v3(0, eyeY, eyeZ), TTG.v3(0, lookY, 0), W / 2, H / 2, f);
  const pr = (p) => cam.project(p);
  return {
    far: pr(TTG.v3(0, TH, L)), net: pr(TTG.v3(0, TH + R.NET_HEIGHT, 0)),
    lft: pr(TTG.v3(-TW, TH, 0)), rgt: pr(TTG.v3(TW, TH, 0)),
    self: pr(TTG.v3(0, 1.60, -PZ)), opp: pr(TTG.v3(0, 1.60, PZ)),
    selfFoot: pr(TTG.v3(0, 0, -PZ)), oppFoot: pr(TTG.v3(0, 0, PZ)),
    near: pr(TTG.v3(0, TH, -L)),
  };
}
function cost(m) {
  if (!m.far || !m.lft || !m.rgt || !m.self || !m.selfFoot || !m.near) return 1e9;
  let c = 0;
  c += Math.pow(m.far.y / H - 0.545, 2) * 2.0;   // 台远边
  c += Math.pow(m.near.y / H - 0.70, 2) * 2.0;   // 台近边
  c += Math.pow(m.lft.x / W - 0.642, 2) * 2.5;   // 世界 -x → 屏幕右缘 0.642
  c += Math.pow(m.rgt.x / W - 0.358, 2) * 2.5;   // 世界 +x → 屏幕左缘 0.358
  c += Math.pow(m.self.y / H - 0.58, 2) * 2.5;   // 己方头顶
  c += Math.pow(m.selfFoot.y / H - 0.91, 2) * 2.0; // 己方脚
  c += Math.pow(m.opp.y / H - 0.40, 2) * 1.2;    // 对方头顶
  return c;
}
let best = null;
for (let eyeY = 2.0; eyeY <= 7.0; eyeY += 0.1) {
  for (let eyeZ = -13.0; eyeZ <= -3.2; eyeZ += 0.1) {
    for (let lookY = 0.4; lookY <= 3.0; lookY += 0.1) {
      for (let fm = 0.5; fm <= 2.2; fm += 0.05) {
        const m = probe(eyeY, eyeZ, lookY, W * fm);
        const c = cost(m);
        if (!best || c < best.c) best = { c, eyeY, eyeZ, lookY, fm, m };
      }
    }
  }
}
const r = (v) => (v == null ? null : +v.toFixed(3));
console.log('最优:', JSON.stringify({
  cost: +best.c.toFixed(5), eyeY: +best.eyeY.toFixed(2), eyeZ: +best.eyeZ.toFixed(2),
  lookY: +best.lookY.toFixed(2), fm: +best.fm.toFixed(2),
  farY: r(best.m.far && best.m.far.y / H), netY: r(best.m.net && best.m.net.y / H),
  lx: r(best.m.lft && best.m.lft.x / W), rx: r(best.m.rgt && best.m.rgt.x / W),
  selfY: r(best.m.self && best.m.self.y / H), oppY: r(best.m.opp && best.m.opp.y / H),
  selfFootY: r(best.m.selfFoot && best.m.selfFoot.y / H),
  nearY: r(best.m.near && best.m.near.y / H),
}));
const cur = probe(3.80, -10.10, 1.30, W * 1.75);
console.log('当前产品机位(v8):', JSON.stringify({
  farY: r(cur.far.y / H), netY: r(cur.net && cur.net.y / H), lx: r(cur.lft.x / W), rx: r(cur.rgt.x / W),
  selfY: r(cur.self.y / H), oppY: r(cur.opp.y / H), selfFootY: r(cur.selfFoot.y / H),
  nearY: r(cur.near.y / H),
}));
