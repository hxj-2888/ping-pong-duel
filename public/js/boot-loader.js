/* boot-loader.js — 进场加载门（2026-11-15）
 * 图像与音频全部就绪后再放行主菜单；`?boot=off` / `?auto=*` / `?net=public` /
 * webdriver 自动化直接跳过，避免截图与探测工具被遮罩挡住。
 * 只做加载与遮罩，不碰玩法状态；失败可重试，online 时自动再试。
 */
(function () {
  'use strict';
  var BYPASS = /[?&]boot=off\b/.test(location.search) ||
    /[?&]auto=/.test(location.search) || /[?&]net=public\b/.test(location.search) ||
    !!(navigator && navigator.webdriver);
  var IMAGES = ['assets/arena/arena_plate.jpg', 'icon-192.png', 'icon-512.png'];
  var AUDIO = ['audio/music.mp4', 'audio/applause.wav'];
  var RETRY_MAX = 3;
  var IMG = {}, AUD = {}, IMG_ST = {}, AUD_ST = {};
  var ready = false, finished = false, listeners = [];

  function $(id) { return document.getElementById(id); }
  function count() {
    var i = { total: IMAGES.length, done: 0, failed: 0 };
    var a = { total: AUDIO.length, done: 0, failed: 0 };
    IMAGES.forEach(function (u) { var s = IMG_ST[u]; if (s && s.ok) i.done++; else if (s && s.failed) i.failed++; });
    AUDIO.forEach(function (u) { var s = AUD_ST[u]; if (s && s.ok) a.done++; else if (s && s.failed) a.failed++; });
    return { img: i, aud: a };
  }
  function progress() {
    var c = count(), total = c.img.total + c.aud.total, done = c.img.done + c.aud.done;
    var failed = c.img.failed + c.aud.failed;
    return { pct: total ? Math.floor(done * 100 / total) : 0,
      ready: done === total && total > 0, failed: failed,
      pending: Math.max(0, total - done - failed), img: c.img, aud: c.aud };
  }
  function notify() {
    listeners.forEach(function (fn) { try { fn(progress()); } catch (e) {} });
  }
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  function loadImage(src, n) {
    n = n | 0;
    IMG_ST[src] = { n: n, ok: false, failed: false };
    var im = new Image();
    IMG[src] = im;
    im.onload = function () {
      IMG_ST[src] = { n: n, ok: true, failed: false };
      notify();
    };
    im.onerror = function () {
      if (n >= RETRY_MAX) { IMG_ST[src] = { n: n, ok: false, failed: true }; notify(); return; }
      setTimeout(function () { loadImage(src, n + 1); }, 600 * Math.pow(2, n));
    };
    im.src = src + (n && /^https?:/.test(location.protocol) ? '?r=' + n : '');
  }

  function loadAudio(src, n) {
    n = n | 0;
    var el = AUD[src];
    if (!el) {
      el = src === 'audio/music.mp4' ? $('bgmAudio') : src === 'audio/applause.wav' ? $('applauseAudio') : null;
      if (!el) {
        el = new Audio();
        AUD[src] = el;
      } else {
        AUD[src] = el;
      }
    }
    AUD_ST[src] = { n: n, ok: false, failed: false };
    var settled = false, timer = 0;
    function settle(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      AUD_ST[src] = { n: n, ok: !!ok, failed: !ok };
      notify();
    }
    function check() { if (el.readyState >= 4) settle(true); }
    el.preload = 'auto';
    el.addEventListener('canplaythrough', function () { settle(true); });
    el.addEventListener('loadeddata', check);
    el.addEventListener('progress', check);
    el.addEventListener('error', function () {
      if (settled) return;
      if (n >= RETRY_MAX) { settle(false); return; }
      setTimeout(function () { loadAudio(src, n + 1); }, 600 * Math.pow(2, n));
    });
    timer = setTimeout(function () {
      /* 少数移动浏览器不触发 canplaythrough：有可播数据（>=3）就放行。 */
      if (settled) return;
      settle(el.readyState >= 3);
    }, 20000);
    if (!el.getAttribute('src') || n) {
      el.src = src + (n && /^https?:/.test(location.protocol) ? '?r=' + n : '');
      try { el.load(); } catch (e) {}
    }
    if (el.readyState >= 4) settle(true);
  }

  function retryFailed() {
    IMAGES.forEach(function (src) { if (IMG_ST[src] && IMG_ST[src].failed) loadImage(src, 0); });
    AUDIO.forEach(function (src) { if (AUD_ST[src] && AUD_ST[src].failed) loadAudio(src, 0); });
    notify();
  }

  function blockKey(e) {
    if (e.key === 'F5' || e.key === 'F12' || (e.ctrlKey && /^(r|R)$/.test(e.key))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function boot() {
    var box = $('bootLoad'), bar = $('bootBar'), txt = $('bootText'), retry = $('bootRetry');
    if (!box) return;
    if (BYPASS) {
      box.hidden = true;
      document.body.classList.remove('boot-lock');
      ready = true;
      window.PPD_BOOT = { ready: true, progress: progress, retry: retryFailed };
      return;
    }
    document.body.classList.add('boot-lock');
    document.addEventListener('keydown', blockKey, true);
    onChange(function (p) {
      if (bar) bar.style.width = Math.max(0, Math.min(100, p.pct)) + '%';
      var bad = p.failed > 0 && p.pending === 0;
      if (txt) txt.textContent = p.ready ? '素材已就绪 · 准备开始'
        : bad ? ('有 ' + p.failed + ' 项素材未就绪 · 点击重试')
          : ('正在加载素材 ' + p.pct + '% · 图像 ' + p.img.done + '/' + p.img.total +
             ' · 音频 ' + p.aud.done + '/' + p.aud.total);
      if (retry) retry.hidden = !bad;
      if (box) { box.classList.toggle('ok', p.ready); box.classList.toggle('bad', bad); }
      if (p.ready && !finished) {
        finished = true;
        ready = true;
        if (window.PPD_BOOT) window.PPD_BOOT.ready = true;
        document.removeEventListener('keydown', blockKey, true);
        document.body.classList.remove('boot-lock');
        setTimeout(function () {
          box.classList.add('is-done');
          setTimeout(function () { box.hidden = true; }, 420);
        }, 180);
      }
    });
    if (retry) retry.onclick = function () { retry.hidden = true; retryFailed(); };
    window.addEventListener('online', retryFailed);
    window.PPD_BOOT = { ready: false, progress: progress, retry: retryFailed };
    IMAGES.forEach(function (src) { loadImage(src, 0); });
    AUDIO.forEach(function (src) { loadAudio(src, 0); });
    notify();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
