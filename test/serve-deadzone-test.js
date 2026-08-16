/* ============================================================
 * test/serve-deadzone-test.js — 发球死区钳制验证（v2.7.0-fix）
 * 1) 钳制边界内（|z|≥SERVE_Z_SAFE）任意站位/常见落点均可解出合法发球
 * 2) 发球方位于死区（z 逼近球网）时，引擎步进会把身体钳回 |z|≥SERVE_Z_SAFE
 * 3) 钳制后持球点 bh 永不越过网面（对方视角球不飘）
 * 用法：node test/serve-deadzone-test.js
 * ============================================================ */
'use strict';
const TT = require('../public/js/engine.js');
const R = TT.RULES;

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!cond) failures++;
};

function engineAt(px, pz) {
  const e = TT.createEngine();
  e.players[0].x = px;
  e.players[0].z = pz;
  e.players[0].padX = px + 0.18;
  e.phase = 'serve';
  e.ball.inHand = true;
  e.server = 0;
  return e;
}

async function main() {
  console.log('=== 发球死区钳制验证 ===\n');
  // 1) 钳制边界内全站位可解（多落点）
  const aims = [[0.0, 0.55], [0.3, 0.5], [-0.3, 0.5], [0.6, 0.35], [0.0, 0.9]];
  let allOk = true, bad = [];
  for (const px of [0.0, -1.0, -1.5, -1.8, -2.0]) {
    for (const pz of [-1.65, -1.50, -1.40, -1.30, -1.25]) {
      let any = false;
      for (const [tx, tz] of aims) {
        if (TT.setServeAim(engineAt(px, pz), 0, tx, tz)) { any = true; break; }
      }
      if (!any) { allOk = false; bad.push(`x=${px},z=${pz}`); }
    }
  }
  check('钳制边界内（|z|≥' + R.SERVE_Z_SAFE + '）任意站位至少有一个合法落点', allOk, allOk ? '' : bad.join('; '));

  // 2) 死区站位（z=-0.6 边线）步进 → 身体被钳回
  const e = engineAt(-1.5, -0.6);
  // 施加前移输入，步进若干拍（钳制应把身体拉回）
  TT.setInput(e, 0, { l: 0, r: 0, f: 1, b: 0, pu: 0, sm: 0, lb: 0, crouch: 0, run: 0 });
  for (let i = 0; i < 120; i++) TT.step(e, 1 / 60); // 2s
  const zAfter = e.players[0].z;
  check('死区站位（z=-0.6）步进后被钳回 |z|≥' + R.SERVE_Z_SAFE, Math.abs(zAfter) >= R.SERVE_Z_SAFE - 0.01, 'z=' + zAfter.toFixed(3));

  // 3) 钳制后持球点 bh 不越网
  const snap = TT.snapshot(e);
  const bh = snap.bh;
  check('钳制后持球点 bh 不越网（bh.z 在己方半台）', bh ? (e.players[0].side === 0 ? bh[2] < 0 : bh[2] > 0) : false,
    bh ? 'bh.z=' + bh[2].toFixed(3) : '无持球快照');

  // 4) 边界外可正常解出并离手（发球不卡）
  const e2 = engineAt(0, -1.65);
  const planOk = TT.setServeAim(e2, 0, 0.0, 0.55);
  check('默认站位瞄准可解（sp 方案生成）', !!planOk, planOk ? '' : 'setServeAim 失败');

  console.log(failures === 0 ? '\n发球死区钳制验证全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('异常:', e); process.exit(1); });
