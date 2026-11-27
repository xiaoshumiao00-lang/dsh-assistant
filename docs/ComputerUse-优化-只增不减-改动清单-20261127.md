# Computer Use 优化改动清单（只增不减，2026-11-27）

> 本轮**只出清单**：不写实现代码、**不改 `vendor/computer-use` 任何文件**（只读引用行号）。
> 落地时按本清单逐条实现，每条都要过 §4 的 A/B 实测门禁；任一项变慢或变差 → 关掉该通道。

## 0. 结论先行

| 项 | 口径 |
| --- | --- |
| 视觉路线 | **保留且是唯一决策者**：模型看截图自己给坐标（`vendor/computer-use/index.js:1240` click / `:1771` drag 的坐标解析一个字不动） |
| 控件树（UIA） | 只做三件事：**前置候选清单**、**编号框锚点**、**事后校验**；不决定点哪里 |
| 坐标系 | 沿用 `src/coordinate-mode.ts`（服务 `assistantCoordinateMode`，像素 / 千分比；`src/assistant.ts:155` 在建会话时读） |
| 已实现、不重复 | 裁剪局部图与旧帧折叠**已实现**，本清单不再提、不再改 |
| 硬约束 | 5 条「只增不减」保底（§1），任何改动不得比现状更慢或更不准 |
| 禁项 | 禁 Best-of-N / 多轮 rollout 换准确率；不弃视觉；不换模型 |

## 1. 五条硬约束（用户要求，不可违背）

1. **读不出就整帧退回纯视觉**：控件树读不出来的页面（自绘控件、canvas、小程序、图片），编号框通道**自动不启动**，整帧原样退回纯视觉猜坐标，**不加任何开销**。
2. **按页面缓存复用**：控件解析结果按页面缓存；UI 变了才重跑，**不每帧重解析**；总步数只降不升。
3. **只比对、不决定**：事后校验只做「点到的位置是否落在那条控件的 rect 内」的比对；比对不中即判 UI 已变、退回原路径（清缓存 + 下次重解析），**绝不替模型改点击位置**。
4. **禁 rollout**：明确禁止靠多轮 rollout（Best-of-N）换准确率——它必然变慢。
5. **同任务新旧各跑一遍实测**：改动落地前，同一任务在新（开通道）/旧（关通道）各跑一遍；**步数或耗时变多就关掉该通道**。

## 2. 四步方案落点（已定稿口径）

| 步 | 做什么 | 落点 | 不许碰 |
| --- | --- | --- | --- |
| ① 视觉坐标 | 模型自己看截图给坐标，坐标换算沿用现有口径 | `vendor/computer-use/index.js:1240`（click）、`:1771`（drag）、`:120` `mapFractionToGlobal`；坐标系开关 `src/coordinate-mode.ts:119-124`、`src/assistant.ts:155` | 点击/拖拽的坐标解析、`sameRect` 基准链 |
| ② 前置候选清单 | 每步观察前给一份「这页有哪些可点控件 + rect + 文本」的候选清单，作为**提示**追加，不替换截图 | **拟新增** `src/cu-uia-probe.ts`（纯逻辑，可 `node` 单测）：`probeFrontWindow()` → `[{ id, name, role, rect, text, source }]` | 不改容器尺寸、不改截图内容、不改工具 schema |
| ③ 编号框锚点 | 在**观察帧副本**上给候选控件画编号框（编号 ↔ 候选 id 一一对应），原帧保留 | **拟新增** `src/cu-uia-overlay.ts`：输入帧 + 候选，输出带编号的副本；无候选时**原样返回原帧**（零开销路径） | 不覆盖 `writeDesktopScreenshots()`（`vendor/computer-use/index.js:998`）产出的原图 |
| ④ 事后校验 | 点完之后比对「实际落点 ∈ 该控件 rect（含 padding）」 | **拟新增** `src/cu-uia-probe.ts#verifyClick(rect, clickedPx)` → `'hit' \| 'miss' \| 'unknown'` | 绝不回写/修正模型给的坐标 |

## 3. 五条保底的落点、判据与验证方法

### 保底 1：读不出就退回纯视觉，零开销

- **落点**：`src/cu-uia-probe.ts#probeFrontWindow()` 的**前置判定**（探针本体），开关收敛在一个函数里；
  调用点放在每步观察前的候选生成处（与 `src/assistant-cu-watch.ts:42 CU_PRESET` 同一套「是不是 CU 会话」的判据）；
  失败即 `{ ok: false, reason }`，调用方**直接跳过**②③，不追加任何提示段。
- **不启动的判据（任一命中即整帧退回）**：
  - 前台窗口拿不到（无窗口 / 覆盖层 / 后台会话）；
  - 可交互控件数 `< 3`（自绘、canvas、图片页的典型结果）；
  - 探针耗时 `> 120ms`（超时即放弃，**不重试**）；
  - 控件 rect 合计覆盖屏面 `< 1%`（说明读到的是一堆 0 尺寸节点）。
- **零开销证据**：零候选时 `src/cu-uia-overlay.ts` 直接返回原帧对象（不复制、不编码）；提示段拼接函数在 `candidates.length === 0` 时返回空串（不进模型上下文）。
- **验证**：`scripts/test-cu-uia-probe.mjs`（拟新增）固定 4 个「读不出」样本（自绘扫码页 / 小程序 / 纯图片页 / canvas 画板）→ 断言 `ok=false`、提示段为空、overlay 返回原帧引用（`===`）。

### 保底 2：按页面缓存复用，不每帧重解析

- **落点**：`src/cu-uia-probe.ts` 的页面缓存（内存 Map + 落盘），落盘文件
  `<profile>/dsh-assistant-cu-uia-cache.json`（与 `src/coordinate-mode.ts:25 SETTINGS_FILE` 同目录，取法复用 `src/coordinate-mode.ts:29 profileDir()`）。
- **缓存键**：`进程名 | 窗口类名 | 窗口标题 | 观察面 rect(w×h)`（rect 直接取 `vendor/computer-use/backend-18yEf5Jq.js:1392 windowSurfaceRect` 的同一份几何，保证与截图/点击同一基准）。
- **失效条件**：
  - 页面尺寸/位置变化（键变了自然 miss）；
  - 相邻两帧像素差超阈值（页面确实变了）→ 重解析一次；
  - 保底 3 的 `verifyClick` 返回 `miss`；
  - 缓存文件版本戳不匹配（升级即全清）。
- **节流**：同一页面 **≤1 次/秒** 重解析；命中缓存时不调用探针（`0 ms` 通道）。
- **验证**：`scripts/test-cu-uia-probe.mjs` 断言「同页面连跑 5 帧只探 1 次」、「帧 diff 才触发第 2 次」、「探针调用次数 ≤ 帧数」；`scripts/bench-cu-uia-ab.mjs`（拟新增）里比对总步数只降不升。

### 保底 3：事后校验只比对，不替模型决定

- **落点**：`src/cu-uia-probe.ts#verifyClick()`；`miss` 的唯一后果 = 清该页面缓存 + 标记「UI 已变」，**模型坐标原样执行**。
- **判据**：`clickedPx ∈ rect`（padding 取 `max(4px, rect 短边 × 10%)`）；候选缺失 → `unknown`（不判变、不清缓存）。
- **禁止**：不在校验里改坐标、不重发点击、不吞掉模型的点击（对照 `vendor/computer-use/index.js:1240`：坐标映射与点击语义保持原样）。
- **验证**：`scripts/test-cu-uia-probe.mjs` 断言 `hit/miss/unknown` 三态；`miss` 后缓存被清、下一次调用会重探；构造「模型点偏 200px」样本，断言**工具调用参数与不带通道时逐字节相同**（只多一条文本备注）。

### 保底 4：禁 rollout / Best-of-N

- **落点**：口径写进工具说明与 §5 禁项；代码侧不引入任何「多次尝试再选一个」的循环。
- **检查点**：`vendor/computer-use/index.js` 现无 rollout/重试放大逻辑（`rollout` 全仓 0 命中，`click` 单次派发）；
  新增代码里禁止出现「重复尝试同一动作」的循环（Code Review 项 + 单测断言）。
- **验证**：`scripts/test-cu-uia-probe.mjs` 断言「一次 click 只产生一次动作派发、探针不重试」
  （探针失败 → `ok:false`，不做第二次 UIA 读取）；`scripts/bench-cu-uia-ab.mjs` 断言工具调用数**不高于**关闭通道时。

### 保底 5：同任务新旧各跑一遍实测才准落地

- **落点**：**拟新增** `scripts/bench-cu-uia-ab.mjs`：同一任务脚本跑两遍（`DSH_CU_UIA=0` / `=1`），采集
  ① 工具调用总数 ② 点击次数 ③ 同坐标重复点击 ④ 墙钟耗时 ⑤ 失败重试数 ⑥ 总步数。
- **判据（硬门）**：任一指标比关通道时**变差**（步数 ≥、耗时 > +10%、重复点击 >）→ 该通道默认关，只在设置页允许手动开。
- **基线（2026-11-20 hpg 门店录入实录）**：60.5 分钟 / 116 次工具调用 / 35 次点击 / 11 次同坐标重复点击 / 44 步（39%）耗在辨认悬浮球窗口。
  另可用 `src/desktop-focus.ts` 与观察面口径（`vendor/computer-use/backend-18yEf5Jq.js:1478 selectWindowsObservation`）解释掉「悬浮球吃掉 44 步」这部分后，再比剩余步数。
- **开关**：`src/client/assistant-settings.tsx` 的 CU 面板加「控件树通道」开关，默认**关**；profile 文件
  `<profile>/dsh-assistant-cu-uia.json`（`{"enabled": false}`）与 `src/coordinate-mode.ts` 同款读写口径。

## 4. 验证矩阵（落地时必须逐格有证据）

| 场景 | 通道关（旧） | 通道开（新） | 通过条件 |
| --- | --- | --- | --- |
| 普通网页后台（UIA 可读） | 记录步数/耗时 | 同任务再跑 | 步数不增、耗时 +≤10%、重复点击减少 |
| 自绘 / 小程序 / 图片页 | 记录 | 同任务再跑 | 二者**完全一致**（通道自检不启动，零开销） |
| 页面中途改版 | 记录 | 同任务再跑 | 校验 `miss` → 重解析 1 次后恢复，不出现额外失败步 |
| 长会话（>100 步） | 记录 | 同任务再跑 | 缓存命中率 > 80%，总步数只降不升 |

## 5. 本轮明确不做

- 不改 `vendor/computer-use/**`（含 `index.js`、`backend-18yEf5Jq.js`、`windows-native-B7Ig34Q0.js`）——只读引用；
- 不引入 rollout / Best-of-N / 多次采样投票；
- 不替换或弱化视觉坐标（模型仍是唯一决策者）；
- 不重复设计裁剪局部图与旧帧折叠（已实现）；
- 不动截图尺寸与点击基准链（`captureMaxEdgePx` 现网 1920 见 `docs/cu-pixel-1920-20261125.md`；`vendor/computer-use/index.js:21`、`:47` 的默认值是 1280，由 profile patch 覆盖）。

## 6. 现状事实与证据（只读核对过）

- 工具定义：`vendor/computer-use/index.js:1240` `click`、`:1639` `screenshot`、`:1771` `drag`。
- 抓屏与回喂：`:949 screenshotFileStem`、`:977 pairScreenshotFiles`、`:998 writeDesktopScreenshots`、`:1177 recapture`、`:1202 screenshotIntro`；
  缩放 `vendor/computer-use/windows-native-B7Ig34Q0.js` 的 `downscaleBgra` / `fitCaptureSize` / `resolveCaptureMaxEdge`
  （口径见 `scripts/test-cu-capture-scale.mjs`）。
- 几何基准：`vendor/computer-use/backend-18yEf5Jq.js:120 mapFractionToGlobal`、`:1392 windowSurfaceRect`、`:1478 selectWindowsObservation`
  （口径见 `scripts/test-cu-observation-surface.mjs`：抓屏矩形 == 点击映射矩形）。
- 坐标系：`src/coordinate-mode.ts:25/29/88`（profile 文件与目录取法）、`:119-124`（`assistantCoordinateMode` 服务）、`src/assistant.ts:155`（新会话读它盖戳）。
- CU 会话判据：`src/assistant-cu-watch.ts:42 CU_PRESET`、`src/assistant-dispatch.ts:37 CU_AGENT_PRESET`。
- 回传桥（后台 code agent → CU，串行队列，不带截图）：`src/cu-bridge-core.mjs`。
- 现有 CU 测试：`scripts/test-cu-capture-scale.mjs`、`test-cu-observation-surface.mjs`、`test-cu-bridge.mjs`、`test-cu-code-agent-notice.mjs`、`test-cu-title-bold.mjs`
  ——新通道的测试挂在这套命名习惯下（`test-cu-uia-probe.mjs`、`bench-cu-uia-ab.mjs`）。
