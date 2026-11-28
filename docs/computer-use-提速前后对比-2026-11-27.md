# Computer Use 提速前后对比 + 恢复点与一键回退（2026-11-27）

> 两条硬要求一起写在本文：**提速**（只增不减）与**可回退**（提取失败必须回到改动前的行为）。
> 所有数字都是本机实测（命令与时间戳见各节），没有估算冒充实测；测不出来的部分在 §4 明说。

## 0. 结论先行

| 项 | 值 | 证据/出处 |
| --- | --- | --- |
| **改动前基线 commit** | 第一段 `ebf16ae`（清单 `aef60f0` 的父提交）；**本段（sidecar）另立新基线 `ff877ae`** | `git rev-parse aef60f0^` / `git log --oneline -1 ff877ae` |
| 本轮改动 commit | `aef60f0`（清单）→ `2326629`（核心逻辑+单测/微基准/真机探针）→ `c063bfe`（恢复点+一键回退+演练脚本，package.json 回基线）→ 本报告更新 | `git log --oneline -5` |
| **与基线的差异** | **8 个新增文件 / 现有文件 0 改动** | `node scripts/cu-uia-rollback-drill.mjs` ① 段 |
| **通道默认状态** | **关**（`default-off`） | `resolveChannelSwitch({})` |
| **关通道后 CU 测试** | **6/6 PASS**（5 个既有 + 本通道单测） | 演练脚本 ② 段（`DSH_CU_UIA=0`） |
| 全量脚本 | **95 个：92 通过 / 3 条既有红**（`mobile-proxy`、`secretary-pagination-dom`、`secretary-session-log-write`） | 逐脚本跑全量 |
| 真机 UIA 探针 | **292–611 ms/页**，读到 123 个控件；按 120ms 硬预算 → **一律判「不启动」**（整帧纯视觉） | `cu-uia-live-probe.mjs` |
| 每帧纯 JS 开销 | 有候选 **14.193 µs**；读不出 **0.129 µs**；校验 0.013 µs；记忆 recall 0.204 µs | `bench-cu-uia-core.mjs` |
| 端到端提速（60.5 分钟 → ?） | **未测出**（原因见 §4，不编数字） | §4 |
| push | **无**（只 commit） | 远端未动 |

## 1. 基线（用户提供的 2026-11-20 hpg 门店录入实录，本轮未复测）

总 **60.5 分钟** / **116 次**工具调用 / **35 次**点击 / **11 次**同坐标重复点击 /
**44 步（39%）**耗在辨认悬浮球窗口 / **13.7 分钟**死磕「复制链接」/ **1630×766** 截图被裁成 **72×72** 带偏坐标。

这 7 个数是既有基线，本轮没有重跑（重跑的前提见 §4）。

## 2. 恢复点与一键回退（本轮新增的硬要求）

### 2.1 恢复点

- 基线 = **`ebf16ae`**（"fix(secretary): 更换会话面板按会话标题显示"），即清单提交 `aef60f0` 的父提交。
- 本轮全部改动走**独立 commit**：`aef60f0` → `2326629` → `c063bfe` → 报告更新；**没有 amend、没有 rebase**。
- 现有文件**没有改动**：`package.json` 上一条临时加过测试链，已在 `c063bfe` 里**恢复成基线内容**，
  所以 `git diff ebf16ae HEAD` 现在只剩新增文件（演练脚本 ① 段实测：8 A / 0 M）。

### 2.2 三条回退路径（任选一条，都回到改动前）

```bash
cd D:/dsh-assistant
# 1) 保留历史，反向提交（推荐：不改写历史）
git revert --no-edit 2326629 c063bfe          # 逆向本次两个代码提交
# 2) 直接丢弃本轮全部改动
git checkout ebf16ae -- .                     # 或：git reset --hard ebf16ae
# 3) 只删新增文件 + 关开关（最轻，等价于「通道从未存在过」）
git rm -q --cached $(git diff --name-only ebf16ae HEAD) && rm -f $(git diff --name-only ebf16ae HEAD)
echo '{"enabled": false}' > "$DSH_HOME/profiles/desktop/dsh-assistant-cu-uia.json"   # 或 export DSH_CU_UIA=0
```

关闭开关（**默认就是关**，不需要任何操作）：环境变量 `DSH_CU_UIA=0` → 关；设置页 CU 面板「控件树通道」= 关；
profile 文件 `dsh-assistant-cu-uia.json` 的 `{"enabled": false}`。优先级（安全侧取胜）：
`DSH_CU_UIA=0` > 文件 `enabled=false` > 文件 `enabled=true` > 缺省关；`DSH_CU_UIA=1` 遇上文件 `false` 记作 `conflict-off`（仍然关）。

### 2.3 「提取失败 = 改动前行为」的三条保证（都有单测）

| 保证 | 实现 | 验证 |
| --- | --- | --- |
| 帧不复制、不编码 | `planChannelFrame()` 关/失败时返回 `copyFrame=false`、`marks=[]` | 单测「关通道 = 改动前行为」 |
| 提示段返空 | 同上 `hint=''`（`buildControlHintBlock([])` 也是 `''`） | 同上 + 「不启动时零开销」例 |
| 点击参数逐字节相同 | 通道函数只读不写：`verifyClick()` 不改入参，`pickPoint()` 只在模型没给坐标时才用记忆 | 单测断言 `JSON.stringify(modelPoint)` 前后相等 |

触发「整帧退回」的 5 个判据（任一命中即退回，不重试、不二次读取）：
无前台窗口 / 可交互控件 < 3 / **探针 > 120ms** / 控件 rect 覆盖 < 1% / 探针报错。

### 2.4 关通道后的实测（演练脚本真跑）

`node scripts/cu-uia-rollback-drill.mjs`（`--baseline` 可换基线）：

```
① 与基线比对：新增 8 个文件，现有文件改动 0 个
② 关通道后 CU 测试（DSH_CU_UIA=0）：
   test-cu-capture-scale PASS / test-cu-observation-surface PASS / test-cu-bridge PASS
   test-cu-code-agent-notice PASS / test-cu-title-bold PASS / test-cu-uia-core PASS
③ 回退命令（三条，见 §2.2）
RESULT: PASS
```

## 3. 真机与微基准实测

### 3.1 真机探针（真实 UIA，不是模拟）

`node scripts/cu-uia-live-probe.mjs --repeat 2`（前台 = Chrome PDF 文档页，`Chrome_WidgetWin_1`，1936×1048）：
读到 **123 个控件**，单次 **296–611 ms**（含 PowerShell 5.1 程序集冷启动 ~190ms）。
按 120ms 硬预算 → `不启动(too-slow)` → 这一帧**不画编号、不返清单、不复制帧**（打印原话：
「这一帧不画编号、不返清单：帧原样交给模型（改动前行为）」）。

免视觉定位的证据（同一台机器，早一次运行）：`--find 更多操作` → `Button "更多操作" rect=(1872,133,32,32)`，
中心 **(1888,149)**——这正是 2026-11-20 实录里「更多 1597,110」那类痛点；说明「探针一旦足够快（常驻 sidecar），
候选 rect 可以直接免掉 13.7 分钟的死磕」。

**结论（重要）**：按用户口径的 120ms 预算，实测页面**全部落在退回分支**——通道实际处于「永远不启动」状态，
这是安全侧，也意味着**本轮没有任何提速发生**。要让通道真的跑起来，必须先把探针做成常驻 sidecar（不付进程费），
把 292–611ms 压到 120ms 以内；预算那条线不动。

### 3.2 微基准（纯 JS 部分）

`node scripts/bench-cu-uia-core.mjs`（Node v24.13.0，预热后计时）：

| 项目 | 实测 |
| --- | --- |
| 每帧（有候选：判定+编号+清单） | **14.193 µs**（2000 次，28.4 ms） |
| 每帧（读不出：直接退回） | **0.129 µs**（2000 次，0.3 ms） |
| 每步（事后校验） | **0.013 µs**（20 万次，2.5 ms） |
| 每步（记忆 recall） | **0.204 µs**（20 万次，40.9 ms） |
| 40 帧 / 8 页面 | **8 次探针**，命中率 **80%**，40 帧共 0.20 ms |
| 候选清单体积 | 真机 774 字符；压测（200 控件）682 字符 ≈ 546–682 token/帧 |

### 3.3 旧 vs 新（能对齐的只有这几项）

| 指标 | 旧（2026-11-20 基线） | 新（2026-11-27 本轮实测） | 说明 |
| --- | --- | --- | --- |
| 总耗时 | 60.5 分钟 | **未测出** | 需要接线 + 重启宿主 + 同任务跑两遍（§4） |
| 工具调用 | 116 次 | **未测出** | 同上 |
| 点击次数 | 35 次 | **未测出** | 同上 |
| 同坐标重复点击 | 11 次 | **未测出** | 同上 |
| 辨认页面步数 | 44 步（39%） | **未测出** | 同上 |
| 每帧通道开销 | 0（无通道） | 0.129 µs（关/读不出） / 14.2 µs（开） | 实测，可忽略 |
| 免视觉定位 | 靠猜坐标（13.7 分钟死磕） | 探针给出 rect，center (1888,149) | 实测，但探针 296–611ms 超预算 |
| 关通道后行为差异 | — | 0（8 新增文件，0 现有改动） | 演练脚本实测 |

## 4. 为什么端到端 A/B 仍然给不出来

1. **观察环在 vendor 里且不许改**：每帧喂模型的内容由 `vendor/computer-use/index.js` 的
   `writeDesktopScreenshots()`(:998)、`recapture()`(:1177)、`screenshot`(:1639) 产出；编号图 + 清单只能插在这条链上。
2. **接完还要重启宿主**才生效（本轮没重启，用户长期口径：不擅自重启）。
3. **本会话不是 CU 会话**，无法作为受测体跑同一任务；只读演练的计时不具备可比性，不拿来充当提速数字。

要拿到真数字：① vendor 观察帧出口加可选钩子（或插件侧 observation wrapper）→ ② 重启宿主 →
③ 同一 hpg 只读演练任务跑两遍（`DSH_CU_UIA=0/1`）→ ④ 采集工具调用/点击/同坐标重复/墙钟/重试/总步数 →
⑤ 任一指标变差（步数不降、耗时 +10% 以上、重复点击增多）**就默认关**（门禁照旧，不放宽）。

## 5. 五条保底 → 文件/函数落点

| 保底 | 落点 | 验证 |
| --- | --- | --- |
| ① 读不出自动退回纯视觉、零开销 | `src/cu-uia-core.ts` `decideControlChannel()`（:128 附近）+ `planChannelFrame()`（关/失败 → `useMarks=false / copyFrame=false / hint=''`） | 单测 2 例 + 真机 120ms 预算实测（整帧退回） |
| ② 按页面缓存复用 | `createPageCache()`（TTL 30s、≤8 页、`resolve()` 只在 miss 时探）；键 `pageCacheKey()` | 单测「40 帧同页只探 1 次」；基准 8 页 40 帧 = 8 探针 |
| ③ 校验只比对、不替模型决定 | `verifyClick()` 只回 `hit/miss/unknown`；`pickPoint()` 永远优先模型坐标 | 单测「校验不改入参坐标」「模型坐标逐字节相同」 |
| ④ 禁 rollout / Best-of-N | 无重试放大逻辑；探针失败不重试 | 单测第 4 例；`vendor` 侧 `rollout` 全仓 0 命中 |
| ⑤ 同任务新旧各跑一遍，变差就关 | `bench-cu-uia-core.mjs`（本轮 PASS）+ 端到端门禁待接线；`resolveChannelSwitch` 默认关 | 本轮结论：**关**，等 A/B |

四步方案落点：候选清单 = `buildControlHintBlock()`；编号框锚点 = `planMarks()`（编号 1..40、只留可点角色
`UIA_ACTIONABLE_ROLES`）；事后校验 = `verifyClick()`；坐标复用 = `createActionMemory()` + `pickPoint()`；
探针 = `src/cu-uia-win.ts`（`UIA_PS1_SCRIPT` / `parseUiaProbeJson()` / `probeForeground()`）。
视觉坐标与点击基准：`vendor/computer-use/index.js:1240/:1771`、`src/coordinate-mode.ts`——**一个字没动**。

## 6. vendor/computer-use 只读门槛核查

`src/tuoguan-host.ts:427` 一带的「只读门控」是**托管信号门控**（`installTuoguanGateForSignals`：决定后台
`code_agent` 是否自动应答），**不是文件锁**，不阻止写 vendor 文件。真正拦住「每帧双通道」的是本轮口径
（不许改 vendor）＋观察环物理上不在插件里。本轮 vendor 目录**零改动**，也没有任何绕过尝试。

## 7. 复现命令

```bash
cd D:/dsh-assistant
node scripts/test-cu-uia-core.mjs            # 9/9 通过
node scripts/bench-cu-uia-core.mjs           # 每帧 14.2µs / 8 页 40 帧 8 探针 / PASS
node scripts/cu-uia-live-probe.mjs --repeat 2 --find 更多操作   # 真机 296–611ms、123 控件、120ms→整帧退回
DSH_CU_UIA=0 node scripts/cu-uia-live-probe.mjs                 # 关通道演练（不画编号、不返清单）
node scripts/cu-uia-rollback-drill.mjs       # 恢复点演练：8 新增/0 改 + 6 个 CU 测试 PASS
npm run check                                # EXIT 0（lib 产物未变，本轮没动现有文件）
```

## 8. 既有红（与本次改动无关）

`test-mobile-proxy`、`test-secretary-pagination-dom`、`test-secretary-session-log-write`：改动前就是红的；
本轮新增的 `test-cu-uia-core` 是绿的，全量仍是 92/95。

## 9. 本段续做：常驻 sidecar 把探针压进 120ms（基线 `ff877ae`）

上一段的结论是「探针 296–611ms > 120ms → 永远不启动」。本段按批准范围第 1 步把它压下来，**没有放宽预算线**。

### 9.1 怎么压的

| 手段 | 效果（本机实测，Chrome 前台窗口） |
| --- | --- |
| 常驻进程（程序集只加载一次） | 消掉每次都付的 150–190ms 冷启动 |
| `CacheRequest` + 可点类型 `OrCondition` 批量取缓存（节点 453 → 183，保留 88 个可点控件） | 把「每个控件一次跨进程取属性」换成「一次 FindAll 批量取」 |

### 9.2 实测（`node scripts/cu-uia-sidecar-bench.mjs --runs 12`，2026-11-27T06:33Z）

| 项 | 值 |
| --- | --- |
| sidecar ready | **332 ms**（一次性，程序集加载） |
| 每次往返 | **42 / 43 / 43 / 43 / 44 / 44 / 45 / 46 / 46 / 47 / 48 / 49 ms** |
| p50 / p95 / max | **43 / 49 / 49 ms**（预算 120 ms） |
| 可点控件 | **88 个**（旧一次性进程 123 个原始节点、筛后可点 40 个） |
| 判定 | `可用`（`decideControlChannel` 通过） |
| 结论 | **PASS：p95 49ms < 120ms**，sidecar 站得住；预算线一个字没动 |

开关打开时的完整链路（`DSH_CU_UIA=1 node scripts/cu-uia-live-probe.mjs --sidecar`）：
探针 46ms → 判定可用 → **编号 40 个**、候选清单 **774 字符**、`copyFrame=true`；默认关时同一页面
⇒ 编号 0 个、清单 0 字符、`copyFrame=false`（帧原样，改动前行为）。

### 9.3 接线状态：**仍未接线**（这是本轮没跑 A/B 的直接原因）

- 插件侧**没有**观察帧出口的钩子：每帧喂模型的图 + 文由 `vendor/computer-use/index.js`
  `writeDesktopScreenshots()`(:998) / `recapture()`(:1177) / `screenshot`(:1639) 产出。
- 两条可行路线（都需要额外能力，不是本轮已做的）：
  1. **插件侧 around-dispatch 包装**：宿主 `dsh-tools` 有 around-wrapper 机制，可在工具结果层
     把编号图 + 候选清单附上去；但仍需一个**图像合成器**（在 PNG 上画编号：编码器 + 位图字体），
     这段还没写、也没验证过。
  2. **改 vendor 观察帧出口**：需要在上面 3 个函数里各插一个「可选的帧后处理钩子」；
     按你的口径，动之前必须先逐行报告（本轮没有动，vendor 零改动）。
- 也就是说：**sidecar 达标 ≠ 通道已能影响一次 CU 任务**。通道现在只会「算」，没有「喂」。

### 9.4 A/B 为什么本轮仍然没跑（不编数字）

1. 没接线（9.3）：开着 `DSH_CU_UIA=1` 跑同一任务，模型看到的东西与关着**完全一样**，跑出的数字无意义。
2. A/B 要跑两遍真实 CU 任务（每次 30–60 分钟级），且要在**重启后的宿主**上跑；重启会**杀掉当前这条工作会话**，
   测量必须由外部常驻脚本驱动，不能在本会话里串着做。
3. 我不会把只读演练计时或估算当端到端数字。

**要拿到数字的最小步骤**（按顺序，需你点头）：
① 写图像合成器（编号框画到 PNG 副本）→ ② 插件侧 around-dispatch 包装（或按 9.3 改 vendor 三处，先报行号）→
③ 重启宿主 → ④ 用同一只读演练任务跑 `DSH_CU_UIA=0` 与 `=1` 各一遍，采集 6 项：工具调用数、点击数、
同坐标重复点击数、墙钟耗时、失败重试数、总步数 → ⑤ 任一指标变差（步数不降 / 耗时 +10% / 重复点击增多）→ 默认关。

### 9.5 本段回退与差异

- 本段新基线：**`ff877ae`**；本段新增提交：`b557cde`（sidecar）。
- 与第一段基线 `ebf16ae` 比：仍是 **10 个新增文件 / 现有文件 0 改动**（`node scripts/cu-uia-rollback-drill.mjs` → PASS）。
- 回退照旧：`git revert --no-edit b557cde`，或删新增文件 + 开关关（`DSH_CU_UIA=0` / profile `{"enabled": false}`）。
- 本轮**没有重启宿主**：新产物都是独立模块与脚本（`lib/*` 未变），重启没有可加载的新东西，
  却会中断这条会话，所以在报告落盘前不做。

## 10. 本段续做：编号框合成器 + 插件侧观察帧包装（仍未接线，等确认）

按批准范围，本段只做「让编号图能出现在模型看到的那一帧」的两块代码，**vendor 三处出口一行未动**。

### 10.1 编号框图像合成器（`src/cu-uia-overlay.ts`，新增）

| 项 | 值 |
| --- | --- |
| 依赖 | 只用 `node:zlib`，不引任何原生包（宿主没给 sharp） |
| PNG 支持 | 8 位、非隔行、颜色类型 0/2/3/4/6（含 tRNS 调色板透明）；别的形状抛 `OverlayUnsupportedError` |
| 画法 | 2px 洋红框 + 深色数字底片 + 3×5 点阵数字放大 2 倍（编号 1..40） |
| 实测 | 真实 900×900 截图画 **40 个编号 = 16.6 ms**，产出 34 KB、尺寸不变 |
| 零开销路径 | `drawn=0`（没有可画编号 / 框太小）→ **返回原 buffer 本体**，不复制不编码 |
| 单测 | `scripts/test-cu-uia-overlay.mjs` **7/7 通过**（编解码闭环、框与编号落点、越界裁剪、原帧原样、非法形状、缩放换算、真图 40 编号） |

### 10.2 插件侧观察帧包装（`src/cu-uia-observe.ts`，新增）

依据（宿主源码只读核对）：`@deepseek-ai/dsh-tools` 的执行链是
`tools/pre-execute` → **`tools/execute`（around-dispatch）** → `tools/post-execute` → `tools/result`；
而 `vendor/computer-use` 的 screenshot/click 结果只回 **文件路径**（`paths` / `screens`），
图像在渲染时才从磁盘读。**所以插件侧只要在 around 位把路径换成编号版 PNG，模型看到的就是编号帧，vendor 不用改。**

| 项 | 值 |
| --- | --- |
| 改什么 | 只换 `paths` 与 `screens[].path` → 临时目录 `dsh-cu-marks/` 下的 `.marks.png` 副本 |
| 不改什么 | 不新增字段（宿主 `output.schema` 是 `additionalProperties:false`，加字段会被拒）、**坐标字段一个都不碰**、原帧文件零字节改动（单测用 sha256 比对过） |
| 兜底 | 开关关 / 探针不启动 / 不是 PNG / 画不出编号 / 探针抛异常 / 事件炸了 → **原 result 原样透传**（连新对象都不造） |
| 单测 | `scripts/test-cu-uia-observe.mjs` **5/5 通过**（四种不画、关着同引用、开着换图且原帧不变、非 PNG 透传、around 位注册与异常兜底） |

### 10.3 还差哪一步才真的接上（需要你点头，我没有擅自做）

在插件入口 `src/assistant.ts`（现有文件）加**两行**，然后 `node build.mjs` + 重启宿主：

```ts
import { installCuObservationWrapper } from './cu-uia-observe.ts'
// apply() 里，与其它 install 并列：
installCuObservationWrapper(ctx, { readSwitch: () => resolveChannelSwitch({ env: process.env.DSH_CU_UIA, fileEnabled: readCuUiaFileEnabled(ctx) }) })
```

代价与影响：`src/assistant.ts` 会从「0 改动」变成「+2 行」（回退演练会显示 1 个 M），
所以本段**故意没接**，保持「与基线只差新增文件」的可回退状态。你说接，我再加这两行并重跑演练。

另外两点如实说明：
- 提示段（候选清单文本）**只能换图**这条路还到不了模型上下文：vendored `render()` 从 value 生成文本，
  value 不许加字段；要给文本得走 `tools/post-execute`/`tools/result`，那是下一步。
- 编号图坐标换算用「窗口 rect → 图像尺寸」的 `scale`，接线时要用 vendor 同一份观察面 rect 算（`windowSurfaceRect`），
  这一条在接线那一轮再对一遍，避免缩放对不上。

### 10.4 本段状态与证据

| 项 | 值 |
| --- | --- |
| 本段提交 | `b557cde`（sidecar）、**`537c6e8`（合成器 + 包装）** |
| 本段基线 | `ff877ae` |
| 与第一段基线 `ebf16ae` 差异 | **14 个新增文件 / 现有文件 0 改动**（演练 ① 段实测） |
| 关通道后 CU 测试 | **8/8 PASS**（5 个既有 + core + overlay + observe）——演练 ② 段 |
| 全量脚本 | **97 个：94 通过 / 3 条既有红**（`mobile-proxy`、`pagination-dom`、`session-log-write`） |
| 是否重启宿主 | **否**（按你的口径：写完代码给证据后停下等确认） |
| 是否 push | **否** |
| vendor/computer-use | **零改动**（三处出口 998 / 1177 / 1639 都只是引用，没有一处被改） |

## 11. 接线完成：观察帧编号框挂到 tools/execute（等重启，未跑 A/B）

批准后只做一件事：把观察帧包装挂进插件入口。**vendor/computer-use 三处出口（998 / 1177 / 1639）仍然一行未改。**

### 11.1 改了几行（`src/assistant.ts`：+3 / -0）

```diff
@@ -60,6 +60,7 @@
 export { assistantCuWatchTestSurface } from './assistant-cu-watch'
+import { installCuObservationWrapper } from './cu-uia-observe.ts'
 /** v4 会话日志事务化改写：宿主真实解析器 dry-run + 写入后回读 + 失败回滚 */
@@ -277,6 +278,9 @@
   registerPiece('assistant cu watch', () => registerAssistantCuWatch(ctx))
+  // Computer Use 观察帧编号框（插件侧 around-dispatch，走 tools/execute；默认关，见 docs/…§11）
+  registerPiece('computer use observation', () => installCuObservationWrapper(ctx))
```

其余逻辑全在**新增文件** `src/cu-uia-observe.ts` 里补齐（不占现有文件）：
`readCuUiaSwitch(ctx)`（`DSH_CU_UIA` 优先 → profile 文件 `dsh-assistant-cu-uia.json` 的 `enabled` → 缺省关）、
`createObservationProbe()`（懒起 sidecar，42–49ms/页 + 页面缓存 30s，任何异常回「通道不启动」）。
`registerPiece` 自带 try/catch：包装装不上也只是记一条日志，不影响其它半部。

### 11.2 重建与证据

| 项 | 值 |
| --- | --- |
| 重建 | `node build.mjs` → EXIT 0；`lib/index.js` 重新生成（**+984 行**产物），bundle 里 grep 到 `installCuObservationWrapper` / `tools/execute` |
| `npm run check` | EXIT 0 |
| 单元测试 | `test-cu-uia-core` 9/9、`test-cu-uia-overlay` 7/7、`test-cu-uia-observe` 5/5 |
| 回退演练 | **PASS**：14 个新增文件 + 白名单 2 个（`src/assistant.ts` **+3 行**、`lib/index.js` +984 构建产物） |
| 关通道后 CU 测试 | **8/8 PASS**（`DSH_CU_UIA=0`：capture-scale / observation-surface / bridge / code-agent-notice / title-bold / core / overlay / observe） |
| 全量脚本 | **97 个：94 通过 / 3 条既有红**（`mobile-proxy`、`pagination-dom`、`session-log-write`）——无新增红 |
| 是否重启宿主 | **否**（按口径停下等用户点） |
| 是否跑 A/B | **否**（重启后才可能；本轮按要求不自己跑） |
| 是否 push | **否** |

演练脚本这轮加了白名单口径（`ALLOWED_TOUCHED`）：只允许 `src/assistant.ts` +3 行与构建产物，
白名单外的现有文件改动仍然直接判 FAIL——「只新增文件」这条纪律没有被放宽，只是把这次批准的 3 行登记在案。

### 11.3 提交与回退

| 项 | 值 |
| --- | --- |
| 本段提交 | **`eba493a`**（接线：assistant.ts +3 行 + observe 默认开关/探针 + 重建 lib/index.js + 演练白名单） |
| 本段之前的基线 | `ff877ae` |
| 全轮提交序列 | `aef60f0` → `2326629` → `c063bfe` → `ff877ae` → `b557cde` → `537c6e8` → `d6e5e97` → **`eba493a`** |

回退（任选一条）：

```bash
# 1) 只回退这次接线（保留前面 sidecar/合成器，回到「装好了但没挂」）
git revert --no-edit eba493a
# 2) 整轮回退到第一段基线（等于通道从未存在过）
git checkout ebf16ae -- . && git rm -q --cached $(git diff --name-only --diff-filter=A ebf16ae HEAD) 2>/dev/null
rm -f $(git diff --name-only --diff-filter=A ebf16ae HEAD)     # 删掉 14 个新增文件
# 3) 只关通道（最小动作，不改任何代码）
export DSH_CU_UIA=0        # 或：echo '{"enabled": false}' > <profile>/dsh-assistant-cu-uia.json
```

### 11.4 重启后怎么测（等用户点，我不自己跑）

1. 重启宿主（让 `lib/index.js` 生效）→ 2. `DSH_CU_UIA=0` 跑一遍只读演练任务，记 6 项：
工具调用数 / 点击数 / 同坐标重复点击数 / 墙钟 / 失败重试数 / 总步数 →
3. `DSH_CU_UIA=1` 再跑同一任务一遍，记同样 6 项 → 4. 任一指标变差（步数不降 / 耗时 +10% / 重复点击增多）→ 默认关。

基线仍参照 2026-11-20 hpg 门店录入：60.5 分钟 / 116 工具调用 / 35 点击 / 11 重复点击 / 44 步（39%）耗在辨认悬浮球窗口。
**重启后的两遍真实数字，会把它们填进本文 §12。**

## 12. A/B 端到端实测（2026-11-27 14:55–14:56，重启后真机）

> 只读演练：**没有写任何业务数据**，只点 PDF 缩略图/工具栏并截图；任务两遍完全一致。
> 原始日志与证据帧：`outputs/2026-11-28/`（README-原始记录.md、timeline.json、baseline/、treatment/）。

### 12.1 任务（两遍相同）

`open_app chrome` → `click [87,421]`（左侧「15」缩略图）→ `click [86,620]`（「16」缩略图）→
`click [972,134]`（PDF 工具栏「更多操作」⋮）→ `screenshot`。

### 12.2 六项指标新旧对比（都有时间戳/文件证据）

| 指标 | 基线（通道关 `{"enabled": false}`） | 改动后（通道开 `{"enabled": true}`） |
| --- | --- | --- |
| 工具调用（步） | **5**（open_app + 3 click + screenshot） | **5**（同样 5 步） |
| 点击次数 | **3** | **3** |
| 同坐标重复点击 | **0** | **0** |
| 点击失败重找 | **2**（两次缩略图点击都没跳页，位置打空） | **2**（同坐标、同样没跳页） |
| 每帧读取次数（帧:步） | 5 帧 : 5 步（每步一帧） | 5 帧 : 5 步 |
| 每帧注入词数 | **0** | **0**（只换图、不加文本；输出 schema 禁加字段） |
| UIA 探针耗时 | 不探（**0 ms**） | 实跑无埋点；旁证 sidecar **42–49 ms/次**（不作实跑数字） |
| 编号框命中 / 未命中步数 | 0 / 5 | **命中 1 / 未命中 4**（只有 `screenshot` 在拦截集里；click/open_app 不拦） |
| 模型可见帧是否带编号 | 否（洋红像素 **0**） | **否**（洋红像素 **0**，帧 sha 与基线相同） |
| 端到端墙钟 | **28.934 s**（14:55:05.814 → 14:55:34.748） | **14.901 s**（14:56:19.882 → 14:56:34.783） |
| 任务结果 | 页码仍 **18/24** | 页码仍 **18/24** |

墙钟差异 **不能**当提速：两遍都是 5 步、由模型思考与工具往返主导（n=5），这不是通道带来的收益。

### 12.3 关键发现：编号图没进「模型看到的那一帧」

- 插件侧确实生效了：`screenshot` 的工具结果原话变成
  `Saved screenshot to C::\Users\<ACCOUNT>\AppData\Local\Temp\dsh-cu-marks\0-Screenshot 2026-11-27 at 14.56.34.marks.png`，
  该文件 1920×1032、**23973 个洋红像素**（40 个编号框）——证明探针 + 合成器 + 路径替换这条链是通的。
- 但**我（模型）收到的附件仍是原帧**（sha `678cfeb…`，洋红 0），因为宿主是用自己渲染的窗口截图喂模型，
  不是去读工具 value 里 `paths` 指的文件。也就是说：**换路径只改了落盘位置与剪贴板，没改模型可见像素。**
- 另一个覆盖缺口：拦截集默认只有 `computer_use` / `screenshot` 两个名字，本机实际的逐步工具是
  `click` / `open_app` / `type`…，所以 5 步里只有 1 步进入通道。

### 12.4 门禁判定（按保底 ⑤）

| 判据 | 实测 | 结论 |
| --- | --- | --- |
| 步数是否下降 | 5 → 5 | ❌ 没降 |
| 耗时是否变好 | 墙钟差异是噪声（模型主导），通道本身每次拦截多 40–70ms（探针 42–49 + 合成 16.6） | ❌ 只会更慢 |
| 重复点击是否减少 | 0 → 0 | ❌ 无变化 |
| 模型可见效果 | 帧完全一样 | ❌ 无效 |

**判定：通道保持默认关**（`DSH_CU_UIA=0` / profile `enabled:false` 已恢复）。
它现在是一个「算得对、但喂不到模型眼前」的半成品，按「只增不减」不许开着用。

### 12.5 这一轮暴露的两个真 bug（已留证，未在本轮修）

1. **开关文件 BOM**：用 PowerShell `Set-Content -Encoding utf8`（PS 5.1）写 `{"enabled": true}` 会带 UTF-8 BOM，
   插件的 `JSON.parse` 直接失败 → `fileEnabled=undefined` → 开关判关（14:56:07 那次尝试因此白跑）。
   修法：读的时候先剥 BOM（`raw.replace(/^\uFEFF/, '')`），或文档写明必须无 BOM 写。
2. **喂帧通道选错了层**：只改 `value.paths` 改不到模型可见附件；要让编号进视觉，必须走 `tools/result` /
   内容块的层（把编号图作为 image block 插进去），或者由宿主提供观察帧钩子。

### 12.6 证据清单（时间戳均为 UTC+8）

| 证据 | 路径 | 时间戳 | 关键数字 |
| --- | --- | --- | --- |
| 基线四帧 | `outputs/2026-11-28/baseline/step1..4*.png` | 14:55:11.705 / 17.477 / 21.162 / 30.802 | 洋红 0 |
| 基线 screenshot | `outputs/2026-11-28/baseline/step5-screenshot.png` | 14:55:34.748 | 335383 B，洋红 0 |
| 改动后编号图 | `outputs/2026-11-28/treatment/0-Screenshot 2026-11-27 at 14.56.34.marks.png` | 14:56:34.783 | **23973 洋红像素** |
| 改动后模型可见帧 | `outputs/2026-11-28/treatment/desktop-Screenshot 2026-11-27 at 14.56.34.png` | 14:56:34.783 | 洋红 0（与基线同 sha） |
| 时间线 | `outputs/2026-11-28/timeline.json` | — | 附件 mtime 清单 |
| 原始记录 | `outputs/2026-11-28/README-原始记录.md` | — | 任务、命令、作废尝试 |

开关状态已恢复为 `{"enabled": false}`（通道默认关）；本轮**没有**改任何现有文件（只追加本报告），
`src/assistant.ts` 仍是上一轮批准的 +3 行。

## 13. §12.5 两个真 bug 的修复（代码已就绪；**A/B 待重启后补数字**）

> 状态：代码 / 测试 / 演练已全部跑绿（见 13.3），**宿主尚未重启**，所以本节**没有**新的 A/B 数字，
> 也**不声称**拿到了真数字。重启后按 13.5 的同一任务跑两遍，把 6 项指标填进本节 13.6。

### 13.1 bug ②：喂帧层换到「能改模型可见内容块」的层

| 项 | 内容 |
| --- | --- |
| 旧做法（无效） | `tools/execute` around 位改 value 的 `paths` → 只改了落盘文件与剪贴板（§12.3 实测：编号图 23973 洋红像素，模型可见帧仍 0） |
| 新做法 | `tools/post-execute` 的 `accept` 决策里**替换 content**（宿主 `dsh-tools` `postExecute` 注释原文：「`accept` keeps the call successful (replacing `content` when given)」） |
| 换什么 | image 块的 `attachment`：`attachments.readImage(ref)` → `overlayPng()` 画编号 → `attachments.saveImage({data, mediaType:'image/png', name})` → 用新 ref 替换；末尾再追加候选清单 `text` 块（这就是"每帧注入词数"的来源） |
| 不动什么 | value 里的坐标字段一个不碰（模型坐标原样执行）；vendor/computer-use 零改动；文本块顺序不变，只在末尾追加 |
| 拦截集 | 从 `computer_use`/`screenshot` 扩到 `click / open_app / type / key / hotkey / scroll / drag / move / open / long_press / wait` 等本机逐步工具 |
| 关通道开销 | 只做一次 `switch.enabled` 判断就返回原 decision —— 单测断言 **readImage/saveImage 0 次调用** |
| 兜底 | 探针不启动 / 没控件 / 没有 image 块 / 读不出附件 / 存不进附件 / 不是 PNG → **原 decision 同一引用返回**（不中断 CU） |

文件：**新增** `src/cu-uia-content.ts`（`rewriteContentBlocks()` 纯逻辑 + `installContentWrapper()` + `attachmentIo()` 适配宿主 attachments 服务），
并由 `src/cu-uia-observe.ts` 的 `installCuObservationWrapper()` 同时挂上 `tools/execute` 与 `tools/post-execute` 两处包装
（卸载函数两处都拆，单测有断言）。`src/assistant.ts` **仍是已批准的 +3 行，没有再动**。

### 13.2 bug ①：开关文件 BOM

`readCuUiaFileEnabled()` 先 `.replace(/^\uFEFF/, '')` 再 `JSON.parse`；回归测试写了一个**真的带 UTF-8 BOM** 的开关文件
（首字节 0xEF 断言过），验证 `{"enabled": true}` 读成 `true`、`false` 读成 `false`、非布尔值仍回 `undefined`（交给缺省关）。

### 13.3 本轮测试与演练证据（重启前）

| 项 | 结果 |
| --- | --- |
| `test-cu-uia-content.mjs`（新增） | **6/6 通过**：关通道零 IO、开着换 attachment 且存下的图有洋红像素、五种失败原样返回、拦截集含 click/open_app/type、BOM 回归、两处包装都装都拆 |
| `test-cu-uia-observe.mjs` | **5/5 通过**（原 5 条按事件名取 handler，适配"装两处"） |
| `test-cu-uia-core.mjs` / `test-cu-uia-overlay.mjs` | 9/9 / 7/7 |
| `npm run check` | EXIT 0（`lib/index.js` 含 `tools/post-execute` / `installContentWrapper` / BOM 剥离） |
| 回退演练 | **PASS**：新增文件 16 个 + 白名单 2 个（`src/assistant.ts` +3 行、`lib/index.js` +1153 行构建产物） |
| 关通道 CU 测试 | **9/9 PASS**（`DSH_CU_UIA=0`，capture-scale / observation-surface / bridge / code-agent-notice / title-bold / core / overlay / observe / content） |
| 全量脚本 | **98 个：95 通过 / 3 条既有红**（`mobile-proxy`、`pagination-dom`、`session-log-write`）——无新增红 |
| 提交 | `1389272` fix(cu): 编号框改走 post-execute 内容块层 + 开关文件剥 BOM |

### 13.4 为修演练脚本加的两处口径（不是放宽）（原文如此，见脚本内注释）

- 白名单里 `lib/index.js` 是**构建产物**，行数不设限；`src/assistant.ts` 仍是 **+3 行**上限，超出即 FAIL。
- 同一路径只登记一次（工作区与 HEAD 都有改动时不重复计数），避免"3 个文件"的误报。

### 13.5 重启后要跑的 A/B（与 §12 完全同一任务）

同一任务同一目标 UI（PDF 第 18/24 页）：
`open_app chrome` → `click [87,421]` → `click [86,620]` → `click [972,134]` → `screenshot`。

两遍：① 开关关（profile `{"enabled": false}`，无 BOM）② 开关开（`{"enabled": true}`）。
要取的指标（比 §12 多了"每帧注入词数"和"洋红像素/sha"两列）：
步数、点击数、同坐标重复、点击失败重找、每帧读取次数、每帧注入词数、探针毫秒、编号框命中/未命中步数、端到端墙钟、
**模型可见帧洋红像素数与 sha**。

### 13.6 结果（2026-11-27 15:56–15:57，重启后真机实测）

**新代码已加载的核对**：宿主进程启动 `2026-11-27T15:54:16.076+08:00` > `lib/index.js` 构建 `15:16:16.364`；
构建产物里 `tools/post-execute` ×1、`installContentWrapper` ×2、`\\uFEFF` 剥离 ×1（grep 实测）。

开关 BOM 复验（真机）：PowerShell `Set-Content -Encoding utf8` 写出的文件首字节 `ef bb bf`，
`readCuUiaFileEnabled()` 仍读出 **true**（旧实现这里返回 undefined → 误判关）。

| 指标 | 基线（关 `{"enabled": false}`） | 改动后（开 `{"enabled": true}`） | 变化 |
| --- | --- | --- | --- |
| 步数 / 工具调用 | **5**（open_app + 3 click + screenshot） | **5** | 持平 |
| 点击次数 | **3** | **3** | 持平 |
| 同坐标重复点击 | **0** | **0** | 持平 |
| 点击失败重找 | **2**（两次缩略图点击没跳页，页码始终 18/24） | **2**（同坐标、同样没跳页） | 持平 |
| 每帧读取次数（帧:步） | 5 : 5 | 5 : 5 | 持平 |
| **每帧注入词数** | **0 字符** | **774 字符 / 17 行**（`outputs/2026-11-28/hint-block-received.txt`，模型实际收到的 text 块原文） | **增加** |
| UIA 探针毫秒 | 0（不探） | 本次运行**未埋点**（无计数器）；sidecar 独立基准 42–49 ms/次属旁证，**不当实跑数字** | 增加（未量化） |
| 编号框命中 / 未命中步数 | **0 / 5** | **5 / 0**（5 帧全部带编号） | 命中率 0 → 100% |
| 端到端墙钟 | **14.383 s**（15:56:54.599 → 15:57:08.982） | **20.373 s**（15:57:11.920 → 15:57:32.293） | 慢 5.990 s（模型思考主导，未归因） |
| **模型可见帧洋红像素** | **0**（4 个唯一 sha：`f0b48d1d…`/`ffcde4d2…`/`f75d2f6f…`/`678cfeba…`） | **23843**（3 个唯一 sha：`2c6c53f9…`/`2ad37986…`/`a674bf2e…`） | **编号真的进了模型看到的那一帧** |
| 任务结果 | 页码 18/24 未变 | 页码 18/24 未变 | 持平 |

**模型可见帧实证**（本轮验收关键项，已用像素统计而不是落盘文件代替）：

| 步骤 | 基线 sha / 洋红 | 改动后 sha / 洋红 |
| --- | --- | --- |
| open_app | `f0b48d1d2712…` / **0** | `2c6c53f966a1…` / **23843** |
| click A（[87,421]） | `ffcde4d26268…` / **0** | `2ad37986e5c2…` / **23843** |
| click B（[86,620]） | `f75d2f6fa53a…` / **0** | `a674bf2e3e08…` / **23843** |
| click C（[972,134]） | `678cfebabce1…` / **0** | `2c6c53f966a1…` / **23843** |
| screenshot | `678cfebabce1…` / **0** | `2c6c53f966a1…` / **23843** |

证据文件：`outputs/2026-11-28/visible/*.png`（按步骤命名，就是那几帧模型输入）、
`outputs/2026-11-28/visible-frames.json`（sha + 洋红像素计数）、`outputs/2026-11-28/hint-block-received.txt`（注入的 17 行清单原文）。

### 13.7 门禁判定（按「任一指标劣于基线就关」）

| 判据 | 实测 | 结论 |
| --- | --- | --- |
| 编号是否真进模型可见帧（本轮验收目标） | 5/5 帧洋红 23843，sha 与基线完全不同 | ✅ **达成** |
| 步数是否下降 | 5 → 5 | ❌ 无改善 |
| 点击 / 同坐标重复 / 失败重找 | 3 / 0 / 2 → 3 / 0 / 2 | ❌ 无改善 |
| 每帧注入词数 | 0 → 774 字符 | ❌ 变差（新增上下文成本） |
| UIA 探针耗时 | 0 → 每帧多一次探针（本次未埋点） | ❌ 变差（未量化） |
| 端到端墙钟 | 14.383 s → 20.373 s | ❌ 未变好 |

**判定：编号通道效果已达成，但按只增不减的硬门禁仍保持默认关**（`{"enabled": false}` 已写回，实测 `fileEnabled=false`）。
它现在是「能用、看得见、但每帧要多花一次探针 + 774 字符清单」的形态；要开必须由用户显式放宽门禁或先证明步数收益。

**下一步的收益点（不改口径也能做）**：把清单压到只列「本屏可视区 + 可点角色 + 名字非空」的前 8–12 条（预计 < 300 字符），
并把探针结果按页面缓存（已有 `createPageCache`）接进 post-execute 路径——那两条做完再跑同一 A/B，才可能把「注入词数/探针」这两项拉到不劣于基线。
（旧的「待补」空表已移除；本轮结果见 §14。）

## 14. §13.7 两条收益点落地（代码 + 证据；**A/B 待重启**）

> 状态：代码 / 测试 / 演练已跑绿（14.1–14.3），宿主已于 16:04:26 重启并核对加载；A/B 已按 14.4 跑完（基线两遍 + 改动后一遍），结果见 14.5。
> 重启后按 14.4 跑新旧各一遍，把 10 项指标填进 14.5。**不提前声称拿到真数字。**

### 14.1 ① 候选清单瘦身（774 字符 / 17 行 → 297 字符 / 8 行）

| 项 | 实现 |
| --- | --- |
| 只列本屏可视区 | `onscreenMarks(marks, windowRect)`：rect 与观察面求交集，交集为空就丢掉 |
| 只列可点角色 + 名字非空 | 复用 `UIA_ACTIONABLE_ROLES` 与 `planMarks()`；名字为空的直接跳过 |
| 前 8 条 + 双上限 | `buildSlimControlHint()`：`maxItems=8`、`maxChars=300`、名字截 18 字符，超限即停 |
| 图不瘦身 | 编号框仍按**全部**可点控件画（`planMarks` 不变），只有文本清单变短 |
| 实测（同一样本） | **17 行 / 774 字符 → 8 行 / 297 字符**（`test-cu-uia-slim` 打印的真实数字） |

### 14.2 ② 探针接进 post-execute + 实跑埋点

| 项 | 实现 |
| --- | --- |
| 页面缓存 | `createObservationProbe()` 内的 `createPageCache`（TTL 30s、≤8 页）；同页命中不重探 |
| 同页每秒 ≤1 次 | 新增 `minIntervalMs=1000` 节流：1 秒内直接吃上次结果，**probeMs 记 0** |
| 冷启动不算预算 | 首帧前先 `await sidecar.probe(1)` 预热并丢弃（实测冷启动 ~380ms），之后才开始计时（实测首探 **45ms**） |
| 埋点 | 新增 `src/cu-uia-metrics.ts`：通道**开**时每次拦截追加一行 JSONL 到 `%TEMP%\dsh-cu-marks\metrics-<日期>.jsonl`；字段含 `at/tool/page/probed/probeMs/hintChars/hintLines/replaced/drawn/overlayMs/decision`；**关通道时一次 IO 都不发生** |

### 14.3 本轮测试与演练（重启前）

| 项 | 结果 |
| --- | --- |
| `test-cu-uia-slim.mjs`（新增） | **4/4**：瘦身 ≤8 行 <300 字符且名字非空、可视区过滤（框不受影响）、双上限、节流（首次 probed=true 45ms / 第二次 probed=false 0ms） |
| 其余 CU 单测 | content 6/6、observe 5/5、core 9/9、overlay 7/7 |
| `npm run check` | EXIT 0 |
| 回退演练 | **PASS**（新增文件 + 白名单仅 `src/assistant.ts` +3、`lib/index.js` 构建产物） |
| 关通道 CU 测试 | **10/10 PASS** |
| 全量脚本 | **99 个：96 通过 / 3 条既有红**（`mobile-proxy`、`pagination-dom`、`session-log-write`）——无新增红 |
| 提交 | `1613e5b`（瘦身 + 缓存/节流 + 埋点） |
| 另 | 已清掉 §13.6 末尾那段残留的「待补」空表 |

### 14.4 重启后要跑的 A/B（与 §13.5 完全同一任务同一 UI）

`open_app chrome` → `click [87,421]` → `click [86,620]` → `click [972,134]` → `screenshot`；
两遍：① `{"enabled": false}` ② `{"enabled": true}`（均无 BOM 写入）。

取 10 项：步数、点击数、同坐标重复、失败重找、每帧读取次数、**每帧注入词数（字符数+行数）**、
**探针毫秒（取埋点 JSONL 的 probeMs 实跑值）**、编号命中/未命中步数、端到端墙钟（起止时间戳）、
**模型可见帧洋红像素数与 sha**。

### 14.5 结果

### 14.5 结果（2026-11-27 16:09–16:11，宿主重启后真机实测）

**加载核对**：宿主主进程启动 `2026-11-27 16:04:26`（PID 25836/41288/25704/46992/59672） > `lib/index.js` 构建 `16:00:55`（600466 B；junction `…node_modules\dsh-assistant` → `D:\dsh-assistant`，同一文件）。构建产物 grep 实到：`buildSlimControlHint` ×2、`onscreenMarks` ×2、`createPageCache` ×2、`recordMetrics` ×2、`dsh-cu-marks` ×2、`UIA_HINT_SLIM_CHARS` ×2、`installContentWrapper` ×2、`installCuObservationWrapper` ×2、`tools/post-execute` ×1。开关文件字节实测无 BOM：关 = `7b 22 65 … 66 61 6c 73 65 7d`（`{"enabled": false}`）、开 = `7b 22 65 … 74 72 75 65 7d`（`{"enabled": true}`）。

同一任务同一目标 UI（Chrome PDF 页码 **18 / 24**，缩略图面板打开）：`open_app chrome` → `click [87,421]` → `click [86,620]` → `click [972,134]` → `screenshot`。基线跑两遍（B1 分块计时；B2 与改动后同为单块连发口径），改动后跑一遍（T）。

| 指标 | 基线（关 `{"enabled": false}`） | 改动后（开 `{"enabled": true}`） | 变化 |
| --- | --- | --- | --- |
| ① 步数 / 工具调用 | **5**（open_app + 3 click + screenshot，B1 与 B2 同） | **5** | 持平 |
| ② 点击次数 | **3** | **3** | 持平 |
| ③ 同坐标重复点击 | **0** | **0** | 持平 |
| ④ 点击失败重找 | **2**（[167,434] 与 [165,640] 两次缩略图点击都没跳页，页码始终 18/24） | **2**（同坐标、同样没跳页） | 持平 |
| ⑤ 每帧读取次数（帧 : 步） | **5 : 5** | **5 : 5** | 持平 |
| ⑥ 每帧注入词数（模型实际收到的 text 块原文） | **0 字符 / 0 行** | **287 字符 / 6 行**（每帧同一份，5 帧合计 1435 字符）——`outputs/2026-11-28/r2/hint-block-received.txt` 逐字核对 287 字符 / 6 行，与埋点 `hintChars:287 hintLines:6` 一致 | 仍**劣于基线**（0 → 287）；相对 §13.6 的 774 字符 / 17 行降 63% 字符 / 65% 行，落在 <300 字符 / ≤8 行目标内 |
| ⑦ UIA 探针毫秒（埋点 JSONL 实跑值） | **0**（不探） | **44 / 48 / 52 / 63 / 0**：前 4 步各实探一次，第 5 步同页命中缓存被节流（`probeMs:0`）；4 次实探合计 **207 ms**，最大 63 ms < 120 ms 预算 | 仍**劣于基线**（0 → 207 ms），但已量化、在预算内且同页不重探 |
| ⑧ 编号框命中 / 未命中步数（按「帧带编号」口径） | **0 / 5** | **5 / 5**（每帧 `drawn:40`、`replaced:1`） | **变好** |
| ⑨ 端到端墙钟（起止时间戳） | B2 **7.337 s**（16:11:01.951 → 16:11:09.288）；B1 **52.216 s**（16:09:32.517 → 16:10:24.733，中间含一次模型思考回合，口径不同） | **7.617 s**（16:11:30.749 → 16:11:38.366） | 同口径比 B2 **慢 0.280 s（+3.8%）**，未变好 |
| ⑩ 模型可见帧洋红像素数与 sha | **0**（B1 四个唯一 sha：`d58818c1…`/`ffcde4d2…`/`f75d2f6f…`/`678cfeba…`；B2 三个唯一：`678cfeba…`/`ffcde4d2…`/`f75d2f6f…`） | **23843**（三个唯一 sha：`2c6c53f9…`/`2ad37986…`/`a674bf2e…`，均 1920×1032） | **变好**（编号真的进了模型看到的那一帧） |
| 任务结果 | 页码 18/24 未变 | 页码 18/24 未变 | 持平 |

**通道自身开销（同一轮埋点直接相加）**：探针 207 ms + 编码合成 `overlayMs` 120/106/105/121/119 = **471 ms** → 5 步合计 **678 ms**，均 **136 ms/步**。

**模型可见帧实证**（像素统计打在宿主附件对象上，不是落盘编号图）：

| 步骤 | 基线 B2 sha / 洋红 | 改动后 sha / 洋红 |
| --- | --- | --- |
| open_app | `678cfebabce1…` / **0** | `2c6c53f966a1…` / **23843** |
| click A（[87,421] → 167,434） | `ffcde4d26268…` / **0** | `2ad37986e5c2…` / **23843** |
| click B（[86,620] → 165,640） | `f75d2f6fa53a…` / **0** | `a674bf2e3e08…` / **23843** |
| click C（[972,134] → 1866,138） | `678cfebabce1…` / **0** | `2c6c53f966a1…` / **23843** |
| screenshot | `678cfebabce1…` / **0** | `2c6c53f966a1…` / **23843** |

两遍基线的帧与 §12/§13 的基线帧**逐字节同 sha**（`ffcde4d2…`/`f75d2f6f…`/`678cfeba…`）；改动后的帧与 §13.6 的改动后帧**逐字节同 sha**（`2c6c53f9…`/`2ad37986…`/`a674bf2e…`）——印证「图不瘦身、只有文本清单变短」：编号图未变，清单从 774 字符缩到 287 字符。

**埋点实跑原文**（`%TEMP%\dsh-cu-marks\metrics-2026-11-27.jsonl`，UTC；本机 = UTC+8）：

```
16:11:34.322 open_app   probed=true  probeMs=44  hint=287字符/6行 replaced=1 drawn=40 overlayMs=120 decision=ok
16:11:35.374 click      probed=true  probeMs=48  hint=287/6 replaced=1 drawn=40 overlayMs=106 decision=ok
16:11:36.446 click      probed=true  probeMs=52  hint=287/6 replaced=1 drawn=40 overlayMs=105 decision=ok
16:11:37.543 click      probed=true  probeMs=63  hint=287/6 replaced=1 drawn=40 overlayMs=121 decision=ok
16:11:38.115 screenshot probed=false probeMs=0   hint=287/6 replaced=1 drawn=40 overlayMs=119 decision=ok
```

页面键 `Chrome_WidgetWin_1|材料力学…手册….pdf - Google Chrome|1936x1048` 五帧相同；前 4 次实探相邻间隔 1.05 / 1.07 / 1.10 s（**同页每秒 ≤1** 成立），第 5 次距上次 0.572 s → 吃缓存 `probeMs=0`。冷启动 sidecar 预热不计时（首探即 44 ms，不是 380 ms）。本轮之前的 6 行是单测写盘留下的（`page:""`、`hintChars:90`），与本次 A/B 的 5 行分开取用；关通道后一次 IO 都不发生（关闭那段时间未新增行）。

**口径说明**：`decision:ok` 是通道决策字段，不是点击命中判定；`verifyClick()` 的事后校验这一轮**没有**接进实跑埋点，所以第 ⑧ 项按「帧是否带编号」计数，不冒充坐标级命中率。

### 14.6 门禁判定（不放宽）

| 判据 | 实测 | 结论 |
| --- | --- | --- |
| 步数 / 点击 / 同坐标重复 / 失败重找 / 帧:步 / 任务结果 | 5 / 3 / 0 / 2 / 5:5 / 页码未变 → 完全相同 | 持平（6 项） |
| 编号进模型可见帧 | 洋红 0 → 23843；带编号帧 0/5 → 5/5 | **变好**（2 项） |
| 每帧注入词数 | 0 → 287 字符 / 6 行 | **劣于基线**（虽比上轮 774/17 降 63%/65%） |
| UIA 探针毫秒 | 0 → 207 ms / 4 次实探（最大 63 ms，在 120 ms 预算内） | **劣于基线** |
| 端到端墙钟（同口径 B2） | 7.337 s → 7.617 s | **劣于基线**（慢 0.280 s） |

**判定：通道保持默认关。** 按「只增不减」硬门禁，注入词数、探针、墙钟三项任一劣于基线就不开——本轮三项都在劣于，所以不开；开关已写回 `{"enabled": false}`（无 BOM）。相对 §13.6 的进步是真的：清单 774 → 287 字符、探针从「未量化」变成「4 次实探 44–63 ms 且同页不重探」、编号进帧的实证复现（23843 洋红 / 5 帧全部带框）。要开必须用户显式放宽门禁，或由步数收益先证明（本轮步数一点没降）。

### 14.7 关通道后的回退与测试证据

- 开关字节复验：`7b 22 65 6e 61 62 6c 65 64 22 3a 66 61 6c 73 65 7d`（无 BOM，`enabled:false`）。
- 回退演练 **PASS**：新增文件 16 个；现有文件改动 2 个且全在白名单（`src/assistant.ts` +3 行、`lib/index.js` +1266 行构建产物）；`git status --porcelain -uno` 对已跟踪文件为空。
- 关通道 CU 测试 **10/10 PASS**（capture-scale / observation-surface / bridge / code-agent-notice / title-bold / uia-core / uia-overlay / uia-observe / uia-content / uia-slim）。
- 全量脚本 **99 个：96 通过 / 3 条既有红**（`test-mobile-proxy`、`test-secretary-pagination-dom`、`test-secretary-session-log-write`）——**无新增红**。
- 证据文件（按仓库约定不入库）：`outputs/2026-11-28/r2/baseline/`、`outputs/2026-11-28/r2/treatment/`、`outputs/2026-11-28/r2/hint-block-received.txt`、`outputs/2026-11-28/r2/metrics-live-5steps.jsonl`；计数与开关助手脚本在 `.tmp/`。

## 15. 多案例 A/B（5 案例 × 开关两态，10 项指标）

### 15.1 案例与口径

本轮计划 5 个案例，**实际只跑成 4 个**：案例⑤（微信）未执行——本机没有微信进程，全局热键 `Ctrl+Alt+W` 连按 2 次 + 等待 10 s 都没有窗口唤出，按用户选择跳过，**没有为它编任何数字**。

全程**只读演练**：无保存、无提交、无发送、无花钱、无远端改动。

统一协议（每案例开关两态各跑 1 次）：同一个工具块内「`pwsh` 起始时间戳 → 5 个计数步 → `pwsh` 结束时间戳」，埋点收割另做（放在被测块之外，不混进步数）。

每案例的 **UI 复位点击不计入这 5 步**，两态同口径：① 用探针实测 tab #7 `rect=(796,0,146,41)` → 中心 `(869,20)` → 跳回分数页 `[453,19]`；② 用 `open_in_browser` 加载 bing 首页。

开关用 `.tmp/set-uia-switch.mjs` 写 `C::\Users\<ACCOUNT>\.dsh\profiles\desktop\dsh-assistant-cu-uia.json`（`{"enabled": true/false}`，无 BOM）。

埋点文件 `C::\Users\<ACCOUNT>\AppData\Local\Temp\dsh-cu-marks\metrics-2026-11-27.jsonl`：本轮起点 **15 行 → 终点 46 行**，其中 **④ 的 5 步贡献 0 行**。另注：本轮开始前有 6 行 `page` 键为空的合成测试行 + §14.5 的 5 行，全部按时间戳过滤后才取用本轮区间。

10 项指标口径（顺序固定）：① 步数 / ② 点击数 / ③ 同坐标重复 / ④ 点击未命中 / ⑤ 每帧读取 / ⑥ 注入字符与行 / ⑦ 探针毫秒 / ⑧ 编号命中与未命中 / ⑨ 墙钟 / ⑩ 模型可见帧 sha 与洋红像素；开通道另附「叠框毫秒」「通道自身」两项辅助值。时间戳一律 UTC+8。

### 15.2 逐案例数据表

#### 案例①（Chrome PDF 手册，第 18/24 页缩略图翻页）

窗口 `Chrome_WidgetWin_1`，1920×1032；5 步 = `open_app chrome` + 点击 `[87,421]` / `[86,620]` / `[972,134]` + `screenshot`。

| # | 指标 | 关通道 | 开通道 |
| --- | --- | --- | --- |
| ① | 步数 | 5 | 5 |
| ② | 点击数 | 3 | 3 |
| ③ | 同坐标重复 | 0 | 0 |
| ④ | 点击未命中 | 2（末次点击未跳页，页仍 18/24） | 2 |
| ⑤ | 每帧读取 | 5:5 | 5:5 |
| ⑥ | 注入 | 0 字符 / 0 行 | 1430 字符 / 30 行（每帧 286 字符 / 6 行，slim 上限 8 项 / 300 字未触顶） |
| ⑦ | 探针 | 未执行（开关关、判定前返回） | 4 次 66 / 69 / 71 / 65 ms 共 271 ms（末步同页节流 0 ms，最大 71 ≤ 120 预算） |
| ⑧ | 编号命中 | 0 步命中 / 5 步未命中 | 5 步命中（drawn 40、replaced 1）/ 0 步未命中 |
| ⑨ | 墙钟 | 4.088 s（18:09:22.276 → 18:09:26.364） | 4.993 s（18:03:20.586 → 18:03:25.579），Δ +0.905 s（+22.1%） |
| ⑩ | 模型可见帧 | 4 个 sha 全 0 洋红：`5bb1a58b` / `614148ca` / `13386ef1` / `b81468ad` | 4 个 sha 每个 18389 洋红：`c59c3bd2` / `c6fa0121` / `d273a555` / `d98a75a1` |
| 附 | 叠框 | —（未启动） | `overlayMs` 116 / 111 / 113 / 111 / 115 共 566 ms |
| 附 | 通道自身 | — | 271 + 566 = 831 ms / 5 步（平均 166 ms/步） |

#### 案例②（浏览器只读网页：必应首页）

URL `https://www.bing.com`，窗口 `Chrome_WidgetWin_1`，1920×1032；5 步同上口径（聚焦搜索框**不输入不提交** + 图片/视频导航点击）。

| # | 指标 | 关通道 | 开通道 |
| --- | --- | --- | --- |
| ① | 步数 | 5 | 5 |
| ② | 点击数 | 3 | 3 |
| ③ | 同坐标重复 | 0 | 0 |
| ④ | 点击未命中 | 0 | 0 |
| ⑤ | 每帧读取 | 5:5 | 5:5 |
| ⑥ | 注入 | 0 字符 / 0 行 | 1430 字符 / 30 行 |
| ⑦ | 探针 | 未执行 | 4 次 106 / 119 / 110 / 80 ms 共 415 ms（末步节流 0，最大 119 ≤ 120 预算，已贴近上限） |
| ⑧ | 编号命中 | 0 步命中 / 5 步未命中 | 5 步命中 / 0 步未命中 |
| ⑨ | 墙钟 | 4.495 s（18:09:38.548 → 18:09:43.043） | 6.042 s（18:03:39.777 → 18:03:45.819），Δ +1.547 s（+34.4%） |
| ⑩ | 模型可见帧 | 5 个 sha 全 0 洋红：`589434f5` / `80fce921` / `015b3199` / `a917e5ad` / `4787bc2a` | 5 个 sha 每个 16304 洋红：`8f648a87` / `e414cccb` / `d4c16afb` / `07980c2c` / `f63b7656` |
| 附 | 叠框 | — | `overlayMs` 254 / 207 / 259 / 150 / 141 共 1011 ms |
| 附 | 通道自身 | — | 415 + 1011 = 1426 ms / 5 步（平均 285 ms/步） |

页面缓存跨页时重新探针：`page` 键从「搜索 - Microsoft 必应」（3 步）变到「世界旅游胜地 - 搜索 视频」（2 步）。

#### 案例③（文件管理器窗口：360FileBrowser64 打开 `D:\dsh-assistant\docs`）

窗口 `class=360ExplorerFrame`，1080×694；探针实测 95 控件 / 29 ms → 判定可用；5 步 = `open_in_finder` + 点击 3 个文件行 `[327,328]` / `[330,366]` / `[327,403]` + `screenshot`。

| # | 指标 | 关通道 | 开通道 |
| --- | --- | --- | --- |
| ① | 步数 | 5 | 5（但只有 4 步被拦截：`open_in_finder` 不在 `CU_OBSERVATION_TOOLS` 里，它的帧 magenta=0 实测证实） |
| ② | 点击数 | 3 | 3 |
| ③ | 同坐标重复 | 0 | 0 |
| ④ | 点击未命中 | 0（3 次点击逐帧核过，末次选中 `cu-pixel-1920` 行） | 0 |
| ⑤ | 每帧读取 | 4（第 5 步 `screenshot` 工具因剪贴板被占用报错 1 次，该步未送帧，未重试） | 5 |
| ⑥ | 注入 | 0 字符 / 0 行 | 1196 字符 / 32 行（每帧 299 字符 / 8 行，正好顶到 slim 上限 8 项 / 300 字） |
| ⑦ | 探针 | 未执行 | 2 次 49 / 48 ms 共 97 ms（另 2 步同页节流 0，最大 49 ≤ 120） |
| ⑧ | 编号命中 | 0 步命中 / 5 步未命中 | 4 步命中 / 0 步未命中 |
| ⑨ | 墙钟 | 4.968 s（18:08:09.788 → 18:08:14.756） | 4.203 s（18:03:54.275 → 18:03:58.478），Δ −0.765 s（−15.4%） |
| ⑩ | 模型可见帧 | 4 个 sha 全 0 洋红：`6975f17b` / `8d915d27` / `b5d02556` / `32bf759a` | `openfinder e19468a1` 洋红 0；`click` `6690459d` / `45c73de8` / `27c916ff` 每个 38984 洋红 |
| 附 | 叠框 | — | `overlayMs` 50 / 60 / 48 / 49 共 207 ms |
| 附 | 通道自身 | — | 97 + 207 = 304 ms / 5 步（平均 61 ms/步） |

⚠️ ③ 是 4 例里唯一「墙钟更短」的一例，但差值小于单步抖动（同一 `off` 跑末步报错、`on` 跑末步正常），**不许把它算作编号通道的功劳**。

③ 的编号命中的是**真实可点控件**（文件行 + 列头 `SplitButton`：名称 / 修改日期 / 类型 / 大小，清单里 `rect=(896,346,272,27)` 等）。

#### 案例④（UIA 读不出的自绘窗口：Everything）

窗口 `class=EVERYTHING`，1048×581，自绘文件列表；5 步 = `open_app Everything` + 点击 `[106,186]` / `[106,226]` / `[106,267]` + `screenshot`，3 次点击都命中列表行、末次选中 `02-中国交通运输科技进步一等奖.pdf`。

| # | 指标 | 关通道 | 开通道 |
| --- | --- | --- | --- |
| ① | 步数 | 5 | 5 |
| ② | 点击数 | 3 | 3 |
| ③ | 同坐标重复 | 0 | 0 |
| ④ | 点击未命中 | 0 | 0 |
| ⑤ | 每帧读取 | 5:5 | 5 |
| ⑥ | 注入 | 0 字符 / 0 行 | 0 字符 / 0 行 |
| ⑦ | 探针 | 未执行 | 探针仍发出（成本未写进行内） |
| ⑧ | 编号命中 | 0 步命中 / 5 步未命中 | 0 步命中 / 5 步未命中 |
| ⑨ | 墙钟 | 3.789 s（18:08:32.823 → 18:08:36.612） | 3.823 s（18:04:12.978 → 18:04:16.801），Δ +0.034 s（+0.9%，小于单步抖动，等于没变） |
| ⑩ | 模型可见帧 | 4 个 sha 全 0 洋红：`7c7805c0` / `630d8e45` / `aecedfd6` / `93bc15e0` | 4 个 sha 全 0 洋红：`0ea02d70` / `ad0808ec` / `45fa249e` / `cafd6b20` → 与关通道帧一样是纯视觉原帧 |
| 附 | 埋点 JSONL | 无新增行 | **新增 0 行**（跑前 46 行、跑后 46 行；整份文件里没有任何 `EVERYTHING` 的 `page` 键） |

「判不启动」这条分支不写埋点行的原因（代码口径，写死在本报告里）：`src/cu-uia-content.ts` 的 `installContentWrapper` 处理器在第 145 行 `if (sample.decision.enabled !== true) return decision` 提前返回，早于第 160 行的 `recordMetrics`——所以这条分支不写行；但**探针本身仍会发出**（成本未写进行内，**不能声称零成本探针**）。

旁证（不是埋点、只用于说明判定原因，不参与 `probeMs` 统计）：`scripts/cu-uia-live-probe.mjs --sidecar` 实测该窗口：`class=EVERYTHING` `rect=1048x581@(70,146)`，控件 0 个，`ok=false`，`error=no-controls`，探针判定 = 不启动(error)，2 ms；页面缓存键 `EVERYTHING|科技进步 - Everything|1048x581`；打印「这一帧不画编号、不返清单：帧原样交给模型（改动前行为）」「按第 ①/③ 条硬约束：这一帧整段跳过候选清单与编号框，退回纯视觉（零开销，点击参数与改动前逐字节相同）」。

**结论行**：硬约束「UIA 读不出 → 编号通道自动不启动、整帧退回纯视觉」在 ④ 真实生效（有 JSONL 无行 + 帧 sha 全 0 洋红 + 墙钟差 0.034 s 三重证据），但「零开销」只对清单/编号/叠帧成立，**探针仍发出且该分支不埋点**。

### 15.3 判定与门禁

新增成本（4 例两态，按 ①②③④ 顺序）：

| 指标 | 关通道 | 开通道 |
| --- | --- | --- |
| 注入字符 / 行 | 0 | 1430 / 1430 / 1196 / 0 |
| 探针毫秒 | 0 | 271 / 415 / 97 / 0 |
| 叠框毫秒 | 0 | 566 / 1011 / 207 / 0 |

墙钟：① **+0.905 s**、② **+1.547 s**、④ **+0.034 s**、③ **−0.765 s**（在单步抖动内，且 `off` 跑末步报错）。

步数 / 点击数 / 同坐标重复 / 点击未命中：4 例两态**全平**——5/5、3/3、0/0、未命中 ① 2:2、②③④ 0:0。编号命中：①②③ **5:5、5:5、4:4** 帧全命中，④ **0:5**。

**门禁结论**：任何指标劣于基线 ⇒ 通道保持默认关，本轮判定**维持默认关**，`DSH_CU_UIA` 与 profile 文件都保持关闭（`UIA_PROBE_BUDGET_MS=120` 不放宽）。② 单步探针 119 ms 已贴预算上限，浏览器窗口是最接近超预算的场景。

短板发现：①② 的 40 个编号只覆盖 Chrome 窗口外壳（标签 / 工具栏 / 书签栏 / 窗口按钮），PDF 渲染文本与必应页面本体（搜索框、导航、结果卡片）不在 UIA 树里 → 编号命中了外壳但**没有命中任务真正要点的元素**，浏览器场景下编号通道实际帮不上；只有 ③ 这类原生控件树可读的窗口，编号才命中真目标。

### 15.4 证据落盘位置

- `D:\dsh-assistant\outputs\2026-11-28\r3\case1-off`、`case1-on`、`case2-off`、`case2-on`、`case3-off`、`case3-on`、`case4-off`、`case4-on`：34 张模型可见帧 PNG，文件名 `01-openapp` / `02-clickA` / `03-clickB` / `04-clickC-shot` / `05-shot`，sha 前缀写在文件名和本报告里。
- `outputs\2026-11-28\r3\metrics-live-2026-11-27.jsonl`：46 行整份快照。
- `outputs\2026-11-28\r3\metrics-slice-before-c1on.jsonl`：16 行起点快照。
- `outputs\2026-11-28\r3\case1-on\metrics-after-c1on.jsonl`。
- `outputs\` 不提交（仓库约定）。
## 16. 回退记录（编号通道全撤，回到 ebf16ae 基线代码）

### 16.1 判定理由

§15 的 4 案例两态实测把编号通道判为**无收益**，三条证据都在：

1. 墙钟：4 例里 **3 例开通道更长** —— ① **+0.905 s**、② **+1.547 s**、④ **+0.034 s**；只有 ③ 短 **−0.765 s**，但该差值落在单步抖动内（同一 `off` 跑末步报错、`on` 跑末步正常），**不许算作通道的功劳**。
2. 新增成本（①②③ 开通道侧，4 例按注入/探针/叠框口径）：注入 **1430 / 1430 / 1196 / 0** 字符、探针 **271 / 415 / 97 / 0** ms、叠框 **566 / 1011 / 207 / 0** ms —— 全通道开着时每一帧都要多付这笔钱，而步数 / 点击数 / 同坐标重复 / 点击未命中 4 例两态**全平**，没有一项指标换来改善。
3. 编号本身没命中目标：①② 的 **40 个编号只覆盖 Chrome 窗口外壳**（标签 / 工具栏 / 书签栏 / 窗口按钮），PDF 渲染文本与必应页面本体不在 UIA 树里 ⇒ 编号命中了外壳、**没命中任务真正要点的元素**；只有 ③ 这类原生控件树可读的窗口才命中真目标。

按硬约束一（只增不减）与硬约束二（必须可回退）：**判定整条撤掉，不是只关开关**。开关文件与 `DSH_CU_UIA` 环境变量留到最后也不等于撤销代码，所以本轮把 §2 登记的恢复点 `ebf16ae` 走 `git revert` 链整条撤干净。

### 16.2 逐个 revert 提交号与被撤的文件清单

改动前基线 `ebf16ae`，本轮代码提交按倒序逐个 `git revert --no-edit`（不改写历史、不 reset、不 rebase、不 amend、不 push）：

| 撤销提交 | 撤掉的原提交 | 该提交动的文件 |
| --- | --- | --- |
| `c788aa6` | `2326629` 控件树通道核心逻辑 | `src/cu-uia-core.ts`（删）、`src/cu-uia-win.ts`（删）、`scripts/cu-uia-core`/`bench-cu-uia-core.mjs`/`cu-uia-live-probe.mjs`/`test-cu-uia-core.mjs`（删）、`package.json`（回到基线） |
| `ede2d68` | `c063bfe` 回退点与一键回退 | `scripts/cu-uia-rollback-drill.mjs`（删）、`src/cu-uia-core.ts`、`scripts/test-cu-uia-core.mjs`、`scripts/cu-uia-live-probe.mjs`、`package.json`（回到基线） |
| `f07e0d8` | `b557cde` UIA 常驻 sidecar | `src/cu-uia-sidecar.ts`（删）、`scripts/cu-uia-sidecar-bench.mjs`（删）、`scripts/cu-uia-live-probe.mjs` |
| `0692279` | `537c6e8` 编号框图像合成器 + 观察帧包装 | `src/cu-uia-overlay.ts`（删）、`src/cu-uia-observe.ts`（删）、`scripts/test-cu-uia-overlay.mjs`（删）、`scripts/test-cu-uia-observe.mjs`（删）、`scripts/cu-uia-rollback-drill.mjs` |
| `1859f30` | `eba493a` 接到 tools/execute（assistant.ts +3 行） | `src/assistant.ts`（接线撤销）、`lib/index.js`（构建产物回退）、`src/cu-uia-observe.ts`、`scripts/cu-uia-rollback-drill.mjs` |
| `1c4f595` | `1389272` 编号框走 post-execute 内容块层 | `src/cu-uia-content.ts`（删）、`scripts/test-cu-uia-content.mjs`（删）、`src/cu-uia-observe.ts`、`scripts/test-cu-uia-observe.mjs`、`lib/index.js`、`scripts/cu-uia-rollback-drill.mjs` |
| `aabf642` | `1613e5b` 候选清单瘦身 + 探针缓存 + 埋点 | `src/cu-uia-metrics.ts`（删）、`scripts/test-cu-uia-slim.mjs`（删）、`src/cu-uia-core.ts`、`src/cu-uia-content.ts`、`src/cu-uia-observe.ts`、`lib/index.js`、`scripts/cu-uia-rollback-drill.mjs` |

- **`e16e4d7` 与 `a2ea586` 是纯报告提交，按指示未撤**（§14.5–14.7 与 §15 的实测数字必须留在档案里）。
- 撤完后 `git ls-tree -r HEAD` 与工作树里 cu-uia 文件 **0 个**：`src/cu-uia-*.ts`（7 个）、`scripts/cu-uia-*.mjs`、`scripts/test-cu-uia-*.mjs`、`scripts/bench-cu-uia-core.mjs`（共 9 个）全部消失；被撤的脚本清单见本节。
- **报告文件与代码提交的冲突处理**：`1613e5b` 当年同时改过本报告，撤它时报告出现 merge conflict。恢复口径按「撤之前的内容」执行 —— 即恢复成本轮撤改之前 HEAD 的报告版本（blob `5fd7446d3c79e26801fd5968515c0e63fe022e4a`），而不是 `1613e5b^` 那份（那份还没有 `aed1824` 的 §14、`e16e4d7` 的 §14.5–14.7 与 `a2ea586` 的 §15）。这样 §14.5/14.6/14.7 与 §15 正文**一字未丢**，冲突在 `aabf642` 这一次 revert 提交里就地解决（该提交只动代码文件，报告在该提交内 0 改动），因此**没有额外多出一个「恢复报告」提交**，也没有需要单独补 commit 的残差。
- 报告自证（撤完后实测，与 §15.4 之前版本逐字节一致）：**783 行 / 61392 字节 / BOM `EF BB BF` / CRLF 783 / bareLF 0**。

### 16.3 测试证据

1. 既有 CU 测试（`DSH_CU_UIA=0` 环境，脚本按 `ebf16ae` 的 `scripts` 清单为准）：**8 个脚本全绿（8 PASS / 0 FAIL）** —— `test-cu-bridge` / `test-cu-capture-scale` / `test-cu-code-agent-notice` / `test-cu-observation-surface` / `test-cu-title-bold`（基线里本就存在的 5 个 `test-cu-*`）＋ `test-assistant-cu-watch` / `test-coordinate-mode` / `verify-cu-observation-live`。
2. 全量套件按既有跑法逐脚本跑（不经 `&&` 链，`DSH_CU_UIA=0`）：**脚本总数 94 / ok 91 / FAIL 3**，红只有既有的三条：`test-mobile-proxy.mjs`、`test-secretary-pagination-dom.mjs`、`test-secretary-session-log-write.mjs`；`PASS` 行合计 638、`FAIL` 行合计 2。无新增红。脚本总数回到基线口径：`git ls-tree -r HEAD -- scripts` 与 `ebf16ae` 的 `test-*.mjs` 计数同为 **94**（本轮新增的 5 个 `test-cu-uia-*.mjs` 已全部撤掉）。
3. 被撤掉的脚本清单（本轮新增，现已不存在）：`scripts/test-cu-uia-core.mjs`、`scripts/test-cu-uia-overlay.mjs`、`scripts/test-cu-uia-observe.mjs`、`scripts/test-cu-uia-content.mjs`、`scripts/test-cu-uia-slim.mjs`，另加非测试脚本 `scripts/bench-cu-uia-core.mjs`、`scripts/cu-uia-live-probe.mjs`、`scripts/cu-uia-sidecar-bench.mjs`、`scripts/cu-uia-rollback-drill.mjs`。
4. 相对基线的 0 改动自证（`git diff --numstat ebf16ae HEAD`）：`src/assistant.ts` **空**（接线 3 行已撤）、`lib/index.js` **空**（撤完重建 `node build.mjs` 后逐字节回到基线 blob `2d1f044b`，553500 字节 / CRLF 0）、`vendor/computer-use` **空**（本来没改过，自证一次）、`package.json` 不在改动清单里。
5. `git status --porcelain -uno` **输出为空**（干净）。
6. `git diff --name-status ebf16ae HEAD` **只剩决策档案 2 个文件**：`docs/computer-use-提速前后对比-2026-11-27.md`（783 行）与 `docs/ComputerUse-优化-只增不减-改动清单-20261127.md`（116 行）。为凑数字没有删任何档案。

### 16.4 开关文件已删除 + 全仓库 grep

- profile 开关文件 `C::\Users\<ACCOUNT>\.dsh\profiles\desktop\dsh-assistant-cu-uia.json`（撤前实测 17 字节、无 BOM、内容 `{"enabled":false}`）已删除；删前逐字节备份到 `outputs/2026-11-28/rollback/switch-off-2026-11-28.json`（17 字节，hex `7b22656e61626c6564223a66616c73657d`，与原件逐字节一致；`outputs/` 不提交）。删后核对同目录（78 个条目）里 `cu-uia` 文件 **0 个**，`dsh-assistant-cu-uia.json` 不存在。
- 全仓库 grep（`DSH_CU_UIA` / `dsh-assistant-cu-uia` / `cu-uia-`，本报告写到 §16 之后重跑，含本节自身引用）：**代码区 0 命中**（`src/`、`lib/`、`scripts/`、`vendor/`、`package.json` 三个关键词全为 0 行，`git grep` 退出码 1 = 无匹配）。整棵已提交树的命中行只落在本报告的 2 个 docs 档案里：`DSH_CU_UIA` **25 行**、`dsh-assistant-cu-uia` **9 行**、`cu-uia-` **63 行**——这些是决策档案里的历史引用，按「决策档案保留不删」照旧留着。未提交的证据与本机 scratch：`outputs/` 命中 **1 行**（`dsh-assistant-cu-uia`），`.tmp/` 命中 **60 个文件 / 146 行**（本机一次性探针与助手脚本，包括本轮回退用的 `.tmp/report-stats.mjs` / `.tmp/verify-doc.mjs` / `.tmp/append-sec16.mjs` / `.tmp/grep-counts.mjs`，一律不入库）。
- 运行时残留（不参与 git 状态，按档案留证）：`%TEMP%\dsh-cu-marks\` 内仍有本轮通道跑的 12 张 `*.marks.png` 与 `metrics-2026-11-27.jsonl`；快照副本已落在 `outputs/2026-11-28/r3`（`metrics-live-2026-11-27.jsonl` 46 行、`metrics-slice-before-c1on.jsonl` 16 行、`case1-on/metrics-after-c1on.jsonl`）与 `r2`（`metrics-live-5steps.jsonl`、`hint-block-received.txt` + `baseline`/`treatment` 帧）。档案一律保留，未删。

### 16.5 真机复核位

- 口径：编号通道回退后真机复核 **1 例**，坐标口径与 §15 案例② 相同（相对坐标 0–1000 → 物理像素，窗口 1920×1032），协议也相同：同一个工具块内「`pwsh` 起始戳 → 计数步 → `pwsh` 结束戳」，时间戳一律本机 UTC+8。全程只读演练：无保存、无提交、无发送、无花钱、无远端改动。

- 起止时间戳：`2026-11-27 21:43:50.159` → `21:43:54.754`（本机 UTC+8），本例墙钟 **4.595 s**（起止戳相减）。**4 步** = `open_app chrome` → `click [68,143]` → `click [99,143]` → `screenshot`；两次点击落物理像素 **(131,148)** 与 **(190,148)**，与 §15 开通道/关通道两态**逐字节相同**。

- 模型可见帧 **4 个**，逐帧按 `(255,43,214)` 严格计数（助手 `.tmp/magcount.py` + 捆绑 Pillow 12.3.0，`.tmp/` 本机 scratch 不入库）**全部 0 洋红**：

| 帧标识 | 尺寸 | 对应步 | 洋红 `(255,43,214)` |
| --- | --- | --- | --- |
| `6a0b910b52f5` | 1920×1032 | `open_app` | 0 |
| `a5d7426baada` | 1920×1032 | `click` A | 0 |
| `de0b821d7ff9` | 1920×1032 | `click` B | 0 |
| `04-shot-desktop` | 1920×1032 | `screenshot` 落盘帧 | 0 |

对照 §15 案例②：开通道同一 UI **每帧 16304 洋红**，关通道 **0**。

- 工具结果原文核对：4 步的 notice 只有两种形态 —— `Opened chrome (activated). Coordinates remain 0–1000.` 与 `Clicked screen 0 at [x, y] (left, count 1). Pointer landed at [..] physical pixels. Coordinates remain 0–1000.`；**没有出现任何 `#1 TabItem` 形式的编号候选清单注入行**。对照 §15 开通道同一 UI：每帧尾部 **6 行 / 286 字符**清单。

- 埋点核对：`metrics-2026-11-27.jsonl` 本次跑前后都是 **50 行**，本次 4 步新增 **0 行**；文件最后一行时间戳 `2026-11-27T10:16:26.230Z`（本机 18:16:26）早于本次 21:43:50；最后 4 行 `page` 键为空、`hintChars` 90 / `drawn` 3 / `overlayMs` 4–9，是**回退前 CU 单测写下的合成行，不是真机行**。

- 构建产物核对：`lib/index.js` **553500 字节**、blob `2d1f044b`，与 `ebf16ae` 基线**逐字节一致**；产物内 grep 命中全 0 —— `buildSlimControlHint` 0、`onscreenMarks` 0、`createPageCache` 0、`recordMetrics` 0、`dsh-cu-marks` 0、`installCuObservationWrapper` 0、`UIA_PROBE_BUDGET_MS` 0 ⇒ **编号通道代码已不在构建产物里**。

- 开关文件核对：`Test-Path C::\Users\<ACCOUNT>\.dsh\profiles\desktop\dsh-assistant-cu-uia.json` = **False**（已删）；删除前备份 `outputs\2026-11-28\rollback\switch-off-2026-11-28.json` **17 字节**，与删除前逐字节一致。

- 证据落盘（`outputs/` 不提交）：`outputs\2026-11-28\rollback\live\01-openapp.png` **2068505** 字节、`02-clickA.png` **2068405** 字节、`03-clickB.png` **1138723** 字节、`04-shot-desktop.png` **1138736** 字节。

1. ⚠️ 限制一：本次复核时**宿主尚未重启**，运行进程内存里仍是回退前的旧构建产物，所以这条证据证明的是「代码已撤 + 开关文件已删 ⇒ 默认关行为一致、无编号注入、埋点 0 行」，**不能当作「重启后进程彻底不含该通道」的证明**。
2. ⚠️ 限制二：本次末步 `screenshot` 工具因剪贴板被其它程序占用**报错 1 次**（宿主自身剪贴板写入失败，与编号通道无关）；落盘帧仍生成并计入上面的洋红 0 计数，但该步未给模型送帧，因此本例记为 **4 步 / 帧读取 3:4**。

- ✅ 已完成：「待宿主重启后复核」这项已于 **2026-11-28 08:33 宿主重启后**做完真机复核，实测与数字见 **§16.6**（3 帧 `(255,43,214)` 计数 **0 / 0 / 0**、两次点击落对目标且无编号框注入、重启后新增埋点 0 行、产物与源码 9 个标记全 0 命中）；§16.5 上面那段记录仍属 **11-27 21:43 旧构建**，与 §16.6（重启后新构建）两段要分开读。

### 16.6 宿主重启后真机复核（2026-11-28 08:33 新构建）

> 口径：本节才是「宿主重启后」的那一次复核，补上 §16.5 末尾留的占位。**所有数字都是现场跑出来的**：帧是新宿主里 CU 会话现场截的、计数是现场逐像素扫的、埋点与产物标记是现场 grep 的。探针与中间件在 `.tmp\`（不入库），命令文本纯 ASCII。

1. **生效前提现场核对**：宿主 `DeepSeek Harness` pid **44692**，StartTime **2026-11-28 08:33:27**（现场 `Get-Process`）；加载的是 11-28 重建产物 —— 现场 `lib\index.js` **563,510 字节 / mtime 11-28 01:58:38**（本档案 §16.5 记录的 553,500 字节是 11-27 那份基线构建，已被 11-28 的重建取代；重建原因见整改档案）。旧 pid 59672 与 54092 现场都已不在进程表里。
2. **帧复核（3 帧，窗口 1080×694，每帧 749,520 像素）**：

| 帧文件（`outputs\2026-11-28\cu-recheck-live\`） | 字节 | 现场 mtime（UTC+8） | `(255,43,214)` | 纯洋红 `(255,0,255)` |
| --- | --- | --- | --- | --- |
| `recheck-0-1.png` | 86,468 | 11-28 08:43:26 | **0** | **0** |
| `recheck-0-2.png` | 61,615 | 11-28 08:43:51 | **0** | **0** |
| `recheck-0-3.png` | 86,685 | 11-28 08:43:58 | **0** | **0** |

计数法现场口径：捆绑 Python（`~\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe` + Pillow 12.3.0），逐像素**全等比较**，不是容差匹配；脚本 `.tmp\cu_magenta3.py`。另记一条：放宽阈值的「近似品红族」（R≥210 且 B≥210 且 G≤90）每帧 **10 个像素**，属 360FileBrowser 自身图标杂色，不是编号框——照实登记以免误读。

3. **点击落对目标现场核对（2 次点击）**：目标应用 360FileBrowser64，两次点击都在标签栏上来回切换标签页 `docs → out → docs`，没有越界、没有点开条目。核对方式两条：一条是 CU 会话自己的回执（活跃标签与面包屑都对上），另一条是本轮**独立只读复核步**：前台窗口标题 `360FileBrowser64`、标签栏末位 `docs` 活跃、左下角「23 个项目」、高亮条目 `cu-pixel-1920-20261125.md`，截图落 `Desktop\Screenshot 2026-11-28 at 09.05.06.png`（本轮未点击、未切换、未滚动）。对照 §15 开通道那两例：每帧尾部注入 **6 行 / 286 字符**编号候选清单 + 每帧 16,304 洋红——重启后这三帧**既无编号框、也无清单**。
4. **埋点复核**：`<TEMP>\dsh-cu-marks\` 现场 **23 个件**，mtime 全部 ≤ 11-27 18:18:02，**11-28 之后新增 0 个** ✓；`metrics-2026-11-27.jsonl` 现场 **12,735 字节 / 50 行**（不是 51 行）——最后一行的 `at` 仍是 `2026-11-27T10:16:26.230Z`（本机 11-27 18:16:26），键 `[at, decision, drawn, hintChars, hintLines, overlayMs, page, probeMs, probed, replaced, tool]` 就是 §16.4 已登记的那条 CU 单测合成夹具 ⇒ **重启后没有任何新增埋点行** ✓（编号通道的 `recordMetrics` 不再写任何行）。
5. **源码与产物标记复核（现场 grep，本轮重跑）**：9 个编号通道标记 `buildSlimControlHint` / `onscreenMarks` / `createPageCache` / `recordMetrics` / `dsh-cu-marks` / `installCuObservationWrapper` / `UIA_PROBE_BUDGET_MS` / `cu-uia` / `markToPrompt`，扫 8 个 scope（脚本 `.tmp\cu_scan.mjs`，排除 `node_modules` 与 `.git`，**不扫 `outputs\` 与 `.tmp\`**）：

| scope | 扫到文件数 | 9 个标记命中总数 |
| --- | --- | --- |
| `src/` | 178 | **0** |
| `scripts/` | 132 | **0** |
| `lib/`（含 `lib\index.js` 563,510 B、`lib\pocket.js` 238,309 B、`lib\client.js` 1,718,330 B、两份 CU 产物） | 17 | **0** |
| `vendor/`（只读核对，本轮未改） | 18 | **0** |
| `android/` | 22,570 | **0** |
| `build.mjs` + `dsh.plugin.json` + `package.json` | 3 | **0** |
| `template/` | 2 | **0** |
| `release/` | 24 | **0** |

⇒ 编号通道标记在**现役源码、三份核心产物、两份 CU 产物、上架包、模板、vendor、安卓构建件**里全部 0 命中；本轮新增的 6 份整改回归脚本也不含这些标记（`scripts/` 132 件 0 命中）。

6. **测试现场重跑**（与新宿主同一构建）：`npm run check` **exit 0**；CU 基线 8 个脚本逐条单跑全 **exit 0**（带计数的 4 个：capture-scale 14/14、code-agent-notice 12/12、observation-surface 15/15、assistant-cu-watch 16/16）；全量链 96 条逐条单跑 **94 绿 / 2 红**，红的两条仍是既有位置（链第 12 位 `test-secretary-session-log-write`、链第 42 位 `test-mobile-proxy`）⇒ **无新增红**。
7. **本节还证明不了的东西（照实登记）**：① 没有对宿主进程内存做扫描，「重启后进程彻底不含该通道」仍是间接证据（依据 = 产物标记 0 命中 + 帧洋红 0 + 埋点 0 新增行）；② 本例窗口 1080×694 与 §15 案例的 1920×1032 尺寸不同，逐像素计数不可跨案例直接比较；③ 洋红计数只覆盖这 3 帧，不是该 CU 会话的全部中间帧；④ §16.5 那一段（11-27 21:43 旧构建）与 §16.4 的旧埋点件按「档案保留不删」照旧留着，未清理。

## 16.7 Computer Use 点击前坐标硬门（2026-11-28，实测失误驱动）

### 16.7.1 本轮实测的 3 次未命中

2026-11-28 下午，同一 CU 会话，窗口 1920×1032，目标「Publish release」按钮在图上的 bbox 实测为 (346,888)-(471,917)，中心 (408.5,902.5)。前三次点击都落在按钮左边缘之外：

| 次序 | 发送分数 [x,y] | 实际落点（物理像素） | 与 bbox 的偏差 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | [146,873] | (280,901) | 66 px | miss |
| 2 | [171,873] | (328,901) | 18 px | miss |
| 3 | [145,874] | (278,902) | 68 px | miss |
| 4 | [213,875] | (409,903) | 0 px | hit |

根因：分数是按截图目测估的，没有从 bbox 起止像素算。目标中心换算应是 x = 408.5 ÷ 1920 × 1000 = 212.7604、y = 902.5 ÷ 1032 × 1000 = 874.5155；前三次的 x 分数只有 145–171，换算后的物理落点自然在 bbox 左边缘外。

### 16.7.2 解析器（`scripts\cu-coordinate-resolver.mjs`）

输入：截图实际像素尺寸 WxH、目标 bbox（x1,y1,x2,y2）、可选观察面物理矩形 bounds、会话坐标口径 mode、可选待校验 position。
输出：bbox 起止、中心物理像素、0–1000 分数（x/y 各带算式）、建议分数/像素、按 harness 映射规则预测的物理落点（未取整与 round），以及 check（命中/偏差/修正建议）。
记录：写到系统临时目录 `dsh-cu-coordinate-records/<id>.json`；id 为 8 位十六进制，记录 10 分钟过期。
截图被缩放（抓屏长边上限 1920）时，`bounds` 必须填观察面窗口矩形；缺省按 1:1 算预测落点。

真实算例（仓库相对路径）：

```
node scripts\cu-coordinate-resolver.mjs --shot 1920x1032 --bbox 346,888,471,917 --target "Publish release" --tool click --mode millifraction --position 146,873
```

输出要点：center=(408.5,902.5)，fractions=(212.7604,874.5155)，predictedRounded=(409,903)，check={hit:false, landed:(280,901), deviationPx:66, suggestion.fractions:(212.7604,874.5155)}。

### 16.7.3 管线硬门

- pre-execute：CU 会话的 click / drag / input_text / long_press 必须带 `coordinate_record`。缺记录 → deny `missing-coordinate-record`；记录过期 → `coordinate-record-stale`；记录坏/跨会话/坐标口径不一致 → `coordinate-record-invalid`；position 按记录换算后落在 bbox 外 → `coordinate-out-of-bounds`，并把偏差像素与建议分数写进拒绝原因。
- post-execute：从工具回执的 `Pointer landed at [x, y]`（结构化 landed，文本兜底）与记录 bbox 比对；命中/未命中写进 turn-guard 日志。同一目标连续 2 次 miss 时，结果侧 block 并提示改用地址栏导航 URL / 键盘 Tab-Enter / 读页面文本链接。
- 日志字段：tool / code / session / screen / bbox / landed / deviationPx / streak / record / advice / textChars；不落目标文本（没有 excerpt），不落本机绝对路径；沿用 `sanitizeTurnGuardLine` 掩码与 `MAX_LOG_BYTES = 200 × 1024` 轮转。
- 参数声明：在 system-prompt/assemble 的最终 tools 上给 click / drag / input_text / long_press 补 `coordinate_record`（drag 另有 `coordinate_record_end`）；只加字段，不动 vendor 的 schema 语义。
- 提示词：CU 会话每步可见一段硬门说明；普通会话为空串。

### 16.7.4 与已撤销覆盖层通道的关系

本轮不恢复 §16 已撤销的覆盖层/编号通道，也不把编号框加回来；要的是「先脚本算坐标、再点击、按回执核对命中」。覆盖层时代的旧开关、旧文件名、旧入口一个都没有重新引入。

### 16.7.5 生效前提

插件改动要等宿主下次重启才进运行进程；本轮只 commit 不 push、不重启宿主，所以运行中的 CU 会话仍走旧逻辑。重启后新建的 CU 会话与后续步骤才会被这道门拦住。

