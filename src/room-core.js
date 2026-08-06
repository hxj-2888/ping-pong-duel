/* ============================================================
 * room-core.js — 房间核心逻辑（纯逻辑，不依赖 Cloudflare 运行时）
 * 镜像本地 server.js 的房间逻辑：create/join/in/rematch/ping、
 * 消息驱动模拟、快照广播、断线通知。
 * GameRoom Durable Object（room.js）薄包装委托本类。
 * 本模块可在 Node 中直接测试（test/do-smoke.js）。
 * ============================================================ */
'use strict';

import TT from './engine.js';

const TICK_HZ = 60;
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混 I/L/O/0/1

export class RoomCore {
  constructor() {
    this.rooms = new Map(); // code -> { engine, clients:[ws|null,ws|null], names:[,], lastSnap, lastStep }
  }

  // ---------- 消息处理 ----------
  handleMessage(ws, rawOrMsg, att) {
    let msg = rawOrMsg;
    if (typeof rawOrMsg === 'string') {
      try { msg = JSON.parse(rawOrMsg); } catch (e) { return; }
    } else if (rawOrMsg instanceof ArrayBuffer || rawOrMsg instanceof Uint8Array) {
      try { msg = JSON.parse(new TextDecoder().decode(rawOrMsg)); } catch (e) { return; }
    }
    if (!msg || typeof msg !== 'object') return;
    if (!att) att = {};
    // DO 驱逐恢复后，旧连接靠持久化的 attachment（room/side）重挂回席位
    if (att.room) {
      const r = this.rooms.get(att.room);
      if (r && att.side >= 0 && r.clients[att.side] !== ws) {
        const wasNull = r.clients[att.side] === null;
        r.clients[att.side] = ws;
        // 重挂时若对手已加入（房间满），补发 room 广播让该客户端从"等待中"进入对局
        // （驱逐期间加入方广播只发给了已挂载的连接，孤儿连接收不到）
        if (wasNull && r.slots[0] && r.slots[1]) {
          this.send(ws, { t: 'room', code: r.code, side: att.side, name: r.names[att.side] || '', wait: false });
        }
      }
    }
    if (msg.t === 'create') this.handleCreate(ws, msg, att);
    else if (msg.t === 'join') this.handleJoin(ws, msg, att);
    else if (msg.t === 'ping') this.send(ws, { t: 'pong', st: Date.now() });
    else if (att.room && msg.t === 'in') {
      const room = this.rooms.get(att.room);
      if (room && att.side >= 0) {
        // 输入位掩码 k（客户端压缩：8 键 → 1 数，位 0=l 1=r 2=pu 3=sm 4=f 5=b 6=crouch 7=run）；
        // 兼容旧客户端发 i 对象（未升级端仍可玩）
        let l = 0, r = 0, f = 0, b = 0, pu = 0, sm = 0, c = 0, rn = 0;
        if (typeof msg.k === 'number') {
          l = (msg.k & 1) ? 1 : 0;
          r = (msg.k & 2) ? 1 : 0;
          pu = (msg.k & 4) ? 1 : 0;
          sm = (msg.k & 8) ? 1 : 0;
          f = (msg.k & 16) ? 1 : 0;
          b = (msg.k & 32) ? 1 : 0;
          c = (msg.k & 64) ? 1 : 0;
          rn = (msg.k & 128) ? 1 : 0;
        } else {
          const i = msg.i || {};
          l = i.l ? 1 : 0; r = i.r ? 1 : 0; f = i.f ? 1 : 0; b = i.b ? 1 : 0;
          pu = i.pu ? 1 : 0; sm = i.sm ? 1 : 0; c = i.c ? 1 : 0; rn = i.rn ? 1 : 0;
        }
        TT.setInput(room.engine, att.side, {
          l, r, f, b, pu, sm,
          lb: c && pu, // 蹲下+推球 = 高吊（推球进阶技巧，服务端推导，无需新按键）
          crouch: c, run: rn,
        });
        // 鼠标/手指瞄准：目标落点（世界坐标）随输入帧上报，服务端求解发球方案并随快照返回
        if (Array.isArray(msg.a) && msg.a.length === 2) {
          const ax = Number(msg.a[0]), az = Number(msg.a[1]);
          if (Number.isFinite(ax) && Number.isFinite(az)) {
            TT.setServeAim(room.engine, att.side, ax, az);
          }
        }
      }
    } else if (att.room && msg.t === 'rematch') {
      const room = this.rooms.get(att.room);
      if (room && room.engine.phase === 'over') {
        TT.resetMatch(room.engine);
        this.broadcast(room, { t: 'rematch' });
      }
    }
    // 每次消息后推进引擎并广播（消息驱动 tick，替代 setInterval）
    if (att.room) this.stepRoom(this.rooms.get(att.room));
  }

  // ---------- 房间逻辑（镜像 server.js） ----------
  handleCreate(ws, msg, att) {
    if (att.room) return;
    const code = this.newRoomCode();
    const room = {
      code,
      engine: TT.createEngine(),
      slots: [false, false], // 已占用席位（持久化，驱逐恢复后据此分配/判满）
      clients: [null, null],
      names: ['', ''],
      lastSnap: '',
      lastStep: 0, // 初始为 0：首次 stepRoom 的 dt 被 clamp 到 0.05，保证首帧即步进
    };
    room.slots[0] = true;
    room.clients[0] = ws;
    room.names[0] = String(msg.name || '玩家1').slice(0, 12);
    this.setAtt(ws, { room: code, side: 0, name: room.names[0] });
    this.rooms.set(code, room);
    this.broadcast(room, { t: 'room', code, side: 0, name: room.names[0], wait: true });
    this.stepRoom(room);
  }

  handleJoin(ws, msg, att) {
    if (att.room) return;
    const code = String(msg.room || '').toUpperCase().trim();
    const room = this.rooms.get(code);
    if (!room) { this.send(ws, { t: 'error', e: '房间不存在' }); return; }
    if (room.slots[0] && room.slots[1]) { this.send(ws, { t: 'error', e: '房间已满' }); return; }
    const name = String(msg.name || '玩家2').slice(0, 12);
    const side = room.slots[0] ? 1 : 0;
    room.slots[side] = true;
    room.clients[side] = ws;
    room.names[side] = name;
    this.setAtt(ws, { room: code, side, name });
    this.broadcast(room, { t: 'room', code, side, name, wait: false });
    this.stepRoom(room);
  }

  newRoomCode() {
    const buf = new Uint32Array(1);
    for (let tries = 0; tries < 50; tries++) {
      let code = '';
      for (let i = 0; i < 4; i++) {
        crypto.getRandomValues(buf);
        code += CHARS[buf[0] % CHARS.length];
      }
      if (!this.rooms.has(code)) return code;
    }
    return 'ABCD';
  }

  // ---------- 模拟推进 + 快照广播（消息驱动，按真实时间差追赶固定步长） ----------
  // 与本地 server.js（60Hz setInterval 恒定步进）保持一致：无论消息多稀疏/密集，
  // 都按真实时间差拆成 1/60 固定步长推进，物理稳定 60Hz、游戏时间不落后于墙钟。
  // 原先"clamp 单帧"的问题：消息间隔 >50ms 时 dt 被压到 0.05 → 游戏时间比真实慢
  // （球速变慢、操作延迟——公网联机"能进但很卡"的直接原因）。
  stepRoom(room) {
    if (!room) return;
    const now = Date.now();
    const step = 1 / TICK_HZ; // 固定 60Hz 步长（与本地 server.js 一致）
    let remaining = (now - room.lastStep) / 1000;
    room.lastStep = now;
    // 上限：长时间无消息（DO 休眠/网络中断）只追 0.5s，避免恢复时瞬间追赶爆炸
    if (remaining > 0.5) remaining = 0.5;
    let n = 0;
    while (remaining >= step && n < 60) {
      TT.step(room.engine, step);
      remaining -= step;
      n++;
    }
    // 即使消息密集（同毫秒多次），至少推进一帧，保证引擎持续推进（首帧即步进）
    if (n === 0 && remaining >= 0) TT.step(room.engine, step);
    const snap = TT.snapshot(room.engine);
    const data = JSON.stringify({ t: 'state', s: snap, n: room.names, my: -1 });
    if (data !== room.lastSnap) {
      room.lastSnap = data;
      for (const c of room.clients) if (c) this.send(c, data);
    }
    // 双方都空则删房
    if (!room.slots[0] && !room.slots[1]) this.rooms.delete(room.code);
  }

  // ---------- 断线处理（镜像 leaveRoom） ----------
  handleClose(ws, att) {
    const codeStr = att && att.room;
    if (!codeStr) return;
    const room = this.rooms.get(codeStr);
    if (!room) return;
    // 优先用 attachment 里的 side（驱逐恢复后 clients 可能还是 null，indexOf 找不到）
    const idx = att.side >= 0 ? att.side : room.clients.indexOf(ws);
    if (idx >= 0) {
      room.clients[idx] = null;
      room.slots[idx] = false;
      room.names[idx] = '';
    }
    // 对方按 slots 判断（驱逐恢复后对方可能尚未重挂，clients 为空，但席位仍在）
    const otherIdx = room.slots[0] ? 0 : (room.slots[1] ? 1 : -1);
    const other = otherIdx >= 0 ? room.clients[otherIdx] : null;
    if (other) {
      this.send(other, { t: 'peer_left', side: idx });
      const snap = TT.snapshot(room.engine);
      const att2 = this.getAtt(other) || {};
      this.send(other, { t: 'state', s: snap, n: room.names, my: att2.side });
      this.stepRoom(room);
    } else if (otherIdx < 0) {
      this.rooms.delete(codeStr);
    }
  }

  // ---------- 持久化（DO 驱逐恢复） ----------
  // 序列化所有房间（不含 WebSocket 引用；席位占用用 slots 记录）。
  serialize() {
    const arr = [];
    for (const room of this.rooms.values()) {
      arr.push({
        code: room.code,
        engine: room.engine,
        slots: room.slots,
        names: room.names,
        lastSnap: room.lastSnap,
        lastStep: room.lastStep,
      });
    }
    return arr;
  }

  // 从持久化数据重建房间；clients 置空，等旧连接的下一条消息按 attachment 重挂
  restore(arr) {
    this.rooms.clear();
    for (const r of arr || []) {
      if (!r || !r.code || !r.slots || (!r.slots[0] && !r.slots[1])) continue;
      this.rooms.set(r.code, {
        code: r.code,
        engine: r.engine,
        slots: r.slots,
        clients: [null, null],
        names: r.names || ['', ''],
        lastSnap: r.lastSnap || '',
        lastStep: r.lastStep || 0,
      });
    }
  }

  // ---------- 发送工具（子类可覆写以适配 DO WebSocket） ----------
  send(ws, data) {
    try {
      if (ws && ws.readyState === 1) { // WebSocket.OPEN
        ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      }
    } catch (e) { /* ignore */ }
  }

  broadcast(room, msg) {
    const data = JSON.stringify(msg);
    for (const c of room.clients) if (c) this.send(c, data);
  }

  // 连接附加状态（子类可覆写：DO 用 serializeAttachment）
  setAtt(ws, att) {
    if (ws && ws.serializeAttachment) ws.serializeAttachment(att);
  }
  getAtt(ws) {
    if (ws && ws.deserializeAttachment) return ws.deserializeAttachment() || {};
    return {};
  }
}
