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
  const C = {
    tableTop: '#1e6fd9',
    tableEdge: '#c9d4e2',
    tableSide: '#8fa3ba',
    netPost: '#d7dde6',
    netTape: '#111827',
    netMesh: 'rgba(245,247,250,0.32)',
    ball: '#ffffff',
  };

  // ---------- 观众席（坐姿火柴人，与球员同一画风：圆头 + 骨线骨架） ----------
  // 场地两端 + 两侧共四个方向的观众席，一次性生成固定站位（确定性伪随机）
  let crowdList = null;
  function crowdLayout() {
    const list = [];
    let seed = 20260804;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const person = (x, y, z) => ({
      x: x + (rnd() - 0.5) * 0.2, y: y + (rnd() - 0.5) * 0.1, z,
      ph: rnd() * Math.PI * 2, c: rnd(),
    });
    // 两端看台（z = ±6.35，球台远端），四排（由远到近生成，保证遮挡顺序正确）
    for (const ez of [-6.35, 6.35]) {
      for (let row = 3; row >= 0; row--) {
        const z = ez + row * 0.5;
        for (let x = -5.2; x <= 5.2; x += 0.46) list.push(person(x, 0.25 + row * 0.48, z));
      }
    }
    // 两侧看台（x = ±3.62/4.17/4.72，四排，面向球台；由外到内生成）
    for (const sx of [-1, 1]) {
      for (let row = 3; row >= 0; row--) {
        const x = sx * (3.62 + row * 0.55);
        for (let z = -5.5; z <= 5.5; z += 0.46) list.push(person(x, 0.25 + row * 0.48, z + (rnd() - 0.5) * 0.2));
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

  // 座位（长条座椅 + 靠背）：与观众行对齐的看台座席，一次性生成
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
    // 背景渐变
    const g = ctx.createLinearGradient(0, 0, 0, vh);
    g.addColorStop(0, '#141b2b');
    g.addColorStop(0.45, '#1b2437');
    g.addColorStop(1, '#0d1220');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);

    // 场地木地板
    const arena = [
      v3(-3.4, 0, -4.6), v3(3.4, 0, -4.6), v3(3.4, 0, 4.6), v3(-3.4, 0, 4.6),
    ];
    const pa = arena.map((p) => cam.project(p));
    if (pa.every((p) => p)) {
      const lg = ctx.createLinearGradient(0, pa[0].y, 0, pa[2].y);
      lg.addColorStop(0, '#7c4a21');
      lg.addColorStop(1, '#a06a33');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(pa[0].x, pa[0].y);
      for (let i = 1; i < pa.length; i++) ctx.lineTo(pa[i].x, pa[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // 地板格线
      for (let x = -3; x <= 3; x += 1) {
        line(ctx, cam, v3(x, 0.001, -4.5), v3(x, 0.001, 4.5), 'rgba(60,30,10,0.25)', 0.012);
      }
      for (let z = -4; z <= 4; z += 1) {
        line(ctx, cam, v3(-3.3, 0.001, z), v3(3.3, 0.001, z), 'rgba(60,30,10,0.25)', 0.012);
      }
      // 比赛区域围挡（低广告板）
      const barrier = [
        [v3(-3.2, 0, -3.2), v3(3.2, 0, -3.2), v3(3.2, 0.9, -3.2), v3(-3.2, 0.9, -3.2)],
        [v3(-3.2, 0, 3.2), v3(3.2, 0, 3.2), v3(3.2, 0.9, 3.2), v3(-3.2, 0.9, 3.2)],
        [v3(-3.2, 0, -3.2), v3(-3.2, 0, 3.2), v3(-3.2, 0.9, 3.2), v3(-3.2, 0.9, -3.2)],
        [v3(3.2, 0, -3.2), v3(3.2, 0, 3.2), v3(3.2, 0.9, 3.2), v3(3.2, 0.9, -3.2)],
      ];
      for (const b of barrier) poly(ctx, cam, b, 'rgba(20,42,74,0.9)', 'rgba(0,0,0,0.4)');
    }
  }

  // 观众席绘制：坐姿火柴人按视角分阵营——屏幕左侧(x<0)=己方观众（红色），
  // 右侧=敌方观众（蓝色）；得分方欢呼举手、对方摇头
  const CROWD_OUTLINE = 'rgba(15,20,28,0.45)';
  const CROWD_R = 0.028; // 骨线粗
  const FAN_COL = ['rgba(240,110,92,0.95)', 'rgba(110,160,246,0.95)']; // 红方 / 蓝方

  // 画单个观众（供逐帧全量 / 动画层共用）
  function drawPerson(ctx, cam, s, time, cheer, shake, col) {
    const c = (cheer && cheer[0] != null) ? cheer : 0;
    const sh = (shake && shake[0] != null) ? shake : 0;
    const p = seatedPose(s, time, c, sh);
    const hp = cam.project(p.head);
    const fp = cam.project(p.hips);
    if (!hp || !fp) return;
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
      // 太远：只画头 + 躯干
      limb(ctx, cam, p.hips, p.shoulder, CROWD_R * 0.85, col, null);
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

  function drawCrowd(ctx, cam, time, viewSide, fan) {
    if (!crowdList) crowdList = crowdLayout();
    for (const s of crowdList) {
      // 屏幕左侧（世界 x<0）为当前视角己方球迷，右侧为敌方球迷
      const team = s.x < 0 ? (viewSide || 0) : 1 - (viewSide || 0);
      const col = FAN_COL[team];
      const c = (fan && fan.cheer) ? fan.cheer[team] : 0;
      const sh = (fan && fan.shake) ? fan.shake[team] : 0;
      drawPerson(ctx, cam, s, time, c, sh, col);
    }
  }

  // 动画层：仅重画得分后欢呼/摇头的观众（叠加在离屏缓存之上，瞬态 ~1.7s）
  function drawCrowdAnimated(ctx, cam, time, viewSide, fan) {
    if (!fan || !fan.cheer || !fan.shake) return;
    // 无任何动画（常规对打帧）直接返回，省去整轮观众循环
    if (!(fan.cheer[0] > 0 || fan.cheer[1] > 0 || fan.shake[0] > 0 || fan.shake[1] > 0)) return;
    for (const s of crowdList) {
      const team = s.x < 0 ? (viewSide || 0) : 1 - (viewSide || 0);
      const c = (fan.cheer && fan.cheer[team]) || 0;
      const sh = (fan.shake && fan.shake[team]) || 0;
      if (c > 0 || sh > 0) drawPerson(ctx, cam, s, time, c, sh, FAN_COL[team]);
    }
  }

  // ---------- 观众席离屏缓存（最大帧开销：~380 观众 × 5,600 次路径 + ~11k 临时对象） ----------
  // 相机多数帧静止（±0.62m 死区）→ 静态层（地板/看台/静止观众）预渲染进离屏 canvas，
  // 相机平移超 0.04m 桶或尺寸/DPR 变化才重建，否则每帧一次 drawImage 整层 blit。
  // 得分后 1.7s 的欢呼/摇头观众由动画层动态叠加。
  // 无 document.createElement 的环境（测试桩/极端环境）自动回退逐帧直画。
  const CROWD_CAM_BUCKET = 0.04;
  let crowdCache = null; // { key, canvas, ctx }
  function clearCrowdCache() { crowdCache = null; }
  function crowdCacheSupported() {
    return typeof document !== 'undefined' && !!document.createElement &&
      typeof document.createElement('canvas').getContext === 'function';
  }
  function rebuildCrowdCache(cam, vw, vh, viewSide, mainCtx) {
    const dpr = mainCtx.canvas ? Math.max(1, mainCtx.canvas.width / Math.max(1, vw)) : 1;
    crowdCache.canvas.width = Math.max(1, Math.round(vw * dpr));
    crowdCache.canvas.height = Math.max(1, Math.round(vh * dpr));
    const cc = crowdCache.ctx;
    cc.setTransform(dpr, 0, 0, dpr, 0, 0);
    cc.clearRect(0, 0, vw, vh);
    drawFloorBg(cc, cam, vw, vh);
    drawBenches(cc, cam);
    drawCrowd(cc, cam, 0, viewSide, null); // 静止 rest 姿态（time=0, 无欢呼）
  }

  function drawFloor(ctx, cam, vw, vh, time, viewSide, fan, low) {
    drawFloorBg(ctx, cam, vw, vh);
    if (low) return; // 低画质：跳过观众席 + 看台
    if (!crowdList) crowdList = crowdLayout();
    // 离屏缓存可用（有 createElement 且非测试桩）：静态层一次绘制、多帧 blit
    if (crowdCacheSupported()) {
      const backing = (ctx.canvas && ctx.canvas.width) || 0;
      const key = `${viewSide}:${Math.round(cam.eye.x / CROWD_CAM_BUCKET)}:${vw}:${vh}:${backing}`;
      if (!crowdCache) crowdCache = { canvas: document.createElement('canvas'), ctx: null, key: '' };
      if (!crowdCache.ctx) crowdCache.ctx = crowdCache.canvas.getContext('2d');
      if (crowdCache.key !== key) {
        crowdCache.key = key;
        rebuildCrowdCache(cam, vw, vh, viewSide, ctx);
      }
      ctx.drawImage(crowdCache.canvas, 0, 0, vw, vh);
      // 动画层：得分后欢呼/摇头的少数观众叠加（其余保持缓存静止画面）
      drawCrowdAnimated(ctx, cam, time, viewSide, fan);
    } else {
      drawBenches(ctx, cam); // 先画座位（观众坐在其上）
      drawCrowd(ctx, cam, time, viewSide, fan);
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

  function drawBall(ctx, cam, pos, spin, time, shadowOnly) {
    // 影子：球在台面上方时投在台面，否则投在地面；球越高影子越大越淡
    const overTable = Math.abs(pos.x) <= R.TABLE_WIDTH / 2 &&
      Math.abs(pos.z) <= R.TABLE_LENGTH / 2;
    const shY = overTable ? R.TABLE_HEIGHT + 0.005 : 0.003;
    const sh = cam.project(v3(pos.x, shY, pos.z));
    if (sh) {
      const h = Math.max(0, pos.y - shY);
      const sr = Math.max(2, R.BALL_RADIUS * (2.2 + h * 1.5) * sh.s);
      const g = ctx.createRadialGradient(sh.x, sh.y, 0, sh.x, sh.y, sr);
      const alpha = Math.max(0.16, 0.44 - h * 0.30);
      g.addColorStop(0, `rgba(0,0,0,${alpha.toFixed(3)})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sh.x, sh.y, sr, 0, Math.PI * 2);
      ctx.fill();
    }
    if (shadowOnly) return;
    const p = cam.project(pos);
    if (!p) return;
    const r = Math.max(1.6, R.BALL_RADIUS * p.s);
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

  // 球台撞击特效：以落点为中心的扩散红圈 + 中心闪光
  function drawEffects(ctx, cam, fx, time) {
    for (const f of fx || []) {
      const age = time - f.t0;
      if (age < 0 || age > 0.45) continue;
      const k = age / 0.45;
      const p = cam.project(v3(f.x, R.TABLE_HEIGHT + 0.006, f.z));
      if (!p) continue;
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

  // 对抗尾影：球飞行路径的渐隐残影（点含时间戳，按年龄淡出）
  function drawTrail(ctx, cam, trail, time) {
    if (!trail || trail.length < 2) return;
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1], b = trail[i];
      const age = time - b.t;
      if (age < 0 || age > 0.4) continue;
      const k = 1 - age / 0.4;
      const pa = cam.project({ x: a.x, y: a.y, z: a.z });
      const pb = cam.project({ x: b.x, y: b.y, z: b.z });
      if (!pa || !pb) continue;
      const w = Math.max(1.2, 0.022 * Math.min(pa.s, pb.s) * (0.35 + 0.65 * k));
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(150,210,255,${(0.5 * k).toFixed(3)})`;
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
  }

  // 发球预计轨迹：白虚线弧线 + 末端落点标记
  function drawServePath(ctx, cam, pts) {
    if (!pts || pts.length < 2) return;
    ctx.lineCap = 'round';
    ctx.setLineDash([4, 7]);
    for (let i = 1; i < pts.length; i++) {
      const pa = cam.project(pts[i - 1]), pb = cam.project(pts[i]);
      if (!pa || !pb) continue;
      const k = i / (pts.length - 1);
      ctx.strokeStyle = `rgba(255,255,255,${(0.75 * (1 - k * 0.55)).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, 0.018 * Math.min(pa.s, pb.s));
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
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
    for (const [a, b] of edges) {
      const pa = cam.project(cs[a]), pb = cam.project(cs[b]);
      if (!pa || !pb) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
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

  // ---------- 场景 ----------
  // view: { cam, players, ball, time, side, fan }
  function drawScene(ctx, view, vw, vh) {
    const { cam, time } = view;
    const low = !!view.low;
    drawFloor(ctx, cam, vw, vh, time, view.side, view.fan, low);
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

    drawTable(ctx, cam);
    drawNet(ctx, cam);
    drawEffects(ctx, cam, view.fx, time);
    // 发球预测轨迹与对抗尾影画在球台之上、角色/球之下（避免被不透明台面遮挡）
    if (view.servePath) drawServePath(ctx, cam, view.servePath);
    if (view.trail && view.trail.length > 1 && !low) drawTrail(ctx, cam, view.trail, time);
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
        drawBall(ctx, cam, view.ball.pos, view.ball.spin, time);
      }
    }
    // 球在发球者手中时绘制在角色之后（手部之前会由角色绘制）
    if (view.ballInHand) {
      drawBall(ctx, cam, view.ballInHand, v3(0, 0, 0), time);
    }
  }

  return { v3, vadd, vsub, vscale, vlen, vnorm, vdot, vcross, clamp, lerp, Camera, limb, box, poly, line, drawScene, drawBall, drawTable, drawNet, drawFloor, drawFloorBg, drawCrowd, drawCrowdAnimated, crowdLayout, seatedPose, benchLayout, drawBenches, drawPlayerShadows, drawEffects, drawTrail, drawServePath, drawHitRangeRing, drawHitRangeSphere, drawHitBox, shade, clearCrowdCache };
});
