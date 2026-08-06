/* ============================================================
 * app/input.js — 键盘/触屏/点击输入与暂停工具（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 输入 ----------
  const KEYMAP = {
    KeyA: 'P1L', KeyD: 'P1R', KeyW: 'P1F', KeyS: 'P1B',
    ArrowLeft: 'P2L', ArrowRight: 'P2R', ArrowUp: 'P2U', ArrowDown: 'P2D',
    ControlLeft: 'P1C', ControlRight: 'P1C',  // Ctrl 蹲下
    ShiftLeft: 'P1S', ShiftRight: 'P1S',      // Shift 跑步
  };

  function applyKey(code, down) {
    const k = KEYMAP[code];
    if (!k) return;
    const side = k[1];
    const map = side === '1' ? PPD.app.keyP1 : PPD.app.keyP2;
    if (k.endsWith('L')) map.l = down ? 1 : 0;
    if (k.endsWith('R')) map.r = down ? 1 : 0;
    if (k.endsWith('F')) map.f = down ? 1 : 0; // W：向前移动
    if (k.endsWith('B')) map.b = down ? 1 : 0; // S：向后移动
    if (k.endsWith('U')) map.pu = down ? 1 : 0;
    if (k.endsWith('D')) map.sm = down ? 1 : 0;
    if (k.endsWith('C')) map.crouch = down ? 1 : 0;
    if (k.endsWith('S')) map.run = down ? 1 : 0;
    if (down && k.endsWith('U') && PPD.app.mode === 'online' && PPD.app.snapB && PPD.app.snapB.ph === 0) {
      PPD.GameAudio.ensure();
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); return; }
    if (e.code.startsWith('Arrow')) e.preventDefault();
    // 游戏中拦截 Ctrl/⌘ 组合键的浏览器默认行为（Ctrl+W 关闭窗口、Ctrl+Q 退出、
    // Ctrl+R 刷新等），保证 Ctrl 只用于“蹲下”，组合移动键（如 Ctrl+W 蹲着向前）正常生效
    if ((e.ctrlKey || e.metaKey) && PPD.app.mode) e.preventDefault();
    applyKey(e.code, true);
    syncKeys();
  });
  window.addEventListener('keyup', (e) => {
    applyKey(e.code, false);
    syncKeys();
  });
  window.addEventListener('blur', () => {
    PPD.app.keyP1 = { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, crouch: 0, run: 0 };
    PPD.app.keyP2 = { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, crouch: 0, run: 0 };
    PPD.app.keys = { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, crouch: 0, run: 0 };
  });

  // 联机模式：任一键组/触控按钮都控制自己的角色
  function syncKeys() {
    if (PPD.app.mode !== 'online') return;
    PPD.app.keys = {
      l: PPD.app.keyP1.l || PPD.app.keyP2.l,
      r: PPD.app.keyP1.r || PPD.app.keyP2.r,
      f: PPD.app.keyP1.f || PPD.app.keyP2.f,
      b: PPD.app.keyP1.b || PPD.app.keyP2.b,
      pu: PPD.app.keyP1.pu || PPD.app.keyP2.pu,
      sm: PPD.app.keyP1.sm || PPD.app.keyP2.sm,
      crouch: PPD.app.keyP1.crouch || PPD.app.keyP2.crouch,
      run: PPD.app.keyP1.run || PPD.app.keyP2.run,
    };
  }

  // ---------- 手机端触控按钮 ----------
  function showTouch(v) {
    PPD.show(PPD.ui.touchControls, v && PPD.isTouch);
  }

  // 全方位摇杆：拖动映射左/右/前/后（可斜向移动），松手回中
  const JOY_MAX = 48; // 摇杆最大行程（px）
  const joy = { active: false, id: -1, cx: 0, cy: 0, dx: 0, dy: 0 };
  function joyApply() {
    const k = PPD.app.keyP1;
    k.r = joy.dx > 0.25 ? 1 : 0;
    k.l = joy.dx < -0.25 ? 1 : 0;
    k.f = joy.dy < -0.25 ? 1 : 0; // 上=向前（朝网）
    k.b = joy.dy > 0.25 ? 1 : 0;
    syncKeys();
  }
  function joyMove(clientX, clientY) {
    let dx = clientX - joy.cx, dy = clientY - joy.cy;
    const len = Math.hypot(dx, dy);
    if (len > JOY_MAX) { dx = (dx / len) * JOY_MAX; dy = (dy / len) * JOY_MAX; }
    joy.dx = dx / JOY_MAX;
    joy.dy = dy / JOY_MAX;
    if (PPD.ui.joyKnob) PPD.ui.joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    joyApply();
  }
  function joyReset() {
    joy.active = false; joy.id = -1;
    joy.dx = 0; joy.dy = 0;
    PPD.app.keyP1.l = 0; PPD.app.keyP1.r = 0; PPD.app.keyP1.f = 0; PPD.app.keyP1.b = 0;
    if (PPD.ui.joyKnob) PPD.ui.joyKnob.style.transform = 'translate(0,0)';
    syncKeys();
  }

  function bindTouch() {
    const hold = (el, key) => {
      if (!el) return;
      const on = (v) => (e) => { e.preventDefault(); PPD.app.keyP1[key] = v; syncKeys(); };
      el.addEventListener('pointerdown', on(1));
      el.addEventListener('pointerup', on(0));
      el.addEventListener('pointercancel', on(0));
      el.addEventListener('pointerleave', on(0));
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    // 蹲下按钮（手机端）：按住蹲下（与电脑 Ctrl 相同效果）
    hold(PPD.ui.btnCrouch, 'crouch');
    // 扣球按钮（手机端）：单按=扣球（右键扣杀，与电脑右键同规则——低球会撞网判负）
    if (PPD.ui.btnSmash) {
      PPD.ui.btnSmash.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const side = PPD.app.mode === 'online' ? PPD.app.side : 0; // 人机/本地=自己(红方/P1)
        fireShot(side, 'sm');
      });
      PPD.ui.btnSmash.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    // 全方位摇杆
    const base = PPD.ui.joyBase;
    if (base) {
      base.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        joy.active = true; joy.id = e.pointerId;
        const r = base.getBoundingClientRect();
        joy.cx = r.left + r.width / 2; joy.cy = r.top + r.height / 2;
        joyMove(e.clientX, e.clientY);
        if (base.setPointerCapture) { try { base.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      });
      base.addEventListener('pointermove', (e) => {
        if (joy.active && e.pointerId === joy.id) joyMove(e.clientX, e.clientY);
      });
      const end = (e) => { if (joy.active && e.pointerId === joy.id) joyReset(); };
      base.addEventListener('pointerup', end);
      base.addEventListener('pointercancel', end);
      base.addEventListener('pointerleave', end);
      base.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }
  bindTouch();

  // ---------- 右上角工具：暂停 / 退出 ----------
  // 人机难度在开局菜单选定，对局中锁定（不提供局内切换）
  function updateGameTools() {
    const showPause = PPD.app.mode === 'ai' || PPD.app.mode === 'local' || PPD.app.mode === 'aivai';
    PPD.show(PPD.ui.btnPause, showPause);
    PPD.show(PPD.ui.btnExit, true);
    PPD.ui.btnPause.textContent = PPD.app.paused ? '继续' : '暂停';
  }

  // AI 观战参数滑杆：4 项 × 双侧（值 50~150 → 倍率 0.5~1.5）；
  // 人机「电脑 AI 数值调控」（tuneOpp*，地狱通关后暂停面板显示）同样写 aiTuneB（对手=蓝方）
  const TUNE_SPEC = {
    tuneAReact: ['aiTuneA', 'reactMul'], tuneACatch: ['aiTuneA', 'catchMul'],
    tuneASmash: ['aiTuneA', 'smashMul'], tuneAAgility: ['aiTuneA', 'agilityMul'],
    tuneBReact: ['aiTuneB', 'reactMul'], tuneBCatch: ['aiTuneB', 'catchMul'],
    tuneBSmash: ['aiTuneB', 'smashMul'], tuneBAgility: ['aiTuneB', 'agilityMul'],
    tuneOppReact: ['aiTuneB', 'reactMul'], tuneOppCatch: ['aiTuneB', 'catchMul'],
    tuneOppSmash: ['aiTuneB', 'smashMul'], tuneOppAgility: ['aiTuneB', 'agilityMul'],
  };

  function tuneVal(el) { return (parseInt(el.value, 10) || 100) / 100; }

  function syncTuneSliders() {
    for (const [id, [sideKey, mulKey]] of Object.entries(TUNE_SPEC)) {
      const el = PPD.ui[id];
      if (!el) continue;
      const mul = PPD.app[sideKey][mulKey];
      el.value = String(Math.round(mul * 100));
      const label = el.parentElement && el.parentElement.querySelector ? el.parentElement.querySelector('b') : null;
      if (label) label.textContent = `×${mul.toFixed(2)}`;
    }
  }

  // 滑杆拖动即生效：写回 app.aiTuneX（loop 下一帧应用），并更新 ×文本
  for (const [id, [sideKey, mulKey]] of Object.entries(TUNE_SPEC)) {
    const el = PPD.ui[id];
    if (!el) continue;
    const apply = () => {
      PPD.app[sideKey][mulKey] = tuneVal(el);
      const label = el.parentElement && el.parentElement.querySelector ? el.parentElement.querySelector('b') : null;
      if (label) label.textContent = `×${PPD.app[sideKey][mulKey].toFixed(2)}`;
    };
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  }

  function togglePause() {
    if (PPD.app.mode !== 'ai' && PPD.app.mode !== 'local' && PPD.app.mode !== 'aivai') return;
    PPD.app.paused = !PPD.app.paused;
    PPD.show(PPD.ui.pausePanel, PPD.app.paused);
    // AI 观战：暂停面板显示双方难度下拉并同步当前值（改后写回 app.aiLevelA/B）
    if (PPD.app.paused && PPD.app.mode === 'aivai') {
      PPD.show(PPD.ui.pauseAIVsAI, true);
      PPD.show(PPD.ui.pauseAITune, false);
      if (PPD.ui.pauseAiLevelA) PPD.ui.pauseAiLevelA.value = String(PPD.app.aiLevelA);
      if (PPD.ui.pauseAiLevelB) PPD.ui.pauseAiLevelB.value = String(PPD.app.aiLevelB);
      syncTuneSliders();
    } else if (PPD.app.paused && PPD.app.mode === 'ai' && PPD.isHellCleared()) {
      // 人机 + 地狱已通关：暂停面板变为「电脑 AI 数值调控」（滑杆即时生效）
      PPD.show(PPD.ui.pauseAIVsAI, false);
      PPD.show(PPD.ui.pauseAITune, true);
      syncTuneSliders();
    } else {
      PPD.show(PPD.ui.pauseAIVsAI, false);
      PPD.show(PPD.ui.pauseAITune, false);
    }
    updateGameTools();
    if (!PPD.app.paused) PPD.GameAudio.ensure();
  }

  PPD.ui.btnPause.addEventListener('click', () => { PPD.GameAudio.ensure(); togglePause(); });
  PPD.ui.btnExit.addEventListener('click', () => { PPD.GameAudio.ensure(); PPD.GameAudio.ui(); PPD.backToMenu(); });
  PPD.ui.btnResume.addEventListener('click', () => { PPD.GameAudio.ensure(); togglePause(); });
  PPD.ui.btnPauseExit.addEventListener('click', () => { PPD.app.paused = false; PPD.backToMenu(); });
  // AI 观战：暂停面板里调整双方 AI 难度（写回 app，loop 下一帧生效）
  if (PPD.ui.pauseAiLevelA) {
    PPD.ui.pauseAiLevelA.addEventListener('change', () => {
      if (PPD.app.mode !== 'aivai') return;
      PPD.app.aiLevelA = PPD.readAiLevel(PPD.ui.pauseAiLevelA);
    });
  }
  if (PPD.ui.pauseAiLevelB) {
    PPD.ui.pauseAiLevelB.addEventListener('change', () => {
      if (PPD.app.mode !== 'aivai') return;
      PPD.app.aiLevelB = PPD.readAiLevel(PPD.ui.pauseAiLevelB);
    });
  }
  window.addEventListener('keydown', (e) => {
    // Esc：设置面板打开时优先关闭设置；否则在比赛中暂停/继续
    if (e.code === 'Escape') {
      if (PPD.ui.settingsPanel && PPD.ui.settingsPanel.style.display !== 'none') {
        PPD.closeSettings();
        return;
      }
      if (PPD.app.mode === 'ai' || PPD.app.mode === 'local' || PPD.app.mode === 'aivai') togglePause();
    }
  });

  // ---------- 屏幕点击：发球瞄准 + 对打单击推球（扣球走右下「扣」按钮） ----------

  function tapSideFor(x) {
    if (PPD.app.mode === 'ai') return 0;               // 人机：始终控制自己（红方）
    if (PPD.app.mode === 'online') return PPD.app.side;    // 联机：控制自己的角色
    return x < PPD.app.resizeW / 2 ? 0 : 1;            // 本地分屏：左半屏 P1，右半屏 P2
  }

  function fireShot(side, type) {
    const k = type === 'sm' ? 'sm' : 'pu';
    const set = (v) => {
      if (PPD.app.mode === 'local') {
        if (side === 0) PPD.app.keyP1[k] = v; else PPD.app.keyP2[k] = v;
      } else if (PPD.app.mode === 'ai') {
        PPD.app.keyP1[k] = v;
        PPD.app.keyP2[k] = v;
      } else {
        PPD.app.keyP1[k] = v;
        PPD.app.keyP2[k] = v;
        PPD.app.keys[k] = v;
      }
    };
    set(1);
    if (PPD.app.mode === 'online') {
      if (type === 'pu' && PPD.app.snapB && PPD.app.snapB.ph === 0) PPD.GameAudio.ensure();
      if (PPD.app.net && PPD.app.net.connected) {
        // 发球时把当前瞄准落点一并上报，保证服务端按瞄准轨迹发球
        const a = PPD.app.serveAim ? [PPD.app.serveAim.x, PPD.app.serveAim.z] : undefined;
        PPD.app.net.send({ t: 'in', i: { l: PPD.app.keys.l, r: PPD.app.keys.r, f: PPD.app.keys.f, b: PPD.app.keys.b, pu: PPD.app.keys.pu, sm: PPD.app.keys.sm, c: PPD.app.keys.crouch, rn: PPD.app.keys.run }, a });
      }
    }
    // 短暂保持按键状态，确保引擎/服务器检测到一次按下边沿
    setTimeout(() => set(0), 70);
  }

  // ---------- 发球瞄准：鼠标/手指位置决定落点与轨迹 ----------
  let lastAimT = 0;
  let lastAimX = -1e9, lastAimY = -1e9;

  // 当前是否轮到“我”发球（返回发球方 side，否则 null）
  function myServeSide() {
    if (PPD.app.mode === 'local' || PPD.app.mode === 'ai') {
      const e = PPD.app.engine;
      if (!e || e.phase !== 'serve' || !e.ball.inHand) return null;
      const side = PPD.app.mode === 'local' ? e.server : 0;
      return side === e.server ? side : null;
    }
    if (PPD.app.mode === 'online') {
      const s = PPD.app.snapB;
      if (!s || s.ph !== 0 || !s.bh || s.sv !== PPD.app.side) return null;
      return PPD.app.side;
    }
    return null;
  }

  // 按指针位置更新瞄准：本地/人机直接求解写入引擎（预览与实发一致），
  // 联机则存到 app.serveAim，由主循环随输入帧上报服务端。
  function updateServeAim(clientX, clientY) {
    const side = myServeSide();
    if (side === null) { PPD.app.serveAiming = false; return; }
    const now = performance.now();
    if (now - lastAimT < 40 && Math.hypot(clientX - lastAimX, clientY - lastAimY) < 8) return;
    lastAimT = now; lastAimX = clientX; lastAimY = clientY;
    const aim = PPD.serveAimFromPointer(clientX, clientY, side);
    if (!aim) return;
    PPD.app.serveAim = aim;
    if (PPD.app.mode !== 'online' && PPD.app.engine) {
      PPD.TT.setServeAim(PPD.app.engine, side, aim.x, aim.z);
    }
  }

  // 新一轮发球开始（serve-ready）时用最近指针位置恢复瞄准
  function refreshServeAim() {
    if (PPD.app.lastPointerX == null) { PPD.app.serveAim = null; return; }
    lastAimT = 0;
    updateServeAim(PPD.app.lastPointerX, PPD.app.lastPointerY);
  }

  PPD.canvas.addEventListener('pointermove', (e) => {
    PPD.app.lastPointerX = e.clientX;
    PPD.app.lastPointerY = e.clientY;
    updateServeAim(e.clientX, e.clientY);
  });

  PPD.canvas.addEventListener('pointerdown', (e) => {
    // 鼠标：左键推球 / 右键扣球（右键不发球菜单）；触屏：单击推球 / 扣球键扣球
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    if (!PPD.app.mode) return;
    PPD.app.lastPointerX = e.clientX;
    PPD.app.lastPointerY = e.clientY;
    const isTouchEv = e.pointerType === 'touch';
    const serveSide = myServeSide();
    if (serveSide !== null) {
      // 发球阶段：电脑单击直接发球；手机第一下点按进入瞄准、第二下点按发球
      updateServeAim(e.clientX, e.clientY);
      // 瞄准目标解不出合法发球：发不出球，提示玩家调整瞄准
      const blocked = PPD.app.mode === 'online'
        ? (PPD.app.snapB && PPD.app.snapB.sb === 1)
        : (PPD.app.engine && PPD.app.engine.players[serveSide].serveAimBlocked);
      if (blocked) {
        PPD.showPoint(PPD.isTouch ? '该位置无法发球，请移动鼠标/手指调整瞄准' : '该位置无法发球，请移动鼠标调整瞄准');
        return;
      }
      if (isTouchEv) {
        if (!PPD.app.serveAiming) {
          PPD.app.serveAiming = true;
          PPD.showPoint('已瞄准：移动手指调整轨迹，再点一下发球');
        } else {
          PPD.app.serveAiming = false;
          fireShot(serveSide, 'pu');
        }
      } else {
        fireShot(serveSide, e.button === 2 ? 'sm' : 'pu');
      }
      return;
    }
    PPD.app.serveAiming = false;
    const side = tapSideFor(e.clientX);
    if (isTouchEv) {
      // 对打（触屏）：单击立即推球（扣球请按右下「扣」按钮）
      fireShot(side, 'pu');
    } else {
      // 对打（鼠标）：左键推球 / 右键扣球
      fireShot(side, e.button === 2 ? 'sm' : 'pu');
    }
  });
  PPD.canvas.addEventListener('contextmenu', (e) => e.preventDefault());


  PPD.updateGameTools = updateGameTools;
  PPD.togglePause = togglePause;
  PPD.showTouch = showTouch;
  PPD.fireShot = fireShot;
  PPD.myServeSide = myServeSide;
  PPD.updateServeAim = updateServeAim;
  PPD.refreshServeAim = refreshServeAim;
})();
