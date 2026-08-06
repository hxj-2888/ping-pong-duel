/* ============================================================
 * app/loop.js — 主循环：按模式推进引擎并渲染（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 主循环 ----------
  let lastTime = 0;
  let acc = 0;

  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0.016);
    lastTime = now;
    // 观众欢呼/摇头强度逐帧衰减（约 1.7s 内平息，与 1.5s 掌声时长接近）
    for (let i = 0; i < 2; i++) {
      PPD.app.fan.cheer[i] = Math.max(0, PPD.app.fan.cheer[i] - dt * 0.6);
      PPD.app.fan.shake[i] = Math.max(0, PPD.app.fan.shake[i] - dt * 0.6);
    }
    PPD.updateHud();

    if (PPD.app.mode === 'local' && PPD.app.engine) {
      if (!PPD.app.paused) {
        acc += dt;
        const step = 1 / 120;
        let n = 0;
        while (acc >= step && n < 8) {
          for (const [i, k] of [[0, PPD.app.keyP1], [1, PPD.app.keyP2]]) {
            // 蹲下+推球 = 高吊（推球进阶技巧）：由输入层自动补 lb，无需新按键
            PPD.TT.setInput(PPD.app.engine, i, { ...k, lb: (k.crouch && k.pu) ? 1 : 0 });
          }
          PPD.TT.step(PPD.app.engine, step);
          PPD.handleEngineEvents(PPD.app.engine);
          acc -= step;
          n++;
        }
      }
      PPD.renderLocal();
    } else if (PPD.app.mode === 'ai' && PPD.app.engine) {
      if (!PPD.app.paused) {
        acc += dt;
        const step = 1 / 120;
        let n = 0;
        while (acc >= step && n < 8) {
          // 人类（P1）：WASD 与方向键均可；蹲下+推球 = 高吊（输入层补 lb，无需新按键）
          const humanPu = PPD.app.keyP1.pu || PPD.app.keyP2.pu;
          const humanCrouch = PPD.app.keyP1.crouch || PPD.app.keyP2.crouch;
          PPD.TT.setInput(PPD.app.engine, 0, {
            l: PPD.app.keyP1.l || PPD.app.keyP2.l,
            r: PPD.app.keyP1.r || PPD.app.keyP2.r,
            f: PPD.app.keyP1.f || PPD.app.keyP2.f,
            b: PPD.app.keyP1.b || PPD.app.keyP2.b,
            pu: humanPu,
            sm: PPD.app.keyP1.sm || PPD.app.keyP2.sm,
            lb: (humanCrouch && humanPu) ? 1 : 0,
            crouch: humanCrouch,
            run: PPD.app.keyP1.run || PPD.app.keyP2.run,
          });
          // 电脑对手（蓝方）：难度 + 地狱通关后的数值调控倍率（暂停面板滑杆，即时生效）。
          // 人机专属微调：地狱默认 ×0.97 接球率（AI 观战保留 1.0 强版展示，人机对战高手可战胜）
          PPD.AIC.control(PPD.app.engine, 1, step, PPD.app.aiLevel, { hellCatchMul: 0.97, ...(PPD.app.aiTuneB || {}) });
          PPD.TT.step(PPD.app.engine, step);
          PPD.handleEngineEvents(PPD.app.engine);
          acc -= step;
          n++;
        }
      }
      PPD.renderSingle();
    } else if (PPD.app.mode === 'aivai' && PPD.app.engine) {
      // AI 观战（AI vs AI）：双方均由 AI 控制，玩家只看不操作；
      // 暂停中可调整双方难度（loop 每帧读 app.aiLevelA/B，改后即时生效）
      if (!PPD.app.paused) {
        acc += dt;
        const step = 1 / 120;
        let n = 0;
        while (acc >= step && n < 8) {
          PPD.AIC.control(PPD.app.engine, 0, step, PPD.app.aiLevelA, PPD.app.aiTuneA);
          PPD.AIC.control(PPD.app.engine, 1, step, PPD.app.aiLevelB, PPD.app.aiTuneB);
          PPD.TT.step(PPD.app.engine, step);
          PPD.handleEngineEvents(PPD.app.engine);
          acc -= step;
          n++;
        }
      }
      PPD.renderSingle();
    } else if (PPD.app.mode === 'online' && PPD.app.net && PPD.app.net.connected) {
      // 输入发送（30Hz + 变化时）
      const myKeys = (PPD.app.keys.l ? 1 : 0) | (PPD.app.keys.r ? 2 : 0) | (PPD.app.keys.pu ? 4 : 0) | (PPD.app.keys.sm ? 8 : 0) | (PPD.app.keys.f ? 16 : 0) | (PPD.app.keys.b ? 32 : 0);
      if (now - PPD.app.lastInputSent > 33) {
        PPD.app.lastInputSent = now;
        // 联机发球瞄准：随输入帧上报目标落点（服务端求解发球方案后随快照返回）
        const a = PPD.app.serveAim ? [PPD.app.serveAim.x, PPD.app.serveAim.z] : undefined;
        PPD.app.net.send({ t: 'in', i: { l: PPD.app.keys.l, r: PPD.app.keys.r, f: PPD.app.keys.f, b: PPD.app.keys.b, pu: PPD.app.keys.pu, sm: PPD.app.keys.sm, c: PPD.app.keys.crouch, rn: PPD.app.keys.run }, a });
      }
      PPD.renderOnline();
    }
  }


  function startLoop() {
    requestAnimationFrame((t) => { lastTime = t; requestAnimationFrame(loop); });
  }
  PPD.loop = loop;
  PPD.startLoop = startLoop;
})();