/* 开发工具：在 Node 中数值搜索相机参数，使观众席落入画面（纯数学，无浏览器） */
'use strict';
const path = require('path');
const TTG = require(path.join(__dirname, '..', 'public', 'js', 'render.js'));
const { v3, Camera, crowdLayout } = TTG;

const VW = 1250, VH = 625, CX = VW / 2, CY = VH / 2;

// 观众采样点：身体底部(y+0.15)与头顶(y+0.55)，含欢呼浮动
function crowdPoints() {
  const pts = [];
  for (const s of crowdLayout()) {
    pts.push({ x: s.x, y: s.y + 0.12, z: s.z });
    pts.push({ x: s.x, y: s.y + 0.55, z: s.z });
  }
  return pts;
}

// 评估相机：返回观众在画面内的比例、包围盒、以及关键元素（球台/球员）位置
function evaluate(eye, look, focal) {
  const cam = new Camera();
  cam.set(eye, look, CX, CY, focal);
  const pts = crowdPoints();
  let inW = 0, inH = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const p of pts) {
    const q = cam.project(p);
    if (!q) continue;
    if (q.x >= 0 && q.x <= VW && q.y >= 0 && q.y <= VH) inW++, inH++;
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
  }
  // 关键元素
  const key = (p) => { const q = cam.project(p); return q ? [Math.round(q.x), Math.round(q.y)] : null; };
  const table = key(v3(0, 0.76, 0));
  const nearFeet = key(v3(0, 0.05, -1.65));
  const nearHead = key(v3(0, 1.7, -1.65));
  const farPlayer = key(v3(0, 0.9, 1.65));
  return {
    total: pts.length,
    visible: inW, visibleH: inH,
    bbox: `x[${Math.round(minX)}..${Math.round(maxX)}] y[${Math.round(minY)}..${Math.round(maxY)}]`,
    table, nearFeet, nearHead, farPlayer,
  };
}

// 候选相机参数表
const candidates = [
  { name: '当前', eye: v3(0, 4.6, -4.2), look: v3(0, 0.75, 0), focal: VW * 1.0 },
  { name: '拉高视点', eye: v3(0, 4.6, -4.2), look: v3(0, 1.6, 0), focal: VW * 1.0 },
  { name: '广角+高视点', eye: v3(0, 5.2, -4.6), look: v3(0, 1.8, 0), focal: VW * 0.9 },
  { name: '高视点+远距', eye: v3(0, 6.2, -5.4), look: v3(0, 2.0, 0), focal: VW * 1.0 },
  { name: '超高俯视', eye: v3(0, 6.6, -4.8), look: v3(0, 2.2, 0), focal: VW * 1.0 },
  { name: '宽FOV+中高', eye: v3(0, 5.0, -4.4), look: v3(0, 1.6, 0), focal: VW * 0.72 },
  { name: '宽FOV+高视点', eye: v3(0, 5.4, -4.6), look: v3(0, 1.8, 0), focal: VW * 0.72 },
  { name: '远拉+宽FOV', eye: v3(0, 7.0, -6.2), look: v3(0, 1.9, 0), focal: VW * 0.8 },
  { name: '远拉+中FOV', eye: v3(0, 7.2, -6.4), look: v3(0, 2.0, 0), focal: VW * 0.95 },
  { name: '高+远+宽', eye: v3(0, 8.0, -7.0), look: v3(0, 2.1, 0), focal: VW * 0.85 },
  { name: '中高+宽FOV2', eye: v3(0, 5.6, -5.0), look: v3(0, 1.9, 0), focal: VW * 0.75 },
  { name: '中高+宽FOV3', eye: v3(0, 6.0, -5.2), look: v3(0, 2.0, 0), focal: VW * 0.78 },
  { name: '放低A', eye: v3(0, 4.6, -4.6), look: v3(0, 1.4, 0), focal: VW * 0.85 },
  { name: '放低B', eye: v3(0, 4.2, -4.8), look: v3(0, 1.5, 0), focal: VW * 0.9 },
  { name: '放低C', eye: v3(0, 4.4, -5.0), look: v3(0, 1.6, 0), focal: VW * 0.88 },
  { name: '放低D', eye: v3(0, 3.9, -4.7), look: v3(0, 1.5, 0), focal: VW * 0.92 },
  { name: '放低E', eye: v3(0, 4.8, -5.2), look: v3(0, 1.7, 0), focal: VW * 0.9 },
  { name: '放低F', eye: v3(0, 4.3, -4.9), look: v3(0, 1.6, 0), focal: VW * 0.95 },
  { name: '放低G', eye: v3(0, 4.1, -5.0), look: v3(0, 1.7, 0), focal: VW * 0.92 },
  { name: '放低H', eye: v3(0, 4.0, -4.5), look: v3(0, 1.3, 0), focal: VW * 0.85 },
];

for (const c of candidates) {
  const r = evaluate(c.eye, c.look, c.focal);
  console.log(`\n[${c.name}] eye=(${c.eye.x},${c.eye.y},${c.eye.z}) look=(${c.look.x},${c.look.y},${c.look.z}) focal=${c.focal}`);
  console.log(`  观众可见 ${r.visible}/${r.total}（画面内），包围盒 ${r.bbox}`);
  console.log(`  球台中心=${r.table} 近侧球员(脚/头)=${r.nearFeet}/${r.nearHead} 远侧球员=${r.farPlayer}`);
}
