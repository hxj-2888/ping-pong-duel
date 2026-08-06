/* ============================================================
 * app/records.js — 个人生涯：后端保存（本地 server.js / Cloudflare DO）
 * 与主菜单展示（总场次/胜率 + 最近 60 条）。接口：POST/GET /api/records。
 * 失败静默（无后端/离线不报错）。
 * ============================================================ */
(function () {
  'use strict';

  // API 基址：记录一律走当前页面**同源**后端——桌面端=本地 server.js（records.json，
  // 页面就是它服务的，必然可达）；网页版=pages.dev /api/records（Cloudflare DO）。
  // 不跟随"联机:公网"切换，避免桌面切公网时记录静默写到远端、重开又读本地导致记录"消失"。
  function apiBase() { return ''; }

  // 保存一条通关记录（人机玩家获胜时由 hud.js 调用）
  async function saveRecord(rec) {
    try {
      const r = await fetch(apiBase() + '/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rec),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.ok ? j.id : null;
    } catch (e) { return null; } // 无后端/离线：静默
  }

  // 拉取最近记录（最新在前）
  async function fetchRecords(limit) {
    try {
      const r = await fetch(apiBase() + '/api/records?limit=' + (limit || 20));
      if (!r.ok) return [];
      const j = await r.json();
      return (j && Array.isArray(j.records)) ? j.records : [];
    } catch (e) { return []; }
  }

  const DIFF = ['简单', '中等', '困难', '地狱'];

  // 解锁判定兜底：从**持久化的后端记录**推导——人机获胜且难度≥困难=解锁地狱、
  // =地狱=地狱通关。即使浏览器 localStorage 被清空（桌面旧临时配置/清缓存），
  // 只要记录还在（records.json / Cloudflare DO），地狱与 AI 观战就不会上锁。
  async function syncUnlocksFromRecords() {
    const list = await fetchRecords(200);
    let beatHard = false, beatHell = false;
    for (const r of list) {
      if (r && r.mode === 'ai' && r.winner === 0 && typeof r.difficulty === 'number') {
        if (r.difficulty >= 2) beatHard = true;
        if (r.difficulty === 3) beatHell = true;
      }
    }
    if (beatHard && PPD.unlockHell) PPD.unlockHell();     // 内部会全量同步 5 个难度下拉
    if (beatHell && PPD.markHellCleared) PPD.markHellCleared();
  }

  // 渲染主菜单小方框（个人生涯摘要；点击展开整页见 openCareer）
  async function refreshRecords() {
    const el = PPD.ui.recordsPanel;
    if (!el) return;
    const list = await fetchRecords(60);
    if (!list.length) {
      el.innerHTML = '个人生涯：暂无对局 · 点击展开';
      return;
    }
    const wins = list.filter((r) => r && r.winner === 0).length;
    const total = list.length;
    const rate = total ? Math.round((wins / total) * 100) : 0;
    el.innerHTML = `个人生涯：总场次 ${total} · 胜率 ${rate}% · 点击展开`;
  }

  // ---------- 个人生涯单开页面（点击小方框展开，分页展示战绩记录） ----------
  const PER_PAGE = 10; // 每页条数
  let careerRecords = [];
  let careerPage = 0;

  function careerItemHtml(r) {
    const d = DIFF[r.difficulty] || '中等';
    const t = new Date(r.ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
    const sc = `${r.score ? r.score[0] : '?'}:${r.score ? r.score[1] : '?'}`;
    const wl = r.winner === 0 ? '胜' : '负';
    const modeLbl = r.mode === 'ai' ? '人机' : (r.mode === 'local' ? '双人' : (r.mode === 'online' ? '联机' : '对战'));
    return `<div class="career-item">${wl} · ${modeLbl} · ${d} · ${sc} · ${time} · ${r.name || '玩家'}</div>`;
  }

  function renderCareerPage() {
    const ui = PPD.ui;
    const total = careerRecords.length;
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    careerPage = Math.max(0, Math.min(careerPage, pages - 1));
    if (ui.careerStats) {
      const wins = careerRecords.filter((r) => r && r.winner === 0).length;
      const rate = total ? Math.round((wins / total) * 100) : 0;
      ui.careerStats.innerHTML = `总场次 ${total} · 胜 ${wins} · 负 ${total - wins} · 胜率 ${rate}%`;
    }
    const slice = careerRecords.slice(careerPage * PER_PAGE, (careerPage + 1) * PER_PAGE);
    if (ui.careerList) {
      ui.careerList.innerHTML = slice.length
        ? slice.map(careerItemHtml).join('')
        : '<div class="career-empty">暂无对局（人机模式对局后自动保存）</div>';
    }
    if (ui.careerPageLabel) ui.careerPageLabel.textContent = `第 ${careerPage + 1} / ${pages} 页`;
    if (ui.btnCareerPrev) ui.btnCareerPrev.disabled = careerPage <= 0;
    if (ui.btnCareerNext) ui.btnCareerNext.disabled = careerPage >= pages - 1;
  }

  async function openCareer() {
    if (PPD.ui.careerPanel) PPD.show(PPD.ui.careerPanel, true);
    if (PPD.ui.menu) PPD.show(PPD.ui.menu, false); // 单开页面：隐藏主菜单
    careerRecords = await fetchRecords(60);
    careerPage = 0;
    renderCareerPage();
  }

  function closeCareer() {
    if (PPD.ui.careerPanel) PPD.show(PPD.ui.careerPanel, false);
    if (PPD.ui.menu) PPD.show(PPD.ui.menu, true);
  }

  // 主菜单小方框点击 → 展开整页；返回/上一页/下一页
  if (PPD.ui.recordsPanel) {
    PPD.ui.recordsPanel.addEventListener('click', () => { if (PPD.GameAudio) PPD.GameAudio.ensure(); openCareer(); });
  }
  if (PPD.ui.btnCareerBack) {
    PPD.ui.btnCareerBack.addEventListener('click', () => { if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui(); closeCareer(); });
  }
  if (PPD.ui.btnCareerPrev) PPD.ui.btnCareerPrev.addEventListener('click', () => { careerPage--; renderCareerPage(); });
  if (PPD.ui.btnCareerNext) PPD.ui.btnCareerNext.addEventListener('click', () => { careerPage++; renderCareerPage(); });

  PPD.saveRecord = saveRecord;
  PPD.fetchRecords = fetchRecords;
  PPD.refreshRecords = refreshRecords;
  PPD.syncUnlocksFromRecords = syncUnlocksFromRecords;
  PPD.openCareer = openCareer;
  PPD.closeCareer = closeCareer;
  PPD.renderCareerPage = renderCareerPage;
})();
