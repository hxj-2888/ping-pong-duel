/* 本地持久化回归：模拟 DO 驱逐（序列化→新实例恢复），验证
 * 1) 恢复后房间仍在  2) 旧连接按 attachment 重挂回席位
 * 3) 新加入者正确拿 side=1（不因 clients 为空而误抢 side=0）
 * 4) 满员判断用 slots  5) 断线清席位 */
'use strict';

import { RoomCore } from '../src/room-core.js';

const OPEN = 1;
let nextId = 1;
class MockWS {
  constructor() { this.id = nextId++; this.readyState = OPEN; this.sent = []; this._att = null; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
  serializeAttachment(a) { this._att = a; }
  deserializeAttachment() { return this._att; }
}

let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) failures++; };
const msgs = (ws) => ws.sent.map((s) => JSON.parse(s));
const lastOf = (ws, t) => { const arr = msgs(ws).filter((m) => m.t === t); return arr[arr.length - 1]; };

function feed(core, ws, msg) {
  core.handleMessage(ws, JSON.stringify(msg), ws._att || {});
}

// ---------- 1. 建房 + 加入 ----------
const coreA = new RoomCore();
const wsHost = new MockWS();
feed(coreA, wsHost, { t: 'create', name: '房主' });
const code = lastOf(wsHost, 'room').code;
const wsGuest = new MockWS();
feed(coreA, wsGuest, { t: 'join', room: code, name: '小蓝' });
check('加入方 side=1', lastOf(wsGuest, 'room').side === 1);

// ---------- 2. 模拟 DO 驱逐：序列化 → 新实例恢复 ----------
const data = JSON.parse(JSON.stringify(coreA.serialize())); // 深拷贝模拟落盘/读盘
const coreB = new RoomCore();
coreB.restore(data);
check('恢复后房间仍存在（slots=[T,T]）', coreB.rooms.has(code) && coreB.rooms.get(code).slots[0] && coreB.rooms.get(code).slots[1]);
check('恢复后 clients 为空（等待重挂）', coreB.rooms.get(code).clients.every((c) => c === null));

// ---------- 3. 新加入者此时加入：应报"房间已满"（slots 判定） ----------
const wsC = new MockWS();
feed(coreB, wsC, { t: 'join', room: code, name: '挤进来' });
check('满员用 slots 判定（房间已满）', lastOf(wsC, 'error') && lastOf(wsC, 'error').e === '房间已满');

// ---------- 4. 旧房主重挂（其 attachment 仍在连接上，发 in 即重挂） ----------
feed(coreB, wsHost, { t: 'in', i: { l: 0, r: 1, f: 0, b: 0, pu: 0, sm: 0 } });
const roomB = coreB.rooms.get(code);
check('房主按 attachment 重挂回 side=0', roomB.clients[0] === wsHost);
check('加入方尚未发消息（clients[1] 仍空，等其重挂）', roomB.clients[1] === null);
feed(coreB, wsGuest, { t: 'in', i: { l: 1, r: 0, f: 0, b: 0, pu: 0, sm: 0 } });
check('加入方重挂回 side=1', roomB.clients[1] === wsGuest);

// ---------- 5. 驱逐恢复后，已空房间被清理 ----------
const coreC = new RoomCore();
feed(coreC, new MockWS(), { t: 'create', name: '单人' });
const code2 = [...coreC.rooms.keys()][0];
const empty = JSON.parse(JSON.stringify(coreC.serialize()));
empty[0].slots = [false, false]; // 模拟双方都已断线
coreC.restore(empty);
check('空房间恢复时被清除', !coreC.rooms.has(code2));

// ---------- 6. 驱逐恢复后断线：用 attachment.side 清席位，且不误删房（对方席位仍在） ----------
const coreD = new RoomCore();
const wsH2 = new MockWS();
feed(coreD, wsH2, { t: 'create', name: '房主2' });
const code3 = lastOf(wsH2, 'room').code;
const wsG2 = new MockWS();
feed(coreD, wsG2, { t: 'join', room: code3, name: '小蓝2' });
const data2 = JSON.parse(JSON.stringify(coreD.serialize()));
const coreE = new RoomCore();
coreE.restore(data2);
coreE.handleClose(wsG2, wsG2._att || {}); // 恢复后 guests 连接断开（clients 里是 null，靠 att.side）
check('恢复后断线按 att.side 清席位', coreE.rooms.get(code3) && coreE.rooms.get(code3).slots[1] === false);
check('房主席位保留（房间未误删）', coreE.rooms.get(code3) && coreE.rooms.get(code3).slots[0] === true);
// 房主随后发消息重挂，还能继续
feed(coreE, wsH2, { t: 'in', i: { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0 } });
check('房主重挂后房间仍活跃', coreE.rooms.get(code3).clients[0] === wsH2);

// ---------- 7. 驱逐恢复后，孤儿房主（等待中，未发过消息）靠心跳重挂并收到补发 room ----------
const coreF = new RoomCore();
const wsH3 = new MockWS();
feed(coreF, wsH3, { t: 'create', name: '房主3' });
const code4 = lastOf(wsH3, 'room').code;
// 模拟驱逐：房主被孤儿化（clients 清空但 slots[0] 保留）
const data3 = JSON.parse(JSON.stringify(coreF.serialize()));
const coreG = new RoomCore();
coreG.restore(data3);
// 加入者先到
const wsG3 = new MockWS();
feed(coreG, wsG3, { t: 'join', room: code4, name: '小蓝3' });
check('加入者成功（side=1）', lastOf(wsG3, 'room') && lastOf(wsG3, 'room').side === 1);
// 孤儿房主心跳（ping）→ 重挂 + 补发 room(wait:false)
const beforeLen = wsH3.sent.length;
feed(coreG, wsH3, { t: 'ping' });
const roomAfter = msgs(wsH3).filter((m) => m.t === 'room').pop();
check('房主心跳后收到补发 room（wait=false, side=0）', roomAfter && roomAfter.wait === false && roomAfter.side === 0);
check('房主已重挂回 side=0', coreG.rooms.get(code4).clients[0] === wsH3);
check('加入者连接未被覆盖', coreG.rooms.get(code4).clients[1] === wsG3);

console.log(failures === 0 ? '\n持久化回归测试全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
