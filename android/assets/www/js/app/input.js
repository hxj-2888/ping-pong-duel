/* ============================================================
 * app/input.js — 键盘/触屏/点击输入与暂停工具（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 输入 ----------
  const KEYMAP = {
    KeyA: 'P1L', KeyD: 'P1R', KeyW: 'P1F', KeyS: 'P1B',
    // 电脑端适配：方向键四向移动（↑/↓ 为前后移动方向键）；P2 推球/扣球改到 ,/.（右手区）
    ArrowLeft: 'P2L', ArrowRight: 'P2R', ArrowUp: 'P2F', ArrowDown: 'P2B',
    Comma: 'P2U', Period: 'P2D',
    ControlLeft: 'P1C', ControlRight: 'P1C',  // Ctrl 蹲下
    ShiftLeft: 'P1S', ShiftRight: 'P1S',      // Shift 跑步
  };

  // v2.6.0：蹲下按键看门狗计时——Ctrl keyup 可能被浏览器吞掉（Ctrl+W/Tab、切标签页、IME 等），
  // 导致 keys.crouch 永久卡 1（蹲下后无法站起）。物理按住时 OS 按键重复会持续刷新该时刻，
  // keyup 丢失后重复停止 → 200ms 轮询发现"按住超 500ms 且无重复"即强制释放。
  let lastCrouchDownAt = 0;
  // v2.7.2-fix:手机端蹲下按钮按住标记——触控按住没有 OS 键盘重复事件，lastCrouchDownAt 不会
  // 刷新，看门狗会在 500ms 后把"仍在按住"的蹲误释放（手机联机蹲不住）。按住期间豁免看门狗。
  let touchCrouchHeld = false;

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
    if (k.endsWith('C')) {
      map.crouch = down ? 1 : 0;
      if (down) lastCrouchDownAt = performance.now();
    }
    if (k.endsWith('S')) map.run = down ? 1 : 0;
    if (down && k.endsWith('U') && PPD.app.mode === 'online' && PPD.app.snapB && PPD.app.snapB.ph === 0) {
      PPD.GameAudio.ensure();
    }
  }

  // P0-3：联机时立即把当前按键状态上行（失焦清零/回前台补发共用）。
  // 失焦后浏览器 rAF 暂停，loop 的输入发送会停摆——若不主动补发，
  // 服务器会保留失焦前的旧按键继续移动（回前台错位、角色"自己走动"）。
  function sendOnlineKeys() {
    if (PPD.app.mode !== 'online' || !PPD.app.net || !PPD.app.net.connected) return;
    const k = PPD.app.keys || {};
    const mask = (k.l ? 1 : 0) | (k.r ? 2 : 0) | (k.pu ? 4 : 0) | (k.sm ? 8 : 0) |
                 (k.f ? 16 : 0) | (k.b ? 32 : 0) | (k.crouch ? 64 : 0) | (k.run ? 128 : 0);
    // v2.7.0-fix:输入帧序号（与 loop 发送共用同一计数器，保证会话内单调不减）
    const seq = (PPD.app._inSeq = (PPD.app._inSeq || 0) + 1);
    PPD.app.net.send({ t: 'in', k: mask, seq });
    PPD.app._lastKeysSent = mask; // 与 loop 发送节流同步，避免下一帧重复发同一掩码
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
    // P0-3：失焦立即把全 0 上行，复位服务器输入（防旧按键残留继续走）
    sendOnlineKeys();
  });
  // P0-3：回前台补发当前键状态（失焦清键后浏览器不重发 keydown，长按键需主动同步）
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) sendOnlineKeys();
    });
  }

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

  // v2.6.0：蹲下按键看门狗——keyup 被浏览器吞掉时强制释放（防"蹲下后无法站起"）
  setInterval(() => {
    if (PPD.app && PPD.app.mode === 'online' && PPD.app.keys && PPD.app.keys.crouch === 1 &&
        !touchCrouchHeld && performance.now() - lastCrouchDownAt > 500) {
      if (PPD.app.keyP1) PPD.app.keyP1.crouch = 0;
      if (PPD.app.keyP2) PPD.app.keyP2.crouch = 0;
      syncKeys();
      // v2.7.0-fix:释放后立即上行（不等下一帧 loop 的 changed 检测）——服务器 1s 输入超时前就收到
      // crouch=0，避免"本地已释放、服务器仍蹲 / 服务器超时清零、本地仍显示蹲"的短暂分叉
      if (PPD.sendOnlineKeys) PPD.sendOnlineKeys();
    }
  }, 200);

  // ---------- 手机端触控按钮 ----------
  function showTouch(v) {
    // 手机端已取消本地分屏（需求 11）：P2 触控组与分屏适配已删除，仅 P1 一组控件
    PPD.show(PPD.ui.touchControls, v && PPD.isTouch);
  }

  // 全方位摇杆：拖动映射左/右/前/后（可斜向移动），松手回中
  const JOY_MAX = 48; // 摇杆最大行程（px）
  // 摇杆工厂：P1/P2 各一个实例，base/knob 为各自 DOM，keyMap 指定写入哪一侧键组（'keyP1'/'keyP2'）
  function makeJoy(base, knob, keyMap) {
    const joy = { active: false, id: -1, cx: 0, cy: 0, dx: 0, dy: 0 };
    const apply = () => {
      const k = PPD.app[keyMap];
      k.r = joy.dx > 0.25 ? 1 : 0;
      k.l = joy.dx < -0.25 ? 1 : 0;
      k.f = joy.dy < -0.25 ? 1 : 0; // 上=向前（朝网）
      k.b = joy.dy > 0.25 ? 1 : 0;
      syncKeys();
    };
    const move = (clientX, clientY) => {
      let dx = clientX - joy.cx, dy = clientY - joy.cy;
      const len = Math.hypot(dx, dy);
      if (len > JOY_MAX) { dx = (dx / len) * JOY_MAX; dy = (dy / len) * JOY_MAX; }
      joy.dx = dx / JOY_MAX;
      joy.dy = dy / JOY_MAX;
      if (knob) knob.style.transform = `translate(${dx}px, ${dy}px)`;
      apply();
    };
    const reset = () => {
      joy.active = false; joy.id = -1;
      joy.dx = 0; joy.dy = 0;
      const k = PPD.app[keyMap];
      k.l = 0; k.r = 0; k.f = 0; k.b = 0;
      if (knob) knob.style.transform = 'translate(0,0)';
      syncKeys();
    };
    if (base) {
      base.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        joy.active = true; joy.id = e.pointerId;
        const r = base.getBoundingClientRect();
        joy.cx = r.left + r.width / 2; joy.cy = r.top + r.height / 2;
        move(e.clientX, e.clientY);
        if (base.setPointerCapture) { try { base.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      });
      base.addEventListener('pointermove', (e) => {
        if (joy.active && e.pointerId === joy.id) move(e.clientX, e.clientY);
      });
      const end = (e) => { if (joy.active && e.pointerId === joy.id) reset(); };
      base.addEventListener('pointerup', end);
      base.addEventListener('pointercancel', end);
      base.addEventListener('pointerleave', end);
      base.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    return { apply, reset };
  }

  function bindTouch() {
    const hold = (el, key, map) => {
      if (!el) return;
      const on = (v) => (e) => { e.preventDefault(); PPD.app[map][key] = v; syncKeys(); };
      el.addEventListener('pointerdown', on(1));
      el.addEventListener('pointerup', on(0));
      el.addEventListener('pointercancel', on(0));
      el.addEventListener('pointerleave', on(0));
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    // 蹲下按钮（手机端）：按住蹲下（与电脑 Ctrl 相同效果）；扣球已改为滑屏（见 canvas pointerup）
    hold(PPD.ui.btnCrouch, 'crouch', 'keyP1');
    // v2.7.2-fix:按住期间豁免键盘看门狗（触控无 OS 重复事件，否则 500ms 后被误释放→蹲不住）
    if (PPD.ui.btnCrouch) {
      PPD.ui.btnCrouch.addEventListener('pointerdown', () => { touchCrouchHeld = true; });
      const crouchOff = () => { touchCrouchHeld = false; };
      PPD.ui.btnCrouch.addEventListener('pointerup', crouchOff);
      PPD.ui.btnCrouch.addEventListener('pointercancel', crouchOff);
      PPD.ui.btnCrouch.addEventListener('pointerleave', crouchOff);
    }
    // 手机端已取消本地分屏：仅 P1 一套摇杆（P2 触控组已删除）
    makeJoy(PPD.ui.joyBase, PPD.ui.joyKnob, 'keyP1');
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
  // 重置按钮 → 要重置的 aiTune 对象（观战蓝方与 人机对手同写 aiTuneB）
  const TUNE_RESET = {
    tuneResetA: 'aiTuneA',
    tuneResetB: 'aiTuneB',
    tuneResetOpp: 'aiTuneB',
  };

  function tuneVal(el) { return (parseInt(el.value, 10) || 100) / 100; }

  // 该侧滑杆对应的 AI 难度（观战红=aiLevelA、观战蓝=aiLevelB、人机对手=aiLevel）
  function tuneLevel(sideKey) {
    if (sideKey === 'aiTuneA') return PPD.app.aiLevelA;
    if (PPD.app.mode === 'ai') return PPD.app.aiLevel;
    return PPD.app.aiLevelB;
  }

  // 按当前难度 + 倍率算出"等效实际值"（与 ai.js 同一套公式，×1 时即难度基准值）
  function tuneEffText(mulKey, mul, level) {
    const L = PPD.AIC && PPD.AIC.LEVELS[level] ? PPD.AIC.LEVELS[level] : null;
    if (!L) return '';
    const clampV = (v, a, b) => (v < a ? a : v > b ? b : v);
    if (mulKey === 'reactMul') {
      // v1.6.1：地狱反应线性（与 ai.js 一致）——0.5→0.02s、1.5→0s 均匀递减；其余难度 基准/倍率
      const d = level === 3 ? Math.max(0, Math.min(0.02, 0.02 * (1.5 - mul))) : L.react / mul;
      return `延迟 ${d.toFixed(2)}s`;
    }
    if (mulKey === 'catchMul') {
      // 人机地狱默认接球率 ×1.0（与 loop.js 传的 hellCatchMul:1 一致：永不刻意漏球）
      const hellMul = (PPD.app.mode === 'ai' && level === 3) ? 1.0 : 1;
      const base = L.catchProb * hellMul;
      // 与 ai.js 同一漏球率线性模型：漏球率 = 基准漏球率 / 倍率（0.5~1.5 全程线性有效）
      const miss = base >= 1 ? 0 : Math.min(0.8, Math.max(0.005, (1 - base) / mul));
      const missTxt = base >= 1 ? '永不漏球' : `每 ${Math.max(2, Math.round(1 / miss))} 球漏 1`;
      // 防扣（接扣球加成）等效值：AI 观战地狱 = 40%~90% 均匀线性；人机对战地狱 = 分段线性
      // ×0.5→50%、×1→80%、×1.5→95%（上限封顶，显示实际值）；其余难度 = 漏球率线性模型 × 实测系数（困难 0.91）
      let sd;
      if (level === 3 && PPD.app.mode !== 'ai') {
        sd = 0.40 + 0.50 * Math.max(0, Math.min(1, mul - 0.5));
      } else if (level === 3) {
        const m = Math.max(0.5, Math.min(1.5, mul));
        sd = m <= 1 ? 0.50 + 0.60 * (m - 0.5) : 0.80 + 0.30 * (m - 1);
      } else {
        const DEF_EFF = { 2: 0.91 };
        const gate = DEF_EFF[level] || 1;
        sd = (L.smashDef || 0) <= 0 ? 0 : clampV(1 - (1 - (L.smashDef || 0)) / mul, 0, 1) * gate;
      }
      return `刻意漏球率 ${Math.round(miss * 100)}%（${missTxt}）` + (L.smashDef > 0 ? `· 防扣约 ${Math.round(sd * 100)}%` : '');
    }
    if (mulKey === 'smashMul') {
      const over = Math.max(0, mul - 1);
      const sp = clampV(L.smashProb * mul, 0, 1);
      if (L.smashProb === 0) return over > 0 ? '扣杀率 0%（溢出→回球更刁钻）' : '扣杀率 0%';
      if (sp >= 1) return `扣杀率 100%${over > 0 ? '（溢出→更刁钻）' : ''}`;
      return `扣杀率 ${Math.round(sp * 100)}%`;
    }
    if (mulKey === 'agilityMul') {
      const over = Math.max(0, mul - 1);
      const under = Math.max(0, 1 - mul);
      // 与 ai.js 同公式：基础 × 倍率（夹取）+ <1 惩罚占空比折扣；按实际值显示
      // （修复困难/地狱拉低滑杆仍显示"移动 100%"的 bug）
      const eff = clampV(L.agility * mul * (1 - under * 0.5), 0, 1);
      // 敏捷>1 移动速度加成（与 ai.js 同公式：最大 +25%）
      const bonus = Math.min(25, Math.round(Math.max(0, mul - 1) * 0.5 * 100));
      let txt = eff >= 1 ? `移动 100%${over > 0 ? '（溢出→站位更准）' : ''}` : `移动 ${Math.round(eff * 100)}%`;
      if (bonus > 0) txt += ` · 速度加成 +${bonus}%`;
      if (under > 0) txt += '（减速惩罚）';
      return txt;
    }
    return '';
  }

  function refreshTuneEff(id, sideKey, mulKey) {
    const el = PPD.ui[id];
    if (!el) return;
    const span = el.parentElement && el.parentElement.querySelector ? el.parentElement.querySelector('.tune-eff') : null;
    if (span) span.textContent = tuneEffText(mulKey, PPD.app[sideKey][mulKey], tuneLevel(sideKey));
  }

  function refreshAllTuneEff() {
    for (const [id, [sideKey, mulKey]] of Object.entries(TUNE_SPEC)) refreshTuneEff(id, sideKey, mulKey);
  }

  function syncTuneSliders() {
    for (const [id, [sideKey, mulKey]] of Object.entries(TUNE_SPEC)) {
      const el = PPD.ui[id];
      if (!el) continue;
      const mul = PPD.app[sideKey][mulKey];
      el.value = String(Math.round(mul * 100));
      const label = el.parentElement && el.parentElement.querySelector ? el.parentElement.querySelector('b') : null;
      if (label) label.textContent = `×${mul.toFixed(2)}`;
      refreshTuneEff(id, sideKey, mulKey);
    }
  }

  // 滑杆拖动即生效：写回 app.aiTuneX（loop 下一帧应用），并更新 ×文本与等效值提示
  for (const [id, [sideKey, mulKey]] of Object.entries(TUNE_SPEC)) {
    const el = PPD.ui[id];
    if (!el) continue;
    const apply = () => {
      PPD.app[sideKey][mulKey] = tuneVal(el);
      const label = el.parentElement && el.parentElement.querySelector ? el.parentElement.querySelector('b') : null;
      if (label) label.textContent = `×${PPD.app[sideKey][mulKey].toFixed(2)}`;
      refreshTuneEff(id, sideKey, mulKey);
    };
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  }

  // 重置按钮：本侧四项全部回到 ×1
  for (const [id, key] of Object.entries(TUNE_RESET)) {
    const btn = PPD.ui[id];
    if (!btn) continue;
    btn.addEventListener('click', () => {
      const set = PPD.app[key];
      set.reactMul = 1; set.catchMul = 1; set.smashMul = 1; set.agilityMul = 1;
      syncTuneSliders();
    });
  }

  // v2.0:AI 观战暂停特效开关(尾影/撞击特效显示,仅观战生效;localStorage 记忆)
  if (PPD.ui.setTrailFx) {
    PPD.ui.setTrailFx.addEventListener('change', () => {
      PPD.app.fxShow.trail = PPD.ui.setTrailFx.checked;
      try { localStorage.setItem('ppd_fx_show', JSON.stringify(PPD.app.fxShow)); } catch (e) { /* ignore */ }
    });
  }
  if (PPD.ui.setSplashFx) {
    PPD.ui.setSplashFx.addEventListener('change', () => {
      PPD.app.fxShow.splash = PPD.ui.setSplashFx.checked;
      try { localStorage.setItem('ppd_fx_show', JSON.stringify(PPD.app.fxShow)); } catch (e) { /* ignore */ }
    });
  }

  function togglePause() {
    if (PPD.app.introActive) return; // 对局开场渲染期间不可暂停
    if (PPD.app.mode !== 'ai' && PPD.app.mode !== 'local' && PPD.app.mode !== 'aivai') return;
    PPD.app.paused = !PPD.app.paused;
    PPD.show(PPD.ui.pausePanel, PPD.app.paused);
    // 模拟推演：暂停面板显示双方难度下拉并同步当前值（改后写回 app.aiLevelA/B）
    if (PPD.app.paused && PPD.app.mode === 'aivai') {
      PPD.show(PPD.ui.pauseAIVsAI, true);
      PPD.show(PPD.ui.pauseAITune, false);
      if (PPD.ui.pauseAiLevelA) PPD.ui.pauseAiLevelA.value = String(PPD.app.aiLevelA);
      if (PPD.ui.pauseAiLevelB) PPD.ui.pauseAiLevelB.value = String(PPD.app.aiLevelB);
      // 模拟推演：暂停可改双方名字（回填当前值，改动即时写回 HUD/胜负显示）
      if (PPD.ui.pauseAiNameA) PPD.ui.pauseAiNameA.value = PPD.app.names[0] || '甲 AI';
      if (PPD.ui.pauseAiNameB) PPD.ui.pauseAiNameB.value = PPD.app.names[1] || '乙 AI';
      syncTuneSliders();
    } else if (PPD.app.paused && PPD.app.mode === 'ai' && PPD.app.aiGameType !== 'endless' && PPD.isHellCleared()) {
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
  // 模拟推演：暂停面板里调整甲/乙双方 AI 难度（写回 app，loop 下一帧生效；等效值提示随之刷新）
  if (PPD.ui.pauseAiLevelA) {
    PPD.ui.pauseAiLevelA.addEventListener('change', () => {
      if (PPD.app.mode !== 'aivai') return;
      PPD.app.aiLevelA = PPD.readAISpec(PPD.ui.pauseAiLevelA);
      refreshAllTuneEff();
    });
  }
  if (PPD.ui.pauseAiLevelB) {
    PPD.ui.pauseAiLevelB.addEventListener('change', () => {
      if (PPD.app.mode !== 'aivai') return;
      PPD.app.aiLevelB = PPD.readAISpec(PPD.ui.pauseAiLevelB);
      refreshAllTuneEff();
    });
  }
  // 模拟推演：暂停面板修改甲/乙 AI 名字（写回 PPD.app.names → HUD/胜负即时生效；持久化本地）
  const bindAIName = (el, side) => {
    if (!el) return;
    const apply = () => {
      if (PPD.app.mode !== 'aivai') return;
      PPD.app.names[side] = el.value.trim() || (side === 0 ? '甲 AI' : '乙 AI');
      if (PPD.saveAINames) PPD.saveAINames(PPD.app.names);
    };
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  };
  bindAIName(PPD.ui.pauseAiNameA, 0);
  bindAIName(PPD.ui.pauseAiNameB, 1);
  window.addEventListener('keydown', (e) => {
    // Esc：个人生涯合并页 > 无尽人机 > 说明书 > 联机框 > 设置面板 > 比赛中暂停/继续
    if (e.code === 'Escape') {
      if (PPD.Replay && PPD.Replay.isActive() && PPD.Replay.closePlayer) {
        PPD.Replay.closePlayer();
        return;
      }
      if (PPD.ui.careerPanel && PPD.ui.careerPanel.style.display !== 'none' && PPD.closeCareer) {
        PPD.closeCareer();
        return;
      }
      if (PPD.ui.endlessPanel && PPD.ui.endlessPanel.style.display !== 'none' && PPD.closeEndlessPanel) {
        PPD.closeEndlessPanel();
        return;
      }
      if (PPD.ui.manualPanel && PPD.ui.manualPanel.style.display !== 'none' && PPD.closeManual) {
        PPD.closeManual();
        return;
      }
      if (PPD.ui.netPanel && PPD.ui.netPanel.style.display !== 'none' && PPD.closeNetPanel) {
        PPD.closeNetPanel();
        return;
      }
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
        // 发球时把当前瞄准落点一并上报（位掩码压缩：8 键 → 1 数），保证服务端按瞄准轨迹发球
        const k = (PPD.app.keys.l ? 1 : 0) | (PPD.app.keys.r ? 2 : 0) | (PPD.app.keys.pu ? 4 : 0) | (PPD.app.keys.sm ? 8 : 0) | (PPD.app.keys.f ? 16 : 0) | (PPD.app.keys.b ? 32 : 0) | (PPD.app.keys.crouch ? 64 : 0) | (PPD.app.keys.run ? 128 : 0);
        const aim = PPD.app.serveAim;
        if (aim) {
          PPD.app.net.send({ t: 'in', k, a: [Math.round(aim.x * 100) / 100, Math.round(aim.z * 100) / 100] });
        } else {
          PPD.app.net.send({ t: 'in', k });
        }
        // P2-3：直发后同步节流标记，避免下一帧 loop 因 changed 重复发同一掩码
        PPD.app._lastKeysSent = k;
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
  // 节流 50ms（非防抖）：移动中每 50ms 求解一次——求解已优化到毫秒级（粗搜 96 次+中断），
  // 轨迹半帧跟手且不掉帧；发球点击前 flushServeAim() 强制用最新位置立即求解
  function doAim(clientX, clientY, side) {
    const now = performance.now();
    if (now - lastAimT < 50 && Math.hypot(clientX - lastAimX, clientY - lastAimY) < 6) return;
    lastAimT = now; lastAimX = clientX; lastAimY = clientY;
    const aim = PPD.serveAimFromPointer(clientX, clientY, side);
    if (!aim) return;
    PPD.app.serveAim = aim;
    if (PPD.app.mode !== 'online' && PPD.app.engine) {
      PPD.TT.setServeAim(PPD.app.engine, side, aim.x, aim.z);
    }
  }

  function updateServeAim(clientX, clientY) {
    const side = myServeSide();
    if (side === null) { PPD.app.serveAiming = false; return; }
    doAim(clientX, clientY, side);
  }

  // 发球点击/触屏点按前调用：强制用最近指针位置立即求解（绕过节流），保证实发落点与瞄准一致
  function flushServeAim() {
    if (PPD.app.lastPointerX == null) return;
    const side = myServeSide();
    if (side === null) return;
    lastAimT = 0;
    doAim(PPD.app.lastPointerX, PPD.app.lastPointerY, side);
  }

  // 新一轮发球开始（serve-ready）时用最近指针位置恢复瞄准（立即求解一次）
  function refreshServeAim() {
    if (PPD.app.lastPointerX == null) { PPD.app.serveAim = null; return; }
    lastAimT = 0;
    const side = myServeSide();
    if (side === null) return;
    doAim(PPD.app.lastPointerX, PPD.app.lastPointerY, side);
  }

  PPD.canvas.addEventListener('pointermove', (e) => {
    PPD.app.lastPointerX = e.clientX;
    PPD.app.lastPointerY = e.clientY;
    updateServeAim(e.clientX, e.clientY);
  });

  // ---------- 触屏滑屏扣球（上滑） ----------
  // 对打阶段（非发球）：触摸抬手时判定——快速上滑(≥45px、≤350ms)=扣球，否则单击=推球。
  // 推球由"按下即发"改为"抬手判定"，滑屏判定才干净；鼠标仍按下即发（左键推/右键扣）。
  // 按 pointerId 分别记录（本地分屏双人同时触摸互不干扰；发球阶段的触摸不进表，抬手时自然无操作）。
  const SWIPE_SM_DIST = 45; // 上滑判定距离（px）
  const SWIPE_SM_MS = 350;  // 上滑判定时长（ms）
  const rallyTouches = new Map(); // pointerId -> {x, y, t, side}

  PPD.canvas.addEventListener('pointerdown', (e) => {
    // 鼠标：左键推球 / 右键扣球；触屏：抬手判定 上滑=扣球 / 单击=推球（发球点两下不变）
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    if (!PPD.app.mode) return;
    PPD.app.lastPointerX = e.clientX;
    PPD.app.lastPointerY = e.clientY;
    const isTouchEv = e.pointerType === 'touch';
    const serveSide = myServeSide();
    if (serveSide !== null) {
      // 发球阶段：电脑单击直接发球；手机第一下点按进入瞄准、第二下点按发球
      updateServeAim(e.clientX, e.clientY);
      flushServeAim(); // 点击发球：强制立即用最新指针位置求解（不等防抖），保证实发落点与瞄准一致
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
      // 对打（触屏）：记录按下，抬手时判定 上滑=扣球 / 单击=推球
      rallyTouches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), side });
      return;
    }
    // 对打（鼠标）：左键推球 / 右键扣球
    fireShot(side, e.button === 2 ? 'sm' : 'pu');
  });
  PPD.canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    const d = rallyTouches.get(e.pointerId);
    if (!d) return;
    rallyTouches.delete(e.pointerId);
    const dy = d.y - e.clientY; // 上滑为正值
    const dt = performance.now() - d.t;
    fireShot(d.side, (dy >= SWIPE_SM_DIST && dt <= SWIPE_SM_MS) ? 'sm' : 'pu');
  });
  PPD.canvas.addEventListener('pointercancel', (e) => { rallyTouches.delete(e.pointerId); });
  PPD.canvas.addEventListener('contextmenu', (e) => e.preventDefault());


  PPD.updateGameTools = updateGameTools;
  PPD.togglePause = togglePause;
  PPD.showTouch = showTouch;
  PPD.fireShot = fireShot;
  PPD.myServeSide = myServeSide;
  PPD.updateServeAim = updateServeAim;
  PPD.flushServeAim = flushServeAim;
  PPD.refreshServeAim = refreshServeAim;
})();
