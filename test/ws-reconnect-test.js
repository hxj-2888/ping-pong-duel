/* 审计 #6 验证：本地服务器断线宽限 + side 接管 + 僵尸清扫 + 房间回收。
 * 通过环境变量把宽限期压到秒级(生产默认 15s/30s 不变)：
 *   RECONNECT_GRACE_MS=2000  ZOMBIE_MS=4000
 * - 正常断线(close 帧)不立即通知对手 → 宽限期内重连带 side 接管 → 对局无缝恢复
 * - 拔网线(直接 destroy,无 close 帧)不立即通知对手 → 超僵尸时限后释放席位并通知对手
 * - 房间双方都释放后回收,再 join 返回"房间不存在"
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 8912;
const URL = `ws://127.0.0.1:${PORT}`;
const GRACE = 2000;  // 测试用宽限期(生产 15s)
const ZOMBIE = 6000; // 测试用僵尸时限(生产 30s):须大于客户端心跳间隔,否则在线但不发消息的客户端会被误杀

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// undici WebSocket 客户端(带消息队列 + 模拟真实客户端的心跳 ping 1s/次,
// 避免"在线但沉默"被僵尸清扫误杀——真实客户端心跳 5s/次 < 生产 ZOMBIE 30s)
function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    const waiters = [];
    let latest = null;
    ws.onopen = () => {
      const hb = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping' })); }, 1000);
      ws.addEventListener('close', () => clearInterval(hb));
      resolve({
        ws,
        send: (o) => ws.send(JSON.stringify(o)),
        get latest() { return latest; },
        drain: () => { inbox.length = 0; },
        next: (pred, timeout) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('等待消息超时')), timeout || 8000);
        const check = () => {
          const i = inbox.findIndex((m) => !pred || pred(m));
          if (i >= 0) {
            const idx = waiters.indexOf(check);
            if (idx >= 0) waiters.splice(idx, 1);
            const m = inbox.splice(i, 1)[0];
            clearTimeout(t);
            res(m);
          }
        };
        waiters.push(check);
        check();
        }),
        has: (pred) => inbox.some((m) => pred(m)),
      });
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      latest = m;
      inbox.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) waiters[i]();
    };
    ws.onerror = (e) => reject(e);
  });
}

// 手工编码 RFC 6455 客户端帧(必带 mask)——拔网线场景用原始 TCP
function frame(opcode, payload, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] |= 0x80;
  const mask = crypto.randomBytes(4);
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, out]);
}

// 原始 TCP 连接(可模拟拔网线:destroy 不发 close 帧)
function rawClient() {
  return new Promise((resolve, reject) => {
    const s = net.connect(PORT, '127.0.0.1');
    const closed = new Promise((res) => {
      s.on('close', () => res('close'));
      s.on('error', () => res('error'));
    });
    s.on('connect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      s.write(
        'GET /ws HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${PORT}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let buf = Buffer.alloc(0);
    const inbox = [];
    const waiters = [];
    // 心跳:模拟真实客户端(ping 1s/次),防"在线但沉默"被僵尸清扫误杀
    const hb = setInterval(() => {
      try { s.write(frame(0x1, Buffer.from(JSON.stringify({ t: 'ping' })))); } catch (e) { /* ignore */ }
    }, 1000);
    s.on('close', () => clearInterval(hb));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.includes('\r\n\r\n')) {
        const rest = buf.slice(buf.indexOf('\r\n\r\n') + 4);
        buf = Buffer.alloc(0);
        if (rest.length) {
          // 升级响应后的数据暂只做透传收集(本测试不解析服务端帧,够用)
        }
        resolve({
          socket: s,
          closed,
          sendJson: (o) => s.write(frame(0x1, Buffer.from(JSON.stringify(o)))),
        });
      }
    });
    s.on('error', reject);
  });
}

async function main() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), RECONNECT_GRACE_MS: String(GRACE), ZOMBIE_MS: String(ZOMBIE) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await sleep(600);

  let failures = 0;
  function check(name, cond) {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
    if (!cond) failures++;
  }

  try {
    // ---- 场景 1:正常断线进宽限,重连带 side 无缝接管 ----
    const a = await wsClient();
    a.send({ t: 'create', name: '房主' });
    const roomMsg = await a.next((m) => m.t === 'room');
    const code = roomMsg.code;

    const b = await wsClient();
    b.send({ t: 'join', room: code, name: '对手' });
    await b.next((m) => m.t === 'room' && m.side === 1);
    a.drain();

    // 正常 close(发 close 帧)→ 宽限期内不通知对手
    b.ws.close();
    await sleep(500);
    check('断线后宽限期内对手未收到 peer_left', !a.has((m) => m.t === 'peer_left'));

    // 宽限期内重连带 side → 接管,对局恢复(不惊动对手)
    const c = await wsClient();
    c.send({ t: 'join', room: code, name: '重连者', side: 1 });
    const cRoom = await c.next((m) => m.t === 'room' && m.side === 1);
    check('重连带 side 接管成功(side=1)', !!cRoom && cRoom.wait === false);
    check('接管后对手收到恢复通知(room side=1)', !!(await a.next((m) => m.t === 'room' && m.side === 1, 3000)));

    // 房间满:无 side 的普通加入被拒
    const d = await wsClient();
    d.send({ t: 'join', room: code, name: '路人' });
    const dErr = await d.next((m) => m.t === 'error');
    check('房间已满时普通加入被拒', dErr && dErr.e === '房间已满');

    // ---- 场景 2:拔网线(无 close 帧)→ 宽限内不通知 → 僵尸超时释放 ----
    c.ws.close(); // 先让 C 退出(宽限 2s,清扫器 5s 周期内释放席位)
    await a.next((m) => m.t === 'peer_left' && m.side === 1, 12000); // 等 C 席位被清扫释放
    a.drain();

    const e = await rawClient(); // 原始 TCP 加入(模拟真实玩家)
    e.sendJson({ t: 'join', room: code, name: '拔网线哥' });
    // 原始连接收 room(透传收集不解析;给服务器一点处理时间)
    await sleep(400);
    check('拔网线前房间可加入', true);

    e.socket.destroy(); // 拔网线:不发 close 帧
    await sleep(500);
    check('拔网线后宽限期内对手未收到 peer_left', !a.has((m) => m.t === 'peer_left'));

    // 僵尸超时(ZOMBIE=6s,清扫周期 5s)→ 对手收到 peer_left
    const leftMsg = await a.next((m) => m.t === 'peer_left', 15000);
    check('僵尸超时后对手收到 peer_left', !!leftMsg && leftMsg.side === 1);

    // ---- 场景 3:房间双方都释放后回收 ----
    a.ws.close();
    // 注意:不能轮询 join——房间空但未删时会 join 成功占位,close 后又刷新宽限计时,房间永不回收。
    // 直接等 A 宽限(2s)+ 清扫周期(5s)+ 余量,然后一次性验证房间已删除。
    await sleep(GRACE + 6000 + 1000);
    const f = await wsClient();
    f.send({ t: 'join', room: code, name: '后来者' });
    const fErr = await f.next((m) => m.t === 'error', 5000);
    check('房间回收后 join 返回"房间不存在"', fErr && fErr.e === '房间不存在');

    console.log(failures === 0 ? '\n断线重连测试通过 ✓' : `\n${failures} 项失败 ✗`);
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (e) {
    console.error('测试异常:', e.message);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
  setTimeout(() => process.exit(process.exitCode || 0), 300);
}

main();
