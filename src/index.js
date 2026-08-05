/* ============================================================
 * index.js — 公网联机 Worker 入口
 * 校验 WebSocket 升级请求后转发到全局 GameRoom DO；
 * 其余请求返回简单信息（静态页面仍由 Cloudflare Pages 托管）。
 * ============================================================ */
'use strict';

import { GameRoom } from './room.js';

export { GameRoom };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 仅 WebSocket 升级请求转发给 DO（避免无效请求计入 DO 费用）
    if (request.headers.get('Upgrade') === 'websocket') {
      const id = env.GAME_ROOM.idFromName('global');
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    // 其他请求：状态/说明
    if (url.pathname === '/') {
      return new Response(
        JSON.stringify({ ok: true, service: 'ping-pong-ws', note: '乒乓对决公网联机 WebSocket 服务器' }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('Not Found', { status: 404 });
  },
};
