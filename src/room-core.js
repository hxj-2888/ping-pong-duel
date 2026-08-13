/* ============================================================
 * room-core.js — 房间核心逻辑（纯逻辑，不依赖 Cloudflare 运行时）
 * 镜像本地 server.js 的房间逻辑：create/join/in/rematch/ping、
 * 消息驱动模拟、快照广播、断线通知。
 * GameRoom Durable Object（room.js）薄包装委托本类。
 * 本模块可在 Node 中直接测试（test/do-smoke.js）。
 * ============================================================ */
'use strict';

import TT from './engine.js';

const TICK_HZ = 60; // 物理模拟固定步长：不要调小！
// 调低会破坏发球/碰撞判定（引擎 step 内部把 dt clamp 到 0.05：TICK_HZ=10 时每步只推进 0.05s，
// 引擎时间只剩 0.5x 慢动作，且 0.1s 大步长下台面碰撞/发球合法性校验失准——公网"进房卡死/发不出球"的直接原因）。
// 节省 CPU 靠的是下面的广播节流，而不是降低物理步长。
const BROADCAST_HZ = 20; // 快照广播速率：物理仍 60Hz 内部步进，广播节流到 20Hz（省带宽/CPU）。
// 20Hz 是公网手感的关键：插值窗口 50ms、对手渲染更平滑；CPU 开销远低于输入消息量，实测无压力。
// 客户端 net.js 的 INTERP_MS 必须与 1000/BROADCAST_HZ 一致（50ms）。
const BROADCAST_MS = 1000 / BROADCAST_HZ; // 100ms：相邻快照间隔，客户端据此插值平滑
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混 I/L/O/0/1

// 校验并规整客户端上报的装扮(联机皮肤同步 v2.0):只接受白名单 id,防注入
function sanitizeSkin(s) {
  if (!s || typeof s !== 'object') return null;
  const ok = { trail: null, paddle: null, shirt: null, splash: false };
  if (typeof s.trail === 'string' && /^(yellow|black|red)$/.test(s.trail)) ok.trail = s.trail;
  if (typeof s.paddle === 'string' && /^(skinA|skinB|skinC)$/.test(s.paddle)) ok.paddle = s.paddle;
  if (typeof s.shirt === 'string' && /^(green|purple|orange|cyan)$/.test(s.shirt)) ok.shirt = s.shirt;
  ok.splash = !!s.splash;
  return ok;
}

export class RoomCore {
  constructor() {
    this.rooms = new Map(); // code -> { engine, clients:[ws|null,ws|null], names:[,], lastSnap, lastStep }
  }

  // 时间源（默认 Date.now；测试可覆写 RoomCore._clock 为可推进的假时钟，
  // 保证消息驱动步进在同步 feed 下也按真实 60Hz 间隔推进、测试确定性）
  _now() { return RoomCore._clock ? RoomCore._clock() : Date.now(); }

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
    this._notes = []; // 本消息产生的诊断事件（重挂/接管/清扫），由 room.js 记录到 diag
    // DO 驱逐恢复后，旧连接靠持久化的 attachment（room/side）重挂回席位。
    // 幂等规则：仅当席位无存活连接（空/已关闭/静默超时）时才接管，
    // 避免"旧连接复活"把重连后的新连接顶掉（重连走 handleJoin 的 side 接管路径）。
    if (att.room) {
      const r = this.rooms.get(att.room);
      if (r && att.side >= 0) {
        const now = this._now();
        const cur = r.clients[att.side];
        if (cur === ws) {
          // 同一连接：仅刷新活跃时刻
          r.lastSeen[att.side] = now;
        } else if (!cur || cur.readyState !== 1 || now - r.lastSeen[att.side] > 20000) {
          const wasNull = !cur;
          if (cur) { try { cur.close(4000, 'replaced'); } catch (e) { /* ignore */ } }
          r.clients[att.side] = ws;
          // 席位曾被断线清扫器释放过：按 attachment 重新占回（含名字）
          if (!r.slots[att.side]) {
            r.slots[att.side] = true;
            r.names[att.side] = r.names[att.side] || att.name || '';
          }
          r.lastSeen[att.side] = now;
          this._notes.push('重挂 room=' + r.code + ' side=' + att.side);
          // 满员 + 本次重挂填补了空席位：向双方已挂载连接补发 room wait:false，
          // 让双方（驱逐后可能互为孤儿）同时进入对局，不再依赖各自下一次心跳
          if (wasNull && r.slots[0] && r.slots[1]) {
            for (let i = 0; i < 2; i++) {
              if (r.clients[i]) this.send(r.clients[i], { t: 'room', code: r.code, side: i, name: r.names[i] || '', wait: false });
            }
          }
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
    return this._notes;
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
      lastSeen: [Date.now(), Date.now()], // 每席位最近消息时刻（Alarm 断线清扫依据）
      lastBroadcastAt: 0, // 最近广播时刻（Alarm 兜底广播依据，保证 ≥2Hz 数据流）
      skins: [null, null], // 联机皮肤同步(v2.0):双方装配的装扮,随 room/state 广播给对手
    };
    room.slots[0] = true;
    room.clients[0] = ws;
    room.names[0] = String(msg.name || '玩家1').slice(0, 12);
    room.lastSeen[0] = this._now();
    room.skins[0] = sanitizeSkin(msg.skin);
    this.setAtt(ws, { room: code, side: 0, name: room.names[0] });
    this.rooms.set(code, room);
    this.broadcast(room, { t: 'room', code, side: 0, name: room.names[0], wait: true, skins: room.skins });
    this.stepRoom(room);
  }

  handleJoin(ws, msg, att) {
    if (att.room) return;
    const code = String(msg.room || '').toUpperCase().trim();
    const room = this.rooms.get(code);
    if (!room) { this.send(ws, { t: 'error', e: '房间不存在' }); return; }
    const now = this._now();
    // 带 side 提示（客户端重连夺回原席位）：优先复用自己的旧席位——
    // 仅当该席位当前无存活连接（空/已关闭/静默超时）时允许，安全不顶掉在线对手。
    let side = room.slots[0] ? 1 : 0;
    const hint = Number(msg.side);
    if (hint === 0 || hint === 1) {
      const cur = room.clients[hint];
      const curDead = !cur || cur.readyState !== 1 || (now - room.lastSeen[hint] > 20000);
      if (curDead) {
        side = hint;
        if (this._notes) this._notes.push('join 夺回 room=' + code + ' side=' + side);
      } else {
        this.send(ws, { t: 'error', e: '房间已满' }); return;
      }
    } else if (room.slots[0] && room.slots[1]) {
      this.send(ws, { t: 'error', e: '房间已满' }); return;
    }
    const name = String(msg.name || '玩家2').slice(0, 12);
    room.slots[side] = true;
    // 接管被判定为已死的旧连接：主动关闭，避免其后续消息重新挂载干扰
    if (room.clients[side] && room.clients[side] !== ws) {
      try { room.clients[side].close(4000, 'replaced'); } catch (e) { /* ignore */ }
    }
    room.clients[side] = ws;
    room.names[side] = name;
    room.lastSeen[side] = now;
    room.skins[side] = sanitizeSkin(msg.skin); // 联机皮肤同步(v2.0)
    this.setAtt(ws, { room: code, side, name });
    // 仅 1 人在房时为等待态（wait:true）——覆盖"房主重连到空房/对手离开后只剩一人"，
    // 让该客户端回到等待面板而不是孤身进入对局
    const waiting = !(room.slots[0] && room.slots[1]);
    this.broadcast(room, { t: 'room', code, side, name, wait: waiting, skins: room.skins });
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
    const now = this._now();
    const step = 1 / TICK_HZ; // 固定 60Hz 步长（与本地 server.js 一致）
    // 累计器：把"距上次调用的真实经过时间"累积起来，凑满一帧才步进。
    // 消息驱动下同一时间窗口会被多次调用（2 客户端各 60Hz 输入 + Alarm 每 200ms），
    // 绝不能"每消息至少一帧"——那会把游戏时间跑成 2 倍速（双方操作越快游戏越快）。
    // 累计器保证游戏时间始终贴近墙钟 1x：无论消息多密集/稀疏都按真实时间差推进。
    room.accTime = Math.min(0.5, (room.accTime || 0) + (now - room.lastStep) / 1000);
    room.lastStep = now;
    // 上限：长时间无消息（DO 休眠/网络中断）只追 0.5s，避免恢复时瞬间追赶爆炸
    let n = 0;
    while (room.accTime >= step && n < 60) {
      TT.step(room.engine, step);
      room.accTime -= step;
      n++;
    }
    // 快照广播节流：物理仍 60Hz 步进，但快照最多每 BROADCAST_MS（20Hz=50ms）发一次。
    // 省 3 倍带宽/序列化 CPU（相对 60Hz）；客户端对相邻快照做插值平滑（见 render.js 的 interp 逻辑）。
    // 空闲期（Alarm 每 100ms 调用本函数）广播降到 10Hz 地板，仍够看门狗判定与等待面板刷新。
    if (now - room.lastBroadcastAt >= BROADCAST_MS) {
      const snap = TT.snapshot(room.engine);
      const data = JSON.stringify({ t: 'state', s: snap, n: room.names, my: -1, skins: room.skins });
      room.lastSnap = data;
      room.lastBroadcastAt = now;
      for (const c of room.clients) if (c) this.send(c, data);
    }
    // 双方都空则删房
    if (!room.slots[0] && !room.slots[1]) this.rooms.delete(room.code);
  }

  // ---------- Alarm 兜底：推进 + 断线清扫（配合 room.js 的 alarm 定时调用） ----------
  // 消息驱动 tick 在"客户端停发消息"时会停摆（半死连接/后台节流/DO 驱逐），
  // Alarm 每拍调用本组方法：推进物理、兜底广播（10Hz 地板）、清理死连接与僵尸席位。

  // 释放某席位（断线事件丢失后的僵尸占位）：清空并通知对手
  freeSlot(room, side, now) {
    room.slots[side] = false;
    room.names[side] = '';
    room.clients[side] = null;
    room.lastSeen[side] = now;
    const otherIdx = room.slots[0] ? 0 : (room.slots[1] ? 1 : -1);
    const other = otherIdx >= 0 ? room.clients[otherIdx] : null;
    if (other) {
      this.send(other, { t: 'peer_left', side });
      const snap = TT.snapshot(room.engine);
      const att2 = this.getAtt(other) || {};
      this.send(other, { t: 'state', s: snap, n: room.names, my: att2.side });
    }
  }

  // 断线清扫（每拍 Alarm 调用）：
  // - 断线宽限到期：连接已摘除（clients[i]===null）且 lastSeen 超过 15s 未重挂 → 释放席位并通知对手；
  // - 静默 >15s 的存活连接 → 主动关闭（触发客户端重连/提示）；
  // - 占位但无消息 >30s 的僵尸席位 → 直接释放（驱逐期 close 丢失的兜底）。
  // 返回 { closed, freed } 供 room.js 记录诊断日志。
  sweepStale(now) {
    const res = { closed: [], freed: [] };
    for (const [code, room] of this.rooms) {
      for (let i = 0; i < 2; i++) {
        if (!room.slots[i]) continue;
        const ws = room.clients[i];
        if (now - room.lastSeen[i] > 30000) {
          // 超 30s 无消息：关连接（若还在）并直接释放席位
          if (ws && ws.readyState === 1) { try { ws.close(4000, 'idle timeout'); } catch (e) { /* ignore */ } }
          this.freeSlot(room, i, now);
          res.freed.push(code + '#' + i);
        } else if (!ws && now - room.lastSeen[i] > 15000) {
          // 断线宽限期（15s）到期仍未重挂：释放席位并通知对手
          this.freeSlot(room, i, now);
          res.freed.push(code + '#' + i);
        } else if (ws && now - room.lastSeen[i] > 15000) {
          // 静默 15s 的存活连接：先关连接，席位由 handleClose 进入宽限或下一轮 30s 清理
          try { ws.close(4000, 'idle timeout'); } catch (e) { /* ignore */ }
          res.closed.push(code + '#' + i);
        }
      }
    }
    // 清空房（宽限到期释放/双方都断线后的兜底）
    for (const [code, room] of this.rooms) {
      if (!room.slots[0] && !room.slots[1]) this.rooms.delete(code);
    }
    return res;
  }

  // Alarm 每拍调用：清扫 + 推进所有房间 + 兜底广播（10Hz 地板由 stepRoom 内部保证）。
  // 返回 { alive: 剩余房间数, notes: 诊断事件 }，room.js 据此续期 Alarm / 写 diag。
  tickAll(now) {
    const sweep = this.sweepStale(now);
    this._notes = [];
    for (const room of this.rooms.values()) {
      this.stepRoom(room); // 内含 10Hz 广播地板
    }
    // stepRoom/broadcast 可能已删空房，兜底清理
    for (const [code, room] of this.rooms) {
      if (!room.slots[0] && !room.slots[1]) this.rooms.delete(code);
    }
    if (sweep.closed.length || sweep.freed.length) {
      this._notes.push('alarm 清扫 closed=[' + sweep.closed.join(',') + '] freed=[' + sweep.freed.join(',') + ']');
    }
    return { alive: this.rooms.size, notes: this._notes };
  }

  // ---------- 断线处理（重连宽限期） ----------
  // 断线不立即释放席位、不通知对手"已离开"：先进入重连宽限期（席位保留、名字保留），
  // 玩家在宽限期内重连（重挂/join 接管）则对局无缝恢复；宽限到期（sweepStale）才
  // 释放席位并通知对手——避免一次网络抖动就把整局打崩成"对手已离开"。
  handleClose(ws, att) {
    const codeStr = att && att.room;
    if (!codeStr) return;
    const room = this.rooms.get(codeStr);
    if (!room) return;
    // 优先用 attachment 里的 side（驱逐恢复后 clients 可能还是 null，indexOf 找不到）
    const idx = att.side >= 0 ? att.side : room.clients.indexOf(ws);
    // 幂等：只有当前占位确实是本连接才摘除——避免"被夺回/重连替换的旧连接"close 时
    // 摘掉新连接的席位（重连/夺回路径见 handleJoin 与 handleMessage 的重挂块）
    if (idx >= 0 && room.clients[idx] === ws) {
      room.clients[idx] = null;
      // slots/names 保留；宽限期从断线时刻起算（sweepStale 按 lastSeen 判定）
      room.lastSeen[idx] = Date.now();
    }
    // 宽限期内不删房、不发 peer_left；到期后的清理与通知交给 sweepStale
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
    const now = this._now();
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
        lastSeen: [now, now], // 从当前时刻起算活跃：避免清扫器误杀恢复中的孤儿连接
        lastBroadcastAt: 0,   // 恢复后立即允许兜底广播（首拍即补发快照）
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
