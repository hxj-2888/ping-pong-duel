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
const RECORDS_KEY = 'records'; // 通关记录（全局单实例，无 TTL 永久保存）
const RECORDS_CAP = 200;

// 校验并规整一条通关记录
function sanitizeRecord(b) {
  if (!b || typeof b !== 'object') return null;
  const name = String(b.name || '玩家').slice(0, 20);
  const mode = b.mode === 'ai' ? 'ai' : 'other';
  const winner = b.winner === 0 ? 0 : 1;
  const sc = Array.isArray(b.score)
    ? b.score.slice(0, 2).map((v) => Math.max(0, Math.min(99, Math.round(Number(v) || 0))))
    : [0, 0];
  const difficulty = [0, 1, 2, 3].includes(Number(b.difficulty)) ? Number(b.difficulty) : 1;
  const ts = Number(b.ts) || Date.now();
  return { id: ts + '_' + Math.random().toString(36).slice(2, 8), name, mode, winner, score: sc, difficulty, ts };
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.core = new RoomCore();
    this.loaded = false;
    this.loadPromise = null;
  }

  // ---------- HTTP API：通关记录（GET/POST/DELETE /api/records，CORS 兼容桌面公网跨域） ----------
  async _handleApi(request) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname !== '/api/records') {
      return new Response(JSON.stringify({ ok: false, e: 'not found' }), { status: 404, headers: cors });
    }
    if (request.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 100);
      const list = (await this.ctx.storage.get(RECORDS_KEY)) || [];
      return new Response(JSON.stringify({ ok: true, records: list.slice(0, limit) }), { headers: cors });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, e: 'bad json' }), { status: 400, headers: cors });
      }
      const rec = sanitizeRecord(body);
      if (!rec) {
        return new Response(JSON.stringify({ ok: false, e: 'invalid' }), { status: 400, headers: cors });
      }
      const list = (await this.ctx.storage.get(RECORDS_KEY)) || [];
      list.unshift(rec);
      if (list.length > RECORDS_CAP) list.length = RECORDS_CAP;
      await this.ctx.storage.put(RECORDS_KEY, list); // 无 TTL：永久保存
      return new Response(JSON.stringify({ ok: true, id: rec.id }), { headers: cors });
    }
    if (request.method === 'DELETE') {
      // 按 id 删除一条记录（维护用；无鉴权，轻量榜单可接受）
      const id = url.searchParams.get('id');
      if (!id) {
        return new Response(JSON.stringify({ ok: false, e: 'no id' }), { status: 400, headers: cors });
      }
      const list = (await this.ctx.storage.get(RECORDS_KEY)) || [];
      const next = list.filter((r) => r && r.id !== id);
      const removed = list.length - next.length;
      if (removed > 0) await this.ctx.storage.put(RECORDS_KEY, next);
      return new Response(JSON.stringify({ ok: true, removed }), { headers: cors });
    }
    return new Response(JSON.stringify({ ok: false, e: 'method' }), { status: 405, headers: cors });
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

  // ---------- WebSocket 升级入口（Hibernation API）+ HTTP API ----------
  async fetch(request) {
    // 通关记录 HTTP API（不经过房间 _load/_save）
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return this._handleApi(request);
    }
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
