/* 本地冒烟：直接实例化 GameRoom，用 mock WebSocket 模拟双客户端
 * 验证房间流程：create → join → in → state → rematch → peer_left */
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

// 收集某连接的 t 类型消息
function msgs(ws) { return ws.sent.map((s) => JSON.parse(s)); }
function lastOf(ws, t) { const arr = msgs(ws).filter((m) => m.t === t); return arr[arr.length - 1]; }

// ---------- 实例化 ----------
const core = new RoomCore();
const wsA = new MockWS(); // 房主
const wsB = new MockWS(); // 加入者

function feed(ws, msg) {
  ws.serializeAttachment(ws._att || {});
  const raw = new TextEncoder().encode(JSON.stringify(msg));
  core.handleMessage(ws, raw, ws._att || {});
}

// ---------- 1. 房主创建房间 ----------
feed(wsA, { t: 'create', name: '房主' });
const roomMsgA = lastOf(wsA, 'room');
check('房主收到 room 消息', !!roomMsgA);
check('房主 side=0', roomMsgA && roomMsgA.side === 0);
check('房主 wait=true（等待对手）', roomMsgA && roomMsgA.wait === true);
check('房间码格式 4 位', roomMsgA && /^[A-Z0-9]{4}$/.test(roomMsgA.code));
const code = roomMsgA.code;
check('房主收到初始 state 快照', msgs(wsA).some((m) => m.t === 'state'));

// ---------- 2. 加入者加入 ----------
feed(wsB, { t: 'join', room: code, name: '小蓝' });
const roomMsgA2 = lastOf(wsA, 'room');
const roomMsgB = lastOf(wsB, 'room');
check('加入方 side=1', roomMsgB && roomMsgB.side === 1);
check('加入方 wait=false（开始对局）', roomMsgB && roomMsgB.wait === false);
check('房主也收到 room 广播（side=1）', roomMsgA2 && roomMsgA2.side === 1);

// ---------- 3. 输入驱动 ----------
const zA = msgs(wsA).length, zB = msgs(wsB).length;
feed(wsA, { t: 'in', i: { l: 0, r: 1, f: 0, b: 0, pu: 0, sm: 0 } });
feed(wsB, { t: 'in', i: { l: 1, r: 0, f: 0, b: 0, pu: 0, sm: 0 } });
// 连续推进多次（模拟 30Hz 输入 500ms）
for (let i = 0; i < 15; i++) {
  feed(wsA, { t: 'in', i: { l: 0, r: 1, f: 0, b: 0, pu: 0, sm: 0 } });
  feed(wsB, { t: 'in', i: { l: 1, r: 0, f: 0, b: 0, pu: 0, sm: 0 } });
}
const snapA = lastOf(wsA, 'state');
const snapB = lastOf(wsB, 'state');
check('P0 向右移动（x>0）', snapA && snapA.s.p[0].x > 0.05);
check('P1 向左移动（x<0）', snapB && snapB.s.p[1].x < -0.05);
check('快照含 z/vz', snapA && typeof snapA.s.p[0].z === 'number' && typeof snapA.s.p[0].vz === 'number');

// ---------- 4. 发球流程 ----------
feed(wsA, { t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 1, sm: 0 } }); // 推球边沿
feed(wsA, { t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0 } });
for (let i = 0; i < 30; i++) { feed(wsA, { t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0 } }); }
const snapServe = lastOf(wsA, 'state');
check('发球后进入对打（ph=1）', snapServe && snapServe.s.ph === 1);

// ---------- 5. 非结束时 rematch 无效 ----------
feed(wsA, { t: 'rematch' });
const snapAfter = lastOf(wsA, 'state');
check('非结束 rematch 比分不变', snapAfter && snapAfter.s.sc[0] === 0 && snapAfter.s.sc[1] === 0);

// ---------- 6. ping/pong ----------
feed(wsA, { t: 'ping' });
check('ping 返回 pong', msgs(wsA).some((m) => m.t === 'pong' && typeof m.st === 'number'));

// ---------- 7. 断线通知 ----------
wsB.readyState = 3;
core.handleClose(wsB, wsB._att);
check('房主收到 peer_left（side=1）', msgs(wsA).some((m) => m.t === 'peer_left' && m.side === 1));

console.log(failures === 0 ? '\nDO 房间逻辑本地冒烟全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
