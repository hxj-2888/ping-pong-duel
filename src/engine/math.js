/* ============================================================
 * engine/math.js — 向量与数学工具（拆分自 engine.js）
 * 本模块通过共享上下文 ctx 使用其他模块的接口，不直接改动其他文件。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.TTMath = factory;
})(typeof self !== 'undefined' ? self : this, function (ctx) {
  'use strict';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));
  // easeOutQuad：挥拍前段加速、后段减速（出球瞬间速度最快，收拍自然回位）
  const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
  const easeOutQuadDeriv = (t) => 2 * (1 - t);
  function vec(x, y, z) { return { x, y, z }; }
  function vadd(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
  function vsub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function vscale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
  function vlen(a) { return Math.hypot(a.x, a.y, a.z); }
  function vnorm(a) { const l = vlen(a); return l > 1e-9 ? vscale(a, 1 / l) : vec(0, 0, 0); }
  function vlerp(a, b, t) { return vadd(vscale(a, 1 - t), vscale(b, t)); }
  function vdot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function vcross(a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  }

  function segPointDist(a, b, p) {
    const ab = vsub(b, a), ap = vsub(p, a);
    const l2 = vdot(ab, ab);
    if (l2 < 1e-12) return vlen(ap);
    const t = clamp(vdot(ap, ab) / l2, 0, 1);
    return vlen(vsub(ap, vscale(ab, t)));
  }

  function segSegDist(a, b, c, d) {
    const u = vsub(b, a), v = vsub(d, c), w0 = vsub(a, c);
    const A = vdot(u, u), B = vdot(u, v), C = vdot(v, v);
    const D = vdot(u, w0), E = vdot(v, w0);
    const det = A * C - B * B;
    let sc, tc;
    if (det > 1e-9) {
      sc = clamp((B * E - C * D) / det, 0, 1);
      tc = clamp((A * E - B * D) / det, 0, 1);
    } else {
      sc = 0;
      tc = clamp(D / (A || 1e-9), 0, 1);
    }
    // 一次迭代修正
    if (det > 1e-9) {
      const w = vadd(w0, vsub(vscale(u, sc), vscale(v, tc)));
      const d1 = vdot(w, u);
      if (d1 < 0) { sc = 0; tc = clamp(E / (C || 1e-9), 0, 1); }
      else if (d1 > A) { sc = 1; tc = clamp((B + E) / (C || 1e-9), 0, 1); }
      else {
        const d2 = vdot(w, v);
        if (d2 < 0) { tc = 0; sc = clamp(-D / (A || 1e-9), 0, 1); }
        else if (d2 > C) { tc = 1; sc = clamp((B - D) / (A || 1e-9), 0, 1); }
      }
    }
    const w = vadd(w0, vsub(vscale(u, sc), vscale(v, tc)));
    return vlen(w);
  }

  return { clamp, lerp, damp, easeOutQuad, easeOutQuadDeriv, vec, vadd, vsub, vscale, vlen, vnorm, vlerp, vdot, vcross, segPointDist, segSegDist };
});