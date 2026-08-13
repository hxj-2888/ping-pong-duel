/* ============================================================
 * app/modes.js — 模式切换：开始/退出/结算/覆盖层（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * ============================================================ */
(function () {
  'use strict';

  function setStatus(text) {
    // 联机框打开时状态提示显示在联机框内（netStatus），否则显示主菜单状态栏
    const el = (PPD.ui.netPanel && PPD.ui.netPanel.style.display !== 'none' && PPD.ui.netStatus)
      ? PPD.ui.netStatus
      : PPD.ui.statusBar;
    if (!el) return;
    el.textContent = text;
    el.style.opacity = 1;
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
    // 撞击特效残留修复:新一局清空旧特效与击球者归属(开局不再残留波纹/溅射)
    PPD.app.lastHitter = -1;
    PPD.app.fx.length = 0;
  }

  function quitGame() {
    if (typeof window !== 'undefined' && window.close) window.close();
  }

  function backToMenu() {
    hideGameOverNow();
    PPD.app.paused = false;
    if (PPD.cancelTeamIntro) PPD.cancelTeamIntro(); // 返回主菜单：立即关闭开场渲染（若在对局中）
    PPD.app.matchTeams = null;
    PPD.app.settingsPause = false; // 设置即暂停：退出对局时复位
    PPD.app.manualPause = false;   // 说明书即暂停：退出对局时复位
    PPD.show(PPD.ui.settingsPanel, false);
    PPD.show(PPD.ui.manualPanel, false);
    PPD.show(PPD.ui.pausePanel, false);
    PPD.GameAudio.setIntensity(0); // 回到主菜单：背景音乐恢复常规节奏
    // 审计 #4/#5:返回菜单 → 递增会话 token(在途 room/state 响应全部作废,不再拉回对局)+
    // 清理会话定时器(陈旧 joinTimer 复活已关闭连接建幽灵房间;watchdog/heartbeat 空转)
    PPD.app.netSessionToken = (PPD.app.netSessionToken || 0) + 1;
    if (PPD.app.net) PPD.app.net.close();
    if (PPD.app.joinTimer) { clearTimeout(PPD.app.joinTimer); PPD.app.joinTimer = null; }
    if (PPD.app.watchdogTimer) { clearInterval(PPD.app.watchdogTimer); PPD.app.watchdogTimer = null; }
    if (PPD.app.heartbeatTimer) { clearInterval(PPD.app.heartbeatTimer); PPD.app.heartbeatTimer = null; }
    PPD.app.mode = null;
    PPD.app.engine = null;
    PPD.app.snapA = PPD.app.snapB = null;
    // 审计 #7:清跨会话残留的快照缓冲/插值状态,避免新房间开局被旧缓冲单调门误判丢弃 ~1s
    PPD.app.snapBuf = null;
    PPD.app.interpClock = null;
    PPD.app._interpLast = null;
    PPD.app.interpGap = null;
    PPD.app.lastEventKeys.clear(); // 退出对局:清事件去重集,避免旧事件在新对局被吞
    PPD.app.lastPhase = -1;
    PPD.app.sideSet = false; // 下次联机会话重新确立 side
    // 清残留联机状态：房间码/重连计数，避免下次建房误走"重连旧房间"路径（本地建房失败修复）
    PPD.app.roomCode = '';
    PPD.app.reconnecting = false;
    PPD.app.reconnectAttempt = 0;
    PPD.app.reconnectStartedAt = 0;
    // 撞击特效残留修复:返回菜单清空特效/击球者归属/对手皮肤
    PPD.app.lastHitter = -1;
    PPD.app.fx.length = 0;
    PPD.app.oppSkin = null;
    PPD.show(PPD.ui.gameScreen, false);
    PPD.show(PPD.ui.menu, true);
    PPD.show(PPD.ui.netPanel, false);
    PPD.show(PPD.ui.netWait, false);
    PPD.showTouch(false);
    if (PPD.refreshRecords) PPD.refreshRecords(); // 个人生涯：返回主页时刷新
  }

  function startOnlineGame(side) {
    PPD.app.mode = 'online';
    PPD.app.side = side;
    PPD.app.lastHitter = -1; // 撞击特效残留修复:新对局复位击球者归属
    PPD.app.fx.length = 0;   // 清空旧撞击特效,开局不再残留
    PPD.app.paused = false;
    PPD.app.snapA = PPD.app.snapB = null;
    PPD.app.lastPhase = -1;
    PPD.app.engine = null;
    PPD.show(PPD.ui.menu, false);
    PPD.show(PPD.ui.gameScreen, true);
    PPD.show(PPD.ui.overlay, false);
    PPD.show(PPD.ui.pausePanel, false);
    PPD.show(PPD.ui.netPanel, false); // 联机框等同新开页面：进入对局即关闭
    PPD.show(PPD.ui.netWait, false);
    PPD.updateGameTools();
    PPD.ui.hintBar.innerHTML =
      'WASD/方向键=移动 · 左键=推球 · 右键=扣球 · Ctrl=蹲下 · 单击=发球';
    if (PPD.isTouch) {
      PPD.ui.hintBar.innerHTML = '摇杆=移动 · 单击=推球 · 上滑=扣球 · 蹲=蹲下 · 发球=点两下';
    }
    PPD.showTouch(true);
  }

  function startLocal() {
    PPD.app.mode = 'local';
    PPD.app.paused = false;
    PPD.app.lastHitter = -1; // 撞击特效残留修复
    PPD.app.fx.length = 0;
    PPD.app.engine = PPD.TT.createEngine();
    // 养成能力（v1.8.0）：本地双人给 P1 注入训练等级（P2 保持默认，公平起见不注入；联机完全不注入）
    if (PPD.applyTrainingToPlayer) PPD.applyTrainingToPlayer(PPD.app.engine.players[0]);
    // 取名生效：P1 用主菜单昵称（空回退 玩家1），P2=玩家2
    PPD.app.names = [PPD.getPlayerName() || '玩家1', '玩家2'];
    // 队伍与旗帜：P1=玩家队（昵称旁选择），P2 恒默认蓝队；观众/球服颜色随旗帜同步
    const teams = PPD.resolveMatchTeams('local');
    PPD.app.matchTeams = teams;
    if (PPD.TTG.setCrowdColors) PPD.TTG.setCrowdColors([teams[0].color, teams[1].color]);
    PPD.setTeamFlag(PPD.ui.flagP1, teams[0]);
    PPD.setTeamFlag(PPD.ui.flagP2, teams[1]);
    PPD.app.lastPhase = -1;
    PPD.app.lastEventKeys.clear();
    PPD.show(PPD.ui.menu, false);
    PPD.show(PPD.ui.gameScreen, true);
    PPD.show(PPD.ui.overlay, false);
    PPD.show(PPD.ui.netPanel, false);
    PPD.show(PPD.ui.netWait, false);
    PPD.show(PPD.ui.pausePanel, false);
    PPD.showTeamIntro(teams); // 开场渲染：双方旗帜/队名，渲染结束进入对局
    PPD.updateGameTools();
    PPD.ui.hintBar.innerHTML =
      'P1: WASD=移动 · 左键=推球 · 右键=扣球 ｜ P2: 方向键=移动 · ,=推球 · .=扣球';
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
    PPD.app.lastHitter = -1; // 撞击特效残留修复
    PPD.app.fx.length = 0;
    PPD.app.aiLevel = readAiLevel(PPD.ui.aiLevel);
    PPD.app.engine = PPD.TT.createEngine();
    // 养成能力（v1.8.0）：人机模式给玩家(P1)注入训练等级；AI 对手(P2) ability 恒 0，判定不受影响
    if (PPD.applyTrainingToPlayer) PPD.applyTrainingToPlayer(PPD.app.engine.players[0]);
    // 取名生效：比分表/胜负/记录里的「你」→ 昵称（空回退 你）
    PPD.app.names = [PPD.getPlayerName() || '你', '电脑'];
    // 队伍与旗帜：玩家队（昵称旁）+ 电脑队（难度下拉旁）；观众/球服颜色随旗帜同步
    const teams = PPD.resolveMatchTeams('ai');
    PPD.app.matchTeams = teams;
    if (PPD.TTG.setCrowdColors) PPD.TTG.setCrowdColors([teams[0].color, teams[1].color]);
    PPD.setTeamFlag(PPD.ui.flagP1, teams[0]);
    PPD.setTeamFlag(PPD.ui.flagP2, teams[1]);
    PPD.app.lastPhase = -1;
    PPD.app.lastEventKeys.clear();
    PPD.AIC.reset();
    PPD.show(PPD.ui.menu, false);
    PPD.show(PPD.ui.gameScreen, true);
    PPD.show(PPD.ui.overlay, false);
    PPD.show(PPD.ui.netPanel, false);
    PPD.show(PPD.ui.netWait, false);
    PPD.show(PPD.ui.pausePanel, false);
    PPD.showTeamIntro(teams); // 开场渲染：双方旗帜/队名，渲染结束进入对局
    PPD.updateGameTools();
    const L = PPD.AIC.LEVELS[PPD.app.aiLevel];
    PPD.ui.hintBar.innerHTML =
      'WASD/方向键=移动 · 左键=推球 · 右键=扣球 · Ctrl=蹲下 · 单击=发球';
    if (PPD.isTouch) {
      PPD.ui.hintBar.innerHTML =
        '摇杆=移动 · 单击=推球 · 上滑=扣球 · 蹲=蹲下 · 发球=点两下';
    }
    PPD.GameAudio.ensure();
    PPD.showTouch(true);
  }

  // ---------- AI 观战（AI vs AI） ----------
  function startAIVsAI() {
    PPD.app.mode = 'aivai';
    PPD.app.paused = false;
    PPD.app.lastHitter = -1; // 撞击特效残留修复
    PPD.app.fx.length = 0;
    PPD.app.aiLevelA = readAiLevel(PPD.ui.aiLevelA);
    PPD.app.aiLevelB = readAiLevel(PPD.ui.aiLevelB);
    PPD.app.engine = PPD.TT.createEngine();
    // AI 观战：双方名字用持久化值（暂停面板可改），缺省 红方 AI/蓝方 AI
    const aiNames = PPD.loadAINames ? PPD.loadAINames() : null;
    PPD.app.names = [
      (aiNames && aiNames[0]) || '红方 AI',
      (aiNames && aiNames[1]) || '蓝方 AI',
    ];
    // 队伍与旗帜：红/蓝双方队伍在难度下拉旁选择；观众/AI 球服颜色随旗帜同步
    const teams = PPD.resolveMatchTeams('aivai');
    PPD.app.matchTeams = teams;
    if (PPD.TTG.setCrowdColors) PPD.TTG.setCrowdColors([teams[0].color, teams[1].color]);
    PPD.setTeamFlag(PPD.ui.flagP1, teams[0]);
    PPD.setTeamFlag(PPD.ui.flagP2, teams[1]);
    PPD.app.lastPhase = -1;
    PPD.app.lastEventKeys.clear();
    PPD.AIC.reset();
    PPD.show(PPD.ui.menu, false);
    PPD.show(PPD.ui.gameScreen, true);
    PPD.show(PPD.ui.overlay, false);
    PPD.show(PPD.ui.netPanel, false);
    PPD.show(PPD.ui.netWait, false);
    PPD.show(PPD.ui.pausePanel, false);
    PPD.showTeamIntro(teams); // 开场渲染：双方旗帜/队名，渲染结束进入对局
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
