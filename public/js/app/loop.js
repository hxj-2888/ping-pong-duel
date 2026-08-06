/* ============================================================
 * app/loop.js — 主循环：按模式推进引擎并渲染（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 主循环 ----------
  let lastTime = 0;
  let lastRender = 0;
  let acc = 0;
  let aiTick = 0; // AI 控制降频计数（每 2 物理步 = 60Hz 一次）
  // FPS 滚动均值（约 1s 窗口）：右上角估测帧数
  const FRAME_HIST = 60;
  let frameHist = new Array(FRAME_HIST).fill(16.67);
  let frameIdx = 0;
  let lastFpsUpdate = 0;

  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0.016);
    lastTime = now;
    // 渲染帧率门控：按所选上限（30/45/60/无上限，默认 60）控制渲染频率；物理仍 120Hz 步进（时钟不前进时放行，兼容测试；无上限=每帧 RAF 都渲染）
    const frameRate = PPD.app.quality && PPD.app.quality.frameRate ? PPD.app.quality.frameRate : 60;
    const renderDt = now - lastRender;
    const shouldRender = renderDt <= 0 || frameRate === 'unlimited' || renderDt >= 1000 / frameRate;
    // 帧间隔滚动均值（估测帧数依据；renderDt<=0 的测试环境不计入）
    if (renderDt > 0) {
      frameHist[frameIdx] = renderDt;
      frameIdx = (frameIdx + 1) % FRAME_HIST;
      let sum = 0;
      for (let i = 0; i < FRAME_HIST; i++) sum += frameHist[i];
      const avg = sum / FRAME_HIST;
      PPD.app.quality.frameMs = avg;
      // 右上角估测帧数（60/45/30 档封顶 60；无上限档显示真实帧率；约 5 次/秒刷新，避免 DOM 抖动）
      if (now - lastFpsUpdate > 200) {
        lastFpsUpdate = now;
        const fps = frameRate === 'unlimited' ? Math.round(1000 / avg) : Math.min(60, Math.round(1000 / avg));
        if (PPD.ui.fpsMeter) {
          PPD.ui.fpsMeter.textContent = String(fps);
          if (fps < 45) PPD.ui.fpsMeter.classList.add('low');
          else PPD.ui.fpsMeter.classList.remove('low');
        }
      }
    }
    // 观众欢呼/摇头强度逐帧衰减（约 1.7s 内平息，与 1.5s 掌声时长接近）
    for (let i = 0; i < 2; i++) {
      PPD.app.fan.cheer[i] = Math.max(0, PPD.app.fan.cheer[i] - dt * 0.6);
      PPD.app.fan.shake[i] = Math.max(0, PPD.app.fan.shake[i] - dt * 0.6);
    }
    // 主菜单（mode===null）无需 HUD 更新
    if (PPD.app.mode !== null) PPD.updateHud();

    // 暂停 / 比赛结束（phase 'over'）：物理已冻结或只剩重开计时，跳过渲染省 CPU；
    // 窗口尺寸/DPR 变化时（resizeDirty）补一帧，避免画布空白。
    // 比赛结束瞬间的决胜欢呼（fan 动画约 1.7s）仍需渲染可见，动画平息后再停
    const fanActive = PPD.app.fan && (PPD.app.fan.cheer[0] > 0 || PPD.app.fan.cheer[1] > 0 ||
      PPD.app.fan.shake[0] > 0 || PPD.app.fan.shake[1] > 0);
    const skipRender = PPD.app.paused || (PPD.app.engine && PPD.app.engine.phase === 'over' && !fanActive);
    const renderNow = shouldRender && !skipRender;

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
      if (renderNow || PPD.app.resizeDirty) {
        PPD.app.resizeDirty = false;
        lastRender = now;
        PPD.renderLocal();
      }
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
          // 人机专属微调：地狱默认 ×0.97 接球率（AI 观战保留 catch 1.0 强版展示，人机对战高手可战胜）。
          // 暂停面板滑杆（aiTuneB）可覆盖微调
          // AI 控制降频到 60Hz（每 2 物理步一次、dt 加倍保持累计时间一致）——省 predictCrossing 高频求解
          if (aiTick++ % 2 === 0) {
            PPD.AIC.control(PPD.app.engine, 1, step * 2, PPD.app.aiLevel, { hellCatchMul: 0.97, ...(PPD.app.aiTuneB || {}) });
          }
          PPD.TT.step(PPD.app.engine, step);
          PPD.handleEngineEvents(PPD.app.engine);
          acc -= step;
          n++;
        }
      }
      if (renderNow || PPD.app.resizeDirty) {
        PPD.app.resizeDirty = false;
        lastRender = now;
        PPD.renderSingle();
      }
    } else if (PPD.app.mode === 'aivai' && PPD.app.engine) {
      // AI 观战（AI vs AI）：双方均由 AI 控制，玩家只看不操作；
      // 暂停中可调整双方难度（loop 每帧读 app.aiLevelA/B，改后即时生效）
      if (!PPD.app.paused) {
        acc += dt;
        const step = 1 / 120;
        let n = 0;
        while (acc >= step && n < 8) {
          // AI 观战：双方 AI 控制降频到 60Hz（每 2 物理步一次、dt 加倍保持累计时间一致）
          if (aiTick++ % 2 === 0) {
            PPD.AIC.control(PPD.app.engine, 0, step * 2, PPD.app.aiLevelA, PPD.app.aiTuneA);
            PPD.AIC.control(PPD.app.engine, 1, step * 2, PPD.app.aiLevelB, PPD.app.aiTuneB);
          }
          PPD.TT.step(PPD.app.engine, step);
          PPD.handleEngineEvents(PPD.app.engine);
          acc -= step;
          n++;
        }
      }
      if (renderNow || PPD.app.resizeDirty) {
        PPD.app.resizeDirty = false;
        lastRender = now;
        PPD.renderSingle();
      }
    } else if (PPD.app.mode === 'online' && PPD.app.net && PPD.app.net.connected) {
      // 输入发送（30Hz + 变化时）
      const myKeys = (PPD.app.keys.l ? 1 : 0) | (PPD.app.keys.r ? 2 : 0) | (PPD.app.keys.pu ? 4 : 0) | (PPD.app.keys.sm ? 8 : 0) | (PPD.app.keys.f ? 16 : 0) | (PPD.app.keys.b ? 32 : 0);
      if (now - PPD.app.lastInputSent > 33) {
        PPD.app.lastInputSent = now;
        // 联机发球瞄准：随输入帧上报目标落点（服务端求解发球方案后随快照返回）
        const a = PPD.app.serveAim ? [PPD.app.serveAim.x, PPD.app.serveAim.z] : undefined;
        PPD.app.net.send({ t: 'in', i: { l: PPD.app.keys.l, r: PPD.app.keys.r, f: PPD.app.keys.f, b: PPD.app.keys.b, pu: PPD.app.keys.pu, sm: PPD.app.keys.sm, c: PPD.app.keys.crouch, rn: PPD.app.keys.run }, a });
      }
      if (renderNow || PPD.app.resizeDirty) {
        PPD.app.resizeDirty = false;
        lastRender = now;
        PPD.renderOnline();
      }
    }
  }


  function startLoop() {
    requestAnimationFrame((t) => { lastTime = t; requestAnimationFrame(loop); });
  }
  PPD.loop = loop;
  PPD.startLoop = startLoop;
})();