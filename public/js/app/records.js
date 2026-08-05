/* ============================================================
 * app/records.js — 通关记录：后端保存（本地 server.js / Cloudflare DO）
 * 与主菜单展示。接口：POST/GET /api/records（两套后端兼容）。
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

  // 渲染到主菜单 #recordsPanel（最近 5 条）
  async function refreshRecords() {
    const el = PPD.ui.recordsPanel;
    if (!el) return;
    const list = await fetchRecords(5);
    if (!list.length) {
      el.innerHTML = '🏆 通关记录：暂无（人机模式击败困难/地狱后自动保存）';
      return;
    }
    const items = list.map((r) => {
      const d = DIFF[r.difficulty] || '中等';
      const t = new Date(r.ts || Date.now());
      const pad = (n) => String(n).padStart(2, '0');
      const time = `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
      const sc = `${r.score ? r.score[0] : '?'}:${r.score ? r.score[1] : '?'}`;
      return `<div class="rec-item">🏆 ${d} · ${sc} · ${time} · ${r.name || '玩家'}</div>`;
    }).join('');
    el.innerHTML = `<div class="rec-title">🏆 通关记录（最近 ${list.length} 条）</div>${items}`;
  }

  PPD.saveRecord = saveRecord;
  PPD.fetchRecords = fetchRecords;
  PPD.refreshRecords = refreshRecords;
  PPD.syncUnlocksFromRecords = syncUnlocksFromRecords;
})();
