/* ============================================================
 * app/training.js — 养成系统（v1.8.0）：对战积分 + 能力训练 + 特效兑换
 * 通过共享对象 PPD 访问公共状态与接口。
 * - 积分：人机按难度(简单1/中等2/困难3/地狱5)+ 胜满负半；本地双人/联机固定 胜3/负1。
 * - 能力训练：移动速度/挥拍延迟/挥拍耗时/碰撞箱，各 5 级；仅本地/人机生效，不同步真人。
 * - 特效兑换：尾影(黄/黑/红)、球拍外观、撞击溅射(替换波纹)，纯本地渲染。
 * - 网页版禁用（跟随个人生涯：数据只留本地应用端）。
 * ============================================================ */
(function () {
  'use strict';

  const AI_DIFF_POINTS = [1, 2, 3, 5];     // 简单/中等/困难/地狱
  const LEVEL_COST = [10, 20, 35, 55, 80]; // 能力训练每级成本（1→2→3→4→5 级）
  const MAX_LEVEL = 5;

  const TRAINING_ITEMS = [
    { key: 'speed', name: '移动速度', per: '+4%', desc: '提升横向移动速度' },
    { key: 'windup', name: '挥拍延迟', per: '-10%', desc: '减少起拍蓄力延迟' },
    { key: 'dur', name: '挥拍耗时', per: '-6%', desc: '缩短挥拍总耗时' },
    { key: 'hitbox', name: '碰撞箱', per: '+3%', desc: '扩大接球判定范围' },
  ];
  const TRAILS = [
    { id: 'yellow', name: '尾影·黄', cost: 30 },
    { id: 'black', name: '尾影·黑', cost: 50 },
    { id: 'red', name: '尾影·红', cost: 80 },
  ];
  const PADDLES = [
    { id: 'skinA', name: '球拍·流光蓝', cost: 20 },
    { id: 'skinB', name: '球拍·翡翠绿', cost: 40 },
    { id: 'skinC', name: '球拍·炫彩金', cost: 60 },
  ];
  const SPLASH_COST = 50;

  // ---------- 积分 ----------
  function refreshPoints() {
    const s = '积分：' + (PPD.app.points || 0);
    if (PPD.ui.trainingPoints) PPD.ui.trainingPoints.textContent = s;
    if (PPD.ui.menuPoints) {
      if (PPD.isWebVersion) { PPD.show(PPD.ui.menuPoints, false); } // 网页版禁用养成：不显示积分
      else { PPD.ui.menuPoints.textContent = s; PPD.show(PPD.ui.menuPoints, true); }
    }
  }

  function addPoints(n) {
    if (PPD.isWebVersion) return; // 网页版禁用养成
    if (!Number.isFinite(n) || n <= 0) return;
    PPD.app.points += n;
    if (PPD.savePoints) PPD.savePoints();
    refreshPoints();
  }

  // 人机结算：按难度 + 胜满负半（e.s===0 表示玩家视角胜）
  function awardAi(difficulty, playerWin) {
    const base = AI_DIFF_POINTS[difficulty] || 1;
    addPoints(playerWin ? base : Math.floor(base / 2));
  }
  // 本地双人 / 联机固定分
  function awardPvp(playerWin) {
    addPoints(playerWin ? 3 : 1);
  }

  // ---------- 能力训练（写进引擎玩家对象；仅本地/人机调用） ----------
  function applyTrainingToPlayer(player) {
    if (!player) return;
    player.ability = {
      speed: PPD.app.training.speed || 0,
      windup: PPD.app.training.windup || 0,
      dur: PPD.app.training.dur || 0,
      hitbox: PPD.app.training.hitbox || 0,
    };
  }

  function upgrade(key) {
    const item = TRAINING_ITEMS.find((x) => x.key === key);
    if (!item) return;
    const lv = PPD.app.training[key] || 0;
    if (lv >= MAX_LEVEL) return;
    const cost = LEVEL_COST[lv];
    if (PPD.app.points < cost) { PPD.setStatus('积分不足，无法升级'); return; }
    PPD.app.points -= cost;
    PPD.app.training[key] = lv + 1;
    if (PPD.savePoints) PPD.savePoints();
    if (PPD.saveTraining) PPD.saveTraining();
    refreshPoints();
    renderTrainingPage();
    PPD.setStatus(item.name + ' 升到 ' + (lv + 1) + ' 级');
  }

  // ---------- 兑换 / 装备 ----------
  function buy(type, id, cost) {
    if (PPD.app.points < cost) { PPD.setStatus('积分不足，无法兑换'); return; }
    PPD.app.points -= cost;
    if (PPD.savePoints) PPD.savePoints();
    if (type === 'trail') { PPD.app.cosmetics.trail = id; }
    else if (type === 'paddle') { PPD.app.cosmetics.paddle = id; }
    if (PPD.saveCosmetics) PPD.saveCosmetics();
    refreshPoints();
    renderTrainingPage();
    PPD.setStatus('已兑换并装备');
  }
  function equip(type, id) {
    if (type === 'trail') { PPD.app.cosmetics.trail = id; }
    else if (type === 'paddle') { PPD.app.cosmetics.paddle = id; }
    if (PPD.saveCosmetics) PPD.saveCosmetics();
    renderTrainingPage();
    PPD.setStatus('已装备');
  }
  function buySplash() {
    if (PPD.app.points < SPLASH_COST) { PPD.setStatus('积分不足，无法兑换'); return; }
    PPD.app.points -= SPLASH_COST;
    PPD.app.cosmetics.splash = true;
    if (PPD.savePoints) PPD.savePoints();
    if (PPD.saveCosmetics) PPD.saveCosmetics();
    refreshPoints();
    renderTrainingPage();
    PPD.setStatus('已兑换撞击溅射（替换波纹反馈）');
  }
  function toggleSplash() {
    PPD.app.cosmetics.splash = !PPD.app.cosmetics.splash;
    if (PPD.saveCosmetics) PPD.saveCosmetics();
    renderTrainingPage();
    PPD.setStatus(PPD.app.cosmetics.splash ? '撞击溅射：开' : '撞击溅射：关（恢复波纹）');
  }

  // ---------- 面板渲染 ----------
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function renderTrainingPage() {
    if (!PPD.ui.trainingPanel) return;
    refreshPoints();
    // 能力训练区
    const t = PPD.app.training;
    const trainHtml = TRAINING_ITEMS.map((it) => {
      const lv = t[it.key] || 0;
      const maxed = lv >= MAX_LEVEL;
      const cost = maxed ? null : LEVEL_COST[lv];
      const btn = maxed
        ? '<button class="btn small" disabled>已满级</button>'
        : '<button class="btn small" data-action="upgrade" data-key="' + it.key + '">升级 ' + cost + ' 积分</button>';
      return '<div class="t-item">' +
        '<div class="t-info"><b>' + esc(it.name) + '</b> <span class="t-lv">Lv.' + lv + '/' + MAX_LEVEL + '</span>' +
        '<div class="t-desc">每级 ' + it.per + ' · ' + esc(it.desc) + '</div></div>' + btn +
        '</div>';
    }).join('');
    if (PPD.ui.trainingList) PPD.ui.trainingList.innerHTML = trainHtml;

    // 特效兑换区
    const c = PPD.app.cosmetics;
    const trailHtml = TRAILS.map((x) => {
      const owned = c.trail === x.id; // 拥有即已装备（尾影单选，直接兑换+装备）
      const btn = owned
        ? '<span class="t-owned">已装备</span>'
        : '<button class="btn small" data-action="buy" data-type="trail" data-id="' + x.id + '" data-cost="' + x.cost + '">兑换 ' + x.cost + '</button>';
      return '<div class="s-item"><span>' + esc(x.name) + '</span>' + btn + '</div>';
    }).join('');
    const paddleHtml = PADDLES.map((x) => {
      const owned = c.paddle === x.id;
      const btn = owned
        ? '<span class="t-owned">已装备</span>'
        : '<button class="btn small" data-action="buy" data-type="paddle" data-id="' + x.id + '" data-cost="' + x.cost + '">兑换 ' + x.cost + '</button>';
      return '<div class="s-item"><span>' + esc(x.name) + '</span>' + btn + '</div>';
    }).join('');
    const splashBtn = c.splash
      ? '<button class="btn small" data-action="splash-toggle">' + (c.splash ? '已开启（点按关闭）' : '已兑换（点按开启）') + '</button>'
      : '<button class="btn small" data-action="splash-buy">兑换 ' + SPLASH_COST + '</button>';
    const splashHtml = '<div class="s-item"><span>撞击溅射（替换波纹反馈）</span>' + splashBtn + '</div>';
    if (PPD.ui.shopList) PPD.ui.shopList.innerHTML =
      '<h3>尾影特效</h3>' + trailHtml +
      '<h3>球拍外观</h3>' + paddleHtml +
      '<h3>球台撞击特效</h3>' + splashHtml;
  }

  function openTraining() {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    // 网页版禁用：跟随个人生涯，数据只留本地应用端
    if (PPD.isWebVersion) {
      if (PPD.showOverlay) {
        PPD.showOverlay('养成系统 · 探索中',
          '养成系统网页版正在探索中，暂不对网页版开放。\n积分、能力训练与特效兑换仅保存在本地应用端（桌面版 / 手机 APK），不会上传到网页版后端。',
          '知道了', () => {});
      }
      return;
    }
    if (PPD.ui.trainingPanel) PPD.show(PPD.ui.trainingPanel, true);
    if (PPD.ui.menu) PPD.show(PPD.ui.menu, false);
    renderTrainingPage();
  }
  function closeTraining() {
    if (PPD.ui.trainingPanel) PPD.show(PPD.ui.trainingPanel, false);
    if (PPD.ui.menu) PPD.show(PPD.ui.menu, true);
    refreshPoints();
  }

  // ---------- 事件绑定（入口按钮 + 面板内事件委托） ----------
  if (PPD.ui.btnTraining) {
    PPD.ui.btnTraining.addEventListener('click', () => { if (PPD.GameAudio) PPD.GameAudio.ensure(); openTraining(); });
  }
  if (PPD.ui.btnTrainingBack) {
    PPD.ui.btnTrainingBack.addEventListener('click', () => { if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui(); closeTraining(); });
  }
  function onPanelClick(e) {
    const el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) return;
    const a = el.getAttribute('data-action');
    if (a === 'upgrade') upgrade(el.getAttribute('data-key'));
    else if (a === 'buy') buy(el.getAttribute('data-type'), el.getAttribute('data-id'), parseInt(el.getAttribute('data-cost'), 10) || 0);
    else if (a === 'splash-buy') buySplash();
    else if (a === 'splash-toggle') toggleSplash();
  }
  if (PPD.ui.trainingList) PPD.ui.trainingList.addEventListener('click', onPanelClick);
  if (PPD.ui.shopList) PPD.ui.shopList.addEventListener('click', onPanelClick);

  // ---------- 导出 ----------
  PPD.addPoints = addPoints;
  PPD.awardAi = awardAi;
  PPD.awardPvp = awardPvp;
  PPD.applyTrainingToPlayer = applyTrainingToPlayer;
  PPD.openTraining = openTraining;
  PPD.closeTraining = closeTraining;
  PPD.renderTrainingPage = renderTrainingPage;
  PPD.refreshPoints = refreshPoints;
})();
