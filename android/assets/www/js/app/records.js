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

  // ---------- 手机端本地生涯（安卓 APK 为 file:// 页面，无同源后端） ----------
  // 本地优先（local-first）：战绩先写 localStorage（手机本地，卸载/清数据会清空，见说明书），
  // 若在「设置→公网联机服务器地址」填了 http://电脑IP:8765 之类地址，再异步尽力同步（跨设备共享）。
  const CAREER_KEY = 'ppd_career';
  const CAREER_MAX = 500; // 本地最多保留 500 条，超限裁剪最旧
  const isMobileOffline = typeof location !== 'undefined' && location.protocol === 'file:';

  function localLoad() {
    try {
      const arr = JSON.parse(localStorage.getItem(CAREER_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function localSave(list) {
    const slim = list.slice(-CAREER_MAX);
    try { localStorage.setItem(CAREER_KEY, JSON.stringify(slim)); }
    catch (e) { // 配额超限：裁一半再试（仍失败则静默放弃）
      try { localStorage.setItem(CAREER_KEY, JSON.stringify(slim.slice(-Math.floor(CAREER_MAX / 2)))); } catch (e2) { /* ignore */ }
    }
  }
  // v2.7.0：公网联机服务器地址已移除——桌面端走同源后端('')；手机端(file:// 无后端)仅存本地(null)。
  function serverBase() {
    if (!isMobileOffline) return '';
    return null;
  }

  // 保存一条通关记录（人机玩家获胜时由 hud.js 调用）。
  // 网页版禁用：个人生涯只保留在本地应用端（桌面版/安装包的 records.json），
  // 网页版不向后端写记录（避免"谁打开网址打了就算进生涯"的问题）。
  async function saveRecord(rec) {
    if (PPD.isWebVersion) return null;
    // 手机端（file:// 无同源后端）：本地优先——先写 localStorage，再尽力同步
    if (isMobileOffline) {
      const list = localLoad();
      list.push(rec);
      localSave(list);
    }
    const base = serverBase();
    if (base === null) return null; // 手机端未配置服务器：仅存手机本地
    try {
      const r = await fetch(base + '/api/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rec),
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.ok ? j.id : null;
    } catch (e) { return null; } // 无后端/离线：静默（本地已保存）
  }

  // 拉取最近记录（最新在前）。手机端读本地 localStorage；桌面端走同源后端。
  async function fetchRecords(limit) {
    if (isMobileOffline) {
      const list = localLoad();
      const n = limit || list.length;
      return list.slice(-n).reverse(); // 最新在前
    }
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

  // 渲染主菜单小方框（个人生涯摘要；点击展开整页见 openCareer）。
  // 网页版：个人生涯功能正在探索中、暂不对网页版开放——显示禁用态 + 感叹号，点击见说明。
  async function refreshRecords() {
    const el = PPD.ui.recordsPanel;
    if (!el) return;
    if (PPD.isWebVersion) {
      el.classList.add('disabled');
      el.innerHTML = '个人生涯 · 探索中（网页版暂未开放）<span class="career-warn" title="点开查看说明">!</span>';
      return;
    }
    // v2.2：并入历史回放 —— 蓝块摘要加回放数
    let replayCount = 0;
    try {
      if (PPD.Replay && PPD.Replay.list) replayCount = (await PPD.Replay.list()).length;
    } catch (e) { /* ignore */ }
    const list = await fetchRecords(60);
    if (!list.length) {
      el.innerHTML = `个人生涯：暂无对局 · 回放 ${replayCount} · 点击展开`;
      return;
    }
    const wins = list.filter((r) => r && r.winner === 0).length;
    const total = list.length;
    const rate = total ? Math.round((wins / total) * 100) : 0;
    el.innerHTML = `个人生涯：总场次 ${total} · 胜率 ${rate}% · 回放 ${replayCount} · 点击展开`;
  }

  // ---------- 个人生涯单开页面（点击小方框展开，分页展示战绩记录） ----------
  const PER_PAGE = 10; // 每页条数
  let careerRecords = [];
  let careerPage = 0;

  // 审计 #3:玩家名是用户输入,渲染进 innerHTML 前必须转义(服务端已去 < >,此处兜底
  // 手机端 localStorage 未经服务端清洗的数据),防存储型 XSS
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function careerItemHtml(r) {
    const d = r.mode === 'endless' ? '无尽-' + (r.difficulty || 1) : (DIFF[r.difficulty] || '中等');
    const t = new Date(r.ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
    const sc = `${r.score ? r.score[0] : '?'}:${r.score ? r.score[1] : '?'}`;
    const wl = r.winner === 0 ? '胜' : '负';
    const modeLbl = r.mode === 'endless' ? '无尽人机' : (r.mode === 'ai' ? '人机' : (r.mode === 'local' ? '双人' : (r.mode === 'online' ? '联机' : '对战')));
    return `<div class="career-item">${wl} · ${modeLbl} · ${d} · ${sc} · ${time} · ${escapeHtml(r.name || '玩家')}</div>`;
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
    // 网页版：个人生涯功能正在探索中、暂不对网页版开放（数据只保存在本地应用端）
    if (PPD.isWebVersion) {
      if (PPD.showOverlay) {
        PPD.showOverlay(
          '个人生涯 · 探索中',
          '个人生涯（战绩记录与历史回放）网页版正在探索中，暂不对网页版开放。\n作战数据仅保存在本地应用端（桌面版 / 安装包，存于应用目录 records.json），不会上传到网页版后端。',
          '知道了',
          () => {}
        );
      }
      return;
    }
    if (PPD.ui.careerPanel) PPD.show(PPD.ui.careerPanel, true);
    if (PPD.ui.menu) PPD.show(PPD.ui.menu, false); // 单开页面：隐藏主菜单
    careerRecords = await fetchRecords(60);
    careerPage = 0;
    renderCareerPage();
    if (PPD.Replay && PPD.Replay.showCareerTab) PPD.Replay.showCareerTab(); // 默认切到「战绩记录」标签
  }

  function closeCareer() {
    if (PPD.Replay && PPD.Replay.closeHistory) PPD.Replay.closeHistory(); // 复位回放删除态/标签
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
