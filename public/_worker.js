/* ============================================================
 * _worker.js — Cloudflare Pages 高级模式入口（公网联机）
 * 同一域名同时提供：静态页面（ASSETS 回退）+ WebSocket 联机（DO）。
 * 域名：ping-pong-duel.pages.dev
 * 说明：原方案 workers.dev 域名在国内网络被 DNS 污染（解析到
 * 无效 IP），页面能开但 WS 连不上；改为挂在 pages.dev 同域下，
 * 客户端 WS 地址 = 页面地址 + '/ws'，无需硬编码域名。
 * ============================================================ */
'use strict';

import { GameRoom } from '../src/room.js';

export { GameRoom };

export default {
  async fetch(request, env, ctx) {
    // 通关记录 HTTP API → 转发到全局 GameRoom DO（静态资源回退之前）
    if (new URL(request.url).pathname.startsWith('/api/')) {
      const id = env.GAME_ROOM.idFromName('global');
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // WebSocket 升级 → 转发到全局 GameRoom DO
    // v2.7.0-fix:已回退 DO 分片——按每客户端随机 ?k= 路由会让 host/guest 落到不同实例导致
    // "房间不存在"（实测）；统一走全局实例（v2.6 行为）。分片需"房间码级路由"设计，留待后续。
    if (request.headers.get('Upgrade') === 'websocket') {
      const id = env.GAME_ROOM.idFromName('global');
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // 其余请求 → 静态资源（游戏页面、音效、图片等）
    return env.ASSETS.fetch(request);
  },
};
