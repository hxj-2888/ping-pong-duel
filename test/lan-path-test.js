/* 局域网路径测试：模拟"手机/另一台设备从局域网 IP 加入"的完整链路
 *  - 起独立端口测试服务器
 *  - 通过 本机局域网IP（非 127.0.0.1）访问 /api/info 与首页（对应手机打开 http://IP:端口）
 *  - 用 ws://局域网IP:端口（显式目标地址，即"对方设备IP+房间码"加入方式的传输层）
 *    create + join + 互发输入 + 收 state 快照
 * 用法：node test\lan-path-test.js
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 8799;

function wsClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    let latest = null;
    ws.onopen = () => resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      get latest() { return latest; },
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
    });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      latest = m;
      inbox.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) waiters[i]();
    };
    ws.onerror = (e) => reject(e);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  await sleep(700);

  let failures = 0;
  const check = (name, cond) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
    if (!cond) failures++;
  };

  try {
    // 拿本机局域网 IPv4（房主面板显示的那串地址之一）
    const infoRes = await fetch(`http://127.0.0.1:${PORT}/api/info`);
    const info = await infoRes.json();
    check('/api/info 返回 ok', !!(info && info.ok));
    const lanIp = Array.isArray(info.ips) && info.ips.length ? info.ips[0] : null;
    check('检测到至少一个局域网 IPv4', !!lanIp);
    if (!lanIp) {
      console.log('（无局域网 IP：跳过手机路径模拟）');
      return;
    }

    // 手机路径①：通过局域网 IP 访问 /api/info 与首页（对应手机浏览器打开 http://IP:端口）
    try {
      const r1 = await fetch(`http://${lanIp}:${PORT}/api/info`);
      const j1 = await r1.json();
      check(`局域网IP访问 /api/info 正常 (http://${lanIp}:${PORT})`, !!(j1 && j1.ok));
    } catch (e) {
      check('局域网IP访问 /api/info 正常', false);
      console.log('  → 局域网IP被拒！大概率是 Windows 防火墙未放行 TCP ' + PORT + '（需管理员手动运行 tools\\局域网放行.cmd）');
    }
    try {
      const r2 = await fetch(`http://${lanIp}:${PORT}/`);
      const txt = await r2.text();
      check('局域网IP访问首页返回游戏页面', r2.status === 200 && txt.includes('乒乓对决'));
    } catch (e) {
      check('局域网IP访问首页返回游戏页面', false);
    }

    // 手机路径②：两个客户端都用显式目标地址 ws://局域网IP:端口（对应"对方设备IP + 房间码"加入方式）
    const url = `ws://${lanIp}:${PORT}`;
    const a = await wsClient(url);
    check(`显式地址直连成功 (${url})`, true);
    const b = await wsClient(url);
    a.send({ t: 'create', name: '房主' });
    const roomMsg = await a.next((m) => m.t === 'room');
    check('房主（经局域网IP）创建房间获得房号', /^[A-Z0-9]{4}$/.test(roomMsg.code));
    b.send({ t: 'join', room: roomMsg.code, name: '手机' });
    const joinMsg = await b.next((m) => m.t === 'room');
    check('加入方（经局域网IP）凭房间码加入 side=1', joinMsg.side === 1);

    // 互发输入 + 收 state 快照（对应手机端能实时同步比分/球）
    a.send({ t: 'in', k: 1, a: [0, 0] });
    b.send({ t: 'in', k: 4, a: [0, 0] });
    const st = await b.next((m) => m.t === 'state');
    check('加入方收到服务器状态快照（联机数据流正常）', !!(st && st.s));

    a.ws.close();
    b.ws.close();
    await sleep(300);
  } catch (e) {
    console.error('测试异常:', e.message);
    failures++;
  } finally {
    // 先杀子进程再延迟退出（process.exit 会跳过 finally，且 Windows 下立即 exit 会触发 libuv 断言）
    child.kill();
  }
  const code = failures ? 1 : 0;
  console.log(failures ? `\n${failures} 项失败` : '\n局域网路径测试全部通过 ✓');
  setTimeout(() => process.exit(code), 300);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
