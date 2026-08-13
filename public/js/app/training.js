/* ============================================================
 * app/training.js — 能力训练页（v2.0）：对战积分 + 能力训练 + 全部洗点
 * 通过共享对象 PPD 访问公共状态与接口。装扮(外观库存/装配/方案)已独立到 app/dressup.js。
 * - 积分：人机按难度(简单1/中等2/困难3/地狱5)+ 胜满负半；本地双人/联机固定 胜3/负1。
 * - 能力训练：移动速度/挥拍延迟/挥拍耗时/碰撞箱，各 5 级；仅本地/人机生效，不同步真人。
 * - 全部洗点：训练归 0 + 所有已购外观退款(调 dressup.refundAllCosmetics)，页面顶部按钮。
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

  // ---------- 积分 ----------
  function refreshPoints() {
    const s = '积分：' + (PPD.app.points || 0);
    if (PPD.ui.trainingPoints) PPD.ui.trainingPoints.textContent = s;
    if (PPD.ui.dressupPoints) PPD.ui.dressupPoints.textContent = s;
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
  // 真人对战(本地双人/联机):基础 1 分,胜者再加 1 → 负1胜2(v2.0 调整)
  function awardPvp(playerWin) {
    addPoints(playerWin ? 2 : 1);
  }

  // 首次击败困难/地狱一次性奖励(人机模式玩家获胜):困难 +50 / 地狱 +100,仅发一次。
  // 返回奖励文本供 hud.js 合并到页面中央结算提示;未触发返回 null
  const FIRST_CLEAR_BONUS = { 2: 50, 3: 100 };
  function awardBonus(aiLevel) {
    const bonus = FIRST_CLEAR_BONUS[aiLevel];
    if (!bonus) return null;
    const key = aiLevel === 2 ? 'hard' : 'hell';
    const b = PPD.app.bonus || {};
    if (b[key]) return null; // 已领过
    b[key] = true;
    PPD.app.bonus = b;
    if (PPD.saveBonus) PPD.saveBonus();
    addPoints(bonus);
    return aiLevel === 2 ? '🎉 首次击败困难!奖励 50 积分' : '🎉 首次击败地狱!奖励 100 积分';
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

  // 洗点：能力逐级降级，退回该级成本
  function downgrade(key) {
    const item = TRAINING_ITEMS.find((x) => x.key === key);
    if (!item) return;
    const lv = PPD.app.training[key] || 0;
    if (lv <= 0) return;
    const back = LEVEL_COST[lv - 1];
    PPD.app.training[key] = lv - 1;
    PPD.app.points += back;
    if (PPD.savePoints) PPD.savePoints();
    if (PPD.saveTraining) PPD.saveTraining();
    refreshPoints();
    renderTrainingPage();
    PPD.setStatus(item.name + ' 降级，退回 ' + back + ' 积分');
  }

  // 全部洗点:训练归 0 退回训练积分(装扮/外观积分不在训练页洗点,v2.0 已去掉)
  function resetAll() {
    let back = 0;
    for (const it of TRAINING_ITEMS) {
      const lv = PPD.app.training[it.key] || 0;
      for (let i = 0; i < lv; i++) back += LEVEL_COST[i];
      PPD.app.training[it.key] = 0;
    }
    if (back <= 0) { PPD.setStatus('当前没有可洗点的训练投入'); return; }
    PPD.app.points += back;
    if (PPD.savePoints) PPD.savePoints();
    if (PPD.saveTraining) PPD.saveTraining();
    refreshPoints();
    renderTrainingPage();
    PPD.setStatus('全部洗点完成，退回 ' + back + ' 积分');
  }

  // ---------- 面板渲染 ----------
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function renderTrainingPage() {
    if (!PPD.ui.trainingPanel) return;
    refreshPoints();
    const t = PPD.app.training;
    const trainHtml = TRAINING_ITEMS.map((it) => {
      const lv = t[it.key] || 0;
      const maxed = lv >= MAX_LEVEL;
      const cost = maxed ? null : LEVEL_COST[lv];
      const down = lv > 0
        ? '<button class="btn small" data-action="downgrade" data-key="' + it.key + '">降级(退' + LEVEL_COST[lv - 1] + ')</button>'
        : '';
      const up = maxed
        ? '<button class="btn small" disabled>已满级</button>'
        : '<button class="btn small" data-action="upgrade" data-key="' + it.key + '">升级 ' + cost + '</button>';
      return '<div class="t-item">' +
        '<div class="t-info"><b>' + esc(it.name) + '</b> <span class="t-lv">Lv.' + lv + '/' + MAX_LEVEL + '</span>' +
        '<div class="t-desc">每级 ' + it.per + ' · ' + esc(it.desc) + '</div></div>' +
        '<div class="t-btns">' + down + up + '</div>' +
        '</div>';
    }).join('');
    if (PPD.ui.trainingList) PPD.ui.trainingList.innerHTML = trainHtml;
  }

  function openTraining() {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    if (PPD.isWebVersion) {
      if (PPD.showOverlay) {
        PPD.showOverlay('能力训练 · 探索中',
          '能力训练网页版正在探索中，暂不对网页版开放。\n积分、能力训练与装扮仅保存在本地应用端（桌面版 / 手机 APK），不会上传到网页版后端。',
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

  // ---------- 事件绑定 ----------
  if (PPD.ui.btnTraining) {
    PPD.ui.btnTraining.addEventListener('click', () => { if (PPD.GameAudio) PPD.GameAudio.ensure(); openTraining(); });
  }
  if (PPD.ui.btnTrainingBack) {
    PPD.ui.btnTrainingBack.addEventListener('click', () => { if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui(); closeTraining(); });
  }
  if (PPD.ui.btnTrainingReset) {
    PPD.ui.btnTrainingReset.addEventListener('click', () => { if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui(); resetAll(); });
  }
  function onTrainingClick(e) {
    const el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) return;
    const a = el.getAttribute('data-action');
    if (a === 'upgrade') upgrade(el.getAttribute('data-key'));
    else if (a === 'downgrade') downgrade(el.getAttribute('data-key'));
  }
  if (PPD.ui.trainingList) PPD.ui.trainingList.addEventListener('click', onTrainingClick);

  // ---------- 导出 ----------
  PPD.addPoints = addPoints;
  PPD.awardAi = awardAi;
  PPD.awardPvp = awardPvp;
  PPD.awardBonus = awardBonus;
  PPD.applyTrainingToPlayer = applyTrainingToPlayer;
  PPD.openTraining = openTraining;
  PPD.closeTraining = closeTraining;
  PPD.renderTrainingPage = renderTrainingPage;
  PPD.refreshPoints = refreshPoints;
  PPD.resetAll = resetAll;
})();
