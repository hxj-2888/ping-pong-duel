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
  if (PPD.ui.btnEndless) {
    PPD.ui.btnEndless.addEventListener('click', () => {
      PPD.GameAudio.ensure();
      PPD.GameAudio.ui();
      openEndlessPanel();
    });
  }
  PPD.ui.btnAIVsAI.addEventListener('click', () => {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    PPD.startAIVsAI();
  });
  // ---------- 联机框（主页「联机对战」入口，等同新开页面） ----------
  if (PPD.ui.btnNetEntry) {
    PPD.ui.btnNetEntry.addEventListener('click', () => {
      PPD.GameAudio.ensure();
      PPD.GameAudio.ui();
      PPD.show(PPD.ui.netPanel, true);
      refreshNetModeBtn(); // 打开时同步 本地/公网 按钮、⚠ 与 IP 输入行状态
      // v2.5:打开联机框时同步线路选择（线路一 Cloudflare / 线路二 ECS）
      if (PPD.ui.serverLine) PPD.ui.serverLine.value = PPD.app.serverLine || 'auto';
    });
  }
  function closeNetPanel() {
    PPD.show(PPD.ui.netWait, false);
    PPD.show(PPD.ui.netPanel, false);
    PPD.show(PPD.ui.netOperate, true); // 恢复操作区（下次建房/加入可再操作）
    PPD.show(PPD.ui.menu, true); // 联机框等同新开页面：关闭后恢复主菜单
    // 审计 #4/#5:退出联机 → 递增会话 token(本连接在途消息回调全部作废)+ 清理会话定时器。
    // 不递增 token 的话,陈旧 joinTimer 会在 12s/6s 后触发 net.connect() 复活已关闭连接
    // (后台建幽灵房间),看门狗/心跳定时器也空转不清理。
    PPD.app.netSessionToken = (PPD.app.netSessionToken || 0) + 1;
    if (PPD.app.net) PPD.app.net.close(); // 未入对局就离开联机框：断开连接
    PPD.app.roomCode = '';
    PPD.app.reconnecting = false;
    PPD.app.reconnectAttempt = 0;
    PPD.app.reconnectStartedAt = 0;
    if (PPD.app.joinTimer) { clearTimeout(PPD.app.joinTimer); PPD.app.joinTimer = null; }
    if (PPD.app.watchdogTimer) { clearInterval(PPD.app.watchdogTimer); PPD.app.watchdogTimer = null; }
    if (PPD.app.heartbeatTimer) { clearInterval(PPD.app.heartbeatTimer); PPD.app.heartbeatTimer = null; }
  }
  PPD.closeNetPanel = closeNetPanel;
  // ---------- 无尽人机：主页入口 / 关卡页 / AI 观战动态选项 ----------
  function refreshAIEntries() {
    if (!PPD.ui.btnAI) return;
    if (PPD.isHellCleared()) {
      PPD.ui.btnAI.textContent = '常规单机';
      if (PPD.ui.btnEndless) PPD.show(PPD.ui.btnEndless, true);
    } else {
      PPD.ui.btnAI.textContent = '人机对战（单机）';
      if (PPD.ui.btnEndless) PPD.show(PPD.ui.btnEndless, false);
    }
  }

  function syncEndlessAIOptions() {
    const hell = PPD.isHellCleared();
    const unlocked = PPD.getEndlessUnlocked ? PPD.getEndlessUnlocked() : 0;
    const selects = [PPD.ui.aiLevelA, PPD.ui.aiLevelB, PPD.ui.pauseAiLevelA, PPD.ui.pauseAiLevelB];
    for (const sel of selects) {
      if (!sel || !sel.options) continue;
      for (let i = sel.options.length - 1; i >= 0; i--) {
        if (sel.options[i].getAttribute && sel.options[i].getAttribute('data-endless')) sel.remove(i);
      }
      if (!hell) continue;
      const maxN = Math.max(1, unlocked);
      for (let n = 1; n <= maxN; n++) {
        const opt = document.createElement('option');
        opt.value = 'inf-' + n;
        opt.textContent = '无尽-' + n;
        opt.setAttribute('data-endless', '1');
        sel.appendChild(opt);
      }
      if (sel.value && sel.value.indexOf('inf-') === 0) {
        const n = parseInt(sel.value.slice(4), 10) || 1;
        if (n > unlocked && n !== 1) sel.value = 'inf-1';
      }
    }
  }

  function renderEndlessPanel() {
    const list = PPD.ui.endlessList;
    if (!list) return;
    const highest = PPD.getEndlessHighest ? PPD.getEndlessHighest() : 0;
    const maxLevel = highest + 1;
    const parts = [];
    for (let n = 1; n <= maxLevel; n++) {
      parts.push(`<button type="button" class="btn endless-level" data-level="${n}">无尽-${n} 挑战</button>`);
    }
    list.innerHTML = parts.length
      ? parts.join('')
      : '<div class="career-empty">请先通关地狱模式解锁无尽人机</div>';
  }

  function openEndlessPanel() {
    if (!PPD.isHellCleared()) {
      PPD.setStatus('请先通关地狱模式');
      return;
    }
    renderEndlessPanel();
    PPD.show(PPD.ui.endlessPanel, true);
    PPD.show(PPD.ui.menu, false);
    PPD.show(PPD.ui.netPanel, false);
    PPD.show(PPD.ui.netWait, false);
  }

  function closeEndlessPanel() {
    PPD.show(PPD.ui.endlessPanel, false);
    PPD.show(PPD.ui.menu, true);
  }

  if (PPD.ui.endlessList) {
    PPD.ui.endlessList.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.endless-level') : null;
      if (btn && btn.dataset && btn.dataset.level) {
        if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui();
        PPD.startEndless(parseInt(btn.dataset.level, 10) || 1);
      }
    });
  }
  if (PPD.ui.btnEndlessBack) {
    PPD.ui.btnEndlessBack.addEventListener('click', () => {
      if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui();
      closeEndlessPanel();
    });
  }
  PPD.refreshAIEntries = refreshAIEntries;
  PPD.syncEndlessAIOptions = syncEndlessAIOptions;
  PPD.openEndlessPanel = openEndlessPanel;
  PPD.closeEndlessPanel = closeEndlessPanel;

  if (PPD.ui.btnNetBack) {
    PPD.ui.btnNetBack.addEventListener('click', () => {
      PPD.GameAudio.ensure();
      PPD.GameAudio.ui();
      closeNetPanel();
    });
  }
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
    // 本地模式下显示"对方设备地址"输入行（需求 9：切本地模式后面板下方自动弹出，支持 IP+房间码加入）
    const show = !PPD.app.publicServer;
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
      PPD.show(PPD.ui.btnNetWarn, false); // 网页版固定公网：无切换，不显示 ⚠ 说明按钮
      refreshLanTargetRow();
      return;
    }
    PPD.ui.btnNetMode.classList.remove('exploring');
    PPD.ui.btnNetMode.title = '';
    PPD.show(PPD.ui.btnNetMode, true);
    PPD.ui.btnNetMode.textContent = PPD.app.publicServer ? '联机:公网' : '联机:本地';
    // 公网感叹号提示（需求 19）：公网模式显示，点击展开说明、再点收回
    PPD.show(PPD.ui.btnNetWarn, PPD.app.publicServer);
    if (!PPD.app.publicServer) PPD.show(PPD.ui.netWarnNote, false);
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
      PPD.setStatus('联机服务器：公网（Cloudflare）');
    } else if (PPD.isLocalHost) {
      PPD.setStatus('联机服务器：本地（局域网）');
    } else {
      PPD.setStatus('联机服务器：本地（可填对方设备地址，或让对方直接打开 http://房主IP:8765）');
    }
  });
  // 公网 ⚠ 感叹号：点击展开「玩家量过大将导致服务器负载卡顿」说明，再次点击收回
  if (PPD.ui.btnNetWarn) {
    PPD.ui.btnNetWarn.addEventListener('click', () => {
      PPD.GameAudio.ui();
      PPD.show(PPD.ui.netWarnNote, PPD.ui.netWarnNote.style.display === 'none');
    });
  }
  // 网页版（https）默认公网：浏览器安全策略禁止 https 页面直连局域网 ws://（混合内容，实测构造即被拦截），
  // 网页版的"本地"仅作为输入/引导入口；本地联机请用桌面版或直接打开 http://房主IP:8765
  if (PPD.isWebVersion) {
    PPD.app.publicServer = true;
    PPD.setStatus('网页版联机：公网（本地联机正在探索中，暂不对网页版开放）');
  } else if (location.protocol === 'file:') {
    // 内置安卓版（APK 打包，file:// 页面无本机服务器）：默认公网联机（Cloudflare）
    PPD.app.publicServer = true;
    PPD.setStatus('安卓版联机：公网（Cloudflare）');
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
  // 需求 10：点击设置全局视为游戏暂停（手机/电脑通用）。对局中打开设置 → paused=true
  // 冻结本地引擎推进与渲染（联机模式服务端继续推进，恢复时快照自动锚定）；关闭设置恢复。
  function openSettings() {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    if (PPD.ui.setShowHitRanges) PPD.ui.setShowHitRanges.checked = PPD.app.showHitRanges;
    // v2.4：判定范围虚线需通关困难解锁——打开设置时同步勾选框禁用态
    if (PPD.syncHitRangeToggle) PPD.syncHitRangeToggle();
    if (PPD.ui.setMusic) PPD.ui.setMusic.checked = PPD.GameAudio.isMusicOn();
    if (PPD.ui.setSound) PPD.ui.setSound.checked = !PPD.GameAudio.isMuted();
    syncVolSlider(PPD.ui.setMusicVol, PPD.GameAudio.getMusicVol());
    syncVolSlider(PPD.ui.setSfxVol, PPD.GameAudio.getSfxVol());
    // v2.5:打开设置时同步联机线路选择（与联机对战面板共用）
    if (PPD.ui.serverLine) PPD.ui.serverLine.value = PPD.app.serverLine || 'auto';
    // 对局中（mode 非空）：设置面板即暂停界面，不叠加暂停面板
    if (PPD.app.mode) {
      PPD.app.settingsPause = true;
      PPD.app.paused = true;
      PPD.show(PPD.ui.pausePanel, false);
      PPD.updateGameTools();
    }
    PPD.show(PPD.ui.settingsPanel, true);
  }
  // v2.5:联机服务器线路切换（联机对战面板/设置面板内选择，localStorage 记忆；下次建房/加入生效）
  if (PPD.ui.serverLine) {
    PPD.ui.serverLine.addEventListener('change', () => {
      PPD.GameAudio.ui();
      PPD.app.serverLine = PPD.ui.serverLine.value;
      try { localStorage.setItem('ppd_server_line', PPD.app.serverLine); } catch (e) { /* ignore */ }
      const lineName = PPD.app.serverLine === 'ecs' ? '线路二 · ECS' :
        PPD.app.serverLine === 'cloudflare' ? '线路一 · Cloudflare' : '自动';
      PPD.setStatus('联机线路：' + lineName + '（下次创建/加入房间生效）');
    });
  }
  function closeSettings() {
    PPD.show(PPD.ui.settingsPanel, false);
    if (PPD.app.settingsPause) {
      PPD.app.settingsPause = false;
      PPD.app.paused = false;
      PPD.GameAudio.ensure();
      PPD.updateGameTools();
    }
  }
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

  // 画质切换（高/低）：写回记忆 + 立即生效（DPR、观众席缓存、低画质渲染开关）
  if (PPD.ui.quality) {
    PPD.ui.quality.addEventListener('change', () => {
      PPD.GameAudio.ui && PPD.GameAudio.ui();
      PPD.setQuality(PPD.ui.quality.value);
      const qn = PPD.app.quality.mode === 'low' ? '低（省电流畅）' : PPD.app.quality.mode === 'medium' ? '中（平衡）' : '高';
      PPD.setStatus('画质：' + qn);
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

  // 主页通用说明已全部移除（v1.6 需求 16）：国际赛事标准与全部操作规则统一收纳进独立说明书页；
  // 比赛页仅在比分栏下方保留一行简易操作说明（见 modes.js 各 start* 的 hintBar 文案）

  // 手机端：显示"下载安卓版"入口（APK 内置版 file:// 页面不显示，避免自下载）
  if (PPD.ui.btnDownloadApk && PPD.isTouch && location.protocol !== 'file:') {
    PPD.show(PPD.ui.btnDownloadApk, true);
    if (PPD.ui.apkHelpLink) PPD.show(PPD.ui.apkHelpLink, true); // 百度/微信等浏览器下载被拦时，引导到下载帮助页
  }

  // 手机端：隐藏「本地双人（分屏）」入口（v1.6 取消手机分屏作战，需求 11；电脑端本地双人保留）
  if (PPD.ui.btnLocal && PPD.isTouch) PPD.show(PPD.ui.btnLocal, false);

  // ---------- 说明书（独立全屏页面，等同新开页面；主页通用说明已全部移除） ----------
  // 平台分流：打开时按设备过滤胶囊（data-platform=pc/mobile/both）
  function filterManualCapsules() {
    if (!PPD.ui.manualPanel || typeof PPD.ui.manualPanel.querySelectorAll !== 'function') return;
    const isMobile = PPD.isTouch;
    const caps = PPD.ui.manualPanel.querySelectorAll('.manual-capsule');
    for (let i = 0; i < caps.length; i++) {
      const el = caps[i];
      const p = el.getAttribute ? (el.getAttribute('data-platform') || 'both') : 'both';
      el.style.display = (p === 'both' || (p === 'mobile') === isMobile) ? '' : 'none';
    }
  }
  function openManual() {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    filterManualCapsules();
    // 对局中打开说明书：视为暂停（与设置一致），关闭恢复
    if (PPD.app.mode) {
      PPD.app.manualPause = true;
      PPD.app.paused = true;
      PPD.show(PPD.ui.pausePanel, false);
      PPD.updateGameTools();
    }
    // v1.6.1：真正页面切换——从主菜单打开时隐藏主菜单（不叠加游戏界面）；滑钮按内容溢出自动显示
    PPD.app._manualFromMenu = !!(PPD.ui.menu && PPD.ui.menu.style.display !== 'none');
    if (PPD.app._manualFromMenu) PPD.show(PPD.ui.menu, false);
    PPD.show(PPD.ui.manualPanel, true);
    if (PPD.updateManualScrollbar) requestAnimationFrame(PPD.updateManualScrollbar);
  }
  function closeManual() {
    PPD.show(PPD.ui.manualPanel, false);
    if (PPD.ui.manualScrollbar) PPD.show(PPD.ui.manualScrollbar, false);
    if (PPD.app._manualFromMenu) { PPD.app._manualFromMenu = false; PPD.show(PPD.ui.menu, true); }
    if (PPD.app.manualPause) {
      PPD.app.manualPause = false;
      PPD.app.paused = false;
      PPD.GameAudio.ensure();
      PPD.updateGameTools();
    }
  }
  PPD.openManual = openManual;
  PPD.closeManual = closeManual;
  // 说明书按钮：设置在设置按钮正下方、同尺寸（电脑端 + 手机端主页统一；v1.6.2 手机端入口移入主页设置下方）
  if (PPD.ui.btnManualMenu) {
    PPD.show(PPD.ui.btnManualMenu, true);
    PPD.ui.btnManualMenu.addEventListener('click', openManual);
  }
  if (PPD.ui.btnManualBack) {
    PPD.ui.btnManualBack.addEventListener('click', () => { PPD.GameAudio.ui(); closeManual(); });
  }

  // 说明书滑钮（v1.6.2，双端通用）：内容溢出整页时自动弹出，拖动↔整页滚动双向同步
  function updateManualScrollbar() {
    const bar = PPD.ui.manualScrollbar, thumb = PPD.ui.manualScrollThumb, sc = PPD.ui.manualPanel;
    if (!bar || !thumb || !sc) return;
    const overflow = sc.scrollHeight > sc.clientHeight + 2;
    PPD.show(bar, overflow); // 内容溢出才显示滑钮（不再仅限手机端）
    if (!overflow) { thumb.style.height = '0px'; thumb.style.top = '0px'; return; }
    const max = Math.max(1, sc.scrollHeight - sc.clientHeight);
    const ratio = sc.clientHeight / Math.max(1, sc.scrollHeight);
    thumb.style.height = Math.max(24, Math.round(bar.clientHeight * ratio)) + 'px';
    thumb.style.top = (sc.scrollTop / max) * Math.max(0, bar.clientHeight - thumb.offsetHeight) + 'px';
  }
  function wireManualScrollbar() {
    const bar = PPD.ui.manualScrollbar, thumb = PPD.ui.manualScrollThumb, sc = PPD.ui.manualPanel;
    if (!bar || !thumb || !sc) return;
    const setFromY = (y) => {
      const max = Math.max(1, sc.scrollHeight - sc.clientHeight);
      sc.scrollTop = (y / bar.clientHeight) * max;
      updateManualScrollbar();
    };
    bar.addEventListener('pointerdown', (e) => {
      if (e.target === thumb) return; // 滑钮拖动单独处理
      e.preventDefault();
      setFromY(e.clientY - bar.getBoundingClientRect().top);
      const move = (ev) => setFromY(ev.clientY - bar.getBoundingClientRect().top);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    thumb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startTop = sc.scrollTop;
      const move = (ev) => {
        const max = Math.max(1, sc.scrollHeight - sc.clientHeight);
        sc.scrollTop = startTop + ((ev.clientY - startY) / bar.clientHeight) * max;
        updateManualScrollbar();
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    sc.addEventListener('scroll', updateManualScrollbar);
    // 胶囊展开/收起（toggle 事件不冒泡 → 用捕获阶段）→ 实时刷新滑钮：溢出自动弹出、收起自动隐藏
    sc.addEventListener('toggle', updateManualScrollbar, true);
    window.addEventListener('resize', updateManualScrollbar);
  }
  PPD.updateManualScrollbar = updateManualScrollbar;
  wireManualScrollbar();

  // 主页滚动已改用浏览器原生滚动条（自定义右端滑动条已移除，见修改记录四十五）

  // ---------- 启动 ----------
  // 各难度下拉的地狱选项：按解锁状态全量同步（人机 + AI 观战主页/暂停面板）
  PPD.syncHellOptions();
  if (PPD.syncHitRangeToggle) PPD.syncHitRangeToggle(); // v2.4：判定范围虚线解锁态同步（设置面板勾选框禁用）
  PPD.syncEndlessAIOptions();
  PPD.refreshAIEntries();
  // 背景音乐：页面打开即播（浏览器自动播放策略拦截时，首次交互立即恢复出声）
  PPD.GameAudio.autoplayMusic();
  // 通关记录：进入主菜单时拉取后端并渲染（失败静默）
  if (PPD.refreshRecords) PPD.refreshRecords();
  // 养成系统：进入主菜单时刷新积分余额（网页版自动隐藏，v1.8.0）
  if (PPD.refreshPoints) PPD.refreshPoints();
  // 解锁判定兜底：从持久化记录推导地狱解锁/通关（localStorage 被清也不会上锁）
  if (PPD.syncUnlocksFromRecords) PPD.syncUnlocksFromRecords();
  // 设置面板版本号（与 package.json / AndroidManifest 一致，单一来源 PPD.app.version）
  if (PPD.ui.appVersion) PPD.ui.appVersion.textContent = 'v' + (PPD.app.version || '');
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
    Replay: PPD.Replay,
    // 地狱解锁（冒烟测试用）
    isHellUnlocked: PPD.isHellUnlocked,
    unlockHell: PPD.unlockHell,
    syncHellOptions: PPD.syncHellOptions,
    // 地狱通关（冒烟测试用）：人机击败地狱 → 解锁人机暂停的电脑 AI 数值调控
    isHellCleared: PPD.isHellCleared,
    markHellCleared: PPD.markHellCleared,
    getEndlessHighest: PPD.getEndlessHighest,
    getEndlessUnlocked: PPD.getEndlessUnlocked,
    advanceEndless: PPD.advanceEndless,
    resetEndless: PPD.resetEndless,
    syncEndlessAIOptions: PPD.syncEndlessAIOptions,
  };
})();
