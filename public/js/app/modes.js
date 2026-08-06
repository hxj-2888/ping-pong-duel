/* ============================================================
 * app/modes.js — 模式切换：开始/退出/结算/覆盖层（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * ============================================================ */
(function () {
  'use strict';

  function setStatus(text) {
    PPD.ui.statusBar.textContent = text;
    PPD.ui.statusBar.style.opacity = 1;
  }

  function showOverlay(title, text, btnText, fn) {
    PPD.ui.overlayTitle.textContent = title;
    PPD.ui.overlayText.textContent = text;
    PPD.ui.overlayBtn.textContent = btnText;
    PPD.ui.overlayBtn.onclick = () => { PPD.show(PPD.ui.overlay, false); fn(); };
    PPD.show(PPD.ui.overlay, true);
  }

  // ---------- 一局结束结算屏：渐变成黑屏 ----------
  let gameOverToken = 0;
  let gameOverHideTimer = null;

  function showGameOver(title) {
    const token = ++gameOverToken;
    clearTimeout(gameOverHideTimer);
    PPD.ui.gameOverTitle.textContent = title;
    PPD.show(PPD.ui.gameOver, true);
    PPD.ui.gameOver.classList.remove('show');
    // 下一帧再加类，触发 0.6s 渐变为黑屏
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token === gameOverToken) PPD.ui.gameOver.classList.add('show');
    }));
  }

  function hideGameOver() {
    gameOverToken++;
    clearTimeout(gameOverHideTimer);
    PPD.ui.gameOver.classList.remove('show');
    gameOverHideTimer = setTimeout(() => PPD.show(PPD.ui.gameOver, false), 650);
  }

  // 立即关闭结算屏（跳过 650ms 渐隐等待），用于"再来一局"
  function hideGameOverNow() {
    gameOverToken++;
    clearTimeout(gameOverHideTimer);
    PPD.ui.gameOver.classList.remove('show');
    PPD.show(PPD.ui.gameOver, false);
  }

  function restartMatch() {
    if (PPD.app.mode === 'online') {
      // 联机需等对方确认 rematch，保留渐隐关闭
      hideGameOver();
      if (PPD.app.net && PPD.app.net.connected) PPD.app.net.send({ t: 'rematch' });
      return;
    }
    // 本地双人 / 人机：立即关闭结算屏再重置引擎，避免黑屏卡顿感
    hideGameOverNow();
    if (PPD.app.engine) {
      PPD.TT.resetMatch(PPD.app.engine);
      PPD.AIC.reset();
      PPD.app.lastEventKeys.clear();
      PPD.app.lastPhase = -1;
    }
  }

  function quitGame() {
    if (typeof window !== 'undefined' && window.close) window.close();
  }

  function backToMenu() {
    hideGameOverNow();
    PPD.app.paused = false;
    PPD.show(PPD.ui.pausePanel, false);
    PPD.GameAudio.setIntensity(0); // 回到主菜单：背景音乐恢复常规节奏
    if (PPD.app.net) PPD.app.net.close();
    PPD.app.mode = null;
    PPD.app.engine = null;
    PPD.app.snapA = PPD.app.snapB = null;
    PPD.app.lastPhase = -1;
    PPD.app.sideSet = false; // 下次联机会话重新确立 side
    PPD.show(PPD.ui.gameScreen, false);
    PPD.show(PPD.ui.menu, true);
    PPD.show(PPD.ui.roomPanel, false);
    PPD.showTouch(false);
    if (PPD.updateMenuScroll) PPD.updateMenuScroll(); // 回到主页：刷新滚动钮显隐
    if (PPD.refreshRecords) PPD.refreshRecords(); // 通关记录：返回主页时刷新
  }

  function startOnlineGame(side) {
    PPD.app.mode = 'online';
    PPD.app.side = side;
    PPD.app.paused = false;
    PPD.app.snapA = PPD.app.snapB = null;
    PPD.app.lastPhase = -1;
    PPD.app.engine = null;
    PPD.show(PPD.ui.menu, false);
    PPD.show(PPD.ui.gameScreen, true);
    PPD.show(PPD.ui.overlay, false);
    PPD.show(PPD.ui.pausePanel, false);
    PPD.updateGameTools();
    PPD.ui.hintBar.innerHTML =
      'WASD/方向键=移动 · 左键=推球 · 右键=扣球 · Ctrl=蹲下 · 单击=发球';
    if (PPD.isTouch) {
      PPD.ui.hintBar.innerHTML = '摇杆=移动 · 点按=推球 · 扣=扣球 · 蹲=蹲下 · 发球=点两下';
    }
    PPD.showTouch(true);
  }

  function startLocal() {
    PPD.app.mode = 'local';
    PPD.app.paused = false;
    PPD.app.engine = PPD.TT.createEngine();
    PPD.app.names = ['玩家1', '玩家2'];
    PPD.app.lastPhase = -1;
    PPD.app.lastEventKeys.clear();
    PPD.show(PPD.ui.menu, false);
    PPD.show(PPD.ui.gameScreen, true);
    PPD.show(PPD.ui.overlay, false);
    PPD.show(PPD.ui.roomPanel, false);
    PPD.show(PPD.ui.pausePanel, false);
    PPD.updateGameTools();
    PPD.ui.hintBar.innerHTML =
      'P1: WASD=移动 · 左键=推球 · 右键=扣球 ｜ P2: 方向键=移动 · ↑=推球 · ↓=扣球';
    if (PPD.isTouch) {
      PPD.ui.hintBar.innerHTML = '摇杆=移动 · 点按=推球 · 扣=扣球 · 蹲=蹲下 · 发球=点两下（左半屏 P1，右半屏 P2）';
    }
    PPD.GameAudio.ensure();
    PPD.showTouch(true);
  }

  // 读取难度下拉（value="0"(简单)/"1"(中等)/"2"(困难)/"3"(地狱，需解锁)）。
  // 注意不能用 `parseInt(...) || 1`：简单=0 会被当成 falsy 改成中等。
  function readAiLevel(sel) {
    const lvl = parseInt(sel && sel.value, 10);
    if (lvl === 0 || lvl === 1 || lvl === 2) return lvl;
    if (lvl === 3 && PPD.isHellUnlocked()) return 3;
    return 1;
  }

  function startAI() {
    PPD.app.mode = 'ai';
    PPD.app.paused = false;
    PPD.app.aiLevel = readAiLevel(PPD.ui.aiLevel);
    PPD.app.engine = PPD.TT.createEngine();
    PPD.app.names = ['你', '电脑'];
    PPD.app.lastPhase = -1;
    PPD.app.lastEventKeys.clear();
    PPD.AIC.reset();
    PPD.show(PPD.ui.menu, false);
    PPD.show(PPD.ui.gameScreen, true);
    PPD.show(PPD.ui.overlay, false);
    PPD.show(PPD.ui.roomPanel, false);
    PPD.show(PPD.ui.pausePanel, false);
    PPD.updateGameTools();
    const L = PPD.AIC.LEVELS[PPD.app.aiLevel];
    PPD.ui.hintBar.innerHTML =
      'WASD/方向键=移动 · 左键=推球 · 右键=扣球 · Ctrl=蹲下 · 单击=发球';
    if (PPD.isTouch) {
      PPD.ui.hintBar.innerHTML =
        '摇杆=移动 · 点按=推球 · 扣=扣球 · 蹲=蹲下 · 发球=点两下';
    }
    PPD.GameAudio.ensure();
    PPD.showTouch(true);
  }

  // ---------- AI 观战（AI vs AI） ----------
  function startAIVsAI() {
    PPD.app.mode = 'aivai';
    PPD.app.paused = false;
    PPD.app.aiLevelA = readAiLevel(PPD.ui.aiLevelA);
    PPD.app.aiLevelB = readAiLevel(PPD.ui.aiLevelB);
    PPD.app.engine = PPD.TT.createEngine();
    PPD.app.names = ['红方 AI', '蓝方 AI'];
    PPD.app.lastPhase = -1;
    PPD.app.lastEventKeys.clear();
    PPD.AIC.reset();
    PPD.show(PPD.ui.menu, false);
    PPD.show(PPD.ui.gameScreen, true);
    PPD.show(PPD.ui.overlay, false);
    PPD.show(PPD.ui.roomPanel, false);
    PPD.show(PPD.ui.pausePanel, false);
    PPD.updateGameTools();
    const LA = PPD.AIC.LEVELS[PPD.app.aiLevelA], LB = PPD.AIC.LEVELS[PPD.app.aiLevelB];
    PPD.ui.hintBar.innerHTML =
      `红方 ${LA.name} vs 蓝方 ${LB.name} · 暂停中可调难度`;
    PPD.GameAudio.ensure();
    PPD.showTouch(false);
  }


  PPD.setStatus = setStatus;
  PPD.showOverlay = showOverlay;
  PPD.showGameOver = showGameOver;
  PPD.hideGameOver = hideGameOver;
  PPD.hideGameOverNow = hideGameOverNow;
  PPD.restartMatch = restartMatch;
  PPD.quitGame = quitGame;
  PPD.backToMenu = backToMenu;
  PPD.readAiLevel = readAiLevel;
  PPD.startOnlineGame = startOnlineGame;
  PPD.startLocal = startLocal;
  PPD.startAI = startAI;
  PPD.startAIVsAI = startAIVsAI;
})();
