/* ============================================================
 * app/net.js — 联机消息与断线处理（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 联机消息 ----------
  function setupNet(hostMode) {
    const net = new PPD.NetClient(PPD.wsUrl()); // 连接时按 本地/公网 选择端点
    PPD.app.net = net;
    // 建房/加入超时自愈：DO 冷启动/驱逐/网络抖动时服务器可能不响应 create/join
    // （WS 已 open 但 DO 尚未就绪或消息丢失），6s 无 room 响应 → 重连重试（最多 2 次）
    let joinTries = 0;
    let joinTimer = null;
    const clearJoinTimer = () => { if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; } };
    const scheduleJoinRetry = () => {
      clearJoinTimer();
      joinTimer = setTimeout(() => {
        if (joinTries >= 2) {
          PPD.setStatus(hostMode ? '建房超时，请重试' : '加入超时，请确认房间码后重试');
          return;
        }
        joinTries++;
        PPD.setStatus(hostMode ? '建房超时，自动重连中…' : '加入超时，自动重连中…');
        net.close();
        net.connect();
      }, 6000);
    };
    net.on('open', () => {
      PPD.setStatus('已连接服务器');
      // 心跳：连接期间每 5s 一次。作用：
      // 1) 等待对手/空闲时保持服务器侧活跃，减少 DO 驱逐；
      // 2) DO 驱逐恢复后，本条消息让服务器按 attachment 把本连接重挂回房间席位。
      if (!PPD.app.heartbeatTimer) {
        PPD.app.heartbeatTimer = setInterval(() => { if (net.connected) net.send({ t: 'ping' }); }, 5000);
      }
      if (hostMode) {
        net.send({ t: 'create', name: PPD.app.names[0] });
        scheduleJoinRetry(); // 房主也要超时自愈（create 无响应时自动重连）
      } else {
        net.send({ t: 'join', room: PPD.ui.joinInput.value.trim(), name: PPD.app.names[0] });
        scheduleJoinRetry();
      }
    });
    net.on('room', (m) => {
      clearJoinTimer();
      PPD.GameAudio.ensure();
      PPD.app.roomCode = m.code;
      PPD.app.names[0] = m.name;
      if (m.side === 0) PPD.app.names[0] = m.name;
      PPD.ui.roomCode.textContent = m.code;
      if (m.wait) {
        // 房主：创建响应即确立自己的 side=0；之后加入方广播（side=1）不应覆盖
        PPD.app.side = m.side;
        PPD.app.sideSet = true;
        PPD.show(PPD.ui.menu, false); // 隐藏主菜单，避免与房间面板叠加
        PPD.show(PPD.ui.roomPanel, true);
        PPD.ui.roomHint.textContent = '等待对手加入…';
        PPD.setStatus(`房间已创建：${m.code}`);
      } else {
        // 加入方：首条非等待 room 消息才是"我的"（side=1）；房主已 sideSet，跳过
        if (!PPD.app.sideSet) {
          PPD.app.side = m.side;
          PPD.app.sideSet = true;
          if (m.side === 1) PPD.app.names[1] = m.name;
        }
        PPD.show(PPD.ui.roomPanel, false);
        PPD.startOnlineGame(PPD.app.side);
      }
    });
    net.on('state', (m) => {
      if (!PPD.app.snapB) {
        PPD.app.snapA = null;
      } else {
        PPD.app.snapA = PPD.app.snapB;
        PPD.app.tA = PPD.app.tB;
      }
      PPD.app.snapB = m.s || m;
      PPD.app.tB = performance.now();
      if (m.n) PPD.app.names = m.n;
      // 在线音效：比较事件
      const evs = (m.s && m.s.ev) || [];
      for (const e of evs) {
        const key = `${e.t}_${e.c}`;
        if (PPD.app.lastEventKeys.has(key)) continue;
        PPD.app.lastEventKeys.add(key);
        if (PPD.app.lastEventKeys.size > 24) PPD.app.lastEventKeys.delete(PPD.app.lastEventKeys.values().next().value);
        switch (e.c) {
          case 'hit': PPD.GameAudio.hit(); break;
          case 'bounce': {
            PPD.GameAudio.bounce();
            const bb = (m.s && m.s.b) || null;
            if (bb) PPD.addFx('bounce', bb[0], bb[1], bb[2], (m.s.t || PPD.app.snapB.t) / 1000);
            break;
          }
          case 'net': PPD.GameAudio.net(); break;
          case 'serve': PPD.GameAudio.serve(); break;
          case 'serve-ready':
            // 新一轮发球：轮到我就用最近指针位置恢复瞄准（预览由服务端快照 sp 驱动）
            if (e.s === PPD.app.side) PPD.refreshServeAim();
            break;
          case 'point':
            if (e.s === -1) { PPD.GameAudio.letSound(); PPD.showPoint('触网入界 · 重发'); }
            else {
              PPD.GameAudio.score();
              PPD.GameAudio.cheer();   // 得分 → 掌声音效
              PPD.triggerCheer(e.s);   // 得分方观众欢呼、对方摇头
              PPD.showPoint(`${e.s === PPD.app.side ? '你' : '对手'} 得分`);
            }
            break;
          case 'over':
            PPD.GameAudio.over();
            PPD.GameAudio.cheer();   // 终局 → 掌声
            PPD.triggerCheer(e.s);   // 胜方观众欢呼、败方摇头
            PPD.app.paused = false;
            PPD.show(PPD.ui.pausePanel, false);
            PPD.updateGameTools();
            PPD.showPoint(e.s === PPD.app.side ? '你赢了！' : '对手获胜');
            PPD.showGameOver(e.s === PPD.app.side ? '您赢了' : '您输了');
            break;
          case 'let': PPD.GameAudio.letSound(); PPD.showPoint('触网 · 重发'); break;
        }
      }
    });
    net.on('peer_left', () => {
      PPD.showOverlay('对手已离开', '可返回菜单重新开始。', '返回菜单', PPD.backToMenu);
    });
    net.on('rematch', () => {
      PPD.hideGameOver();
      PPD.app.snapA = null;
      PPD.app.lastPhase = -1;
      PPD.app.lastEventKeys.clear();
    });
    net.on('error', (e) => {
      PPD.setStatus(e.e || '连接错误');
    });
    net.on('close', () => {
      clearJoinTimer();
      if (PPD.app.heartbeatTimer) { clearInterval(PPD.app.heartbeatTimer); PPD.app.heartbeatTimer = null; }
      if (PPD.app.mode === 'online') {
        PPD.showOverlay('连接已断开', '请检查服务器是否运行。', '返回菜单', PPD.backToMenu);
      }
    });
    net.connect();
  }


  PPD.setupNet = setupNet;
})();