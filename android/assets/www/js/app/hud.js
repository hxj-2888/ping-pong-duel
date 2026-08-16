/* ============================================================
 * app/hud.js — 事件音效、提示与 HUD 计分板（拆分自 main.js）
 * 通过共享对象 PPD（app/state.js）访问公共状态与接口。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 事件 → 音效/提示 ----------
  // 得分方名称（按模式取 PPD.app.names：人机=昵称/电脑，模拟推演=甲乙 AI 名字，其余=玩家1/2）
  function winnerName(side) {
    const n = PPD.app.names || [];
    if (PPD.app.mode === 'ai') return side === 0 ? (n[0] || '你') : '电脑';
    if (PPD.app.mode === 'aivai') return side === 0 ? (n[0] || '甲 AI') : (n[1] || '乙 AI');
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
        case 'hit':
          PPD.GameAudio.hit();
          // 追踪最后击球者(联机/本地撞击溅射特效按击球者装备渲染,v2.0)
          PPD.app.lastHitter = e.s;
          // v2.0:感叹号仅在"反击扣杀/低平快球"时触发(wasCounter:推球回击扣杀/低平,AI 也记录):
          // 人机模式玩家(e.s=0)反击 → 电脑;观战(aivai)任一 AI 反击 → 对方 AI;对扣/普通推球不触发
          if (engine.ball.wasCounter === 1) {
            if ((PPD.app.mode === 'ai' && e.s === 0) || PPD.app.mode === 'aivai') {
              if (engine.players[1 - e.s]) engine.players[1 - e.s].exclaimT = 0.8;
            }
          }
          break;
        case 'bounce':
          PPD.GameAudio.bounce();
          // 发球阶段落台特效按发球方归属(修复开局 lastHitter 残留导致的波纹+溅射同屏);对打阶段由 addFx 用 lastHitter
          addFx('bounce', engine.ball.pos.x, engine.ball.pos.y, engine.ball.pos.z, engine.t,
            engine.phase === 'serve' ? engine.server : (PPD.app.lastHitter >= 0 ? PPD.app.lastHitter : -1));
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
            const reasonText = { double: '两次弹跳', out: '出界', 'opp-miss': '未能回球', volley: '违例拦击', 'serve-fault': '发球失误', 'no-cross': '未过网', 'serve-timeout': '发球超时' }[engine.pointReason] || '';
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
          // 无尽人机：胜利 → 解锁下一关；落败 → 闯关进度回到无尽-1（AI 观战已解锁项保留）
          if (PPD.app.mode === 'ai' && PPD.app.aiGameType === 'endless') {
            if (e.s === 0 && PPD.advanceEndless) PPD.advanceEndless(PPD.app.endlessLevel);
            else if (e.s === 1 && PPD.resetEndless) PPD.resetEndless();
          }
          // 个人生涯：人机/本地双人/联机每局结束都记录（winner=玩家视角胜负；后端留最近 60 条）
          const recMode = PPD.app.mode === 'ai'
            ? (PPD.app.aiGameType === 'endless' ? 'endless' : 'ai')
            : (PPD.app.mode === 'local' ? 'local' : 'online');
          if ((PPD.app.mode === 'ai' || PPD.app.mode === 'local' || PPD.app.mode === 'online') && PPD.saveRecord) {
            const eng = PPD.app.engine;
            const n = PPD.app.names || [];
            let recName, recWinner;
            if (PPD.app.mode === 'ai') { recName = n[0] || '玩家'; recWinner = e.s === 0 ? 0 : 1; }
            else if (PPD.app.mode === 'local') { recName = n[0] || '玩家1'; recWinner = e.s === 0 ? 0 : 1; }
            else { recName = n[PPD.app.side] || '玩家'; recWinner = e.s === PPD.app.side ? 0 : 1; }
            PPD.saveRecord({
              name: recName,
              mode: recMode,
              winner: recWinner,
              score: eng && eng.score ? [eng.score[0], eng.score[1]] : [0, 0],
              difficulty: PPD.app.mode === 'ai'
                ? (PPD.app.aiGameType === 'endless' ? PPD.app.endlessLevel : PPD.app.aiLevel)
                : 1,
              ts: Date.now(),
            });
          }
          // 养成积分结算（v2.0）：人机按难度(简单1/中等2/困难3/地狱5)+胜满负半；本地双人固定 胜2/负1
          if (PPD.app.mode === 'ai' && PPD.awardAi) {
            PPD.awardAi(PPD.app.aiLevel, e.s === 0);
          } else if (PPD.app.mode === 'local' && PPD.awardPvp) {
            PPD.awardPvp(e.s === 0);
          }
          // v2.0:首次击败困难/地狱一次性奖励(人机玩家获胜):困难+50/地狱+100,奖励文本合并到页面中央结算提示
          const bonusText = (PPD.app.mode === 'ai' && e.s === 0 && PPD.awardBonus) ? PPD.awardBonus(PPD.app.aiLevel) : null;
          const overMsg = [bonusText,
            hellUnlocked ? '🎉 你赢了，已解锁地狱模式！' : `${winnerName(e.s)} 获胜！`
          ].filter(Boolean).join(' · ');
          showPoint(overMsg);
          PPD.showGameOver(PPD.app.mode === 'ai'
            ? (e.s === 0 ? '您赢了' : '您输了')
            : `${winnerName(e.s)} 获胜`);
          // 赛后回放：终局落盘本场回放（结算页「查看回放/保存回放」按钮随之可用）
          if (PPD.Replay) {
            PPD.Replay.finish({
              score: PPD.app.engine && PPD.app.engine.score ? [PPD.app.engine.score[0], PPD.app.engine.score[1]] : [0, 0],
              winner: e.s,
              names: PPD.app.names,
              difficulty: PPD.app.mode === 'ai'
                ? (PPD.app.aiGameType === 'endless' ? PPD.app.endlessLevel : PPD.app.aiLevel)
                : 1,
            });
          }
          break;
        case 'let': PPD.GameAudio.letSound(); showPoint('触网 · 重发'); break;
      }
    }
  }

  function addFx(type, x, y, z, t0, hitterSide) {
    // 撞击特效归属(v2.0):
    // - 本地/人机/观战:装备溅射后不分敌我,双方打出的球落台统一用本机装备特效(修复开局波纹+溅射同屏)
    // - 联机:发球阶段(bounce 传发球方 side)按发球方装备、对打按 lastHitter,双方看到一致;
    //   hitterSide 无效(-1)时回退本机装备
    let splashOn;
    if (PPD.app.mode === 'online') {
      if (hitterSide === PPD.app.side) splashOn = !!(PPD.app.equip && PPD.app.equip.splash);
      else if (hitterSide === 1 - PPD.app.side) splashOn = !!(PPD.app.oppSkin && PPD.app.oppSkin.splash);
      else splashOn = !!(PPD.app.equip && PPD.app.equip.splash);
    } else {
      splashOn = !!(PPD.app.equip && PPD.app.equip.splash);
    }
    const t = (type === 'bounce' && splashOn) ? 'splash' : type;
    // v2.4 预算：fx 同屏上限 8（原 12）；splash 类型同屏最多 3 个（超出替换最旧溅射，避免连续撞击累积尖峰）
    if (t === 'splash') {
      let n = 0, firstSplash = -1;
      for (let i = 0; i < PPD.app.fx.length; i++) {
        if (PPD.app.fx[i].type === 'splash') { n++; if (firstSplash < 0) firstSplash = i; }
      }
      if (n >= 3 && firstSplash >= 0) PPD.app.fx.splice(firstSplash, 1);
    }
    PPD.app.fx.push({ type: t, x, y, z, t0 });
    if (PPD.app.fx.length > 8) PPD.app.fx.shift();
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

  // 6 秒发球倒计时：只在发球方持球时显示；剩余 2 秒进入红色警示。
  function updateServeTimer(phId, ballInHand, phaseT) {
    const el = PPD.ui.serveTimer;
    if (!el) return;
    const limit = PPD.TT.RULES.SERVE_TIME_LIMIT || 6;
    if (phId !== 0 || !ballInHand) {
      if (el.style.display !== 'none') {
        el.style.display = 'none';
        el.classList.remove('warning');
      }
      return;
    }
    const remain = Math.max(0, Math.ceil(limit - phaseT));
    const warn = remain <= 2;
    const text = warn ? `发球 ${remain}s · 即将超时` : `发球 ${remain}s`;
    if (el.style.display === 'none') el.style.display = '';
    if (el.textContent !== text) el.textContent = text;
    if (el.classList.contains('warning') !== warn) el.classList.toggle('warning', warn);
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
  let lastBallH = ''; // 球高文本缓存（每帧 toFixed 结果相同则跳过 DOM 写入）
  function updateHitRangeLive() {
    const mode = PPD.app.mode;
    const elH = PPD.ui.ballHeight, elS = PPD.ui.inBoxStatus;
    // 左上角判定面板跟随主页开关：关闭时隐藏全部提示内容（v2.4 精简：只保留 球高/进箱）
    const panel = PPD.ui.hitRangeInfo;
    if (panel && panel.style.display !== (PPD.app.showHitRanges ? '' : 'none')) {
      panel.style.display = PPD.app.showHitRanges ? '' : 'none';
    }
    if (!elH || !elS || (mode !== 'local' && mode !== 'ai' && mode !== 'online' && mode !== 'aivai')) return;
    // 球位置：本地/人机/观战用引擎，联机用快照（飞行 b / 持球 bh）
    let bv = null;
    if (mode === 'online' && PPD.app.snapB) {
      const s = PPD.app.snapB;
      if (s.b) bv = { x: s.b[0], y: s.b[1], z: s.b[2] };
      else if (s.bh) bv = { x: s.bh[0], y: s.bh[1], z: s.bh[2] };
    } else if (PPD.app.engine && PPD.app.engine.ball) {
      bv = PPD.app.engine.ball.pos;
    }
    const htxt = bv ? bv.y.toFixed(2) + 'm' : '—';
    if (lastBallH !== htxt) { lastBallH = htxt; elH.textContent = htxt; }
    // 判定对象：人机=玩家(昵称)，联机=自己，本地=P1+P2，模拟推演=甲/乙
    const sides = (mode === 'local' || mode === 'aivai') ? [0, 1] : (mode === 'ai' ? [0] : [PPD.app.side]);
    const label = (i) => {
      if (mode === 'aivai') return PPD.app.names[i] || (i === 0 ? '甲 AI' : '乙 AI');
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
  }

  // ---------- HUD ----------
  // 上次写入的 DOM 值缓存：分数/名字/发球点只在变化时才写（省每帧 DOM 写入/重排）
  let lastHud = { p1: '', p2: '', s1: -1, s2: -1, dotLeft: null, dotOpacity: 0 };
  let lastNetInfo = ''; // 联机/人机/观战状态栏文本缓存（每帧重算但值不变则跳过 DOM 写入）
  function updateHud() {
    let score = [0, 0], server = 0, phId = 0, phaseT = 0, ballInHand = false, names = PPD.app.names;
    if (PPD.app.mode === 'local' && PPD.app.engine) {
      score = PPD.app.engine.score;
      server = PPD.app.engine.server;
      phId = PPD.TT.PHASE_ID[PPD.app.engine.phase];
      phaseT = PPD.app.engine.phaseT;
      ballInHand = PPD.app.engine.ball.inHand;
    } else if (PPD.app.mode === 'ai' && PPD.app.engine) {
      score = PPD.app.engine.score;
      server = PPD.app.engine.server;
      phId = PPD.TT.PHASE_ID[PPD.app.engine.phase];
      phaseT = PPD.app.engine.phaseT;
      ballInHand = PPD.app.engine.ball.inHand;
      names = PPD.app.names;
    } else if (PPD.app.mode === 'aivai' && PPD.app.engine) {
      score = PPD.app.engine.score;
      server = PPD.app.engine.server;
      phId = PPD.TT.PHASE_ID[PPD.app.engine.phase];
      phaseT = PPD.app.engine.phaseT;
      ballInHand = PPD.app.engine.ball.inHand;
      names = PPD.app.names;
    } else if (PPD.app.mode === 'online' && PPD.app.snapB) {
      score = PPD.app.snapB.sc;
      server = PPD.app.snapB.sv;
      phId = PPD.app.snapB.ph;
      phaseT = PPD.app.snapB.pt || 0;
      ballInHand = !!(PPD.app.snapB.bh && !PPD.app.snapB.b);
      names = PPD.app.names;
    }
    // 背景音乐紧张强度随比分实时变化（胶着/赛点节奏加快）
    if (PPD.app.mode !== null) PPD.updateMusicIntensity(score);
    // 联机时始终把自己显示在左侧 P1
    const disp = (PPD.app.mode === 'online' && PPD.app.side === 1)
      ? [names[1], names[0]]
      : names;
    // HUD 值变化才写 DOM（省每帧写入/重排）
    const p1 = `${disp[0] || '玩家1'}`, p2 = `${disp[1] || '玩家2'}`;
    if (lastHud.p1 !== p1) { lastHud.p1 = p1; PPD.ui.hudP1.textContent = p1; }
    if (lastHud.p2 !== p2) { lastHud.p2 = p2; PPD.ui.hudP2.textContent = p2; }
    // 联机时比分也按自己视角调换：左边永远是自己的分数
    const sc1 = PPD.app.mode === 'online' && PPD.app.side === 1 ? score[1] : score[0];
    const sc2 = PPD.app.mode === 'online' && PPD.app.side === 1 ? score[0] : score[1];
    if (lastHud.s1 !== sc1) { lastHud.s1 = sc1; PPD.$id('score1').textContent = sc1; }
    if (lastHud.s2 !== sc2) { lastHud.s2 = sc2; PPD.$id('score2').textContent = sc2; }
    const dot = PPD.ui.serveDot;
    const dotSide = PPD.app.mode === 'online' && PPD.app.side === 1 ? 1 - server : server;
    const dotLeft = dotSide === 0 ? 'calc(50% - 70px)' : 'calc(50% + 55px)';
    if (lastHud.dotLeft !== dotLeft) { lastHud.dotLeft = dotLeft; dot.style.left = dotLeft; }
    if (lastHud.dotOpacity !== 1) { lastHud.dotOpacity = 1; dot.style.opacity = 1; } // 恒 1，只写一次

    // 阶段横幅（仅在变化时）
    if (phId !== PPD.app.lastPhase) {
      if (PPD.app.lastPhase === 3) PPD.hideGameOver(); // 比赛结束 8 秒自动重开时关闭结算屏
      PPD.app.lastPhase = phId;
      const text = phId === 0 ? '发球' : phId === 1 ? '对打' : phId === 2 ? '得分' : '比赛结束';
      // 发球瞄准提示按设备区分：桌面只提鼠标，触屏才提"鼠标/手指"
      const aimHint = PPD.isTouch ? '移动鼠标/手指瞄准落点' : '移动鼠标瞄准落点';
      // v2.7.2:发球阶段提示只在首次显示（玩家看过一次即可，后续不再提醒，避免每回合重复干扰）。
      // 其他阶段（对打/得分/比赛结束）正常显示，不影响比分/胜负感知。
      let serveHintShown = false;
      try { serveHintShown = typeof localStorage !== 'undefined' && localStorage.getItem('ppd_serve_hint_shown') === '1'; } catch (e) { /* ignore */ }
      if (phId === 0 && PPD.app.mode === 'online') {
        if (!serveHintShown) {
          showPhase(server === PPD.app.side ? `你的发球 · ${aimHint}` : '对方发球');
          try { if (typeof localStorage !== 'undefined') localStorage.setItem('ppd_serve_hint_shown', '1'); } catch (e) { /* ignore */ }
        }
        // 已看过：发球阶段不再弹 phaseBanner 提醒（serveDot 已指示发球方）
      } else if (phId === 0 && PPD.app.mode === 'ai') {
        if (!serveHintShown) {
          const pn = (PPD.app.names && PPD.app.names[0]) || '你';
          showPhase(server === 0 ? `${pn} 发球 · ${aimHint}` : '电脑发球');
          try { if (typeof localStorage !== 'undefined') localStorage.setItem('ppd_serve_hint_shown', '1'); } catch (e) { /* ignore */ }
        }
      } else if (phId === 0 && PPD.app.mode === 'local') {
        if (!serveHintShown) {
          showPhase(`${server === 0 ? 'P1' : 'P2'} 发球 · ${aimHint}`);
          try { if (typeof localStorage !== 'undefined') localStorage.setItem('ppd_serve_hint_shown', '1'); } catch (e) { /* ignore */ }
        }
      } else if (phId === 0 && PPD.app.mode === 'aivai') {
        // AI 观战：无人类瞄准，仍提示发球方
        const na = (PPD.app.names && PPD.app.names[0]) || '甲';
        const nb = (PPD.app.names && PPD.app.names[1]) || '乙';
        showPhase(`${server === 0 ? na : nb} 发球`);
      } else if (phId !== 2) {
        showPhase(text);
      }
    }

    updateServeTimer(phId, ballInHand, phaseT);

    let netTxt = '本地双人';
    if (PPD.app.mode === 'online') {
      netTxt = PPD.app.net && PPD.app.net.connected ? `房间 ${PPD.app.roomCode}` : '连接中断';
    } else if (PPD.app.mode === 'ai') {
      const aiSpec = PPD.app.aiGameType === 'endless'
        ? PPD.AIC.endlessConfig(PPD.app.endlessLevel)
        : PPD.app.aiLevel;
      const L = PPD.AIC.resolveLevel(aiSpec);
      netTxt = `人机对战 · ${L.name}`;
    } else if (PPD.app.mode === 'aivai') {
      const LA = PPD.AIC.resolveLevel(PPD.app.aiLevelA);
      const LB = PPD.AIC.resolveLevel(PPD.app.aiLevelB);
      const tuned = (t) => Object.values(t).some((v) => v !== 1);
      netTxt = `模拟推演 · 甲${LA.name}${tuned(PPD.app.aiTuneA) ? '⚙' : ''} vs 乙${LB.name}${tuned(PPD.app.aiTuneB) ? '⚙' : ''}`;
    }
    if (lastNetInfo !== netTxt) { lastNetInfo = netTxt; PPD.ui.netInfo.textContent = netTxt; } // 值变化才写 DOM

    // 左上角：球高 + 进箱状态实时刷新（每帧）
    updateHitRangeLive();
  }


  PPD.updateHud = updateHud;
  PPD.handleEngineEvents = handleEngineEvents;
  PPD.showPoint = showPoint;
  PPD.showPhase = showPhase;
  PPD.addFx = addFx;
})();
