/* ============================================================
 * app/teams.js — 队伍与旗帜：预设队伍、主菜单选择器、对局开场渲染
 * 通过共享对象 PPD（app/state.js）访问公共状态与界面元素。
 * 队伍 = 旗帜(旗帜色) + 队名(系统默认队名可自定义，限 6 字)；
 * 观众颜色、球员球服颜色随对应旗帜队色同步（仅本地/人机/模拟推演，联机保持默认红蓝）。
 * ============================================================ */
(function () {
  'use strict';

  // 预设队伍：id / 默认队名（以旗帜颜色命名，颜色仅代表旗帜色而非队伍身份）/ 旗帜主色(队色) / 饰条辅色
  const TEAMS = [
    { id: 'hong',  name: '红色', color: '#d0321e', accent: '#ffffff' },
    { id: 'lan',   name: '蓝色', color: '#2563eb', accent: '#ffffff' },
    { id: 'lv',    name: '绿色', color: '#16a34a', accent: '#ffffff' },
    { id: 'cheng', name: '橙色', color: '#ea580c', accent: '#ffffff' },
    { id: 'zi',    name: '紫色', color: '#9333ea', accent: '#ffffff' },
    { id: 'qing',  name: '青色', color: '#0891b2', accent: '#ffffff' },
    { id: 'jin',   name: '金色', color: '#d9a441', accent: '#1e293b' },
    { id: 'fen',   name: '粉色', color: '#ec4899', accent: '#ffffff' },
  ];
  const teamById = (id) => TEAMS.find((t) => t.id === id) || TEAMS[0];

  // 槽位：me=玩家自己（昵称旁）/ opp=人机电脑对手 / a、b=模拟推演甲乙双方。
  // 每槽持久化队伍 id + 自定义队名（空=用该队默认队名）
  const SLOTS = [
    { key: 'me',  def: 'hong' },
    { key: 'opp', def: 'lan' },
    { key: 'a',   def: 'hong' },
    { key: 'b',   def: 'lan' },
  ];
  const store = {};
  for (const s of SLOTS) {
    store[s.key] = { team: s.def, name: '' };
    try {
      const v = localStorage.getItem('ppd_team_' + s.key);
      const n = localStorage.getItem('ppd_team_' + s.key + '_name');
      if (v && TEAMS.some((t) => t.id === v)) store[s.key].team = v;
      if (n) store[s.key].name = String(n).slice(0, 6); // 队名限 6 字（v2.2）
    } catch (e) { /* ignore */ }
  }
  function saveSlot(key) {
    try {
      localStorage.setItem('ppd_team_' + key, store[key].team);
      localStorage.setItem('ppd_team_' + key + '_name', store[key].name);
    } catch (e) { /* ignore */ }
  }
  // 当前槽位的完整队伍信息（自定义队名优先，空则用该队默认队名）
  function slotTeam(key) {
    const t = teamById(store[key].team);
    return { id: t.id, name: store[key].name || t.name, color: t.color, accent: t.accent };
  }

  // 按模式解析本局双方队伍：
  // - 本地双人：P1=玩家队，P2 恒默认蓝色
  // - 人机：玩家队 + 电脑队（电脑栏选择）
  // - 模拟推演：甲队 + 乙队（甲乙栏选择）
  // - 其他（联机/未开始）：默认红蓝
  function resolveMatchTeams(mode) {
    if (mode === 'ai') return [slotTeam('me'), slotTeam('opp')];
    if (mode === 'aivai') return [slotTeam('a'), slotTeam('b')];
    if (mode === 'local') {
      const l = teamById('lan');
      return [slotTeam('me'), { id: l.id, name: l.name, color: l.color, accent: l.accent }];
    }
    const h = teamById('hong'), l = teamById('lan');
    return [
      { id: h.id, name: h.name, color: h.color, accent: h.accent },
      { id: l.id, name: l.name, color: l.color, accent: l.accent },
    ];
  }

  // 设置旗帜元素颜色（CSS 变量 --flag-color / --flag-accent，样式见 style.css .team-flag）
  function setFlag(el, team) {
    if (!el || !team) return;
    try {
      el.style.setProperty('--flag-color', team.color);
      el.style.setProperty('--flag-accent', team.accent || '#ffffff');
    } catch (e) { /* 测试桩 style 无 setProperty 等环境：忽略 */ }
  }

  // ---------- 主菜单队伍选择器（旗帜预览 + 队伍下拉 + 队名输入，改动即持久化） ----------
  const PICKERS = {
    me:  { sel: 'teamMe',  name: 'teamMeName',  flag: 'teamFlagMe' },
    opp: { sel: 'teamOpp', name: 'teamOppName', flag: 'teamFlagOpp' },
    a:   { sel: 'teamA',   name: 'teamAName',   flag: 'teamFlagA' },
    b:   { sel: 'teamB',   name: 'teamBName',   flag: 'teamFlagB' },
  };
  function populateSelect(sel) {
    if (!sel || typeof document.createElement !== 'function') return;
    sel.innerHTML = '';
    for (const t of TEAMS) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      sel.appendChild(opt);
    }
  }
  function initPickers() {
    for (const key of Object.keys(PICKERS)) {
      const ids = PICKERS[key];
      const sel = PPD.$id(ids.sel);
      const name = PPD.$id(ids.name);
      const flag = PPD.$id(ids.flag);
      if (!sel || !name || !flag) continue;
      populateSelect(sel);
      sel.value = store[key].team;
      // 队名输入框回填：自定义队名优先，否则该队默认队名
      name.value = store[key].name || teamById(store[key].team).name;
      setFlag(flag, teamById(store[key].team));
      sel.addEventListener('change', () => {
        const prev = teamById(store[key].team);
        store[key].team = sel.value;
        const cur = teamById(sel.value);
        // 切队伍：队名为空或等于上一队默认名 → 自动换成新队默认名；自定义队名保留
        const curName = (name.value || '').trim();
        if (!curName || curName === prev.name) name.value = cur.name;
        store[key].name = (name.value || '').trim().slice(0, 6); // 队名限 6 字（v2.2）
        setFlag(flag, cur);
        saveSlot(key);
      });
      name.addEventListener('input', () => {
        store[key].name = (name.value || '').trim().slice(0, 6); // 队名限 6 字（v2.2）
        saveSlot(key);
      });
      name.addEventListener('change', () => {
        store[key].name = (name.value || '').trim().slice(0, 6);
        saveSlot(key);
      });
    }
  }

  // ---------- 队伍颜色色块选择（竖屏队伍配置抽屉用）：
  // 8 个色块取自上方同一份 TEAMS 配色池，点击写回原<select> 并派发 change，
  // 既有持久化/摘要刷新逻辑完全复用，不新增系统。非竖屏由 CSS 隐藏。 ----------
  const SWATCH_IDS = { me: 'swatchMe', opp: 'swatchOpp', a: 'swatchA', b: 'swatchB' };
  function initSwatches() {
    if (!document || typeof document.getElementById !== 'function') return;
    if (typeof document.createElement !== 'function') return;
    for (const key of Object.keys(SWATCH_IDS)) {
      const host = document.getElementById(SWATCH_IDS[key]);
      const sel = PPD.$id(PICKERS[key].sel);
      if (!host || !sel || !host.appendChild) continue;
      const sync = () => {
        const kids = host.children || [];
        for (let i = 0; i < kids.length; i++) {
          const on = !!kids[i].classList && kids[i].classList.toggle;
          if (on) kids[i].classList.toggle('active', TEAMS[i] && TEAMS[i].id === sel.value);
        }
      };
      for (const t of TEAMS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.title = t.name;
        try { b.style.setProperty('--sw', t.color); } catch (e) { /* 测试桩无 setProperty */ }
        b.addEventListener('click', () => {
          if (sel.value === t.id) return;
          sel.value = t.id;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
        host.appendChild(b);
      }
      sel.addEventListener('change', sync);
      sync();
    }
  }

  // ---------- 对局开场渲染：双方旗帜 + 队名 + VS（渲染结束进入对局） ----------
  const INTRO_MS = 2200; // 开场渲染时长（渲染结束后进入对局）
  let introToken = 0;
  let introTimer = null;
    let introFinish = null;   // 当前开场的「立即收尾」回调（立即开始 / 跳过共用）
// 开场倒计时 + 进度条：每 100ms 自续一个 setTimeout（不用 setInterval，
  // 保证任何路径都能被clearTimeout 收干净，不会在测试里留下悬挂定时器）。
  // 仅当 DOM 存在（真实页面）时启用；测试沙箱无这些节点即整体跳过。
  function startCountdown(token) {
    const u = PPD.ui;
    const hasCount = !!(u.tiCount && u.tiBar);
    const t0 = Date.now();
    const tick = () => {
      if (token !== introToken) return;
      const left = Math.max(0, INTRO_MS - (Date.now() - t0));
      if (hasCount) {
        u.tiCount.textContent = String(Math.max(0, Math.ceil(left / 1000)));
        try { u.tiBar.style.width = (left / INTRO_MS * 100).toFixed(1) + '%'; } catch (e) { /* ignore */ }
      }
      if (left <= 0) { if (introFinish) introFinish(); return; }
      introTimer = setTimeout(tick, 100);
    };
    tick();
  }

  function showTeamIntro(teams) {
    const u = PPD.ui;
    if (!u.teamIntro) return;
    const token = ++introToken;
    clearTimeout(introTimer);
    introFinish = null;
    setFlag(u.tiFlagL, teams[0]);
    setFlag(u.tiFlagR, teams[1]);
    u.tiNameL.textContent = teams[0].name;
    u.tiNameR.textContent = teams[1].name;
    // 开场渲染期间冻结物理（loop 见 introActive 不步进），画面照常渲染打底
    PPD.app.introActive = true;
    PPD.show(u.pausePanel, false);
    PPD.show(u.teamIntro, true);
    u.teamIntro.classList.remove('hide');
    void u.teamIntro.offsetWidth; // 强制重排，触发渐入
    u.teamIntro.classList.add('show');
    // 收尾回调：倒计时走完与「立即开始」共用同一条路径，行为完全一致
    introFinish = () => {
      if (token !== introToken) return;
      introFinish = null;
      clearTimeout(introTimer);
      PPD.app.introActive = false; // 渲染结束：进入对局
      u.teamIntro.classList.add('hide');
      setTimeout(() => {
        if (token !== introToken) return;
        PPD.show(u.teamIntro, false);
        u.teamIntro.classList.remove('show');
        u.teamIntro.classList.remove('hide');
      }, 350);
    };
    startCountdown(token);
  }

  // 返回主菜单/退出对局时立即关闭开场渲染
  function cancelTeamIntro() {
    introToken++;
    clearTimeout(introTimer);
    introFinish = null;
    PPD.app.introActive = false;
    const u = PPD.ui;
    if (u.teamIntro) {
      PPD.show(u.teamIntro, false);
      u.teamIntro.classList.remove('show');
      u.teamIntro.classList.remove('hide');
    }
  }

  // 开场出口按钮（竖屏排版方案 §1.5）：立即开始 = 直接收尾；返回主菜单 = 退出开场。
  if (PPD.ui.tiStart) {
    PPD.ui.tiStart.addEventListener('click', () => { if (introFinish) introFinish(); });
  }
  if (PPD.ui.tiBack) {
    PPD.ui.tiBack.addEventListener('click', () => {
      cancelTeamIntro();
      if (PPD.backToMenu) PPD.backToMenu();
    });
  }

  PPD.Teams = { TEAMS };
  PPD.resolveMatchTeams = resolveMatchTeams;
  PPD.setTeamFlag = setFlag;
  PPD.showTeamIntro = showTeamIntro;
  PPD.cancelTeamIntro = cancelTeamIntro;
  initPickers();
  initSwatches(); // 竖屏队伍配置抽屉的色块选择（桌面隐藏，不影响原有下拉）
})();
