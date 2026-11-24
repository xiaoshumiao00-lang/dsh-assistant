# 手机端「设置 → 个人助手」看不到内容 —— 根因、修复与回归（2026-11-25）

## 0. 结论先行

**一句话：** 设置页的整块手机样式在 DSH 0.2.2 上**直接失效**了 —— 面板还挂在
`:has(> :first-child > :last-child > button)` 这条位置门控上，而 0.2.2 把设置 tab 列表
从标题行搬进了独立的 `<nav>`，门控永远为假，于是面板退回 100vh 桌面网格：
**tab 条变成横向滚动（390px 下 6 个 tab 有 4 个落在面板外）、「手机访问」卡片右列
（nowrap）把标题/说明列挤成 42.6–76.6px（≈4 字一行）、面板顶到屏幕边缘、没有浮层形态**。
这就是「看不到显示内容」：框在、字读不到、tab 够不到。

**但要如实说明：整页纯白（连遮罩都没有）在本机 Chrome 上没能复现。** 320/360/390/430/700
五档 + 844×390 横屏 + Android WebView UA（`wv ... Chrome/156`，与真机同 UA）都量过：
面板节点在、宽度 288–358px、`display:grid`、`visibility:visible`、`opacity:1`、
`elementFromPoint` 命中内容区，控制台 0 个未捕获异常。如果真机确实是纯白，还需要手机侧
一次 DOM 取证（见 §6）。

## 1. 复现方式与现场数字（本机 Chrome，无宿主重启）

脚本：`scripts/test-mobile-settings-live.mjs`（playwright + 本机 Chrome + 真 pocket 页面
`http://127.0.0.1:3081`，走的正是手机那条链路：抽屉 → 账号菜单 → 设置 → 个人助手）。

**三组证据（390×844，修复前）：**

| 组 | 量什么 | 实测 |
| --- | --- | --- |
| ① 节点在不在 | 设置面板 | `div[role=dialog][aria-modal=true][data-shortcut-modal=settings].AnXs9G_panel` 在；子节点 `_navTitle` / `nav._nav > ._navList`（6 个 `button._navCell`）/ `_header` / `_options` 全在；面板内 26 个 button（含 QR 卡片、开关） |
| ② 多大 | 面板 / 内容区 | panel **358×844 @ (16,0)**，`position:relative`、`border-radius:0px`、`max-height:none`；options **358×730**；360×740 时 328×740；320×568 时 288×568 |
| ③ 被谁盖住 | 命中 / 层级 / 祖先 | `elementFromPoint(195,234)` → `DIV`（options 内部，无遮挡）；overlay 计算 `z-index:1300` > 抽屉 `1200`；面板祖先链 `display/visibility/opacity` 全部正常（无隐藏层） |

**真正坏的是几何，不是可见性：**

* tab 条 `overflow-x:auto`，6 个 tab 里 **4 个落在面板外**：`账号与余额 x=-97`、
  `通用设置 x=15`、`内置插件 x=351`、`Agent 预设 x=463`（面板 16…374）。
* 「手机访问」卡片：360×740 下右列（开发者 / Star / 链接，`white-space:nowrap`）拿 **199.4px**，
  左列（标题 + 说明）只剩 **42.6px** —— 每个字一行。

## 2. 四条假设逐条排

| 假设 | 结论 | 证据 |
| --- | --- | --- |
| ① 面板落在被 `!important` 钉成 0px 的轨里 | **不成立** | 设置面板是 body 级 portal（父链 `overlay → body`），不在 AppFrame 的 grid 里；frame `grid-template-columns` 390/412px 正常。但**同类位置选择器病**在设置面板内部确实还在（门控 `:has(> :first-child > :last-child > button)`），这次就是它 |
| ② 自己的 CSS 把设置容器 `display:none/opacity:0/被深色层盖住` | **部分成立（真因）** | 不是 `display:none`，而是**整块手机规则不匹配**（门控为假）→ 桌面 100vh 网格生效；面板自身 `display:grid / opacity:1 / visibility:visible / z-index:1`，overlay 1300 压住抽屉 1200 |
| ③ 设置页是 body 级 portal 浮层被裁剪 / z-index 被压低 | **不成立（裁剪的是内容，不是浮层）** | overlay z=1300 > 抽屉 1200；面板完整在视口内；被裁的是 tab 条与卡片右列（面板 `overflow:hidden`） |
| ④ 设置项在手机布局下没注入（渲染/Slot 没跑） | **不成立** | 「个人助手」tab 与 section 都在：`div[data-slot="settings.section"]` 内含 5 个分段按钮 + 「手机访问」卡片 + QR，注入正常 |

## 3. 改动

### `src/client/pocket/mobile/mobile.css.ts`

| 行 | 改了什么 |
| --- | --- |
| 337 | 新增 `SETTINGS_SHEET` 锚点常量：`:is([aria-modal="true"][data-shortcut-modal="settings"], [aria-modal="true"]:has([class$="_navList"]))` —— 两条身份判据（宿主自己的 `data-shortcut-modal="settings"`、以及全站唯一的 `_navList`），**不再用任何子元素序号** |
| 837–1001 | 重写整节「Settings sheet on mobile (DSH 0.2.2 dialog structure)」：删掉 19 条位置门控规则；面板改成 8px 边距 + 圆角 + `height:auto` + `max-height: calc(100dvh - 24px - safe-area)`（868 行）；**875/876 行覆盖 grid 列/行**（宿主 `202px 156px` 比手机面板宽，导致 tab 条溢出）；tab 条 `_navList` 改成 `repeat(auto-fit, minmax(92px,1fr))` 换行网格（≈3 列）；`_options` 成为唯一滚动区（`min-height:0` + `overflow-y:auto`）；「手机访问」卡片按 `data-*` 标记换行、右列取消 `nowrap`；面板显式写 `visibility:visible / opacity:1 / pointer-events:auto`（任何宿主/插件把它藏起来时兜底） |
| 1163 | 删掉重复的旧「dsh-web-ui polish: settings sheet」块（同样的 `:first-child` 门控），留指针注释指向上面那一节 |

### `src/client/pocket/index.jsx`

| 行 | 改了什么 |
| --- | --- |
| 565 | 「手机访问」卡片头部行加 `data-dsh-pocket-card="hero"` |
| 568 / 572 | 左列 `data-part="intro"`、右列 `data-part="credit"`（CSS 用插件自己的标记，不依赖宿主哈希类名） |

### 测试与其它

| 文件 | 说明 |
| --- | --- |
| `scripts/test-mobile-settings-sheet.mjs`（新，已接进 `npm test`） | 离线回归：取 `mobile.css.ts` 导出的 `MOBILE_CSS`，套到**照 0.2.2 实测结构复刻**的对话框 DOM 上，在真 Chrome 里 390/360/320 三档量「宽度非 0 / 没被隐藏 / tab 不被裁 / 内容无横向溢出 / 卡片左列 ≥120px / 命中面板 / overlay 压抽屉」+ 5 条选择器契约 |
| `scripts/test-mobile-settings-live.mjs`（新，手工跑） | 真页面验收（需要宿主在跑；不可达时 SKIP 退出 0）。loopback 自动读 `~/.dsh/dsh-pocket/token-lan`，公网读 `token` |
| `scripts/test-composition-gate.mjs:291` | **HEAD 上就是红的**：断言还是 287308b 之前的 `> :first-child` 写法，改成 `> [class*="_sidebarCol"]`（与代码一致，27/27 转绿） |
| `package.json` | `test` 链末尾加 `test-mobile-settings-sheet.mjs` |
| `lib/client.js` | `node build.mjs` 产物 |

## 4. 测试原始数字（RED → GREEN）

### 4.1 离线回归 `test-mobile-settings-sheet.mjs`

旧代码（`git archive HEAD` 快照，同一份测试文件）：

```
FAIL MOBILE_CSS 里设置面板锚点是 _navList / data-shortcut-modal（不是子元素序号）  — 没找到设置面板锚点
FAIL MOBILE_CSS 里设置面板规则按类名后缀挂：_nav/_navList/_navCell/_header/_options  — 缺 [class$="_nav"]
FAIL 设置面板不许被钉成 position:absolute/left:8px  — 找不到 Settings sheet 那节
FAIL 面板显式声明可见性  — 面板块缺 visibility: visible !important
FAIL 「手机访问」卡片的身份标记在插件自己的渲染里  — 缺卡片标记规则
FAIL [390×844] 面板是手机尺寸的浮层  — panel 358×844 at (16,0)
FAIL [390×844] tab 条换行排布  — display=flex overflowX=auto
FAIL [390×844] 6 个设置 tab 全落在面板内  — outside=["内置插件(327+68)","Agent 预设(403+80.2)"] panelRight=374
FAIL [390×844] 「手机访问」卡片左列拿到可读宽度  — intro 76.6px / credit 199.4px
（360×740、320×568 同样红；overlay z / 命中 / 宽度非 0 这几条绿）
FAIL 15/32 mobile-settings-sheet
```

新代码：

```
PASS 32/32 mobile-settings-sheet
（390×844: panel 366.5×284.2、tab outside=[]、intro 309.7px；360×740: 338.3、intro 281.2；
 320×568: 299.4、intro 242.3；三档 tab 条 display=grid、options 无横向溢出、overlay z=1300）
```

> 注：离线夹具内容比真实设置页短，所以面板高度是内容高度（284），真实页面见 4.2。

### 4.2 真页面验收 `test-mobile-settings-live.mjs`

旧构建（390×844）：

```
PASS 面板宽度非 0 — 358px
PASS 面板未被隐藏（自身 + 祖先链） — display=grid visibility=visible opacity=1 hiddenChain=[]
FAIL 面板高度收在视口内（≤ vh-12） — h=844 vh=844
FAIL tab 列表不是横向滚动条（换行排布） — overflowX=auto w=358
FAIL 所有设置标签都在面板内（不被裁掉） — tabs=6 outside=["账号与余额(-97+108)","通用设置(15+108)","内置插件(351+108)","Agent 预设(463+108)"]
FAIL 卡片标题/说明列宽度 ≥ 120px（不被右列挤成竖排） — intro w=42.6 credit w=199.4   ← 360×740
FAIL 10/14 mobile-settings-live
```

新构建（build 之后同一脚本）：

```
PASS 设置面板存在（aria-modal + _navList） — pos=relative 374×461
PASS 面板宽度非 0 — 374px
PASS 面板不超出视口 — panel x=8 w=374 vw=390
PASS 面板未被隐藏（自身 + 祖先链） — display=grid visibility=visible opacity=1 hiddenChain=[]
PASS 面板高度收在视口内（≤ vh-12） — 稳态实测 panel 374×820 @ (8,12)，options 374×672、scrollHeight 1469（可滚）
PASS tab 列表不是横向滚动条（换行排布） — 6 个 tab 3×2 网格
PASS 所有设置标签都在面板内（不被裁掉） — tabs=6 outside=[]
PASS 内容区宽度非 0 且无横向溢出 — w=374/360=344
PASS 「手机访问」卡片在面板内且无横向溢出 — card 304×96
PASS 卡片标题/说明列宽度 ≥ 120px — intro w=304 credit w=199.4
PASS 内容区中心点击命中面板内部 — 195,280 → DIV
PASS 页面无未捕获异常
PASS 14/14 mobile-settings-live
```

### 4.3 构建与静态检查

```
node build.mjs   → "[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js"，EXIT 0
npm run check    → EXIT 0
```

### 4.4 全套测试

`npm test` **EXIT 1**：`96 PASS / 0 FAIL` 后停在 `test-secretary-session-log-write.mjs` ——
宿主升到 0.2.2 后 `D:\deepseek-harness\packages\session\session-format-v3-to-v4\lib\index.js`
与 `D:\DSH Desktop\...` 都不存在（`src/session-log-guard.ts:188-189` 的硬编码候选路径）。
**改动前同样红**（见 `.tmp/npm-test-baseline.log`，96 PASS / 0 FAIL 后同一条中断），与本次改动无关。

为给全量结论，把 `package.json` 的 `test` 链**逐条单跑**（79 条）：

```
SUMMARY scripts=79 exit0=77 nonzero=2 PASSlines=365 FAILlines=0
  非 0 的两条（都是改动前就红，已用 HEAD 快照复核）：
  · test-secretary-session-log-write.mjs — 宿主解析器路径不存在（同上）
  · test-mobile-proxy.mjs — "gzip 浏览器也必须收到精简后的 boot graph" 断言过期
    （38ff1a4 之后不再精简模块图；旧快照上同一条同样失败）
  新增 test-mobile-settings-sheet.mjs — PASS 32/32
```

## 5. 修后的手机设置页（实拍）

`390×844`：设置面板变成圆角浮层（8px 边距、距顶 12px），tab 条 3×2 换行（6 个 tab 全部可点），
「手机访问」卡片标题/说明独立成行，正文可纵向滚动（内容 1469px 装进 672px 视野），
关闭按钮常驻右上角。截图：`.dsh\repro\mobile-settings-blank\new-390x844.png` / `new-360x740.png`。

## 6. 未验证项（明确列出）

1. **宿主没有重启**（按规矩不重启）。`node build.mjs` 只重写 `lib/client.js`，boot 图里模块 URL
   带 `rev` 内容哈希 —— **手机需要刷新页面**才会拿到新包。
2. **真机未验证**：只有本机 Chrome（390/360/320/700/844×390、含 Android WebView UA）与离线夹具。
   真机上的安全区（刘海/手势条）、系统字体放大没有实测。
3. **整页纯白未复现**：如果真机仍是整页纯白（不是「内容挤成竖排 / tab 够不到」），那属于另一条链路
   —— 需要手机侧一次取证：`~/.dsh/dsh-pocket/diagnostic.jsonl` 里 `name":"layout-probe"` 那条
   （带 w/h/grid/frame 子元素顺序）＋ 一次 `document.querySelector('[aria-modal="true"]')` 的截图。
   本机这次只证实了「设置面板的手机样式整块失效」这条真因。
4. **公共隧道页在本机会整页空白**：`__DSH_BOOT__` 有 86 模块 / 3 批次，但 `#root` 子节点 0、
   无 client 心跳、无报错。与本次修复无关，也没修 —— 未确认是否与手机同因，单列出来。
5. 手机端布局的其它分支（强制 `data-dsh-pocket-layout="desktop"`、≥1024px 桌面档）本批没有逐项回归。
   实测过的是 844×390 横屏（仍是手机壳）：修前是官方 800×342 居中卡片、内容 612×288；
   修后按新规则变成 828×366 浮层（8px 边距、tab 3 列、内容 794 宽、14/14 全绿），
   即横屏手机也统一走手机浮层，桌面档（body 不带 mobile 标记且视口 ≥1024）不受影响。
