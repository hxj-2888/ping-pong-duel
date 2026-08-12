/* 审计 #1 验证：WebSocket 帧/分片/缓冲大小上限。
 * - 超大单帧 payload(>64KB, len=127) → 服务器必须断开连接(防内存/CPU DoS)
 * - 分片累积超限(50KB + 50KB) → 服务器必须断开连接(防分片无限累积)
 * - 正常消息不受影响：仍可建房/收快照(保证上限不误伤正常流量)
 * 使用原始 TCP 连接手工编码 RFC 6455 帧(undici WebSocket 不允许发超大帧)。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 8911;
const URL = `ws://127.0.0.1:${PORT}`;
const MAX_FRAME = 64 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 手工编码 RFC 6455 客户端帧(必带 mask)
function frame(opcode, payload, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] |= 0x80; // masked
  const mask = crypto.randomBytes(4);
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, out]);
}

// 原始 TCP 连接 + WebSocket 升级握手；返回 { socket, closed: Promise }
function rawClient() {
  return new Promise((resolve, reject) => {
    const s = net.connect(PORT, '127.0.0.1');
    const closed = new Promise((res) => {
      s.on('close', () => res('close'));
      s.on('error', () => res('error'));
      s.on('end', () => res('end'));
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
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.includes('\r\n\r\n')) resolve({ socket: s, closed });
    });
    s.on('error', reject);
  });
}

// 等待连接被服务器主动断开(超时失败)
function waitClosed(closed, ms) {
  return Promise.race([
    closed,
    sleep(ms).then(() => { throw new Error('连接未被服务器断开(上限未生效)'); }),
  ]);
}

async function main() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  await sleep(600);

  let failures = 0;
  function check(name, cond) {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
    if (!cond) failures++;
  }

  try {
    // 1. 超大单帧(100KB) → 断开
    {
      const { socket, closed } = await rawClient();
      socket.write(frame(0x1, Buffer.alloc(MAX_FRAME + 40 * 1024, 'A')));
      const why = await waitClosed(closed, 3000);
      check(`超大单帧(>64KB)被断开(${why})`, true);
    }
    // 2. 分片累积超限(50KB + 50KB) → 断开
    {
      const { socket, closed } = await rawClient();
      socket.write(frame(0x1, Buffer.alloc(50 * 1024, 'B'), false)); // 首分片 fin=0
      await sleep(100);
      socket.write(frame(0x0, Buffer.alloc(50 * 1024, 'C'), true));  // 续片累积 100KB
      const why = await waitClosed(closed, 3000);
      check(`分片累积超限(100KB)被断开(${why})`, true);
    }
    // 3. 巨大长度字段伪造(2GB 声明) → 断开(无需真的发 2GB)
    {
      const { socket, closed } = await rawClient();
      const hdr = Buffer.alloc(10);
      hdr[0] = 0x81; hdr[1] = 0xff; // opcode=1, fin, len=127, masked
      hdr.writeBigUInt64BE(BigInt(2 * 1024 * 1024 * 1024), 2);
      socket.write(hdr);
      const why = await waitClosed(closed, 3000);
      check(`伪造 2GB 长度字段被断开(${why})`, true);
    }
    // 4. 正常流量不受影响：普通 WebSocket 建房 + 快照
    {
      const ws = new WebSocket(URL);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.send(JSON.stringify({ t: 'create', name: '正常玩家' }));
      const m = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('建房超时')), 5000);
        ws.onmessage = (ev) => { clearTimeout(t); res(JSON.parse(ev.data)); };
      });
      check('正常建房仍工作', m.t === 'room' && /^[A-Z0-9]{4}$/.test(m.code));
      ws.close();
    }

    console.log(failures === 0 ? '\nWS 帧上限测试通过 ✓' : `\n${failures} 项失败 ✗`);
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
