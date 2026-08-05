/* ============================================================
 * room.js — GameRoom Durable Object：公网联机房间服务器
 * 使用 WebSocket Hibernation API，逻辑委托给 RoomCore（room-core.js）。
 * 全局单 DO（idFromName('global')），客户端协议与本地 server.js 兼容。
 * 房间持久化到 DO storage（SQLite）：DO 被休眠驱逐后（约 30s 无消息），
 * 重启实例从 storage 恢复房间，旧连接靠持久化的 attachment 重挂回席位。
 * ============================================================ */
'use strict';

import { DurableObject } from 'cloudflare:workers';
import { RoomCore } from './room-core.js';

const STORAGE_KEY = 'rooms';

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.core = new RoomCore();
    this.loaded = false;
    this.loadPromise = null;
  }

  // 首次使用前从 storage 恢复房间（幂等）
  async _load() {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const data = await this.ctx.storage.get(STORAGE_KEY);
        if (data) this.core.restore(data);
        this.loaded = true;
      })();
    }
    await this.loadPromise;
  }

  // 每次状态变更后落盘（供驱逐恢复）；2h TTL 自动清理僵尸房间
  // （如房主断线未触发 webSocketClose、席位卡死的情况）
  async _save() {
    if (!this.loaded) return;
    try {
      await this.ctx.storage.put(STORAGE_KEY, this.core.serialize(), { expirationTtl: 7200 });
    } catch (e) {
      // storage 失败不阻断消息处理（房间仍在内存中）
    }
  }

  // ---------- WebSocket 升级入口（Hibernation API） ----------
  async fetch(request) {
    await this._load();
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return new Response('ping-pong ws: 仅接受 WebSocket 连接', { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // 用 Hibernation API 接受连接：空闲可休眠，不钉住 DO 计费
    this.ctx.acceptWebSocket(server);
    // 初始无归属（create/join 后由 webSocketMessage 设置 attachment）
    server.serializeAttachment({ room: null, side: -1, name: '' });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- 消息处理（委托 RoomCore） ----------
  async webSocketMessage(ws, raw) {
    await this._load();
    const att = ws.deserializeAttachment() || {};
    this.core.handleMessage(ws, raw, att);
    await this._save();
  }

  // ---------- 断线处理（委托 RoomCore） ----------
  async webSocketClose(ws, code, reason, wasClean) {
    await this._load();
    const att = ws.deserializeAttachment() || {};
    this.core.handleClose(ws, att);
    await this._save();
  }
}
