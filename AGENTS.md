# AGENTS.md — 乒乓对决

> **当前版本**：3.2.1 · `androidVersionCode` 29 · 最后更新：2026-10-18
> **一句话**：ITTF 标准球台 + 火柴人物理骨架的双人乒乓球（单机 / 本地分屏 / 局域网与公网联机），零依赖前端 + Cloudflare Durable Object 后端。
> **接手入口**：[`README.md`](README.md) → [`修改记录.md`](修改记录.md)（含「项目状态」固定章节：结构 / 部署 / 联机 / 测试 / 待办 / 踩坑）→ 本文。

---

## 一、开工前必读

1. [`修改记录.md`](修改记录.md) §七「踩坑备忘」—— 7 条平台级坑，全是实测出来的
2. [`审计报告.md`](审计报告.md) —— 2026-08-13 基线审计，**已归档但仍是问题清单**
3. 本文 §三 红线

> `修改记录-归档.md` 与 `合并说明.md` 是**只读存档**，不要往里面追加内容。

---

## 二、命令与门禁

| 目的 | 命令 |
|---|---|
| 本地起服务 | `npm start`（`node server.js`，默认 <http://localhost:8765>） |
| **全量门禁** | `npm run test:all`（32 项测试 + 引擎镜像校验） |
| 版本一致性 | `npm run test:ver` |
| 引擎镜像字节一致 | `npm run test:sync` |
| 公网协议冒烟 | `npm run test:ws`（默认连 `wss://ping-pong-duel.pages.dev/ws`） |
| DO 驱逐恢复 | `npm run test:evict`（35s 空闲后再加入） |
| 移动端实测 | `npm run probe:mobile` / `node tools/pp-layout-probe.cjs` |
| 全渠道同步 | `node tools/autosync.js --once` |
| 部署 | `npm run deploy:all`（先 DO Worker 再 Pages） |
| 文档死链 | `node tools/check-docs.cjs` |

### 什么算"绿"

- `npm run test:all` 全过，**除两项既有失败**：
  - `physics-boundary-test`（台面走位）
  - `browser-smoke`（虚线勾选框禁用断言）
  这两项与基线一致即视为无回归，**但必须在记录里写明"较基线的 2 项既有失败未变"**。
  出现第 3 项失败 = 回归。
- `npm run test:ver` 9 项全绿（版本副本一致）。
- `npm run test:sync` 引擎镜像字节一致。
- 布局改动必须过 320 / 360 / 390 / 430 / 768 / 1280 六档实测：无横向滚动、无出界、无文字裁切。

---

## 三、红线

1. **双端镜像。** 房间逻辑有两份实现：本地 `server.js` 与云端 `src/room-core.js`。
   改一份必须改另一份并在记录里注明「双端镜像」。历史教训：本地漏了 `side` 接管与宽限清扫，
   「局域网一次抖动就永久终结对局」。
2. **引擎镜像必须字节级一致。** `public/js/engine*` ↔ `src/engine*` ↔ `dist/ecs` ↔
   `android/assets/www` ↔ `乒乓对决_安装包/game`，共 7 对。改引擎后必须 `node tools/autosync.js --once`。
3. **版本号只改真源。** `package.json` 的 `version` + `androidVersionCode` 是唯一真源。
   `node tools/set-version.js <版本> <code>` **只改 package.json，不刷新副本**——
   `bump` 之后必须紧跟一次 `--sync`，APK 就位后还要再 `--sync` 一次同步期望字节数。
4. **APK 签名证书必须与线上在用的包一致**（当前 `50b1c573…190df`）。证书变了 = 老用户无法覆盖安装，
   必须在下载页写清"需先卸载"。签名密码只从 gitignored 的 `.env` 或环境变量读，**禁止硬编码**。
5. **缓存键必须随版本递增。** `sw.js` 的缓存名绑定 `package.json` 版本；APK 靠文件名换版本破缓存
   （`PingPongDuel-v<版本>.apk`）。历史上 `ppd-v5` 五个版本没动，离线兜底一直拿旧文件。
6. **只改排版时不许动玩法。** 布局/UI 轮的边界是「位置/尺寸/间距/层级」，`aiLevel`、队伍槽位
   （`me`/`opp`/`a`/`b`）、`localStorage` 键、服务端接口一律不动。改前先声明边界，改后逐条核对。
7. **同步工具不许静默跳过。** `autosync` 每次必须打印「预期 N / 实际 M」；目标目录不存在要报错，
   不许 `continue`。历史上 `%PKG%` 占位符从未展开，桌面安装包长期同步不到任何改动，而每次运行都"成功"。
8. **CI 校验的必须是用户实际下载的那个文件。** 文件名从 `package.json` 推导，并交叉校验
   `download.html` 与 `_headers` 引用的是同一个名字；冒烟从线上 `download.html` grep 出真实文件名再校验 PK 头。

---

## 四、文件地图

| 路径 | 说明 |
|---|---|
| `public/index.html` · `public/css/style.css` | 前端入口与样式（含竖屏断点） |
| `public/js/engine.js` | 物理引擎（重力/空气阻力/马格努斯旋转/规则/计分）——**镜像源** |
| `public/js/render.js` · `characters.js` | 3D 透视渲染 / 火柴人骨架与 IK |
| `public/js/ai.js` | 人机（落点预测/追球/推扣/四档难度） |
| `public/js/app/` | 界面模块（state/net/modes/loop/hud/input/teams/records） |
| `server.js` | 本地联机 WebSocket + 静态服务（**双端之一**） |
| `src/room-core.js` · `src/room.js` · `src/index.js` | Cloudflare DO 房间逻辑（**双端之二**） |
| `public/_worker.js` | Pages 高级模式：静态资源 + WS 转发到 DO |
| `test/` | 32 项测试，见 `package.json` 的 `test:all` |
| `tools/set-version.js` · `tools/autosync.js` · `tools/check-engine-sync.js` | 版本 / 同步 / 镜像校验 |
| `android/` | APK 构建（`build.cmd`）+ `assets/www` 资产副本 |

---

## 五、记录要求

- 变更记录写在 [`修改记录.md`](修改记录.md)：`## YYYY-MM-DD · 主题`（二级）+ 四类归档 + 五要素。
- 每条必须附「验证」段，写命令与读数；**不许只写"已验证"**。
- 尾部固定：`未做（本轮范围外）` / `已知遗留` / `已否决`。
- 归档规则：主文件只保留最新记录 + `一~七` 固定章节；更早的移入 `修改记录-归档.md`（只读）。

---

## 六、提交前自检

- [ ] 改了 `src/` 有没有同步 `server.js`（或反向）？
- [ ] 改了引擎有没有跑 `autosync` 并 `test:sync` 过？
- [ ] 升版本后有没有紧接 `--sync`？`test:ver` 全绿？
- [ ] APK 重建了吗？证书指纹还是 `50b1c573…` 吗？
- [ ] `sw.js` 缓存名跟着版本走了吗？
- [ ] 布局改动跑了六档实测吗？首屏零滚动吗？
- [ ] 这次改动有没有越界碰到玩法参数？
- [ ] 两项既有失败之外，有没有新增失败？
