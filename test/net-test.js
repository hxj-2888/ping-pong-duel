/* 联机无头测试：真实 WebSocket 连接 × 2 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 8899;
const URL = `ws://127.0.0.1:${PORT}`;

function wsClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    const waiters = [];
    let latest = null;
    ws.onopen = () => resolve({
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
      })
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
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  await sleep(600);

  let failures = 0;
  function check(name, cond) {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
    if (!cond) failures++;
  }

  try {
    // /api/info：版本 + 端口 + IPv4 列表（房主面板显示联机地址、启动器版本校验的依据）
    try {
      const infoRes = await fetch(`http://127.0.0.1:${PORT}/api/info`);
      const info = await infoRes.json();
      check('/api/info 返回 ok', !!(info && info.ok));
      check('/api/info 版本形如 x.y.z-local', /^\d+\.\d+\.\d+-local$/.test(info.version || ''));
      check('/api/info 端口正确', info.port === PORT);
      check('/api/info ips 为数组', Array.isArray(info.ips));
    } catch (e) {
      check('/api/info 可访问', false);
    }

    const a = await wsClient();
    const b = await wsClient();

    a.send({ t: 'create', name: '小红' });
    const roomMsg = await a.next((m) => m.t === 'room');
    check('创建房间获得房号', /^[A-Z0-9]{4}$/.test(roomMsg.code));
    check('房主 side=0', roomMsg.side === 0);

    b.send({ t: 'join', room: roomMsg.code, name: '小蓝' });
    const joinMsg = await b.next((m) => m.t === 'room');
    check('加入方 side=1', joinMsg.side === 1);
    const hostMsg = await a.next((m) => m.t === 'room' && m.side === 1);
    check('房主收到对手加入通知', !!hostMsg);

    // 心跳 pong 带服务器版本（客户端据此识别旧服务器，防止"进房后双方卡死"）
    a.send({ t: 'ping' });
    const pong = await a.next((m) => m.t === 'pong');
    check('pong 带版本 ver', !!pong && /^\d+\.\d+\.\d+-local$/.test(pong.ver || ''));

    // 双方发输入
    a.send({ t: 'in', i: { l: 0, r: 1, pu: 0, sm: 0 } });
    b.send({ t: 'in', i: { l: 1, r: 0, pu: 0, sm: 0 } });
    await sleep(500);
    const st1 = a.latest;
    check('状态快照到达', !!st1 && !!st1.s);
    check('P0 向右移动', st1.s.p[0].x > 0.05);
    check('P1 向左移动', st1.s.p[1].x < -0.05);

    // 双方回中再发球：发球目标瞄准对手位置一半（clamp ±0.72），对手在边缘时发球轨迹贴边临界、
    // 60Hz 服务器实时计时下偶发出界（曾致「无回球时发球方得分」间歇失败）
    a.send({ t: 'in', i: { l: 1, r: 0, pu: 0, sm: 0 } });
    b.send({ t: 'in', i: { l: 0, r: 1, pu: 0, sm: 0 } });
    await sleep(400);
    a.send({ t: 'in', i: { l: 0, r: 0, pu: 0, sm: 0 } });
    b.send({ t: 'in', i: { l: 0, r: 0, pu: 0, sm: 0 } });
    await sleep(200);

    // 让 P0 发球（按 W）
    a.send({ t: 'in', i: { l: 0, r: 0, pu: 1, sm: 0 } });
    await sleep(150);
    a.send({ t: 'in', i: { l: 0, r: 0, pu: 0, sm: 0 } });
    let served = false;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      const st = a.latest && a.latest.s;
      if (st.ph === 1 && st.b) { served = true; break; }
    }
    check('发球进入对打阶段', served);
    a.drain(); b.drain();

    // 无人回球 → P0 得分（等 3.5 秒，留足余量避免负载下偶发超时）
    await sleep(3500);
    let score = null;
    for (let i = 0; i < 50; i++) {
      const st = a.latest && a.latest.s;
      if (st.sc[0] + st.sc[1] >= 1) { score = st.sc; break; }
      await sleep(100);
    }
    check('无回球时发球方得分', score && score[0] === 1 && score[1] === 0);

    // 房主请求重开（比赛未结束时不应重置）
    a.send({ t: 'rematch' });
    await sleep(300);
    const stAfter = a.latest.s;
    check('非结束时 rematch 无效', stAfter.sc[0] + stAfter.sc[1] >= 1);

    // 断线通知
    b.ws.close();
    const leftMsg = await a.next((m) => m.t === 'peer_left');
    check('房主收到对手离开通知', leftMsg.side === 1);

    a.ws.close();
    await sleep(300);
    console.log(failures === 0 ? '\n全部联机测试通过 ✓' : `\n${failures} 项失败 ✗`);
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (e) {
    console.error('测试异常:', e.message);
    process.exitCode = 1;
  } finally {
    // 必须先杀掉子进程再退出：process.exit 会跳过 finally，泄漏的服务器会让后续运行连到旧进程（串扰）
    child.kill();
  }
  setTimeout(() => process.exit(process.exitCode || 0), 300);
}

main();
