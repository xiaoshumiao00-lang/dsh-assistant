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
