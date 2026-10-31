# dsh-assistant 更新日志

单一更新源：GitHub Releases <https://github.com/xiaoshumiao00-lang/dsh-assistant>。
控制室里的「更新公告」正文由 `npm run build` 从本文件里当前版本那一节抽出来（见 `build.mjs`），
不再手写常量——改了代码就必须改这一节，公告与实现不会各说各话。

## [Unreleased] - 本机已跑绿，已 commit / 已 push（未 tag / 未 publish）

🛠️ 0.2.11 之后落地的整改（本机验证，已进仓库，尚未发到 GitHub Release 版本号）

【卸载通道】新增 `scripts/uninstall-assistant.mjs`：默认只摘 profile 的 `dsh-assistant` junction 并把 profile 的 `package.json` 从 `*.bak-assistant-*` 备份恢复（没有备份就剥掉依赖项与打包清单条目，同时留一份 `package.json.before-uninstall-<时间戳>`，并提示旧插件要手动补回）；`--purge` 额外把助手数据挪进 `~/.dsh/uninstall-backup-<时间戳>/`（不是删）——`<profile>/dsh-assistant-ball/`、`~/.dsh/assistant/`、本机 `config.json`、两份状态 json、聚焦日志。浏览器侧（IndexedDB `dsh-worktable` 与 `dsh.assistant.*` / `dsh.worktable.*` 的 localStorage 键）脚本碰不到，只列出键名前缀 + 给一段可粘贴的 DevTools 片段；`dsh.sessions.current` 是宿主的，脚本明确不清。`--dry-run` 什么都不动。回归测试 `scripts/test-uninstall-plan.mjs`（含「真实目录不是 junction 时不许删内容」这一条）。README 补「卸载」章节。

【质量门】新增 `npm run lint`（`scripts/lint-standards.mjs`）与 `npm run typecheck`（`tsconfig.json` + `scripts/typecheck.mjs`）两个脚本键（之前 README 宣传了脚本却没加进 package.json——这条现在由 `test-quality-gate.mjs` 盯着）。lint 不引 eslint：查个人化标识与退役仓库名不许复现、两处版本号一致、运行时自名一致、宿主日志不再自称 `[dsh-worktable]`、`.mjs` 脚本里不许出现 TS 注解——它第一次跑就抓出 3 处真问题（`src/client/flow.tsx`、`src/client/index.tsx` 的旧路径示例，以及宿主日志前缀）。typecheck 诚实版：本机实测【过不了】（缺 `@types/node` 与宿主 `.d.ts`），跑不起来时退出码 2 并说明「不是通过了」，绝不打印通过。新增 `.github/workflows/ci.yml`（ubuntu + windows 矩阵，Node 22：install → build → check → test → lint；typecheck 挂 `continue-on-error`）——这份文件本机留着但**没能推上去**：仓库用的 PAT 没有 `workflow` scope，GitHub 直接拒绝「创建/更新 workflow 文件」，要给 token 加上 `workflow` scope 或从网页上传，Actions 才第一次跑起来。

【一键导出诊断包】设置 →「个人助手」页底新增「🧰 导出诊断包（脱敏）」：收插件版本、聚焦日志尾部、桌面球 helper 日志尾部、手机访问诊断流水摘要、状态文件概要、助手目录用量与目录 allowlist 根列表；写盘前统一脱敏（家目录 / DSH 数据根 / profile / 助手目录 / Desktop / 临时目录 / 配置里的私人目录换成 `<HOME>` `<DSH>` `<PROFILE>` `<ROOT>` 标记，残留盘符路径换 `<PATH>`，`pin:` / `token=` / `Bearer …` / 长十六进制串与 JSON 字符串内的 6–8 位数字换 `«已脱敏»`），`dsh-pocket/settings.json` 整份不进包，包里还写清「哪些故意不给」。落 `~/.dsh/assistant/outputs/diagnostics-<时间戳>.json`，UI 给可复制路径 + 体积 + 脱敏替换处数。新宿主路由 `GET /api/assistant/diagnostics`、`POST /api/assistant/diagnostics/export`（**要重启 DSH Desktop**）。回归测试 `scripts/test-assistant-diagnostics.mjs`（6 项）。

【助手档案导出 / 导入】同页新增「📦 导出助手档案」与「📥 导入助手档案」：导出是单一 JSON 清单（AGENTS.md + `journal/` + `notes/` + `archive/` + `config.json` + `USER.md`/`MEMORY.md`/`memories.json` + 状态 json），每项带相对路径、字节数与 SHA-256，整带 `checksum` 与总体积，落 `~/.dsh/assistant/exports/archive-<时间戳>.json`（不在 `outputs/` 的 14 天自动清范围）。导入先验校验和（不对整包拒绝）、把 AGENTS.md/journal/notes 现状备份进 `archive/import-backup-<时间戳>/`、按文件夹判重跳过、内容不同一律【不覆盖】而是另存 `<原名>.imported-<时间戳>.<后缀>`、`state` 区拒收（删除墓碑不写回，报告数量）、路径不许跳出区目录、本机没有的预设显式列进 `missingPresets` 不静默；UI 直接打印「导入了什么 / 跳过了什么 / 冲突另存 / 备份在哪」。新宿主路由 `GET /api/assistant/archive`、`POST /api/assistant/archive/export`、`POST /api/assistant/archive/import`（**要重启 DSH Desktop**）。回归测试 `scripts/test-assistant-archive.mjs`（10 项）。

【README 对齐】「一概不碰 journal/notes」改成实际的按天/按字节归档语义；「三个入口」改成「入口不止三个」（列全长按 600ms、Ctrl+Alt+A、顶栏按钮、卡片会话列表、`?assistant=chat` / `#assistant`、`POST /api/assistant/open-assistant`）；周期数字按代码改回实测量（活动扫描 1.2 秒、同步去抖 800 毫秒、远程轮询 3 秒）。

【点卡片进入哪条会话 = 进行中的优先】原来纯按「最近更新」倒序取第一条：宿主的 `updatedAt` 只在新提示词时前进，于是「最新那条刚跑完的会话」会盖掉「还在跑的那条」——用户点卡片被带进已结束的会话，不是正在进行的会话。现在走 `src/client/sessionRank.ts` 的活跃度档：① 等你回答（黄）② 正在跑（蓝，多条在跑取最近有活动的那条；当前会话本就在这档则保持不变）③ 没有进行中的才按模板「最新步骤」/「最近更新」兜底。「会话列表」浮层用同一套排序（置顶 → 黄 → 蓝 → 异常 → 空闲按最近更新倒序），浮层第一行就是点卡片会进的那条；黄点在列表里显式标「等你回答」。卡片状态判定（`awaitingOf` / `isRunning`）与会话列表、进入判定改走同一对口径（`sessionAwaitingFlag` / `sessionRunningFlag` / `sessionFaceSnapshotOf`），模板步骤判定也合并成一个 `templateFlowStepOf`（会话列表 / 新建会话目录 / 进入项目三处同源，不再各写一份）。附带：点开项目时把「实际进入的那条会话」也一起 ack（原来只 ack 绑定会话，非绑定会话在等决策时光晕熄不掉）。回归测试 `scripts/test-session-rank.mjs`（10 项，已进 `npm test`）。

【手机端流畅度：左菜单开合慢 / 抽屉右上角那颗没用的按钮 / 语音输入说几个词就自己停】三件一起修，全部在插件的手机层，不碰宿主。

① 「点左上角三条横线后弹左菜单要慢一下」的根因查清了：原来那次「图标 rail → 完整列表」的官方侧栏升级（AppFrame 换列 + SidebarRoot 重挂载 + 会话列表重建）挂在**第一次点汉堡**上，几百毫秒的主线程活儿做完之后，0.28s 的滑行才开始。现在首屏装配完 700 毫秒先补好升级（`armPreUpgrade`），点开抽屉只在那条还没补时同步补做；按下汉堡（pointerdown）就把那一列提到独立合成层，`will-change: transform` 520 毫秒内必撤——久留会让这一列成为宿主设置面板 portal 的包含块，重演「面板偏 102px」那个老 bug。开合耗时改为实测打点（`measureOpen` → 诊断流水里的 `drawer-open` 阶段，带 `ms` 与 `up`），下次打开「一键导出诊断包」就能看到还剩多少毫秒，不用凭猜。

② 抽屉右上角那颗「打开侧边栏」（官方 logoRow 里的 sidebar toggle，用户判定它在手机上没用）在 `mobile.css.ts` 的窄屏规则里收掉：判据三条（`button[class*="_toggle"]` 与中英两种 `aria-label` 兜底），全部限定在抽屉那一列的 `[data-window-drag]` 内部。电脑布局的侧栏、会话头右侧的「打开右侧边栏」都不受影响；官方键盘快捷键（收起/展开侧栏）照旧可用。

③ 新建 `src/client/compositionGate.ts`：一条「别人正在输入时插件不许改 DOM」的纪律。捕获阶段听 `compositionstart` / `compositionend`，加 140 毫秒收尾窗（组合结束后宿主与 Lexical 还在补发节点），加开 / 关抽屉的 360 毫秒让路窗，超过 120 秒的组合自动放行（有的输入法引擎根本不发 `compositionend`，绝不能因此把补丁永久锁死）。手机侧所有 body 级扫描与 DOM 补丁改走 `createGatedThrottle`：**让路窗口内不跑，但批次绝不丢**（按 `skipMs` 重试，最多 12 次后强跑一次），`throttleByFrame` 也统一挂进这条闸门。三个具体中断源堵掉：`fileGuard` 的「复制」按钮注入与「隐藏添加工作区」扫描一律不碰输入框那一棵树（`insideComposer`：`[data-composer-card]`，文本节点走 `parentElement`——Lexical 每个字都在换文本节点），`modelSettingsNotice` 的报错文案替换同理不碰 `[contenteditable]` 本体，统计行折叠 `moveTps` 不搬编辑器里的节点；控制室 1.2 秒活动扫描、3 秒跨端轮询、2 秒修 `dsh.sessions.current`、2 秒贴底测量、任务管理窗 2 秒重渲染、托管状态 2.5 秒轮询都在窗口内跳过（不是取消，下一轮照旧补）。微信键盘 / 讯飞那种「一边说一边出字」被打断的老因就在这儿：插件在宿主 Lexical 编辑器里改 DOM → 宿主重排输入框 → 当场结束组合。

④ 顺带把三个「第三方套件兼容」观察者（explorer 可用性 / preview 开合标记 / 表格抬起动画）从「永久挂着」改成有界确认（`featurePresence.mjs`）：本机跑的是纯 DeepSeek Harness，根本没有 `[data-aionui-*]` 那两列，原来这三个观察者一直在 `document.body` 全量 childList / attributes 上排 querySelector + getComputedStyle（长会话详情实测 ~2 万节点，一次扫描 ~19 毫秒）。现在 15–20 秒窗口内确认不到就不再观察，切布局时 `recheck` 补一次；真有那两列的套件宿主照旧补挂，且只挂一次。

④·补 同一轮里再收三处：`modelSettingsNotice` 的补丁队列给上硬上限（800 个节点封顶，只留最新的那批）并且**输入框那一棵树里的节点根本不进队列**（Lexical 每个字都在换文本节点，过去每一批都排进队列）；分栏工作区的「兜底重锚定」body 观察器也挂上闸门（300 毫秒合并 + 组合 / 开合窗口让路）。反过来，`observeExternalSplit`（外来 `.ta_split` 让位观察器）**保持原样不闸门**：那里是「外来分栏出现就立即让位」的契约，不是扫描优化——契约优先，别为省几毫秒偷偷改掉互斥语义（`scripts/test-split-observer.mjs` 盯着这条）。

另外给语音这条路装了探针：`createVoiceProbe` 只在 `compositionstart` / `compositionend` 这两个边界读一次输入框文本长度（全程只读、绝不写 DOM —— 写输入框那一棵树才是要打断语音的那件事），`createVoiceTally` 把它汇总成一条 `voice-compose` 诊断记录（说了几段 / 各类归类 / 一共进去多少字 / 最长一段多少毫秒）。可疑中止（`interrupted` = 上一段还没等到 `compositionend` 就来了新的一段；`silent-long` = 说了 2.5 秒以上一个字都没进）立刻发一条，正常打字每 20 段合并发一条，不把 beacon 打成「每敲一下发一发」。你在手机上说完一段长语音后打开「一键导出诊断包」，就能看见断在哪一类、总共断了几次。

⑤ 回归测试 `scripts/test-composition-gate.mjs`（27 项：闸门本体判据、140 毫秒收尾窗、120 秒兜底放行、让路不丢批次、`maxSkips` 上限、`insideComposer` 两种判据、存在性闸门到期停轮 / 只挂一次 / 晚挂载补挂、抽屉控制器「开抽屉即让路」且绝不降回 collapsed、以及抽屉收那颗按钮的规则不许落到输入框或会话列表上、语音探针的归类与汇总（可疑中止立刻发一条、正常打字每 20 段合并发一条）），已进 `npm test` 链。`npm run build` / `check` / `lint` / `test` 本机全绿。

## [0.2.11] - 2026-10-30

🛠️ 本版本更新（商业化 P0 收口）

【个人配置外置】仓库里不再有本机路径、本机技能目录、本机人名与语音纠错表：
新建项目的默认位置、技能文件路径、AGENTS.md 人设、语音术语纠错都改成本机配置文件
`~/.dsh/assistant/config.json`（由宿主 `GET /api/assistant/config` 下发给页面）。
配置文件里没有这些值时，全部退回通用默认（平台 Desktop 目录 / `~/.dsh/skills` / 通用术语表），行为不变。

【记忆面板】个人助手设置里新增「🧠 它记下了什么」：列出 USER.md 与 MEMORY.md 的每一条（含 `[importance]`、分支、改于日期），
可逐条删除、可整侧清空、可复制与导出 .md，同时显示助手目录各区（journal / notes / outputs / archive）的文件数、体积与上限状态。
写回走宿主新路由 `/api/assistant/memory-entry-delete` 与 `/api/assistant/memory-clear`：删之前一定先备份，
并且必须重启 DSH Desktop 才生效（面板会讲清楚，不会偷偷刷新）。

【journal / notes 容量策略】助手目录多出 `archive/`：journal 超过 90 天、或文件数超过 180 份、notes 总字节超过 8MB 时，
旧文件**整份搬进 archive/**（插件永不删除，一字不少）；只有 `outputs/`（杂物间）才会被自动删。
archive 自己超过 32MB 时只在面板与日志里提示，插件不再自动搬。

【升级链路闭环】仓库只留一个更新源（`xiaoshumiao00-lang/dsh-assistant`）：控制室、工作台分栏页、更新检查全部共用同一份
升级指令与同一套 localStorage 缓存键；此前分栏页里那条指向已退役仓库的升级命令已删除。运行时插件自名也统一成 `dsh-assistant`。

【AGENTS.md 追加规矩】助手目录的固定人设改由插件托管（`persona v1` 标记段，内容来自本机配置文件），
旧文件缺「家目录规矩」「归档规矩」时只追加那一节，用户手改的正文绝不覆盖。

【质量门】新增回归测试：家目录 / 归档 / 记忆写回 / 默认项目位置解析；`npm test` 逐条跑，构建继续强制两处版本号一致。

## [0.2.10] - 2026-10-28

- 当前会话识别适配 DSH 0.2（`uiWorkspace.selection` → `sessions.current` → 旧快照 → `localStorage dsh.sessions.current` 兜底）。
- 「离开项目」改按项目文件夹判定：模板流程内部各步骤之间切换不再算离开。
- 打开私人助手前先收起项目分栏（助手是单一会话全屏布局）。

## [0.2.9] - 2026-10-27

- 助手家目录分区：`AGENTS.md` + `journal/` + `notes/` + `outputs/`；`outputs/` 超过 14 天自动清理。
- 宿主路由 `/api/assistant/home`、`/api/assistant/tidy`。

## [0.2.8] - 2026-10-26

- 助手卡建卡被首同步吃掉的问题修复；新建会话 / Computer Use 模式 / 沿用上次模型的选择行为修正。

## [0.2.7] - 2026-10-25

- 私人助手在控制室就是一张普通项目卡（图标、排序、按文件夹判重、删除墓碑不重建）。

## [0.2.6] - 2026-10-24

- 私人助手入口：长按悬浮球 600ms / Ctrl+Alt+A / 控制室顶栏「🤖 私人助手」；单击悬浮球仍进控制室不变；`?assistant=chat` 直达。

## [0.2.5] - 2026-10-23

- 手机访问独立生命周期：手机访问改成独立入口（`dsh-assistant/pocket`），有自己的 Cordis 生命周期；工作台 / 控制室 / 客户端代码的热重载不再重启代理与 SSH 隧道。登录密钥改为安装级持久化，DSH 重启 / 更新后手机不必重新输入访问密码（改密码仍会使旧登录失效）。
- 手机首屏更快：手机端只精简桌面原生能力、埋点与开发期 HMR，设置 / Skill / 自动化任务 / 记忆系统等用户功能全部保留；模块在代理里本地合并成少量 JS 再一次性 gzip / Brotli 下发。需要完整插件树时加 `?dsh-full-plugins=1`。
- 路由注册不再泄漏：全部 web 路由集中登记、统一注销，热重载不再因「路由重复」让插件启动到一半失败；旧版本泄漏在宿主里的路由会被自动替换清理。
- 选文件夹只用一套浏览器：手机端「新建项目 / 更改文件夹」与「会话输入框 → 电脑文件」共用同一套路径浏览器；起始目录不存在时自动退到最近可读上级并提示。
- 复制更可靠：http 打开时没有剪贴板 API 的兜底（含 iOS 多行）；路径浏览器地址栏可一键复制。
- 手机顶部标题固定显示产品名，不再被长会话名占满。

## [0.2.4] 及更早

- 0.2.4：只看进行中筛选、临时运行卡片、坐标开关。
- 0.2.3：加号菜单支持再次点击关闭并置顶；更换手机悬浮球默认头像；电脑文件置顶到附件菜单首位；手机端会话支持上传电脑文件。
- 0.2.2：修复提问时控制室仍显示进行中；控制室响应与新建会话流畅性；跨端控制室与会话实时状态。
- 0.2.1：项目管理菜单、按设备列数、独立 Electron 悬浮球、模板步骤进度。
- 0.2.0：合并托管、跨端同步、桌面原生球、设置整合、控制室交互修复；首次同步取项目并集再回写宿主。
- 0.1.x：悬浮球控制室 + 手机访问一体化插件首发；去掉侧栏工作台区块（控制室只从悬浮球进入）。
