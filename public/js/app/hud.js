/* ============================================================
 * app/hud.js — 事件音效、提示与 HUD 计分板（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * ============================================================ */
(function () {
  'use strict';

  // 左上角：接球碰撞箱与蹲下最低接球高显示（数值与引擎 RULES 保持一致）
  if (PPD.ui.hitBallVal) {
    const R = PPD.TT.RULES;
    PPD.ui.hitBallVal.textContent =
      `${(R.HITBOX_HX * 2).toFixed(1)}×${(R.HITBOX_HZ * 2).toFixed(1)}×${(R.HITBOX_Y_TOP - R.HITBOX_Y_BOTTOM).toFixed(1)}m`;
  }
  if (PPD.ui.hitPaddleVal) PPD.ui.hitPaddleVal.textContent = `低至 ${PPD.TT.RULES.CROUCH_HITBOX_Y_BOTTOM}m`;

  // ---------- 事件 → 音效/提示 ----------
  // 得分方名称（按模式取 PPD.app.names：人机=昵称/电脑，AI 观战=双方 AI 名字，其余=玩家1/2）
  function winnerName(side) {
    const n = PPD.app.names || [];
    if (PPD.app.mode === 'ai') return side === 0 ? (n[0] || '你') : '电脑';
    if (PPD.app.mode === 'aivai') return side === 0 ? (n[0] || '红方 AI') : (n[1] || '蓝方 AI');
    return side === 0 ? (n[0] || '玩家1') : (n[1] || '玩家2');
  }

  function handleEngineEvents(engine) {
    const ev = engine.events;
    for (const e of ev) {
      const key = `${e.t.toFixed(3)}_${e.c}`;
      if (PPD.app.lastEventKeys.has(key)) continue;
      PPD.app.lastEventKeys.add(key);
      if (PPD.app.lastEventKeys.size > 20) {
        const first = PPD.app.lastEventKeys.values().next().value;
        PPD.app.lastEventKeys.delete(first);
      }
      switch (e.c) {
        case 'hit': PPD.GameAudio.hit(); break;
        case 'bounce':
          PPD.GameAudio.bounce();
          addFx('bounce', engine.ball.pos.x, engine.ball.pos.y, engine.ball.pos.z, engine.t);
          break;
        case 'net': PPD.GameAudio.net(); break;
        case 'serve': PPD.GameAudio.serve(); break;
        case 'serve-ready':
          // 新一轮发球：用最近指针位置恢复瞄准（人机/本地）
          if (PPD.app.mode === 'ai' && e.s === 0) PPD.refreshServeAim();
          if (PPD.app.mode === 'local') PPD.refreshServeAim();
          break;
        case 'point':
          if (e.s === -1) { PPD.GameAudio.letSound(); showPoint('触网入界 · 重发'); }
          else {
            PPD.GameAudio.score();
            PPD.GameAudio.cheer();   // 得分 → 掌声音效
            PPD.triggerCheer(e.s);   // 得分方观众欢呼、对方摇头
            const winner = winnerName(e.s);
            const reasonText = { double: '两次弹跳', out: '出界', 'opp-miss': '未能回球', volley: '违例拦击', 'serve-fault': '发球失误' }[engine.pointReason] || '';
            showPoint(`${winner} 得分${reasonText ? ' · ' + reasonText : ''}`);
          }
          break;
        case 'over':
          PPD.GameAudio.over();
          PPD.GameAudio.cheer();   // 终局 → 掌声
          PPD.triggerCheer(e.s);   // 胜方观众欢呼、败方摇头
          PPD.app.paused = false;
          PPD.show(PPD.ui.pausePanel, false);
          PPD.updateGameTools();
          // 地狱模式解锁：人机模式在困难难度下玩家获胜
          const hellUnlocked = PPD.app.mode === 'ai' && PPD.app.aiLevel === 2 && e.s === 0;
          if (hellUnlocked) PPD.unlockHell();
          // 地狱通关：人机模式在地狱难度下玩家获胜 → 解锁人机暂停的电脑 AI 数值调控
          if (PPD.app.mode === 'ai' && e.s === 0 && PPD.app.aiLevel === 3 && PPD.markHellCleared) {
            PPD.markHellCleared();
          }
          // 个人生涯：人机模式每局结束都记录胜负（winner=胜方 0=玩家 1=电脑；后端留最近 60 条）
          if (PPD.app.mode === 'ai' && PPD.saveRecord) {
            const eng = PPD.app.engine;
            PPD.saveRecord({
              name: (PPD.app.names && PPD.app.names[0]) || '玩家',
              mode: 'ai',
              winner: e.s === 0 ? 0 : 1,
              score: eng && eng.score ? [eng.score[0], eng.score[1]] : [0, 0],
              difficulty: PPD.app.aiLevel,
              ts: Date.now(),
            });
          }
          const overMsg = hellUnlocked
            ? '🎉 你赢了，已解锁地狱模式！'
            : `${winnerName(e.s)} 获胜！`;
          showPoint(overMsg);
          PPD.showGameOver(PPD.app.mode === 'ai'
            ? (e.s === 0 ? '您赢了' : '您输了')
            : `${winnerName(e.s)} 获胜`);
          break;
        case 'let': PPD.GameAudio.letSound(); showPoint('触网 · 重发'); break;
      }
    }
  }

  function addFx(type, x, y, z, t0) {
    PPD.app.fx.push({ type, x, y, z, t0 });
    if (PPD.app.fx.length > 12) PPD.app.fx.shift();
  }

  let pointToastTimer = null;
  function showPoint(text) {
    const el = PPD.ui.pointToast;
    el.textContent = text;
    el.style.opacity = 1;
    clearTimeout(pointToastTimer);
    pointToastTimer = setTimeout(() => { el.style.opacity = 0; }, 1800);
  }

  let phaseBannerTimer = null;
  function showPhase(text) {
    const el = PPD.ui.phaseBanner;
    el.textContent = text;
    el.style.opacity = 1;
    clearTimeout(phaseBannerTimer);
    phaseBannerTimer = setTimeout(() => { el.style.opacity = 0; }, 1400);
  }

  // ---------- 球高 + 进箱状态实时指示（左上角） ----------
  // 与引擎 strokes.js 的碰撞箱判定逐字一致：|dx|<HX 且 |dz|<HZ 且 箱底<y<箱顶
  function hitBoxOf(px, pz, facing, crouch) {
    const R = PPD.TT.RULES;
    return {
      x: px,
      z: pz + facing * 0.42,
      hx: R.HITBOX_HX,
      hz: R.HITBOX_HZ,
      yTop: crouch ? R.CROUCH_HITBOX_Y_TOP : R.HITBOX_Y_TOP,
      yBottom: crouch ? R.CROUCH_HITBOX_Y_BOTTOM : R.HITBOX_Y_BOTTOM,
    };
  }
  function ballInBox(box, b) {
    return Math.abs(b.x - box.x) < box.hx &&
      Math.abs(b.z - box.z) < box.hz &&
      b.y > box.yBottom && b.y < box.yTop;
  }
  // 感知辅助上升沿跟踪：球进"人类控制方"箱体的一瞬间播一次提示音
  let lastInBox = {};
  // "可扣杀"指示：与 AI 同一判定（computeShot 扣杀求解不降级即"可扣杀"），节流避免频繁求解
  let lastSmashCheck = 0;
  function canSmashNow(engine, i) {
    const b = engine && engine.ball;
    if (!b || !engine.players || engine.phase !== 'play' || b.inHand) return false;
    const p = engine.players[i], f = p.facing;
    const zc = p.z + f * 0.42;
    if (b.vel.z * f >= 0) return false;                       // 未朝本方来
    if (Math.abs(b.pos.z - zc) > 2.6) return false;            // 太远（求解无意义且省开销）
    const shot = PPD.TT.computeShot(engine, i, 2);
    return !!(shot && !shot.netHit);
  }
  // "可高吊"指示：蹲下+推球（推球进阶技巧）能否放出高吊——与人机 lb 同一求解判定
  function canLobNow(engine, i) {
    const b = engine && engine.ball;
    if (!b || !engine.players || engine.phase !== 'play' || b.inHand) return false;
    const p = engine.players[i], f = p.facing;
    const zc = p.z + f * 0.42;
    if (b.vel.z * f >= 0) return false;
    if (Math.abs(b.pos.z - zc) > 2.6) return false;
    const shot = PPD.TT.computeShot(engine, i, 1, { lob: true });
    return !!(shot && !shot.degraded);
  }
  function updateHitRangeLive() {
    const mode = PPD.app.mode;
    const elH = PPD.ui.ballHeight, elS = PPD.ui.inBoxStatus, elSm = PPD.ui.smashStatus, elLb = PPD.ui.lobStatus;
    // 左上角判定面板跟随主页开关：关闭时隐藏全部提示内容（接球箱/蹲下最低/球高/进箱）
    const panel = PPD.ui.hitRangeInfo;
    if (panel && panel.style.display !== (PPD.app.showHitRanges ? '' : 'none')) {
      panel.style.display = PPD.app.showHitRanges ? '' : 'none';
    }
    if (!elH || !elS || (mode !== 'local' && mode !== 'ai' && mode !== 'online')) return;
    // 球位置：本地/人机用引擎，联机用快照（飞行 b / 持球 bh）
    let bv = null;
    if (mode === 'online' && PPD.app.snapB) {
      const s = PPD.app.snapB;
      if (s.b) bv = { x: s.b[0], y: s.b[1], z: s.b[2] };
      else if (s.bh) bv = { x: s.bh[0], y: s.bh[1], z: s.bh[2] };
    } else if (PPD.app.engine && PPD.app.engine.ball) {
      bv = PPD.app.engine.ball.pos;
    }
    elH.textContent = bv ? bv.y.toFixed(2) + 'm' : '—';
    // 判定对象：人机=红方(昵称)，联机=自己，本地=P1+P2（名字优先，缺省 P1/P2/你）
    const sides = mode === 'local' ? [0, 1] : (mode === 'ai' ? [0] : [PPD.app.side]);
    const label = (i) => {
      if (mode === 'local') return PPD.app.names[i] || `P${i + 1}`;
      return PPD.app.names[PPD.app.side] || '你';
    };
    const ps = (i) => {
      if (mode === 'online' && PPD.app.snapB) {
        const p = PPD.app.snapB.p[i];
        return p ? { x: p.x, z: p.z, facing: i === 0 ? 1 : -1, crouch: p.cq } : null;
      }
      const p = PPD.app.engine && PPD.app.engine.players[i];
      return p ? { x: p.x, z: p.z, facing: p.facing, crouch: p.crouch } : null;
    };
    let anyIn = false;
    const inFlags = {};
    const parts = sides.map((i) => {
      const p = ps(i);
      const inBox = !!(p && bv && ballInBox(hitBoxOf(p.x, p.z, p.facing, p.crouch), bv));
      inFlags[i] = inBox;
      if (inBox) anyIn = true;
      return `${label(i)}${inBox ? ' 进箱' : ' 未进箱'}`;
    });
    elS.textContent = parts.join(' · ');
    elS.className = anyIn ? 'on' : 'off';
    // 感知辅助（仅判定范围显示开启时）：球进入"人类控制方"（人机=侧0；本地=P1/P2）
    // 箱体的上升沿 → 短提示音，帮玩家抓住出手时机；对打阶段才触发
    if (PPD.app.showHitRanges && (mode === 'ai' || mode === 'local') &&
        PPD.app.engine && PPD.app.engine.phase === 'play') {
      for (const i of sides) {
        if (inFlags[i] && !lastInBox[i] && PPD.GameAudio && PPD.GameAudio.ready) PPD.GameAudio.ready();
        lastInBox[i] = !!inFlags[i];
      }
    } else {
      lastInBox = {};
    }
    // 可扣杀/可高吊指示（节流 0.12s）：本地双人/人机/联机对"人类控制方"实时判定
    if ((elSm || elLb) && PPD.app.engine) {
      const now = performance ? performance.now() : Date.now();
      if (now - lastSmashCheck > 120) {
        lastSmashCheck = now;
        const smSides = mode === 'local' ? [0, 1] : (mode === 'ai' ? [0] : [PPD.app.side]);
        let anySmash = false, anyLob = false;
        for (const i of smSides) {
          if (canSmashNow(PPD.app.engine, i)) anySmash = true;
          if (canLobNow(PPD.app.engine, i)) anyLob = true;
          if (anySmash && anyLob) break;
        }
        if (elSm) { elSm.textContent = anySmash ? '可扣杀 ✓' : '暂不可'; elSm.className = anySmash ? 'on' : 'off'; }
        if (elLb) { elLb.textContent = anyLob ? '可高吊 ✓' : '暂不可'; elLb.className = anyLob ? 'on' : 'off'; }
      }
    }
  }

  // ---------- HUD ----------
  function updateHud() {
    let score = [0, 0], server = 0, phId = 0, names = PPD.app.names;
    if (PPD.app.mode === 'local' && PPD.app.engine) {
      score = PPD.app.engine.score;
      server = PPD.app.engine.server;
      phId = PPD.TT.PHASE_ID[PPD.app.engine.phase];
    } else if (PPD.app.mode === 'ai' && PPD.app.engine) {
      score = PPD.app.engine.score;
      server = PPD.app.engine.server;
      phId = PPD.TT.PHASE_ID[PPD.app.engine.phase];
      names = PPD.app.names;
    } else if (PPD.app.mode === 'aivai' && PPD.app.engine) {
      score = PPD.app.engine.score;
      server = PPD.app.engine.server;
      phId = PPD.TT.PHASE_ID[PPD.app.engine.phase];
      names = PPD.app.names;
    } else if (PPD.app.mode === 'online' && PPD.app.snapB) {
      score = PPD.app.snapB.sc;
      server = PPD.app.snapB.sv;
      phId = PPD.app.snapB.ph;
      names = PPD.app.names;
    }
    // 背景音乐紧张强度随比分实时变化（胶着/赛点节奏加快）
    if (PPD.app.mode !== null) PPD.updateMusicIntensity(score);
    // 联机时始终把自己显示在左侧 P1
    const disp = (PPD.app.mode === 'online' && PPD.app.side === 1)
      ? [names[1], names[0]]
      : names;
    PPD.ui.hudP1.textContent = `${disp[0] || '玩家1'}`;
    PPD.ui.hudP2.textContent = `${disp[1] || '玩家2'}`;
    // 联机时比分也按自己视角调换：左边永远是自己的分数
    PPD.$id('score1').textContent = PPD.app.mode === 'online' && PPD.app.side === 1 ? score[1] : score[0];
    PPD.$id('score2').textContent = PPD.app.mode === 'online' && PPD.app.side === 1 ? score[0] : score[1];
    const dot = PPD.ui.serveDot;
    const dotSide = PPD.app.mode === 'online' && PPD.app.side === 1 ? 1 - server : server;
    dot.style.left = dotSide === 0 ? 'calc(50% - 70px)' : 'calc(50% + 55px)';
    dot.style.opacity = 1;

    // 阶段横幅（仅在变化时）
    if (phId !== PPD.app.lastPhase) {
      if (PPD.app.lastPhase === 3) PPD.hideGameOver(); // 比赛结束 8 秒自动重开时关闭结算屏
      PPD.app.lastPhase = phId;
      const text = phId === 0 ? '发球' : phId === 1 ? '对打' : phId === 2 ? '得分' : '比赛结束';
      // 发球瞄准提示按设备区分：桌面只提鼠标，触屏才提"鼠标/手指"
      const aimHint = PPD.isTouch ? '移动鼠标/手指瞄准落点' : '移动鼠标瞄准落点';
      if (phId === 0 && PPD.app.mode === 'online') {
        showPhase(server === PPD.app.side ? `你的发球 · ${aimHint}` : '对方发球');
      } else if (phId === 0 && PPD.app.mode === 'ai') {
        const pn = (PPD.app.names && PPD.app.names[0]) || '你';
        showPhase(server === 0 ? `${pn} 发球 · ${aimHint}` : '电脑发球');
      } else if (phId === 0 && PPD.app.mode === 'local') {
        showPhase(`${server === 0 ? 'P1' : 'P2'} 发球 · ${aimHint}`);
      } else if (phId === 0 && PPD.app.mode === 'aivai') {
        const na = (PPD.app.names && PPD.app.names[0]) || '红方';
        const nb = (PPD.app.names && PPD.app.names[1]) || '蓝方';
        showPhase(`${server === 0 ? na : nb} 发球`);
      } else if (phId !== 2) {
        showPhase(text);
      }
    }

    if (PPD.app.mode === 'online') {
      PPD.ui.netInfo.textContent = PPD.app.net && PPD.app.net.connected ? `房间 ${PPD.app.roomCode}` : '连接中断';
    } else if (PPD.app.mode === 'ai') {
      const L = PPD.AIC.LEVELS[PPD.app.aiLevel] || PPD.AIC.LEVELS[1];
      PPD.ui.netInfo.textContent = `人机对战 · ${L.name}`;
    } else if (PPD.app.mode === 'aivai') {
      const LA = PPD.AIC.LEVELS[PPD.app.aiLevelA] || PPD.AIC.LEVELS[1];
      const LB = PPD.AIC.LEVELS[PPD.app.aiLevelB] || PPD.AIC.LEVELS[1];
      const tuned = (t) => Object.values(t).some((v) => v !== 1);
      PPD.ui.netInfo.textContent =
        `AI 观战 · 红${LA.name}${tuned(PPD.app.aiTuneA) ? '⚙' : ''} vs 蓝${LB.name}${tuned(PPD.app.aiTuneB) ? '⚙' : ''}`;
    } else {
      PPD.ui.netInfo.textContent = '本地双人';
    }

    // 左上角：球高 + 进箱状态实时刷新（每帧）
    updateHitRangeLive();
  }


  PPD.updateHud = updateHud;
  PPD.handleEngineEvents = handleEngineEvents;
  PPD.showPoint = showPoint;
  PPD.showPhase = showPhase;
  PPD.addFx = addFx;
})();