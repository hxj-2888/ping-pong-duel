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
// WebSocket 消息上限(审计 #1:防内存/CPU DoS):
// - 单连接累积缓冲超 WS_MAX_BUF → 直接断开(恶意客户端慢速灌数据拖死内存)
// - 单帧/单条分片消息 payload 超 WS_MAX_FRAME → 拒绝并断开(超大帧一次性大分配 / 分片无限累积)
const WS_MAX_BUF = 256 * 1024;
const WS_MAX_FRAME = 64 * 1024;
// 僵尸连接宽限(审计 #6,镜像 room-core 语义):
// - RECONNECT_GRACE_MS:重连宽限期。重连带原席位加入时,占位客户端失联超此时间 → 静默接管该席位;
//   宽限期内 → 席位仍属于旧连接,新连接按"房间已满"处理(防止重连瞬间被抢占)。
// - ZOMBIE_MS:僵尸清扫时限。连接失联(拔网线/AP 断开,close 可能数分钟不触发)超此时间 →
//   定期清扫释放席位并销毁 socket,否则席位永久占用、对手卡死。
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 15 * 1000;
const ZOMBIE_MS = Number(process.env.ZOMBIE_MS) || 30 * 1000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// 跨源联机白名单（ECS 对齐真实游戏接口，2026-08-29）：
// 客户端的 ECS 线路地址固定为 wss://searchdelta.online/ws（见 state.js getServerUrl），
// 而玩家很可能是从 Cloudflare 托管的页面 https://ping-pong-duel.pages.dev 打开游戏后再
// 切到 ECS 线路的——此时 Origin 是 pages.dev、Host 是 searchdelta.online，
// 二者天然不相等。若只按"Origin.host === Host"校验，这类跨源联机会在握手阶段就被
// socket.destroy()，表现为「联机拉不了手（握手失败/反复重连）」。
// 此前 ECS 上的临时解法是在 nginx 里 proxy_set_header Origin ""（清空 Origin 绕过校验），
// 但那会一并废掉 CSWSH 防护（任何网站都能连你的服务器刷房），故改为显式白名单：
// 在 ECS 上配置 WS_ALLOWED_ORIGINS 列出所有合法的联机页面来源即可，安全与可用性兼得。
// 例：Environment=WS_ALLOWED_ORIGINS=https://searchdelta.online,https://ping-pong-duel.pages.dev
// 条目可写完整 origin（https://a.com）也可只写主机（a.com / a.com:8080），
// 内部统一归一成 host 再比对（URL.host 不含协议与端口以外的部分）。
const WS_ALLOWED_ORIGINS = String(process.env.WS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => {
    const t = s.trim().toLowerCase();
    if (!t) return '';
    try { return new URL(t).host; } catch (e) { return t; } // 无协议的裸主机名：原样保留
  })
  .filter(Boolean);
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

// 审计 2026-08-29（M5 修复）：判定请求是否来自本机/局域网（私有地址段）。
// /api/info 会返回服务器全部非回环 IPv4（含内网 IP 与 Radmin VPN 虚拟网卡地址）。
// 公网部署场景（ECS 8765 + 安全组 0.0.0.0/0）下，任何人访问该接口即可拿到内网拓扑。
// 判定取 Host 头与 socket 远端地址二者之一：经 nginx 反代时 remoteAddress 恒为 127.0.0.1，
// 只看远端地址会把公网请求误判为内网，因此必须以 Host 头为准。
function isPrivateRequester(req) {
  const PRIVATE = /^(127\.|::1$|localhost$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (host && PRIVATE.test(host)) return true;
  const ra = String((req.socket && req.socket.remoteAddress) || '').toLowerCase().replace(/^::ffff:/, '');
  return PRIVATE.test(ra);
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
  // 审计 #3:名字存储型 XSS——20 字符内可含 <svg onload=...> 等 HTML 载荷,
  // 服务端先剔除 < > 字符(前端渲染另有转义兜底,双保险)
  const name = String(b.name || '玩家').replace(/[<>]/g, '').slice(0, 20);  const mode = b.mode === 'ai' || b.mode === 'local' || b.mode === 'online' ? b.mode : 'other';
  const winner = b.winner === 0 ? 0 : 1;
  const sc = Array.isArray(b.score)
    ? b.score.slice(0, 2).map((v) => Math.max(0, Math.min(99, Math.round(Number(v) || 0))))
    : [0, 0];
  const difficulty = [0, 1, 2, 3].includes(Number(b.difficulty)) ? Number(b.difficulty) : 1;
  const ts = Number(b.ts) || Date.now();
  return { id: ts + '_' + Math.random().toString(36).slice(2, 8), name, mode, winner, score: sc, difficulty, ts };
}

// 校验并规整客户端上报的装扮(联机皮肤同步):只接受白名单 id,防注入。
// v2.1 特效分离:装扮仅 尾影/溅射 特效;球衣与拍面恒=队服(旗帜队色),球拍/上衣装扮已删除
// 审计 M4(2026-08-29):联机玩家名过滤，与 sanitizeRecord 及公网 DO 端(room-core.js)对齐。
// 联机名字会随 room / state 广播给对手；HUD 当前用 textContent 渲染（安全），
// 但名字不清洗等于把 XSS 载荷存下来广播，未来渲染方式一改就会被引爆。
// 与战绩名一致剔除 < > 并截断 12 字符（联机名上限比战绩名的 20 更严）。
function sanitizeName(s, fallback) {
  return String(s || fallback).replace(/[<>]/g, '').slice(0, 12);
}

function sanitizeSkin(s) {
  if (!s || typeof s !== 'object') return null;
  const ok = { trail: null, splash: false };
  if (typeof s.trail === 'string' && /^(yellow|black|red)$/.test(s.trail)) ok.trail = s.trail;
  ok.splash = !!s.splash;
  return ok;
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

// 审计 M3(2026-08-29):POST /api/records 写入限流（按来源 IP，滚动 60s 窗口）。
// DELETE 已有 RECORDS_TOKEN 保护（未配置则拒绝），但 POST 原本完全无鉴权：
// 任何人可循环写入，60 条上限(RECORDS_CAP)会被垃圾数据挤满、真实战绩被顶掉。
// 默认 20 条/分钟/IP（正常玩家一局才写 1 条，绰绰有余）；
// 设为 0 关闭限流（纯内网联机/本地调试场景）。Map 附带过期清理，避免随 IP 数无界增长。
const RECORDS_POST_LIMIT = Number(process.env.RECORDS_POST_LIMIT ?? 20);
const recordsPostHits = new Map();
function recordsPostLimited(req) {
  if (!RECORDS_POST_LIMIT) return false;
  const now = Date.now();
  const ip = String((req.socket && req.socket.remoteAddress) || 'unknown');
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
    // ★ 安全收敛: 不再返回 hostname(含 Windows 用户名) 与完整网卡清单(ifaces)，
    //   仅保留客户端房主面板必需的 ips + port，减少内网拓扑与个人身份泄露面
    // ★ 审计 M5(2026-08-29):公网来源不再返回局域网 IP——房主面板只在本地/局域网场景
    //   才需要展示"对方请打开 http://IP:端口"，公网部署一律返回空列表
    //   （客户端已有降级：空列表显示"未检测到局域网地址"提示，且公网模式本就不显示该面板）。
    res.end(JSON.stringify({ ok: true, version: VERSION, port: PORT, ips: isPrivateRequester(req) ? localIps() : [] }));
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
      // 审计 M3:公网可写接口加限流，防刷垃圾战绩顶掉真实记录（见 recordsPostLimited）
      if (recordsPostLimited(req)) {
        res.writeHead(429, Object.assign({ 'Retry-After': '60' }, cors));
        res.end(JSON.stringify({ ok: false, e: '写入过于频繁，请稍后再试' }));
        return;
      }
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
      // 按 id 删除一条记录（维护用；与 Cloudflare DO 行为一致）。
      // 审计 #18:公网/局域网 DELETE 无鉴权 → 任何人可任意删改战绩。加 token 保护:
      // 需 ?token= 匹配环境变量 RECORDS_TOKEN;未配置 RECORDS_TOKEN 时一律拒绝删除(只读保护)。
      const want = process.env.RECORDS_TOKEN;
      const q = new URLSearchParams(req.url.split('?')[1] || '');
      if (!want || q.get('token') !== want) {
        res.writeHead(403, cors); res.end(JSON.stringify({ ok: false, e: 'forbidden' })); return;
      }
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
  // 审计低危:startsWith(ROOT) 前缀检查可被 "public" 前缀兄弟目录绕过(如 public-evil),
  // 改用 path.relative 判定是否真正越出根目录
  if (path.relative(ROOT, filePath).startsWith('..')) {
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

// 从累积缓冲解析完整帧；返回 [frames, rest]。
// state = { fragOp, fragParts }：承载跨调用的分片状态——分片消息可能跨多个 data chunk,
// 若状态只存在函数内,续片会被当成独立消息处理(原代码 bug),且分片累积上限失效(审计 #1)。
// payload 超 maxPayload 抛错(上层捕获后断开连接,防超大帧/分片累积 DoS)
function parseFrames(acc, maxPayload, state) {
  const frames = [];
  let buf = acc;
  let fragOp = state.fragOp;
  let fragParts = state.fragParts;
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
      const n = buf.readBigUInt64BE(2);
      if (n > BigInt(maxPayload)) throw new Error('frame too large');
      len = Number(n); off = 10;
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
      // 分片累积上限:累计 payload 超限即拒绝(防分片无限累积)
      let total = payload.length;
      for (const p of fragParts) total += p.length;
      if (total > maxPayload) throw new Error('fragment too large');
      fragParts.push(payload);
      if (fin) { frames.push({ opcode: fragOp, payload: Buffer.concat(fragParts) }); fragOp = -1; fragParts = []; }
    } else if (opcode === 0x1 || opcode === 0x2) {
      if (fin) frames.push({ opcode, payload });
      else { fragOp = opcode; fragParts = [payload]; }
    } else {
      frames.push({ opcode, payload });
    }
  }
  state.fragOp = fragOp;
  state.fragParts = fragParts;
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
  // 审计 #13:50 次碰撞(31^4≈92 万组合,概率≈0)后不再回退固定码 'ABCD'——
  // 固定码不查重会被 rooms.set 顶掉活房;返回 null 由 create 报错重试
  return null;
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
      // v2.7.0-fix:输入帧序号（客户端会话内自增）：per-connection 水印丢弃乱序/重放
      // （WebSocket 有序传输下主要为去重/防迟到帧）；无 seq 的旧客户端照常处理（兼容）
      if (typeof msg.seq === 'number') {
        if (msg.seq <= client.lastInSeq) break;
        client.lastInSeq = msg.seq;
      }
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
      client.lastInputAt = Date.now(); // v2.6.0：输入超时判定的最后输入时刻
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
  // 审计低危:WS 升级无 Origin 校验(CSWSH)——恶意网页可跨站发起 WebSocket 连本地服务器刷房。
  // 规则:浏览器同源页面 Origin 须与 Host 头同 host;安卓 APK(file:// 页面)的 Origin 为
  // file:/null、curl 等非浏览器客户端无 Origin,一律放行——不影响局域网联机与安卓端。
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !/^file:/i.test(origin)) {
    let ohost = null;
    try { ohost = new URL(origin).host; } catch (e) { /* 非法 Origin 视为不匹配 */ }
    // 放行条件（满足其一）：
    //   1) 同源：Origin.host === Host（玩家直接打开本服务器页面，最常见场景）
    //   2) 白名单：Origin.host 在 WS_ALLOWED_ORIGINS 中（网页版托管在别的域名、跨源连本机）
    // 未命中一律断开——保留 CSWSH 防护，杜绝任意网站跨站连本地服务器刷房。
    const ohostL = ohost ? ohost.toLowerCase() : '';
    const hostL = String(req.headers.host || '').toLowerCase();
    if (!ohostL || (ohostL !== hostL && !WS_ALLOWED_ORIGINS.includes(ohostL))) {
      socket.destroy();
      return;
    }
  }
  const accept = crypto.createHash('sha1')
    .update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  // v2.7.0-fix:关闭 Nagle（参照 v2.1 server.js:394-396，v2.7 误删）——联机输入/快照都是小包，
  // 攒批会额外增加最多 ~40ms 延迟（公网明显）；实时游戏宁可多发小包也不要延迟。
  try { socket.setNoDelay(true); } catch (e) { /* ignore */ }

  const client = { ws: socket, room: null, side: -1, name: '', buf: Buffer.alloc(0), lastSeen: Date.now(), lastInputAt: Date.now(), lastInSeq: 0, fragState: { fragOp: -1, fragParts: [] } };
  socket.on('data', (chunk) => {
    // 审计 #6:任何数据到达都视为连接存活(僵尸清扫据此判定失联)
    client.lastSeen = Date.now();
    // 审计 #1:累积缓冲超限 → 恶意/失控客户端,直接断开(防内存 DoS)
    if (client.buf.length + chunk.length > WS_MAX_BUF) { socket.destroy(); return; }
    client.buf = Buffer.concat([client.buf, chunk]);
    let frames, rest;
    try {
      [frames, rest] = parseFrames(client.buf, WS_MAX_FRAME, client.fragState);
    } catch (e) {
      // 审计 #1:超大帧/分片超限 → 断开,不再继续解析
      socket.destroy();
      return;
    }
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
    // 审计 #6:断线不立即释放席位、不通知对手——进入重连宽限期(镜像 room-core handleClose):
    // 席位保留、名字保留,玩家宽限期内重连(带 side)对局无缝恢复;宽限到期由清扫器释放并
    // 通知对手,避免一次网络抖动就把整局打崩成"对手已离开"。
    detachClient(client);
  });
});

// 审计 #13:create/join 无速率限制 → 公网/局域网可枚举房间码、刷房占资源。
// 按连接限速(滚动 60s 窗口):create ≤8 次、join ≤30 次——正常客户端(含断线重连、
// 本地测试脚本)远低于此,超限多为枚举/刷房行为,拒绝并提示。DO 侧 room-core 有镜像
// 实现 _rateLimited,两端语义一致。
function rateLimited(client, kind, limit) {
  const now = Date.now();
  const rec = client.msgRate || (client.msgRate = {});
  rec[kind] = (rec[kind] || []).filter((t) => now - t < 60000);
  if (rec[kind].length >= limit) return true;
  rec[kind].push(now);
  return false;
}

function handleClientMessage(client, msg) {
  if (msg.t === 'create') {
    stats.create++;
    if (rateLimited(client, 'create', 8)) {
      send(client, { t: 'error', e: '操作过于频繁，请稍后再试' });
      return;
    }
    // 审计 #2:连接先建房 A 再 create/join 房 B → 房 A 的 room.clients 残留引用永不清理
    // (主循环只删双空房,A 永久 60Hz 空转;且同 ws 同时收 A、B 两个房间广播互相污染)。
    // 进入任何新房前先退出旧房(与 room-core 对齐)。
    if (client.room) leaveRoom(client);
    const code = newRoomCode();
    // 审计 #13:碰撞耗尽兜底不再回退固定码 'ABCD'(不查重会被 rooms.set 顶掉活房,
    // 原房间双方卡死)——返回 null 时报错重试。50 次碰撞概率≈0,纯防御性分支。
    if (!code) { send(client, { t: 'error', e: '创建失败，请重试' }); return; }
    const room = {
      code,
      engine: TT.createEngine(),
      clients: [null, null],
      lastSnap: '',
      lastSeen: [Date.now(), Date.now()], // 每席位最近活跃/断线时刻(审计 #6:断线宽限与僵尸清扫依据)
      skins: [null, null], // 联机皮肤同步(v2.0):双方装配的装扮,随 room/state 广播给对手
      accTime: 0,   // 固定步长累计器(镜像 DO stepRoom)：游戏时间按真实经过时间追赶，不被 setInterval 拖慢
      lastTick: 0,
    };
    rooms.set(code, room);
    client.room = room; client.side = 0; client.name = sanitizeName(msg.name, '玩家1');
    room.clients[0] = client;
    room.lastSeen[0] = Date.now();
    room.skins[0] = sanitizeSkin(msg.skin);
    broadcast(room, { t: 'room', code, side: 0, name: client.name, wait: true, skins: room.skins });
    return;
  }
  if (msg.t === 'join') {
    stats.join++;
    if (rateLimited(client, 'join', 30)) {
      send(client, { t: 'error', e: '操作过于频繁，请稍后再试' });
      return;
    }
    // 审计 #2:同上,先退旧房再进新房,防房间永久泄漏与双房间广播互相污染
    if (client.room) leaveRoom(client);
    const code = String(msg.room || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      send(client, { t: 'error', e: '房间不存在' });
      return;
    }
    // 审计 #6:side 接管——断线自动重连带原席位加入(msg.side=0/1,仅重连客户端才带 side)。
    // 本地服务器无身份鉴权,带 side 即视为重连请求:占位连接(可能已失联未触发 close)静默替换、
    // 释放旧连接(不惊动对手);DO 端因有 WebSocket readyState 与持久化 attachment,保留更严格的
    // curDead 判定(见 src/room-core.js handleJoin),本地从简以保证"一次网络抖动不打崩对局"。
    const wantSide = (msg.side === 0 || msg.side === 1) ? msg.side : -1;
    if (wantSide >= 0 && room.clients[wantSide] && room.clients[wantSide] !== client) {
      const old = room.clients[wantSide];
      old.room = null;
      stats.close++;
      try { old.ws.destroy(); } catch (e) { /* ignore */ }
      room.clients[wantSide] = null;
    }
    if (room.clients[0] && room.clients[1]) {
      send(client, { t: 'error', e: '房间已满' });
      return;
    }
    client.room = room; client.name = sanitizeName(msg.name, '玩家2');
    // 优先落位到请求的 side(接管成功则空出);否则按现有占位分配
    client.side = (wantSide >= 0 && !room.clients[wantSide]) ? wantSide : (room.clients[0] ? 1 : 0);
    room.clients[client.side] = client;
    room.lastSeen[client.side] = Date.now();
    room.skins[client.side] = sanitizeSkin(msg.skin); // 联机皮肤同步(v2.0)
    // v2.7.0-fix:等待标志与 room-core 对齐——仅双方席位都占用才 wait:false（原无条件 false，
    // 导致 host 断线重连带 side 回房时"独自开局"）；单人 join/重连回到等待面板
    const waiting = !(room.clients[0] && room.clients[1]);
    broadcast(room, { t: 'room', code, side: client.side, name: client.name, wait: waiting, skins: room.skins });
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

// ---------- 断线宽限与席位释放(审计 #6,镜像 room-core) ----------
// lastSeen 语义:每席位最近活跃/断线时刻;0 = 席位已释放(不再参与宽限计时)。
// 断线(close/拔网线)不立即释放席位,进宽限期等重连;宽限到期才释放并通知对手。

// 断线摘除:只摘连接,不通知对手、不释放席位——进宽限期(RECONNECT_GRACE_MS 内可重连恢复)
function detachClient(client) {
  if (!client.room) return;
  const room = client.room;
  const idx = room.clients.indexOf(client);
  if (idx >= 0) {
    room.clients[idx] = null;
    room.lastSeen[idx] = Date.now(); // 宽限期从断线时刻起算
  }
  client.room = null;
}

// 释放某席位(宽限到期/主动离开/僵尸清扫):摘除连接、通知对手、标记释放
function freeSlot(room, idx) {
  if (room.clients[idx] === null && room.lastSeen[idx] === 0) return; // 已释放,防重复通知
  room.clients[idx] = null;
  room.lastSeen[idx] = 0; // 0=已释放:不再参与宽限计时,房间可被回收
  const other = room.clients[0] || room.clients[1];
  if (other) {
    send(other, { t: 'peer_left', side: idx });
    const snap = TT.snapshot(room.engine);
    const my = other === room.clients[0] ? 0 : 1;
    send(other, { t: 'state', s: snap, n: room.clients.map((c) => (c ? c.name : '')), my });
  }
}

// 用户主动离开(换房/退出):立即释放席位并通知对手(不等宽限)
function leaveRoom(client) {
  if (!client.room) return;
  stats.close++;
  const room = client.room;
  const idx = room.clients.indexOf(client);
  client.room = null;
  if (idx < 0) return;
  freeSlot(room, idx);
  if (!room.clients[0] && !room.clients[1]) rooms.delete(room.code);
}

// 房间是否仍应保留:任一席位有存活连接,或任一席位处于断线宽限期(等重连)
function roomAlive(room, now) {
  for (let i = 0; i < 2; i++) {
    if (room.clients[i]) return true;                                  // 在线
    if (now - room.lastSeen[i] <= RECONNECT_GRACE_MS) return true;     // 断线宽限中(等重连)
  }
  return false;
}

// ---------- 主循环：60Hz 模拟 + 广播 ----------
// 固定 60Hz 步长 + 按真实经过时间累计追赶（镜像 DO stepRoom）：
// setInterval 被 tick 开销/机器负载拖慢时（实测曾掉到 ~41Hz），若每拍只步进固定 1/60，
// 游戏时间会永久落后墙钟（移动/物理全部变慢，联机手感"走不动"）。
// 累计器保证游戏时间始终贴近墙钟 1x：无论循环实际频率多少，物理都按 60Hz 步进补齐。
setInterval(() => {
  const nowTick = Date.now();
  for (const room of rooms.values()) {
    if (!roomAlive(room, nowTick)) {
      rooms.delete(room.code);
      continue;
    }
    const step = 1 / TICK_HZ;
    const last = room.lastTick || (nowTick - 1000 / TICK_HZ); // 新房间首拍按一帧计，立即步进
    // v2.7.1-fix:人满前冻结引擎推进（问题3：开房间等待期就开始比赛）。仅 1 人（等待对手）时
    // 不推进物理、不累时间，对手加入后双方从同一起跑线开始；重置 lastTick/accTime 不补等待期欠账。
    const roomFull = !!(room.clients[0] && room.clients[1]);
    if (!roomFull) {
      room.lastTick = nowTick;
      room.accTime = 0;
    } else {
      // v2.7.0-fix:accTime 追赶上限 0.5s→2.0s——断流/卡顿 >0.5s 后游戏时间不再永久落后墙钟
      //（恢复后最多一次补齐 2s，避免极端情况下瞬间追赶爆炸）
      room.accTime = Math.min(2.0, (room.accTime || 0) + (nowTick - last) / 1000);
      room.lastTick = nowTick;
      let n = 0;
      while (room.accTime >= step && n < 60) {
        TT.step(room.engine, step);
        room.accTime -= step;
        n++;
      }
    }
    // P0-4 广播节流：物理仍 60Hz 步进（accTime 已保证 1×），快照 stringify+广播按 25ms 地板（40Hz）。
    // 原"内容变化或≥50ms"因 t 每 tick 变导致恒真 → 每 tick 全量 snapshot+stringify（60Hz），
    // 是本地服务器 CPU/带宽热点（实测循环被拖慢）。改为仅在广播时 snapshot+stringify，省 ~1/3 开销；
    // 40Hz 插值锚点对客户端（滞后 25~80ms、缓冲 6 帧）仍平滑。
    if (nowTick - (room.lastSentAt || 0) >= 25) {
      const snap = TT.snapshot(room.engine);
      const data = JSON.stringify({ t: 'state', s: snap, n: room.clients.map((c) => (c ? c.name : '')), my: -1, skins: room.skins });
      stats.broadcast++;
      room.lastSentAt = nowTick;
      for (const c of room.clients) {
        // v2.7.0-fix:背压——发送缓冲超限（慢客户端）跳过本帧（快照全量、最新语义，丢旧保新）
        if (c && c.ws && c.ws.writable && c.ws.writableLength < 512 * 1024) {
          try { c.ws.write(encodeFrame(0x1, Buffer.from(data))); } catch (e) { /* ignore */ }
        }
      }
    }
    // v2.6.0：输入超时——客户端断线/静默超 1s 未发输入 → 清零该席位输入（TT.setInput 全 0），
    // 防止玩家永久保持蹲姿/移动状态广播给对手（keyup 丢失、网络静默、拔线未触发 close 等）
    for (let i = 0; i < 2; i++) {
      const c = room.clients[i];
      if (c && c.ws && c.ws.writable && nowTick - (c.lastInputAt || nowTick) > 1000) {
        TT.setInput(room.engine, i, { l: 0, r: 0, f: 0, b: 0, pu: 0, sm: 0, lb: 0, crouch: 0, run: 0 });
        c.lastInputAt = nowTick;
      }
    }
  }
}, 1000 / TICK_HZ);

// 审计 #6:断线清扫(每 5s,镜像 room-core sweepStale)——
// 拔网线/AP 断开时 socket close 可能数分钟不触发,席位被永久占用、对手卡死(本地重连必失败)。
// - 存活连接失联超 ZOMBIE_MS → 僵尸:释放席位并通知对手,销毁 socket;
// - 断线宽限(RECONNECT_GRACE_MS)到期仍未重连 → 释放席位并通知对手;
// - 双方席位都释放 → 删房。
// 正常客户端有心跳(ping 5s/次),lastSeen 恒新鲜,不会被误杀。
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (let i = 0; i < 2; i++) {
      const c = room.clients[i];
      if (c && now - c.lastSeen > ZOMBIE_MS) {
        stats.close++;
        freeSlot(room, i);
        try { c.ws.destroy(); } catch (e) { /* ignore */ }
      } else if (!c && room.lastSeen[i] !== 0 && now - room.lastSeen[i] > RECONNECT_GRACE_MS) {
        stats.close++;
        freeSlot(room, i);
      }
    }
  }
  for (const [code, room] of rooms) {
    if (!roomAlive(room, now)) rooms.delete(code);
  }
}, 5000);

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
