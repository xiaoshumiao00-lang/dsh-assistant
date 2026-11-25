# 手机端「会话详情过一会就卡死」根因修复报告（2026-11-25）

## 结论（先行）

**根因**：宿主 DSH 0.2.2 的 AppFrame 在「官方抽屉打开」（`drawerOpen = 视口<768 && 官方侧栏展开`）时给主内容四列打 `inert`；我们的手机壳在首屏后 ~700ms 用 PRE_UPGRADE 把官方侧栏展开成完整列表、之后**从不收回**，三条关闭路径也只滑走视觉层、不动宿主状态 —— 于是「官方展开 + 我们的抽屉关着」成为常态，主内容列被宿主永久 `inert`：点不动、滑不动、composer 无法聚焦，但侧栏列本身不 inert，所以「只有点侧边栏里的其他会话才能跳转」。**修复**：抽屉模式（frame 带 `data-sidebar-drawer`）下强制铁律「官方侧栏展开 ⟺ 我们的抽屉开着」——关抽屉经延迟对账对称收回官方；PRE_UPGRADE 在抽屉模式直接跳过（那里 SidebarRoot `wide=drawer` 恒真，会话列表本来就常驻挂载，没有可预热的东西）。非抽屉模式（宽屏强制手机布局）保持「只升不降」老纪律，绝不替用户折图标 rail。

**验证**：旧代码新回归测试 3 条根因断言全红、新代码 10/10 全绿；真页面（Playwright + 本机 Chrome，390×844，pocket 127.0.0.1:3081）修复前置静 1.2s 即 frozen=true，修复后置静 120s frozen 恒 false、三条关闭路径关后主内容立即可点可滚、抽屉开合与跳转正常。

## 1. 复现与取证（修复前，真页面）

环境：本机 Chrome + Playwright，视口 390×844（isMobile/hasTouch/dpr2），pocket `http://127.0.0.1:3081`（token-lan），真路径「开抽屉 → 点会话 → 进详情 → 等」。探针与日志在 `C::\Users\<ACCOUNT>\.dsh\repro\mobile-session-frozen\`（probe2/3b/4 及各自 run.log）。

### 1.1 卡死判据与现场

卡死判据（FROZEN）:= `data-dshp-drawer=closed` 且 `:scope > [class*="_centerCol"]` 带 `inert`。

probe3b「静置、什么都不点」：进页面 1.2s 后

```
marker=closed  hasCollapsed=false  centerInert=true  sidebarInert=false
dialog: w=280 left=-308 rows=6 aria-modal=true   ariaModalCount=1  inertCount=4
frozen=true   hits: elementFromPoint(195,300/620) → div.mP3x-q_frame（点击被改派到 frame）
composer.inertAt = div.mP3x-q_centerCol
```

主内容四列（centerCol / rightbarCol / bottomRow / leadingSeat）全部 inert；官方侧栏 dialog 仍在屏外（left=-308）却保持 `aria-modal=true` —— 宿主认为「抽屉开着」。到 rest+10s 依旧，不自愈。

### 1.2 属性时间线：谁在什么时候打的 inert

probe4 `ATTR_TIMELINE`（addInitScript 起计时，属性级 MutationObserver）：

```
at=1372ms  dialog[aria-modal] 加上          ┐
at=1372ms  sidebarCol  inert 摘除           │
at=1372ms  centerCol/rightbarCol/bottomRow/ │  PRE_UPGRADE → ctx.layout.toggleSidebar()
           leadingSeat  inert 打上          │  → narrowExpanded=true → drawerOpen=true
at=1372ms  frame data-sidebar-collapsed 摘除 ┘
at=41827ms data-dshp-drawer=open（点汉堡，正常）
at=42732ms （实验：点官方 mask）aria-modal 摘除、centerCol inert 摘除、collapsed 打上
```

1372ms ≈ chrome 挂载后 700ms 的 `PRE_UPGRADE_MS` 定时器（drawer-chrome.ts `armPreUpgrade`）。**这一次调用就是「打开 DSH 过一会就卡死」的「过一会」。**

### 1.3 因果实验（inert 是卡死的充要条件）

probe4 实验 A：只 `removeAttribute('inert')` 摘掉主内容四列（其余一切不动）：

```
UNINERT_MAIN {nodes:4, before:[centerCol/rightbarCol/bottomRow/leadingSeat 均 inert]}
→ hits 立刻落到真实内容 div.an3WzG_scrollBody，composer.inertAt=null
→ 15s 后 HELD_FROZEN=false（不自愈回冻，因为宿主状态没变、React 没重渲染这四列）
再 setAttribute('inert','') 装回 → REINERT centerInert=true → 立刻复冻
```

宿主 AppFrame 真源码（app.asar 内 dsh-client-ui-layout）：

```js
const drawer = viewport < 768 && !windowsTitlebar
const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0
const drawerOpen = drawer && !sidebarCollapsed
...
<CenterColumn inert={drawerOpen}>  <RightbarColumn inert={drawerOpen}>
<div data-shell-bottom inert={drawerOpen?'' :undefined}>  <div data-shell-leading inert={drawerOpen?'' :undefined}>
```

SidebarRoot：`useModalLayer(column, drawer && !collapsed, toggleSidebar)`，`aria-modal={drawer && !collapsed}`；`wide = drawer || …` —— **抽屉模式下会话列表恒常驻挂载**，collapsed 只影响属性/inert/位移，不重挂载列表。所以 PRE_UPGRADE 在抽屉模式没有任何可预热的东西，纯害。

### 1.4 为什么「只有点侧边栏里的其他会话才能跳转」

宿主 `actions.selectPanel`：`if (viewportWidth < 768) narrowExpanded = false` —— 点会话行会把官方侧栏收回收起 → `drawerOpen=false` → 主内容 inert 解除。probe3b 实测：卡死态点会话行后 `centerInert=false、hits 落真实内容、mainClickable=true`。这同时解释了「跳进新会话详情，过一会又卡死」：要跳转就得再开抽屉，而开抽屉的 `needsUpgrade` 路径又会把官方展开；只要哪次关闭没把官方收回（旧代码三条路径都不收），主内容再次永久 inert。

### 1.5 候选假设逐条核销

| 假设 | 取证 | 结论 |
|---|---|---|
| ① 宿主把主内容 inert（官方 modal 常开） | §1.1–1.4 全部命中 | **成立，即根因** |
| ② 我们的 MutationObserver 风暴 / CPU 卡死 | rAF 心跳 maxGap 91–163ms、longtask 仅 4–8 次（含页面加载）、mutBatches 静置期 ~0 增长；解冻/复冻随 inert 摘装即时切换，与观察器频率无关 | 排除（主线程一直活着，画面「卡住」是 inert 不吃事件） |
| ③ 触摸手势层吃滚动（swipe.mjs / preventDefault） | swipe.mjs 全部 `passive:true`、无 `preventDefault`；卡死时 `scrollTop` 程序赋值可写但滚轮/触摸不进（inert 阻断命中），摘 inert 后立即可滚 | 排除 |
| ④ backdrop/固定层拦截 | elementFromPoint 在卡死时落到 `div.mP3x-q_frame`（inert 改派），不是任何 backdrop；aa1a101 的 mask 规则 `pointer-events:none/display:none` 工作正常 | 排除 |
| ⑤ ~21k 节点 DOM 爆炸 | 卡死现场 domNodes=5041–5044，远未到 21k；用户报「卡住」非「空白」 | 排除 |

## 2. 修复（最小改动，两条文件）

铁律：**抽屉模式（frame 带 `data-sidebar-drawer`）下，官方侧栏展开 ⟺ 我们的抽屉开着。**

1. `armPreUpgrade`：抽屉模式直接跳过（不再替用户打开一个永不关闭的宿主 modal）；非抽屉模式（宽屏强制手机布局，rail→列表的重建是真的贵）保留原行为。
2. 新增「延迟对账」`reconcileOfficial`：`applyState()`（开/关抽屉）与 chrome 挂载就位后 `setTimeout(0)` 对账一次 —— 抽屉模式下若官方开合与我们的 marker 不一致，调一次 `expandSidebar`/`collapseSidebar` 对齐；延迟是为了躲开宿主 `selectPanel`（点会话行时它在我们捕获监听之后才收起官方）与宿主 Escape 的同步翻转，两个顺序都收敛。对账后 400ms 复查、最多 3 次（宿主不理会时不空转）。**只在 `data-sidebar-drawer` 存在时对账**：非抽屉模式收起官方 = 折成 48px 图标 rail，那是用户的地盘，老纪律「只升不降」一字不动。
3. 关抽屉的滑出动画不受影响：宿主规则 `[data-sidebar-drawer][data-sidebar-collapsed] .sidebarCol` 的 `visibility 0s linear var(--ds-transition-duration-slow)` 会把 hidden 延迟到 transform 滑出播完。

### 改动文件 + 行号

- `src/client/pocket/mobile/drawer-chrome.ts`
  - L70–79：`DrawerChromeOptions` 新增 `collapseSidebar?: () => void`（含「抽屉模式收起≠图标 rail」注释）
  - L143–149：对账状态（`reconcileTimer` / `reconcileAttempts` / `RECONCILE_RETRY_MS=400` / `RECONCILE_MAX_ATTEMPTS=3`）
  - L178–208：`applyState()` 末尾 `scheduleReconcile(0)` + `reconcileOfficial` / `scheduleReconcile` 实现（铁律注释）
  - L385–396：`armPreUpgrade` 抽屉模式跳过（含根因注释）
  - L609–616：`attempt()` chrome 就位后对账一次（治重挂载留下的「官方展开+抽屉关着」冻结尾场）
  - L656：teardown 清 `reconcileTimer`
  - L29–34：× 按钮注释更新为新纪律（× 仍只调 `closeDrawer`，不直接碰宿主）
- `src/client/pocket/mobile/mobile-apply.tsx`
  - L259–266：控制器注释更新（只升不降 → 抽屉模式对称开合、非抽屉模式只升不降）
  - L317–327：`mountDrawerChrome` 接线 `collapseSidebar`（同一个 `ctx.layout.toggleSidebar`，盲翻转的方向由对账前的属性判据保证；错误上报 tag `collapseSidebar`）
- `scripts/test-mobile-session-scrollable.mjs`（新增，466 行）：根因回归，见 §3.1
- `package.json`：测试链在 `test-mobile-drawer-nav-close.mjs` 后插入新测试
- `lib/client.js`：`node build.mjs` 产物（仓库惯例随修复提交）

### 没碰的东西（约束逐项）

- `src/assistant-secretary.ts`、折叠预算常量（600/900/200）、`secretary-cards*`：未动。
- dbfb059 的 `onDocumentPointerDown` / `onDocumentClick` / `ensureCloseButton`：一字未改（× 按钮、文档级 pointerdown 关闭、导航行 click 关闭的逻辑原样；对账挂在 `applyState` 里，不改这三条的判定）。
- f8e1b3b backdrop 兜底（mobile.css.ts L476–483）：未动，新测试断言它还在。
- aa1a101 mask 两条规则、287308b 的 9 处 CSS + 4 处 JS 类名后缀锚点：未动，新测试断言锚点还在。
- 官方侧栏**没有**被折成图标 rail：抽屉模式的「收起」只是把抽屉滑回屏外（宿主自己的 collapsed 语义），rail 只在 ≥768px 出现，而那条路径（非抽屉模式）对账直接返回。
- 亮度断言组（f8e1b3b 的 251.5/138.0）：test-mobile-drawer-nav-close 13/13 绿，未回红。

## 3. 测试

### 3.1 新回归 `scripts/test-mobile-session-scrollable.mjs`（旧码红 / 新码绿）

最小假 DOM 模拟宿主 AppFrame 的 inert 语义（官方展开 ⇒ 摘 collapsed + 给主内容列打 inert；收起 ⇒ 反之），FROZEN 判据与真页面一致。10 条断言：静置不预展开、开抽屉展开、空白/×/会话行三条关闭路径收回官方且主内容解冻、对账收敛不空转、非抽屉模式只升不降、CSS 锚点、卸载熄火、全程无 FROZEN。

旧代码（`git stash` 两个 src 文件后）原始输出：

```
FAIL 静置 1s：抽屉模式不触发 PRE_UPGRADE，主内容列无 inert（不卡死） — 抽屉模式里官方侧栏本来就常驻挂载，不许预展开（旧代码这里会调用）  1 !== 0
PASS 开抽屉：marker=open 且官方展开（对账/同步补齐）
FAIL 点空白关抽屉：官方被收回收起，主内容列 inert 解除 — 关抽屉必须收回官方（旧代码不收 → 主内容永久 inert）  false !== true
FAIL 点右上角 × 关抽屉：官方收回，主内容解冻 — false !== true
PASS 点会话行关抽屉：与宿主 selectPanel 共存，最终官方收起、主内容解冻
PASS 对账收敛：静候 600ms 宿主 toggleSidebar 调用次数不再增长
PASS 非抽屉模式（宽屏强制手机布局）：PRE_UPGRADE 仍预展开一次，关闭不收回
PASS CSS 锚点完好：287308b 类名后缀 + aa1a101 压暗层 + f8e1b3b backdrop 兜底
PASS 卸载后对账定时器不再动作
PASS 全程 frozen 判据未在「抽屉关着」时成立（逐场景断言已覆盖，这里收尾）
EXIT=1   （7/10，三条根因断言红）
```

新代码原始输出：

```
PASS ×10（同上十条全绿）
ok test-mobile-session-scrollable — PASS 10/10
EXIT=0
```

### 3.2 构建与指定测试

```
node build.mjs            EXIT 0（lib/index.js、lib/pocket.js、lib/client.js、lib/computer-use*.js）
npm run check             EXIT 0（6 × node --check）
test-pocket-drawer-dismiss.mjs    ok — PASS 8/8   EXIT 0
test-mobile-drawer-nav-close.mjs  PASS 13/13      EXIT 0
test-mobile-settings-sheet.mjs    PASS 32/32      EXIT 0
```

### 3.3 全量套件（逐脚本，不受 && 短路影响）

逐脚本跑 package.json 测试链全部 80 个脚本（runner 与逐条输出在 `C::\Users\<ACCOUNT>\.dsh\repro\mobile-session-frozen\suite-run.log` / `suite-results.json`）：

```
TOTAL scripts=80 ok=78 failed=2
FAILED scripts/test-secretary-session-log-write.mjs exit=1
FAILED scripts/test-mobile-proxy.mjs exit=1
```

本次新增/涉及的脚本全绿：`test-mobile-session-scrollable.mjs 10/10`、`test-pocket-drawer-dismiss.mjs 8/8`、`test-mobile-drawer-nav-close.mjs 13/13`、`test-mobile-settings-sheet.mjs 32/32`、`test-mobile-drawer-chrome.mjs ok`、`test-mobile-toggle-zone.mjs ok`、`test-mobile-boot.mjs ok`、`test-composition-gate.mjs ok`。

`npm test`（&& 链）EXIT 1 的说明：链在第 11 个脚本 `test-secretary-session-log-write.mjs` 处短路，报错「宿主真实解析器不可用，已拒绝写入会话日志：`D:\deepseek-harness\packages\session\session-format-v3-to-v4\lib\index.js（不存在）`…」—— 本机没有这两个宿主 resolver 路径，是**环境性既有红**（上一轮 f8e1b3b 报告已记录同一个红）。另一个红 `test-mobile-proxy.mjs` 断言「不存在 @deepseek-ai/dsh-client-product-analytics」，已被 38ff1a4 引入该依赖 supersede（断言过期，既有红）。两个红都与手机抽屉/会话详情无关：本次改动的两个 src 文件不在它们的依赖路径上，且 stash 本次改动后它们照样红（上一轮报告记录的 failed 名单相同）。

## 4. 真页面验收（修复后，probe5）

同一环境（Playwright + 本机 Chrome，390×844，token-lan；完整原始输出 `probe5-run.log`）。**结论：修复前所有「卡住」信号归零，四条门全过。**

**门 1 · 静置 120s 不复冻**：rest+1.5s/+10s/+30s/+60s/+120s 全部 `frozen=false`、`centerInert=false`、`collapsed=true`、`inertCount=1`（只剩侧栏列自身那枚，属正常），`elementFromPoint` 全程落在真实内容 `an3WzG_scrollBody`，composer 无 inert 祖先，滚动可写。（修复前对照：rest+1.2s 即 `frozen=true`、`inertCount=4`、命中全部改派回 frame。）

```
GATE1_REST_120S {"frozen":false,"centerInert":false,"collapsed":true}
```

**门 2 · 开抽屉 → 点会话行**：`drawER_OPEN_OK {"marker":"open","dialogLeft":0,"rows":6,"expanded":true}`（官方正常展开、列表在屏）；点行后 `after-nav: closed + collapsed=true + centerInert=false`，再过 25s 依旧 `frozen=false`。修复前同一路径在 +20s 内仍活、但 at-rest 必冻；现在连「开抽屉过一会」这条复发路径也没了（关抽屉会把官方收回）。

**门 3 · 点抽屉外空白关闭**：`GATE_BLANK {"marker":"closed","collapsed":true,"centerInert":false,"frozen":false}` —— 空白关闭后官方被对账收回、主内容立即可点可滚。

**门 4 · 点 × 关闭 + 收尾**：`GATE_X` 同样全绿；最终再等 30s：`GATE_FINAL {"frozen":false,"centerInert":false,"collapsed":true,"marker":"closed"}`。

`PAGE_ERRORS` 只有 404/403 资源噪音（修复前后相同，与抽屉无关）。侧栏本身全程可点（开抽屉后行命中、点行成功收起并解除主内容 inert），与「只有侧边栏可点」的旧症状互为反证。

> 说明：`TAP_MAIN_AFTER_*` 报 "no main target" 是因为该测试账号的会话内容面板（`V4vHZW_column`）里没有 `[data-turn-process]` 这类可点目标 —— 但 `hits` 已落在真实内容列、`composerInert=null`，解冻判据与可点性由 elementFromPoint/focus/scroll 三项直接证明。

## 5. Commit

本地 commit（未 push、未重启宿主、未跑 dev:web；只 add 了本次改动的 5 个文件）：

```
b588eb5 fix(mobile): 会话详情过一会卡死 —— 抽屉模式下官方侧栏开合与我们的抽屉对齐

 lib/client.js                              | 108 +++----
 package.json                               |   2 +-
 scripts/test-mobile-session-scrollable.mjs | 494 +++++++++++++++++++++++++++++
 src/client/pocket/mobile/drawer-chrome.ts  |  65 +++-
 src/client/pocket/mobile/mobile-apply.tsx  |  18 +-
 5 files changed, 626 insertions(+), 61 deletions(-)
```

真机生效路径：`lib/client.js` 经 Junction（`C::\Users\<ACCOUNT>\.dsh\profiles\desktop\node_modules\dsh-assistant` → `D:\dsh-assistant`）直接被宿主伺服，手机刷新页面即生效，无需重启宿主（本次 probe5 即是对该产物的真页面验证）。

## 附：取证工件索引（未跟踪，勿删）

- 探针与日志：`C::\Users\<ACCOUNT>\.dsh\repro\mobile-session-frozen\`（probe2/3b/4/5 + 各 run.log、test-scrollable-OLDCODE/NEWCODE.log、suite-run.log、suite-results.json、asar-slices/）
- 宿主源码切片：`asar-slices\drawerOpen.txt`（AppFrame `inert={drawerOpen}`）、`SidebarRoot.txt`（`useModalLayer(column, drawer && !collapsed, toggleSidebar)`、`wide = drawer || …`、collapsed 时 `visibility` 延迟规则）
