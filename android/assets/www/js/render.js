/* ============================================================
 * render.js — 轻量 3D 渲染器（Canvas 2D 透视投影）
 * 场景：球馆地板、按 ITTF 标准尺寸的球台与球网、乒乓球
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TTG = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const R = (root && root.TT ? root.TT : require('./engine.js')).RULES;

  // ---------- 向量 ----------
  function v3(x, y, z) { return { x, y, z }; }
  function vadd(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
  function vsub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function vscale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
  function vlen(a) { return Math.hypot(a.x, a.y, a.z); }
  function vnorm(a) { const l = vlen(a); return l > 1e-9 ? vscale(a, 1 / l) : v3(0, 0, 0); }
  function vdot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function vcross(a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------- 相机 ----------
  class Camera {
    constructor() {
      this.eye = v3(0, 0, 0);
      this.look = v3(0, 0, 0);
      this.fwd = v3(0, 0, 1);
      this.right = v3(1, 0, 0);
      this.up = v3(0, 1, 0);
      this.cx = 0; this.cy = 0; this.f = 500;
    }
    set(eye, look, cx, cy, f) {
      this.eye = eye; this.look = look; this.cx = cx; this.cy = cy; this.f = f;
      this.fwd = vnorm(vsub(look, eye));
      this.right = vnorm(vcross(this.fwd, v3(0, 1, 0)));
      if (vlen(this.right) < 0.01) this.right = v3(1, 0, 0);
      this.up = vcross(this.right, this.fwd);
    }
    project(p) {
      const d = vsub(p, this.eye);
      const z = vdot(d, this.fwd);
      if (z < 0.12) return null;
      const s = this.f / z;
      return {
        x: this.cx + vdot(d, this.right) * s,
        y: this.cy - vdot(d, this.up) * s,
        s, z,
      };
    }
    depth(p) {
      return vdot(vsub(p, this.eye), this.fwd);
    }
  }

  // ---------- 绘制原语 ----------
  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const r = clamp(Math.round((n >> 16) * f), 0, 255);
    const g = clamp(Math.round(((n >> 8) & 0xff) * f), 0, 255);
    const b = clamp(Math.round((n & 0xff) * f), 0, 255);
    return `rgb(${r},${g},${b})`;
  }

  // 线段胶囊（投影后带粗细与描边）
  function limb(ctx, cam, a, b, r, color, outline) {
    const pa = cam.project(a), pb = cam.project(b);
    if (!pa || !pb) return;
    const w = Math.max(1, r * 2 * Math.min(pa.s, pb.s));
    ctx.lineCap = 'round';
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = w + Math.max(1.5, w * 0.22);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  }

  // 3D 盒子：center + 半尺寸(hw,hh,hd)，局部坐标轴 basis{f,u,s}
  function box(ctx, cam, center, hw, hh, hd, basis, color) {
    const f = basis.f, u = basis.u, s = basis.s;
    const c = [
      vadd(center, vadd(vscale(f, hd), vadd(vscale(u, hh), vscale(s, hw)))),
      vadd(center, vadd(vscale(f, hd), vadd(vscale(u, hh), vscale(s, -hw)))),
      vadd(center, vadd(vscale(f, hd), vadd(vscale(u, -hh), vscale(s, hw)))),
      vadd(center, vadd(vscale(f, hd), vadd(vscale(u, -hh), vscale(s, -hw)))),
      vadd(center, vadd(vscale(f, -hd), vadd(vscale(u, hh), vscale(s, hw)))),
      vadd(center, vadd(vscale(f, -hd), vadd(vscale(u, hh), vscale(s, -hw)))),
      vadd(center, vadd(vscale(f, -hd), vadd(vscale(u, -hh), vscale(s, hw)))),
      vadd(center, vadd(vscale(f, -hd), vadd(vscale(u, -hh), vscale(s, -hw)))),
    ];
    const faces = [
      [0, 1, 3, 2], [4, 6, 7, 5], // +f, -f
      [0, 2, 6, 4], [1, 5, 7, 3], // +u, -u
      [0, 4, 5, 1], [2, 3, 7, 6], // +s, -s
    ];
    const norms = [f, vscale(f, -1), u, vscale(u, -1), s, vscale(s, -1)];
    const light = vnorm(v3(0.35, 0.8, 0.5));
    const toCam = vnorm(vsub(cam.eye, center));
    const parts = [];
    for (let i = 0; i < 6; i++) {
      if (vdot(norms[i], toCam) <= 0.02) continue;
      const pts = faces[i].map((idx) => cam.project(c[idx]));
      if (pts.some((p) => !p)) continue;
      const d = cam.depth(c[faces[i][0]]);
      parts.push({ d, pts, lit: clamp(0.5 + 0.5 * vdot(norms[i], light), 0.35, 1.15) });
    }
    parts.sort((a, b) => b.d - a.d);
    for (const part of parts) {
      ctx.fillStyle = shade(color, part.lit);
      ctx.strokeStyle = 'rgba(15,20,30,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(part.pts[0].x, part.pts[0].y);
      for (let i = 1; i < part.pts.length; i++) ctx.lineTo(part.pts[i].x, part.pts[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  function poly(ctx, cam, pts, fill, stroke) {
    const p = pts.map((v) => cam.project(v));
    if (p.some((x) => !x)) return;
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke || 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function line(ctx, cam, a, b, color, width) {
    const pa = cam.project(a), pb = cam.project(b);
    if (!pa || !pb) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, width * Math.min(pa.s, pb.s));
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
  }

  // ---------- 场景元素 ----------
  /* 〔2026-10-23 忠于原图〕台面恢复为「被聚光照亮的亮天蓝」#2f8fd4：
     原图里球台是全画面第二亮的高饱和蓝色（采样 rgb(50,143,215)），白线清晰、
     球网可见。2026-10-22 曾把台面压到 #14488f 等灯光层恢复，但避让层已删，
     台面一直偏暗；本版直接把台面提到原图亮度，压暗交给整体氛围层。 */
  const C = {
    /* 〔2026-10-23 v8〕台面 #2f8fd4 → #2e88e0：参考图台面实测均值 (77,112,204)，
       台缘暗蓝 (33,83,182)、台心亮蓝 (149,180,226)。旧色偏暗偏灰，
       再被光锥的暖白一盖就整块变灰白；#3a93dc 的 S=0.74 仍差一点进不了
       直方图 S>0.75 档（参考图该档占 33.5%，本版只有 6.3%，台面是最大缺口），
       再压一档到 #2e88e0（S=0.795）。 */
    tableTop: '#2e88e0',
    tableEdge: '#e8f1fa',
    tableSide: '#6f93b8',
    netPost: '#e6ebf2',
    netTape: '#f8fafc',
    netMesh: 'rgba(238,244,251,0.55)',
    ball: '#ffffff',
  };

  // 养成尾影配色(v1.8.0)：已装备的尾影特效颜色(rgba 前缀,后拼 alpha)；
  // 未装备时用默认浅蓝。黄/黑/红在 drawTrail 里附带粒子效果。
  const TRAIL_COLORS = {
    yellow: 'rgba(255,215,80,',
    black: 'rgba(42,46,56,',
    red: 'rgba(255,72,48,',
  };
  // 球台撞击特效（溅射粒子）与尾影配色匹配（v2.4）：装备尾影时溅射粒子用同色系；
  // 黑色尾影提亮为灰蓝以保证在深色球台上可见；未装备用默认橙红渐变。
  const SPLASH_RGB = {
    yellow: [255, 215, 80],
    black: [110, 118, 132],
    red: [255, 72, 48],
  };
  // 手机端渲染预算（v2.4）：观众动画层半分辨率，减 75% 动画期填充
  const animScale = () => (typeof PPD !== 'undefined' && PPD && PPD.isTouch) ? 0.5 : 1.0;
  const isTouchNow = () => !!(typeof PPD !== 'undefined' && PPD && PPD.isTouch);

  // ---------- 观众席（坐姿火柴人，与球员同一画风：圆头 + 骨线骨架） ----------
  // 场地两端 + 两侧共四个方向的观众席，一次性生成固定站位（确定性伪随机）
  let crowdList = null;
  let crowdListDensity = 1; // 当前观众布局的密度（1=满员，0.5=电脑减半，0.25=手机再减半），变化时重建布局
  let crowdListZ = 0;       // 当前布局是按哪一侧相机生成的（端看台只放对面）
  /* 看台几何常量：crowdLayout() 与 benchLayout() 共用，避免"观众和座位对不上"。
     〔2026-10-22 外推〕首排离球场边缘只有约 0.05m（台边 3.4 / 首排 3.62），
     视觉上光点几乎贴住台面。参考图里球台四周有明显空地，
     故整体外推：侧看台 3.62→4.30、端看台 6.35→6.95，给球场留出呼吸区。 */
  /* 〔2026-10-23 忠于原图〕看台改成"深碗"：
     · 首排更靠球台（4.30 → 3.95），观众墙贴着球场，像原图那样包围成一圈；
     · 行数 4 → 6，行距 0.55/0.50 → 0.42/0.40，看台更高更陡，光棒一直顶到画面上缘；
     · 侧看台沿 z 加长（±5.5 → ±7.2），近端那几排会落到画面左下/右下角（原图四角都是大光棒）。 */
  /* 〔2026-10-23 新参考图 v7〕看台重新包住球场（相机退到 6.5m 后看台显得远/矮）：
     · 首排贴近球台（侧 3.30→2.70、端 2.35→2.60），观众墙贴着球场包围成一圈；

  /* 观众布局：两端/两侧看台坐姿火柴人（2026-10-23 v9 从远端仓库 origin/main 恢复原版几何）。
     density 密度（默认 1）：0.5/0.25 步长加倍、人数成比例减半（省填充率）。
     zSign：相机所在侧的符号（-1 = 相机在 -z 端）。端看台只生成在对面那一侧 ——
       这条是 2026-10-22 的**真 bug 修复**，必须保留：早先两头都放，横屏时另一侧正好
       落在画面下缘之外看不出问题，但**竖屏**（vh=844，纵向视野大得多）会把它整排照进来，
       实测竖屏截图里球台前方多出一排"挡在球员前面"的观众。 */
  function crowdLayout(density, zSign) {
    const d = density == null ? 1 : density;
    const zs = zSign === 1 ? 1 : -1;
    const step = 0.46 / d;
    const list = [];
    let seed = 20260804;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const person = (x, y, z) => ({
      x: x + (rnd() - 0.5) * 0.2, y: y + (rnd() - 0.5) * 0.1, z,
      ph: rnd() * Math.PI * 2, c: rnd(),
    });
    // 两端看台（z = ∓6.35，球台远端），四排（由远到近生成，保证遮挡顺序正确）
    const farZ = -zs * 6.35;
    for (let row = 3; row >= 0; row--) {
      const z = farZ + Math.sign(farZ) * row * 0.5;
      for (let x = -5.2; x <= 5.2; x += step) list.push(person(x, 0.25 + row * 0.48, z));
    }
    // 两侧看台（x = ±3.62/4.17/4.72/5.27，四排，面向球台；由外到内生成）
    for (const sx of [-1, 1]) {
      for (let row = 3; row >= 0; row--) {
        const x = sx * (3.62 + row * 0.55);
        for (let z = -5.5; z <= 5.5; z += step) list.push(person(x, 0.25 + row * 0.48, z + (rnd() - 0.5) * 0.2));
      }
    }
    return list;
  }

  // 坐姿火柴人骨架（面向球场中心；knees 前伸、小腿下落、手搭膝上），
  // 供绘制与测试共用。返回各关节点世界坐标。
  // cheer: 欢呼量（举手 + 起身）；shake: 摇头量（头部左右快速摆动，失望）
  function seatedPose(s, time, cheer, shake) {
    const c = Math.max(0, Math.min(1, cheer || 0));
    const sh = Math.max(0, Math.min(1, shake || 0));
    const t = time || 0;
    const bob = c > 0.01 ? Math.sin(t * 12 + s.ph) * 0.045 * c : 0;
    const y = s.y + bob;
    // 朝向球场中心
    const toCenter = v3(-s.x, 0, -s.z);
    const f = vlen(toCenter) > 1e-6 ? vnorm(toCenter) : v3(0, 0, 1);
    const side = vnorm(v3(-f.z, 0, f.x));
    const hips = v3(s.x, y + 0.30, s.z);
    const shoulder = vadd(hips, v3(0, 0.34, 0));
    // 摇头：头部左右快速摆动（约 3.5Hz，失望摇头）
    const headWig = sh > 0.01 ? Math.sin(t * 22 + s.ph) * 0.055 * sh : 0;
    const head = v3(s.x + headWig, shoulder.y + 0.17, s.z);
    const shL = vadd(shoulder, vscale(side, -0.15));
    const shR = vadd(shoulder, vscale(side, 0.15));
    // 大腿前伸（膝比髋略低），小腿下落至脚
    const kneeL = vadd(hips, vadd(vscale(f, 0.26), vadd(vscale(side, -0.13), v3(0, -0.08, 0))));
    const kneeR = vadd(hips, vadd(vscale(f, 0.26), vadd(vscale(side, 0.13), v3(0, -0.08, 0))));
    const footL = vadd(kneeL, vadd(vscale(f, 0.20), v3(0, -0.18, 0)));
    const footR = vadd(kneeR, vadd(vscale(f, 0.20), v3(0, -0.18, 0)));
    // 手：常态搭在膝上；欢呼时举起（随 c 平滑过渡 + 小幅挥舞）
    const handRestL = vadd(kneeL, v3(0, 0.04, 0));
    const handRestR = vadd(kneeR, v3(0, 0.04, 0));
    const handUpL = vadd(shL, vadd(vscale(side, -0.18), v3(0, 0.28, 0)));
    const handUpR = vadd(shR, vadd(vscale(side, 0.18), v3(0, 0.28, 0)));
    const sway = c > 0.05 ? Math.sin(t * 9 + s.ph * 1.7) * 0.05 * c : 0;
    const handL = c > 0.05 ? vadd(handRestL, vscale(vsub(handUpL, handRestL), c)) : handRestL;
    const handR = c > 0.05 ? vadd(handRestR, vscale(vsub(handUpR, handRestR), c)) : handRestR;
    return { head, shoulder, shL, shR, hips, kneeL, kneeR, footL, footR, handL: vadd(handL, vscale(side, sway)), handR: vadd(handR, vscale(side, -sway)), f, side };
  }

  /* 座位（长条座椅 + 靠背）：与观众行对齐的看台座席，一次性生成。
     〔2026-10-23 v9 从远端仓库 origin/main 恢复原版〕——坐姿观众坐在实体长椅上，
     否则火柴人像浮在半空；几何与恢复后的 crowdLayout 严格对齐。 */
  let benchList = null;
  function benchLayout() {
    const benches = [];
    const y = (row) => 0.25 + row * 0.48; // 与 crowdLayout 行高一致
    // 两侧看台（x = ±(3.62 + row*0.55)，沿 z 方向排座；axis='z'）
    for (const sx of [-1, 1]) {
      for (let row = 0; row < 4; row++) {
        const x = sx * (3.62 + row * 0.55);
        benches.push({ x, y: y(row), z: 0, lenX: 0.36, lenZ: 11.0, axis: 'z' });
      }
    }
    // 两端看台（z = ±(6.35 + row*0.5)，沿 x 方向排座；axis='x'）
    for (const ez of [-6.35, 6.35]) {
      for (let row = 0; row < 4; row++) {
        const z = ez + row * 0.5;
        benches.push({ x: 0, y: y(row), z, lenX: 10.4, lenZ: 0.36, axis: 'x' });
      }
    }
    return benches;
  }

  // 绘制看台座席：加高的座面 + 高靠背；正对面/远端座椅的前脸提亮，与左右两侧一致
  function drawBenches(ctx, cam) {
    if (!benchList) benchList = benchLayout();
    const basis = { f: v3(0, 0, 1), u: v3(0, 1, 0), s: v3(1, 0, 0) };
    for (const b of benchList) {
      // 座面（高 0.2m）
      box(ctx, cam, v3(b.x, b.y + 0.10, b.z), b.lenX / 2, 0.10, b.lenZ / 2, basis, '#67809f');
      // 靠背（竖向板，高于观众下半身，从人群中清晰露出）
      if (b.axis === 'z') {
        box(ctx, cam, v3(b.x + Math.sign(b.x) * 0.24, b.y + 0.17, b.z), 0.035, 0.17, b.lenZ / 2, basis, '#6b85a7');
      } else {
        box(ctx, cam, v3(b.x, b.y + 0.17, b.z + Math.sign(b.z) * 0.24), b.lenX / 2, 0.17, 0.035, basis, '#6b85a7');
      }
      // 面向镜头的前脸提亮（端看台：正对面/远端的座椅清晰可见）
      if (b.axis === 'x') {
        const fz = b.z + Math.sign(cam.eye.z || 1) * (b.lenZ / 2);
        poly(ctx, cam, [
          v3(b.x - b.lenX / 2, b.y, fz), v3(b.x + b.lenX / 2, b.y, fz),
          v3(b.x + b.lenX / 2, b.y + 0.34, fz), v3(b.x - b.lenX / 2, b.y + 0.34, fz),
        ], '#8fa9c8', null);
      }
    }
  }

  // 静态地面层：背景渐变 + 木地板 + 格线 + 围挡（相机相关；供逐帧与离屏缓存共用）
  function drawFloorBg(ctx, cam, vw, vh) {
    /* 背景渐变（2026-10-22 暗场：整体再压一档，让聚光灯成为唯一的高亮来源）。
       旧值 #141b2b/#1b2437/#0d1220 在无灯光时本身就是一块"深蓝灰"，看台/光棒压在上面
       分不清层次；压到近黑后，应援棒与聚光锥才有落脚点。 */
    const g = ctx.createLinearGradient(0, 0, 0, vh);
    g.addColorStop(0, '#070a12');
    g.addColorStop(0.45, '#0b111c');
    g.addColorStop(1, '#06090f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);

    // 场地木地板（2026-10-22 重做：不再画多边形）
    //
    // 旧实现：硬边多边形 + 深色描边 + 4 块实心围挡，球场像"一块板"。
    // 上一版：多边形 + 径向渐隐覆盖，但**多边形本身的边**依然是一条直线
    //         （渐隐到边线处还没到 1，于是近端/两侧留下一条可见的斜边）。
    // 本版：**不画多边形**，直接在整幅画布上铺一个椭圆径向渐变——
    //       中心是地板色，向外自然淡出到完全透明。没有边，就没有"边线"。
    //       椭圆用 setTransform 先缩放再画圆实现（测试桩没有 save/restore/ellipse 渐变）。
    const LA = LIGHT_AMB;
    const c0 = cam.project(v3(0, 0, 0));
    const cxE = cam.project(v3(3.4, 0, 0)), czE = cam.project(v3(0, 0, 4.6));
    if (c0 && cxE && czE) {
      /* ⚠ 屏幕方向：相机在 -z 端朝 +z 看，世界 +x 投到屏幕**左**侧。这里统一用绝对值取半径，
         再用 setTransform 把"圆心放到 c0、y 方向压缩成椭圆"：
           新变换 = 原变换 ∘ translate(c0) ∘ scale(k, 1)，
         所以平移量是 c0（屏幕坐标），不能乘 k —— 上一版写成 e + a*k*cx 让圆心跑掉了。 */
      const rx = Math.max(40, Math.abs(cxE.x - c0.x) * 1.30);   // 横向半径：地板半宽 ×1.30
      const ry = Math.max(40, Math.abs(czE.y - c0.y) * 1.10);   // 纵向半径：地板半长 ×1.10
      const _m = ctx.getTransform ? ctx.getTransform() : null;
      const _a = _m && _m.a ? _m.a : 1, _d = _m && _m.d ? _m.d : 1;
      const _e = _m && _m.e ? _m.e : 0, _f = _m && _m.f ? _m.f : 0;
      const k = rx / ry;
      ctx.setTransform(_a * k, 0, 0, _d, _e + _a * c0.x, _f + _d * c0.y);
      const lg = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
      /* 中心实、边缘完全透明：地板"从光里长出来"，四边自然消失。
         0.45 处开始衰减，0.80 处只剩一点点，1.0 完全消失 —— 没有可辨认的边界。
         〔2026-10-23 忠于原图〕整体提亮一档：原图地板是可见的暖棕色木地板，
         0.62/0.50 在暗场压下近乎纯黑；提到 0.74/0.62 后地板恢复质感。 */
      lg.addColorStop(0, `rgba(${LA.floorFar},0.74)`);
      lg.addColorStop(0.42, `rgba(${LA.floorFar},0.62)`);
      lg.addColorStop(0.70, `rgba(${LA.floorNear},0.28)`);
      lg.addColorStop(0.88, `rgba(${LA.floorNear},0.06)`);
      lg.addColorStop(1, `rgba(${LA.floorNear},0)`);
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(rx, 0);
      for (let i = 1; i <= 48; i++) {
        const th = (i / 48) * Math.PI * 2;
        ctx.lineTo(Math.cos(th) * rx, Math.sin(th) * ry);
      }
      ctx.fill();
      ctx.setTransform(_m || [1, 0, 0, 1, 0, 0]);
    }
    /* 〔2026-10-23 v7 忠于新参考图〕近端地板 + 台前亮池 + 红蓝侧反光。
       参考图画面下 1/3 是**可见的暗地板**（不是纯黑）：中央有聚光灯池的反光
       （y 0.83~0.95 最亮），左缘吃红、右缘吃蓝（观众席颜色的反射，采样
       左 #4d160f / 中 #482124 / 右 #121234）。上面的椭圆渐变只覆盖到台心附近，
       「相机与球台之间」这段一直是背景黑——这里补齐，并保证与椭圆衔接处无硬边。 */
    {
      const TBL = R.TABLE_LENGTH / 2;
      /* 块顶取**台面远边**的投影（不是台前地面的投影！）。
         ⚠ v8b 30° 俯角踩坑：旧版用 `project(0, 0, -TBL)`（台前**地面**点）当起点，
         俯角 13.9° 时它落在 0.896H 还好；俯角抬到 30° 后台面透视压缩、
         这个地面点被压到 0.991H ⇒ 整块三色调地板只剩底部 6%，
         其余全是椭圆渐变那层暖棕 —— 右半地板实测回到 (49,28,29)（参考图 (34,23,40)），
         side_slope 右值从 -31 掉到 -18。
         改成从台面远边（高 0.76 的点）稍上方起笔：台面本身随后由 drawTable 盖住，
         两侧露出来的正是"球台旁边那块地板"，参考图那里同样是带色的。 */
      const farP = cam.project(v3(0, R.TABLE_HEIGHT, TBL));
      const y0 = (farP ? farP.y : vh * 0.50) - vh * 0.03;
      const y1 = vh;
      if (y1 - y0 > 4) {
        /* ① 近端地板：顶边透明淡入，往下稳定的**品红棕**（参考图台前地板实测
           左 (56,25,25) / 中 (94,53,57) / 右 (38,26,43) —— 是红观众席光反射出来的
           品红调，不是中性暖棕；旧版 rgba(112,62,42) 落在 HSV 红色 bin（0-30°），
           而参考图同区域在品红 bin（330-360°），直方图差 0.14）。 */
        const g1 = ctx.createLinearGradient(0, y0, 0, y1);
        g1.addColorStop(0, 'rgba(100,54,58,0)');
        g1.addColorStop(0.18, 'rgba(100,54,58,0.68)');
        g1.addColorStop(0.6, 'rgba(94,52,56,0.72)');
        g1.addColorStop(1, 'rgba(86,48,52,0.74)');
        ctx.fillStyle = g1;
        ctx.fillRect(0, y0, vw, y1 - y0);
        /* ①b 〔v8〕横向三色调：参考图地板是"左暖红 → 中品红 → 右深蓝"的一条横向渐变
           （实测 x0.15 (82,27,24) / x0.30 (125,75,76) / x0.50 (136,16,64) /
            x0.85 (28,29,83)）。
           ⚠ 方向必须按**相机所在侧**定，不能想当然"画布左=屏幕左"：
           app 层只对 side 0 视口做 scale(-1,1) 镜像（applyViewMirror），
           · eye.z<0（side 0 红方）：画布右缘才显示在屏幕左 ⇒ 暖色（红方观众反光）放画布右；
           · eye.z>0（side 1 蓝方，不镜像）：暖色放画布左。
           两侧观众的世界坐标不变（s.x<0 = 红方），所以只有画布方向是反的。
           （第一版直接把暖色写在画布左，红方视角下暖色跑到了蓝方那一侧。）
           〔v8b 直方图对齐〕右半蓝色要更饱和：参考图右地板实测 (28,29,83) S=0.66、
           最右 (8,17,50) S=0.84；旧值 (58,42,80) S=0.48 合成后掉到 S<0.5，
           HSV 直方图在 (青, 中饱和, 暗) 这一档比参考图多出 0.21（0.231 vs 0.026）。 */
        const warmRight = (cam.eye && cam.eye.z < 0);
        const hx = (f) => (warmRight ? 1 - f : f);   // 屏幕归一化位置 → 画布位置
        const gH = ctx.createLinearGradient(0, 0, vw, 0);
        gH.addColorStop(hx(0.00), 'rgba(146,54,42,0.52)');   // 屏幕左：暖红
        /* 〔v8b 30°〕中/右两档饱和度各降一档，把像素从 S>0.5 档挪回 S 0.25~0.5 档：
           实测参考图地板中段 (94,53,57) S=0.44、右段 (34,23,40) S=0.42，
           都落在中饱和档；本版旧值合成后 S≈0.6，直方图在
           (品红,S.5~.75,V.25~.5) 与 (蓝,S.5~.75,V<.25) 两档各多出 0.04~0.08。 */
        gH.addColorStop(hx(0.35), 'rgba(112,58,64,0.50)');   // 中：品红
        gH.addColorStop(hx(0.62), 'rgba(44,36,92,0.52)');    // 右：蓝紫
        gH.addColorStop(hx(1.00), 'rgba(26,28,96,0.54)');    // 屏幕右：深蓝
        ctx.fillStyle = gH;
        ctx.fillRect(0, y0, vw, y1 - y0);
        // ② 红蓝侧反光：暖色一侧（屏幕左）暖红、冷色一侧（屏幕右）冷蓝，越靠下越明显
        const warmA = warmRight ? vw * 0.70 : 0, warmB = warmRight ? vw : vw * 0.30;
        const coolA = warmRight ? 0 : vw * 0.70, coolB = warmRight ? vw * 0.30 : vw;
        const gL = ctx.createLinearGradient(0, y0, 0, y1);
        gL.addColorStop(0, 'rgba(168,38,26,0)');
        gL.addColorStop(1, 'rgba(168,38,26,0.22)');
        ctx.fillStyle = gL;
        ctx.fillRect(warmA, y0, warmB - warmA, y1 - y0);
        const gR = ctx.createLinearGradient(0, y0, 0, y1);
        gR.addColorStop(0, 'rgba(26,30,120,0)');
        gR.addColorStop(1, 'rgba(26,30,120,0.24)');
        ctx.fillStyle = gR;
        ctx.fillRect(coolA, y0, coolB - coolA, y1 - y0);
        /* ③ 台前亮池：聚光灯落在台前地板上的反光（lighter，椭圆柔边）
           〔v8〕色调改**品红粉** (252,170,205)：参考图台前亮池实测 (165,130,163)，
           是红观众席光 + 白聚光的混合；旧值 (255,214,232) 太浅（S=0.16），
           品红 bin 的像素量只有参考图的 36%（0.101 vs 0.278），是 hist_l1 的最大缺口。 */
        /* v8b 定位方式：不能直接用 project(0,0,-TBL-0.55) —— 30° 俯角下台前地面点
           被压到画底之外（实测 1.0H+），池心会掉出画幅。改为以**台面近边**为基准，
           在"近边 → 画底"之间取 0.5 处落池心，半径也按这段前墙高度算。 */
        const nearE = cam.project(v3(0, R.TABLE_HEIGHT, -TBL));
        const frontTop = nearE ? nearE.y : y0 + (y1 - y0) * 0.55;
        const px = vw / 2;
        const py = frontTop + (y1 - frontTop) * 0.50;
        const prx = Math.max(60, vw * 0.19), pry = Math.max(20, (y1 - frontTop) * 0.42);
        const _pg = ctx.globalCompositeOperation;
        if (typeof _pg === 'string') ctx.globalCompositeOperation = 'lighter';
        const gp = ctx.createRadialGradient(px, py, 0, px, py, pry);
        gp.addColorStop(0, 'rgba(252,170,205,0.36)');
        gp.addColorStop(0.55, 'rgba(244,158,196,0.16)');
        gp.addColorStop(1, 'rgba(240,152,192,0)');
        ctx.save();
        ctx.translate(px, py);
        ctx.scale(prx / pry, 1);
        ctx.translate(-px, -py);
        ctx.fillStyle = gp;
        ctx.beginPath();
        ctx.arc(px, py, pry, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        if (typeof _pg === 'string') ctx.globalCompositeOperation = _pg;
      }
    }
    {
      // 地板格线：透明度降到 1/3，且只画靠近中心的（外圈已被渐隐吃掉）
      for (let x = -2; x <= 2; x += 1) {
        line(ctx, cam, v3(x, 0.001, -3.2), v3(x, 0.001, 3.2), 'rgba(60,30,10,0.10)', 0.010);
      }
      for (let z = -3; z <= 3; z += 1) {
        line(ctx, cam, v3(-2.4, 0.001, z), v3(2.4, 0.001, z), 'rgba(60,30,10,0.10)', 0.010);
      }
      /* 围挡已删除：参考图里球场边缘没有任何实体遮挡物，
         边界感由地板渐隐 + 观众光点自然收束。 */
    }
  }

  /* ============================================================================
   * 暗场 + 顶部聚光灯 + 体积光 + 四角暗角（2026-10-22）
   *
   * 设计来自《乒乓赛场_总纲提示词》：
   *   ① 场地整体压暗 → 暗色竞技场
   *   ② 球台与球员由头顶一束聚光灯单独打亮，光锥边缘锐利、带轻微体积雾
   *   ③ 光锥外的观众席跟着落暗（它们只是氛围，不能和球员抢亮度）
   *   ④ 画面四角加暗角
   *
   * 为什么不用 tools/spotlight-demo.html 的「快照 → 压暗 → 遮罩贴回」：
   *   那套每帧要 3 张全屏离屏画布（快照/遮罩/临时）+ 4 次全屏合成，并且需要 4 张 PNG。
   *   本项目零依赖、要跑在手机 Canvas2D 上，所以改成**纯渐变**：
   *     · 压暗层 = 纵向渐变 × 横向渐变（乘法合成到一条 rgba 字符串，零逐像素运算）
   *       + 球台处一个"避让"径向渐变（向心压暗最轻，台面维持明亮）
   *     · 体积光 = 横向渐变 + 两个锥形渐变，`lighter` 叠一次，光锥边缘锐利
   *   每帧固定 2 次全屏 fillRect + 1 次锥体填充，与观众人数无关。
   *
   * 三个作用域：
   *   'world'  画在场景里（drawFloor 缓存层末、或逐帧直画路径的末尾）——只压暗看台/地板，
   *            不含球员与球；受 drawFloor 的「相机/尺寸变色才重建」缓存保护，静止时不重绘。
   *   'overlay' 画在整帧最上层（drawScene 末尾）——所有元素（球员/球/UI 之下但画面上）都被压暗，
   *            因为它是每帧都变的透明层，所以只做「球台避让 + 体积光 + 暗角」这几样便宜的事。
   *   'off'     不画（低画质 / 用户关闭灯光）。
   * ========================================================================== */
  const LIGHT_AMB = {
    // 纵向压暗：上缘（看台）最重，台面高度最轻，下缘（近端地板）中等
    // 〔2026-10-23 v7 忠于新参考图〕darkTop 0.74→0.58：参考图观众带亮度 0.19~0.24
    // （旧值把光海压到 0.08~0.16，第二亮层直接压死）；darkBottom 0.30→0.22：
    // 参考图近端地板可见（暗暖棕 + 台前亮池反光），旧值压成纯黑。
    darkTop: 0.58, darkMid: 0.22, darkBottom: 0.22,
    // 地板亮度系数（drawFloorBg 使用）：压暗后地板自然变暗
    /* 〔2026-10-23 v7 按新参考图〕新参考图地板更暗：左 #4d160f / 中 #482124 / 右 #121234，
       且台前有一块亮池反光（y 0.83~0.95 中央最亮）。底色往暗暖棕收，侧向反光与亮池
       在 drawFloorBg 里单独画（红左蓝右）。
       〔v8〕饱和度补齐：实测本版渲染地板只有 (45,32,28)（S≈0.38），参考图同位置
       (59,28,29)（S≈0.51）且左缘更红、右缘更蓝。底色与侧反光一起加饱和。 */
    floor: 1.0, floorNear: '128,58,40', floorFar: '152,76,44',
    // 体积光（lighter 叠加）：外锥宽而淡（雾），内锥窄而亮（光锥核心）
    /* 〔2026-10-23 v8〕volCenter 0.85→0.55：v7 为把"台上亮池"立住把锥体推到 0.85，
       叠加两束（球员都在中轴）后中心列整段过曝成 255,255,255，台面的蓝被洗掉。
       参考图实测：锥体中段（y 0.30）只给暗背景加 ~(84,91,112)，即 α≈0.36；
       单束 α = volCenter × lvl(0.56) ⇒ volCenter ≈ 0.55 正好。
       台上亮池改由 drawTable 的蓝色聚光池承担（锥体在台面前沿就淡出）。 */
    volCenter: 0.55, volEdge: 0.30, volBottom: 0.70,
    volTint: '255,246,230',
    // 四角暗角（overlay 层，整帧最上）：两角最重、四边较轻
    // 〔2026-10-23 v7〕vigCorner 0.55→0.45：参考图四角虽暗，光棒依旧发光。
    vigSide: 0.16, vigCorner: 0.45,
  };

  /* 灯光开关：world = 暗场压暗层（画进地板缓存，相机变化才重建）；
     overlay = 四角暗角 + 体积光（每帧一次，很便宜）。默认两层都开。
     关闭时两层都关（低画质 / 用户关灯）。 */
  const LIGHTING = { world: true, overlay: true };
  function setLightingMode(m) {
    if (m === 'off') { LIGHTING.world = LIGHTING.overlay = false; }
    else if (m === 'world') { LIGHTING.world = true; LIGHTING.overlay = false; }
    else if (m === 'overlay') { LIGHTING.world = false; LIGHTING.overlay = true; }
    else if (m === 'both' || m === 'on') { LIGHTING.world = LIGHTING.overlay = true; }
    else return lightingMode();
    clearCrowdCache();   // 压暗层画在缓存里，开关变了必须重建
    return lightingMode();
  }
  const lightingMode = () => (LIGHTING.world && LIGHTING.overlay ? 'both'
    : LIGHTING.world ? 'world' : LIGHTING.overlay ? 'overlay' : 'off');


  /* 世界层压暗 + 球台避让（两段式，避免两层边界互相"咬"出矩形）：
     ① 纵向渐变：上缘（看台）最重、台面高度最轻、下缘（近端地板）中等——与相机无关，永远铺满整幅；
     ② 球台避让椭圆：以球台四角包围盒中心为圆心，台面内圈完全透明（恢复原亮度），
        向外到椭圆边缘压掉 0.42（过渡带宽，正好把"台面 → 地板"的落差磨平）。
     椭圆边缘之外不再额外压暗（①已经铺好了底），所以不会出现矩形压边。
     ⚠ 测试桩没有 save/restore，也不接受椭圆变换以外的输入：这里用"先缩放再画圆"的 setTransform 实现。 */
  /* 世界层压暗：**只做纵向**（上缘看台最重、台面高度最轻、近端地板中等）。
     球台/球员的"高亮"不靠这里做减法，而是靠：
       · 地板本身已经是"中心亮、四边完全透明"的椭圆渐变（drawFloorBg）
       · 最外层的四角暗角（drawVignette）收边
     这样只剩一条上下方向的亮度曲线，画面里不会出现任何"椭圆/矩形"的压边痕迹。
     （上一版在这里加了"球台避让椭圆"，结果椭圆边界比地板边还显眼——已删。） */
  function drawDarken(ctx, cam, vw, vh) {
    const A = LIGHT_AMB;
    const darkY = (t) => (t < 0.5
      ? A.darkTop + (A.darkMid - A.darkTop) * (t / 0.5)
      : A.darkMid + (A.darkBottom - A.darkMid) * ((t - 0.5) / 0.5));
    const gv = ctx.createLinearGradient(0, 0, 0, vh);
    for (let i = 0; i <= 6; i++) gv.addColorStop(i / 6, `rgba(3,5,10,${darkY(i / 6).toFixed(3)})`);
    ctx.fillStyle = gv;
    ctx.fillRect(0, 0, vw, vh);
  }
  /* 四角暗角：中间透明、四边/四角变黑。径向渐变在角上距离更远 ⇒ 自然更重。 */
  function drawVignette(ctx, vw, vh) {
    const A = LIGHT_AMB;
    const cx = vw / 2, cy = vh * 0.54;
    const r0 = Math.min(vw, vh) * 0.34;
    const r1 = Math.hypot(vw / 2, vh / 2) * 1.04;
    const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.45, `rgba(0,0,0,${(A.vigSide * 0.5).toFixed(3)})`);
    g.addColorStop(0.7, `rgba(0,0,0,${(A.vigSide + (A.vigCorner - A.vigSide) * 0.35).toFixed(3)})`);
    g.addColorStop(1, `rgba(0,0,0,${A.vigCorner.toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);
  }

  /* 体积光：从画面顶部中央灯位向下的锥形光束。
     横向渐变（中心亮、两侧锐利衰减）× 细长锥形多边形，外锥淡（体积雾）+ 内锥亮（光锥核心）。
     全部 lighter，不压暗任何东西，叠在压暗层之上是安全的。
     〔2026-10-23 忠于原图〕加**纵向淡出**：锥体分 4 段，越靠下（近台面）越亮。
     原图的灯锥是「从上往下逐渐拧亮」的，顶部几乎只是微光；单段等亮度会在顶部糊出
     一条暖白柱，把远处球员的头和上半身染成米色（实测 rgb(69,66,62)）。 */
  let CONE_SPRITE = null;   // { key, canvas }
  function buildConeSprite(vw, vh) {
    const key = vw + 'x' + vh;
    if (CONE_SPRITE && CONE_SPRITE.key === key) return CONE_SPRITE.canvas;
    let cv = null;
    try {
      if (typeof document === 'undefined' || !document.createElement) return null;
      cv = document.createElement('canvas');
    } catch (e) { return null; }
    const SW = Math.max(64, Math.round(vw * 0.62));
    const SH = Math.max(64, Math.round(vh));
    cv.width = SW; cv.height = SH;
    const c2 = cv.getContext('2d');
    if (!c2) return null;
    const A = LIGHT_AMB;
    const cxp = SW / 2;
    const topY = -SH * 0.05;
    const botY = SH * A.volBottom;
    const wTop = SW * 0.060, wBot = SW * 0.300;
    const ROWS = 96;
    for (let i = 0; i < ROWS; i++) {
      const t0 = i / ROWS, t1 = (i + 1) / ROWS;
      const y0 = topY + (botY - topY) * t0;
      const y1 = topY + (botY - topY) * t1;
      // 锥宽沿纵向线性张开；纵向亮度：顶部微光、越靠近台面越亮（原图就是这样）
      const halfW = wTop + (wBot - wTop) * t0;
      /* 纵向：顶部微光 → 越往下越亮 → **中段开始淡出**（v8：0.72→0.62 起、0.20 内淡完）。
         旧值让锥体一路亮到台面前沿（y 0.74），整块台面被暖白盖住、蓝色尽失；
         参考图的锥体在台面上沿就淡出，台面的亮由台面自己的蓝色聚光池给。 */
      const fadeOut = t0 > 0.62 ? Math.max(0, 1 - (t0 - 0.62) / 0.20) : 1;
      const lvl = (0.18 + 0.82 * Math.pow(t0, 0.85)) * fadeOut;
      const a = A.volCenter * lvl;
      const g = c2.createLinearGradient(cxp - halfW, 0, cxp + halfW, 0);
      // 中心亮 → 两侧陡降（光锥边缘锐利），最外圈完全透明
      g.addColorStop(0.00, `rgba(${A.volTint},0)`);
      g.addColorStop(0.16, `rgba(${A.volTint},${(a * 0.52).toFixed(3)})`);
      g.addColorStop(0.34, `rgba(${A.volTint},${(a * 0.88).toFixed(3)})`);
      g.addColorStop(0.50, `rgba(${A.volTint},${a.toFixed(3)})`);
      g.addColorStop(0.66, `rgba(${A.volTint},${(a * 0.88).toFixed(3)})`);
      g.addColorStop(0.84, `rgba(${A.volTint},${(a * 0.52).toFixed(3)})`);
      g.addColorStop(1.00, `rgba(${A.volTint},0)`);
      c2.fillStyle = g;
      /* 行边界取整后**平铺**（不加 1px 重叠）：
         重叠会把同一条边画两遍，在 lighter 下叠出可见的横向亮线（上一版实测就是这个问题）。 */
      const y0i = Math.round(y0), y1i = Math.round(y1);
      if (y1i > y0i) c2.fillRect(cxp - halfW, y0i, halfW * 2, y1i - y0i);
    }
    CONE_SPRITE = { key, canvas: cv };
    return cv;
  }

  /* 〔2026-10-23 用户要求〕**两束光，各自跟随一名球员**。
     · 锥体精灵仍是预烘焙的一份（按画幅缓存），只是每束各 drawImage 一次；
     · 每束的水平位置 = 该球员在屏幕上的 x（平滑跟随），锥底落在球员脚下；
     · 锥顶收拢到画面上方中央附近（两束从同一个顶部区域分叉下来，像球馆顶灯）；
     · 球员左右移动时，光跟着走 —— 这就是"灯光时刻照着火柴人"。
     没传 players（回放/测试）时退回原来的一束居中，行为不变。 */
  function drawVolumetricCone(ctx, vw, vh, cam, players) {
    const A = LIGHT_AMB;
    const cv = buildConeSprite(vw, vh);
    const _pc = ctx.globalCompositeOperation;
    const canLighter = typeof _pc === 'string';
    if (canLighter) ctx.globalCompositeOperation = 'lighter';

    // 每束光的水平落点：取球员脚下在屏幕上的 x（夹在画幅内）
    const spots = [];
    if (cam && players && players.length) {
      for (const pl of players) {
        const q = cam.project(v3(pl.x, 0, pl.z));
        if (!q) continue;
        spots.push(Math.max(vw * 0.12, Math.min(vw * 0.88, q.x)));
      }
    }
    if (!spots.length) spots.push(vw / 2);   // 兜底：居中一束

    /* 〔2026-10-23 v8〕相邻落点合并成一束：两名球员都靠近中轴时（对拉、准备姿势），
       参考图里就是**一束**光打在台心；旧版画两束且都落在 x≈0.5W，
       lighter 叠出来是一片纯白（实测中心列 y 0.2~0.65 全为 255,255,255）。
       分开超过 0.14 画幅才画两束（球员真的拉开时灯各自跟随）。 */
    spots.sort((a, b) => a - b);
    const beams = [];
    for (const cx of spots) {
      const last = beams[beams.length - 1];
      if (last != null && cx - last < vw * 0.14) beams[beams.length - 1] = (last + cx) / 2;
      else beams.push(cx);
    }
    const multi = beams.length > 1;

    const dw = cv ? cv.width : vw * 0.62;
    const dh = cv ? cv.height : vh;
    // 两束时各收窄到 0.72，避免两束叠在中间糊成一大片白
    const scaleW = multi ? 0.72 : 1.0;
    for (const cx of beams) {
      if (cv && typeof ctx.drawImage === 'function') {
        const w2 = dw * scaleW;
        ctx.drawImage(cv, cx - w2 / 2, 0, w2, dh);
      } else {
        // 无 canvas 环境（测试桩）：退回单段梯形，只为不抛错
        const hw = vw * 0.20 * scaleW;
        const g = ctx.createLinearGradient(cx - hw, 0, cx + hw, 0);
        g.addColorStop(0, `rgba(${A.volTint},0)`);
        g.addColorStop(0.5, `rgba(${A.volTint},${A.volCenter.toFixed(3)})`);
        g.addColorStop(1, `rgba(${A.volTint},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(cx - vw * 0.018, -vh * 0.05);
        ctx.lineTo(cx + vw * 0.018, -vh * 0.05);
        ctx.lineTo(cx + hw, vh * A.volBottom);
        ctx.lineTo(cx - hw, vh * A.volBottom);
        ctx.lineTo(cx - vw * 0.018, -vh * 0.05);
        ctx.fill();
      }
    }

    // 灯位亮点：每束光在画面上方各自有一个小亮芯（被上缘切掉一半）
    for (const cx of beams) {
      const lx = vw / 2 + (cx - vw / 2) * 0.35;   // 灯位比落点更靠中间（顶灯分叉）
      const ly = vh * 0.008;
      const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, vh * 0.060);
      lg.addColorStop(0, 'rgba(255,253,247,0.85)');
      lg.addColorStop(0.18, 'rgba(255,246,228,0.32)');
      lg.addColorStop(1, 'rgba(255,246,228,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.arc(lx, ly, vh * 0.060, 0, Math.PI * 2);
      ctx.fill();
    }
    if (canLighter) ctx.globalCompositeOperation = _pc;
  }

  /* 〔2026-10-23 v8〕看台环境色浸染（stand wash）
     参考图观众区不是"黑底 + 亮棒"，而是**整片被应援色染过**：实测右上观众区最暗的
     35% 像素均值 (4,14,41)（深蓝、S=0.89），左上 (26,10,16)（深红、S=0.64）；
     本版同区域只有 (5,7,14)（近中性、V=0.05）——HSV 直方图 (青, S.5~.75, V<.25)
     一档比参考图多 0.28，side_slope 右值只有 -23（参考 -39）。
     在压暗层之后、观众棒之前铺一层很淡的横向色 wash：左深红、中品红、右深蓝，
     棒子画在它上面，于是"暗缝"也带着观众席的颜色，和参考图一致。 */
  function drawStandWash(ctx, cam, vw, vh) {
    if (typeof ctx.createLinearGradient !== 'function') return;   // 测试桩
    const warmRight = (cam && cam.eye && cam.eye.z < 0);
    const hx = (f) => (warmRight ? 1 - f : f);
    const top = 0, bot = vh * 0.52;          // 只染看台带（台面以下交给地板三色调）
    const g = ctx.createLinearGradient(0, 0, vw, 0);
    g.addColorStop(hx(0.00), 'rgba(126,32,26,0.30)');   // 屏幕左：深红
    g.addColorStop(hx(0.30), 'rgba(104,30,44,0.24)');   // 左中：红棕
    g.addColorStop(hx(0.50), 'rgba(58,28,74,0.16)');    // 中：品红/紫
    g.addColorStop(hx(0.72), 'rgba(24,44,132,0.26)');   // 右中：蓝
    g.addColorStop(hx(1.00), 'rgba(16,30,128,0.34)');   // 屏幕右：深蓝
    // 纵向：上部全强度，底部 16% 线性淡出（球台高度不能带色，台面要保持纯净的蓝）。
    // 用分条 + globalAlpha 缩放实现"竖横两个方向的渐变叠加"（单个渐变只能一个方向）。
    const fadeStart = bot - vh * 0.16;
    ctx.fillStyle = g;
    ctx.fillRect(0, top, vw, Math.max(0, fadeStart - top));
    const M = 8, _ga = ctx.globalAlpha;
    for (let i = 0; i < M; i++) {
      ctx.globalAlpha = _ga * (1 - (i + 0.5) / M);
      const y0 = fadeStart + (bot - fadeStart) * i / M;
      const y1 = fadeStart + (bot - fadeStart) * (i + 1) / M;
      ctx.fillRect(0, y0, vw, y1 - y0);
    }
    ctx.globalAlpha = _ga;
  }

  /* 统一入口：
     'world'   → 压暗层 + 球台避让（画在场景里 / 离屏缓存里，只压看台与地板）
     'overlay' → 四角暗角 + 体积光（画在整帧最后，每帧一次，很便宜）
     'off'     → 什么都不画 */
  function drawLighting(ctx, cam, vw, vh, mode, players) {
    if (mode === 'world') {
      drawDarken(ctx, cam, vw, vh);
    } else if (mode === 'overlay') {
      drawVignette(ctx, vw, vh);
      drawVolumetricCone(ctx, vw, vh, cam, players);
    }
  }

  // 观众席绘制：坐姿火柴人按视角分阵营——屏幕左侧(x<0)=己方观众（红色），
  // 右侧=敌方观众（蓝色）；得分方欢呼举手、对方摇头
  const CROWD_OUTLINE = 'rgba(15,20,28,0.45)';
  const CROWD_R = 0.028; // 骨线粗
  // 观众队色（默认红方/蓝方；对局开始前按双方旗帜队色 setCrowdColors 覆盖，颜色与旗帜同步）
  // 〔2026-10-23 v9 从远端仓库 origin/main 恢复原版队色〕应援棒实验结束后回到最初的
  // 暖橙红 / 青蓝——与坐姿火柴人（drawPerson）的浅色骨线在暗场里对比最清楚。
  let FAN_COL = ['rgba(240,110,92,0.95)', 'rgba(110,160,246,0.95)'];

  // 画单个观众（供逐帧全量 / 动画层共用）
  // fast：动画层快速绘制——跳过头/肢体描边，肢体不描边（低开销动效；轮廓细节由下方静态层呈现）
  function drawPerson(ctx, cam, s, time, cheer, shake, col, fast) {
    // 调用方传的是标量（fan.cheer[team]）；seatedPose 内部已钳制 0..1
    const c = cheer || 0;
    const sh = shake || 0;
    const p = seatedPose(s, time, c, sh);
    const hp = cam.project(p.head);
    const fp = cam.project(p.hips);
    if (!hp || !fp) return;
    // 屏幕外剔除（相机后方 project 返回 null 已跳过；这里再剔屏幕外——手机窄视口大量观众在屏外，
    // 省静态层/动画层烘焙与直画填充率）。
    // 注意：project 返回 CSS 像素坐标，而 canvas.width/height 是设备像素。动画层是半分辨率画布
    // （scale=dpr×0.5），若直接拿设备像素当边界，dpr=1 时屏幕右半场观众会被误剔、永远不进动画层
    // （得分时右半场无欢呼无摇头）→ 用当前 transform 的缩放把边界换算回 CSS 像素，静态层/动画层口径一致。
    // 可见性基准用**座位坐标**（姿态无关）：动画层观众 cheer/shake 时 head/hips 会位移（起身/举手/摇头），
    // 若按姿态坐标剔除，动画期边界观众可能与静态层（rest 姿态）可见性不同 → 静态/动画人数不一致。
    // 座位 s 是固定站位（crowdLayout 生成后不变），两层用同一基准，人数严格一致。
    const _t = ctx.getTransform ? ctx.getTransform() : null;
    const _scale = _t && _t.a > 0 ? _t.a : 1;
    // 分屏右半视口：离屏缓存上下文带 -vx 平移（相机绝对屏幕 x → 视口本地 x），
    // 剔除须用本地坐标（否则右半视口观众全被当屏外剔除）
    const _tx = _t && _t.a > 0 ? (_t.e || 0) / _t.a : 0;
    const CW = ctx.canvas ? ctx.canvas.width / _scale : 0;
    const CH = ctx.canvas ? ctx.canvas.height / _scale : 0;
    if (CW > 0 && CH > 0) {
      const sp = cam.project(v3(s.x, s.y, s.z)); // 座位基准点（姿态无关）
      if (!sp) return;
      const m = 60;
      if (sp.x + _tx < -m || sp.x + _tx > CW + m || sp.y < -m || sp.y > CH + m) return;
    }
    const sc = Math.min(hp.s, fp.s);
    // 头（圆头，与球员一致）
    const headR = Math.max(1.2, 0.105 * sc * 0.9);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(hp.x, hp.y, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = CROWD_OUTLINE;
    ctx.lineWidth = Math.max(0.6, headR * 0.16);
    ctx.stroke();
    if (fp.y - hp.y < 10) {
      // 太远：只画头 + 躯干（动画/静态同规则——远处小人不因姿态不同而画出不同完整度，观感一致）
      limb(ctx, cam, p.hips, p.shoulder, CROWD_R * 0.85, col, fast ? CROWD_OUTLINE : null);
      return;
    }
    // 躯干（髋→肩）
    limb(ctx, cam, p.hips, p.shoulder, CROWD_R, col, CROWD_OUTLINE);
    // 大腿（髋→膝，前伸）
    limb(ctx, cam, p.hips, p.kneeL, CROWD_R * 0.9, col, CROWD_OUTLINE);
    limb(ctx, cam, p.hips, p.kneeR, CROWD_R * 0.9, col, CROWD_OUTLINE);
    // 小腿（膝→脚，下落）
    limb(ctx, cam, p.kneeL, p.footL, CROWD_R * 0.8, col, CROWD_OUTLINE);
    limb(ctx, cam, p.kneeR, p.footR, CROWD_R * 0.8, col, CROWD_OUTLINE);
    // 手臂（肩→手，搭膝/举手）
    limb(ctx, cam, p.shL, p.handL, CROWD_R * 0.75, col, CROWD_OUTLINE);
    limb(ctx, cam, p.shR, p.handR, CROWD_R * 0.75, col, CROWD_OUTLINE);
  }

  // teamFixed（本地分屏两端背景一致）：观众队色统一为"红左蓝右"（P1 主视角）。
  // 分屏时 P1 半屏已镜像、P2 半屏未镜像，若仍按 viewSide 分阵营，两端观众颜色会左右相反；
  // 固定映射后两侧看到的观众颜色、得分欢呼/摇头都在同一侧。人机/联机不传该标志，保持"己方球迷在左"。
  function drawCrowd(ctx, cam, time, viewSide, fan, density, teamFixed) {
    /* 布局缓存：密度或「相机侧」变化才重建。
       相机侧很关键——端看台只生成在镜头对面那一侧，换边（本地双人 P2 视口）必须重建，
       否则 P2 会看到"背对镜头"的那排（竖屏下会糊在球台前面）。 */
    const zs = (cam.eye.z || 0) >= 0 ? 1 : -1;
    if (!crowdList || crowdListDensity !== density || crowdListZ !== zs) {
      crowdList = crowdLayout(density, zs);
      crowdListDensity = density;
      crowdListZ = zs;
    }
    for (const s of crowdList) {
      // 屏幕左侧（世界 x<0）为当前视角己方球迷，右侧为敌方球迷
      const team = teamFixed ? (s.x < 0 ? 0 : 1) : (s.x < 0 ? (viewSide || 0) : 1 - (viewSide || 0));
      const col = FAN_COL[team];
      const c = (fan && fan.cheer) ? fan.cheer[team] : 0;
      const sh = (fan && fan.shake) ? fan.shake[team] : 0;
      drawPerson(ctx, cam, s, time, c, sh, col, false);
    }
  }

  // 动画层：得分后欢呼/摇头按 30Hz 烘焙进离屏缓存（见 drawFloor / CROWD_ANIM_HZ），
  // 帧间隔内只 blit 缓存，不再逐帧重绘全部观众。

  // ---------- 观众席离屏缓存（最大帧开销：~380 观众 × 5,600 次路径 + ~11k 临时对象） ----------
  // 静态层（地板/看台，全分辨率）与动画层（全部观众，全分辨率+描边）分离，**任一时刻观众只画在一层**：
  // - 无动画：静态层 = 地板+看台+rest 观众（相机/尺寸/DPR/模式变化才重建，每帧一次 drawImage blit）；
  // - 动画中：静态层 = 地板+看台（不含观众，动画开始重建一次），全部观众由动画层按 30Hz 烘焙绘制。
  //   若动画期静态层仍保留 rest 观众，会与动画层动势身影错位叠出"复制体"（欢呼举手/起身/摇头的位移
  //   让两层同人不同影）——故动画期静态层必须去掉观众，只保留动画层一份。
  // - 动画层：全分辨率 + 外描边（与静态层同一画风，轮廓清晰、人数观感一致），动画结束停止 blit，
  //   静态层重建回 rest 观众（无需逐帧重画）。动画仅在得分欢呼时短暂触发（~1.5s），开销可控。
  // 无 document.createElement 的环境（测试桩/极端环境）自动回退逐帧直画。
  /* 相机移动重建阈值(m)：0.06 → 0.12。
     光棒墙加密到 2600+ 根之后，单次重建约 8~10ms；桶太小会让「一边跑一边重建」直接吃掉帧预算。
     0.12m 的位移在画面里不到 1px，肉眼看不出抖动。 */
  const CROWD_CAM_BUCKET = 0.06;
  /* 欢呼动画刷入动画层的频率（Hz）。
     观众墙加密后单次烘焙 ~7ms，30Hz 下每两帧就要吃掉一帧的 2/3；24Hz 仍能看清挥舞，
     实测 0.62 密度下烘焙 ~7ms，60fps 预算 16.7ms 仍够用，故保持 30Hz（动画更顺）。 */
  const CROWD_ANIM_HZ = 30;
  // 静态/动画离屏缓存：按 viewSide（分屏两侧队色相反）分键——本地双人两视口各自缓存，
  // 避免 A 视口重建后 B 视口 key 不同又踢掉重建，导致每帧全量重画 376 人观众席（帧率抖动）。
  // 每个 entry 懒创建（先静态层后动画层，保持 createElement 顺序，兼容测试桩 canvas 序号）。
  let crowdCaches = {}; // { [viewSide]: { static:{key,canvas,ctx}, anim:{key,canvas,ctx,active,animT} } }
  function clearCrowdCache() { crowdCaches = {}; }
  // 按队伍旗帜队色重设观众颜色（hex → rgba，保持 0.95 风格透明度）；
  // 队色变化强制重建观众缓存（静态层/动画层都按 FAN_COL 取色，重建后自动用新队色）
  function setCrowdColors(cols) {
    if (!Array.isArray(cols) || cols.length < 2) return;
    const toRGBA = (hex) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
      if (!m) return hex;
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.95)`;
    };
    FAN_COL = [toRGBA(cols[0]), toRGBA(cols[1])];
    clearCrowdCache();
  }
  // 仅探测 document.createElement 可用性（不在此创建 canvas——避免每帧分配一个探针画布；getContext 能力在首次建缓存时自然验证）
  function crowdCacheSupported() {
    return typeof document !== 'undefined' && !!document.createElement;
  }
  // 动画是否进行中（任一观众有欢呼/摇头量）——true 期间动画层按 CROWD_ANIM_HZ 烘焙
  function crowdAnimActive(fan) {
    if (!fan) return false;
    return !!((fan.cheer && (fan.cheer[0] > 0 || fan.cheer[1] > 0)) ||
              (fan.shake && (fan.shake[0] > 0 || fan.shake[1] > 0)));
  }
  // 静态层重建：地板/看台 + 静止观众（rest 姿态），全分辨率（写入 entry.static）。
  // withCrowd=false（动画进行中）：静态层不含观众——动画层同时绘制全部观众，
  // 避免"静止层 rest 身影 + 动画层动势身影"同屏叠出复制体（欢呼举手/起身浮动的位移会让两层错开）。
  function rebuildCrowdCache(entry, cam, vw, vh, viewSide, mainCtx, withCrowd, density, teamFixed) {
    // 缓存 dpr 按**整屏** CSS 宽计算（clientWidth）：分屏时 vw=半视口宽，若用 canvas.width/vw
    // 会得到 2×dpr → 半视口缓存按整屏像素烘焙（4× 冗余像素与内存），本地双人恒命中
    const dpr = mainCtx.canvas ? Math.max(1, mainCtx.canvas.width / Math.max(1, mainCtx.canvas.clientWidth || vw)) : 1;
    entry.static.canvas.width = Math.max(1, Math.round(vw * dpr));
    entry.static.canvas.height = Math.max(1, Math.round(vh * dpr));
    const cc = entry.static.ctx;
    // 视口左上角 CSS x：相机投影为绝对屏幕坐标，缓存是视口本地坐标 → 整体平移 -vx
    const vx = (cam.cx || 0) - vw / 2;
    cc.setTransform(dpr, 0, 0, dpr, -vx * dpr, 0);
    cc.clearRect(0, 0, vw, vh);
    drawFloorBg(cc, cam, vw, vh);
    drawBenches(cc, cam);
    /* 暗场压暗层画在缓存**内部**（只压地板与看台，不含球员/球）：
       它只与相机/尺寸/模式有关，静止时随缓存一起 blit，不再每帧重绘。 */
    if (LIGHTING.world) drawLighting(cc, cam, vw, vh, 'world');
    /* 〔v8〕看台环境色浸染：画在压暗层之后、观众棒之前（暗缝也带观众席的颜色） */
    if (LIGHTING.world) drawStandWash(cc, cam, vw, vh);
    /* 〔2026-10-23 忠于原图〕全部观众画在压暗层**之后**：
       原图里两侧光海（左暖橙/右青蓝）是从黑场里长出来的自发光体，是画面第二亮层。
       旧实现只把端看台放在压暗层后、侧看台被 darkTop=0.80 压死，左右两片光海几乎不可见。
       现在统一后置：压暗层只压地板/看台结构，光棒全部保持原亮度，由最外层暗角收边。 */
    if (withCrowd !== false) {
      drawCrowd(cc, cam, 0, viewSide, null, density, teamFixed); // 静止 rest 姿态（time=0, 无欢呼）
    }
  }
  // 动画层重建：画**全部**观众——有欢呼/摇头量的按动作绘制，其余 rest 姿态兜底。
  // 透明底叠在静态层上。动画期静态层**不含观众**（防叠影复制体：动作姿态位移会让两层同人不同影），
  // 全部观众由动画层绘制。动画层必须在 fan 非零时烘焙（30Hz），否则观众消失——这是关键约束。
  // 全分辨率 + 描边与静态层同画风。
  function rebuildAnimCache(entry, cam, vw, vh, viewSide, mainCtx, time, fan, teamFixed) {
    // 同 rebuildCrowdCache：按整屏 CSS 宽计算缓存 dpr（分屏下避免 2×dpr → 4× 冗余像素）
    const dpr = mainCtx.canvas ? Math.max(1, mainCtx.canvas.width / Math.max(1, mainCtx.canvas.clientWidth || vw)) : 1;
    const s = animScale(); // 手机端动画层半分辨率（减动画期填充 75%，v2.4）
    entry.anim.canvas.width = Math.max(1, Math.round(vw * dpr * s));
    entry.anim.canvas.height = Math.max(1, Math.round(vh * dpr * s));
    const ac = entry.anim.ctx;
    // 视口左上角 CSS x：与静态层一致整体平移 -vx（分屏右半视口）
    const vx = (cam.cx || 0) - vw / 2;
    ac.setTransform(dpr * s, 0, 0, dpr * s, -vx * dpr * s, 0);
    ac.clearRect(0, 0, vw, vh);
    /* 〔2026-10-23 忠于原图〕一次画全量观众、不再分批，也不再在动画层里压暗：
       原图两侧光海是自发光体，欢呼动画期同样要保持亮度（旧实现侧看台在动画层被
       source-atop 压暗，得分瞬间左右两片光海突然变暗，与静止层观感不一致）。 */
    for (const p of crowdList) {
      const team = teamFixed ? (p.x < 0 ? 0 : 1) : (p.x < 0 ? (viewSide || 0) : 1 - (viewSide || 0));
      const c = (fan && fan.cheer) ? fan.cheer[team] : 0;
      const sh = (fan && fan.shake) ? fan.shake[team] : 0;
      drawPerson(ac, cam, p, time, c, sh, FAN_COL[team], true);
    }
  }

  function drawFloor(ctx, cam, vw, vh, time, viewSide, fan, low, density, noCrowd, teamFixed) {
    /* 布局缓存：密度或「相机侧」变化才重建。
       相机侧很关键——端看台只生成在镜头对面那一侧，换边（本地双人 P2 视口）必须重建，
       否则 P2 会看到"背对镜头"的那排（竖屏下会糊在球台前面）。 */
    const zs = (cam.eye.z || 0) >= 0 ? 1 : -1;
    if (!crowdList || crowdListDensity !== density || crowdListZ !== zs) {
      crowdList = crowdLayout(density, zs);
      crowdListDensity = density;
      crowdListZ = zs;
    }
    // 视口左上角 CSS x（分屏右半=half，整屏=0）：相机投影为**绝对屏幕坐标**（cam.cx 含 vx 偏移），
    // 而离屏缓存是视口本地坐标 → 画入缓存时整体平移 -vx，blit 时放回视口位置（否则分屏右半整片空白）
    const vx = (cam.cx || 0) - vw / 2;
    // 离屏缓存可用（有 createElement 且非测试桩）：静态层一次绘制、多帧 blit；
    // 动画层按 30Hz 烘焙叠加，帧间隔内只 blit（背景/看台分层绘制，观众任一时刻只在一层，无需每帧重画）
    if (crowdCacheSupported()) {
      const backing = (ctx.canvas && ctx.canvas.width) || 0;
      // crowdMode：观众画在哪一层——off=无观众（低画质/联机）；static=静止层（rest 观众）；
      // anim=动画层（动画期静态层只留地板+看台，防止与动画层叠影出"复制体"）。
      // 并入静态层缓存 key：模式切换自动触发重建（动画开始/结束各重建一次静态层）。
      const anim = crowdAnimActive(fan);
      const crowdMode = (low || noCrowd) ? 'off' : (anim ? 'anim' : 'static');
      const key = `${viewSide}:${vx}:${Math.round(cam.eye.x / CROWD_CAM_BUCKET)}:${vw}:${vh}:${backing}:${crowdMode}:${LIGHTING.world ? 1 : 0}${LIGHTING.overlay ? 1 : 0}:`;
      // 按 viewSide 取/建本视口的静态+动画缓存（本地双人两视口互不踢缓存）
      let entry = crowdCaches[viewSide];
      if (!entry) {
        entry = crowdCaches[viewSide] = {
          static: { canvas: document.createElement('canvas'), ctx: null, key: '' },
          anim: { canvas: document.createElement('canvas'), ctx: null, key: '', active: false, animT: null },
        };
      }
      const st = entry.static, an = entry.anim;
      if (!st.ctx) st.ctx = st.canvas.getContext('2d');
      if (!an.ctx) an.ctx = an.canvas.getContext('2d');
      if (low || noCrowd) {
        // 低画质 / 联机模式（noCrowd）：地板+围挡缓存（无观众席/看台），相机/尺寸/DPR 变化才重建
        if (st.key !== key) {
          st.key = key;
          // 同 rebuildCrowdCache：按整屏 CSS 宽（clientWidth）算 dpr，分屏下避免 2×dpr → 4× 冗余像素
          const dpr = Math.max(1, backing / Math.max(1, (ctx.canvas && ctx.canvas.clientWidth) || vw));
          st.canvas.width = Math.max(1, Math.round(vw * dpr));
          st.canvas.height = Math.max(1, Math.round(vh * dpr));
          const fc = st.ctx;
          fc.setTransform(dpr, 0, 0, dpr, -vx * dpr, 0);
          fc.clearRect(0, 0, vw, vh);
          drawFloorBg(fc, cam, vw, vh);
          // 暗场压暗层同样进缓存（只压地板；联机/低画质没有观众席，但地板仍要落暗）
          if (LIGHTING.world) drawLighting(fc, cam, vw, vh, 'world');
          if (LIGHTING.world) drawStandWash(fc, cam, vw, vh);
        }
        ctx.drawImage(st.canvas, vx, 0, vw, vh);
        return;
      }
      // 静态层：相机/尺寸/DPR/模式变化才重建。动画期静态层**不含观众**（防叠影复制体），
      // 全部观众由动画层绘制——动画层必须在 fan 非零时烘焙，否则观众消失（"一欢呼人少一半"）
      if (st.key !== key) {
        st.key = key;
        rebuildCrowdCache(entry, cam, vw, vh, viewSide, ctx, crowdMode === 'static', density, teamFixed);
      }
      // 动画层：相机 key 变化、动画开始、动画中 30Hz 烘焙（浮点容差 1e-6 稳定节奏）
      if (anim) {
        const animDue = !an.active || an.key !== key ||
          (an.animT == null || time - an.animT >= 1 / CROWD_ANIM_HZ - 1e-6);
        if (animDue) {
          an.key = key;
          an.active = true;
          an.animT = time;
          rebuildAnimCache(entry, cam, vw, vh, viewSide, ctx, time, fan, teamFixed);
        }
      } else if (an.active) {
        // 动画结束：停止叠加动画层；静态层 key 已切回 'static' → 本帧已重建回 rest 观众（单份，无叠影）
        an.active = false;
        an.animT = null;
        an.key = key;
      }
      ctx.drawImage(st.canvas, vx, 0, vw, vh);
      if (an.active) ctx.drawImage(an.canvas, vx, 0, vw, vh);
    } else {
      if (low || noCrowd) { drawFloorBg(ctx, cam, vw, vh); if (LIGHTING.world) { drawLighting(ctx, cam, vw, vh, 'world'); drawStandWash(ctx, cam, vw, vh); } return; }
      drawFloorBg(ctx, cam, vw, vh);
      drawBenches(ctx, cam); // 先画座位（观众坐在其上）
      if (LIGHTING.world) drawLighting(ctx, cam, vw, vh, 'world');
      if (LIGHTING.world) drawStandWash(ctx, cam, vw, vh);
      /* 〔2026-10-23 忠于原图〕与缓存路径一致：观众画在压暗层之后（自发光光海） */
      drawCrowd(ctx, cam, time, viewSide, fan, density, teamFixed);
    }
  }

  // 球台下方投影阴影：两层柔化四边形（接触影 + 外围柔影），增强立体感
  function drawTableShadow(ctx, cam) {
    const W = R.TABLE_WIDTH / 2, L = R.TABLE_LENGTH / 2;
    // 轻微偏移（模拟光照方向）
    const ox = -0.03, oz = -0.05;
    const quad = (scale, alpha) => {
      const pts = [
        cam.project(v3(-W * scale + ox, 0.004, -L * scale + oz)),
        cam.project(v3(W * scale + ox, 0.004, -L * scale + oz)),
        cam.project(v3(W * scale + ox, 0.004, L * scale + oz)),
        cam.project(v3(-W * scale + ox, 0.004, L * scale + oz)),
      ];
      if (pts.some((p) => !p)) return;
      ctx.fillStyle = `rgba(6,10,16,${alpha})`;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fill();
    };
    quad(1.15, 0.15); // 外围柔影（略大于台面，柔化过渡）
    quad(1.0, 0.36);  // 接触影（桌面正下方最深）
  }

  function drawTable(ctx, cam) {
    drawTableShadow(ctx, cam); // 先画投影（桌体随后盖在其上）
    const L = R.TABLE_LENGTH / 2, W = R.TABLE_WIDTH / 2, H = R.TABLE_HEIGHT, T = R.TABLE_THICK;
    const basis = { f: v3(0, 0, 1), u: v3(0, 1, 0), s: v3(1, 0, 0) };
    // 台面
    box(ctx, cam, v3(0, H, 0), W, T / 2, L, basis, C.tableTop);
    // 侧板
    box(ctx, cam, v3(0, H - T / 2, L + T / 2), W, T / 2, T / 2, basis, C.tableSide);
    box(ctx, cam, v3(0, H - T / 2, -L - T / 2), W, T / 2, T / 2, basis, C.tableSide);
    box(ctx, cam, v3(W + T / 2, H - T / 2, 0), T / 2, T / 2, L, basis, C.tableSide);
    box(ctx, cam, v3(-W - T / 2, H - T / 2, 0), T / 2, T / 2, L, basis, C.tableSide);
    // 桌腿
    for (const lx of [-W + 0.06, W - 0.06]) {
      for (const lz of [-L + 0.08, L - 0.08]) {
        box(ctx, cam, v3(lx, H / 2, lz), 0.045, H / 2, 0.045, basis, '#6d7a8c');
      }
    }
    // 白线：边线与端线（2cm），中线（3mm）
    const top = v3(0, H + 0.0025, 0);
    const pts = {
      nw: v3(-W, H + 0.0025, -L), ne: v3(W, H + 0.0025, -L),
      sw: v3(-W, H + 0.0025, L), se: v3(W, H + 0.0025, L),
    };
    poly(ctx, cam, [pts.nw, pts.ne, pts.se, pts.sw], C.tableTop);
    const lw = 0.020;
    const inner = {
      nw: v3(-W + lw, H + 0.003, -L + lw), ne: v3(W - lw, H + 0.003, -L + lw),
      sw: v3(-W + lw, H + 0.003, L - lw), se: v3(W - lw, H + 0.003, L - lw),
    };
    poly(ctx, cam, [pts.nw, pts.ne, pts.se, pts.sw], 'rgba(0,0,0,0)');
    line(ctx, cam, pts.nw, pts.ne, '#f8fafc', lw);
    line(ctx, cam, pts.sw, pts.se, '#f8fafc', lw);
    line(ctx, cam, pts.nw, pts.sw, '#f8fafc', lw);
    line(ctx, cam, pts.ne, pts.se, '#f8fafc', lw);
    // 中线（双打中线，赛事标准 3mm）
    line(ctx, cam, v3(0, H + 0.004, -L + lw), v3(0, H + 0.004, L - lw), '#f8fafc', 0.003);
    void top;
    /* 〔2026-10-23 v7 忠于新参考图〕台面聚光池：参考图台心被聚光灯打亮
       （亮带 #3a7bf6 vs 台缘 #1e4ca8），不是一整块平色。在台面中央叠一层
       柔和的**蓝白**径向渐变（lighter），中心最亮、向台缘淡出。
       〔v8〕① 外半径 1 → ry（渐变定义在用户空间，写 1 会在 1/ry 处就走完全程，
       亮池塌成一个亮点，反而在台心叠出一颗白痘）；② 色调从暖白改蓝白：
       参考图台面是高饱和蓝，暖白会把蓝洗成灰。 */
    {
      const c0 = cam.project(v3(0, H, 0));
      const cR = cam.project(v3(W, H, 0));
      if (c0 && cR && typeof ctx.createRadialGradient === 'function') {
        const rx = Math.max(8, Math.abs(cR.x - c0.x) * 0.62);
        const ry = rx * 0.42;
        const _pg = ctx.globalCompositeOperation;
        if (typeof _pg === 'string') ctx.globalCompositeOperation = 'lighter';
        const gp = ctx.createRadialGradient(c0.x, c0.y, 0, c0.x, c0.y, ry);
        gp.addColorStop(0, 'rgba(150,205,255,0.34)');
        gp.addColorStop(0.5, 'rgba(120,180,250,0.15)');
        gp.addColorStop(1, 'rgba(110,170,245,0)');
        ctx.save();
        ctx.translate(c0.x, c0.y);
        ctx.scale(rx / ry, 1);
        ctx.translate(-c0.x, -c0.y);
        ctx.fillStyle = gp;
        ctx.beginPath();
        ctx.arc(c0.x, c0.y, ry, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        if (typeof _pg === 'string') ctx.globalCompositeOperation = _pg;
      }
    }
  }

  function drawNet(ctx, cam) {
    const H = R.TABLE_HEIGHT, NH = R.NET_HEIGHT, NW = R.NET_WIDTH;
    const basis = { f: v3(0, 0, 1), u: v3(0, 1, 0), s: v3(1, 0, 0) };
    // 网柱
    for (const sx of [-NW / 2, NW / 2]) {
      box(ctx, cam, v3(sx, H + NH / 2, 0), 0.014, NH / 2, 0.014, basis, C.netPost);
      box(ctx, cam, v3(sx, H + NH + 0.012, 0), 0.022, 0.012, 0.022, basis, '#aab4c2');
    }
    // 顶带
    box(ctx, cam, v3(0, H + NH + 0.005, 0), NW / 2, 0.010, 0.010, basis, C.netTape);
    // 网面
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const x = -NW / 2 + (NW * i) / n;
      line(ctx, cam, v3(x, H + 0.008, 0), v3(x, H + NH - 0.006, 0), C.netMesh, 0.0015);
    }
    for (let i = 0; i <= 6; i++) {
      const y = H + 0.01 + ((NH - 0.02) * i) / 6;
      line(ctx, cam, v3(-NW / 2, y, 0), v3(NW / 2, y, 0), C.netMesh, 0.0012);
    }
  }

  // 径向渐变精灵缓存（按半径分桶烘焙一次，drawImage 替代每帧 createRadialGradient——球/阴影优化）
  const radialSprites = new Map();
  // 上限防多局累积：不同相机角度/距离 → 半径值域宽，旧条目定期清空避免堆膨胀/GC 压力
  const RADIAL_SPRITE_MAX = 512;
  function cacheRadialSprite(key, s) {
    radialSprites.set(key, s);
    if (radialSprites.size > RADIAL_SPRITE_MAX) radialSprites.clear();
    return s;
  }
  // 球体精灵：主体渐变 + 描边（含高光偏移，烘焙时按半径）
  function ballSprite(r) {
    const key = Math.max(2, Math.round(r));
    let s = radialSprites.get('b' + key);
    if (!s) {
      const size = Math.ceil(key * 2 + 8);
      const cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
      const c = cv.getContext('2d');
      const cx = size / 2;
      const g = c.createRadialGradient(cx - key * 0.35, cx - key * 0.4, key * 0.12, cx, cx, key);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.75, '#e8edf4'); g.addColorStop(1, '#aab6c6');
      c.fillStyle = g;
      c.beginPath(); c.arc(cx, cx, key, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(40,55,75,0.8)'; c.lineWidth = 1; c.stroke();
      s = { canvas: cv, size };
      return cacheRadialSprite('b' + key, s);
    }
    return s;
  }
  // 球影精灵：中心黑 → 边缘透明（最终透明度由调用方 globalAlpha 控制）
  function ballShadowSprite(r) {
    const key = Math.max(2, Math.round(r));
    let s = radialSprites.get('bs' + key);
    if (!s) {
      const size = Math.ceil(key * 2 + 8);
      const cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
      const c = cv.getContext('2d');
      const cx = size / 2;
      const g = c.createRadialGradient(cx, cx, 0, cx, cx, key);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, size, size);
      s = { canvas: cv, size };
      return cacheRadialSprite('bs' + key, s);
    }
    return s;
  }
  // 球员脚下阴影精灵（软化椭圆三停，透明度烘焙固定）
  function playerShadowSprite(r) {
    const key = Math.max(4, Math.round(r));
    let s = radialSprites.get('ps' + key);
    if (!s) {
      const size = Math.ceil(key * 2 + 8);
      const cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
      const c = cv.getContext('2d');
      const cx = size / 2;
      const g = c.createRadialGradient(cx, cx, 0, cx, cx, key);
      g.addColorStop(0, 'rgba(0,0,0,0.34)');
      g.addColorStop(0.6, 'rgba(0,0,0,0.18)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, size, size);
      s = { canvas: cv, size };
      return cacheRadialSprite('ps' + key, s);
    }
    return s;
  }

  // vel/low 可选：高速球按速度沿反方向拉出渐隐锥形（运动模糊），表现"快"；低画质缩短。
  function drawBall(ctx, cam, pos, spin, time, shadowOnly, vel, low) {
    // 影子：球在台面上方时投在台面，否则投在地面；球越高影子越大越淡
    const overTable = Math.abs(pos.x) <= R.TABLE_WIDTH / 2 &&
      Math.abs(pos.z) <= R.TABLE_LENGTH / 2;
    const shY = overTable ? R.TABLE_HEIGHT + 0.005 : 0.003;
    const sh = cam.project(v3(pos.x, shY, pos.z));
    if (sh) {
      const h = Math.max(0, pos.y - shY);
      const sr = Math.max(2, R.BALL_RADIUS * (2.2 + h * 1.5) * sh.s);
      const alpha = Math.max(0.16, 0.44 - h * 0.30);
      if (crowdCacheSupported()) {
        const sp = ballShadowSprite(sr);
        ctx.globalAlpha = alpha;
        ctx.drawImage(sp.canvas, sh.x - sp.size / 2, sh.y - sp.size / 2, sp.size, sp.size);
        ctx.globalAlpha = 1;
      } else {
        const g = ctx.createRadialGradient(sh.x, sh.y, 0, sh.x, sh.y, sr);
        g.addColorStop(0, `rgba(0,0,0,${alpha.toFixed(3)})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sh.x, sh.y, sr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (shadowOnly) return;
    const p = cam.project(pos);
    if (!p) return;
    const r = Math.max(1.6, R.BALL_RADIUS * p.s);
    // 速度拉伸：沿速度反方向画一道向尾端透明的拉丝，高速球在屏幕上"变长"（与尾影互补）
    const spd = vel ? Math.hypot(vel.x, vel.y, vel.z) : 0;
    if (spd > 7) {
      const dir = vnorm(vel);
      const len = Math.min(0.55, spd * 0.026) * (low ? 0.6 : 1);
      const pt = cam.project(vsub(pos, vscale(dir, len)));
      if (pt) {
        const a = Math.min(0.34, 0.10 + (spd - 7) / 40) * (low ? 0.7 : 1);
        const g = ctx.createLinearGradient(pt.x, pt.y, p.x, p.y);
        g.addColorStop(0, 'rgba(210,235,255,0)');
        g.addColorStop(1, `rgba(235,246,255,${a.toFixed(3)})`);
        ctx.strokeStyle = g;
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(1.2, r * 1.25);
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
    }
    if (crowdCacheSupported()) {
      const sp = ballSprite(r);
      ctx.drawImage(sp.canvas, p.x - sp.size / 2, p.y - sp.size / 2, sp.size, sp.size);
    } else {
      const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.12, p.x, p.y, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.75, '#e8edf4');
      g.addColorStop(1, '#aab6c6');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,55,75,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // 旋转高光（表现旋转）
    const sp = Math.hypot(spin.x, spin.y, spin.z);
    if (sp > 5) {
      const ang = time * (2 + sp * 0.12);
      const hx = Math.cos(ang) * r * 0.28, hy = Math.sin(ang) * r * 0.28;
      ctx.fillStyle = 'rgba(208,50,30,0.9)';
      ctx.beginPath();
      ctx.arc(p.x + hx, p.y + hy, r * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 球台撞击特效：默认扩散红圈+中心闪光；装备"撞击溅射"时(type='splash')改为飞溅粒子。
  // v2.4 预算：low 时溅射只保留主冲击波纹（不画粒子）；溅射粒子色随装备尾影匹配（trailStyle）。
  function drawEffects(ctx, cam, fx, time, low, trailStyle) {
    for (const f of fx || []) {
      const age = time - f.t0;
      if (age < 0) continue;
      if (f.type === 'hit') { drawHitSpark(ctx, cam, f, age, low); continue; }
      if (age > 0.45) continue;
      const k = age / 0.45;
      const p = cam.project(v3(f.x, R.TABLE_HEIGHT + 0.006, f.z));
      if (!p) continue;
      if (f.type === 'splash') {
        drawSplash(ctx, p, k, low, trailStyle);
        continue;
      }
      const r = (0.045 + k * 0.40) * p.s;
      const alpha = (1 - k) * 0.85;
      ctx.strokeStyle = `rgba(208,50,30,${alpha.toFixed(3)})`;
      ctx.lineWidth = Math.max(1.5, 0.018 * p.s * (1 - k * 0.55));
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r, r * 0.52, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,214,170,${((1 - k) * 0.75).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.2, r * 0.16), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 撞击溅射粒子(增强 v2.0)：中心冲击闪光 + 双层粒子(亮火花 + 暗尾粒)。
  // v2.4：粒子数手机端减半（6）/桌面 8；低画质仅主冲击波纹；装备尾影时粒子用同色系（SPLASH_RGB 匹配）。
  // v2.7.0：特效质量随画质分级——高=全额(14)、中=大部分(8)、低=少量(4)，低画质不再完全关闭粒子（手机端再减半）。
  function fxTier() {
    return (root && root.PPD && root.PPD.app && root.PPD.app.quality && root.PPD.app.quality.mode) || 'high';
  }
  function drawSplash(ctx, p, k, low, trailStyle) {
    // 中心冲击闪光：短促的白亮圈(仅前 40% 生命周期,随后被飞溅粒子覆盖)
    if (k < 0.45) {
      const flash = 1 - k / 0.45;
      const fr = (0.02 + k * 0.12) * p.s;
      ctx.fillStyle = `rgba(255,236,190,${(flash * 0.6).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, fr, 0, Math.PI * 2);
      ctx.fill();
    }
    // v2.7.0：低画质不再完全关闭粒子，改为少量（保留撞击观感）
    const tier = fxTier();
    const base = tier === 'high' ? 14 : tier === 'medium' ? 8 : 4;
    const n = isTouchNow() ? Math.max(2, Math.round(base / 2)) : base;
    const rgb = SPLASH_RGB[trailStyle] || null; // 与装备尾影配色匹配；未装备默认橙红渐变
    for (let i = 0; i < n; i++) {
      const seed = (i * 0.618 + p.x * 0.0371) % 1;
      const a = seed * Math.PI * 2 + (i % 3) * 0.35;
      const speed = 0.5 + ((i * 0.382) % 1);          // 飞溅速度(外扩速率,粒子间差异)
      const dist = (0.02 + 0.14 * k * speed) * p.s;
      const px = p.x + Math.cos(a) * dist;
      const py = p.y + Math.sin(a) * dist * 0.55;
      const big = i % 3 !== 2;                        // 2/3 亮火花 + 1/3 暗尾粒
      const r = Math.max(big ? 1.1 : 0.7, 0.024 * p.s * (1 - k) * (big ? (0.6 + ((i * 0.37) % 1) * 0.8) : 0.45));
      const alpha = (1 - k) * (big ? 0.95 : 0.6);
      if (rgb) {
        // 尾影同色系：亮火花按亮度微调、暗尾粒压暗
        const mul = big ? (0.75 + ((i * 0.37) % 1) * 0.45) : 0.5;
        ctx.fillStyle = `rgba(${Math.round(rgb[0] * mul)},${Math.round(rgb[1] * mul)},${Math.round(rgb[2] * mul)},${alpha.toFixed(3)})`;
      } else {
        const hue = big ? (15 + ((i * 9) % 20)) : (30 + ((i * 11) % 20)); // 橙红渐变
        const light = big ? (58 + ((i * 7) % 22)) : (48 + ((i * 9) % 15));
        ctx.fillStyle = `hsla(${hue},100%,${light}%,${alpha.toFixed(3)})`;
      }
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 击球火花（v3.6.0）：球拍触球瞬间的放射短线 + 中心闪光，画在真实球位（不贴台面）。
  // pow=0..1 由出球速度决定；越高火花越长越白（扣杀）。低画质/低档位减少条数。
  function drawHitSpark(ctx, cam, f, age, low) {
    const life = 0.30;
    if (age < 0 || age > life) return;
    const p = cam.project(v3(f.x, f.y, f.z));
    if (!p) return;
    const k = age / life;
    const pow = clamp(f.pow == null ? 0.7 : f.pow, 0, 1);
    const tier = fxTier();
    const n = (low || tier === 'low') ? 4 : tier === 'medium' ? 6 : 9;
    const fade = 1 - k;
    const fr = Math.max(1.5, (0.012 + 0.05 * k) * p.s * (0.7 + pow * 0.6));
    ctx.fillStyle = `rgba(255,244,214,${(0.75 * fade).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, fr, 0, Math.PI * 2);
    ctx.fill();
    const seedBase = f.x * 37.1 + f.z * 91.7;
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const seed = ((seedBase + i * 0.618) % 1 + 1) % 1;
      const ang = seed * Math.PI * 2;
      const d0 = (0.015 + 0.02 * k) * p.s * pow;
      const d1 = (0.03 + 0.11 * k * (0.5 + seed)) * p.s * (0.6 + pow * 0.7);
      ctx.strokeStyle = `rgba(255,${Math.round(180 + pow * 50)},${Math.round(120 + pow * 90)},${(0.85 * fade).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, 0.006 * p.s * fade);
      ctx.beginPath();
      ctx.moveTo(p.x + Math.cos(ang) * d0, p.y + Math.sin(ang) * d0);
      ctx.lineTo(p.x + Math.cos(ang) * d1, p.y + Math.sin(ang) * d1);
      ctx.stroke();
    }
  }

  // 对抗尾影：球飞行路径的渐隐残影（点含时间戳，按年龄淡出）。
  // trailStyle=已装备尾影(yellow/black/red)时换色并附带粒子；未装备用默认浅蓝。
  // v2.4 预算：主轨迹按年龄分 4 段合成（每段 1 次 stroke，替代逐段 60+ 次提交）；
  // low 时只画主轨迹、关闭粒子（保留拖影观感、省路径提交）。
  function drawTrail(ctx, cam, trail, time, trailStyle, low) {
    if (!trail || trail.length < 2) return;
    const color = TRAIL_COLORS[trailStyle] || 'rgba(150,210,255,';
    ctx.lineCap = 'round';
    const SEGS = 4; // 年龄带数：每带一次 stroke
    for (let s = 0; s < SEGS; s++) {
      const k0 = s / SEGS, k1 = (s + 1) / SEGS;
      const midK = (k0 + k1) / 2;
      // v2.7.0 尾影削弱：透明度 0.65→0.55（对应本实现 0.5→0.42）
      ctx.strokeStyle = `${color}${(0.42 * midK).toFixed(3)})`;
      let started = false;
      let bandW = 1.2;
      ctx.beginPath();
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1], b = trail[i];
        const age = time - b.t;
        if (age < 0 || age > 0.4) continue;
        const k = 1 - age / 0.4;
        if (k < k0 || k >= k1) continue;
        const pa = cam.project({ x: a.x, y: a.y, z: a.z });
        const pb = cam.project({ x: b.x, y: b.y, z: b.z });
        if (!pa || !pb) continue;
        if (!started) { ctx.moveTo(pa.x, pa.y); started = true; }
        ctx.lineTo(pb.x, pb.y);
        // v2.7.0 尾影削弱：主线宽 1.6→1.4（系数 0.022→0.019）
        const w = Math.max(1.2, 0.019 * Math.max(pa.s, pb.s) * (0.35 + 0.65 * midK));
        if (w > bandW) bandW = w;
      }
      if (started) { ctx.lineWidth = bandW; ctx.stroke(); }
    }
    // v2.7.0：粒子随画质分级（高逐点/中隔点/低隔4点），低画质不再完全关闭；仅装备尾影附带
    if (TRAIL_COLORS[trailStyle]) drawTrailParticles(ctx, cam, trail, time, color, low);
  }

  function drawTrailParticles(ctx, cam, trail, time, color, low) {
    // v2.7.0 分级：高=逐点(1)、中=隔点(2，手机 4)、低=隔4点(4)；粒子半径/亮度回调（尾影削弱）
    const tier = fxTier();
    let step;
    if (low || tier === 'low') step = 4;
    else if (tier === 'high') step = 1;
    else step = isTouchNow() ? 4 : 2;
    for (let i = 1; i < trail.length; i += step) {
      const b = trail[i];
      const age = time - b.t;
      if (age < 0 || age > 0.4) continue;
      const k = 1 - age / 0.4;
      const p = cam.project({ x: b.x, y: b.y, z: b.z });
      if (!p) continue;
      const seed = (i * 13.7 + b.t * 41.3) % 1;
      const ang = seed * Math.PI * 2;
      const d = (0.5 + (i % 3) * 0.6) * k * 0.014 * p.s;
      const px = p.x + Math.cos(ang) * d;
      const py = p.y + Math.sin(ang) * d;
      // v2.7.0 尾影削弱：粒子半径/亮度回调（半径系数 0.010→0.0085、alpha 0.7→0.6）
      const r = Math.max(0.7, 0.0085 * p.s * k * (0.65 + (i % 4) * 0.25));
      ctx.fillStyle = `${color}${(0.6 * k).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 发球预计轨迹：白虚线弧线 + 末端落点标记
  // 渐隐分段绘制：把 ~64 段独立 stroke 合成 5 段（每段一条路径一次 stroke）——
  // 原实现每段 beginPath+stroke 触发 64 次渲染管线提交，是等待发球阶段掉帧主因
  function drawServePath(ctx, cam, pts) {
    if (!pts || pts.length < 2) return;
    ctx.lineCap = 'round';
    ctx.setLineDash([4, 7]);
    const N = pts.length;
    const SEGS = 5;
    const per = Math.ceil((N - 1) / SEGS);
    for (let seg = 0; seg < SEGS; seg++) {
      const iStart = 1 + seg * per;
      const iEnd = Math.min(N - 1, iStart + per);
      if (iStart >= N) break;
      const kEnd = iEnd / (N - 1);
      ctx.strokeStyle = `rgba(255,255,255,${(0.75 * (1 - kEnd * 0.55)).toFixed(3)})`;
      let started = false;
      let w = 1;
      for (let i = iStart; i <= iEnd; i++) {
        const pa = cam.project(pts[i - 1]), pb = cam.project(pts[i]);
        if (!pa || !pb) { started = false; continue; }
        if (!started) { ctx.beginPath(); ctx.moveTo(pa.x, pa.y); started = true; }
        ctx.lineTo(pb.x, pb.y);
        w = Math.max(1, 0.018 * Math.min(pa.s, pb.s));
      }
      if (started) { ctx.lineWidth = w; ctx.stroke(); }
    }
    ctx.setLineDash([]);
    // 落点标记（画在采样终点附近，近似展示球最终落台位置）
    const last = pts[pts.length - 1];
    const pl = cam.project(last);
    if (pl) {
      const r = Math.max(3, 0.05 * pl.s);
      ctx.fillStyle = 'rgba(255,196,120,0.85)';
      ctx.beginPath(); ctx.arc(pl.x, pl.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(pl.x, pl.y, r + 2.5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  // 判定范围虚线：以 center 为圆心、radius 为半径、由基向量 u/v 张成平面的虚线圆环
  function drawDashedCircle(ctx, cam, center, radius, u, v, color) {
    const N = 48;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const p = cam.project(v3(
        center.x + (c * u.x + s * v.x) * radius,
        center.y + (c * u.y + s * v.y) * radius,
        center.z + (c * u.z + s * v.z) * radius
      ));
      if (!p) return;
      pts.push(p);
    }
    const sc = pts[Math.floor(N / 4)].s;
    ctx.setLineDash([6, 8]);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, 0.018 * sc);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i <= N; i++) ctx.lineTo(pts[i % N].x, pts[i % N].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 球拍判定范围：水平虚线圆环
  function drawHitRangeRing(ctx, cam, center, radius, color) {
    drawDashedCircle(ctx, cam, center, radius, v3(1, 0, 0), v3(0, 0, 1), color);
  }

  // 球判定范围：球形线框（水平环 + 面向相机的垂直环），直观呈现球形判定
  function drawHitRangeSphere(ctx, cam, center, radius, color) {
    drawDashedCircle(ctx, cam, center, radius, v3(1, 0, 0), v3(0, 0, 1), color); // 水平环
    drawDashedCircle(ctx, cam, center, radius, cam.right, cam.up, color);        // 面向相机垂直环
  }

  // 接球碰撞箱线框：以 center 为中心、半尺寸(hw,hh,hd) 的虚线长方体（12 条棱）
  function drawHitBox(ctx, cam, center, hw, hh, hd, color) {
    const cs = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      cs.push(v3(center.x + sx * hw, center.y + sy * hh, center.z + sz * hd));
    }
    // 12 条棱：x 向（同 sy/sz）、y 向（同 sx/sz）、z 向（同 sx/sy）
    const edges = [[0,4],[1,5],[2,6],[3,7],[0,2],[1,3],[4,6],[5,7],[0,1],[2,3],[4,5],[6,7]];
    ctx.setLineDash([6, 8]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    // 12 棱合成单条路径一次 stroke（原 12 次独立 beginPath/stroke 是虚线碰撞箱帧开销大头）
    ctx.beginPath();
    for (const [a, b] of edges) {
      const pa = cam.project(cs[a]), pb = cam.project(cs[b]);
      if (!pa || !pb) continue;
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 球员脚下接触阴影（胯下阴影）：软化椭圆，让球员"踩"在地板上、增强立体感。
  // 近侧球员脚部常被画面底部裁切：阴影贴画面底部显示，保证可见
  function drawPlayerShadows(ctx, cam, players) {
    const H = (ctx.canvas && ctx.canvas.height) || 720;
    for (const pl of players || []) {
      const q = cam.project(v3(pl.x, 0.004, pl.z));
      if (!q) continue;
      const cy = Math.min(q.y, H - 12);
      if (cy < 0) continue;
      const r = Math.max(4, 0.34 * q.s);
      if (crowdCacheSupported()) {
        const sp = playerShadowSprite(r);
        ctx.drawImage(sp.canvas, q.x - sp.size / 2, cy - sp.size / 2, sp.size, sp.size);
      } else {
        const g = ctx.createRadialGradient(q.x, cy, 0, q.x, cy, r);
        g.addColorStop(0, 'rgba(0,0,0,0.34)');
        g.addColorStop(0.6, 'rgba(0,0,0,0.18)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(q.x, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /* ============================================================================
   * 参考图底板（2026-10-23）
   *
   * 用户要求"直接用参考图，去掉水印"。参考图里球台/球网/光海/光锥/地板/看台都已画好，
   * 只有球员/球/HUD 是"死"的，已用 tools/make-arena-plate.py 擦掉，
   * 产出 public/assets/arena/arena_plate.jpg。
   *
   * 用法：铺满画幅当背景，然后只画球员/球/特效。相机已被标定到这张图的球台四角
   * （tools/solve-arena-camera.cjs），所以球员正好站在底板球台上。
   *
   * 兼容：贴图没加载好（或 Node 测试桩无 Image）时自动退回程序化场景，
   *       保证任何情况下都有画面、测试也不受影响。
   * ========================================================================== */
  // 默认 'proc'：按参考图**用代码绘制**。'plate' 只是留作对照的调试开关。
  const ARENA_PLATE = { img: null, ok: false, mode: 'proc', flip: false };
  // app 层在镜像视口（红方 ctx.scale(-1,1)）时置 true，让底片在屏幕上保持原样
  function setArenaFlip(v) { ARENA_PLATE.flip = !!v; }
  (() => {
    try {
      if (typeof Image === 'undefined') return;
      const im = new Image();
      im.onload = () => {
        ARENA_PLATE.ok = !!(im.naturalWidth > 0);
        clearCrowdCache();
      };
      im.onerror = () => { ARENA_PLATE.ok = false; };
      im.src = 'assets/arena/arena_plate.jpg';
      ARENA_PLATE.img = im;
    } catch (e) { ARENA_PLATE.ok = false; }
  })();
  // 切底板 / 程序化场景（调试用）：setArenaPlate('plate'|'proc')
  function setArenaPlate(m) {
    if (m !== 'plate' && m !== 'proc') return ARENA_PLATE.mode;
    ARENA_PLATE.mode = m;
    clearCrowdCache();
    return ARENA_PLATE.mode;
  }
  const arenaPlateMode = () => ARENA_PLATE.mode;
  const plateReady = () => ARENA_PLATE.mode === 'plate' && ARENA_PLATE.ok
    && ARENA_PLATE.img && ARENA_PLATE.img.complete && ARENA_PLATE.img.naturalWidth > 0;

  /* 铺底板：整幅拉伸（底板本身就是按这个机位渲的，不需要再投影）。
     再叠一层很淡的暖色雾，让程序画的球员/球与底片的色调接上。 */
  function drawArenaPlate(ctx, vw, vh) {
    const im = ARENA_PLATE.img;
    /* ⚠ 底片要"抵消"视口镜像：
       红方视角（side 0）整幅画布做了 ctx.scale(-1,1) 镜像，
       如果直接 drawImage，底片会左右翻转（实测：左橙右青变成左青右橙，与参考图相反）。
       这里检测当前变换的 a 是否为负，是就把底片自己再翻一次，让它在屏幕上保持原样。
       球员/球仍走原来的镜像逻辑（它们必须跟着视角翻转才是对的）。 */
    /* ⚠ 必须在**未镜像**的画布上调用：
       app 层把"铺底片"放在 applyViewMirror 之前（见 renderSingle / renderOnline / renderLocal）。
       实测（tools/diag-flip.cjs）：镜像画布上直接 drawImage 会让左右配色反过来。 */
    ctx.drawImage(im, 0, 0, vw, vh);
    // 轻微压暗四角，把注意力收回到球台（底板自带一点，这里再补一档）
    const g = ctx.createRadialGradient(vw / 2, vh * 0.55, Math.min(vw, vh) * 0.34,
                                       vw / 2, vh * 0.55, Math.hypot(vw / 2, vh / 2) * 1.02);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.62, 'rgba(0,0,0,0.10)');
    g.addColorStop(1, 'rgba(0,0,0,0.34)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);
  }

  // ---------- 场景 ----------
  // view: { cam, players, ball, time, side, fan, teamFixed }
  function drawScene(ctx, view, vw, vh) {
    /* 底片翻转标志由调用方每帧显式给出（view.plateFlip）。
       早先用全局 setArenaFlip(true) 置位，但它是"粘滞"的：
       红方视口置 true 后，蓝方视口（不镜像）也跟着翻转 ⇒ 截图里左右配色正好反了。 */
    ARENA_PLATE.flip = !!view.plateFlip;
    const { cam, time } = view;
    const low = !!view.low;
    /* 〔2026-10-23 参考图底板〕底片由 app 层在**镜像之外**先铺好（见 drawArenaPlate 注释），
       这里只负责"底板模式不画地板/看台/球台/球网"。
       贴图没就绪时自动退回原来的程序化场景（保证任何情况下都有画面）。 */
    const usePlate = plateReady();
    if (!usePlate) {
      drawFloor(ctx, cam, vw, vh, time, view.side, view.fan, low, view.density, view.noCrowd, view.teamFixed);
    }
    drawPlayerShadows(ctx, cam, view.players);

    // 球台对侧的玩家（对手）先画：随后绘制的球台表面会盖住其腿部，
    // 避免对手的腿“踩”在球台之上
    const farPlayers = [];
    const nearPlayers = [];
    for (const pl of view.players) {
      (pl.side === view.side ? nearPlayers : farPlayers).push(pl);
    }
    for (const pl of farPlayers) {
      if (root && root.TTG && root.TTG.drawCharacter) {
        root.TTG.drawCharacter(ctx, cam, pl, view.ball, time, view.side, view.hideOwn, view.hideLegs);
      }
    }

    // 底板模式下球台与球网已经在图里，不再重画（否则会与底片重影）
    if (!usePlate) {
      drawTable(ctx, cam);
      drawNet(ctx, cam);
    }
    drawEffects(ctx, cam, view.fx, time, !!view.low, view.trailStyle); // 低画质关溅射粒子、溅射随尾影配色
    // 发球预测轨迹与对抗尾影画在球台之上、角色/球之下（避免被不透明台面遮挡）
    if (view.servePath) drawServePath(ctx, cam, view.servePath);
    // v2.4：低画质也保留尾影主轨迹（无粒子），关掉 !low 整体跳过
    if (view.trail && view.trail.length > 1 && !view.trailHidden) drawTrail(ctx, cam, view.trail, time, view.trailStyle, !!view.low);
    // 判定范围虚线（首页开关控制）：与实际判定一致——接球碰撞箱（进箱即命中，
    // 以球员为中心、向网前偏移 0.42m；蹲下时箱体下探可接贴地球）
    if (view.showHitRanges) {
      const bpos = view.ball ? view.ball.pos : null;
      for (const pl of view.players) {
        const yTop = pl.crouch ? R.CROUCH_HITBOX_Y_TOP : R.HITBOX_Y_TOP;
        const yBottom = pl.crouch ? R.CROUCH_HITBOX_Y_BOTTOM : R.HITBOX_Y_BOTTOM;
        // 球在该球员箱内 → 绿框高亮（进箱即命中，所见即所得）
        const inBox = !!(bpos &&
          Math.abs(bpos.x - pl.x) < R.HITBOX_HX &&
          Math.abs(bpos.z - (pl.z + (pl.facing || 0) * R.HITBOX_Z_OFF)) < R.HITBOX_HZ &&
          bpos.y > yBottom && bpos.y < yTop);
        drawHitBox(ctx, cam,
          v3(pl.x, (yTop + yBottom) / 2, pl.z + (pl.facing || 0) * R.HITBOX_Z_OFF),
          R.HITBOX_HX, (yTop - yBottom) / 2, R.HITBOX_HZ,
          inBox ? 'rgba(74,222,128,0.9)' : 'rgba(255,255,255,0.55)');
      }
    }

    // 近侧玩家与球按深度排序（远→近）
    const objects = [];
    for (const pl of nearPlayers) {
      objects.push({ kind: 'player', pl, d: cam.depth(v3(pl.x, 1.0, pl.z)) });
    }
    if (view.ball) {
      objects.push({ kind: 'ball', d: cam.depth(view.ball.pos) });
    }
    objects.sort((a, b) => b.d - a.d);
    for (const o of objects) {
      if (o.kind === 'player') {
        if (root && root.TTG && root.TTG.drawCharacter) {
          root.TTG.drawCharacter(ctx, cam, o.pl, view.ball, time, view.side, view.hideOwn, view.hideLegs);
        }
      } else if (view.ball) {
        drawBall(ctx, cam, view.ball.pos, view.ball.spin, time, false, view.ball.vel, low);
      }
    }
    // 球在发球者手中时绘制在角色之后（手部之前会由角色绘制）
    if (view.ballInHand) {
      drawBall(ctx, cam, view.ballInHand, v3(0, 0, 0), time);
    }
    /* 〔2026-10-22 暗场〕overlay 模式：整帧最后画一次「球台避让 + 四角暗角 + 体积光」。
       它不压暗台面与它脚下的球员（径向渐变内半径留空），只把画面边缘收进黑暗。
       world 模式的世界层压暗已经在 drawFloor 的缓存里，这里不重复。 */
    if (LIGHTING.overlay) drawLighting(ctx, cam, vw, vh, 'overlay', view.players);
  }

  return { v3, vadd, vsub, vscale, vlen, vnorm, vdot, vcross, clamp, lerp, Camera, limb, box, poly, line, drawScene, drawBall, drawTable, drawNet, drawFloor, drawFloorBg, drawCrowd, crowdLayout, seatedPose, drawPerson, benchLayout, drawBenches, drawPlayerShadows, drawEffects, drawTrail, drawServePath, drawHitRangeRing, drawHitRangeSphere, drawHitBox, shade, clearCrowdCache, setCrowdColors,
    // 〔2026-10-22〕暗场灯光：setLightingMode('world'|'overlay'|'off') / lightingMode() / drawLighting(...)
    setLightingMode, lightingMode, drawLighting, LIGHT_AMB,
    // 〔2026-10-23〕参考图底板：setArenaPlate('plate'|'proc') / arenaPlateMode() / plateReady()
    setArenaPlate, arenaPlateMode, plateReady, drawArenaPlate, setArenaFlip };
});
