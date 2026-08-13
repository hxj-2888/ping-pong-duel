/* ============================================================
 * app/dressup.js — 装扮系统页（v2.0）：外观库存/装配卸下/退款 + 装扮方案
 * 通过共享对象 PPD 访问公共状态与接口。能力训练已独立到 app/training.js。
 * - 兑换 → 入持有库存(owned)，不自动装配；玩家在库存中自行「装配/卸下」。
 * - 装扮页已移除退款功能(v2.0)；refundAllCosmetics 仅供训练页"全部洗点"调用。
 * - 装扮方案：从 4 类(尾影/球拍/上衣/溅射)各选 1 组合(至少 1 类至多 4 类)，自定义名，最多 8 个。
 * - 网页版禁用（数据只留本地应用端）。
 * ============================================================ */
(function () {
  'use strict';

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
  const SHIRTS = [
    { id: 'green', name: '上衣·翠绿', cost: 20 },
    { id: 'purple', name: '上衣·紫罗兰', cost: 30 },
    { id: 'orange', name: '上衣·活力橙', cost: 40 },
    { id: 'cyan', name: '上衣·海蓝青', cost: 50 },
  ];
  const SPLASH_COST = 50;
  const MAX_PLANS = 8;

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function costOf(list, id) { const x = list.find((v) => v.id === id); return x ? x.cost : 0; }
  function nameOf(list, id) { const x = list.find((v) => v.id === id); return x ? x.name : ''; }

  // ---------- 兑换(入库存) ----------
  function own(type, id, cost) {
    if (PPD.app.points < cost) { PPD.setStatus('积分不足，无法兑换'); return; }
    const o = PPD.app.owned;
    if (type === 'trail') { if (!o.trail.includes(id)) o.trail.push(id); }
    else if (type === 'paddle') { if (!o.paddle.includes(id)) o.paddle.push(id); }
    else if (type === 'shirt') { if (!o.shirt.includes(id)) o.shirt.push(id); }
    else return;
    PPD.app.points -= cost;
    if (PPD.savePoints) PPD.savePoints();
    if (PPD.saveOwned) PPD.saveOwned();
    if (PPD.refreshPoints) PPD.refreshPoints();
    renderDressup();
    PPD.setStatus('已兑换，可在库存中装配');
  }
  function ownSplash() {
    if (PPD.app.points < SPLASH_COST) { PPD.setStatus('积分不足，无法兑换'); return; }
    PPD.app.owned.splash = true;
    PPD.app.points -= SPLASH_COST;
    if (PPD.savePoints) PPD.savePoints();
    if (PPD.saveOwned) PPD.saveOwned();
    if (PPD.refreshPoints) PPD.refreshPoints();
    renderDressup();
    PPD.setStatus('已兑换撞击溅射，可在库存中装配');
  }

  // ---------- 装配 / 卸下 ----------
  function equip(type, id) {
    const o = PPD.app.owned;
    const has = type === 'splash' ? o.splash : (o[type] || []).includes(id);
    if (!has) return;
    PPD.app.equip[type] = id;
    if (PPD.saveEquip) PPD.saveEquip();
    renderDressup();
    PPD.setStatus('已装配');
  }
  function unequip(type) {
    PPD.app.equip[type] = null;
    if (PPD.saveEquip) PPD.saveEquip();
    renderDressup();
    PPD.setStatus('已卸下');
  }
  function equipSplash() {
    if (!PPD.app.owned.splash) return;
    PPD.app.equip.splash = true;
    if (PPD.saveEquip) PPD.saveEquip();
    renderDressup();
    PPD.setStatus('撞击溅射已装配');
  }
  function unequipSplash() {
    PPD.app.equip.splash = false;
    if (PPD.saveEquip) PPD.saveEquip();
    renderDressup();
    PPD.setStatus('撞击溅射已卸下（恢复波纹）');
  }

  // 全部外观退款（仅供训练页"全部洗点"调用，装扮页已移除退款功能 v2.0）：清空库存与装配，返回退回积分
  function refundAllCosmetics() {
    let back = 0;
    const o = PPD.app.owned;
    for (const id of o.trail || []) back += costOf(TRAILS, id);
    for (const id of o.paddle || []) back += costOf(PADDLES, id);
    for (const id of o.shirt || []) back += costOf(SHIRTS, id);
    if (o.splash) back += SPLASH_COST;
    PPD.app.owned = { trail: [], paddle: [], shirt: [], splash: false };
    PPD.app.equip = { trail: null, paddle: null, shirt: null, splash: false };
    if (PPD.saveOwned) PPD.saveOwned();
    if (PPD.saveEquip) PPD.saveEquip();
    return back;
  }

  // ---------- 装扮方案 ----------
  function savePlan() {
    const name = (PPD.ui.planNameInput && PPD.ui.planNameInput.value.trim()) || '';
    if (!name) { PPD.setStatus('请先输入方案名'); return; }
    const eq = PPD.app.equip;
    if (!(eq.trail || eq.paddle || eq.shirt || eq.splash)) { PPD.setStatus('请先装配至少一项外观'); return; }
    if (PPD.app.plans.length >= MAX_PLANS) { PPD.setStatus('方案已达上限（' + MAX_PLANS + ' 个），请先删除'); return; }
    PPD.app.plans.push({ name: name.slice(0, 12), trail: eq.trail, paddle: eq.paddle, shirt: eq.shirt, splash: !!eq.splash });
    if (PPD.savePlans) PPD.savePlans();
    if (PPD.ui.planNameInput) PPD.ui.planNameInput.value = '';
    renderDressup();
    PPD.setStatus('方案已保存：' + name);
  }
  function applyPlan(idx) {
    const p = PPD.app.plans[idx];
    if (!p) return;
    PPD.app.equip = { trail: p.trail, paddle: p.paddle, shirt: p.shirt, splash: !!p.splash };
    if (PPD.saveEquip) PPD.saveEquip();
    renderDressup();
    PPD.setStatus('已应用方案：' + (p.name || ''));
  }
  function deletePlan(idx) {
    PPD.app.plans.splice(idx, 1);
    if (PPD.savePlans) PPD.savePlans();
    renderDressup();
    PPD.setStatus('方案已删除');
  }

  // ---------- 渲染 ----------
  function shopItem(nameHtml, btnHtml) {
    return '<div class="s-item"><div class="t-info">' + nameHtml + '</div><span class="t-btns">' + btnHtml + '</span></div>';
  }
  function ownedItemBtn(type, id, equipped) {
    return equipped
      ? '<button class="btn small" data-action="unequip" data-type="' + type + '">已装配(卸下)</button>'
      : '<button class="btn small" data-action="equip" data-type="' + type + '" data-id="' + id + '">装配</button>';
  }

  function renderDressup() {
    if (!PPD.ui.dressupPanel) return;
    if (PPD.refreshPoints) PPD.refreshPoints();
    const o = PPD.app.owned, eq = PPD.app.equip;
    const trailHtml = TRAILS.map((x) => {
      const has = (o.trail || []).includes(x.id);
      return has
        ? shopItem('<b>' + esc(x.name) + '</b> <span class="t-owned">持有</span>', ownedItemBtn('trail', x.id, eq.trail === x.id))
        : shopItem('<b>' + esc(x.name) + '</b>', '<button class="btn small" data-action="own" data-type="trail" data-id="' + x.id + '" data-cost="' + x.cost + '">兑换 ' + x.cost + '</button>');
    }).join('');
    const paddleHtml = PADDLES.map((x) => {
      const has = (o.paddle || []).includes(x.id);
      return has
        ? shopItem('<b>' + esc(x.name) + '</b> <span class="t-owned">持有</span>', ownedItemBtn('paddle', x.id, eq.paddle === x.id))
        : shopItem('<b>' + esc(x.name) + '</b>', '<button class="btn small" data-action="own" data-type="paddle" data-id="' + x.id + '" data-cost="' + x.cost + '">兑换 ' + x.cost + '</button>');
    }).join('');
    const shirtHtml = SHIRTS.map((x) => {
      const has = (o.shirt || []).includes(x.id);
      return has
        ? shopItem('<b>' + esc(x.name) + '</b> <span class="t-owned">持有</span>', ownedItemBtn('shirt', x.id, eq.shirt === x.id))
        : shopItem('<b>' + esc(x.name) + '</b>', '<button class="btn small" data-action="own" data-type="shirt" data-id="' + x.id + '" data-cost="' + x.cost + '">兑换 ' + x.cost + '</button>');
    }).join('');
    const splashHtml = o.splash
      ? shopItem('<b>撞击溅射</b> <span class="t-owned">持有</span>',
          eq.splash
            ? '<button class="btn small" data-action="splash-unequip">已装配(卸下)</button>'
            : '<button class="btn small" data-action="splash-equip">装配</button>')
      : shopItem('<b>撞击溅射</b>', '<button class="btn small" data-action="splash-own">兑换 ' + SPLASH_COST + '</button>');
    if (PPD.ui.dressupList) PPD.ui.dressupList.innerHTML =
      '<h3>尾影特效</h3>' + trailHtml +
      '<h3>球拍外观</h3>' + paddleHtml +
      '<h3>上衣换色</h3>' + shirtHtml +
      '<h3>球台撞击特效</h3>' + splashHtml;

    // 装扮方案列表
    const plansHtml = PPD.app.plans.map((p, i) => {
      const parts = [];
      if (p.trail) { const n = nameOf(TRAILS, p.trail); if (n) parts.push(n); }
      if (p.paddle) { const n = nameOf(PADDLES, p.paddle); if (n) parts.push(n); }
      if (p.shirt) { const n = nameOf(SHIRTS, p.shirt); if (n) parts.push(n); }
      if (p.splash) parts.push('撞击溅射');
      return '<div class="s-item"><div class="t-info"><b>' + esc(p.name || '未命名') + '</b>' +
        '<div class="t-desc">' + esc(parts.join(' + ') || '(空)') + '</div></div>' +
        '<span class="t-btns">' +
        '<button class="btn small" data-action="plan-apply" data-idx="' + i + '">应用</button>' +
        '<button class="btn small" data-action="plan-delete" data-idx="' + i + '">删除</button></span></div>';
    }).join('');
    if (PPD.ui.planList) PPD.ui.planList.innerHTML = plansHtml || '<div class="career-empty">还没有装扮方案</div>';
  }

  function openDressup() {
    PPD.GameAudio.ensure();
    PPD.GameAudio.ui();
    if (PPD.isWebVersion) {
      if (PPD.showOverlay) {
        PPD.showOverlay('装扮系统 · 探索中',
          '装扮系统网页版正在探索中，暂不对网页版开放。\n外观库存、装配与装扮方案仅保存在本地应用端（桌面版 / 手机 APK）。',
          '知道了', () => {});
      }
      return;
    }
    if (PPD.ui.dressupPanel) PPD.show(PPD.ui.dressupPanel, true);
    if (PPD.ui.menu) PPD.show(PPD.ui.menu, false);
    renderDressup();
  }
  function closeDressup() {
    if (PPD.ui.dressupPanel) PPD.show(PPD.ui.dressupPanel, false);
    if (PPD.ui.menu) PPD.show(PPD.ui.menu, true);
    if (PPD.refreshPoints) PPD.refreshPoints();
  }

  // ---------- 事件绑定 ----------
  if (PPD.ui.btnDressup) {
    PPD.ui.btnDressup.addEventListener('click', () => { if (PPD.GameAudio) PPD.GameAudio.ensure(); openDressup(); });
  }
  if (PPD.ui.btnDressupBack) {
    PPD.ui.btnDressupBack.addEventListener('click', () => { if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui(); closeDressup(); });
  }
  if (PPD.ui.btnPlanSave) {
    PPD.ui.btnPlanSave.addEventListener('click', () => { if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui(); savePlan(); });
  }
  function onDressupClick(e) {
    const el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) return;
    const a = el.getAttribute('data-action');
    const type = el.getAttribute('data-type');
    const id = el.getAttribute('data-id');
    const cost = parseInt(el.getAttribute('data-cost'), 10) || 0;
    if (a === 'own') own(type, id, cost);
    else if (a === 'splash-own') ownSplash();
    else if (a === 'equip') equip(type, id);
    else if (a === 'unequip') unequip(type);
    else if (a === 'splash-equip') equipSplash();
    else if (a === 'splash-unequip') unequipSplash();
    else if (a === 'plan-apply') applyPlan(parseInt(el.getAttribute('data-idx'), 10) || 0);
    else if (a === 'plan-delete') deletePlan(parseInt(el.getAttribute('data-idx'), 10) || 0);
  }
  if (PPD.ui.dressupList) PPD.ui.dressupList.addEventListener('click', onDressupClick);
  if (PPD.ui.planList) PPD.ui.planList.addEventListener('click', onDressupClick);

  // ---------- 导出 ----------
  PPD.COSMETIC_ITEMS = { TRAILS, PADDLES, SHIRTS, SPLASH_COST, MAX_PLANS };
  PPD.ownCosmetic = own;
  PPD.ownSplash = ownSplash;
  PPD.equipCosmetic = equip;
  PPD.unequipCosmetic = unequip;
  PPD.refundAllCosmetics = refundAllCosmetics;
  PPD.savePlan = savePlan;
  PPD.applyPlan = applyPlan;
  PPD.deletePlan = deletePlan;
  PPD.renderDressup = renderDressup;
  PPD.openDressup = openDressup;
  PPD.closeDressup = closeDressup;
})();
