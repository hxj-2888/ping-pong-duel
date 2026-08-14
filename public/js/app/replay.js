/* ============================================================
 * app/replay.js — 赛后回放：录制 / 本地存储 / 播放 / 视频导出
 *
 * 设计：
 *  - 录制：本地/人机/模拟推演模式在主循环每个物理步后采集 TT.snapshot(engine)
 *    快照（每 2 个物理步 = 60Hz 一帧）；联机模式直接采集服务端广播快照。
 *    快照与服务端联机协议同构，回放复用联机渲染管线（viewModelFromSnapInterp）。
 *  - 存储：IndexedDB 主存储（大容量），localStorage 兜底；每局一个回放，
 *    按时间倒序展示，自动裁剪最旧（数量/总大小上限）。
 *  - 播放：独立播放器（进度条 / 播放暂停 / 1×2×4× 倍速 / 回放音效）。
 *  - 导出：canvas.captureStream + MediaRecorder 把回放录制成 WebM 视频——
 *    电脑端用「另存为」选保存位置，手机端录完后走系统分享（可存相册/文件）；
 *    不支持录屏的浏览器回退为导出回放数据文件（.ppd.json）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = factory({});
  } else {
    factory(root);
  }
})(typeof self !== 'undefined' ? self : this, function (host) {
  'use strict';

  const PPD = (host && host.PPD) || (typeof window !== 'undefined' ? window.PPD : null);
  const hasLS = (function () {
    try { return typeof localStorage !== 'undefined' && !!localStorage; } catch (e) { return false; }
  })();

  // ---------- 快照编解码（压缩存储：数组布局 + 数值取整） ----------
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const r1 = (v) => Math.round(v * 10) / 10;

  // 布局：[t, ph, sc0, sc1, sv, pr, p0(20), p1(20), b|bh|sp|sb|ev]
  function encodeSnap(s) {
    const p = s.p || [];
    const p0 = p[0] || {}, p1 = p[1] || {};
    const out = [
      Math.round(s.t),
      s.ph | 0,
      (s.sc && s.sc[0]) | 0, (s.sc && s.sc[1]) | 0,
      s.sv | 0,
      s.pr || '',
    ];
    for (const pl of [p0, p1]) {
      out.push(r3(pl.x || 0), r3(pl.z || 0), r3(pl.vx || 0), r3(pl.vz || 0), r3(pl.lean || 0));
      const st = pl.st || [0, 0, 0];
      out.push(st[0] | 0, r3(st[1] || 0), r3(st[2] || 0));
      const pc = pl.pc || [0, 0, 0], pn = pl.pn || [0, 0, 0], pv = pl.pv || [0, 0, 0];
      out.push(r3(pc[0]), r3(pc[1]), r3(pc[2]),
        r3(pn[0]), r3(pn[1]), r3(pn[2]),
        r3(pv[0]), r3(pv[1]), r3(pv[2]));
      out.push(r3(pl.sb || 0), r3(pl.cq || 0), r3(pl.rn || 0));
    }
    out.push(Array.isArray(s.b) ? s.b.map((v, i) => (i < 6 ? r3(v) : r1(v))) : null);   // 46
    out.push(Array.isArray(s.bh) ? s.bh.map(r3) : null);                                 // 47
    out.push(Array.isArray(s.sp) ? s.sp.map((v, i) => (i < 3 ? r3(v) : r1(v))) : null); // 48
    out.push(s.sb ? 1 : 0);                                                              // 49
    out.push(Array.isArray(s.ev)
      ? s.ev.map((e) => [Math.round(e.t * 1000), e.c, e.s == null ? -1 : e.s])
      : []);                                                                             // 50
    return out;
  }

  function decodeSnap(a) {
    const mkPlayer = (o) => ({
      x: a[o], z: a[o + 1], vx: a[o + 2], vz: a[o + 3], lean: a[o + 4],
      st: [a[o + 5], a[o + 6], a[o + 7]],
      pc: [a[o + 8], a[o + 9], a[o + 10]],
      pn: [a[o + 11], a[o + 12], a[o + 13]],
      pv: [a[o + 14], a[o + 15], a[o + 16]],
      sb: a[o + 17], cq: a[o + 18], rn: a[o + 19],
    });
    return {
      t: a[0], ph: a[1], sc: [a[2], a[3]], sv: a[4], pr: a[5] || '',
      p: [mkPlayer(6), mkPlayer(26)],
      b: a[46], bh: a[47], sp: a[48], sb: a[49] ? 1 : 0,
      ev: Array.isArray(a[50])
        ? a[50].map((e) => ({ t: e[0] / 1000, c: e[1], s: e[2] }))
        : [],
    };
  }

  // ---------- 存储（IndexedDB 主 / localStorage 兜底） ----------
  const IDB_DB = 'ppd-replays';
  const IDB_STORE = 'replays';
  const IDB_META = 'meta';
  const LS_INDEX_KEY = 'ppd_replays_index';
  const MAX_REPLAYS = 10;
  const MAX_REPLAY_BYTES = 28 * 1024 * 1024;   // IndexedDB 总大小上限
  const LS_MAX_REPLAYS = 3;
  const LS_MAX_BYTES = 1.8 * 1024 * 1024;      // localStorage 兜底上限
  let idb = null;

  function idbOpen() {
    if (idb) return Promise.resolve(idb);
    if (typeof indexedDB === 'undefined' || !indexedDB.open) {
      return Promise.reject(new Error('no-idb'));
    }
    return new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(IDB_DB, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(IDB_META)) {
          const st = db.createObjectStore(IDB_META, { keyPath: 'id' });
          st.createIndex('ts', 'ts');
        }
      };
      req.onsuccess = () => { idb = req.result; resolve(idb); };
      req.onerror = () => reject(req.error || new Error('idb-open'));
    });
  }

  function idbRun(mode, fn) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(mode === 'rw' ? [IDB_STORE, IDB_META] : IDB_META, mode === 'rw' ? 'readwrite' : 'readonly'); }
      catch (e) { reject(e); return; }
      let out;
      try { out = fn(tx); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      tx.onerror = () => reject(tx.error || new Error('idb-tx'));
    }));
  }

  function metaOf(rec) {
    return {
      id: rec.id, ts: rec.ts, mode: rec.mode, names: rec.names, score: rec.score,
      winner: rec.winner, difficulty: rec.difficulty, side: rec.side,
      durationMs: rec.durationMs, bytes: rec.bytes || String(rec.framesJson || '').length,
    };
  }

  async function idbSave(rec) {
    await idbRun('rw', (tx) => {
      tx.objectStore(IDB_STORE).put({ id: rec.id, framesJson: rec.framesJson });
      tx.objectStore(IDB_META).put(metaOf(rec));
    });
    // 裁剪最旧
    const all = await idbRun('ro', (tx) => {
      const req = tx.objectStore(IDB_META).index('ts').getAll();
      return req;
    });
    const list = (all || []).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    let total = list.reduce((s, r) => s + (r.bytes || 0), 0);
    while (list.length > MAX_REPLAYS || total > MAX_REPLAY_BYTES) {
      const old = list.shift();
      if (!old) break;
      total -= old.bytes || 0;
      await idbRun('rw', (tx) => {
        tx.objectStore(IDB_STORE).delete(old.id);
        tx.objectStore(IDB_META).delete(old.id);
      });
    }
  }

  async function idbList() {
    const all = await idbRun('ro', (tx) => {
      const req = tx.objectStore(IDB_META).index('ts').getAll();
      return req;
    });
    return (all || []).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  async function idbLoad(id) {
    const db = await idbOpen();
    const meta = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_META, 'readonly');
      const req = tx.objectStore(IDB_META).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('idb-meta'));
    });
    if (!meta) return null;
    const framesJson = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(id);
      req.onsuccess = () => resolve((req.result && req.result.framesJson) || null);
      req.onerror = () => reject(req.error || new Error('idb-frames'));
    });
    if (framesJson == null) return null;
    return Object.assign({}, meta, { framesJson });
  }

  async function idbDelete(id) {
    await idbRun('rw', (tx) => {
      tx.objectStore(IDB_STORE).delete(id);
      tx.objectStore(IDB_META).delete(id);
    });
  }

  function lsAll() {
    if (!hasLS) return [];
    try {
      const arr = JSON.parse(localStorage.getItem(LS_INDEX_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function lsSaveIndex(arr) {
    if (!hasLS) return;
    try { localStorage.setItem(LS_INDEX_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
  }
  function lsSave(rec) {
    if (!hasLS) return false;
    let arr = lsAll().filter((r) => r.id !== rec.id);
    arr.push(metaOf(rec));
    arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const key = 'ppd_replay_' + rec.id;
    let saved = false;
    try { localStorage.setItem(key, rec.framesJson); saved = true; } catch (e) { saved = false; }
    if (!saved) {
      // 配额不足：删最旧再试一次
      while (arr.length && !saved) {
        const old = arr.shift();
        if (old.id === rec.id) break;
        try { localStorage.removeItem('ppd_replay_' + old.id); } catch (e2) { /* ignore */ }
        try { localStorage.setItem(key, rec.framesJson); saved = true; } catch (e3) { saved = false; }
      }
      if (!saved) return false;
    }
    let total = arr.reduce((s, r) => s + (r.bytes || 0), 0);
    while (arr.length > LS_MAX_REPLAYS || total > LS_MAX_BYTES) {
      const old = arr.shift();
      if (!old) break;
      total -= old.bytes || 0;
      try { localStorage.removeItem('ppd_replay_' + old.id); } catch (e2) { /* ignore */ }
    }
    lsSaveIndex(arr);
    return true;
  }
  function lsList() {
    return lsAll().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }
  function lsLoad(id) {
    if (!hasLS) return null;
    const meta = lsAll().find((r) => r.id === id);
    if (!meta) return null;
    let framesJson = null;
    try { framesJson = localStorage.getItem('ppd_replay_' + id); } catch (e) { /* ignore */ }
    if (framesJson == null) return null;
    return Object.assign({}, meta, { framesJson });
  }
  function lsDelete(id) {
    if (!hasLS) return false;
    let found = false;
    try { localStorage.removeItem('ppd_replay_' + id); found = true; } catch (e) { /* ignore */ }
    const arr = lsAll().filter((r) => r.id !== id);
    if (arr.length !== lsAll().length) found = true;
    lsSaveIndex(arr);
    return found;
  }

  async function storeSave(rec) {
    try { await idbSave(rec); return true; } catch (e) { /* 回退 localStorage */ }
    return lsSave(rec);
  }
  async function storeList() {
    try { return await idbList(); } catch (e) { /* 回退 */ }
    return lsList();
  }
  async function storeLoad(id) {
    try { const r = await idbLoad(id); if (r) return r; } catch (e) { /* 回退 */ }
    return lsLoad(id);
  }
  async function storeDelete(id) {
    let deleted = false;
    try { await idbDelete(id); deleted = true; } catch (e) { /* 回退 localStorage */ }
    if (lsDelete(id)) deleted = true;
    return deleted;
  }

  // ---------- 录制 ----------
  const rec = { active: false, done: false, frames: [], stepN: 0, lastT: 0, lastFinishedT: 0, meta: null };
  let latest = null;

  function begin(meta) {
    rec.active = true;
    rec.done = false;
    rec.frames = [];
    rec.stepN = 0;
    rec.lastT = 0;
    rec.meta = meta || {};
  }

  function pushFrame(snap) {
    if (rec.done) return;
    rec.frames.push(encodeSnap(snap));
    rec.lastT = snap.t || rec.lastT;
    if (snap.ph === 3 || (snap.ev && snap.ev.some((e) => e.c === 'over'))) rec.done = true; // 终局帧
    if (rec.frames.length > 90000) rec.done = true; // 安全上限（约 25 分钟）
  }

  // 引擎模式：每 2 个物理步（120Hz→60Hz）采一帧；终局帧无条件补采
  function tick(engine) {
    if (!rec.active || rec.done || !engine) return;
    rec.stepN++;
    if (rec.stepN % 2 !== 0 && engine.phase !== 'over') return;
    pushFrame(PPD.TT.snapshot(engine));
  }

  // 联机模式：直接采集服务端广播快照；新一局（t 归零）自动开启新一轮录制
  function recordOnline(snap) {
    if (!snap) return;
    if (!rec.active) {
      if (typeof snap.t === 'number' && rec.lastFinishedT && snap.t < rec.lastFinishedT - 500) {
        begin({ mode: 'online', difficulty: 1, side: PPD.app.side });
      } else {
        return;
      }
    }
    pushFrame(snap);
  }

  async function finish(info) {
    if (!rec.active) return null;
    rec.active = false;
    rec.lastFinishedT = rec.lastT;
    const meta = rec.meta || {};
    const frames = rec.frames;
    rec.frames = [];
    if (frames.length < 2) return null;
    const names = (info && info.names) || (PPD.app && PPD.app.names) || ['玩家1', '玩家2'];
    const score = (info && info.score) || (PPD.app && PPD.app.engine && PPD.app.engine.score) || [0, 0];
    const winner = (info && info.winner != null) ? info.winner : (score[0] > score[1] ? 0 : 1);
    const recObj = {
      id: 'rp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      ts: Date.now(),
      mode: meta.mode || 'ai',
      names: Array.isArray(names) ? names.map(String) : ['玩家1', '玩家2'],
      score: Array.isArray(score) ? [score[0] | 0, score[1] | 0] : [0, 0],
      winner: winner | 0,
      difficulty: meta.difficulty || 1,
      side: meta.side || 0,
      durationMs: rec.lastT | 0,
      framesJson: JSON.stringify(frames),
      bytes: 0,
    };
    recObj.bytes = recObj.framesJson.length;
    latest = {
      id: recObj.id, ts: recObj.ts, mode: recObj.mode, names: recObj.names,
      score: recObj.score, winner: recObj.winner, difficulty: recObj.difficulty,
      side: recObj.side, durationMs: recObj.durationMs, bytes: recObj.bytes,
    };
    // 结算页「查看回放/保存回放」按钮可用（先于异步落盘，避免延迟）
    if (PPD && PPD.ui) {
      if (PPD.ui.btnReplay) PPD.ui.btnReplay.disabled = false;
      if (PPD.ui.btnSaveReplay) PPD.ui.btnSaveReplay.disabled = false;
    }
    await storeSave(recObj);
    return latest;
  }

  // 中途退出/放弃对局：丢弃未完成的录制
  function cancel() {
    rec.active = false;
    rec.done = false;
    rec.frames = [];
  }

  async function list() {
    return storeList();
  }
  async function load(id) {
    return storeLoad(id);
  }
  async function remove(id) {
    return storeDelete(id);
  }

  // ---------- 回放播放器 ----------
  const player = {
    active: false,
    frames: [],
    _decoded: [],
    idx: 0,
    t: 0,
    durationMs: 0,
    playing: false,
    speed: 1,
    side: 0,
    meta: null,
    from: 'menu',
    _evSeen: null,
    exporting: null,
  };
  let pendingVideo = null;

  function fmtDur(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }
  function modeLbl(m) {
    return m === 'ai' ? '人机' : m === 'local' ? '本地双人' : m === 'aivai' ? '模拟推演' : m === 'online' ? '联机' : '对战';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function setStatus(text) {
    if (PPD && PPD.ui && PPD.ui.replayStatus) PPD.ui.replayStatus.textContent = text;
    else if (PPD && PPD.setStatus) PPD.setStatus(text);
  }

  function openPlayer(recObj, from) {
    if (!recObj || !Array.isArray(recObj.frames) || recObj.frames.length < 2) {
      if (PPD && PPD.setStatus) PPD.setStatus('回放数据不可用');
      return;
    }
    player.active = true;
    player.frames = recObj.frames.map(decodeSnap); // 解码为渲染插值用的快照对象
    player.meta = recObj;
    player.side = recObj.side || 0;
    player.durationMs = recObj.durationMs || player.frames[player.frames.length - 1].t || 1;
    player.playing = false;
    player.speed = 1;
    player.idx = 0;
    player.t = 0;
    player._evSeen = new Set();
    player.exporting = null;
    pendingVideo = null;
    player.from = from || 'menu';
    // 显示游戏画面（回放画在 game canvas 上），隐藏比赛相关面板
    if (!PPD) return;
    if (PPD.ui.menu) PPD.show(PPD.ui.menu, false);
    if (PPD.ui.historyPanel) PPD.show(PPD.ui.historyPanel, false);
    if (PPD.ui.careerPanel) PPD.show(PPD.ui.careerPanel, false);
    if (PPD.ui.gameOver) PPD.show(PPD.ui.gameOver, false);
    if (PPD.ui.netPanel) PPD.show(PPD.ui.netPanel, false);
    if (PPD.ui.netWait) PPD.show(PPD.ui.netWait, false);
    if (PPD.ui.pausePanel) PPD.show(PPD.ui.pausePanel, false);
    if (PPD.ui.settingsPanel) PPD.show(PPD.ui.settingsPanel, false);
    if (PPD.ui.manualPanel) PPD.show(PPD.ui.manualPanel, false);
    if (PPD.ui.overlay) PPD.show(PPD.ui.overlay, false);
    if (PPD.ui.gameScreen) PPD.show(PPD.ui.gameScreen, true);
    if (PPD.ui.gameTools) PPD.show(PPD.ui.gameTools, false);
    if (PPD.ui.hitRangeInfo) PPD.show(PPD.ui.hitRangeInfo, false);
    if (PPD.ui.hud) PPD.show(PPD.ui.hud, false); // 比分改由 canvas 绘制（视频导出可见）
    if (PPD.ui.touchControls) PPD.show(PPD.ui.touchControls, false);
    if (PPD.showTouch) PPD.showTouch(false);
    if (PPD.ui.replayPanel) PPD.show(PPD.ui.replayPanel, true);
    if (PPD.ui.replayTitle) {
      const n = recObj.names || [];
      PPD.ui.replayTitle.textContent =
        `回放 · ${modeLbl(recObj.mode)} · ${escapeHtml(n[0] || '玩家1')} vs ${escapeHtml(n[1] || '玩家2')} · ${recObj.score[0]}:${recObj.score[1]}`;
    }
    if (PPD.ui.hintBar) {
      PPD.ui.hintBar.innerHTML = '回放：空格 播放/暂停 · ←/→ 快退快进 · 拖动进度条跳转';
    }
    updateControls();
    updateHud();
  }

  async function openById(id, from) {
    const recObj = await load(id);
    if (!recObj) {
      if (PPD && PPD.setStatus) PPD.setStatus('回放不存在或已失效');
      return;
    }
    try {
      recObj.frames = JSON.parse(recObj.framesJson);
    } catch (e) {
      if (PPD && PPD.setStatus) PPD.setStatus('回放数据损坏');
      return;
    }
    openPlayer(recObj, from);
  }

  function isActive() { return player.active; }

  function currentIndex() {
    const fr = player.frames;
    if (!fr.length) return -1;
    let i = player.idx;
    while (fr[i + 1] && fr[i + 1].t <= player.t) i++;
    while (i > 0 && fr[i].t > player.t) i--;
    player.idx = i;
    return i;
  }

  function seekTo(t) {
    player.t = Math.max(0, Math.min(player.durationMs, t));
    player.idx = 0;
    currentIndex();
    updateHud();
    updateControls();
  }

  function processEvents(fromIdx, toIdx) {
    if (!player._evSeen) player._evSeen = new Set();
    const fr = player.frames;
    const start = Math.max(0, fromIdx);
    for (let i = start; i <= toIdx; i++) {
      const evs = fr[i] && fr[i].ev;
      if (!evs || !evs.length) continue;
      for (const e of evs) {
        if (!e || !e.c) continue;
        const key = `${e.t}_${e.c}`;
        if (player._evSeen.has(key)) continue;
        player._evSeen.add(key);
        if (player._evSeen.size > 400) {
          const first = player._evSeen.values().next().value;
          if (first) player._evSeen.delete(first);
        }
        if (!PPD || !PPD.GameAudio) continue;
        switch (e.c) {
          case 'hit': PPD.GameAudio.hit(); break;
          case 'bounce': PPD.GameAudio.bounce(); break;
          case 'net': PPD.GameAudio.net(); break;
          case 'serve': PPD.GameAudio.serve(); break;
          case 'let': PPD.GameAudio.letSound(); break;
          case 'point':
            PPD.GameAudio.score();
            PPD.GameAudio.cheer();
            if (PPD.triggerCheer) PPD.triggerCheer(e.s === -1 ? 0 : e.s);
            break;
          case 'over':
            PPD.GameAudio.over();
            PPD.GameAudio.cheer();
            if (PPD.triggerCheer) PPD.triggerCheer(e.s);
            break;
          default: break;
        }
      }
    }
  }

  function onReplayEnded() {
    if (player.exporting && player.exporting.recorder) {
      const ex = player.exporting;
      player.exporting = null;
      setStatus('回放播放完成，正在生成视频…');
      try { ex.recorder.stop(); } catch (e) { deliverVideoFallback(); }
    } else {
      setStatus('回放结束 · 可拖动进度条或点击播放重新观看');
    }
  }

  function frame(dt) {
    if (!player.active) return;
    if (player.playing) {
      const before = player.idx;
      player.t += dt * 1000 * player.speed;
      if (player.t >= player.durationMs) {
        player.t = player.durationMs;
        player.playing = false;
      }
      const idx = currentIndex();
      processEvents(before, idx);
      player.idx = idx;
      if (!player.playing) onReplayEnded();
    } else {
      currentIndex();
    }
    updateHud();
    updateControls();
  }

  function updateHud() {
    if (!player.active || !PPD || !PPD.ui) return;
    const fr = player.frames;
    const i = Math.max(0, currentIndex());
    const cur = fr[i];
    if (!cur) return;
    const sc = cur.sc || [0, 0];
    if (PPD.ui.score1) PPD.ui.score1.textContent = String(sc[0]);
    if (PPD.ui.score2) PPD.ui.score2.textContent = String(sc[1]);
    const names = (player.meta && player.meta.names) || [];
    if (PPD.ui.hudP1) PPD.ui.hudP1.textContent = names[0] || '玩家1';
    if (PPD.ui.hudP2) PPD.ui.hudP2.textContent = names[1] || '玩家2';
    const dot = PPD.ui.serveDot;
    if (dot) {
      dot.style.left = cur.sv === 0 ? 'calc(50% - 70px)' : 'calc(50% + 55px)';
      dot.style.opacity = '1';
    }
    if (PPD.ui.netInfo) {
      PPD.ui.netInfo.textContent = `回放 · ${modeLbl(player.meta.mode)} · ${fmtDur(player.t)} / ${fmtDur(player.durationMs)}`;
    }
    const ph = cur.ph;
    if (ph !== player._lastPh && PPD.showPhase) {
      player._lastPh = ph;
      const text = ph === 0 ? '发球' : ph === 1 ? '对打' : ph === 2 ? '得分' : '比赛结束';
      PPD.showPhase(text);
    }
  }

  function render() {
    if (!player.active || !PPD) return;
    const w = PPD.app.resizeW, h = PPD.app.resizeH;
    const ctx = PPD.ctx;
    ctx.clearRect(0, 0, w, h);
    const fr = player.frames;
    if (!fr.length) return;
    let prev = fr[0], next = fr[fr.length - 1], alpha = 0;
    const t = player.t;
    if (fr.length > 1) {
      let i = currentIndex();
      if (fr[i + 1]) {
        prev = fr[i]; next = fr[i + 1];
        alpha = (t - prev.t) / Math.max(1, next.t - prev.t);
      } else {
        prev = fr[Math.max(0, fr.length - 2)]; next = fr[fr.length - 1]; alpha = 1;
      }
    }
    const side = player.side;
    let view;
    if (PPD.viewModelFromSnapInterp) {
      view = PPD.viewModelFromSnapInterp(prev, next, alpha, side, null);
    } else if (PPD.viewModelFromSnap) {
      view = PPD.viewModelFromSnap(next, side, null);
    } else {
      return;
    }
    if (PPD.servePathFromSnap && next.sv === side) view.servePath = PPD.servePathFromSnap(next);
    if (PPD.updateTrail) PPD.updateTrail(view);
    const myX = next.p && next.p[side] ? next.p[side].x : 0;
    const cam = PPD.makeCam ? PPD.makeCam(side, myX, 0, 0, w, h) : null;
    if (cam) view.cam = cam;
    ctx.save();
    if (side === 0 && PPD.applyViewMirror) PPD.applyViewMirror(ctx, w);
    if (PPD.TTG && PPD.TTG.drawScene) PPD.TTG.drawScene(ctx, view, w, h);
    ctx.restore();
    // canvas 内比分/时间（DOM HUD 已隐藏，导出视频时可见）
    const sc = next.sc || [0, 0];
    ctx.font = 'bold 30px system-ui, "Microsoft YaHei"';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 8;
    ctx.fillText(`${sc[0]} : ${sc[1]}`, w / 2, 44);
    ctx.shadowBlur = 0;
    ctx.font = '13px system-ui, "Microsoft YaHei"';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText(`${fmtDur(t)} / ${fmtDur(player.durationMs)}`, w / 2, 66);
  }

  function updateControls() {
    if (!PPD || !PPD.ui) return;
    if (PPD.ui.btnReplayPlay) {
      PPD.ui.btnReplayPlay.textContent = player.playing ? '⏸ 暂停' : '▶ 播放';
    }
    if (PPD.ui.btnReplaySpeed) PPD.ui.btnReplaySpeed.textContent = `${player.speed.toFixed(1)}×`;
    if (PPD.ui.replayProgress) {
      const pct = player.durationMs ? Math.round((player.t / player.durationMs) * 1000) : 0;
      PPD.ui.replayProgress.value = String(pct);
    }
    if (PPD.ui.replayTimeLabel) {
      PPD.ui.replayTimeLabel.textContent = `${fmtDur(player.t)} / ${fmtDur(player.durationMs)}`;
    }
  }

  function closePlayer() {
    if (!player.active) return;
    // 取消进行中的录制
    if (player.exporting && player.exporting.recorder) {
      try { player.exporting.recorder.stop(); } catch (e) { /* ignore */ }
      player.exporting = null;
    }
    player.active = false;
    player.playing = false;
    player.frames = [];
    player._decoded = [];
    player.exporting = null;
    pendingVideo = null;
    if (!PPD) return;
    if (PPD.ui.replayPanel) PPD.show(PPD.ui.replayPanel, false);
    if (PPD.ui.hud) PPD.show(PPD.ui.hud, true);
    if (PPD.ui.gameTools) PPD.show(PPD.ui.gameTools, true);
    const fromGameOver = player.from === 'gameover' &&
      PPD.app.mode && PPD.app.engine && PPD.app.engine.phase === 'over';
    if (fromGameOver) {
      if (PPD.showGameOver) {
        const w = PPD.app.engine.pointWinner;
        const title = PPD.app.mode === 'ai'
          ? (w === 0 ? '您赢了' : '您输了')
          : ((PPD.app.names && PPD.app.names[w]) || '玩家' + (w + 1)) + ' 获胜';
        PPD.showGameOver(title);
      } else if (PPD.ui.gameOver) {
        PPD.show(PPD.ui.gameOver, true);
      }
      if (PPD.ui.gameScreen) PPD.show(PPD.ui.gameScreen, true);
      if (PPD.showTouch) PPD.showTouch(true);
    } else if (player.from === 'career') {
      // 从个人生涯页「历史回放」标签打开：关闭后回到合并页回放标签
      if (PPD.ui.gameOver) PPD.show(PPD.ui.gameOver, false);
      if (PPD.ui.gameScreen) PPD.show(PPD.ui.gameScreen, false);
      if (PPD.ui.menu) PPD.show(PPD.ui.menu, false);
      if (PPD.ui.careerPanel) PPD.show(PPD.ui.careerPanel, true);
      if (PPD.showTouch) PPD.showTouch(false);
      showTab('history'); // 回放标签保持激活
      list().then((l) => { historyItems = l; renderHistory(); }).catch(() => { /* ignore */ });
    } else {
      if (PPD.ui.gameOver) PPD.show(PPD.ui.gameOver, false);
      if (PPD.ui.gameScreen) PPD.show(PPD.ui.gameScreen, false);
      if (PPD.ui.menu) PPD.show(PPD.ui.menu, true);
      if (PPD.ui.pausePanel) PPD.show(PPD.ui.pausePanel, false);
      if (PPD.showTouch) PPD.showTouch(false);
    }
  }

  function closeAll() {
    player.active = false;
    player.playing = false;
    player.exporting = null;
    pendingVideo = null;
    historyDeleting = false;
    historySelected.clear();
    if (PPD) {
      if (PPD.ui.replayPanel) PPD.show(PPD.ui.replayPanel, false);
      if (PPD.ui.historyPanel) PPD.show(PPD.ui.historyPanel, false);
    }
  }

  // ---------- 历史比赛（并入个人生涯页「历史回放」标签 v2.2） ----------
  let historyItems = [];
  let historyDeleting = false;
  const historySelected = new Set();

  // 合并页标签切换：'career'=战绩记录 / 'history'=历史回放（高亮 + 显隐标签体）
  function showTab(name) {
    if (!PPD || !PPD.ui) return;
    const isHist = name === 'history';
    if (PPD.ui.btnCareerTab) PPD.ui.btnCareerTab.classList.toggle('active', !isHist);
    if (PPD.ui.btnHistoryTab) PPD.ui.btnHistoryTab.classList.toggle('active', isHist);
    if (PPD.ui.careerTab) PPD.show(PPD.ui.careerTab, !isHist);
    if (PPD.ui.historyPanel) PPD.show(PPD.ui.historyPanel, isHist);
  }
  function showCareerTab() { showTab('career'); }

  function historyTime(r) {
    const t = new Date(r.ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }

  function historyItemHtml(r) {
    const n = r.names || [];
    const main = `🎬 ${modeLbl(r.mode)} · ${escapeHtml(n[0] || '玩家1')} vs ${escapeHtml(n[1] || '玩家2')} · <b>${r.score[0]}:${r.score[1]}</b>`;
    const sub = `${historyTime(r)} · 时长 ${fmtDur(r.durationMs)}`;
    if (!historyDeleting) {
      return `<div class="history-item">
        <div class="history-main">${main}</div>
        <div class="history-sub">${sub}</div>
        <button type="button" class="btn small history-view" data-id="${escapeHtml(r.id)}">查看回放</button>
      </div>`;
    }
    const selected = historySelected.has(r.id);
    return `<div class="history-item selectable${selected ? ' selected' : ''}" data-id="${escapeHtml(r.id)}">
      <button type="button" class="history-check${selected ? ' checked' : ''}" data-id="${escapeHtml(r.id)}" aria-pressed="${selected ? 'true' : 'false'}">${selected ? '☑' : '☐'}</button>
      <div class="history-main">${main}</div>
      <div class="history-sub">${sub}</div>
    </div>`;
  }

  function renderHistory() {
    const el = PPD && PPD.ui && PPD.ui.historyList;
    if (!el) return;
    if (!historyItems.length) {
      el.innerHTML = '<div class="career-empty">暂无历史回放：完成任意一局（人机/双人/AI观战/联机）后自动保存</div>';
    } else {
      el.innerHTML = historyItems.map(historyItemHtml).join('');
    }
    updateHistoryDeleteUI();
  }

  function updateHistoryDeleteUI() {
    if (!PPD || !PPD.ui) return;
    if (PPD.ui.btnHistoryDelete) {
      PPD.ui.btnHistoryDelete.textContent = historyDeleting ? '取消删除' : '🗑 删除回放';
    }
    if (PPD.ui.historyDeleteBar) PPD.show(PPD.ui.historyDeleteBar, historyDeleting);
    if (PPD.ui.historyDeleteHint) {
      PPD.ui.historyDeleteHint.textContent = historyDeleting
        ? '点击条目选择要删除的回放，选好后点击“删除所选”'
        : '';
    }
    if (PPD.ui.btnHistoryDeleteConfirm) {
      PPD.ui.btnHistoryDeleteConfirm.disabled = !historySelected.size;
      PPD.ui.btnHistoryDeleteConfirm.textContent = historySelected.size
        ? `删除所选（${historySelected.size}）`
        : '删除所选';
    }
  }

  function toggleHistoryDeleteMode() {
    historyDeleting = !historyDeleting;
    historySelected.clear();
    renderHistory();
  }

  function toggleHistorySelection(id) {
    if (!historyDeleting) return;
    if (historySelected.has(id)) historySelected.delete(id);
    else historySelected.add(id);
    renderHistory();
  }

  async function confirmDeleteHistory() {
    if (!historySelected.size) {
      if (PPD && PPD.setStatus) PPD.setStatus('请先选择要删除的回放');
      return;
    }
    const ids = Array.from(historySelected);
    const ok = await confirmAsync('删除回放', `确定删除选中的 ${ids.length} 场回放吗？删除后无法恢复。`, '删除', '取消');
    if (!ok) return;
    let deleted = 0;
    for (const id of ids) {
      try { if (await remove(id)) deleted++; } catch (e) { /* 单条删除失败继续 */ }
    }
    historyDeleting = false;
    historySelected.clear();
    historyItems = await list();
    renderHistory();
    if (PPD && PPD.setStatus) PPD.setStatus(`已删除 ${deleted} 场回放`);
  }

  async function openHistory() {
    if (!PPD) return;
    // 网页版：与个人生涯一致整页禁用（回放数据仅本地存储，桌面/APK 不受影响）
    if (PPD.isWebVersion) {
      if (PPD.showOverlay) {
        PPD.showOverlay('个人生涯 · 探索中',
          '个人生涯（战绩记录与历史回放）网页版正在探索中，暂不对网页版开放。\n数据仅保存在本地应用端（桌面版 / 手机 APK）。',
          '知道了', () => {});
      }
      return;
    }
    const listAll = await list();
    historyItems = listAll;
    historyDeleting = false;
    historySelected.clear();
    renderHistory();
    // 并入个人生涯页：切到「历史回放」标签（页面保持打开，不单独开页）
    if (PPD.ui.careerPanel) PPD.show(PPD.ui.careerPanel, true);
    if (PPD.ui.menu) PPD.show(PPD.ui.menu, false);
    if (PPD.ui.replayPanel) PPD.show(PPD.ui.replayPanel, false);
    showTab('history');
  }

  function closeHistory() {
    if (!PPD) return;
    historyDeleting = false;
    historySelected.clear();
    showTab('career'); // 切回「战绩记录」标签（仍停留在个人生涯页）
  }

  // ---------- 视频 / 数据文件导出 ----------
  function supportsVideo() {
    try {
      return !!(PPD && PPD.canvas && PPD.canvas.captureStream &&
        typeof window !== 'undefined' && window.MediaRecorder);
    } catch (e) { return false; }
  }
  function pickMime() {
    const cands = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (const m of cands) {
      try {
        if (window.MediaRecorder && window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(m)) return m;
      } catch (e) { /* ignore */ }
    }
    return '';
  }
  function defaultVideoName() {
    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `乒乓对决回放_${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
  }

  function confirmAsync(title, text, okText, cancelText) {
    return new Promise((resolve) => {
      if (!PPD || !PPD.ui || !PPD.ui.overlay ||
          typeof document === 'undefined' || !document.createElement || !PPD.ui.overlayBtn.parentNode) {
        resolve(true);
        return;
      }
      const ui = PPD.ui;
      ui.overlayTitle.textContent = title;
      ui.overlayText.textContent = text;
      ui.overlayBtn.textContent = okText || '确定';
      let cancelBtn = document.getElementById('replayConfirmCancel');
      if (!cancelBtn) {
        cancelBtn = document.createElement('button');
        cancelBtn.id = 'replayConfirmCancel';
        cancelBtn.className = 'btn';
        cancelBtn.textContent = cancelText || '取消';
        cancelBtn.style.marginTop = '6px';
        ui.overlayBtn.parentNode.appendChild(cancelBtn);
      } else {
        cancelBtn.style.display = '';
      }
      const done = (v) => {
        ui.overlayBtn.onclick = null;
        if (cancelBtn) { cancelBtn.style.display = 'none'; cancelBtn.onclick = null; }
        PPD.show(ui.overlay, false);
        resolve(v);
      };
      ui.overlayBtn.onclick = () => done(true);
      cancelBtn.onclick = () => done(false);
      PPD.show(ui.overlay, true);
    });
  }

  async function saveVideo() {
    if (!player.active) {
      if (latest) {
        await openById(latest.id, 'gameover');
      } else {
        if (PPD && PPD.setStatus) PPD.setStatus('本局暂无回放数据');
        return;
      }
    }
    if (player.frames.length < 2) {
      setStatus('回放数据不足，无法导出');
      return;
    }
    if (!supportsVideo()) {
      setStatus('当前浏览器不支持录屏，将导出回放数据文件');
      exportDataFile();
      return;
    }
    const durTxt = fmtDur(player.durationMs);
    const tip = PPD && PPD.isTouch
      ? `将完整播放一遍回放并录制成视频（约 ${durTxt}）。\n录制完成后可一键分享/保存到手机相册或文件。`
      : `将完整播放一遍回放并录制成视频（约 ${durTxt}）。\n录制完成后将弹出「另存为」选择保存位置。`;
    const ok = await confirmAsync('保存回放视频', `${tip}\n期间请保持页面在前台，不要切换或关闭窗口。`, '开始录制', '取消');
    if (!ok) return;
    // 电脑端先选保存位置（需要用户手势），再开始录制
    let fileHandle = null;
    if (!(PPD && PPD.isTouch) && typeof window !== 'undefined' && window.showSaveFilePicker) {
      try {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: defaultVideoName() + '.webm',
          types: [{ description: 'WebM 视频', accept: { 'video/webm': ['.webm'] } }],
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    startExport(fileHandle);
  }

  function startExport(fileHandle) {
    const mime = pickMime();
    if (!mime) { exportDataFile(); return; }
    let stream;
    try { stream = PPD.canvas.captureStream(60); } catch (e) { exportDataFile(); return; }
    let recorder;
    try {
      recorder = new window.MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 });
    } catch (e) { exportDataFile(); return; }
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e && e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      try { if (stream.getTracks) stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
      const blob = new Blob(chunks, { type: mime });
      deliverVideo(blob, fileHandle);
    };
    player.exporting = { recorder, fileHandle };
    seekTo(0);
    player.playing = true;
    player.speed = 1;
    setStatus('正在录制回放视频… 播放完成后自动保存（请保持页面在前台）');
    try { recorder.start(250); } catch (e) { player.exporting = null; exportDataFile(); }
    updateControls();
  }

  async function deliverVideo(blob, fileHandle) {
    const name = defaultVideoName() + '.webm';
    if (fileHandle) {
      try {
        const w = await fileHandle.createWritable();
        await w.write(blob);
        await w.close();
        setStatus('回放视频已保存 ✓');
        return;
      } catch (e) { /* 落空则走下载 */ }
    }
    if (PPD && PPD.isTouch) {
      pendingVideo = { blob, name };
      const ok = await confirmAsync(
        '回放视频已生成',
        '视频已录制完成（WebM 格式）。点击「保存到相册」通过系统分享保存到相册/文件，或选择「直接下载」。',
        '保存到相册',
        '取消'
      );
      if (!ok) { setStatus('已取消保存'); return; }
      let file;
      try { file = new File([blob], name, { type: 'video/webm' }); }
      catch (e) {
        downloadBlob(blob, name);
        setStatus('已开始下载：请在浏览器下载管理中保存到相册/文件');
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: '乒乓对决回放', text: '乒乓对决赛后回放' });
          setStatus('已分享/保存 ✓');
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') { setStatus('已取消'); return; }
        }
      }
      downloadBlob(blob, name);
      setStatus('已开始下载：请在浏览器下载管理中保存到相册/文件');
      return;
    }
    downloadBlob(blob, name);
    setStatus('已开始下载回放视频（也可在浏览器下载管理中另存）');
  }

  function downloadBlob(blob, name) {
    if (typeof document === 'undefined' || !document.createElement || !document.body) return;
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 5000);
    } catch (e) { /* ignore */ }
  }

  function deliverVideoFallback() {
    if (PPD && PPD.setStatus) PPD.setStatus('视频生成失败，请重试或使用保存数据文件');
  }

  // 兜底：不支持录屏时导出回放数据文件（.ppd.json）
  async function exportDataFile() {
    if (!player.active && latest) await openById(latest.id, 'gameover');
    if (!player.active || !player.meta) return;
    const recObj = player.meta;
    const data = JSON.stringify({
      app: '乒乓对决回放',
      version: 1,
      exportedAt: Date.now(),
      meta: {
        mode: recObj.mode, names: recObj.names, score: recObj.score,
        winner: recObj.winner, durationMs: recObj.durationMs, ts: recObj.ts,
      },
      frames: player.frames.map(encodeSnap), // 保持压缩数组格式
    }, null, 0);
    let blob;
    try { blob = new Blob([data], { type: 'application/json' }); }
    catch (e) { setStatus('当前环境不支持导出文件'); return; }
    const name = defaultVideoName() + '.ppd.json';
    if (typeof window !== 'undefined' && window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: '乒乓对决回放数据', accept: { 'application/json': ['.json'] } }],
        });
        const w = await h.createWritable();
        await w.write(blob);
        await w.close();
        setStatus('回放数据已保存 ✓');
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') { setStatus('已取消保存'); return; }
      }
    }
    downloadBlob(blob, name);
    setStatus('已开始下载回放数据文件');
  }

  // ---------- UI 接线 ----------
  function wire() {
    if (!PPD) return;
    if (PPD.ui.btnHistoryTab) {
      PPD.ui.btnHistoryTab.addEventListener('click', () => {
        if (PPD.GameAudio && PPD.GameAudio.ensure) PPD.GameAudio.ensure();
        openHistory();
      });
    }
    if (PPD.ui.btnCareerTab) {
      PPD.ui.btnCareerTab.addEventListener('click', () => {
        if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui();
        showCareerTab();
      });
    }
    if (PPD.ui.btnHistoryDelete) {
      PPD.ui.btnHistoryDelete.addEventListener('click', () => {
        if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui();
        toggleHistoryDeleteMode();
      });
    }
    if (PPD.ui.btnHistoryDeleteConfirm) {
      PPD.ui.btnHistoryDeleteConfirm.addEventListener('click', () => {
        if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui();
        confirmDeleteHistory();
      });
    }
    if (PPD.ui.historyList) {
      PPD.ui.historyList.addEventListener('click', (e) => {
        if (historyDeleting) {
          const item = e.target && e.target.closest ? e.target.closest('.history-item[data-id]') : null;
          if (item && item.dataset && item.dataset.id) toggleHistorySelection(item.dataset.id);
          return;
        }
        const btn = e.target && e.target.closest ? e.target.closest('.history-view') : null;
        if (btn && btn.dataset && btn.dataset.id) {
          if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui();
          openById(btn.dataset.id, 'career'); // 从个人生涯页打开：关闭回放后回到生涯页
        }
      });
    }
    if (PPD.ui.btnReplay) {
      PPD.ui.btnReplay.addEventListener('click', () => {
        if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui();
        if (latest) openById(latest.id, 'gameover');
        else if (PPD.setStatus) PPD.setStatus('本局暂无回放数据');
      });
    }
    if (PPD.ui.btnSaveReplay) {
      PPD.ui.btnSaveReplay.addEventListener('click', () => {
        if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui();
        saveVideo();
      });
    }
    if (PPD.ui.btnReplayPlay) {
      PPD.ui.btnReplayPlay.addEventListener('click', () => {
        if (!player.active) return;
        if (player.t >= player.durationMs - 1) seekTo(0);
        player.playing = !player.playing;
        updateControls();
      });
    }
    if (PPD.ui.btnReplaySpeed) {
      PPD.ui.btnReplaySpeed.addEventListener('click', () => {
        if (!player.active) return;
        player.speed = player.speed >= 4 ? 1 : player.speed * 2;
        updateControls();
      });
    }
    if (PPD.ui.btnReplaySave) {
      PPD.ui.btnReplaySave.addEventListener('click', () => { saveVideo(); });
    }
    if (PPD.ui.replayProgress) {
      PPD.ui.replayProgress.addEventListener('input', () => {
        if (!player.active) return;
        const pct = parseInt(PPD.ui.replayProgress.value, 10) || 0;
        player.playing = false;
        seekTo((pct / 1000) * player.durationMs);
      });
    }
    if (PPD.ui.btnReplayBack) {
      PPD.ui.btnReplayBack.addEventListener('click', () => {
        if (PPD.GameAudio && PPD.GameAudio.ui) PPD.GameAudio.ui();
        closePlayer();
      });
    }
    // 键盘控制：空格 播放/暂停，←/→ 快退/快进 5 秒
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('keydown', (e) => {
        if (!player.active) return;
        if (e.code === 'Space') {
          e.preventDefault();
          if (player.t >= player.durationMs - 1) seekTo(0);
          player.playing = !player.playing;
          updateControls();
        } else if (e.code === 'ArrowLeft') {
          e.preventDefault();
          seekTo(player.t - 5000);
        } else if (e.code === 'ArrowRight') {
          e.preventDefault();
          seekTo(player.t + 5000);
        }
      });
    }
  }

  wire();

  // 暴露接口
  host.ReplayCodec = { encodeSnap, decodeSnap };
  if (PPD) {
    PPD.Replay = {
      begin, tick, recordOnline, finish, cancel,
      list, load, remove, openById, openPlayer, openHistory, closeHistory,
      closePlayer, closeAll, saveVideo, exportDataFile,
      isActive, frame, render, seekTo,
      showCareerTab, showTab,
      get latest() { return latest; },
    };
  }
  return host.ReplayCodec;
});
