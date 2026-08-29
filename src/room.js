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
const DIAG_KEY = 'diag'; // 诊断日志（驱逐恢复排查）
const RECORDS_CAP = 60; // 个人生涯：后端留最近 60 条战绩
// v2.7.0-fix:Alarm 安全 tick 间隔 100→50（v2.7 从 v2.1 的 50 改大到 100，空闲期广播地板掉到 10Hz，
// 是公网实测快照率 11.5~18Hz 低于设计 20Hz 的成因之一）；恢复 50ms 保 20Hz 数据流地板
const ALARM_MS = 50;
// 安全上限（审计 2026-08-29）：
//   - 单 IP 并发连接 ≤8（防单点连接洪水挤占全局单 DO）
//   - 单连接消息速率：突发 400 条、持续 120 条/秒（正常客户端输入 ≤60Hz，只打击滥用）
const MAX_SOCKETS_PER_IP = 8;
const RATE_CAP = 400;
const RATE_REFILL_PER_SEC = 120;

// 诊断日志里的 4 位房间码统一脱敏：/api/diag 公开可读（审计 M1），
// 排障需要的形状信息（事件类型/side/数量）保留，房间码一律打码
function maskCodes(s) {
  return s.replace(/room=[A-Z0-9]{4}/g, 'room=****').replace(/\b[A-Z0-9]{4}(?=#)/g, '****');
}

// 追加诊断日志（最多 50 条）
async function diag(ctx, s) {
  try {
    const arr = (await ctx.storage.get(DIAG_KEY)) || [];
    arr.push(maskCodes(Date.now() + ' ' + s));
    if (arr.length > 50) arr.splice(0, arr.length - 50);
    await ctx.storage.put(DIAG_KEY, arr);
  } catch (e) { /* ignore */ }
}

// 校验并规整一条通关记录
function sanitizeRecord(b) {
  if (!b || typeof b !== 'object') return null;
  // 审计 #3:名字存储型 XSS——服务端剔除 < > 字符(前端渲染另有转义兜底,双保险)
  const name = String(b.name || '玩家').replace(/[<>]/g, '').slice(0, 20);
  const mode = b.mode === 'ai' || b.mode === 'local' || b.mode === 'online' ? b.mode : 'other';
  const winner = b.winner === 0 ? 0 : 1;
  const sc = Array.isArray(b.score)
    ? b.score.slice(0, 2).map((v) => Math.max(0, Math.min(99, Math.round(Number(v) || 0))))
    : [0, 0];
  const difficulty = [0, 1, 2, 3].includes(Number(b.difficulty)) ? Number(b.difficulty) : 1;
  const ts = Number(b.ts) || Date.now();
  return { id: ts + '_' + Math.random().toString(36).slice(2, 8), name, mode, winner, score: sc, difficulty, ts };
}

// 审计 M3(2026-08-29):POST /api/records 写入限流（按 CF-Connecting-IP，滚动 60s 窗口）。
// 与本地 server.js 同策略：DELETE 已有 RECORDS_TOKEN 保护，POST 原本对公网完全开放，
// 任何人可循环写入，60 条上限(RECORDS_CAP)会被垃圾数据挤满、真实战绩被顶掉。
// 默认 20 条/分钟/IP；Map 附带过期清理，避免随 IP 数无界增长。
const RECORDS_POST_LIMIT = 20;
const recordsPostHits = new Map();
function recordsPostLimited(request) {
  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const hits = (recordsPostHits.get(ip) || []).filter((t) => now - t < 60000);
  if (hits.length >= RECORDS_POST_LIMIT) { recordsPostHits.set(ip, hits); return true; }
  hits.push(now);
  recordsPostHits.set(ip, hits);
  if (recordsPostHits.size > 1000) {
    for (const [k, v] of recordsPostHits) {
      if (!v.length || now - v[v.length - 1] > 60000) recordsPostHits.delete(k);
    }
  }
  return false;
}

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.core = new RoomCore();
    this.loaded = false;
    this.loadPromise = null;
    this._alarmPending = false;
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
    if (url.pathname !== '/api/records' && url.pathname !== '/api/diag') {
      return new Response(JSON.stringify({ ok: false, e: 'not found' }), { status: 404, headers: cors });
    }
    if (url.pathname === '/api/diag') {
      // 读取时再脱敏一次：历史版本写入的条目可能仍含房间码
      const arr = ((await this.ctx.storage.get(DIAG_KEY)) || []).map(maskCodes);
      return new Response(JSON.stringify({ ok: true, diag: arr }), { headers: cors });
    }
    if (request.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '60', 10) || 60, 100);
      const list = (await this.ctx.storage.get(RECORDS_KEY)) || [];
      return new Response(JSON.stringify({ ok: true, records: list.slice(0, limit) }), { headers: cors });
    }
    if (request.method === 'POST') {
      // 审计 M3:公网可写接口加限流，防刷垃圾战绩顶掉真实记录（见 recordsPostLimited）
      if (recordsPostLimited(request)) {
        return new Response(JSON.stringify({ ok: false, e: '写入过于频繁，请稍后再试' }), {
          status: 429, headers: Object.assign({ 'Retry-After': '60' }, cors),
        });
      }
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
      // 按 id 删除一条记录（维护用）。审计 #18:公网 DELETE 无鉴权 → 任何人可任意删改战绩。
      // 需 ?token= 匹配环境变量 RECORDS_TOKEN(wrangler secret 绑定);未配置时一律拒绝删除(只读保护)。
      const want = this.env.RECORDS_TOKEN;
      if (!want || url.searchParams.get('token') !== want) {
        return new Response(JSON.stringify({ ok: false, e: 'forbidden' }), { status: 403, headers: cors });
      }
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
        if (data) {
          this.core.restore(data);
          await diag(this.ctx, '_load 恢复房间数=' + this.core.rooms.size);
        } else {
          await diag(this.ctx, '_load storage 无房间数据');
        }
        this.loaded = true;
      })();
    }
    await this.loadPromise;
  }

  // 每次状态变更后落盘（供驱逐恢复）；2h TTL 自动清理僵尸房间
  // （如房主断线未触发 webSocketClose、席位卡死的情况）
  // 节流：每消息都写 storage 会拖慢消息处理（SQLite 写 + engine 全量序列化），
  // 60Hz 输入下即每秒几十次写——联机卡顿主因之一。改为 2s 窗口内只落盘一次；
  // 断线（webSocketClose）时强制保存，驱逐恢复容忍丢最近 2s 状态（连接重挂后快照补齐）。
  async _save(force) {
    if (!this.loaded) return;
    const now = Date.now();
    if (!force && this.lastSaveAt && now - this.lastSaveAt < 2000) return;
    this.lastSaveAt = now;
    try {
      await this.ctx.storage.put(STORAGE_KEY, this.core.serialize(), { expirationTtl: 7200 });
    } catch (e) {
      // storage 失败不阻断消息处理（房间仍在内存中）
    }
  }

  // ---------- Alarm 兜底驱动 ----------
  // 消息驱动 tick 在客户端停发消息时会停摆（半死连接/后台节流/驱逐），表现为"进房间后卡死"。
  // Alarm 每 50ms 唤醒一次：推进物理 + 兜底广播（≥2Hz 快照）+ 断线/僵尸席位清扫。
  // 有房间存活时自我续期；全部房间空后停止（不钉住 DO 计费）。
  _armAlarm() {
    if (this._alarmPending) return;
    this._alarmPending = true;
    try { this.ctx.storage.setAlarm(Date.now() + ALARM_MS); } catch (e) { this._alarmPending = false; }
  }

  async alarm() {
    this._alarmPending = false;
    await this._load();
    const res = this.core.tickAll(Date.now());
    for (const n of res.notes) await diag(this.ctx, n);
    await this._save(false);
    if (res.alive > 0) this._armAlarm();
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
    // 单 IP 并发连接上限（审计 M2）：全局单 DO，防单点连接洪水
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    let perIp = 0;
    for (const s of this.ctx.getWebSockets()) {
      try {
        const a = s.deserializeAttachment ? s.deserializeAttachment() : null;
        if (a && a.ip === ip) perIp++;
      } catch (e) { /* 附件缺失按不计入 */ }
    }
    if (perIp >= MAX_SOCKETS_PER_IP) {
      return new Response('too many connections from this IP', { status: 429 });
    }
    // 用 Hibernation API 接受连接：空闲可休眠，不钉住 DO 计费
    this.ctx.acceptWebSocket(server);
    // 初始无归属（create/join 后由 webSocketMessage 设置 attachment）
    server.serializeAttachment({ room: null, side: -1, name: '', ip });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- 消息处理（委托 RoomCore） ----------
  async webSocketMessage(ws, raw) {
    // 消息速率上限（审计 M2）：令牌桶，突发 400 / 持续 120 条每秒；超限直接断开（1008 策略违规）。
    // 限流状态放内存 WeakMap——休眠唤醒后重置，滥用者重新积累也只有突发额度。
    if (!this._rate) this._rate = new WeakMap();
    const now = Date.now();
    let bucket = this._rate.get(ws);
    if (!bucket) {
      bucket = { tokens: RATE_CAP, ts: now };
      this._rate.set(ws, bucket);
    }
    bucket.tokens = Math.min(RATE_CAP, bucket.tokens + ((now - bucket.ts) / 1000) * RATE_REFILL_PER_SEC);
    bucket.ts = now;
    if (bucket.tokens < 1) {
      try { ws.close(1008, 'rate limit'); } catch (e) { /* already closed */ }
      return;
    }
    bucket.tokens -= 1;
    await this._load();
    const att = ws.deserializeAttachment() || {};
    const notes = this.core.handleMessage(ws, raw, att) || [];
    // 诊断事件（重挂/接管等，均为低频，直接落盘不影响 60Hz 消息处理）
    for (const n of notes) await diag(this.ctx, n);
    // 节流落盘：2s 窗口内只写一次（60Hz 输入下避免每消息写 storage——卡顿主因）。
    // 原每消息 diag 日志同样每消息读写 storage，已移除（驱逐问题已修复并验证）
    await this._save(false);
    // 建房/加入后确保 Alarm 续期：消息停摆时由 Alarm 兜底推进/广播/清扫
    this._armAlarm();
  }

  // ---------- 断线处理（委托 RoomCore） ----------
  async webSocketClose(ws, code, reason, wasClean) {
    await this._load();
    const att = ws.deserializeAttachment() || {};
    this.core.handleClose(ws, att);
    await diag(this.ctx, 'close code=' + code + ' reason=' + (reason || '') + ' side=' + att.side);
    await this._save(true); // 断线强制落盘（席位清空立即持久化，避免恢复后房间还占着）
    this._armAlarm();
  }

  // ---------- 连接错误（Hibernation 下 socket 错误不触发 close 时兜底） ----------
  async webSocketError(ws, error) {
    await this._load();
    const att = ws.deserializeAttachment() || {};
    await diag(this.ctx, 'ws error side=' + att.side);
    try { ws.close(1011, 'ws error'); } catch (e) { /* ignore */ }
    this.core.handleClose(ws, att);
    await this._save(true);
    this._armAlarm();
  }
}
