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
  //
  // 三层重试机制说明(审计 #12,各管一段、互不干扰):
  // 1) NetClient 握手重试(network.js maxRetries=2):连接从未 open 成功时,close 后自动重连,
  //    首次+2 次重试=最多 3 次尝试(间隔 1.2s×1.5^n);一旦 open 过即交棒给下层。
  // 2) join 超时自愈(joinTimer,下方 scheduleJoinRetry):WS 已 open 但 create/join 无响应,
  //    首次 12s、后续 6s 重连,共 4 次——防 DO 冷启动误报"建房超时"。
  // 3) 看门狗重连(MAX_RECONNECTS=2):open 成功后联机中判定 state/pong 超时,重连回原房间。
  // 最坏情况(连接从未成功)下 1)与 2)会叠加,实际 ~6 次握手/20-30s,属正常自愈路径而非死循环。
  const WATCHDOG_MS = 1000;    // 看门狗检查周期
  const STATE_STALE_MS = 6000; // state 超过该时长未更新 → 判定数据流中断（Alarm ≥2Hz，留足网络抖动余量）
  const PONG_STALE_MS = 25000; // v2.7.0-fix:pong 超过该时长未收到 → 判定半死连接（原 20s，公网高抖动下放宽）
  const MAX_RECONNECTS = 3;    // v2.7.0-fix:自动重连上限（原 2，公网高抖动下减少重连耗尽回菜单）
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
    // 审计 #4:清理上一会话残留的 joinTimer——陈旧定时器会在用户退出联机后仍触发
    // net.connect() 复活已关闭连接,后台建幽灵房间(最多 4 次持续 ~30s),并与新会话并发互相覆盖。
    if (PPD.app.joinTimer) { clearTimeout(PPD.app.joinTimer); PPD.app.joinTimer = null; }
    // 审计 #5:会话 token——backToMenu/closeNetPanel 递增;本会话各消息回调校验 token 失配即返回,
    // 防止在途 room/state 响应在用户退出后仍执行(被硬拉回对局)。
    PPD.app.netSessionToken = (PPD.app.netSessionToken || 0) + 1;
    const token = PPD.app.netSessionToken;
    // 每次开启新联机会话：复位重连状态与插值时钟
    PPD.app.reconnecting = false;
    PPD.app.reconnectAttempt = 0;
    PPD.app.reconnectStartedAt = 0;
    PPD.app.lastStateAt = 0;
    PPD.app.lastPongAt = 0;
    PPD.app.roomCode = ''; // 全新会话：清残留房间码，确保 hostMode 始终新建房间（修复本地建房失败）
    // 审计 #7:清跨会话残留的快照缓冲/插值状态——新房间引擎 t 从 0 开始,旧缓冲末帧 t 若 <1000ms,
    // 单调门判定不满足"大幅变小"条件 → 开局 ~1s 快照被丢弃 + 旧帧造成插值跳变
    PPD.app.snapBuf = null;
    PPD.app.interpClock = null;
    PPD.app._interpLast = null;
    PPD.app.interpGap = null;
    PPD.app.pred = null; // 本地玩家预测状态随新会话重建
    PPD.app.serverX = null; PPD.app.serverZ = null; // v2.6.0：纠偏目标随会话重建
    // 审计 #11:保存本会话玩家名——断线重连 join 用这个名字(不能用 names[0]:
    // 加入方 names[0] 可能被房主名覆盖,重连会让槽位被改名、生涯记录记错名)
    PPD.app.sessionName = PPD.getPlayerName ? (PPD.getPlayerName() || (hostMode ? '房主' : '挑战者')) : PPD.app.names[0];

    const net = new PPD.NetClient(PPD.wsUrl()); // 连接时按 本地/公网 选择端点
    PPD.app.net = net;
    // 建房/加入超时自愈：DO 冷启动/驱逐/网络抖动时服务器可能不响应 create/join
    // （WS 已 open 但 DO 尚未就绪或消息丢失），6s 无 room 响应 → 重连重试（最多 2 次）
    let joinTries = 0;
    const clearJoinTimer = () => { if (PPD.app.joinTimer) { clearTimeout(PPD.app.joinTimer); PPD.app.joinTimer = null; } };
    const scheduleJoinRetry = () => {
      clearJoinTimer();
      // P0-2 进房时序：缩短 create/join 无响应的等待并更早反馈——
      // 局域网/本地秒进，无需 12s 宽限；DO 冷启动由 NetClient 握手重试兜底。
      // 首次 4s、后续 3s，共 4 次重试。
      PPD.app.joinTimer = setTimeout(() => {
        // 审计 #4:会话已切换(用户退出/重开联机/返回菜单)→ 本定时器作废,绝不复活旧连接
        if (PPD.app.net !== net || token !== PPD.app.netSessionToken) return;
        if (joinTries >= 4) {
          PPD.setStatus(hostMode ? '建房超时，请重试' : '加入超时，请确认房间码后重试');
          return;
        }
        joinTries++;
        PPD.setStatus(hostMode ? '建房超时，自动重连中…' : '加入超时，自动重连中…');
        net.close();
        net.connect();
      }, joinTries === 0 ? 4000 : 3000);
    };
    net.on('open', () => {
      if (PPD.app.net !== net || token !== PPD.app.netSessionToken) return; // 会话已切换(审计 #5)
      PPD.setStatus('已连接服务器');
      // 心跳：连接期间每 5s 一次。作用：
      // 1) 等待对手/空闲时保持服务器侧活跃，减少 DO 驱逐；
      // 2) DO 驱逐恢复后，本条消息让服务器按 attachment 把本连接重挂回房间席位。
      if (!PPD.app.heartbeatTimer) {
        PPD.app.heartbeatTimer = setInterval(() => {
          if (PPD.app.net && PPD.app.net.connected) {
            PPD.app._pingSentAt = Date.now(); // fix:往返 RTT 测量——pong 回来时算 now-发送时刻（不依赖服务器时钟）
            PPD.app.net.send({ t: 'ping' });
          }
        }, 5000);
      }
      if (hostMode && !PPD.app.roomCode) {
        // 首次建房：尚无房间码，创建（带当前装配特效皮肤,服务器广播给对手;v2.1 仅尾影/溅射）
        net.send({ t: 'create', name: PPD.app.names[0], skin: PPD.app.equip });
        scheduleJoinRetry();
      } else if (PPD.app.reconnectAttempt > 0 && PPD.app.roomCode) {
        // 断线自动重连：重新加入原房间（带 side 提示，服务端据此夺回原席位）。
        // 审计 #11:用会话保存的本名(不能用 names[0]——加入方会被房主名覆盖导致槽位改名)
        net.send({ t: 'join', room: PPD.app.roomCode, name: PPD.app.sessionName, side: PPD.app.side, skin: PPD.app.equip });
      } else if (hostMode) {
        net.send({ t: 'create', name: PPD.app.names[0], skin: PPD.app.equip });
        scheduleJoinRetry();
      } else {
        net.send({ t: 'join', room: PPD.ui.joinInput.value.trim(), name: PPD.app.names[0], skin: PPD.app.equip });
        scheduleJoinRetry();
      }
    });
    net.on('room', (m) => {
      if (PPD.app.net !== net || token !== PPD.app.netSessionToken) return; // 会话已切换(审计 #5)
      clearJoinTimer();
      // 联机皮肤同步(v2.1):服务器广播双方装配特效(尾影/溅射),存对手皮肤供溅射归属;球衣/拍面恒=队服
      if (m.skins) PPD.app.oppSkin = m.skins[1 - m.side] || null;
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
        // 也可能是重连到空房/对手离开后只剩一人：回到联机框等待区（隐藏对局画面避免叠层）
        PPD.app.side = m.side;
        PPD.app.sideSet = true;
        PPD.show(PPD.ui.menu, false);
        PPD.show(PPD.ui.gameScreen, false);
        PPD.show(PPD.ui.netPanel, true);
        PPD.show(PPD.ui.netWait, true);
        PPD.show(PPD.ui.netOperate, false); // v1.6.1：房主建房后隐藏操作区（无需再输房间号）
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
        PPD.show(PPD.ui.netWait, false);
        PPD.app.lastStateAt = Date.now(); // 开局数据流基线：4s 内必有首帧快照
        if (PPD.app.mode !== 'online' || PPD.ui.gameScreen.style.display === 'none') {
          PPD.startOnlineGame(PPD.app.side); // 内部会隐藏主菜单与联机框
          // P0-2 首帧提示：进对局后 2s 仍无首帧快照 → 明确提示（避免黑屏/等待文字干等）
          clearTimeout(PPD.app.firstSnapTimer);
          PPD.app.firstSnapTimer = setTimeout(() => {
            if (PPD.app.net === net && token === PPD.app.netSessionToken &&
                PPD.app.mode === 'online' && !PPD.app.snapB) {
              PPD.setStatus('正在等待服务器数据…');
            }
          }, 2000);
        } else {
          // 已在对局中（重连/重挂补发的 room）：只隐藏遮罩，不重置快照避免闪屏
          PPD.show(PPD.ui.overlay, false);
        }
        // v2.7.0-fix:进房（对局建立/恢复）后补发握手/重连期间缓存的输入帧（NetClient 出站队列）
        if (net.flushPending) net.flushPending();
      }
    });
    net.on('pong', (m) => {
      if (PPD.app.net !== net || token !== PPD.app.netSessionToken) return; // 会话已切换(审计 #5)
      PPD.app.lastPongAt = Date.now();
      // fix:往返 RTT 测量——用客户端发送时刻（_pingSentAt）而非 m.st：
      // m.st 是服务器时钟，客户端与服务器时钟偏差（实测 CF ~430ms）会让单程差值变负被过滤
      if (PPD.app._pingSentAt) {
        const rtt = Date.now() - PPD.app._pingSentAt;
        PPD.app._pingSentAt = 0;
        if (rtt > 0 && rtt < 10000) {
          PPD.app.rtt = PPD.app.rtt == null ? rtt : PPD.app.rtt * 0.7 + rtt * 0.3;
        }
      }
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
      if (PPD.app.net !== net || token !== PPD.app.netSessionToken) return; // 会话已切换:退出后迟到的快照不得再执行(审计 #5)
      // 联机皮肤同步(v2.1):服务器广播双方装配特效(尾影/溅射),存对手皮肤供溅射归属
      if (m.skins) PPD.app.oppSkin = m.skins[1 - PPD.app.side] || null;
      PPD.app.lastStateAt = Date.now(); // 看门狗基线：服务端 Alarm 保证 ≥2Hz
      const wasReconnecting = PPD.app.reconnecting; // 先记录：下方会清除重连标记
      // 数据流恢复（重连后首帧到达）：结束重连状态
      if (PPD.app.reconnecting) {
        PPD.app.reconnecting = false;
        PPD.app.reconnectAttempt = 0;
        PPD.app.reconnectStartedAt = 0;
        PPD.show(PPD.ui.overlay, false);
        PPD.setStatus('已恢复连接');
      }
      // 快照缓冲（最近 6 帧，含引擎时间 t）：供 renderOnline 按插值时钟做跨帧平滑插值。
      // 单调门：丢弃同会话内 t 倒退/重复的快照（防止缓冲时间回退 → 渲染整帧回跳）。
      // 重连首帧 / 引擎重置（新对局 t 从 0 重来，t 大幅变小）→ 清空缓冲重新锚定后接受。
      const buf = (PPD.app.snapBuf = PPD.app.snapBuf || []);
      const snap = m.s || m;
      const newT = typeof snap.t === 'number' ? snap.t : null;
      if (newT != null && buf.length) {
        const lastT = buf[buf.length - 1].t;
        if (newT <= lastT) {
          if (wasReconnecting || newT < lastT - 1000) {
            buf.length = 0;
            PPD.app.snapA = null;
            PPD.app.snapB = null;
            PPD.app.interpClock = null;
            PPD.app.interpGap = null;
            PPD.app.interpLagged = false;
          } else {
            return; // 同会话乱序/重放：丢弃
          }
        }
      }
      buf.push({ t: newT, s: snap });
      if (buf.length > 6) buf.shift();
      // snapA/snapB 保持最近两帧（HUD 比分/发球方/阶段直接读 snapB；预测 reconcile 用最新）
      if (!PPD.app.snapB) {
        PPD.app.snapA = null;
      } else {
        PPD.app.snapA = PPD.app.snapB;
        PPD.app.tA = PPD.app.tB;
      }
      PPD.app.snapB = snap;
      PPD.app.tB = performance.now();
      if (PPD.Replay) PPD.Replay.recordOnline(snap);
      // 本地玩家输入预测：以服务器快照为锚（详见 render.js stepPrediction）。
      // 首次初始化；偏差校准（输入丢失/卡顿恢复/重连）时校正预测位置，避免长期漂移。
      // 正常对局时服务器只是滞后于预测（追赶中），不重置——保证本地手感即时。
      {
        const sp = PPD.app.snapB.p;
        const me = sp && sp[PPD.app.side];
        if (me) {
          if (!PPD.app.pred) {
            PPD.app.pred = { x: me.x, z: me.z, vx: me.vx || 0, vz: me.vz || 0, padX: me.pc ? me.pc[0] : me.x, crouch: me.cq || 0 };
            PPD.app.serverX = null; PPD.app.serverZ = null;
          } else {
            const ex = me.x - PPD.app.pred.x, ez = me.z - PPD.app.pred.z;
            if (Math.abs(ex) > 1.0 || Math.abs(ez) > 1.0) {
              if (Math.abs(ex) > 3 || Math.abs(ez) > 3) {
                // 严重失步（重连/传送/卡顿恢复）：整体硬校准回服务器
                PPD.app.pred.x = me.x; PPD.app.pred.z = me.z;
                PPD.app.pred.vx = me.vx || 0; PPD.app.pred.vz = me.vz || 0;
                PPD.app.pred.padX = me.pc ? me.pc[0] : me.x;
                PPD.app.pred.crouch = me.cq || 0;
                PPD.app.serverX = null; PPD.app.serverZ = null;
              } else {
                // v2.7.0-fix:1~3m 区间记录服务器位置，由 render.js stepPrediction 每帧按
                // "合法领先距离（RTT×速度）"平滑收敛（原 v2.6.0 只写不读=死代码，见 render.js stepPrediction）
                PPD.app.serverX = me.x;
                PPD.app.serverZ = me.z;
              }
            } else {
              // 偏差 ≤1m：正常范围，清掉陈旧纠偏目标（防 render 拉向过期位置）
              PPD.app.serverX = null;
              PPD.app.serverZ = null;
            }
          }
          // v2.7.0-fix:蹲姿同步——服务器 cq=0 且本地未按蹲时，pred.crouch 强制归 0
          //（Ctrl keyup 丢失/看门狗释放后 pred 可能残留蹲姿，而服务器已站立，本地却一直显示蹲）
          if (me.cq === 0 && PPD.app.keys && PPD.app.keys.crouch === 0 && PPD.app.pred.crouch > 0.3) {
            PPD.app.pred.crouch = 0;
          }
          // v2.7.2-fix:蹲姿分叉自愈——本地认为按住蹲（keys.crouch=1）但服务器快照持续站立
          //（cq<0.2）超 1.2s：说明蹲输入在服务器侧从未生效（keyup 丢失后本地一直上行 crouch=1
          // 但旧服务器不认 k 位 6、或输入断流后服务器已超时清零），强制本地释放并上行。
          // 消除"自己看蹲、对方看走、速度按走"的持久分叉；健康服务器按住 Ctrl 时 cq 会升到 1，
          // 不会误触发（引擎 crouch 纯跟随输入，无强制站立场景）。
          if (PPD.app.keys && PPD.app.keys.crouch === 1 && (me.cq || 0) < 0.2) {
            if (!PPD.app._crouchDisagreeAt) {
              PPD.app._crouchDisagreeAt = performance.now();
            } else if (performance.now() - PPD.app._crouchDisagreeAt > 1200) {
              if (PPD.app.keyP1) PPD.app.keyP1.crouch = 0;
              if (PPD.app.keyP2) PPD.app.keyP2.crouch = 0;
              PPD.app.keys.crouch = 0;
              PPD.app.pred.crouch = 0;
              PPD.app._crouchDisagreeAt = 0;
              if (PPD.sendOnlineKeys) PPD.sendOnlineKeys();
            }
          } else {
            PPD.app._crouchDisagreeAt = 0;
          }
          PPD.app.pred.t = performance.now();
        }
      }
      // 插值显示时钟（引擎时间 ms）：快照缓冲 + 实测间隔自适应（本地 60Hz≈17ms、公网 20Hz≈50ms）。
      // 时钟滞后最新快照 1.5 个实测间隔（渲染延迟 ~25-80ms），恒有可插值的相邻帧对，
      // 渲染时在缓冲内找跨时钟的帧对做 [0,1] 纯插值 → 任意广播率都平滑、无跳变无回退。
      // 首帧/断流/追赶（落后超 3 间隔）时向前锚定；正常由渲染循环按真实时间 1x 推进。
      {
        const t = typeof PPD.app.snapB.t === 'number' ? PPD.app.snapB.t : 0;
        if (buf.length >= 2) {
          const gap = Math.min(120, Math.max(16, buf[buf.length - 1].t - buf[buf.length - 2].t));
          PPD.app.interpGap = PPD.app.interpGap == null ? gap : PPD.app.interpGap * 0.7 + gap * 0.3;
          // v2.7.0-fix:插值滞后 = max(帧间隔×1.5, RTT×0.5+30)，钳位放宽到 25~120ms——
          // 公网高 RTT 下给足缓冲余量，避免时钟追平最新帧导致抽动；本地低 RTT 保持原手感
          const baseLag = (PPD.app.interpGap || 50) * 1.5;
          const rttLag = PPD.app.rtt != null ? PPD.app.rtt * 0.5 + 30 : 0;
          const lag = Math.max(25, Math.min(120, Math.max(baseLag, rttLag)));
          const target = PPD.app.snapB.t - lag;
          // 滞后建立：首帧/缓冲刚满 2 帧（interpLagged=false）时锚定到 target 建立渲染滞后
          // （否则时钟贴最新帧 → alpha 恒 1 → 低广播率按整帧步进 = 抽动）。
          // 此后时钟按真实时间 1x 推进（与服务器引擎时间同步率一致，小漂移由 lag 吸收），
          // 只在落后超 3 间隔（断流/追赶）时向前重锚，绝不回退重置。
          if (!PPD.app.interpLagged) {
            PPD.app.interpClock = target;
            PPD.app.interpLagged = true;
          } else if (target - PPD.app.interpClock > PPD.app.interpGap * 3) {
            PPD.app.interpClock = target;
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
          case 'hit':
            PPD.GameAudio.hit();
            // 追踪最后击球者(联机撞击溅射特效按击球者装备渲染,v2.0)
            PPD.app.lastHitter = e.s;
            break;
          case 'bounce': {
            PPD.GameAudio.bounce();
            const bb = (m.s && m.s.b) || null;
            if (bb) {
              // 发球阶段(ph=0)落台特效按发球方归属,修复开局 lastHitter 残留导致的波纹+溅射同屏
              const inServe = m.s.ph === 0;
              const hitterSide = inServe ? m.s.sv : (PPD.app.lastHitter >= 0 ? PPD.app.lastHitter : -1);
              PPD.addFx('bounce', bb[0], bb[1], bb[2], (m.s.t || PPD.app.snapB.t) / 1000, hitterSide);
            }
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
              // 失分原因（含未过网）：与本地/人机同一映射，按快照 pointReason 显示
              const reason = { double: '两次弹跳', out: '出界', 'opp-miss': '未能回球', volley: '违例拦击', 'serve-fault': '发球失误', 'no-cross': '未过网', 'serve-timeout': '发球超时' }[(m.s && m.s.pr) || ''] || '';
              PPD.showPoint(`${e.s === PPD.app.side ? '你' : '对手'} 得分${reason ? ' · ' + reason : ''}`);
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
            if (PPD.Replay) {
              PPD.Replay.finish({
                score: (PPD.app.snapB && PPD.app.snapB.sc) ? PPD.app.snapB.sc : [0, 0],
                winner: e.s,
                names: m.n || PPD.app.names,
                difficulty: 1,
              });
            }
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
            // 养成积分结算（v1.8.0）：联机固定 胜3/负1（训练属性不同步真人，但积分照给）
            if (PPD.awardPvp) PPD.awardPvp(e.s === PPD.app.side);
            break;
          case 'let': PPD.GameAudio.letSound(); PPD.showPoint('触网 · 重发'); break;
        }
      }
    });
    net.on('peer_left', () => {
      if (PPD.app.net !== net || token !== PPD.app.netSessionToken) return; // 会话已切换(审计 #5)
      PPD.showOverlay('对手已离开', '可返回菜单重新开始。', '返回菜单', PPD.backToMenu);
    });
    net.on('rematch', () => {
      if (PPD.app.net !== net || token !== PPD.app.netSessionToken) return; // 会话已切换(审计 #5)
      PPD.hideGameOver();
      PPD.app.snapA = null;
      PPD.app.lastPhase = -1;
      PPD.app.lastEventKeys.clear();
      // 撞击特效残留修复:rematch 新一局清空旧特效与击球者归属
      PPD.app.fx.length = 0;
      PPD.app.lastHitter = -1;
    });
    net.on('error', (e) => {
      if (PPD.app.net !== net || token !== PPD.app.netSessionToken) return; // 会话已切换(审计 #5)
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
      // 审计 #4:会话已切换(用户退出/重开)→ 不触发本连接的自动重连,也不清心跳(新会话的心跳归新连接管)
      if (PPD.app.net !== net || token !== PPD.app.netSessionToken) return;
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
      if (document.hidden) {
        // v2.6.0：切后台时清空蹲下键——Ctrl keyup 可能被浏览器吞掉（Ctrl+W/Tab、IME 等），
        // 导致 keys.crouch 永久卡 1（蹲下后无法站起）；后台期间统一释放
        if (PPD.app.keyP1) PPD.app.keyP1.crouch = 0;
        if (PPD.app.keyP2) PPD.app.keyP2.crouch = 0;
        if (PPD.app.keys) PPD.app.keys.crouch = 0;
      } else {
        PPD.app.lastStateAt = Date.now();
        PPD.app.lastPongAt = Date.now();
        if (PPD.app.net && PPD.app.net.connected) {
          PPD.app._pingSentAt = Date.now(); // fix:往返 RTT 测量（与心跳一致）
          PPD.app.net.send({ t: 'ping' });
        }
        // 回前台立即补发一次当前按键（后台 setInterval 已降频，即刻恢复输入流，消除回前台瞬间的卡顿/状态分叉）
        if (PPD.sendOnlineInput) PPD.sendOnlineInput();
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
        // 防火墙提示用真实端口（自定义 PORT 时不再误导写死 8765）
        if (PPD.ui.lanFirewallPort) {
          PPD.ui.lanFirewallPort.textContent = info.port || 8765;
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
