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
  // 仅本地（v2.7.0 起移除「公网联机服务器地址」同步功能）：战绩写入 localStorage
  //（手机本地，卸载/清数据会清空）。
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

  // ---------- 顶部动态信息（G4/G5）：三条横向等宽，间以 1px 竖线分隔 ----------
  // 静态结果数据（总场次/胜率/回放）已移入「生涯」二级页；首屏只留动态信息。
  function statBarsHtml(list) {
    const recent = list.slice(0, 10);
    const bars = recent.map((r) => {
      const win = r && r.winner === 0;
      return `<span class="stat-bar ${win ? 'win' : 'lose'}"></span>`;
    }).join('');
    return bars ? `<div class="stat-bars">${bars}</div>` : '';
  }
  // 微趋势：近 10 场胜率 vs 更早 10 场胜率（升=↑ 降=↓ 平=—）
  function statTrendHtml(list) {
    const recent = list.slice(0, 10);
    const prev = list.slice(10, 20);
    if (recent.length < 3 || prev.length < 3) {
      return '<span class="stat-trend flat" title="样本不足，暂无趋势">—</span>';
    }
    const rRate = recent.filter((r) => r && r.winner === 0).length / recent.length;
    const pRate = prev.filter((r) => r && r.winner === 0).length / prev.length;
    const d = rRate - pRate;
    if (d > 0.15) return `<span class="stat-trend up" title="近 ${recent.length} 场上升">▲</span>`;
    if (d < -0.15) return `<span class="stat-trend down" title="近 ${recent.length} 场下降">▼</span>`;
    return '<span class="stat-trend flat" title="近期持平">—</span>';
  }
  // ① 近 10 场战绩趋势：N 胜 + 微型胜负方块条
  function trendCellHtml(list) {
    const recent = list.slice(0, 10);
    const wins = recent.filter((r) => r && r.winner === 0).length;
    return '<span class="dash-label">近 10 场</span>'
      + `<span class="dash-value">${wins} 胜 ${statTrendHtml(list)}</span>`
      + statBarsHtml(list);
  }
  // ② 提升引导：一句可执行的下一步 + 青绿文字按钮
  function guideCellHtml() {
    return '<span class="dash-label">提升建议</span>'
      + '<span class="guide-text">接发球专项可提升</span>'
      + '<button type="button" class="guide-action" id="btnGuideTraining">去训练 →</button>';
  }
  // 生涯二级入口：完整统计（总场次/胜/负/胜率）在这一页
  function statCareerLinkHtml() {
    return '<button type="button" class="stat-career-link" id="btnStatCareer">'
      + '<span class="career-link-text">生涯</span><span aria-hidden="true">›</span></button>';
  }
  // 上次战绩（G4）：仅展示对手/比分/胜负/模式，唯一允许的操作是查看回放
  const MODE_LBL = { ai: '人机', local: '双人', online: '联机', endless: '无尽', aiVsAi: '推演' };
  function renderRecentMatch(list, replayCount) {
    const box = PPD.ui.recentMatch;
    if (!box) return;
    const r = list && list[0];
    if (!r) { box.hidden = true; return; }
    const t = new Date(r.ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    const when = `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
    const sc = r.score ? `${r.score[0]}:${r.score[1]}` : '—';
    const win = r.winner === 0;
    const mode = MODE_LBL[r.mode] || '对战';
    if (PPD.ui.recentTitle) {
      PPD.ui.recentTitle.innerHTML = `${escapeHtml(r.name || '对手')} · `
        + `<b>${sc}</b> · <i class="${win ? 'win' : 'lose'}">${win ? '胜' : '负'}</i>`;
    }
    if (PPD.ui.recentMeta) PPD.ui.recentMeta.textContent = `${mode} · ${when}`;
    // 查看回放：仅在确有回放时出现（无回放则不显示任何操作）
    const rp = document.getElementById('btnRecentReplay');
    if (rp) rp.hidden = !(replayCount > 0);
    box.hidden = false;
  }

  // 把三栏内容分别写进各自的单元格（互不挤压）。
  // 单元格引用走 PPD.ui（getElementById），避免依赖 querySelector。
  function paintDashboard(trendHtml, guideHtmlStr, entryHtml) {
    const el = PPD.ui.recordsPanel;
    if (!el) return;
    const t = PPD.ui.dashTrend;
    const g = PPD.ui.dashGuide;
    const e = PPD.ui.dashEntry;
    if (t) t.innerHTML = trendHtml;
    if (g) g.innerHTML = guideHtmlStr;
    if (e) e.innerHTML = entryHtml;
    // 宿主缺少单元格引用时（极简宿主）退回整块渲染，保证信息不丢
    if (!t && !g && !e) el.innerHTML = trendHtml + guideHtmlStr + entryHtml;
  }

  // 渲染顶部动态信息（完整统计见 openCareer）。
  // 网页版：个人生涯功能正在探索中、暂不对网页版开放——显示禁用态 + 感叹号，点击见说明。
  async function refreshRecords() {
    const el = PPD.ui.recordsPanel;
    if (!el) return;
    if (PPD.isWebVersion) {
      el.classList.add('disabled');
      paintDashboard('<span class="dash-label">个人生涯 · 探索中</span>'
        + '<span class="career-warn" title="点开查看说明">!</span>', '', statCareerLinkHtml());
      renderRecentMatch([], 0);
      bindDashboardActions();
      return;
    }
    el.classList.remove('disabled');
    let replayCount = 0;
    try {
      if (PPD.Replay && PPD.Replay.list) replayCount = (await PPD.Replay.list()).length;
    } catch (e) { /* ignore */ }
    const list = await fetchRecords(60);
    if (!list.length) {
      if (PPD.app) { PPD.app.hasRecords = false; PPD.app.lastMode = ''; }
      if (PPD.refreshPrimaryAction) PPD.refreshPrimaryAction();
      paintDashboard('<span class="dash-label">近 10 场</span><span class="dash-value">暂无战绩</span>',
        guideCellHtml(), statCareerLinkHtml());
      renderRecentMatch([], replayCount);
      bindDashboardActions();
      return;
    }
    // 主行动按钮副标题依赖"上次模式"，数据到位后同步
    if (PPD.app) {
      PPD.app.hasRecords = true;
      PPD.app.lastMode = (list[0] && list[0].mode) || '';
    }
    if (PPD.refreshPrimaryAction) PPD.refreshPrimaryAction();
    paintDashboard(trendCellHtml(list), guideCellHtml(), statCareerLinkHtml());
    renderRecentMatch(list, replayCount);
    bindDashboardActions();
  }

  // 顶栏内的三个次级交互：生涯入口（复用整页生涯）、引导动作（跳能力训练）、查看回放
  // 控件是每次渲染重新生成的，用 getElementById 现取现绑；不依赖 querySelector。
  function bindDashboardActions() {
    const link = document.getElementById('btnStatCareer');
    if (link && link.addEventListener) {
      link.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        openCareer();
      });
    }
    const guide = document.getElementById('btnGuideTraining');
    if (guide && guide.addEventListener) {
      guide.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (PPD.ui.btnTraining) PPD.ui.btnTraining.click();
      });
    }
    const rp = document.getElementById('btnRecentReplay');
    if (rp && rp.addEventListener) {
      rp.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        // 查看回放：复用回放系统的历史回放入口（切到生涯页「历史回放」标签）
        if (PPD.Replay && PPD.Replay.openHistory) PPD.Replay.openHistory();
        else openCareer();
      });
    }
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

  // 顶部区域点击 → 展开整页生涯；但区域内的次级控件（生涯入口 / 去训练 / 查看回放）
  // 自行处理点击，不触发整页跳转，避免一次点击产生两个动作。
  if (PPD.ui.recordsPanel) {
    PPD.ui.recordsPanel.addEventListener('click', (ev) => {
      const t = ev && ev.target;
      if (t && t.closest && t.closest('button')) return;
      if (PPD.GameAudio) PPD.GameAudio.ensure();
      openCareer();
    });
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
