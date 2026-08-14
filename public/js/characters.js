/* ============================================================
 * characters.js — 火柴人物理骨架人物模型
 * 骨骼层次直接可见：髋→脊柱→肩→颈→头；肩→腕→拍（直臂）
 * 髋→膝→足（站立时接近直腿，蹲下时膝盖前屈、身体压低）
 * 全部关节带弹簧-阻尼平滑（惯性），击球时手臂获得动量回摆
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TTG = Object.assign(root.TTG || {}, api);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 依赖 render.js 暴露的向量工具与绘制原语
  const T = (typeof TTG !== 'undefined') ? TTG : require('./render.js');
  const R = (typeof TT !== 'undefined') ? TT.RULES : require('./engine.js').RULES;
  const { v3, vadd, vsub, vscale, vlen, vnorm, vdot, vcross, clamp, lerp, limb, box } = T;

  // 骨架参数（身高 1.75m 比例）
  const B = {
    hipY: 0.92,
    legLen1: 0.46, legLen2: 0.44, footH: 0.08,
    torsoLen: 0.46,
    shoulderHalf: 0.19,
    neckLen: 0.14,
    headR: 0.105,
    armLen1: 0.30, armLen2: 0.28, handLen: 0.10,
  };

  // 火柴人配色：黑色骨感线条 + 队色上衣（P1 红 / P2 蓝），P1 红拍 / P2 蓝拍
  const STICK = [
    { body: '#000000', joint: '#000000', head: '#000000', shirt: '#d0321e', paddleFace: '#d0321e', paddleBack: '#24272e' },
    { body: '#000000', joint: '#000000', head: '#000000', shirt: '#2563eb', paddleFace: '#2563eb', paddleBack: '#24272e' },
  ];

  // 关节圆点（按投影缩放）
  function joint(ctx, cam, p, r, fill, stroke) {
    const q = cam.project(p);
    if (!q) return;
    const rad = Math.max(1.4, r * q.s);
    ctx.beginPath();
    ctx.arc(q.x, q.y, rad, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(0.8, rad * 0.2);
      ctx.stroke();
    }
  }

  // 每个视口的动画状态（惯性平滑）
  const animState = new Map();

  function getAnim(side) {
    if (!animState.has(side)) {
      animState.set(side, {
        stride: 0,
        stepAmp: 0,
        armSmooth: v3(0, 0, 0),
        armLSmooth: v3(0, 0, 0),
        armKick: v3(0, 0, 0),
        headSmooth: v3(0, 0, 0),
        torsoPitch: 0.15,
        torsoRoll: 0,
      });
    }
    return animState.get(side);
  }

  // 平滑/衰减系数常量（提出 1-exp(-k·dt)，避免每帧每角色重复 Math.exp）
  const SMOOTH_STEP = 1 - Math.exp(-6 / 60);
  const SMOOTH_TORSO = 1 - Math.exp(-10 / 60);
  const SMOOTH_ARM = 1 - Math.exp(-16 / 60);
  const SMOOTH_ARM_L = 1 - Math.exp(-14 / 60);
  const DECAY_KICK = Math.exp(-8 / 60);

  function drawCharacter(ctx, cam, pl, ball, time, viewSide, hideOwn, hideLegs) {
    // 动画状态属于角色而非视角：联机时对手和自己是两套独立状态
    const anim = getAnim(pl.side);
    const dt = 1 / 60;
    const f = pl.facing;
    const x = pl.x, z = pl.z;
    const vx = pl.vx || 0;
    const vz = pl.vz || 0;
    const crouch = pl.crouch ? 1 : 0; // 蹲下（Ctrl）：压低身体、膝盖前屈
    // 隐藏己方火柴人（避免遮挡视线），球拍仍保留显示
    const selfHidden = !!hideOwn && pl.side === viewSide;
    // 腿部始终绘制（火柴人完整可见），仅当己方身体整体隐藏时不画
    const legsHidden = selfHidden;

    // 步态相位随移动速度推进（横向 + 前后），移动中双腿始终有步法动作
    const speed = Math.hypot(vx, vz);
    // 动画死区：<0.05m/s 视为静止，冻结步态/步幅/起伏——杀掉停止后残留微动造成的"原地抽动"
    const speedAnim = speed < 0.05 ? 0 : speed;
    anim.stride += speedAnim * dt * 3.0;
    // 移动幅度平滑：停止时双脚收回中立站姿，不会定格在跨步中途；蹲下时步幅收小
    anim.stepAmp = lerp(anim.stepAmp, Math.min(1, speedAnim * 0.9) * (1 - 0.45 * crouch), SMOOTH_STEP);
    const stride = anim.stride;
    const bob = speedAnim * 0.025 * Math.sin(stride * 2) * (1 - 0.6 * crouch);

    // 躯干
    const stroke = pl.stroke || { active: false, type: 0, t: 0, dur: 0.4 };
    const strokeProg = stroke.active ? clamp(stroke.t / stroke.dur, 0, 1) : -1;
    // 视觉动作与引擎挥拍一致使用 easeOutQuad（前段加速更有力度感）
    const swingProg = strokeProg >= 0 ? 1 - (1 - strokeProg) * (1 - strokeProg) : -1;
    let pitchTarget = 0.14 + speedAnim * 0.015 + crouch * 0.30; // 蹲下时身体前倾（速度死区防残留俯仰）
    let rollTarget = (pl.lean || 0) * 0.75;
    if (swingProg >= 0) {
      const swing = Math.sin(swingProg * Math.PI);
      const drive = stroke.type === 2 || stroke.type === 3; // 扣球/低平快球：幅度更大的平击摆臂
      pitchTarget += drive ? 0.30 * swing : 0.16 * swing;
      rollTarget += drive ? -0.12 * swing : -0.06 * swing;
    }
    anim.torsoPitch = lerp(anim.torsoPitch, pitchTarget, SMOOTH_TORSO);
    anim.torsoRoll = lerp(anim.torsoRoll, rollTarget, SMOOTH_TORSO);

    // 髋关节（蹲下时髋部降低，形成蹲姿）
    const hips = v3(x, (B.hipY - 0.30 * crouch) + bob * 0.35, z + f * 0.06);
    // 躯干方向基（前倾 + 侧倾）
    const fwdBase = v3(0, 0, f);
    const sideDir = v3(f > 0 ? 1 : -1, 0, 0);
    const torsoUp = vnorm(v3(
      -Math.sin(anim.torsoRoll) * 0.35,
      Math.cos(anim.torsoPitch) * Math.cos(anim.torsoRoll),
      f * Math.sin(anim.torsoPitch)
    ));
    const torsoFwd = vnorm(v3(0, Math.sin(anim.torsoPitch) * 0.5, f * Math.cos(anim.torsoPitch)));
    const torsoSide = vnorm(vcross(torsoUp, torsoFwd));
    const torsoBasis = { f: torsoFwd, u: torsoUp, s: torsoSide };

    // 肩
    const shoulderMid = vadd(hips, vscale(torsoUp, B.torsoLen * 0.82));
    const shoulderL = vadd(shoulderMid, vscale(torsoSide, B.shoulderHalf));
    const shoulderR = vadd(shoulderMid, vscale(torsoSide, -B.shoulderHalf));
    // 颈/头
    const neck = vadd(shoulderMid, vscale(torsoUp, B.neckLen));

    // 头部注视球
    let lookTarget = v3(x + f * 1.2, 1.35, z + f * 1.2);
    if (ball && ball.vis) lookTarget = ball.pos;
    const headDir = vnorm(vsub(lookTarget, neck));
    const headYaw = Math.atan2(vdot(headDir, torsoSide), vdot(headDir, torsoFwd));
    const headPitch = Math.asin(clamp(vdot(headDir, torsoUp), -1, 1)) * 0.6;
    const headBasis = {
      f: vnorm(vadd(vscale(torsoFwd, Math.cos(headYaw)), vscale(torsoSide, Math.sin(headYaw)))),
      u: torsoUp,
      s: torsoSide,
    };
    const headCenter = vadd(neck, vscale(vnorm(vadd(vscale(torsoFwd, Math.sin(headYaw) * 0.04), vscale(torsoUp, 0.105))), 0.12));

    // 手臂：长度固定（大臂 + 小臂），只改变朝向，动作不再伸缩
    const ARM_LEN = B.armLen1 + B.armLen2;
    const paddleP = pl.paddle ? pl.paddle.p : null;
    let wristR = paddleP ? { ...paddleP } : vadd(shoulderR, v3(0, -0.25, f * 0.35));
    // 持拍手对球的轻微追踪：待机时球朝自己运动，手沿球的运动方向略微伸出（仅视觉，不影响判定）
    if (!stroke.active && ball && ball.vis && ball.vel && vlen(ball.vel) > 0.2) {
      const bv = ball.vel;
      if (vdot(bv, v3(0, 0, f)) < 0) {
        const d = vlen(vsub(ball.pos, wristR));
        if (d < 2.0) {
          const k = clamp(1 - d / 2.0, 0, 1);
          const dir2d = vnorm(v3(bv.x, 0, bv.z));
          wristR = vadd(wristR, vscale(dir2d, 0.10 * k));
        }
      }
    }
    // 击球动量回摆（只影响手腕朝向，不改变臂长）
    // 注意：回摆必须是有界的小幅衰减，原实现逐帧累加会把手臂甩到身体后方
    const kick = pl.sb ? vscale(vnorm(pl.paddle ? pl.paddle.n : v3(0, 0, f)), -pl.sb * 0.12) : v3(0, 0, 0);
    anim.armSmooth = vadd(anim.armSmooth, vscale(vsub(wristR, anim.armSmooth), SMOOTH_ARM));
    anim.armKick = vscale(anim.armKick, DECAY_KICK);
    if (pl.sb > 0.05) anim.armKick = vadd(anim.armKick, vscale(kick, 0.05));
    let dirR = vsub(vadd(vadd(anim.armSmooth, anim.armKick), kick), shoulderR);
    if (vlen(dirR) < 1e-4) dirR = v3(0, -0.35, f * 0.5);
    // 手臂始终保持在身体前方：接球靠身体移动到位，手不得绕到后背
    if (vdot(dirR, v3(0, 0, f)) < 0.12) dirR = v3(dirR.x, dirR.y, f * 0.12);
    wristR = vadd(shoulderR, vscale(vnorm(dirR), ARM_LEN));
    if ((wristR.z - shoulderR.z) * f < 0.06) wristR.z = shoulderR.z + f * 0.06;

    // 左手平衡臂（同样固定臂长，并平滑过渡，避免起收拍时突然跳动）
    let wristL;
    if (swingProg >= 0) {
      const opp = stroke.type === 2 || stroke.type === 3 ? 0.9 : 0.55;
      wristL = vadd(shoulderL, v3(-f * 0.5 * Math.sin(swingProg * Math.PI) * opp, -0.05, f * 0.15));
    } else {
      wristL = vadd(shoulderL, v3(0, -0.32, f * 0.34));
    }
    anim.armLSmooth = vadd(anim.armLSmooth, vscale(vsub(wristL, anim.armLSmooth), SMOOTH_ARM_L));
    let dirL = vsub(anim.armLSmooth, shoulderL);
    if (vlen(dirL) < 1e-4) dirL = v3(0, -0.4, f * 0.3);
    wristL = vadd(shoulderL, vscale(vnorm(dirL), ARM_LEN));

    // 腿（乒乓球步法：左右移动时双脚横向开合，前后移动时双脚交替进退，
    //      脚始终贴近身体下方、不踏上球台）
    const stepX = Math.sin(stride);
    const stepZ = Math.sin(stride + Math.PI / 2); // 与横向错相，避免同相僵硬
    const liftA = Math.max(0, Math.sin(stride + Math.PI / 2)) * 0.05 * anim.stepAmp;
    const liftB = Math.max(0, Math.sin(stride + Math.PI * 1.5)) * 0.05 * anim.stepAmp;
    const wX = speed > 1e-6 ? Math.abs(vx) / speed : 0; // 横向移动权重
    const wZ = speed > 1e-6 ? Math.abs(vz) / speed : 0; // 前后移动权重
    const ampX = (0.06 + 0.08 * wX) * anim.stepAmp;
    const ampZ = (0.03 + 0.03 * wZ) * anim.stepAmp;
    const footL = v3(x - 0.16 + stepX * ampX, B.footH + liftA, z + f * (0.04 + stepZ * ampZ));
    const footR = v3(x + 0.16 - stepX * ampX, B.footH + liftB, z + f * (0.04 - stepZ * ampZ));
    // 髋与脚统一按世界坐标左右对应（左髋→左脚、右髋→右脚），
    // 避免按身体朝向取髋位时与脚错位，造成两腿“X”型交叉
    const hipL = vadd(hips, v3(-0.11, 0, 0));
    const hipR = vadd(hips, v3(0.11, 0, 0));
    // 膝盖：蹲下时膝盖前屈（双腿分段绘制，形成真实蹲姿）
    const kneeL = v3((hipL.x + footL.x) / 2 + f * 0.15 * crouch, (hipL.y + footL.y) / 2 + 0.04, (hipL.z + footL.z) / 2);
    const kneeR = v3((hipR.x + footR.x) / 2 + f * 0.15 * crouch, (hipR.y + footR.y) / 2 + 0.04, (hipR.z + footR.z) / 2);

    // ---------- 收集部件按深度排序绘制（火柴人：骨线 + 关节圆点） ----------
    const parts = [];
    const add = (d, fn) => parts.push({ d, fn });
    const dAt = (p) => cam.depth(p);
    const col = STICK[pl.side];
    // 队服（app/teams.js 按本局双方队伍注入）：球衣与拍面主色恒=旗帜队色，装扮不可覆盖（特效分离 v2.1）
    const teamCol = pl.teamColor || col.shirt;
    const shirtCol = teamCol;
    const lineR = 0.042; // 骨线粗（加粗圆头）

    // 腿（髋→膝→脚；站立时接近直腿，蹲下时膝盖前屈）
    if (!legsHidden) add(dAt(v3((footL.x + hipL.x) / 2, 0.4, (footL.z + hipL.z) / 2)), () => {
      limb(ctx, cam, hipL, kneeL, lineR, col.body, 'rgba(15,20,28,0.55)');
      limb(ctx, cam, kneeL, footL, lineR, col.body, 'rgba(15,20,28,0.55)');
      limb(ctx, cam, footL, vadd(footL, v3(0, 0, f * 0.09)), lineR * 0.85, col.joint, 'rgba(15,20,28,0.4)');
    });
    if (!legsHidden) add(dAt(v3((footR.x + hipR.x) / 2, 0.4, (footR.z + hipR.z) / 2)), () => {
      limb(ctx, cam, hipR, kneeR, lineR, col.body, 'rgba(15,20,28,0.55)');
      limb(ctx, cam, kneeR, footR, lineR, col.body, 'rgba(15,20,28,0.55)');
      limb(ctx, cam, footR, vadd(footR, v3(0, 0, f * 0.09)), lineR * 0.85, col.joint, 'rgba(15,20,28,0.4)');
    });

    // 上衣（髋→肩）：队色加粗圆头线条，不覆盖手臂（手臂仍为黑色骨线）
    if (!selfHidden) add(dAt(shoulderMid), () => {
      limb(ctx, cam, hips, shoulderMid, lineR * 1.6, shirtCol, 'rgba(15,20,28,0.55)');
      limb(ctx, cam, shoulderMid, vadd(shoulderMid, vscale(torsoUp, B.neckLen * 0.75)), lineR * 0.9, col.body, 'rgba(15,20,28,0.5)');
    });

    // 肩线（队色上衣的肩部）+ 肩关节（手臂的起点，确保手明确接在肩上）
    if (!selfHidden) add(dAt(shoulderMid), () => {
      limb(ctx, cam, shoulderL, shoulderR, lineR * 1.25, shirtCol, 'rgba(15,20,28,0.5)');
      joint(ctx, cam, shoulderL, 0.048, col.joint, null);
      joint(ctx, cam, shoulderR, 0.048, col.joint, null);
    });

    // 左臂
    if (!selfHidden) add(dAt(wristL), () => {
      limb(ctx, cam, shoulderL, wristL, lineR * 0.92, col.body, 'rgba(15,20,28,0.5)');
      joint(ctx, cam, wristL, 0.032, col.joint, null);
    });

    // 头
    if (!selfHidden) add(dAt(headCenter), () => {
      joint(ctx, cam, headCenter, B.headR, col.head, 'rgba(15,20,28,0.65)');
      // 视线小点（头朝向球）
      const eye = vadd(headCenter, vscale(headBasis.f, B.headR * 0.52));
      joint(ctx, cam, eye, 0.016, '#1c2430', null);
    });

    // 右臂（持拍）
    add(dAt(wristR), () => {
      if (!selfHidden) {
        limb(ctx, cam, shoulderR, wristR, lineR * 0.92, col.body, 'rgba(15,20,28,0.5)');
        joint(ctx, cam, wristR, 0.032, col.joint, null);
      }
    });

    parts.sort((a, b) => b.d - a.d);
    for (const p of parts) p.fn();

    // v2.0:AI 扣杀/低平预警 → 头部右上方黄色「?」(0.2s:前 0.1s 全显 + 后 0.1s 渐变淡出)
    if (pl.warnSmash) {
      const q = cam.project(headCenter);
      if (q) {
        // 渐变消失:最后 0.1s(warnT≤0.1)透明度 1→0
        const fade = Math.max(0, Math.min(1, (pl.warnT || 0) / 0.1));
        const fs = Math.max(16, 0.30 * q.s);
        ctx.fillStyle = `rgba(250,204,21,${(0.95 * fade).toFixed(3)})`;
        ctx.font = `bold ${fs}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('?', q.x + 0.30 * q.s, q.y - 0.30 * q.s);
      }
    }
    // v2.0:反击成功 → 头上感叹号(随头移动,0.8s 淡出;只读标记不影响 AI 操作)
    if (pl.exclaimT > 0) {
      const q = cam.project(headCenter);
      if (q) {
        const k = Math.max(0, Math.min(1, pl.exclaimT / 0.8));
        const fs = Math.max(16, 0.30 * q.s);
        ctx.fillStyle = `rgba(250,204,21,${(0.95 * k).toFixed(3)})`;
        ctx.font = `bold ${fs}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('!', q.x, q.y - 0.38 * q.s);
      }
    }

    // 球拍：billboard 绘制（始终面向镜头，亮色拍面 + 手柄，确保清晰可见）
    if (pl.paddle && wristR) {
      const q = cam.project(wristR);
      if (q) {
        const size = R.BLADE_WID * q.s * 1.15;
        ctx.save();
        ctx.translate(q.x, q.y);
        ctx.fillStyle = pl.teamColor || col.paddleFace; // 拍面主色恒=队服（旗帜队色，装扮不覆盖 v2.1）
        ctx.strokeStyle = 'rgba(15,20,30,0.65)';
        ctx.lineWidth = Math.max(1, size * 0.045);
        ctx.beginPath();
        ctx.ellipse(0, 0, size / 2, size * 0.42, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#9a6b3f';
        ctx.fillRect(-size * 0.075, size * 0.30, size * 0.15, size * 0.34);
        ctx.restore();
      }
    }
  }

  return { drawCharacter };
});
