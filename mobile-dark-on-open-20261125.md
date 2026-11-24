# 点会话进详情「页面还是暗的，点一下才正常」— 根因与修复（2026-11-25）

## 结论（先看这段）

**真凶不是宿主 0.2.2 的 `div.drawerMask[data-sidebar-mask]`，而是我们自己的 `[data-mobile-nav="backdrop"]`**（`rgba(0,0,0,.45)`、`z-index:30`、全屏 390×844）。

直接原因链：

1. 抽屉 chrome 从 React overlay（`MobileNavOverlay.tsx`）改写成纯 DOM（`drawer-chrome.ts`）之后，**「点抽屉里的导航行 = 关抽屉」这条规则只留在 `MobileNavOverlay` 里，而 MobileNavOverlay 这个宿主构建里根本没渲染**（`mobile-apply.tsx` 只在第 4 行 import 了它，全文件没有 `<MobileNavOverlay`）。
2. `drawer-chrome.ts` 的文档级 `pointerdown` 又对「抽屉内的点击」一律早退放行（"抽屉里的点击先判，不在这里关"），于是点会话行 / 新会话之后 `data-dshp-drawer` **仍然写着 `open`**。
3. marker 还是 open → `[data-mobile-nav="backdrop"]`（inline `display:block`）继续盖在刚打开的会话详情上；同时宿主那边**自己**把官方侧栏收掉了（`data-sidebar-collapsed=true`，宿主规则 `visibility:hidden` 那一列），所以用户看到的是「抽屉不见了，但整页还是暗的」。
4. 用户再点一下：那一下落在详情页上（我们的 backdrop 是 `pointer-events:none`，不抢点击），同时命中 `pointerdown` 的「点抽屉外 → closeDrawer()」分支 → marker 变 closed、backdrop `display:none` → 页面亮。**这就是「点一下才正常亮度」，而且那一下是白点的（第一次点详情页内容不会生效）。**

**aa1a101 为什么没治好**：它修的是宿主那一层（`${FRAME_SELECTOR}:not(${OPEN}) > [data-sidebar-mask] { display:none }` + 开着时 `pointer-events:none`）。这两条至今都还在、也一直生效（下面的实测里，marker 一 closed，宿主 mask 立刻 `display:none`），但**它压暗的那一层从来不是让页面变黑的那一层**：宿主 mask 是 `rgba(0,0,0,.24)`，而且宿主自己 collapse 之后会在 300ms 内淡到 `opacity:0`（实测 0.9928 → 0.0165 → 0）。真正持久发黑的是我们自己的 `.45` 那层，aa1a101 没有碰它。

主因修复（导航行点击关抽屉）与「抽屉右上角收起按钮」「点空白关闭」是同一次并行改动落地的，已在 **`dbfb059`**（`src/client/pocket/mobile/drawer-chrome.ts` 的 `onDocumentClick`，L415–423，注册在 L587）。本份提交在此之上补两件事：**一条兜底 CSS**（marker 因任何原因没跟上时也不许留暗屏）+ **一条能红的回归测试**，并给出窄窗实测证据。

---

## 一、实测现场（真宿主 0.2.2，`http://127.0.0.1:58395`）

方法和口径（读完可复算）：

- 无头 Chrome（`channel: 'chrome'`，390×844，DPR 2，`isMobile`，Android Chrome UA），用宿主自己的 browser-session cookie 打开真实页面（cookie 由 `~/.dsh/.credentials.yaml` 里 `client-connection/browser-session` 的签名密钥本地签出，脚本在 `C::\Users\<ACCOUNT>\.dsh\repro\mobile-dark\`，**没有**改宿主、没有重启宿主）。
- 每步都取：`document.elementsFromPoint()` 前 8 层、所有「面积 ≥ 半屏 且 fixed/absolute/sticky 且背景有 alpha 或 backdrop-filter」的层、以及 `[data-sidebar-mask]` / `[data-mobile-nav="backdrop"]` / `[class*="_sidebarCol"]` 的 computed 值。
- 亮度 = 截图右侧区域（780×1688 图里的 `(429,253)-(741,759)`，即抽屉之外的主内容区）的平均亮度，Python/Pillow 算（`lum.py`）。
- 时间基准 `t0` = 点击会话行那一刻；`t120 / t520 / t2000` = 之后。

### 变暗时（旧构建，`aa1a101` 之后、`dbfb059` 之前）

| 步骤 | marker | 宿主 frame | 宿主 mask | **我们的 backdrop** | 全屏压暗层清单 | 亮度 |
|---|---|---|---|---|---|---|
| 列表页 / 抽屉关 | `closed` | `data-sidebar-drawer` | `display:none`，w=0 | `display:none` | 无 | **251.5** |
| 抽屉打开 | `open` | — | `display:block`，`opacity:1`，`rgba(0,0,0,0.24)`，`pointer-events:none` | `display:block`，`rgba(0,0,0,0.45)`，390×844 | mask + sidebarCol + backdrop | 165.9 |
| **点会话行 t0** | **`open`** | `data-sidebar-collapsed=true`（宿主自己收了侧栏） | `opacity:0.992768`（开始淡出） | **`display:block`** | mask + sidebarCol + backdrop | 171.7 |
| t120 | `open` | 同上 | `opacity:0.0165083` | `display:block` | mask + backdrop | — |
| **t520** | **`open`** | 同上 | `opacity:0` | **`display:block`** | **只剩 backdrop（`.45`）** | **138.0** |
| t2000 | `open` | 同上 | `opacity:0` | `display:block` | 只剩 backdrop | **138.0** |
| **点一下之后 t120** | **`closed`** | 同上 | `display:none` | **`display:none`** | **无** | **251.5** |

- 变暗 = 138.0，正常 = 251.5，**掉了约 45%**，而且 t2000 仍然 138.0（不是过渡动画，是稳定停在那）。
- `elementFromPoint(195,422)` 在变暗时命中的是 `div.GRgSLq_input`（输入框，`pointer-events:auto`）——**不是**遮罩：所以我们那块 backdrop 不抢点击（这是设计），用户「点一下」时那一下其实是在点详情页，只是顺手触发了文档级的「点抽屉外 → 关抽屉」。
- 三类候选的排除/确认：
  1. **宿主 `div.drawerMask[data-sidebar-mask]`：确认存在，但不是元凶**。它是 frame 的直接子元素（`mask.parentElement === frame` 为 true），`z-index:70`，`background: rgba(0,0,0,0.24)`，`backdrop-filter:none`（本机主题的 `--dsw-mask-blur` 为 none）；它在宿主 collapse 后 300ms 内自己淡到 0，且 aa1a101 的 `:not([data-dshp-drawer="open"]) > [data-sidebar-mask]{display:none}` 仍在生效（点一下之后 mask 立刻 `display:none`）。
  2. **助手自己的 `[data-mobile-nav="backdrop"]`：确认是元凶**，见上表：它在 t520/t2000 是唯一剩下的压暗层，`rgba(0,0,0,.45)`，`display:block`，正好对应「整页发暗、抽屉已不在」。
  3. **宿主路由/转场遮罩或其它 fixed 层：排除**。整个流程里「面积≥半屏的 fixed/absolute 层」只有上表这几种，没有任何第三个全屏遮罩；`layers` 清单在点一下之后是空数组。

### 修好之后（当前 HEAD + 本提交，mouse 与 touch 两条路径）

| 路径 | t0 | t600 | t1800 | 压暗层 |
|---|---|---|---|---|
| `locator.click()`（合成鼠标点击） | marker `closed`，backdrop `none`，mask `none/0` → **251.5** | 251.5 | 251.5 | 只有 sidebarCol（白底，已在屏外） |
| `touchscreen.tap()`（touchstart/touchend + 合成 click） | marker `closed`，backdrop `none`，mask `none/0` → **251.5** | 251.5 | 251.5 | 同上 |

即：**点会话行的那一下就把抽屉状态关掉，详情页第一帧就是正常亮度，不需要第二次点击。**

### 定位过程中做过的三条对照实验（钉住"哪一层"这件事）

在旧构建上，用注入的方式单独验证三种假设（同一套页面、同一套取点，只改一件事）：

| 注入的实验 | t0 亮度 | t600 | t1800 | 说明 |
|---|---|---|---|---|
| control（什么都不做） | 169.4 | **138.0** | **138.0** | 复现 bug：暗屏会一直留着 |
| 只注入「点导航行 → marker closed + backdrop hidden」 | **251.5** | 251.5 | 251.5 | 立刻亮 ⇒ 主因就是"抽屉状态没关" |
| 只注入兜底 CSS（官方 collapsed 时隐藏我们的 backdrop） | 222.4 | **251.4** | 251.4 | 也能亮，但要等宿主自己的 .24 mask 淡完（≈300ms）⇒ 兜底够用、但不是"第一帧就亮" |

结论：**主修复必须是"点导航行就关抽屉状态"**（已由 `dbfb059` 落在 `drawer-chrome.ts`），兜底 CSS 只负责"万一 marker 又没跟上，也绝不留一块暗屏"。

---

## 二、宿主源码依据（`D:\deepseek-harness\resources\app.asar`，只读）

从 asar 里解出 `@deepseek-ai/dsh-client-ui-layout` 的 src（解包脚本在 repro 目录），逐条对上：

- `src/client/AppFrame.tsx` L172：`const drawer = viewport < SIDEBAR_DRAWER_BREAKPOINT && !windowsTitlebar`；`columns.ts` L21 `SIDEBAR_DRAWER_BREAKPOINT = 768`。
- `AppFrame.tsx` L312-313：`{drawer && <div className={css.drawerMask} data-sidebar-mask aria-hidden="true" onClick={drawerOpen ? () => { actions.toggleSidebar() } : undefined} />}` —— **看起来像元凶**：它的 onClick 就是官方 `toggleSidebar()`，点一下会把侧栏折成图标 rail，和用户描述的"点一下就好"高度吻合。所以必须实测排除，不能靠读代码定案。
- `AppFrame.module.css` L310-324：`.drawerMask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;z-index:70;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);opacity:0;pointer-events:none}`；`.frame[data-sidebar-drawer]:not([data-sidebar-collapsed]) .drawerMask{opacity:1;pointer-events:auto}`。
- `AppFrame.module.css` L298-304：`.frame[data-sidebar-drawer][data-sidebar-collapsed] .sidebarCol{transform:translateX(-100%);visibility:hidden;transition: transform .3s, visibility 0s linear .3s}` —— 这解释了"抽屉明明没收起来（marker=open、我们的 transform:none 还压着）却看不见了"：宿主用 `visibility:hidden` 收的，我们的 `transform:none !important` 管不到 visibility。
- 这三条合起来才有"抽屉消失 + 全屏变暗 + 点一下恢复"的组合症状；只盯宿主 mask 会得出 aa1a101 那种"修了但没用"的结论。

---

## 三、改了哪些文件、哪些行号

本提交（在 `dbfb059` 之后）：

| 文件 | 行 | 改了什么 |
|---|---|---|
| `src/client/pocket/mobile/mobile.css.ts` | **L464-471**（新增） | 兜底规则：`[data-mobile-nav="frame"][data-dshp-drawer="open"][data-sidebar-collapsed] [data-mobile-nav="backdrop"] { display:none !important }`。含义：宿主已经把侧栏列 `visibility:hidden` 收走时（抽屉其实不在屏上），我们自己的压暗层一律不许显示 —— marker 因事件丢失/竞态/别的插件改宿主状态而停在 open，也不会再留一块暗屏。 |
| `scripts/test-mobile-drawer-nav-close.mjs` | 新增 299 行 | 回归测试，**13 条断言**：5 条状态机（关着点会话行不留暗层 / 开着点会话行立刻关 / kebab 不关 / 抽屉内非导航空白不关 / 点抽屉外照旧关）+ 3 条选择器（aa1a101 的两条仍生效 + 本次兜底）。 |
| `package.json` | L57（`scripts.test`） | 把 `scripts/test-mobile-drawer-nav-close.mjs` 接进全量链（紧跟 `test-pocket-drawer-dismiss.mjs`）。 |
| `lib/client.js` | 重建 | `node build.mjs` 产物，含上面那条 CSS（`mobile.css.ts` 是 `MOBILE_CSS` 的单一来源，两份副本——`@media (max-width:1023px)` 与 `body[data-dsh-pocket-layout="mobile"]` 前缀版——都已带上）。`lib/index.js`、`lib/pocket.js` 与 HEAD 完全一致（`git diff --stat` 为空），即这次没有动服务端产物。 |

并行落地的**主因修复**（同一 bug 的必要一半，不是我写的，但我逐行核对并实测过）：`dbfb059`，`src/client/pocket/mobile/drawer-chrome.ts` L415-423 `onDocumentClick`（capture 阶段，`navTargetFor(target)` 命中就 `closeDrawer()`；用 click 而非 pointerdown，保证 React 先收到这次点击）、L587 注册，以及同 commit 的 `modalOutsideDrawer` / 收起按钮。

没有动：`src/assistant-secretary.ts`、任何折叠预算/`600`/`900`/`200` 常量、`secretary-cards*` 相关逻辑。

---

## 四、测试原始数字

**先红后绿（同一份测试、同一台机器）**

1. 旧代码（`aa1a101`，`dbfb059` 未落地时跑）：
   ```
   AssertionError [ERR_ASSERTION]: 点会话行（导航）必须立刻关抽屉：否则 .45 压暗层一直盖在刚打开的会话详情上，用户要再点一下才亮
   'open' !== 'closed'
       at scripts\test-mobile-drawer-nav-close.mjs:260
   [exit code: 1]
   ```
2. 只差兜底 CSS 时（`dbfb059` 已落地、`mobile.css.ts` 未改）：
   ```
   AssertionError [ERR_ASSERTION]: 兜底规则缺失：官方已 collapsed（宿主把侧栏列 visibility:hidden 收走）时，我们自己的 backdrop 必须 display:none
       at scripts\test-mobile-drawer-nav-close.mjs:308
   [exit code: 1]
   ```
3. 加上兜底 CSS 之后：
   ```
   PASS 13/13
   ```

**相关 smoke（原始行）**

```
=== test-mobile-drawer-nav-close ===
PASS 13/13
=== test-pocket-drawer-dismiss ===
PASS 抽屉外的模态框（设置面板）开着时，点空白不关抽屉
PASS 开着抽屉再点汉堡 ⇒ 收起（同一次点击不二次翻转）
ok test-pocket-drawer-dismiss — PASS 8/8
=== test-mobile-drawer-chrome ===
ok test-mobile-drawer-chrome
=== test-mobile-toggle-zone ===
ok test-mobile-toggle-zone
```

**`npm run check`**：`node --check` 六个产物全过（EXIT 0）。

**`node build.mjs`**：`[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js`。

**全量 `npm test`**：`npm test` 本身 **EXIT 1**，而且它会在**第一个**失败脚本处就停（`&&` 链），所以我在本机把链上的 78 个脚本**逐个跑完**，拿到完整原始结果（`C::\Users\<ACCOUNT>\.dsh\repro\mobile-dark\suite-results.json`）：

```
TOTAL scripts=78 ok=75 failed=3
FAILED: scripts/test-secretary-session-log-write.mjs exit=1
FAILED: scripts/test-mobile-proxy.mjs exit=1
FAILED: scripts/test-composition-gate.mjs exit=1
```

三个失败**都与本改动无关**，且都是"更早的、有意的改动没同步更新自己的测试/环境"：

| 失败脚本 | 原始失败点 | 为什么与本改动无关 |
|---|---|---|
| `test-secretary-session-log-write.mjs` | `Module.loadHostLogParser` 抛「宿主真实解析器不可用」：候选路径 `D:\deepseek-harness\packages\session\session-format-v3-to-v4\lib\index.js`、`D:\DSH Desktop\resources\app.asar\node_modules\...` 在本机都不存在（`Test-Path` 两个 False） | 环境缺路径；同一次构建里 `lib/index.js`、`lib/pocket.js` 与 HEAD **二进制一致**（`git diff --stat` 为空） |
| `test-mobile-proxy.mjs` | L73 `assert.equal(body.includes(desktop), false)`：期望精简 boot graph 里**没有** `@deepseek-ai/dsh-client-product-analytics` | 这条期望被 `38ff1a4 fix(pocket): keep the full module graph for mobile lean boot (DSH 0.2.2 compat)` 有意废弃（为 0.2.2 兼容改成保留完整模块图），测试没跟着改；脚本只 import `src/pocket-host/proxy.mjs`（本提交没碰） |
| `test-composition-gate.mjs` | 期望 CSS 里还有 `[data-mobile-nav="frame"] > :first-child [data-window-drag] button[class*="_toggle"]`，实际已经没有（现为 `> [class*="_sidebarCol"] ...`） | 这条选择器被 `287308b`（本轮之前）为了修 0.2.2 的 `drawerMask` 抢第 1 个网格位而**故意换掉**，测试没跟着改；脚本只 import `mobile.css.ts`，不读 `lib/client.js` |

顺带记一笔：这 3 个红灯在 `dbfb059`（这次改动之前）就存在，属于仓库现状；本轮没有顺手改它们（超出「只改自己该改的」范围），需要的话可以单开一轮专门清。

---

## 五、我必须说清楚的未验证 / 不能保证的部分

1. **没有真机验证。** 全部证据来自 390×844 无头 Chrome（Android UA + `hasTouch`），touch 路径是 `page.touchscreen.tap()` 合成事件，不是真实 WebView（微信 XWEB / 小米浏览器）。真机上"click 在 React 重渲染后还会不会到"这类时序，理论上仍可能与仿真不同。
2. **宿主没有重启**，所以这一版只有 **`lib/client.js` 变了**：手机端必须**刷新页面**才会拿到新 bundle（`node build.mjs` 已重建，junction 到 profile 的路径见仓库约定）。我没有碰宿主进程、没有 `pnpm dev:web`。
3. `npm test` 整体 **EXIT 1**：三个失败脚本（`test-secretary-session-log-write.mjs` 环境缺宿主解析器路径、`test-mobile-proxy.mjs` 与 `test-composition-gate.mjs` 的期望被更早的 `38ff1a4` / `287308b` 有意改掉但测试没同步）全部早于本次改动存在、且不读我改的任何文件；逐脚本跑完整链的原始结果：`scripts=78 ok=75 failed=3`（`C::\Users\<ACCOUNT>\.dsh\repro\mobile-dark\suite-results.json`）。
4. **兜底 CSS 只覆盖"宿主已经 collapsed"这个状态**。如果哪天宿主在收侧栏时**不再**设 `data-sidebar-collapsed`（或换成别的 marker），兜底会失效 —— 那时主修复（导航行点击关抽屉）仍然是第一道防线，但"其它路径残留 marker"就又没网了。测试里那三条选择器断言就是为这种宿主升级准备的哨兵。
5. 亮度数字是"主内容区平均亮度"，不是 WCAG 对比度；用它比较"暗 / 亮"够用，不能当无障碍指标。
6. 复现用的登录 cookie 是本地从签名密钥签出来的（只在本机、只读页面），没有写进仓库、没有写进报告；`D:\dsh-assistant` 里也没有留下任何 cookie/密钥。
