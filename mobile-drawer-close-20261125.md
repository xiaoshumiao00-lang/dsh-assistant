# 手机端抽屉关不掉 + 缺收起按钮（2026-11-25）

**结论：抽屉本身没坏，是「点空白关抽屉」的判据被宿主 DSH 0.2.2 自己的抽屉实现毒死了。**
宿主把侧栏根节点渲染成 `<div role="dialog" aria-modal="true" data-shortcut-modal="sidebar">`，
而 `drawer-chrome.ts` 里那条「有模态框就让它掌屏」的守卫用的是
`document.querySelector('[aria-modal="true"]') !== null` —— 开抽屉时它命中的正是**抽屉自己**，
于是每一次「点抽屉外」都在守卫处 return，`closeDrawer()` 一次都没执行。
aa1a101 之前还能关，是因为原来真有一条点击路径（宿主原厂遮罩 `div.drawerMask[data-sidebar-mask]`
的 `onClick = toggleSidebar`）；aa1a101 把那一层改成 `pointer-events:none`（为了不让它把侧栏折成
图标 rail），替代品就是我们那条被 aria-modal 挡死的监听 —— 所以「点空白不收起」是这两个改动叠加的必然结果。
抽屉右上角没有收起按钮，是因为我们把宿主 logoRow 里那颗官方 toggle 用 CSS 藏掉了（它调 toggleSidebar，
会折成 rail），却没补一颗自己的按钮。

---

## 1. 现场证据（真页面 Playwright 探针，未改代码时采）

探针：`.tmp/probe-drawer-dismiss.mjs` / `.tmp/probe-guards.mjs` / `.tmp/probe-writes.mjs`
（本机 Chrome，414×896，`isMobile` + `hasTouch`，直连 `http://127.0.0.1:3081` 的真 pocket 页面，
PIN 登录后进真宿主 DOM；只读，不改任何文件）。

### 1.1 事件监听清单：我们的监听**挂上了**，但提前 return 了

把 `Document.prototype.addEventListener` 包一层记下的清单（抽屉开着时）：

| target | type | capture | 函数开头（压缩后） | 归属 |
|---|---|---|---|---|
| document | pointerdown | true | `()=>{fixed?.({type:\`reset\`})}` | 宿主 |
| document | pointerdown | true | `event=>{const element=event.composedPath().find(...)` | 宿主 |
| document | pointerdown | false | `b=>{if(!c(b)||l5(b.target)){a=null;return}a={x:b.clientX,...` | 我们的 swipe（passive） |
| document | pointerdown | true | `Ae=>{if(!o)return;let Ne=Ae.target;Ne instanceof Element&&...` | **我们的 `onDocumentPointerDown`** |
| document | pointerdown | true | `Ae=>{if(b=null,p||o)return;let Ne=Q0(Ae);...` | 我们的 `onZoneDown` |
| document | click | true | `s=>{let r=e;if(r===null||performance.now()>t){e=null;return}...` | 宿主 |

→ 监听确实在、确实是 capture；问题不在「没挂上」，在函数体里的判断。

### 1.2 pointer-events 计算值（抽屉开 / 关）

| 元素 | 抽屉开 | 抽屉关 |
|---|---|---|
| `[data-sidebar-mask]`（宿主原厂遮罩） | `pointer-events: none` | `pointer-events: auto` + `display:none` |
| `[data-mobile-nav="backdrop"]`（我们的压暗层） | `pointer-events: none` | `pointer-events: none` + `display:none` |
| `[data-shell-overlay]`（壳层） | `pointer-events: none`（子元素 auto） | 同 |

两块遮罩都点击穿透（aa1a101 + issue #38 的设计），所以「点空白」的点击**不会**落在任何遮罩上，
只能靠 document 级监听兜住 —— 这条例外路径又被 1.4 的守卫挡死。

### 1.3 elementFromPoint + 事件流水：点击确实送到了

抽屉开着时，点右侧空白 `(404,448)`：

```
elementFromPoint(404,448) 命中链：
  <div nav=frame class="mP3x-q_frame"> pe=auto
  <div class=""> pe=auto
  <div class=""> pe=auto
  <body class=""> pe=auto
  <html class=""> pe=auto
```

容器 `[class*="_centerCol"]` 此时带 `inert`（宿主 `CenterColumn inert={drawerOpen}`），命中被改派到
AppFrame 本身。document 捕获阶段收到的事件流水：

```
pointerdown target=div nav=frame  x=404 y=448
touchstart  target=div nav=frame  x=404 y=448
click       target=div nav=frame  x=404 y=448
```

→ 点击一路到达 document，`onDocumentPointerDown` 确实被调用；它没有关抽屉，是函数内 return。

### 1.4 根因：`[aria-modal="true"]` 命中的是抽屉自己

抽屉开着时页面上 `aria-modal="true"` 的节点数 = 1，就是宿主侧栏根：

```json
{
  "html": "<div role=\"dialog\" data-shortcut-modal=\"sidebar\" aria-label=\"导航\" tabindex=\"-1\" class=\"wtg9ga_root wtg9ga_quietBars\" aria-modal=\"true\">",
  "class": "wtg9ga_root wtg9ga_quietBars",
  "display": "flex",
  "visibility": "visible",
  "rect": { "x": 0, "y": 0, "w": 280, "h": 896 }
}
```

它就在抽屉列 `[class*="_sidebarCol"]` 里面（祖先链见 1.3 的 `wtg9ga_root > wtg9ga_sidebarCol`）。
旧代码：

```ts
/* 抽屉开外的模态框掌屏 */
if (doc.querySelector('[aria-modal="true"]') !== null) return   // ← 永远命中侧栏自己
closeDrawer()
```

同一个守卫还让「抽屉内的点击」全部落进 `isOverlayTap()`（`closest('[role="dialog"]')` 命中侧栏根），
所以连「点会话行关抽屉」也不可能由这条路径兜住。

### 1.5 改动前三条路径的实测结果（marker = `frame[data-dshp-drawer]`）

| 操作 | marker 结果 | 备注 |
|---|---|---|
| 点汉堡开抽屉 | `open` | 正常 |
| 点右侧空白 `(400,700)` | **`open`**（不关） | 症状复现 |
| 点右侧空白 `(404,448)` | **`open`**（不关） | 症状复现 |
| 点抽屉右上角 `(256,26)` | `open`，但宿主 `data-sidebar-collapsed` 被写上 | 那一下命中的是 `button.wtg9ga_brand`（宿主品牌钮=折叠侧栏），抽屉状态机与宿主状态脱钩 |
| 点会话行 `(28,346)` | **`open`**（不关） | 会话导航行只在 `MobileNavOverlay` 里有关闭逻辑，而这个组件在本宿主**不渲染**（DOM 里只有 `frame / session-log / backdrop / toggle`，没有 `fab`） |

### 1.6 与 aa1a101 的关系（对预判线索的核实结论）

- 「原本靠宿主遮罩的点击关抽屉」：**成立**。宿主 `drawerMask` 的 `onClick = toggleSidebar`（仅当宿主
  `drawerOpen` 时挂上），一按就把侧栏折成 rail；aa1a101 为保住列表内容把这一层改成 `pointer-events:none`。
- 「我们的 backdrop / document 监听」：backdrop 是 `pointer-events:none`（issue #38 起的既有设计），
  document 监听挂着但被 1.4 的守卫挡死。
- 结论：**不是** aa1a101 单独造成的，也不该靠恢复 `[data-sidebar-mask]` 的点击来修（那会重新把侧栏折成
  图标 rail）。修法只能是「我们自己的状态机接管点空白」，并把 aria-modal 判据限定为「抽屉之外的模态框」。

---

## 2. 改动（只动 JS，没碰 `[data-sidebar-mask]` 的 CSS）

### `src/client/pocket/mobile/drawer-chrome.ts`

| 行 | 改动 |
|---|---|
| 21 | 引入 `navTargetFor`（导航行判定复用 `nav-targets.mjs`，不另写一套） |
| 29–35 | 新增 `DRAWER_CLOSE_SELECTOR = '[data-mobile-nav="drawer-close"]'`（稳定锚点，不认哈希类名） |
| 63–67 | 新增 `CLOSE_ICON`（16×16 × 形） |
| 73 | `labels` 增加可选 `close`（无障碍名字） |
| 98 | 新增状态 `closeButton` |
| 161 | `applyState()` 里同步收起按钮（开/关、抽屉布局与否） |
| 175–179 | `drawerModeActive()`：只在宿主 `<768px` 的 `data-sidebar-drawer` 或强制抽屉布局下才挂按钮（电脑宽屏侧栏里不许露 ×） |
| 191–229 | `ensureCloseButton()`：按钮挂在**抽屉列本身**（不是 `[data-shell-overlay]`，那层的规则会藏掉我们的控件）；`position:absolute; top:calc(env(safe-area-inset-top,0px)+8px); right:8px; 40×40; z-index:5`；`click → closeDrawer()`，**不**调宿主 `toggleSidebar()` |
| 231–239 | `syncCloseButton()`：关着 / 非抽屉布局 → `display:none` |
| 243–255 | `modalOutsideDrawer(drawerEl)`：逐个看 `aria-modal="true"`，只要有一个**在抽屉之外**才算真掌屏 |
| 358–407 | `onDocumentPointerDown`：373–386 先判 `drawerEl.contains(target)`（**必须排在 `isOverlayTap` 前面**，否则侧栏自己的 `role="dialog"` 会把整个抽屉放过去）；364 顺手 `isConnected` 补挂被 React 摘掉的按钮 |
| 405–406 | 改用 `modalOutsideDrawer()`（旧判据为何必死见 398–404 的注释） |
| 415–423 | 新增 `onDocumentClick`：抽屉内命中 `navTargetFor()`（会话行 / 新会话 / 文件入口）⇒ `closeDrawer()`；行内 kebab 不算（`NAV_EXCLUDE`） |
| 556 | `attempt()` 里补一次 `syncCloseButton()`（壳层/抽屉列晚于 chrome 挂载时） |
| 587 / 608 | 注册 / 注销 `click` 捕获监听 |
| 615–617 | 卸载时摘掉收起按钮并清引用 |

### `src/client/pocket/mobile/mobile-apply.tsx`

| 行 | 改动 |
|---|---|
| 320–322 | `labels.close = navT('close')`（`mobileNav` 词典里的「收起目录」） |

### `scripts/test-pocket-drawer-dismiss.mjs`（新增，8 条断言）

最小假 DOM（带 `closest` / `matches` 极简选择器引擎 + `style.cssText` 摊平），直接跑真实现：

1. 现场条件：抽屉里的宿主侧栏带 `role=dialog` + `aria-modal`（旧判据会误判）
2. 点抽屉外空白（target 被 inert 改派到 frame）⇒ 关
3. 抽屉右上角有可见可点收起按钮（在抽屉列里、带 safe-area 上边距、贴右沿）
4. 点收起按钮 ⇒ 关，且**不**调宿主 `toggleSidebar`（`expandCalls` 不变）
5. 抽屉关着时按钮隐藏
6. 点会话行 ⇒ 抽屉同时收起
7. 抽屉**之外**的模态框掌屏时，点空白不关
8. 开着抽屉再点汉堡 ⇒ 收起（同一次点击不二次翻转）

`package.json`（第 57 行 test 链）在 `test-mobile-drawer-chrome.mjs` 之后插入该脚本。

---

## 3. 测试原始输出

### 3.1 旧代码（HEAD 的 `drawer-chrome.ts`）→ FAIL

```
$ node scripts/test-pocket-drawer-dismiss.mjs
PASS 现场条件：抽屉里的宿主侧栏带 role=dialog + aria-modal（旧判据会误判）
FAIL 点抽屉外空白（target 被 inert 改派到 frame）能关抽屉 — 点空白必须把 marker 置回 closed

'open' !== 'closed'

FAIL 抽屉右上角有可见可点的收起按钮（在抽屉列里，自带 safe-area 上边距） — 收起按钮必须挂在抽屉列里
FAIL 点收起按钮 ⇒ 收起（走我们自己的 closeDrawer，不叫宿主 toggleSidebar） — 点收起按钮必须关抽屉

'open' !== 'closed'

FAIL 抽屉关着时收起按钮隐藏（不会在电脑布局里露出一个 ×） — Cannot read properties of null (reading 'style')
FAIL 点会话行进详情 ⇒ 抽屉同时收起 — 点汉堡要能开抽屉

'closed' !== 'open'

FAIL 抽屉外的模态框（设置面板）开着时，点空白不关抽屉 — 模态框关掉后点空白应恢复关闭

'open' !== 'closed'

FAIL 开着抽屉再点汉堡 ⇒ 收起（同一次点击不二次翻转） — 点汉堡要能开抽屉

'closed' !== 'open'

AssertionError [ERR_ASSERTION]: 断言条数与 EXPECTED 对不上
1 !== 8
EXIT=1
```

（三条验收路径逐一 FAIL；`1 PASS / 7 FAIL`。）

### 3.2 新代码 → PASS

```
$ node scripts/test-pocket-drawer-dismiss.mjs
PASS 现场条件：抽屉里的宿主侧栏带 role=dialog + aria-modal（旧判据会误判）
PASS 点抽屉外空白（target 被 inert 改派到 frame）能关抽屉
PASS 抽屉右上角有可见可点的收起按钮（在抽屉列里，自带 safe-area 上边距）
PASS 点收起按钮 ⇒ 收起（走我们自己的 closeDrawer，不叫宿主 toggleSidebar）
PASS 抽屉关着时收起按钮隐藏（不会在电脑布局里露出一个 ×）
PASS 点会话行进详情 ⇒ 抽屉同时收起
PASS 抽屉外的模态框（设置面板）开着时，点空白不关抽屉
PASS 开着抽屉再点汉堡 ⇒ 收起（同一次点击不二次翻转）
ok test-pocket-drawer-dismiss — PASS 8/8
EXIT=0
```

### 3.3 构建 / 静态检查

```
$ node build.mjs
[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js
BUILD_EXIT=0

$ npm run check
> node --check lib/index.js && node --check lib/pocket.js && node --check lib/client.js && ...
CHECK_EXIT=0
```

### 3.4 `npm test`（默认环境）

`EXIT=1`，前 10 个脚本全绿（**96 条 PASS / 0 FAIL**），第 11 个
`scripts/test-secretary-session-log-write.mjs` 直接抛错：

```
Error: 宿主真实解析器不可用，已拒绝写入会话日志：
  D:\deepseek-harness\packages\session\session-format-v3-to-v4\lib\index.js（不存在）；
  D:\DSH Desktop\resources\app.asar\node_modules\@deepseek-ai\dsh-session-format-v3-to-v4\lib\index.js（不存在）
```

这是**本次改动之前就存在的环境问题**：`lib/index.js` 与 HEAD 逐字节相同
（`git diff HEAD -- lib/index.js` 为 0 行），宿主实际装在 `D:\deepseek-harness\resources\app.asar`，
源码里写死的两个候选路径都不存在。我试过把 asar 里的真实解析器抽出来（`DSH_HOST_PARSER` / `DSH_HOST_SESSION_MODULE`
支持），但依赖链继续要 `dsh-util-*` → `@js-temporal/polyfill` → `jsbi`，没有继续往下挖。

### 3.5 全套 77 个脚本逐个跑（绕开上面那条 fail-fast）

```
$ node .tmp/run-suite.mjs
...
OK   [68/77] scripts/test-mobile-toggle-zone.mjs (30ms)
OK   [69/77] scripts/test-mobile-drawer-chrome.mjs (59ms)
OK   [70/77] scripts/test-pocket-drawer-dismiss.mjs (60ms)
...
==== SUMMARY ====
scripts=77 ok=74 failed=3
PASS lines=339 FAIL lines=4
FAILED scripts/test-secretary-session-log-write.mjs  (宿主解析器路径不存在，见 3.4)
FAILED scripts/test-mobile-proxy.mjs                  (AssertionError: gzip 浏览器也必须收到精简后的 boot graph)
FAILED scripts/test-composition-gate.mjs              (断言仍期望 CSS 里的 `> :first-child`，287308b 之后已改成 `> [class*="_sidebarCol"]`)
```

后两条也**与本次改动无关**，A/B 验证：把 `lib/client.js` 换回 HEAD 版本（`git checkout HEAD -- lib/client.js`）
后，这两个脚本同样 `EXIT=1`，失败内容一字不差；它们读的是 `src/pocket-host/proxy.mjs` 和
`src/client/pocket/mobile/mobile.css.ts`（我一行没动）。换回本次构建后两个脚本依旧同样失败。

**相关脚本**：`test-mobile-drawer-chrome` → `ok`（EXIT 0）；`test-mobile-toggle-zone` → `ok`（EXIT 0）；
`test-pocket-drawer-dismiss` → `PASS 8/8`（EXIT 0）。

---

## 4. 真页面验收（本次构建已生效）

`.tmp/verify-drawer-fix.mjs`，本机 Chrome，四档视口，全部 `ALL PASS`（EXIT 0）：

| 宽度 | bundle 是新构建 | 点空白 ⇒ 关 | 收起按钮几何 | 点按钮 ⇒ 关 | 点会话行 ⇒ 关 |
|---|---|---|---|---|---|
| 375 | ✅ 含 `drawer-close` | ✅ open→closed | ✅ `{x:232,y:8,w:40,h:40}`，`display:flex`，`hitIsButton:true`，`aria-label=收起目录` | ✅ | ✅ |
| 390 | ✅ | ✅ | ✅ 同上 | ✅ | ✅ |
| 414 | ✅ | ✅ | ✅ 同上 | ✅ | ✅ |
| 430 | ✅ | ✅ | ✅ 同上 | ✅ | ✅ |

抽屉列 280×844，按钮 `x=232 y=8 40×40` → 右沿 272 / 抽屉右沿 280，整块在视口内。
1280×900 桌面布局单独验过：`[data-mobile-nav="drawer-close"]` **不存在**（宽屏侧栏里不会露 ×）。

---

## 5. 未验证项

1. **宿主没重启**：手机必须**刷新页面**才会加载新 `lib/client.js`（bundle 已确认含本次改动；
   未重启宿主、也未跑 `dev:web`）。
2. **真机 iPhone 刘海 / 安全区**：只验证了 `top: calc(env(safe-area-inset-top,0px) + 8px)` 这个写法与
   375–430 普通视口的几何（emulation 里 inset=0）。真机不同 inset 下按钮位置未实测。
3. **抽屉外模态框掌屏**（设置面板/导出面板）只在单测假 DOM 里验证；真页面上没有去点开设置面板。
4. **并发会话的 CSS 改动**（`[data-sidebar-mask]` 压暗层 / 进详情仍发暗）我没有碰，也没验证它们的现状；
   关抽屉逻辑全部在 JS（`drawer-chrome.ts`），不依赖那一块 CSS。
5. 宿主重渲染把收起按钮摘掉时，靠「下一次 pointerdown 时 `isConnected` 补挂」兜底；没有做持续观察，
   极端情况下（摘掉后用户第一下就点按钮位置）会先点到宿主内容一次。

---

## 6. 本地 commit

```
dbfb059 fix(mobile): tap-outside now really closes the phone drawer, plus a visible collapse button
 lib/client.js                             | 194 +++++++--------
 package.json                              |   2 +-
 scripts/test-pocket-drawer-dismiss.mjs    | 401 ++++++++++++++++++++++++++++++
 src/client/pocket/mobile/drawer-chrome.ts | 159 +++++++++++-
 src/client/pocket/mobile/mobile-apply.tsx |   2 +
 5 files changed, 652 insertions(+), 106 deletions(-)
```

未 `git add -A`；未跟踪的 `tmp-*.png` / `.tmp/` / `outputs/` / `secretary-*.md` / 另一会话的
`scripts/test-mobile-drawer-nav-close.mjs` 都没有进提交，另一会话当时正在改的
`src/client/pocket/mobile/mobile.css.ts` 也没进提交（提交时它在工作区里未暂存）。
未 push、未重启宿主、未跑 `dev:web`。

本报告（`mobile-drawer-close-20261125.md`）按仓库惯例留作未跟踪文件，不进 commit。
