/* ============================================================
 * app/main.js — 启动引导与菜单按钮（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 菜单事件 ----------
  PPD.ui.btnLocal.addEventListener('click', () => {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    PPD.startLocal();
  });
  PPD.ui.btnAI.addEventListener('click', () => {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    PPD.startAI();
  });
  PPD.ui.btnAIVsAI.addEventListener('click', () => {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    PPD.startAIVsAI();
  });
  PPD.ui.btnHost.addEventListener('click', () => {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    PPD.app.names[0] = PPD.ui.nameInput.value.trim() || '房主';
    PPD.setupNet(true);
  });
  PPD.ui.btnJoin.addEventListener('click', () => {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    if (!PPD.ui.joinInput.value.trim()) {
      PPD.setStatus('请输入房间码');
      return;
    }
    PPD.app.names[0] = PPD.ui.nameInput.value.trim() || '挑战者';
    PPD.setupNet(false);
  });
  // 联机服务器切换：仅桌面版（localhost）显示；网页版固定走公网同域 /ws
  function refreshNetModeBtn() {
    if (!PPD.ui.btnNetMode) return;
    if (!PPD.isLocalHost) { PPD.show(PPD.ui.btnNetMode, false); return; }
    PPD.show(PPD.ui.btnNetMode, true);
    PPD.ui.btnNetMode.textContent = PPD.app.publicServer ? '联机:公网' : '联机:本地';
  }
  PPD.ui.btnNetMode.addEventListener('click', () => {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    PPD.app.publicServer = !PPD.app.publicServer;
    refreshNetModeBtn();
    PPD.setStatus(PPD.app.publicServer ? '联机服务器：公网（Cloudflare）' : '联机服务器：本地（局域网）');
  });
  refreshNetModeBtn();

  // ---------- 设置面板（主页与比赛页右上角 ⚙）：判定虚线 / 背景音乐 / 游戏音效 ----------
  // 音量滑杆的百分比标签（滑杆 value 0~100 → 显示 N%）
  function syncVolSlider(el, vol) {
    if (!el) return;
    el.value = String(Math.round(vol * 100));
    const lb = el.parentElement && el.parentElement.querySelector ? el.parentElement.querySelector('b') : null;
    if (lb) lb.textContent = Math.round(vol * 100) + '%';
  }
  function openSettings() {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    if (PPD.ui.setShowHitRanges) PPD.ui.setShowHitRanges.checked = PPD.app.showHitRanges;
    if (PPD.ui.setMusic) PPD.ui.setMusic.checked = PPD.GameAudio.isMusicOn();
    if (PPD.ui.setSound) PPD.ui.setSound.checked = !PPD.GameAudio.isMuted();
    syncVolSlider(PPD.ui.setMusicVol, PPD.GameAudio.getMusicVol());
    syncVolSlider(PPD.ui.setSfxVol, PPD.GameAudio.getSfxVol());
    PPD.show(PPD.ui.settingsPanel, true);
  }
  function closeSettings() { PPD.show(PPD.ui.settingsPanel, false); }
  PPD.openSettings = openSettings;
  PPD.closeSettings = closeSettings;
  PPD.ui.btnSettings.addEventListener('click', openSettings);
  PPD.ui.btnSettingsGame.addEventListener('click', openSettings);
  PPD.ui.btnSettingsClose.addEventListener('click', () => { PPD.GameAudio.ui(); closeSettings(); });
  // 判定范围虚线：局内随时可关（设置面板开关，立即生效 + 本地记忆）
  PPD.ui.setShowHitRanges.addEventListener('change', () => {
    PPD.app.showHitRanges = PPD.ui.setShowHitRanges.checked;
    try { localStorage.setItem('ppd_show_hit_ranges', PPD.app.showHitRanges ? '1' : '0'); } catch (e) { /* ignore */ }
  });
  // 背景音乐 / 游戏音效：写回 GameAudio（内部持久化）
  PPD.ui.setMusic.addEventListener('change', () => { PPD.GameAudio.setMusicOn(PPD.ui.setMusic.checked); });
  PPD.ui.setSound.addEventListener('change', () => { PPD.GameAudio.setMuted(!PPD.ui.setSound.checked); });
  // 音乐 / 音效音量滑杆：拖动即生效 + 更新百分比标签
  const wireVol = (el, setter) => {
    if (!el) return;
    const apply = () => {
      const v = (parseInt(el.value, 10) || 0) / 100;
      setter(v);
      syncVolSlider(el, v);
    };
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  };
  wireVol(PPD.ui.setMusicVol, (v) => PPD.GameAudio.setMusicVol(v));
  wireVol(PPD.ui.setSfxVol, (v) => PPD.GameAudio.setSfxVol(v));

  PPD.ui.btnAgain.addEventListener('click', () => { PPD.GameAudio.ensure(); PPD.GameAudio.ui(); PPD.restartMatch(); });
  PPD.ui.btnMenu.addEventListener('click', () => { PPD.GameAudio.ensure(); PPD.GameAudio.ui(); PPD.backToMenu(); });
  PPD.ui.btnQuit.addEventListener('click', () => { PPD.GameAudio.ensure(); PPD.GameAudio.ui(); PPD.quitGame(); });
  // 等待房间面板：返回主页（backToMenu 内部会关闭联机连接）
  PPD.ui.btnRoomBack.addEventListener('click', () => {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    PPD.backToMenu();
  });

  // 提示
  PPD.ui.tips.innerHTML = `
    国际赛事标准：球台 2.74×1.525m（高 0.76m）· 网高 0.1525m · 球 40mm / 2.7g · 拍面 15×15cm<br>
    规则：11 分制（10 平后净胜 2 分）· 每 2 分发球轮换 · 发球须先落本方再落对方半台 · 触网入界重发
  `;

  // ---------- 启动 ----------
  // 各难度下拉的地狱选项：按解锁状态全量同步（人机 + AI 观战主页/暂停面板）
  PPD.syncHellOptions();
  // 背景音乐：页面打开即播（浏览器自动播放策略拦截时，首次交互立即恢复出声）
  PPD.GameAudio.autoplayMusic();
  // 通关记录：进入主菜单时拉取后端并渲染（失败静默）
  if (PPD.refreshRecords) PPD.refreshRecords();
  // 解锁判定兜底：从持久化记录推导地狱解锁/通关（localStorage 被清也不会上锁）
  if (PPD.syncUnlocksFromRecords) PPD.syncUnlocksFromRecords();
  // 调试：?auto=ai 自动进入人机对战（便于截图/自动化验证）
  if (/[?&]auto=ai/.test(location.search)) PPD.startAI();
  // 调试：?net=public 强制联机走公网（桌面端自动化验证用，网页版本就同域 /ws）
  if (/[?&]net=public/.test(location.search)) PPD.app.publicServer = true;
  // 调试：?auto=host 自动创建联机房间；?auto=join&code=XXXX 自动加入（便于自动化验证联机）
  if (/[?&]auto=host/.test(location.search)) {
    PPD.app.names[0] = '房主';
    PPD.setupNet(true);
  }
  if (/[?&]auto=join/.test(location.search)) {
    const cm = /[?&]code=([A-Z0-9]{4})/.exec(location.search);
    if (cm) {
      PPD.ui.joinInput.value = cm[1];
      PPD.app.names[0] = '挑战者';
      PPD.setupNet(false);
    }
  }
  window.addEventListener('resize', PPD.resize);
  PPD.resize();
  PPD.startLoop();
  PPD.ui.hudP1.textContent = '玩家1';
  PPD.ui.hudP2.textContent = '玩家2';

  // 调试/测试句柄（只读暴露内部状态）

  window.__PPD = {
    get app() { return PPD.app; },
    get ui() { return PPD.ui; },
    GameAudio: PPD.GameAudio,
    unlockHell: PPD.unlockHell,
    isHellUnlocked: PPD.isHellUnlocked,
    syncHellOptions: PPD.syncHellOptions,
    viewModelFromEngine: PPD.viewModelFromEngine,
    viewModelFromSnap: PPD.viewModelFromSnap,
    servePathFromSnap: PPD.servePathFromSnap,
    serveAimFromPointer: PPD.serveAimFromPointer,
    myServeSide: PPD.myServeSide,
    updateServeAim: PPD.updateServeAim,
    setServeAim: PPD.TT.setServeAim,
    solveServeTo: PPD.TT.solveServeTo,
    // 地狱解锁（冒烟测试用）
    isHellUnlocked: PPD.isHellUnlocked,
    unlockHell: PPD.unlockHell,
    syncHellOptions: PPD.syncHellOptions,
    // 地狱通关（冒烟测试用）：人机击败地狱 → 解锁人机暂停的电脑 AI 数值调控
    isHellCleared: PPD.isHellCleared,
    markHellCleared: PPD.markHellCleared,
  };
})();
