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
    PPD.app.names[0] = PPD.getPlayerName() || '房主';
    PPD.app.lanTarget = ''; // 房主始终连本机服务器（自己的 server.js），忽略对方地址输入
    // 立即反馈：DO 冷启动/网络抖动时连接可能需 1~8s，避免用户以为点了没反应
    PPD.setStatus('正在连接服务器…');
    PPD.setupNet(true);
  });
  PPD.ui.btnJoin.addEventListener('click', () => {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    if (!PPD.ui.joinInput.value.trim()) {
      PPD.setStatus('请输入房间码');
      return;
    }
    PPD.app.names[0] = PPD.getPlayerName() || '挑战者';
    // 本地模式：读取"对方设备地址"（IP 或 IP:端口，可留空=自动用当前页面地址）
    PPD.app.lanTarget = (PPD.ui.lanTargetInput && PPD.ui.lanTargetInput.value.trim()) || '';
    PPD.setStatus('正在连接服务器…');
    PPD.setupNet(false);
  });
  // 昵称持久化：取名生效——输入即保存，下次打开仍是该名字
  if (PPD.ui.nameInput) {
    PPD.ui.nameInput.addEventListener('input', () => {
      try { localStorage.setItem('ppd_name', PPD.ui.nameInput.value.trim()); } catch (e) { /* ignore */ }
    });
  }
  // 联机服务器切换：所有入口（桌面应用 / 局域网页面 / 网页版）都显示"本地/公网"选项。
  // 网页版(https)的本地联机正在探索中、暂不对网页版开放（浏览器安全策略禁止 https 页面
  // 直连局域网 ws://，实测构造即被拦截）——网页版按钮显示"联机:本地 · 探索中"，点击仅提示不切换。
  function refreshLanTargetRow() {
    const row = PPD.ui.lanTargetRow;
    const inp = PPD.ui.lanTargetInput;
    if (!row || !inp) return;
    if (PPD.isWebVersion) { PPD.show(row, false); return; } // 网页版本地联机探索中：不需要填对方地址
    // 本地模式 + 非本机时才需要"对方设备地址"（本机/局域网页面会自动推断，可不填）
    const show = !PPD.isLocalHost && !PPD.app.publicServer;
    PPD.show(row, show);
    // 局域网页面（http://本机IP:端口）：默认预填当前服务器地址（对方=房主这台电脑），可改
    if (show && !inp.value.trim() && location.protocol === 'http:' && /^\d{1,3}(\.\d{1,3}){3}/.test(location.hostname)) {
      inp.value = location.host;
    }
  }
  function refreshNetModeBtn() {
    if (!PPD.ui.btnNetMode) return;
    if (PPD.isWebVersion) {
      PPD.ui.btnNetMode.textContent = '联机:本地 · 探索中';
      PPD.ui.btnNetMode.title = '本地联机正在探索中，暂不对网页版开放；网页版默认公网联机';
      PPD.ui.btnNetMode.classList.add('exploring');
      PPD.show(PPD.ui.btnNetMode, true);
      refreshLanTargetRow();
      return;
    }
    PPD.ui.btnNetMode.classList.remove('exploring');
    PPD.ui.btnNetMode.title = '';
    PPD.show(PPD.ui.btnNetMode, true);
    PPD.ui.btnNetMode.textContent = PPD.app.publicServer ? '联机:公网' : '联机:本地';
    refreshLanTargetRow();
  }
  PPD.ui.btnNetMode.addEventListener('click', () => {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    if (PPD.isWebVersion) {
      PPD.setStatus('本地联机正在探索中，暂不对网页版开放；网页版默认公网联机。本地联机请用桌面版/安装包');
      return;
    }
    PPD.app.publicServer = !PPD.app.publicServer;
    refreshNetModeBtn();
    if (PPD.app.publicServer) {
      const addr = (PPD.app.publicServerUrl || '').trim();
      PPD.setStatus(addr ? `联机服务器：公网（自建 ${addr}）` : '联机服务器：公网（Cloudflare）');
    } else if (PPD.isLocalHost) {
      PPD.setStatus('联机服务器：本地（局域网）');
    } else {
      PPD.setStatus('联机服务器：本地（可填对方设备地址，或让对方直接打开 http://房主IP:8765）');
    }
  });
  // 公网联机服务器地址（设置面板）：可指向自建 ECS 等低延迟服务器（ws://IP:端口）。
  // 启动时从本地记忆恢复；改动即生效并记忆（下次联机公网直连该地址）。
  (function initPublicServerUrl() {
    try {
      const saved = localStorage.getItem('ppd_public_server');
      if (saved) PPD.app.publicServerUrl = saved;
    } catch (e) { /* ignore */ }
    const inp = PPD.ui.publicServerInput;
    if (inp) {
      inp.value = PPD.app.publicServerUrl || '';
      inp.addEventListener('change', () => {
        PPD.app.publicServerUrl = (inp.value || '').trim();
        try { localStorage.setItem('ppd_public_server', PPD.app.publicServerUrl); } catch (e) { /* ignore */ }
        PPD.setStatus(PPD.app.publicServerUrl ? `公网联机服务器：${PPD.app.publicServerUrl}` : '公网联机服务器：默认（Cloudflare）');
      });
    }
  })();
  // 网页版（https）默认公网：浏览器安全策略禁止 https 页面直连局域网 ws://（混合内容，实测构造即被拦截），
  // 网页版的"本地"仅作为输入/引导入口；本地联机请用桌面版或直接打开 http://房主IP:8765
  if (PPD.isWebVersion) {
    PPD.app.publicServer = true;
    PPD.setStatus('网页版联机：公网（本地联机正在探索中，暂不对网页版开放）');
  } else if (location.protocol === 'file:') {
    // 内置安卓版（APK 打包，file:// 页面无本机服务器）：默认公网联机，
    // 服务器地址在设置「公网联机服务器地址」配置（默认 Cloudflare，可填自建 ECS 低延迟地址）
    PPD.app.publicServer = true;
    PPD.setStatus('安卓版联机：公网（设置中可填自建服务器地址，默认 Cloudflare）');
  }
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

  // 画质切换（高/低）：写回记忆 + 立即生效（DPR、观众席缓存、低画质渲染开关）
  if (PPD.ui.quality) {
    PPD.ui.quality.addEventListener('change', () => {
      PPD.GameAudio.ui && PPD.GameAudio.ui();
      PPD.setQuality(PPD.ui.quality.value);
      PPD.setStatus(PPD.app.quality.low ? '画质：低（省电流畅）' : '画质：高');
    });
  }
  // 关闭环境观众（勾选框，默认关闭）：写回记忆 + 立即生效（清观众席缓存）
  if (PPD.ui.setNoCrowd) {
    PPD.ui.setNoCrowd.addEventListener('change', () => {
      PPD.GameAudio.ui && PPD.GameAudio.ui();
      PPD.setNoCrowd(PPD.ui.setNoCrowd.checked);
      PPD.setStatus(PPD.app.noCrowd ? '环境观众：关闭' : '环境观众：开启（高画质下生效）');
    });
  }
  // 帧率上限切换（30/45/60/无上限）：渲染门控即时生效（物理仍 120Hz）
  if (PPD.ui.frameRate) {
    PPD.ui.frameRate.addEventListener('change', () => {
      PPD.GameAudio.ui && PPD.GameAudio.ui();
      const v = PPD.ui.frameRate.value;
      PPD.setFrameRate(v === 'unlimited' ? 'unlimited' : parseInt(v, 10));
      PPD.setStatus('帧率上限：' + (PPD.app.quality.frameRate === 'unlimited' ? '无上限' : PPD.app.quality.frameRate));
    });
  }

  // 提示
  PPD.ui.tips.innerHTML = `
    国际赛事标准：球台 2.74×1.525m（高 0.76m）· 网高 0.1525m · 球 40mm / 2.7g · 拍面 15×15cm<br>
    规则：11 分制（10 平后净胜 2 分）· 每 2 分发球轮换 · 发球须先落本方再落对方半台 · 触网入界重发
  `;

  // 手机端：显示"下载安卓版"入口（APK 内置版 file:// 页面不显示，避免自下载）
  if (PPD.ui.btnDownloadApk && PPD.isTouch && location.protocol !== 'file:') {
    PPD.show(PPD.ui.btnDownloadApk, true);
    if (PPD.ui.apkHelpLink) PPD.show(PPD.ui.apkHelpLink, true); // 百度/微信等浏览器下载被拦时，引导到下载帮助页
  }

  // 主页滚动已改用浏览器原生滚动条（自定义右端滑动条已移除，见修改记录四十五）

  // ---------- 启动 ----------
  // 各难度下拉的地狱选项：按解锁状态全量同步（人机 + AI 观战主页/暂停面板）
  PPD.syncHellOptions();
  // 背景音乐：页面打开即播（浏览器自动播放策略拦截时，首次交互立即恢复出声）
  PPD.GameAudio.autoplayMusic();
  // 通关记录：进入主菜单时拉取后端并渲染（失败静默）
  if (PPD.refreshRecords) PPD.refreshRecords();
  // 解锁判定兜底：从持久化记录推导地狱解锁/通关（localStorage 被清也不会上锁）
  if (PPD.syncUnlocksFromRecords) PPD.syncUnlocksFromRecords();
  // 设置面板版本号（与 package.json / AndroidManifest 一致，单一来源 PPD.app.version）
  if (PPD.ui.appVersion) PPD.ui.appVersion.textContent = 'v' + (PPD.app.version || '');
  // 说明书胶囊按平台分流：手机端只显示手机内容，电脑端只显示电脑内容（data-platform=pc/mobile/both）
  // 测试桩 DOM 无 querySelectorAll 时跳过
  if (typeof document.querySelectorAll === 'function') {
    const isMobile = PPD.isTouch;
    const caps = document.querySelectorAll('.manual-capsule');
    for (let i = 0; i < caps.length; i++) {
      const el = caps[i];
      const p = el.getAttribute ? (el.getAttribute('data-platform') || 'both') : 'both';
      const show = p === 'both' || (p === 'mobile') === isMobile;
      if (!show) el.style.display = 'none';
    }
  }
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
  window.addEventListener('resize', () => { PPD.resize(); });
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
    saveRecord: PPD.saveRecord,
    fetchRecords: PPD.fetchRecords,
    // 地狱解锁（冒烟测试用）
    isHellUnlocked: PPD.isHellUnlocked,
    unlockHell: PPD.unlockHell,
    syncHellOptions: PPD.syncHellOptions,
    // 地狱通关（冒烟测试用）：人机击败地狱 → 解锁人机暂停的电脑 AI 数值调控
    isHellCleared: PPD.isHellCleared,
    markHellCleared: PPD.markHellCleared,
  };
})();
