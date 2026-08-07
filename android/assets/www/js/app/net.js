/* ============================================================
 * app/net.js — 联机消息与断线处理（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * 包含：建房/加入、心跳、state/pong 数据看门狗 + 自动重连。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 断线自动重连（看门狗） ----------
  // 服务端 Alarm 保证联机数据流 ≥2Hz（强制兜底广播）：
  // 因此"联机中 >4s 收不到 state"即可判定为死链（不会把发球待发静止误判为卡死）。
  // 重连自动重新加入原房间（带 side 提示，服务端据此夺回原席位），最多 2 次，失败回菜单。
  const WATCHDOG_MS = 1000;    // 看门狗检查周期
  const STATE_STALE_MS = 6000; // state 超过该时长未更新 → 判定数据流中断（Alarm ≥2Hz，留足网络抖动余量）
  const PONG_STALE_MS = 20000; // pong 超过该时长未收到 → 判定半死连接
  const MAX_RECONNECTS = 2;    // 自动重连上限（超过回菜单）
  const RECONNECT_TIMEOUT_MS = 8000; // 重连 join 超过该时长无响应 → 本次重连作废进入下一轮

  // 看门狗：联机中周期性检查 state/pong 新鲜度
  function startWatchdog() {
    if (PPD.app.watchdogTimer) clearInterval(PPD.app.watchdogTimer);
    PPD.app.watchdogTimer = setInterval(() => {
      const now = Date.now();
      // 后台标签页被浏览器冻结时消息投递会暂停/积压：跳过判定，回前台由 visibilitychange 重置基线
      if (typeof document !== 'undefined' && document.hidden) return;
      if (PPD.app.mode !== 'online') return;
      // 重连的 join 长时间无响应（房间被清理/链路仍断）：本次尝试作废，进入下一轮
      if (PPD.app.reconnecting && PPD.app.reconnectStartedAt && now - PPD.app.reconnectStartedAt > RECONNECT_TIMEOUT_MS) {
        PPD.app.reconnecting = false;
        forceReconnect('重连超时');
        return;
      }
      if (!PPD.app.net || !PPD.app.net.connected) return; // 断线由 close/重连流程处理
      if (PPD.app.lastStateAt && now - PPD.app.lastStateAt > STATE_STALE_MS) {
        forceReconnect('数据流中断');
      } else if (PPD.app.lastPongAt && now - PPD.app.lastPongAt > PONG_STALE_MS) {
        forceReconnect('连接超时');
      }
    }, WATCHDOG_MS);
  }

  // 触发自动重连（幂等：重连进行中不再重复触发）
  function forceReconnect(reason) {
    if (PPD.app.reconnecting) return;
    PPD.app.reconnecting = true;
    PPD.app.reconnectStartedAt = Date.now();
    PPD.app.lastStateAt = Date.now(); // 每次尝试给足宽限，避免立即连环触发
    PPD.app.reconnectAttempt = (PPD.app.reconnectAttempt || 0) + 1;
    if (PPD.app.reconnectAttempt > MAX_RECONNECTS) {
      // 重试耗尽：断开并回菜单（用户可手动重新建房/加入）
      PPD.app.reconnecting = false;
      PPD.app.reconnectAttempt = 0;
      if (PPD.app.net) PPD.app.net.close();
      PPD.showOverlay('连接已断开', '无法恢复连接，请检查网络后重试。', '返回菜单', PPD.backToMenu);
      return;
    }
    // 第 1 轮重连不弹全屏遮罩（服务端有 15s 重连宽限期，快速恢复时对局观感不被打断）：
    // 仅状态栏提示；第 2 轮起才弹遮罩，最后一轮失败回菜单
    if (PPD.app.reconnectAttempt === 1) {
      PPD.setStatus('网络波动，正在重连…');
    } else {
      PPD.showOverlay('连接中断', `正在自动重连（${PPD.app.reconnectAttempt}/${MAX_RECONNECTS}）…`, '返回菜单', PPD.backToMenu);
    }
    const net = PPD.app.net;
    if (net) {
      net.close(); // closedByUser=true：不触发 close 事件（由本流程管理）
      net.connect();
    }
  }

  // ---------- 联机消息 ----------
  function setupNet(hostMode) {
    // 每次开启新联机会话：复位重连状态与插值时钟
    PPD.app.reconnecting = false;
    PPD.app.reconnectAttempt = 0;
    PPD.app.reconnectStartedAt = 0;
    PPD.app.lastStateAt = 0;
    PPD.app.lastPongAt = 0;
    PPD.app.interpClock = null;
    PPD.app._interpLast = null;
    PPD.app.pred = null; // 本地玩家预测状态随新会话重建

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
        PPD.app.heartbeatTimer = setInterval(() => { if (PPD.app.net && PPD.app.net.connected) PPD.app.net.send({ t: 'ping' }); }, 5000);
      }
      if (hostMode && !PPD.app.roomCode) {
        // 首次建房：尚无房间码，创建
        net.send({ t: 'create', name: PPD.app.names[0] });
        scheduleJoinRetry();
      } else if (PPD.app.reconnectAttempt > 0 && PPD.app.roomCode) {
        // 断线自动重连：重新加入原房间（带 side 提示，服务端据此夺回原席位）
        net.send({ t: 'join', room: PPD.app.roomCode, name: PPD.app.names[0], side: PPD.app.side });
      } else if (hostMode) {
        net.send({ t: 'create', name: PPD.app.names[0] });
        scheduleJoinRetry();
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
      // 重连成功：复位重连状态并隐藏重连遮罩
      if (PPD.app.reconnecting) {
        PPD.app.reconnecting = false;
        PPD.app.reconnectAttempt = 0;
        PPD.app.reconnectStartedAt = 0;
        PPD.show(PPD.ui.overlay, false);
        PPD.setStatus('已恢复连接');
      }
      if (m.wait) {
        // 房主：创建响应即确立自己的 side=0；之后加入方广播（side=1）不应覆盖。
        // 也可能是重连到空房/对手离开后只剩一人：回到等待面板（隐藏对局画面避免叠层）
        PPD.app.side = m.side;
        PPD.app.sideSet = true;
        PPD.show(PPD.ui.menu, false);
        PPD.show(PPD.ui.gameScreen, false);
        PPD.show(PPD.ui.roomPanel, true);
        PPD.ui.roomHint.textContent = '等待对手加入…';
        PPD.setStatus(`房间已创建：${m.code}`);
        renderLANUrls(); // 本地模式：显示"对方请打开 http://IP:端口"（含 Radmin VPN 虚拟网卡 IP）
      } else {
        // 加入方：首条非等待 room 消息才是"我的"（side=1）；房主已 sideSet，跳过
        if (!PPD.app.sideSet) {
          PPD.app.side = m.side;
          PPD.app.sideSet = true;
          if (m.side === 1) PPD.app.names[1] = m.name;
        }
        PPD.show(PPD.ui.roomPanel, false);
        PPD.app.lastStateAt = Date.now(); // 开局数据流基线：4s 内必有首帧快照
        if (PPD.app.mode !== 'online' || PPD.ui.gameScreen.style.display === 'none') {
          PPD.startOnlineGame(PPD.app.side);
        } else {
          // 已在对局中（重连/重挂补发的 room）：只隐藏遮罩，不重置快照避免闪屏
          PPD.show(PPD.ui.overlay, false);
        }
      }
    });
    net.on('pong', (m) => {
      PPD.app.lastPongAt = Date.now();
      // 本地模式：新版 server.js 的 pong 带 ver 字段；旧服务器（缺 k 位掩码输入解析）没有 →
      // 提示重启服务器，避免"进房后双方卡死"（输入被旧服务器静默丢弃）。只提示一次。
      if (!PPD.isLocalHost || PPD.app.publicServer || PPD.app.serverStaleWarned) return;
      if (!m || !m.ver) {
        PPD.app.serverStaleWarned = true;
        PPD.setStatus('⚠ 本地服务器版本过旧（不识别新版输入）：请重启本地服务器后重试');
      } else {
        PPD.app.serverVersion = m.ver;
      }
    });
    net.on('state', (m) => {
      PPD.app.lastStateAt = Date.now(); // 看门狗基线：服务端 Alarm 保证 ≥2Hz
      // 数据流恢复（重连后首帧到达）：结束重连状态
      if (PPD.app.reconnecting) {
        PPD.app.reconnecting = false;
        PPD.app.reconnectAttempt = 0;
        PPD.app.reconnectStartedAt = 0;
        PPD.show(PPD.ui.overlay, false);
        PPD.setStatus('已恢复连接');
      }
      if (!PPD.app.snapB) {
        PPD.app.snapA = null;
      } else {
        PPD.app.snapA = PPD.app.snapB;
        PPD.app.tA = PPD.app.tB;
      }
      PPD.app.snapB = m.s || m;
      PPD.app.tB = performance.now();
      // 本地玩家输入预测：以服务器快照为锚（详见 render.js stepPrediction）。
      // 首次初始化；明显偏差（输入丢失/卡顿恢复/重连）时重置回服务器位置，避免长期漂移。
      // 正常对局时服务器只是滞后于预测（追赶中），不重置——保证本地手感即时。
      {
        const sp = PPD.app.snapB.p;
        const me = sp && sp[PPD.app.side];
        if (me) {
          if (!PPD.app.pred) {
            PPD.app.pred = { x: me.x, z: me.z, vx: me.vx || 0, vz: me.vz || 0, padX: me.pc ? me.pc[0] : me.x, crouch: me.cq || 0 };
          } else if (Math.abs(me.x - PPD.app.pred.x) > 0.6 || Math.abs(me.z - PPD.app.pred.z) > 0.6) {
            PPD.app.pred.x = me.x; PPD.app.pred.z = me.z;
            PPD.app.pred.vx = me.vx || 0; PPD.app.pred.vz = me.vz || 0;
            PPD.app.pred.padX = me.pc ? me.pc[0] : me.x;
            PPD.app.pred.crouch = me.cq || 0;
          }
          PPD.app.pred.t = performance.now();
        }
      }
      // 插值显示时钟（引擎时间 ms）：服务端 20Hz 广播（间隔 50ms），客户端滞后一个
      // 间隔对相邻快照插值平滑（见 renderOnline/viewModelFromSnapInterp）。
      // 开局/断流/追赶时跳对齐；正常时由渲染循环按真实时间 1x 推进。
      {
        const INTERP_MS = 50; // 与服务端广播间隔一致（20Hz）
        const t = typeof PPD.app.snapB.t === 'number' ? PPD.app.snapB.t : 0;
        if (PPD.app.snapA && typeof PPD.app.snapA.t === 'number' && typeof PPD.app.snapB.t === 'number') {
          if (PPD.app.interpClock == null || PPD.app.snapB.t - PPD.app.interpClock > INTERP_MS * 1.5) {
            PPD.app.interpClock = PPD.app.snapB.t - INTERP_MS; // 断流/开局：跳到最新之后一个间隔
          }
        } else {
          PPD.app.interpClock = t;
        }
      }
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
            // 个人生涯：联机（真人）对局计入——记录自己视角的胜负（与本地双人/人机一致）
            if (PPD.saveRecord) {
              const n = PPD.app.names || [];
              const sc = (PPD.app.snapB && PPD.app.snapB.sc) ? PPD.app.snapB.sc : [0, 0];
              PPD.saveRecord({
                name: n[PPD.app.side] || '玩家',
                mode: 'online',
                winner: e.s === PPD.app.side ? 0 : 1,
                score: [sc[0], sc[1]],
                difficulty: 1,
                ts: Date.now(),
              });
            }
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
      const msg = e.e || '连接错误';
      // 浏览器"混合内容"拦截（https 网页版 new WebSocket('ws://…') 构造即抛错，已实测）：
      // 网页版无法直连局域网服务器，给出明确引导，且不要触发重连
      if (/insecure WebSocket|Mixed Content/i.test(msg)) {
        PPD.setStatus('⚠ 浏览器安全限制：https 网页版不能直连局域网服务器。请让对方直接打开 http://房主IP:8765 加入，或使用桌面版/安装包');
        return;
      }
      PPD.setStatus(msg);
      // 自动重连期间原房间已被清理/席位被占：放弃并回菜单（不再挂起重连状态）
      if (PPD.app.reconnecting && (e.e === '房间不存在' || e.e === '房间已满')) {
        PPD.app.reconnecting = false;
        PPD.app.reconnectAttempt = 0;
        PPD.app.reconnectStartedAt = 0;
        if (PPD.app.net) PPD.app.net.close();
        PPD.showOverlay('连接已断开', e.e === '房间不存在' ? '房间已不存在，请重新创建。' : '连接未能恢复，请返回菜单重试。', '返回菜单', PPD.backToMenu);
      }
    });
    net.on('close', () => {
      clearJoinTimer();
      if (PPD.app.heartbeatTimer) { clearInterval(PPD.app.heartbeatTimer); PPD.app.heartbeatTimer = null; }
      // 对局中或等待面板（房主已建房）意外断线（非用户主动关闭）：走自动重连，
      // forceReconnect 会显示重连遮罩；重连成功后按 roomCode re-join 回到原房间
      if (PPD.app.mode === 'online' || PPD.app.roomCode) {
        forceReconnect('连接断开');
      }
    });
    net.connect();
    startWatchdog();
  }

  // 后台标签页回前台：重置看门狗基线（后台期间消息可能积压/暂停，避免一回来就误判断线）+ 立即 ping
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        PPD.app.lastStateAt = Date.now();
        PPD.app.lastPongAt = Date.now();
        if (PPD.app.net && PPD.app.net.connected) {
          PPD.app.net.send({ t: 'ping' });
        }
      }
    });
  }

  // ---------- 局域网联机地址（房主等待面板） ----------
  // 本地模式建房后拉取 /api/info，列出"对方请打开 http://IP:端口"（多个网卡/Radmin VPN 虚拟网卡全列出）。
  // 公网模式 / 非 localhost（对方机器）不显示。
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(() => legacyCopy(t));
    } else legacyCopy(t);
  }
  function legacyCopy(t) {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }
  function renderLANUrls() {
    const el = PPD.ui.lanUrls;
    if (!el) return;
    if (!PPD.isLocalHost || PPD.app.publicServer) {
      PPD.show(el, false);
      PPD.show(PPD.ui.lanFirewallNote, false); // 公网模式/对方机器：不显示本地地址与解禁提醒
      return;
    }
    // 房主本地建房：显示"手动放行防火墙"提醒（仅提示，绝不自动执行解禁）
    PPD.show(PPD.ui.lanFirewallNote, true);
    fetch('/api/info', { cache: 'no-store' })
      .then((r) => r.json())
      .then((info) => {
        if (!info || !info.ok || !Array.isArray(info.ips) || !info.ips.length) {
          el.innerHTML = '<div class="lan-note">未检测到局域网地址：请先连接同一网络 / 开启 Radmin VPN，或用 <b>ipconfig</b> 查看本机 IPv4</div>';
          PPD.show(el, true);
          return;
        }
        const proto = location.protocol === 'https:' ? 'https' : 'http';
        // 优先用带网卡名的 ifaces（WLAN / 以太网 / Radmin VPN），缺失时回退纯 ips
        const ifaces = Array.isArray(info.ifaces) && info.ifaces.length ? info.ifaces : null;
        const items = ifaces
          ? ifaces.map((f) => ({ name: f.name || '', ip: f.address }))
          : info.ips.map((ip) => ({ name: '', ip }));
        el.innerHTML = '<div class="lan-title">对方请打开以下地址（并输入房间码）：</div>' +
          items.map((it) => {
            const url = `${proto}://${it.ip}:${info.port}`;
            const label = it.name ? `<span class="lan-iface">${it.name} · </span>` : '';
            return `<div class="lan-url"><code>${label}${url}</code><button type="button" class="lan-copy" data-url="${url}">复制</button></div>`;
          }).join('');
        PPD.app.lanInfo = info;
        PPD.show(el, true);
      })
      .catch(() => { /* 旧服务器无 /api/info：静默，仅显示默认提示 */ });
  }
  if (PPD.ui.lanUrls) {
    PPD.ui.lanUrls.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.lan-copy') : null;
      if (btn && btn.dataset.url) copyText(btn.dataset.url);
    });
  }

  PPD.setupNet = setupNet;
})();
