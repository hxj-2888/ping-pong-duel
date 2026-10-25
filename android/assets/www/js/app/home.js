/* ============================================================
 * app/home.js — 场景化主页（P1 2026-10-24）
 * canvas 菜单场景之上的 DOM 浮层交互：
 *   模式状态机（右三通道选中，哨子开局，默认单机·当前难度）
 *   球员名字牌跟随（读 PPD.app.menuProj，由 renderMenuScene 每帧投影）
 *   球员编辑弹层（mode-aware：人机=难度 / 无尽=关卡 / 其余=改名换衣）
 *   球衣染色层（--me/--foe）、撞色互换、首访引导气泡、主页 toast 自动淡出
 * 数据契约不变：所有控件写回隐藏 <select>/input 宿主并派发 change，
 * 持久化与开局参数读取沿用 teams.js / modes.js 原逻辑，零第二配置源。
 * ============================================================ */
(function () {
  'use strict';
  const $ = PPD.$id;

  const el = {
    chip: $('homeChip'),
    plMe: $('plMe'), plFoe: $('plFoe'),
    tagMe: $('tagMe'), tagFoe: $('tagFoe'),
    tagMeName: $('tagMeName'), tagFoeName: $('tagFoeName'),
    whistle: $('btnWhistle'), whistleLabel: $('whistleLabel'),
    chLocal: $('chLocal'), chNet: $('chNet'), chEndless: $('chEndless'),
    hint: $('homeHint'),
    mask: $('homeMask'), sheetTitle: $('sheetTitle'),
    rowNameMe: $('rowNameMe'), rowNameFoe: $('rowNameFoe'),
    swatchMe: $('swatchMe'), swatchOpp: $('swatchOpp'),
    rowDiff: $('rowDiff'), rowEndless: $('rowEndless'), endlessList: $('homeEndlessList'),
    done: $('sheetDone'),
    toast: $('statusBar'),
    nameInput: PPD.ui ? PPD.ui.nameInput : $('nameInput'),
    teamOppName: $('teamOppName'),
    aiLevel: PPD.ui ? PPD.ui.aiLevel : $('aiLevel'),
    teamMe: $('teamMe'), teamOpp: $('teamOpp'),
  };
  // 关键元素缺失（极简宿主/测试桩）时整体跳过，不阻塞其余模块
  if (!el.chip || !el.whistle || !el.mask) return;

  const HINT_KEY = 'ppd_home_hint_seen';
  const ENDLESS_SEL_KEY = 'ppd_endless_home_level';
  const MODE_NAME = { ai: '单机对战', local: '本地对战', online: '联机对战', endless: '无尽挑战' };

  // ---------- 模式状态机：哨子按 mode 开局（默认 ai=人机·当前难度） ----------
  let mode = 'ai';
  let endlessSel = 1;

  function diffLabel() {
    const sel = el.aiLevel;
    if (!sel || !sel.options) return '中等';
    const opt = Array.prototype.slice.call(sel.options)
      .find((o) => String(o.value) === String(sel.value));
    return opt ? String(opt.textContent).replace(/（[^）]*）/g, '').replace(/🔒/g, '').trim() : '中等';
  }

  function refreshChip() {
    const extra = mode === 'ai' ? ' · ' + diffLabel()
      : mode === 'endless' ? ' · 无尽-' + endlessSel : '';
    el.chip.textContent = MODE_NAME[mode] + extra;
    [el.chLocal, el.chNet, el.chEndless].forEach((b) => {
      if (b && b.classList) b.classList.toggle('on', b.dataset ? b.dataset.mode === mode : false);
    });
    if (el.whistleLabel) el.whistleLabel.textContent = mode === 'online' ? '打开联机' : '吹哨开始';
  }

  function toast(msg) { if (PPD.setStatus) PPD.setStatus(msg); }

  function openNetDoor() {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    // 〔2026-10-25 通道门转场〕主页浮层滑走 → 联机卡片从右侧滑入（同一世界的门）
    const menuEl = PPD.ui.menu;
    if (menuEl && menuEl.classList) menuEl.classList.add('leaving');
    setTimeout(() => {
      PPD.show(PPD.ui.netPanel, true);
      PPD.show(menuEl, false);
      if (menuEl && menuEl.classList) menuEl.classList.remove('leaving');
      if (PPD.refreshNetModeBtn) PPD.refreshNetModeBtn();
      if (PPD.ui.serverLine) PPD.ui.serverLine.value = PPD.app.serverLine || 'auto';
      if (PPD.netMeasureLines) PPD.netMeasureLines();
    }, 240);
  }

  function refreshLocks() {
    if (el.chEndless && el.chEndless.classList) {
      const locked = !PPD.isHellCleared();
      el.chEndless.classList.toggle('locked', locked);
      // 锁定态悬停说明解锁条件（触屏点击本就有 toast 提示）
      if (el.chEndless.title !== undefined) {
        el.chEndless.title = locked ? '通关地狱模式解锁' : '';
      }
    }
  }

  function selectMode(m) {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    if (m === 'endless' && !PPD.isHellCleared()) {
      toast('通关地狱模式后解锁无尽挑战');
      return;
    }
    mode = m;
    refreshChip();
    if (m === 'online') openNetDoor(); // 通道门：点击直达联机框（双哨子准备为 P5）
  }

  [el.chLocal, el.chNet, el.chEndless].forEach((b) => {
    if (b) b.addEventListener('click', () => selectMode(b.dataset.mode));
  });

  el.whistle.addEventListener('click', () => {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    closeSheet();
    // 联机通道门：直达联机框（对局建立时由 startOnlineGame 播转场），不在此处套转场
    if (mode === 'online') { openNetDoor(); return; }
    // P2 拨开式转场：浮层退场 → 短黑屏 → 纸张从中缝拨开露出带观众的比赛画面
    PPD.cineTransition(() => {
      if (mode === 'local') { PPD.startLocal(); return; }
      if (mode === 'endless') {
        if (!PPD.isHellCleared()) { toast('通关地狱模式后解锁无尽挑战'); return; }
        PPD.startEndless(endlessSel);
        return;
      }
      PPD.startAI(); // 默认：单机对战 · 当前难度
    });
  });

  // ---------- 拨开式转场（P2）：黑屏 → 纸张从中缝向左右拨开 ----------
  // launch 在黑屏段（220ms）末尾执行——此刻切到对局画面（观众已在场景里），
  // 下一帧 .split 让两片黑幕左右滑开露出新画面；全程 <0.8s 无需跳过按钮。
  // 桩环境无 cineMask 时退化为直接执行 launch。
  let cineTimer1 = null, cineTimer2 = null;
  PPD.cineTransition = function (launch) {
    const mask = $('cineMask');
    const menuEl = PPD.ui.menu;
    if (!mask || !mask.classList) {
      if (typeof launch === 'function') launch();
      return;
    }
    if (PPD.GameAudio && PPD.GameAudio.shutter) PPD.GameAudio.shutter();
    clearTimeout(cineTimer1);
    clearTimeout(cineTimer2);
    mask.classList.remove('split');
    mask.classList.add('on', 'cover');
    if (menuEl && menuEl.classList) menuEl.classList.add('leaving');
    cineTimer1 = setTimeout(() => {
      if (typeof launch === 'function') launch();
      // 双 rAF 确保黑屏帧已绘制，再开始拨开（避免同帧跳变）
      const raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
      raf(() => raf(() => {
        mask.classList.add('split');
        cineTimer2 = setTimeout(() => {
          mask.classList.remove('on', 'cover', 'split');
          if (menuEl && menuEl.classList) menuEl.classList.remove('leaving');
        }, 560);
      }));
    }, 220);
  };

  // 难度变化 → chip 实时刷新（分段控件写回 select 后派发 change，同一数据源）
  if (el.aiLevel && el.aiLevel.addEventListener) el.aiLevel.addEventListener('change', refreshChip);

  // ---------- 无尽关卡选择（对方球员弹层内；默认已解锁最高，选择持久化） ----------
  function loadEndlessSel() {
    const unlocked = Math.max(1, PPD.getEndlessUnlocked ? PPD.getEndlessUnlocked() : 0);
    let v = 0;
    try { v = parseInt(localStorage.getItem(ENDLESS_SEL_KEY), 10) || 0; } catch (e) { /* ignore */ }
    endlessSel = v >= 1 ? Math.min(v, unlocked) : unlocked;
  }
  loadEndlessSel();

  function renderEndlessList() {
    if (!el.endlessList || typeof document.createElement !== 'function') return;
    const highest = PPD.getEndlessHighest ? PPD.getEndlessHighest() : 0;
    const unlocked = PPD.getEndlessUnlocked ? PPD.getEndlessUnlocked() : 0;
    const maxN = Math.max(1, highest + 1); // 可挑战 = 最高通关 + 1
    el.endlessList.innerHTML = ''; // 桩环境兼容（无 removeChild/firstChild）
    for (let n = 1; n <= maxN; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '无尽-' + n;
      const can = n === 1 || n <= unlocked;
      if (can && n === endlessSel) b.className = 'on';
      if (!can) { b.className = 'lock'; b.disabled = true; }
      else b.addEventListener('click', () => {
        endlessSel = n;
        try { localStorage.setItem(ENDLESS_SEL_KEY, String(n)); } catch (e) { /* ignore */ }
        PPD.GameAudio.ui();
        renderEndlessList();
        refreshChip();
      });
      el.endlessList.appendChild(b);
    }
  }

  // ---------- 球员编辑弹层（底部 sheet，控件即真实数据宿主） ----------
  let sheetTimer = null;
  function openSheet(who) {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    if (el.sheetTitle) el.sheetTitle.textContent = who === 'me' ? '我方球员' : '对方球员';
    // 〔2026-10-25 修复〕这些行带 hidden 属性：必须切属性而非 style.display——
    // 全局守卫 [hidden]{display:none!important} 会让 PPD.show 的 display 切换失效，
    // 对方弹层的名字框/球衣色块曾因此永远不可见（"无法改名/换衣"）。
    if (el.rowNameMe) el.rowNameMe.hidden = who !== 'me';
    if (el.rowNameFoe) el.rowNameFoe.hidden = who !== 'foe';
    if (el.swatchMe) el.swatchMe.hidden = who !== 'me';
    if (el.swatchOpp) el.swatchOpp.hidden = who !== 'foe';
    // mode-aware：难度只对人机的对方球员；无尽关卡只在无尽模式对方球员；本地/联机只有改名换衣
    if (el.rowDiff) el.rowDiff.hidden = !(who === 'foe' && mode === 'ai');
    if (el.rowEndless) el.rowEndless.hidden = !(who === 'foe' && mode === 'endless');
    if (who === 'foe' && mode === 'endless') renderEndlessList();
    clearTimeout(sheetTimer);
    el.mask.hidden = false;
    if (el.mask.classList) el.mask.classList.add('open');
  }
  function closeSheet() {
    if (!el.mask || el.mask.hidden) return;
    if (el.mask.classList) el.mask.classList.remove('open');
    clearTimeout(sheetTimer);
    sheetTimer = setTimeout(() => { el.mask.hidden = true; }, 220);
  }

  if (el.mask) {
    el.mask.addEventListener('click', (ev) => { if (ev.target === el.mask) closeSheet(); });
  }
  if (el.done) el.done.addEventListener('click', closeSheet);
  if (document && typeof document.addEventListener === 'function') {
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && el.mask && !el.mask.hidden
        && PPD.ui.menu && PPD.ui.menu.style.display !== 'none') {
        ev.stopPropagation();
        closeSheet();
      }
    });
  }
  function wirePlayer(node, who) {
    if (!node) return;
    node.addEventListener('click', () => openSheet(who));
    node.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openSheet(who); }
    });
  }
  wirePlayer(el.plMe, 'me');
  wirePlayer(el.plFoe, 'foe');
  // 名字牌已从热区拆出（独立定位）：点击 tag 同样打开编辑弹层
  wirePlayer(el.tagMe, 'me');
  wirePlayer(el.tagFoe, 'foe');

  // 撞色互换：捕获阶段先处理——目标色与另一槽位相同时，另一槽位让出（换成我方原色），
  // 随后 teams.js 的色块监听照常把当前槽位写成目标色；两侧持久化均由既有 change 流程完成
  function wireSwap(rowHost, mySel, otherSel) {
    if (!rowHost || !rowHost.addEventListener || !mySel || !otherSel) return;
    rowHost.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('.swatch') : null;
      if (!btn || !rowHost.children) return;
      const teams = (PPD.Teams && PPD.Teams.TEAMS) || [];
      const idx = Array.prototype.indexOf.call(rowHost.children, btn);
      const target = teams[idx];
      if (!target || target.id === mySel.value) return;
      if (otherSel.value === target.id) {
        otherSel.value = mySel.value;
        otherSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, true);
  }
  wireSwap(el.swatchMe, el.teamMe, el.teamOpp);
  wireSwap(el.swatchOpp, el.teamOpp, el.teamMe);

  // ---------- 名字牌跟随 + 球衣染色（loop 菜单分支在渲染后调用） ----------
  const TEAMS = () => (PPD.Teams && PPD.Teams.TEAMS) || [];
  function teamColor(sel) {
    const t = TEAMS().find((x) => x && x.id === (sel && sel.value));
    return t ? t.color : null;
  }
  // 〔2026-10-25〕名字牌与热区分开定位：
  //   tag  → 底边中心贴头顶投影（pr.x/pr.y），紧贴球员头顶不再悬空；
  //   热区 → 中心对准躯干投影（pr.bx/pr.by），罩住身体供点击。
  function placeTag(side, pr) {
    const player = side === 0 ? el.plMe : el.plFoe;
    const tag = side === 0 ? el.tagMe : el.tagFoe;
    if (!pr || typeof pr.x !== 'number' || !isFinite(pr.x)) return;
    const k = Math.max(0.5, Math.min(1.3, (pr.s || 110) / 130));
    if (player) {
      const w = Math.round(150 * k), h = Math.round(250 * k);
      player.style.width = w + 'px';
      player.style.height = h + 'px';
      player.style.transform = 'translate(' + Math.round(pr.bx - w / 2) + 'px,' + Math.round(pr.by - h * 0.52) + 'px)';
    }
    if (tag) tag.style.transform = 'translate(' + Math.round(pr.x) + 'px,' + Math.round(pr.y) + 'px) translate(-50%,-100%)';
  }
  function setTagColor(node, color) {
    if (!node || !node.querySelector) return;
    const dot = node.querySelector('.dot');
    if (dot && dot.style && dot.style.setProperty) {
      try { dot.style.setProperty('--tag-c', color || '#8fa3c8'); } catch (e) { /* 桩环境 */ }
    }
  }
  let tintLast = '';
  PPD.updateHomeTags = function () {
    if (!el.plMe || !el.plFoe) return;
    const pr = PPD.app && PPD.app.menuProj;
    if (pr) {
      placeTag(0, pr[0]);
      placeTag(1, pr[1]);
    }
    const meName = ((el.nameInput && el.nameInput.value) || '').trim() || '乒乓球手';
    // 对方名：无尽显示关卡名；其余显示用户自定义名；队名等于默认颜色名（未自定义）时回落「电脑」
    const typedFoe = ((el.teamOppName && el.teamOppName.value) || '').trim();
    const isDefaultColorName = TEAMS().some((x) => x && x.name === typedFoe);
    const foName = mode === 'endless' ? '无尽-' + endlessSel
      : (typedFoe && !isDefaultColorName ? typedFoe : '电脑');
    if (el.tagMeName && el.tagMeName.textContent !== meName) el.tagMeName.textContent = meName;
    if (el.tagFoeName && el.tagFoeName.textContent !== foName) el.tagFoeName.textContent = foName;
    setTagColor(el.tagMe, teamColor(el.teamMe));
    setTagColor(el.tagFoe, teamColor(el.teamOpp));
    // 球衣染色层：--me/--foe 写根元素（.home-tint 渐变引用；变化才写，避免每帧重绘）
    const meC = teamColor(el.teamMe) || '#d0321e';
    const foC = teamColor(el.teamOpp) || '#2563eb';
    const key = meC + foC;
    if (key !== tintLast && document.documentElement && document.documentElement.style) {
      tintLast = key;
      try {
        document.documentElement.style.setProperty('--me', meC);
        document.documentElement.style.setProperty('--foe', foC);
      } catch (e) { /* 桩环境 */ }
    }
  };

  // ---------- 主页 toast（#statusBar 的主页形态）：文字变化即亮起，2.6s 后自动淡出 ----------
  if (el.toast && typeof MutationObserver !== 'undefined') {
    let hideT = null;
    try {
      const mo = new MutationObserver(() => {
        if (!el.toast.textContent) return;
        if (el.toast.classList) el.toast.classList.add('show');
        clearTimeout(hideT);
        hideT = setTimeout(() => {
          if (el.toast.classList) el.toast.classList.remove('show');
        }, 2600);
      });
      mo.observe(el.toast, { childList: true });
    } catch (e) { /* 桩环境 */ }
  }

  // ---------- 首访引导气泡（一次性，localStorage 记忆） ----------
  (function firstHint() {
    if (!el.hint) return;
    let seen = false;
    try { seen = !!localStorage.getItem(HINT_KEY); } catch (e) { seen = false; }
    if (seen) return;
    const dismiss = () => {
      el.hint.hidden = true;
      try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* ignore */ }
    };
    el.hint.hidden = false;
    el.hint.addEventListener('click', dismiss);
    setTimeout(dismiss, 8000);
  })();

  // ---------- P3 AI对打·观看视角选择：选完即开局（看台边线机位 / 球员视角跟随甲/乙） ----------
  const aiw = {
    mask: $('aiWatchMask'), side: $('aiwSide'),
    fa: $('aiwFollowA'), fb: $('aiwFollowB'), cancel: $('aiwCancel'),
  };
  PPD.openAIWatchPicker = function () {
    if (!aiw.mask) return false;
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    clearTimeout(sheetTimer);
    aiw.mask.hidden = false;
    if (aiw.mask.classList) aiw.mask.classList.add('open');
    return true;
  };
  function closeAIW() {
    if (!aiw.mask || aiw.mask.hidden) return;
    if (aiw.mask.classList) aiw.mask.classList.remove('open');
    clearTimeout(sheetTimer);
    sheetTimer = setTimeout(() => { aiw.mask.hidden = true; }, 220);
  }
  function launchAIW(view, follow) {
    closeAIW();
    PPD.app.aiView = view;
    PPD.app.aiFollowSide = follow;
    // 甲乙难度 = 主页当前难度（已拍板：AI对打用主页当前敌我配置）
    if (PPD.ui.aiLevelA && PPD.ui.aiLevel) PPD.ui.aiLevelA.value = PPD.ui.aiLevel.value;
    if (PPD.ui.aiLevelB && PPD.ui.aiLevel) PPD.ui.aiLevelB.value = PPD.ui.aiLevel.value;
    PPD.cineTransition(() => PPD.startAIVsAI());
  }
  if (aiw.side) aiw.side.addEventListener('click', () => { PPD.GameAudio.ui(); launchAIW('side', 0); });
  if (aiw.fa) aiw.fa.addEventListener('click', () => { PPD.GameAudio.ui(); launchAIW('player', 0); });
  if (aiw.fb) aiw.fb.addEventListener('click', () => { PPD.GameAudio.ui(); launchAIW('player', 1); });
  if (aiw.cancel) aiw.cancel.addEventListener('click', closeAIW);
  if (aiw.mask) aiw.mask.addEventListener('click', (ev) => { if (ev.target === aiw.mask) closeAIW(); });

  // ---------- 初始化 ----------
  refreshLocks();
  refreshChip();
  // 通关状态可能随后端战绩拉取变化（refreshRecords → syncUnlocksFromRecords）：低频轮询同步锁态
  setInterval(() => { refreshLocks(); }, 4000);

  // 暴露给测试/调试（只读 + 受控操作）
  PPD.Home = {
    get mode() { return mode; },
    get endlessSel() { return endlessSel; },
    selectMode,
    openSheet,
    closeSheet,
    refreshChip,
    refreshLocks,
  };
})();
