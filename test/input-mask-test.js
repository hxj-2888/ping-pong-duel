/* 输入位掩码协议测试：验证 DO（RoomCore）解析 k 位掩码与旧 i 对象完全等效
 * 位定义：0=l 1=r 2=pu 3=sm 4=f 5=b 6=crouch 7=run
 * 1) 位掩码 k 解析出正确的 8 个输入
 * 2) 旧 i 对象兼容（未升级客户端仍可玩）
 * 3) 两种格式产生相同引擎输入
 * 4) 瞄准 a 随包上报正常
 */
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

function feed(core, ws, msg) {
  core.handleMessage(ws, JSON.stringify(msg), ws._att || {});
}

// ---------- 1. 位掩码解析 ----------
{
  const core = new RoomCore();
  const ws = new MockWS();
  feed(core, ws, { t: 'create', name: 'A' });
  const room = [...core.rooms.values()][0];
  // 全按键按下：l+r+pu+sm+f+b+crouch+run = 0xFF
  feed(core, ws, { t: 'in', k: 255 });
  const inp = room.engine.inputs[0];
  check('位掩码 0xFF：全部 8 键为 true', !!(inp.l && inp.r && inp.pu && inp.sm && inp.f && inp.b && inp.crouch && inp.run));
  check('蹲+推 → lb（高吊）推导', inp.lb === 1);

  // 单键：r(bit1)=2
  feed(core, ws, { t: 'in', k: 2 });
  const inp2 = room.engine.inputs[0];
  check('k=2 仅 r 生效', inp2.r === 1 && inp2.l === 0 && inp2.pu === 0 && inp2.sm === 0 && inp2.f === 0 && inp2.b === 0 && inp2.crouch === 0 && inp2.run === 0);

  // 组合：f(16)+crouch(64)+run(128) = 208
  feed(core, ws, { t: 'in', k: 208 });
  const inp3 = room.engine.inputs[0];
  check('k=208 仅 f+crouch+run', inp3.f === 1 && inp3.crouch === 1 && inp3.run === 1 && inp3.l === 0 && inp3.r === 0);
}

// ---------- 2. 旧 i 对象兼容 ----------
{
  const core = new RoomCore();
  const ws = new MockWS();
  feed(core, ws, { t: 'create', name: 'B' });
  const room = [...core.rooms.values()][0];
  feed(core, ws, { t: 'in', i: { l: 1, r: 0, f: 1, b: 0, pu: 0, sm: 1, c: 1, rn: 0 } });
  const inp = room.engine.inputs[0];
  check('旧 i 对象兼容：l+f+sm+crouch', inp.l === 1 && inp.f === 1 && inp.sm === 1 && inp.crouch === 1 && inp.r === 0);
  check('旧 i 对象：蹲+推=false → lb=0（pu 为 0）', inp.lb === 0);
  // 蹲+推（旧对象）→ lb=1
  feed(core, ws, { t: 'in', i: { pu: 1, c: 1 } });
  check('旧 i 对象：蹲+推 → lb=1', room.engine.inputs[0].lb === 1);
}

// ---------- 3. 两种格式等效 ----------
{
  const coreA = new RoomCore();
  const wsA = new MockWS();
  feed(coreA, wsA, { t: 'create', name: 'A' });
  const roomA = [...coreA.rooms.values()][0];
  feed(coreA, wsA, { t: 'in', k: 18 }); // f(16)+r(2)

  const coreB = new RoomCore();
  const wsB = new MockWS();
  feed(coreB, wsB, { t: 'create', name: 'B' });
  const roomB = [...coreB.rooms.values()][0];
  feed(coreB, wsB, { t: 'in', i: { f: 1, r: 1 } });

  const a = roomA.engine.inputs[0], b = roomB.engine.inputs[0];
  check('k=18 与 i{f,r} 等效', a.l === b.l && a.r === b.r && a.f === b.f && a.pu === b.pu && a.sm === b.sm && a.b === b.b && a.crouch === b.crouch && a.run === b.run);
}

// ---------- 4. 瞄准上报 ----------
{
  const core = new RoomCore();
  const ws = new MockWS();
  feed(core, ws, { t: 'create', name: 'C' });
  const room = [...core.rooms.values()][0];
  // 待发阶段才能设置瞄准（phase=serve && inHand && server===0）
  const eng = room.engine;
  eng.phase = 'serve';
  eng.ball.inHand = true;
  eng.server = 0;
  feed(core, ws, { t: 'in', k: 0, a: [0.5, -1.2] });
  const aim = eng.players[0].serveAim;
  check('瞄准 a=[0.5,-1.2] 被设置', aim && Math.abs(aim.x - 0.5) < 1e-6 && Math.abs(aim.z - (-1.2)) < 1e-6);
  // 不带 a 不清除旧瞄准（瞄准独立于输入包）
  feed(core, ws, { t: 'in', k: 2 });
  const aim2 = eng.players[0].serveAim;
  check('不带 a 的包保留旧瞄准', aim2 && Math.abs(aim2.x - 0.5) < 1e-6);
}

console.log(failures === 0 ? '\n位掩码协议测试全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
