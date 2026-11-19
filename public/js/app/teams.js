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

  // ---------- 队伍颜色色块选择（快速开始卡片 / 模拟推演配置区共用）：
  // 8 个色块取自上方同一份 TEAMS 配色池，点击写回原<select> 并派发 change，
  // 既有持久化/摘要刷新逻辑完全复用，不新增系统。 ----------
  const SWATCH_IDS = { me: 'swatchMe', opp: 'swatchOpp', a: 'swatchA', b: 'swatchB' };
  function initSwatches() {
    if (!document || typeof document.getElementById !== 'function') return;
    if (typeof document.createElement !== 'function') return;
    for (const key of Object.keys(SWATCH_IDS)) {
      const host = document.getElementById(SWATCH_IDS[key]);
      const sel = PPD.$id(PICKERS[key].sel);
      if (!host || !sel || !host.appendChild) continue;
      if (host.setAttribute) host.setAttribute('role', 'radiogroup');
      const kids = [];
      const sync = () => {
        for (let i = 0; i < kids.length; i++) {
          const on = TEAMS[i] && TEAMS[i].id === sel.value;
          const b = kids[i];
          if (b.classList && b.classList.toggle) b.classList.toggle('active', !!on);
          if (b.setAttribute) b.setAttribute('aria-checked', on ? 'true' : 'false');
        }
      };
      for (const t of TEAMS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.title = t.name;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-label', t.name);
        try { b.style.setProperty('--sw', t.color); } catch (e) { /* 测试桩无 setProperty */ }
        b.addEventListener('click', () => {
          if (sel.value === t.id) return;
          sel.value = t.id;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
        host.appendChild(b);
        kids.push(b);
      }
      // 键盘 ←/→ 在色块间移动并选中（与难度分段控件一致的单选组键盘操作）
      if (host.addEventListener) {
        host.addEventListener('keydown', (ev) => {
          if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
          const i = kids.indexOf(document.activeElement);
          if (i < 0) return;
          ev.preventDefault();
          const n = (i + (ev.key === 'ArrowRight' ? 1 : -1) + kids.length) % kids.length;
          kids[n].focus();
          kids[n].click();
        });
      }
      sel.addEventListener('change', sync);
      sync();
    }
  }

  PPD.Teams = { TEAMS };
  PPD.resolveMatchTeams = resolveMatchTeams;
  PPD.setTeamFlag = setFlag;
  initPickers();
  initSwatches(); // 快速开始卡片 / 模拟推演配置区的敌我配色色块
})();
