/* ============================================================
 * server.js — 乒乓球联机服务器（零依赖）
 *  - 静态文件服务（public/）
 *  - 原生 WebSocket 实现（RFC 6455，仅服务器必需部分）
 *  - 房间系统：房主创建 4 位房间码，对手凭码加入
 *  - 服务器权威模拟：60Hz 固定步长，快照广播给双方
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const TT = require('./public/js/engine.js');

const PORT = Number(process.env.PORT) || 8765;
const ROOT = path.join(__dirname, 'public');
const TICK_HZ = 60;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// 协议版本：客户端/桌面启动器据此识别"旧服务器"（旧版不解析 k 位掩码输入，
// 会导致客户端连上但输入全部被丢弃 → 进房后双方卡死）。版本号取 package.json + -local。
const VERSION = require('./package.json').version + '-local';

// 本机局域网/VPN IPv4 地址列表（房主展示联机地址用；Radmin VPN 等虚拟网卡 26.x 也会列出）
function localIps() {
  const out = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal && ni.address) out.push(ni.address);
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

// 带网卡名的 IPv4 列表（房主面板显示"WLAN / 以太网 / Radmin VPN · http://IP:端口"，
// 帮助用户从多个地址中挑出与对方同一网络的那个；兼容旧客户端：ips 字段保持不变）
function localIfaces() {
  const out = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal && ni.address) out.push({ name, address: ni.address });
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

// 诊断统计：每 10s 打印一次（有活动才打印），排查"进房卡死"时确认输入到底有没有到达服务器
const stats = { in: 0, broadcast: 0, create: 0, join: 0, close: 0 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json; charset=utf-8', // PWA 清单（手机端安装）
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------- 通关记录（本地后端，records.json 持久化，与 Cloudflare DO /api/records 兼容） ----------
// RECORDS_FILE 可用环境变量覆盖（测试用临时文件）
const RECORDS_FILE = process.env.RECORDS_FILE || path.join(__dirname, 'records.json');
const RECORDS_CAP = 60; // 个人生涯：后端留最近 60 条战绩

function sanitizeRecord(b) {
  if (!b || typeof b !== 'object') return null;
  const name = String(b.name || '玩家').slice(0, 20);
  const mode = b.mode === 'ai' || b.mode === 'local' || b.mode === 'online' ? b.mode : 'other';
  const winner = b.winner === 0 ? 0 : 1;
  const sc = Array.isArray(b.score)
    ? b.score.slice(0, 2).map((v) => Math.max(0, Math.min(99, Math.round(Number(v) || 0))))
    : [0, 0];
  const difficulty = [0, 1, 2, 3].includes(Number(b.difficulty)) ? Number(b.difficulty) : 1;
  const ts = Number(b.ts) || Date.now();
  return { id: ts + '_' + Math.random().toString(36).slice(2, 8), name, mode, winner, score: sc, difficulty, ts };
}

function loadRecords() {
  try { return JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8')); } catch (e) { return []; }
}
// 原子写：先写临时文件再 rename，防止进程中断把 records.json 写坏（规范后端）
function saveRecords(list) {
  try {
    const tmp = RECORDS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1), 'utf8');
    fs.renameSync(tmp, RECORDS_FILE);
  } catch (e) { /* ignore */ }
}

// ---------- 静态文件 ----------
const server = http.createServer((req, res) => {
  // 非法百分号编码（如 /%zz）会让 decodeURIComponent 抛 URIError；
  // 不捕获会以未捕获异常直接打崩整个服务器进程，这里兜底返回 400
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  // 联机诊断/房主地址信息：版本 + 端口 + IPv4 列表（启动器据此判断服务器新旧，
  // 客户端房主面板据此显示"对方请打开 http://IP:端口"；Radmin VPN 虚拟网卡 IP 也会列出）
  if (urlPath === '/api/info') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ ok: true, version: VERSION, port: PORT, ips: localIps(), ifaces: localIfaces(), hostname: os.hostname() }));
    return;
  }

  // 通关记录 API（GET/POST/DELETE /api/records，CORS 兼容桌面公网跨域）
  if (urlPath === '/api/records') {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.method === 'GET') {
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      const limit = Math.min(parseInt(q.get('limit') || '60', 10) || 60, 100);
      res.writeHead(200, cors);
      res.end(JSON.stringify({ ok: true, records: loadRecords().slice(0, limit) }));
      return;
    }
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (e) {
          res.writeHead(400, cors); res.end(JSON.stringify({ ok: false, e: 'bad json' })); return;
        }
        const rec = sanitizeRecord(body);
        if (!rec) { res.writeHead(400, cors); res.end(JSON.stringify({ ok: false, e: 'invalid' })); return; }
        const list = loadRecords();
        list.unshift(rec);
        if (list.length > RECORDS_CAP) list.length = RECORDS_CAP;
        saveRecords(list);
        res.writeHead(200, cors);
        res.end(JSON.stringify({ ok: true, id: rec.id }));
      });
      return;
    }
    if (req.method === 'DELETE') {
      // 按 id 删除一条记录（维护用；与 Cloudflare DO 行为一致）
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      const id = q.get('id');
      if (!id) { res.writeHead(400, cors); res.end(JSON.stringify({ ok: false, e: 'no id' })); return; }
      const list = loadRecords();
      const next = list.filter((r) => r && r.id !== id);
      const removed = list.length - next.length;
      if (removed > 0) saveRecords(next);
      res.writeHead(200, cors);
      res.end(JSON.stringify({ ok: true, removed }));
      return;
    }
    res.writeHead(405, cors); res.end(JSON.stringify({ ok: false, e: 'method' })); return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- WebSocket 帧编解码 ----------
function encodeFrame(opcode, payload, mask) {
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
  header[0] = 0x80 | opcode;
  let maskKey = null;
  if (mask) {
    header[1] |= 0x80;
    maskKey = crypto.randomBytes(4);
    header = Buffer.concat([header, maskKey]);
  }
  if (mask) {
    const out = Buffer.from(payload);
    for (let i = 0; i < out.length; i++) out[i] ^= maskKey[i % 4];
    return Buffer.concat([header, out]);
  }
  return Buffer.concat([header, payload]);
}

// 从累积缓冲解析完整帧；返回 [frames, rest]
function parseFrames(acc) {
  const frames = [];
  let buf = acc;
  let fragOp = -1;
  let fragParts = [];
  while (buf.length >= 2) {
    const b0 = buf[0], b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2)); off = 10;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < off + 4) break;
      maskKey = buf.subarray(off, off + 4); off += 4;
    }
    if (buf.length < off + len) break;
    let payload = Buffer.from(buf.subarray(off, off + len));
    if (masked) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    buf = buf.subarray(off + len);

    if (opcode === 0x0) { // continuation
      fragParts.push(payload);
      if (fin) { frames.push({ opcode: fragOp, payload: Buffer.concat(fragParts) }); fragOp = -1; fragParts = []; }
    } else if (opcode === 0x1 || opcode === 0x2) {
      if (fin) frames.push({ opcode, payload });
      else { fragOp = opcode; fragParts = [payload]; }
    } else {
      frames.push({ opcode, payload });
    }
  }
  return [frames, buf];
}

// ---------- 房间 ----------
const rooms = new Map();

function newRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 50; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[crypto.randomInt(chars.length)];
    if (!rooms.has(code)) return code;
  }
  return 'ABCD';
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) {
    if (c && c.ws && c.ws.writable) {
      try { c.ws.write(encodeFrame(0x1, Buffer.from(data))); } catch (e) { /* ignore */ }
    }
  }
}

function handleMessage(room, client, msg) {
  switch (msg.t) {
    case 'in': {
      stats.in++;
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
      TT.setInput(room.engine, client.side, {
        l, r, f, b, pu, sm,
        lb: c && pu, // 蹲下+推球 = 高吊（推球进阶技巧，服务端推导）
        crouch: c, run: rn,
      });
      // 鼠标/手指瞄准：目标落点（世界坐标）随输入帧上报，服务端求解发球方案并随快照返回
      if (Array.isArray(msg.a) && msg.a.length === 2) {
        const ax = Number(msg.a[0]), az = Number(msg.a[1]);
        if (Number.isFinite(ax) && Number.isFinite(az)) {
          TT.setServeAim(room.engine, client.side, ax, az);
        }
      }
      break;
    }
    case 'rematch': {
      if (room.engine.phase === 'over') {
        TT.resetMatch(room.engine);
        broadcast(room, { t: 'rematch' });
      }
      break;
    }
    case 'ping': {
      if (client.ws) client.ws.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ t: 'pong', st: Date.now(), ver: VERSION }))));
      break;
    }
    default:
      break;
  }
}

// ---------- HTTP 升级 → WebSocket ----------
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  const client = { ws: socket, room: null, side: -1, name: '', buf: Buffer.alloc(0), alive: true };
  socket.on('data', (chunk) => {
    client.buf = Buffer.concat([client.buf, chunk]);
    const [frames, rest] = parseFrames(client.buf);
    client.buf = rest;
    for (const f of frames) {
      if (f.opcode === 0x8) { // close
        try { socket.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8]))); } catch (e) { /* ignore */ }
        socket.end();
        return;
      }
      if (f.opcode === 0x9) { // ping
        try { socket.write(encodeFrame(0xa, f.payload)); } catch (e) { /* ignore */ }
        continue;
      }
      if (f.opcode !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(f.payload.toString('utf8')); } catch (e) { continue; }
      handleClientMessage(client, msg);
    }
  });
  socket.on('error', () => { /* ignore */ });
  socket.on('close', () => {
    client.alive = false;
    leaveRoom(client);
  });
});

function handleClientMessage(client, msg) {
  if (msg.t === 'create') {
    stats.create++;
    const code = newRoomCode();
    const room = {
      code,
      engine: TT.createEngine(),
      clients: [null, null],
      lastSnap: '',
    };
    rooms.set(code, room);
    client.room = room; client.side = 0; client.name = String(msg.name || '玩家1').slice(0, 12);
    room.clients[0] = client;
    broadcast(room, { t: 'room', code, side: 0, name: client.name, wait: true });
    return;
  }
  if (msg.t === 'join') {
    stats.join++;
    const code = String(msg.room || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      send(client, { t: 'error', e: '房间不存在' });
      return;
    }
    if (room.clients[0] && room.clients[1]) {
      send(client, { t: 'error', e: '房间已满' });
      return;
    }
    client.room = room; client.name = String(msg.name || '玩家2').slice(0, 12);
    client.side = room.clients[0] ? 1 : 0;
    room.clients[client.side] = client;
    broadcast(room, { t: 'room', code, side: client.side, name: client.name, wait: false });
    return;
  }
  if (client.room) {
    handleMessage(client.room, client, msg);
  }
}

function send(client, msg) {
  if (client.ws && client.ws.writable) {
    try { client.ws.write(encodeFrame(0x1, Buffer.from(JSON.stringify(msg)))); } catch (e) { /* ignore */ }
  }
}

function leaveRoom(client) {
  if (!client.room) return;
  stats.close++;
  const room = client.room;
  const idx = room.clients.indexOf(client);
  if (idx >= 0) room.clients[idx] = null;
  client.room = null;
  const other = room.clients[0] || room.clients[1];
  if (other) {
    send(other, { t: 'peer_left', side: idx });
    const snap = TT.snapshot(room.engine);
    send(other, { t: 'state', s: snap, n: room.clients.map((c) => (c ? c.name : '')), my: other.side });
  } else {
    rooms.delete(room.code);
  }
}

// ---------- 主循环：60Hz 模拟 + 广播 ----------
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.clients[0] && !room.clients[1]) {
      rooms.delete(room.code);
      continue;
    }
    TT.step(room.engine, 1 / TICK_HZ);
    const snap = TT.snapshot(room.engine);
    const data = JSON.stringify({ t: 'state', s: snap, n: room.clients.map((c) => (c ? c.name : '')), my: -1 });
    if (data !== room.lastSnap) {
      stats.broadcast++;
      room.lastSnap = data;
      for (const c of room.clients) {
        if (c && c.ws && c.ws.writable) {
          try { c.ws.write(encodeFrame(0x1, Buffer.from(data))); } catch (e) { /* ignore */ }
        }
      }
    }
  }
}, 1000 / TICK_HZ);

// 诊断统计：每 10s 打印一次（有活动或房间存在才打印，避免空转噪音）。
// 排查"进房卡死"：房间在但 in=0 → 输入没到服务器（旧服务器/连接问题）；
// 房间在、in 有值但 broadcast=0 → 引擎没推进（引擎异常）。
setInterval(() => {
  const total = stats.in + stats.broadcast + stats.create + stats.join + stats.close;
  if (total === 0 && rooms.size === 0) return;
  console.log(`[stats] rooms=${rooms.size} in=${stats.in} broadcast=${stats.broadcast} create=${stats.create} join=${stats.join} close=${stats.close}`);
  stats.in = stats.broadcast = stats.create = stats.join = stats.close = 0;
}, 10000);

server.listen(PORT, () => {
  console.log(`乒乓对决联机服务器 v${VERSION} 已启动: http://localhost:${PORT}`);
  console.log(`联机地址: ws://localhost:${PORT}  (局域网内可用本机 IP)`);
  const ips = localIps();
  if (ips.length) {
    console.log('局域网/VPN 联机地址（让对方浏览器打开并输入房间码）:');
    for (const ip of ips) console.log(`  http://${ip}:${PORT}`);
  } else {
    console.log('未检测到局域网 IPv4 地址（请检查网络连接 / 是否已开启 Radmin VPN 等虚拟网卡）');
  }
});
