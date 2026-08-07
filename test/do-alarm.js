/* 本地冒烟：RoomCore 的 Alarm 兜底逻辑（修复"进房间后卡死"）
 * 验证：tickAll 零输入强制广播 / sweepStale 死连接与僵尸席位清理 /
 *       重挂满员双向通知 / join side 夺回接管 / 发球边沿回归 */
'use strict';

import { RoomCore } from '../src/room-core.js';

// ---------- mock WebSocket（模拟 DO Hibernation 连接） ----------
const OPEN = 1;
let nextId = 1;
class MockWS {
  constructor() { this.id = nextId++; this.readyState = OPEN; this.sent = []; this._att = null; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
  serializeAttachment(a) { this._att = a; }
  deserializeAttachment() { return this._att; }
}

// ---------- 测试辅助 ----------
let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) failures++; };

function msgs(ws) { return ws.sent.map((s) => JSON.parse(s)); }
function lastOf(ws, t) { const arr = msgs(ws).filter((m) => m.t === t); return arr[arr.length - 1]; }

// ---------- 实例化 ----------
const core = new RoomCore();
const wsA = new MockWS(); // 房主
const wsB = new MockWS(); // 加入者

// 假时钟：每 feed 推进 16ms（60Hz 输入帧间隔），让累计器按真实节奏步进（测试确定性）
let fakeNow = Date.now();
RoomCore._clock = () => fakeNow;

function feed(ws, msg) {
  fakeNow += 16; // 60Hz 输入帧间隔
  ws.serializeAttachment(ws._att || {});
  const raw = new TextEncoder().encode(JSON.stringify(msg));
  core.handleMessage(ws, raw, ws._att || {});
}

// ---------- 1. 建房 + 加入（满员） ----------
feed(wsA, { t: 'create', name: '房主' });
const code = lastOf(wsA, 'room').code;
feed(wsB, { t: 'join', room: code, name: '小蓝' });
const room = core.rooms.get(code);
check('房间满员（slots 全占）', room && room.slots[0] && room.slots[1]);

// ---------- 2. tickAll：零输入也推进并强制广播（打破去重静默） ----------
// 发球待发阶段双方不动 → 快照内容不变 → 纯消息驱动不会广播；
// Alarm 的 tickAll 应在距上次广播 >500ms 时兜底补发，保证 ≥2Hz 数据流
room.lastBroadcastAt = fakeNow - 600; // 模拟 >500ms 无广播
const zA = msgs(wsA).length, zB = msgs(wsB).length;
const res = core.tickAll(fakeNow);
check('tickAll 返回 alive=1（有房间存活，Alarm 续期）', res && res.alive === 1);
check('tickAll 零输入仍强制广播（房主收到新 state）', msgs(wsA).slice(zA).some((m) => m.t === 'state'));
check('tickAll 零输入仍强制广播（加入者收到新 state）', msgs(wsB).slice(zB).some((m) => m.t === 'state'));

// ---------- 3. sweepStale：静默 >15s 关闭连接 ----------
room.lastSeen[1] = fakeNow - 16000;
const s1 = core.sweepStale(fakeNow);
check('sweep 静默 15s+ 关闭连接（closed 记录）', s1.closed.some((s) => s === code + '#1'));
check('关闭后连接 readyState=CLOSED', wsB.readyState === 3);
check('关闭连接后席位仍在（等 handleClose/30s 清理）', room.slots[1] === true);

// ---------- 4. sweepStale：占位 >30s 释放僵尸席位并通知对手 ----------
room.lastSeen[1] = fakeNow - 31000;
const s2 = core.sweepStale(fakeNow);
check('sweep 释放僵尸席位（freed 记录）', s2.freed.some((s) => s === code + '#1'));
check('僵尸席位已释放', room.slots[1] === false && room.clients[1] === null);
check('对手收到 peer_left', msgs(wsA).some((m) => m.t === 'peer_left' && m.side === 1));

// ---------- 4.5 断线重连宽限期（不再立即 peer_left） ----------
// 断线只摘连接、保留席位：宽限期内重连无缝恢复，到期才释放并通知对手
const zGraceA = msgs(wsA).length;
const wsE = new MockWS();
feed(wsE, { t: 'join', room: code, name: '小蓝', side: 1 }); // 新连接占回 side=1
wsE.readyState = 3;
core.handleClose(wsE, wsE._att);
check('断线进入宽限期：席位保留、连接摘除', room.slots[1] === true && room.clients[1] === null);
check('宽限期内不立即通知对手 peer_left', !msgs(wsA).slice(zGraceA).some((m) => m.t === 'peer_left'));
room.lastSeen[1] = fakeNow - 16000; // 宽限期（15s）到期
core.sweepStale(fakeNow);
check('宽限到期后释放席位并通知对手', room.slots[1] === false && msgs(wsA).some((m) => m.t === 'peer_left'));

// ---------- 5. 重挂满员：双向补发 room wait:false ----------
// 真实重连 = 新连接（attachment 为 room:null），先 re-join 占回被释放的 side=1
const wsB2 = new MockWS();
feed(wsB2, { t: 'join', room: code, name: '小蓝', side: 1 });
const roomB2 = lastOf(wsB2, 'room');
check('重连 join 占回 side=1', roomB2 && roomB2.side === 1 && roomB2.wait === false);
// 模拟驱逐恢复：host 已重挂、加入者仍孤儿 → 加入者重挂时应同时通知双方
const zA2 = msgs(wsA).length, zB2 = msgs(wsB2).length;
room.clients = [wsA, null];
feed(wsB2, { t: 'ping' });
check('重挂者收到补发 room wait:false', msgs(wsB2).slice(zB2).some((m) => m.t === 'room' && m.wait === false));
check('已挂载对手也收到补发 room wait:false', msgs(wsA).slice(zA2).some((m) => m.t === 'room' && m.wait === false));

// ---------- 6. join side 夺回接管 ----------
// 满员 + 原席位连接已死（readyState!=1）→ 带 side 提示的 join 可夺回，不顶掉在线对手
const dead = new MockWS();
dead.readyState = 3;
room.clients[1] = dead;
room.slots[1] = true;
const wsC = new MockWS();
feed(wsC, { t: 'join', room: code, name: '小蓝2', side: 1 });
const roomC = lastOf(wsC, 'room');
check('死席位可被 side 提示夺回', roomC && roomC.side === 1 && roomC.wait === false);
check('夺回后 clients[1] 是新连接', room.clients[1] === wsC);
// 满员 + 原席位连接存活 → 拒绝
const wsD = new MockWS();
feed(wsD, { t: 'join', room: code, name: '小蓝3', side: 1 });
check('存活席位拒绝被顶（房间已满）', msgs(wsD).some((m) => m.t === 'error' && m.e === '房间已满'));

// ---------- 7. 发球边沿回归（防"点了发球没反应"复发） ----------
// 回到可发球站位后 pu 边沿应触发发球并进入对打（ph=1）
room.engine.players[0].x = 0;
room.engine.players[0].padX = 0;
feed(wsA, { t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 1, sm: 0 } }); // 推球边沿发球
feed(wsA, { t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0 } });
for (let i = 0; i < 30; i++) { feed(wsA, { t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0 } }); }
const snapServe = lastOf(wsA, 'state');
check('发球边沿进入对打（ph=1）', snapServe && snapServe.s.ph === 1);

// ---------- 8. 双方断线 → 宽限到期清扫后房间删除 ----------
wsA.readyState = 3;
core.handleClose(wsA, wsA._att);
wsC.readyState = 3;
core.handleClose(wsC, wsC._att);
room.lastSeen[0] = fakeNow - 16000; // 双方宽限期（15s）到期
room.lastSeen[1] = fakeNow - 16000;
core.sweepStale(fakeNow);
check('双方断线且宽限到期后房间被删除', !core.rooms.has(code));

console.log(failures === 0 ? '\nDO Alarm 兜底逻辑全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
