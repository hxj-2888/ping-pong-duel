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
  // FPS 滚动均值（约 1s 窗口）：供"自动"画质的帧率降级判定
  const FRAME_HIST = 60;
  let frameHist = new Array(FRAME_HIST).fill(16.67);
  let frameIdx = 0;

  // "自动"画质降级判定（滞回防抖）：持续 <40fps(>25ms) 约 2s → 低画质；
  // 恢复 >55fps(<18.2ms) 持续约 2s → 还原
  function autoQuality(frameMs) {
    const q = PPD.app.quality;
    if (q.mode !== 'auto') return;
    if (frameMs > 25) {
      q.degradeMs += frameMs;
      q.restoreMs = 0;
      if (!q.low && q.degradeMs > 2000) {
        q.low = true;
        PPD.app.dpr = 1;
        if (PPD.TTG && PPD.TTG.clearCrowdCache) PPD.TTG.clearCrowdCache();
        PPD.resize();
      }
    } else if (frameMs < 18.2) {
      q.restoreMs += frameMs;
      q.degradeMs = 0;
      if (q.low && q.restoreMs > 2000) {
        q.low = false;
        PPD.resize();
      }
    } else {
      q.degradeMs = 0;
      q.restoreMs = 0;
    }
  }

  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0.016);
    lastTime = now;
    // 渲染 60fps 门控：物理仍 120Hz 步进，渲染最多每秒 60 次（时钟不前进时放行，兼容测试）
    const renderDt = now - lastRender;
    const shouldRender = renderDt <= 0 || renderDt >= 1000 / 60;
    // 帧间隔滚动均值（自动降级依据；renderDt<=0 的测试环境不计入）
    if (renderDt > 0) {
      frameHist[frameIdx] = renderDt;
      frameIdx = (frameIdx + 1) % FRAME_HIST;
      let sum = 0;
      for (let i = 0; i < FRAME_HIST; i++) sum += frameHist[i];
      const avg = sum / FRAME_HIST;
      PPD.app.quality.frameMs = avg;
      autoQuality(avg);
    }
    // 观众欢呼/摇头强度逐帧衰减（约 1.7s 内平息，与 1.5s 掌声时长接近）
    for (let i = 0; i < 2; i++) {
      PPD.app.fan.cheer[i] = Math.max(0, PPD.app.fan.cheer[i] - dt * 0.6);
      PPD.app.fan.shake[i] = Math.max(0, PPD.app.fan.shake[i] - dt * 0.6);
    }
    // 主菜单（mode===null）无需 HUD 更新
    if (PPD.app.mode !== null) PPD.updateHud();

    // 暂停 / 比赛结束（phase 'over'）：物理已冻结或只剩重开计时，跳过渲染省 CPU；
    // 窗口尺寸/DPR 变化时（resizeDirty）补一帧，避免画布空白
    const skipRender = PPD.app.paused || (PPD.app.engine && PPD.app.engine.phase === 'over');
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
          PPD.AIC.control(PPD.app.engine, 1, step, PPD.app.aiLevel, { hellCatchMul: 0.97, ...(PPD.app.aiTuneB || {}) });
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
          PPD.AIC.control(PPD.app.engine, 0, step, PPD.app.aiLevelA, PPD.app.aiTuneA);
          PPD.AIC.control(PPD.app.engine, 1, step, PPD.app.aiLevelB, PPD.app.aiTuneB);
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