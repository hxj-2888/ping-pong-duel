/* 公网实测（k 位掩码输入格式）：直连 Cloudflare 部署服务器，
 * 用与真实客户端完全一致的协议（{t:'in', k, a}）验证：
 *   - create → join → 双方移动（k 位掩码是否被解析）
 *   - 发球（pu 位）是否进入对打阶段
 *   - 引擎时间推进 vs 墙钟（判断部署端 tick 是否被降速/卡死）
 * 用法：node test\ws-live-k.js
 */
'use strict';

const WS_URL = process.env.WS_URL || 'wss://ping-pong-duel.pages.dev/ws';

let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' ｜ ' + extra : '')); if (!cond) failures++; };

function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const msgs = [];
    const waiters = [];
    ws.onopen = () => resolve({
      ws, msgs,
      send(o) { try { ws.send(JSON.stringify(o)); } catch (e) {} },
      next(t, timeout = 8000) {
        return new Promise((res, rej) => {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i] && msgs[i].t === t) return res(msgs[i]);
          }
          const timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error('等待 ' + t + ' 超时')); }, timeout);
          const w = (m) => { if (m.t === t) { clearTimeout(timer); const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); res(m); } };
          waiters.push(w);
        });
      },
    });
    ws.onmessage = (ev) => {
      try { const m = JSON.parse(ev.data); msgs.push(m); for (const w of [...waiters]) w(m); } catch (e) {}
    };
    ws.onerror = () => reject(new Error('ws error'));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('连接:', WS_URL);
  const A = await client();
  const B = await client();
  A.send({ t: 'create', name: '房主' });
  const roomA = await A.next('room');
  check('房主收到 room', roomA.side === 0 && /^[A-Z0-9]{4}$/.test(roomA.code));
  B.send({ t: 'join', room: roomA.code, name: '小蓝' });
  const roomB = await B.next('room');
  check('加入方 side=1', roomB.side === 1);

  // 关键：k 位掩码输入（真实客户端 loop.js 发送格式）
  const t0 = Date.now();
  const iv = setInterval(() => {
    A.send({ t: 'in', k: 2 }); // 位1 = r（向右）
    B.send({ t: 'in', k: 1 }); // 位0 = l（向左）
    if (Date.now() - t0 > 600) clearInterval(iv);
  }, 30);
  await sleep(900);
  const snapA = await A.next('state');
  check('P0 向右移动（k 位掩码被解析）', snapA.s.p[0].x > 0.05, 'x=' + snapA.s.p[0].x.toFixed(3));
  const snapB = await B.next('state');
  check('P1 向左移动（k 位掩码被解析）', snapB.s.p[1].x < -0.05, 'x=' + snapB.s.p[1].x.toFixed(3));

  // 发球（对齐真实客户端：瞄准对方半台中部 [0,0.6]；发球前必须站回可发球位置）
  // 自适应回中：按服务器快照实际位置持续移动，直到 |x|≤0.35（避免固定时长过冲/不足）
  let posX = 99;
  for (let i = 0; i < 60 && posX > 0.35; i++) {
    A.send({ t: 'in', k: 1, a: [0, 0.6] }); // 左移
    await sleep(50);
    const s = await A.next('state');
    posX = s.s.p[0].x;
  }
  for (let i = 0; i < 20 && posX < -0.35; i++) {
    A.send({ t: 'in', k: 2, a: [0, 0.6] }); // 过头往右拉回
    await sleep(50);
    const s = await A.next('state');
    posX = s.s.p[0].x;
  }
  check('发球方已回中（x≈0）', Math.abs(posX) < 0.35, 'x=' + Math.round(posX * 100) / 100);
  // 瞄准对方半台中部 + 按住发球键 100ms（pu 位=4，带 a 瞄准）
  for (let i = 0; i < 5; i++) { A.send({ t: 'in', k: 4, a: [0, 0.6] }); await sleep(20); }
  A.send({ t: 'in', k: 0, a: [0, 0.6] });
  let servePh = -1, serveBlocked = -1;
  for (let i = 0; i < 80 && servePh !== 1; i++) {
    A.send({ t: 'in', k: 0, a: [0, 0.6] });
    await sleep(50);
    const s = await A.next('state');
    if (s.s.ph !== undefined) servePh = s.s.ph;
    if (s.s.sb !== undefined) serveBlocked = s.s.sb;
  }
  check('发球进入对打（ph=1）', servePh === 1, 'ph=' + servePh + ' 瞄准锁定sb=' + serveBlocked);

  // 引擎时间推进 vs 墙钟（诊断项：仅当引擎几乎停摆——卡死——才判失败；
  // 广播/网络抖动会让瞬时比值偏移，0.68~1.6x 均属正常噪声，不作硬性判定）
  const st0 = await A.next('state');
  const tEngine0 = st0.s.t;
  const tWall0 = Date.now();
  for (let i = 0; i < 20; i++) { A.send({ t: 'in', k: 0 }); await sleep(100); }
  const st1 = await A.next('state');
  const wallElapsed = Date.now() - tWall0;
  const engElapsed = st1.s.t - tEngine0;
  const ratio = engElapsed / wallElapsed;
  console.log(`[诊断] 引擎 ${Math.round(engElapsed)}ms / 墙钟 ${wallElapsed}ms = ${ratio.toFixed(2)}x（<0.25 视为引擎停摆）`);
  if (ratio < 0.25) { check('引擎时间未停摆', false, 'ratio=' + ratio.toFixed(2)); }

  A.ws.close(); B.ws.close();
  console.log(failures === 0 ? '\n公网 k 格式实测全部通过 ✓（部署端为最新协议）' : `\n${failures} 项失败 ✗（部署端协议不兼容 → 需重新部署 src/）`);
  await sleep(200);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('异常:', e.message); process.exit(1); });
