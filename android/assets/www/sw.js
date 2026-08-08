/* ============================================================
 * sw.js — 乒乓对决 Service Worker（PWA：安装到主屏幕 / 离线兜底）
 * 策略：网络优先 + 缓存兜底（游戏文件随版本更新，网络优先避免缓存旧版）。
 * 仅缓存 GET 静态资源；API（/api/*）与 WebSocket 一律直连不缓存。
 * 注意：Service Worker 仅在 https（或 localhost）下生效；
 *       纯 http 的 ECS 端不会注册（浏览器限制），清单/图标仍提供主屏快捷方式。
 * ============================================================ */
'use strict';

const CACHE = 'ppd-v4'; // v1.6.2：缓存名递增，强制各端（桌面/网页/APK）刷新旧 Service Worker 预缓存（应用壳）

// 首次安装：预缓存应用外壳（核心文件；失败不阻塞安装）
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll([
        './',
        './index.html',
        './css/style.css',
        './js/engine/rules.js',
        './js/engine/math.js',
        './js/engine/state.js',
        './js/engine/physics.js',
        './js/engine/shots.js',
        './js/engine/strokes.js',
        './js/engine.js',
        './js/render.js',
        './js/characters.js',
        './js/network.js',
        './js/audio.js',
        './js/ai.js',
        './js/app/state.js',
        './js/app/records.js',
        './js/app/input.js',
        './js/app/render.js',
        './js/app/hud.js',
        './js/app/net.js',
        './js/app/modes.js',
        './js/app/loop.js',
        './js/app/main.js',
        './manifest.webmanifest',
        './icon-192.png',
        './icon-512.png',
      ]))
      .catch(() => { /* 个别资源失败不阻塞安装 */ })
  );
  self.skipWaiting();
});

// 清理旧缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 网络优先 + 缓存兜底；API/非 GET 直连
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // API 不缓存
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
