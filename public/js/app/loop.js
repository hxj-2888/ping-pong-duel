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

  // ---------- 联机输入泵（RAF 无关，独立 setInterval 驱动） ----------
  // 关键修复：输入发送原先绑在 requestAnimationFrame（loop）里。页面被遮挡/切后台/系统
  // 降帧时 RAF 冻结 → 输入停发 → 公网 DO（消息驱动推进引擎）收不到消息就几乎不推进物理
  // （只剩 Alarm 兜底）→ 角色卡住不动/蹲下等状态不更新；回前台积攒快照一次性涌入 →
  // 插值时钟猛追 → 瞬移/超长回溯。本地 server.js 用 setInterval 独立推进故不明显。
  // 修复：输入发送改为 setInterval 独立驱动（RAF 停了也照常发），保持公网引擎"心跳"不断。
  // 50ms 节流 + 按键变化立即补发；setInterval 后台仅被节流到 ~1Hz（不冻结），足以续推引擎。
  function sendOnlineInput() {
    if (PPD.app.mode !== 'online' || !PPD.app.net || !PPD.app.net.connected) return;
    if (PPD.app.paused || PPD.app.introActive) return; // 暂停/开场不发送（恢复后快照自动锚定）
    const k = PPD.app.keys;
    const myKeys = (k.l ? 1 : 0) | (k.r ? 2 : 0) | (k.pu ? 4 : 0) | (k.sm ? 8 : 0) | (k.f ? 16 : 0) | (k.b ? 32 : 0) | (k.crouch ? 64 : 0) | (k.run ? 128 : 0);
    const now = Date.now();
    const changed = myKeys !== PPD.app._lastKeysSent;
    if (changed || now - (PPD.app.lastInputSent || 0) >= 50) {
      PPD.app._lastKeysSent = myKeys;
      PPD.app.lastInputSent = now;
      // v2.7.0-fix:输入帧序号（会话内单调递增；服务器按 per-connection 水印丢弃乱序/重放，
      // 兼容不发送 seq 的旧客户端）
      const seq = (PPD.app._inSeq = (PPD.app._inSeq || 0) + 1);
      // 联机发球瞄准：随输入帧上报目标落点（服务端求解发球方案后随快照返回）；
      // 瞄准未变化时不带（undefined 省略字段），进一步减包
      const aim = PPD.app.serveAim;
      if (aim) {
        PPD.app.net.send({ t: 'in', k: myKeys, seq, a: [Math.round(aim.x * 100) / 100, Math.round(aim.z * 100) / 100] });
      } else {
        PPD.app.net.send({ t: 'in', k: myKeys, seq });
      }
    }
  }

  function loop(now) {
    requestAnimationFrame(loop);
    // 渲染循环整体容错（P0-1）：任何单帧异常（HUD/渲染/插值对异常快照抛错）都不再
    // 永久停画——联机音效在 WS 回调独立播放，若渲染被异常掐断会出现"听得到音效、
    // 看到界面、画面迟迟不出"。这里捕获后仅警告一次，下一帧继续渲染。
    try {
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0.016);
    lastTime = now;
    // 对局开场渲染期间（introActive）：冻结物理（不步进），画面照常渲染打底（见下方各分支与 skipRender）
    const intro = !!PPD.app.introActive;
    // 渲染帧率门控：按所选上限（30/60/无上限，默认无上限自动匹配设备刷新率）控制渲染频率；物理仍 120Hz 步进（时钟不前进时放行，兼容测试；无上限=每帧 RAF 都渲染）
    const frameRate = PPD.app.quality && PPD.app.quality.frameRate ? PPD.app.quality.frameRate : 'unlimited';
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
      // 右上角估测帧数（v2.4：一律显示真实渲染帧率，去掉 30/60 档"封顶 60"的误导；
      // 选 30 档显示真实 ~30，选 60 档在 60Hz 门控下显示真实 ~60；约 5 次/秒刷新，避免 DOM 抖动）
      if (now - lastFpsUpdate > 200) {
        lastFpsUpdate = now;
        const fps = Math.round(1000 / avg);
        if (PPD.ui.fpsMeter) {
          PPD.ui.fpsMeter.textContent = String(fps);
          if (fps < 45) PPD.ui.fpsMeter.classList.add('low');
          else PPD.ui.fpsMeter.classList.remove('low');
        }
        // v2.7.2:右上角网络延迟显示（联机模式；RTT EMA 已在 pong 处理器计算）
        if (PPD.ui.pingMeter) {
          // fix:PPD.app.ws 不存在（WebSocket 封装是 PPD.app.net），原条件恒 false 导致延迟永不显示
          const online = PPD.app.mode === 'online' && PPD.app.net && PPD.app.net.connected;
          if (online) {
            const rtt = Math.round(PPD.app.rtt || 0);
            PPD.ui.pingMeter.textContent = rtt + ' ms';
            PPD.ui.pingMeter.classList.remove('warn', 'bad');
            if (rtt >= 200) PPD.ui.pingMeter.classList.add('bad');
            else if (rtt >= 100) PPD.ui.pingMeter.classList.add('warn');
            PPD.ui.pingMeter.style.display = '';
          } else {
            PPD.ui.pingMeter.style.display = 'none';
          }
        }
      }
    }
    // 观众欢呼/摇头强度逐帧衰减（约 1.7s 内平息，与 1.5s 掌声时长接近）
    for (let i = 0; i < 2; i++) {
      PPD.app.fan.cheer[i] = Math.max(0, PPD.app.fan.cheer[i] - dt * 0.6);
      PPD.app.fan.shake[i] = Math.max(0, PPD.app.fan.shake[i] - dt * 0.6);
    }
    // 回放播放：优先于比赛模式处理（不推进引擎，只推进回放时钟并渲染在 game canvas）
    if (PPD.Replay && PPD.Replay.isActive()) {
      PPD.Replay.frame(dt);
      PPD.app.resizeDirty = false;
      lastRender = now;
      PPD.Replay.render();
      return;
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
      if (!PPD.app.paused && !intro) {
        acc += dt;
        const step = 1 / 120;
        let n = 0;
        while (acc >= step && n < 8) {
          for (const [i, k] of [[0, PPD.app.keyP1], [1, PPD.app.keyP2]]) {
            // 蹲下+推球 = 高吊（推球进阶技巧）：由输入层自动补 lb，无需新按键
            PPD.TT.setInput(PPD.app.engine, i, { ...k, lb: (k.crouch && k.pu) ? 1 : 0 });
          }
          PPD.TT.step(PPD.app.engine, step);
          if (PPD.Replay) PPD.Replay.tick(PPD.app.engine); // 回放录制：每 2 物理步采一帧
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
      if (!PPD.app.paused && !intro) {
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
          // 人机专属微调：地狱 ×1.0 完全不再刻意漏球（与观战一致，高手仍可战胜）；暂停面板滑杆可覆盖
          // AI 控制降频到 60Hz（每 2 物理步一次、dt 加倍保持累计时间一致）——省 predictCrossing 高频求解
          if (aiTick++ % 2 === 0) {
            const aiSpec = PPD.app.aiGameType === 'endless'
              ? PPD.AIC.endlessConfig(PPD.app.endlessLevel)
              : PPD.app.aiLevel;
            const aiTune = PPD.app.aiGameType === 'endless'
              ? { hellCatchMul: 1 }
              : { hellCatchMul: 1, ...(PPD.app.aiTuneB || {}) };
            PPD.AIC.control(PPD.app.engine, 1, step * 2, aiSpec, aiTune);
          }
          PPD.TT.step(PPD.app.engine, step);
          if (PPD.Replay) PPD.Replay.tick(PPD.app.engine); // 回放录制：每 2 物理步采一帧
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
      if (!PPD.app.paused && !intro) {
        acc += dt;
        const step = 1 / 120;
        let n = 0;
        while (acc >= step && n < 8) {
          // AI 观战：双方 AI 控制降频到 60Hz（每 2 物理步一次、dt 加倍保持累计时间一致）
          if (aiTick++ % 2 === 0) {
            const tuneA = PPD.AIC.isInfiniteLevel(PPD.app.aiLevelA) ? {} : PPD.app.aiTuneA;
            const tuneB = PPD.AIC.isInfiniteLevel(PPD.app.aiLevelB) ? {} : PPD.app.aiTuneB;
            PPD.AIC.control(PPD.app.engine, 0, step * 2, PPD.app.aiLevelA, tuneA);
            PPD.AIC.control(PPD.app.engine, 1, step * 2, PPD.app.aiLevelB, tuneB);
          }
          PPD.TT.step(PPD.app.engine, step);
          if (PPD.Replay) PPD.Replay.tick(PPD.app.engine); // 回放录制：每 2 物理步采一帧
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
      // 设置暂停（需求 10）：暂停期间冻结输入发送（服务端继续推进，恢复时快照自动锚定）
      if (!PPD.app.paused && !intro) {
        sendOnlineInput();
      } // 设置暂停：输入发送块结束（恢复后由快照自动锚定）
      if (renderNow || PPD.app.resizeDirty) {
        PPD.app.resizeDirty = false;
        lastRender = now;
        PPD.renderOnline();
      }
    }
    } catch (e) {
      if (!PPD.app._loopErrWarned) {
        PPD.app._loopErrWarned = true;
        if (typeof console !== 'undefined' && console.error) console.error('渲染循环异常（已容错，仅提示一次）:', e);
      }
    }
  }


  function startLoop() {
    requestAnimationFrame((t) => { lastTime = t; requestAnimationFrame(loop); });
    // 联机输入泵：独立 setInterval（RAF 无关）。页面被遮挡/后台/降帧时 RAF 冻结，
    // 但 setInterval 仍被唤醒（后台节流到 ~1Hz），持续向服务器发输入保持引擎推进。
    // 前台时 RAF loop 也调用 sendOnlineInput，二者经 50ms 节流去重，不会重复发送。
    if (!PPD.app._onlineInputTimer) {
      PPD.app._onlineInputTimer = setInterval(sendOnlineInput, 50);
    }
  }
  PPD.loop = loop;
  PPD.startLoop = startLoop;
  PPD.sendOnlineInput = sendOnlineInput; // visibilitychange 回前台补发复用
})();
