# Computer Use 提速前后对比 + 恢复点与一键回退（2026-11-27）

> 两条硬要求一起写在本文：**提速**（只增不减）与**可回退**（提取失败必须回到改动前的行为）。
> 所有数字都是本机实测（命令与时间戳见各节），没有估算冒充实测；测不出来的部分在 §4 明说。

## 0. 结论先行

| 项 | 值 | 证据/出处 |
| --- | --- | --- |
| **改动前基线 commit** | `ebf16ae` | `git rev-parse aef60f0^`（清单 commit 的父提交） |
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
