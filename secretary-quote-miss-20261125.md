# 个人秘书「引用不生效」根因取证与修法报告（2026-11-25）

## 结论一句话

引用链路本身没断：引用在 prompt 构建之前就已落盘、键也对、内容也对，模型那一轮**看得见**被引用的卡；失效点是引用段只贴在派活分层(1790)之前、离这条用户消息隔着一大段派活规则，且正文写的是「用户接下来那条消息」这种未来时口径——模型手里已经握着这条消息，等于没被钉住，于是「这个任务完成了吗？」被接到了最近那条 48G 派活上。修法：1783 登记段原样保留（措辞升级为「这条消息」），另加一张 `order=1791` 的硬锚点段贴在派活分层之后、最靠近这条用户消息，用不许改口的硬要求把指代钉在被引用的那张卡上。

## 0. 用户实报原文

> 个人秘书的会话卡片引用功能还是有bug，我刚才明明引用的是这个会话卡片，"本地部署的大模型为什么执行任务时出现这个错误"，但是秘书回复的是"48G 查价这条已完成 · 京东按价格升序…"

（该消息本身也落进了秘书会话日志：见 §3 时间线 #14159/#14164。）

## 1. 开局取证（raw 原文）

开工前先贴原始三件套（当时工作区还是干净的，只有已知未跟踪文件）：

### 1.1 `git log -1 --oneline`（现在仍是同一值）

```
c075206 docs: 纳入本轮落地报告 —— 手机端抽屉关闭(dbfb059)、进详情亮度(f8e1b3b)、设置面板空白(0968794)、会话详情卡死(b588eb5)、删手机界面布局栏(f690a60)、composer图片光标标记(31e4a27)、秘书完成行隐藏(5ad7a52) 的取证与测试记录
```

### 1.2 `git status --porcelain`（开局时）

开局时只有已知未跟踪物（`.tmp/`、`outputs/`、30 张 `tmp-secretary-*.png` 冒烟截图），无任何已跟踪文件改动；`git diff --stat` 为空。

### 1.3 「HEAD 应为 f502653 附近、有 3 个 tmp_diff_av_index.txt 残留」——与真实仓库不符

- `git cat-file -t f502653` → `fatal: Not a valid object name f502653`（exit 128）。本地与远端都不存在这个对象。
- `Get-ChildItem -Recurse -Filter tmp_diff_av_index*` → 0 个匹配。工作区没有这个残留。
- `git log --oneline -8`：HEAD = `c075206`，此前 `5ad7a52` / `31e4a27` / `b588eb5` / `f690a60` / `0968794`，没有 f502653 的影子。
- 旁证：秘书会话自己的一条回复曾断言「仓库 HEAD 仍是 f502653」——那是**另一个会话的另一份副本**里的状态，不是 `D:\dsh-assistant`。本仓库一切以 `c075206` 为基准。

⚠️ 本轮 `git ls-remote origin main` 网络取数：开工前曾取到 `c075206`（与本地 HEAD 一致）；写报告时复测因 TLS 断连失败（`TLS connect error: unexpected eof`），属网络抖动，不影响本地判定。

**处置**：以上不一致如实写进本报告；所有改动、测试都基于真实仓库 `D:\dsh-assistant` @ `c075206`。

## 2. 取证方法（先取证再动手）

- 只读解压宿主会话日志 `~/.dsh/sessions/--C-Users-<ACCOUNT>-.dsh-assistant--/session-83bca3e3-bcd1-49f0-8b3c-2ec9edae14e3/session.v4.jsonl.zstd`（`~` = 本机用户主目录；35,325,715 B → 解码 88,990,726 B，14,292 行，5,963 帧，逐帧解码 `bad=0`）。**只读，未重写原文件。**
- v4 判据核对：首帧单行 header、其余帧独立 zstd 帧（magic `28 b5 2f fd` 枚举切片逐帧解）。
- Node 24 的 `zlib.zstdDecompressSync` 对多帧文件只解第一帧，所以按帧切；这是探针脚本自己的读法，与宿主无关。
- prompt 文本从 `system/message` 事件读（`request/header` 事件只存 `header,reason`，不含正文）。
- 行号以 `analyze-events.mjs` 的单一索引为准（其它探针脚本因 `.filter(Boolean)` 有空行偏移，弃用）。

## 3. 失效现场时间线（2026-11-25 06:19–06:26，全部取自解码后的日志原文）

| 行号 | 事件 | 时间 (UTC) | 内容 |
|---|---|---|---|
| #14049 | system turn=583 | 06:16:59 前后 | 16 段，**无**卡片引用段 |
| #14086 | system turn=584 | 06:19:20.074Z | 16 段，**无**卡片引用段 |
| #14106 | system turn=585 | 06:23:36.571Z | **有**卡片引用段 |
| #14122 | assistant/message turn=585 step=2 | 06:24:05.358Z | 「✅ 48G 查价这条已完成 · 京东按价格升序，最便宜的实物 48G 卡起价 4999 元…」← 用户投诉的答非所问，就产生在这一轮 |
| #14124 | turn/end turn=585 | 06:24:05.362Z | — |
| #14129 | agent/inbox/spliced | 06:24:30.221Z | 真实用户消息「这个任务完成了吗？」 |
| #14133 | system turn=586 | 06:24:30.296Z | **有**卡片引用段（引用已登记、注入成功） |
| #14134 | user/message | 06:24:30.297Z | 「这个任务完成了吗？」 |
| #14141 | assistant reasoning turn=586 | 06:24:49.497Z | 原文：'or possibly "这个任务" refers to the card they were referencing' … 'most likely means…' → 模型**明确看见了**被引用的卡，然后自己选了 48G 任务 |
| #14152 | assistant/message turn=586 | 06:24:55.212Z | 又答 48G |
| — | turn/end turn=586 | 06:24:55.216Z | 引用被消费清掉（与状态文件 `updatedAt` 精确吻合） |
| #14159/#14164 | 用户投诉消息 | 06:26:09.368/.445Z | 「引用功能还是有bug…」 |

### 3.1 turn 585/586 prompt 里注入段原文（#14133 节录）

```
# 卡片引用（个人秘书）
用户刚在会话页上按了「引用」，引用的就是下面这张用户消息卡；用户接下来那条消息就是要接着它说的内容。
定位：kind=user｜轮次 584｜cardKey=user:13:input-message620571e4-fd4b-418f-952f-1aec0512b770
卡片正文摘录（不是完整汇报，只用来定位引用的是哪段话）：本地部署的大模型为什么执行任务时出现这个错误[图1:image.png]
处理要求：把用户这条消息当作对这张卡的回应；…引用登记只说明「接着哪张卡说」，不改变任何派活与工具规则。
# 语音输入（个人秘书）…
# 派活分层（个人秘书）…（1790，全 prompt 最后一段）
```

要点：
- 键正确：`session-83bca3e3…`（现役秘书会话）。
- 卡正确：`cardKey=user:13:input-message620571e4…`、轮次 584、摘录正是用户引用的那句「本地部署的大模型为什么执行任务时出现这个错误」。
- 位置：引用段是 8 段里的第 6 段，后面还隔着语音输入、整段派活分层——**不贴着这条用户消息**。
- 口径：「用户**接下来**那条消息」是将来时；模型这一轮手里已经握着这条消息。

### 3.2 宿主状态文件原文

`~/.dsh/profiles/desktop/dsh-assistant-secretary-quote.json`：

```json
{"version":1,"updatedAt":"2026-11-25T06:24:55.216Z","quoteBySession":{}}
```

85 字节。`updatedAt` 与 turn 586 `turn/end`（消费清引用，`src/assistant-secretary.ts` 的 turn/end 分支删除+persist）毫秒吻合——是**消费写盘**，不是迟到登记。`quoteBySession` 已空，说明引用按设计「吃掉一轮就收」。

## 4. 三条候选根因的判定（按证据，不许猜）

### 候选 1：客户端 POST 与用户发消息竞态（引用在 prompt 构建完之后才落盘）—— ❌ 排除

证据：
- 引用登记先于消息到达：用户按引用的时间在 turn 584 期间（06:19 前后），而带引用的 prompt 出现在 turn 585（06:23:36.571Z）与 turn 586（06:24:30.296Z），均早于/贴着各自 `user/message`（#14129 06:24:30.221Z → #14133 06:24:30.296Z）。
- 状态文件 `updatedAt=06:24:55.216Z` 精确等于 turn 586 `turn/end` 时刻 = 消费写盘，不是迟到登记。
- 若真是竞态，prompt 里根本不该出现引用段；但 585、586 两轮都实实在在带着。

### 候选 2：客户端上报 sessionId 与宿主 activeSessionId 不一致（记录落别的 key）—— ❌ 排除

证据：
- turn 586 prompt 里注入段用的是秘书会话自己的 key，且 `cardKey`/`轮次 584`/摘录内容与用户投诉的那张卡逐字一致（§3.1）。键错的话注入体不可能这么准。
- 状态文件按 `sessionId` 分组，当时 `quoteBySession` 清空前本就只有这一条；GET/消费都命中同一条。

### 候选 3：注入其实成功、模型没接上 —— ✅ 成立

证据：
- turn 586 推理原文（#14141）：'or possibly "这个任务" refers to the card they were referencing' —— 模型**看见了**引用卡，仍在多任务清单里自己挑了 48G。
- 结构弱点 1：引用段在 8 段中排第 6，与这条用户消息之间隔着语音输入段和整段派活分层（1790 是全 prompt 最后一段，离消息最近的不是引用而是派活规则）。
- 结构弱点 2：正文「用户接下来那条消息」是将来时口径，对已经握着消息的模型没有约束力；「处理要求」是描述性软话，没有「不许接到别的任务」这种硬钉。
- 这两点是措辞/位置问题，不是登记问题——恰对应用户授权的第 3 类修法。

### ⚠️ 对上一轮中断会话取证的更正

上轮中断会话曾得出「1783 缺席」的初步印象——那是**读错了轮次**：turn 587/588/589 的 prompt 本来就只有 1770/1780/1785/1790 四段，因为引用在 586 轮 `turn/end` 已按设计消费清掉。引用在 585、586 两轮都在。特此更正。

## 5. 修法（只动引用链路：登记、注入位置/措辞；客户端 store 一行未动）

判据（对应候选 3）：让引用在模型那一轮**真的可见且权重更高**——位置挪到最靠近用户消息处（派活分层之后），措辞从不许改口的硬要求直接钉死指代。

改动文件（相对 `D:\dsh-assistant`，行号为改后值）：

1. `src/assistant-secretary.ts:313-321` — 新增导出常量 `SECRETARY_QUOTE_ANCHOR_SECTION_ORDER = 1791`（贴在派活分层 1790 之后、宿主自有段之前；注释里写清失效现场判据）。
2. `src/assistant-secretary.ts:391` — 1783 登记段正文「用户接下来那条消息」→「用户这条消息」（去掉未来时口径）；`:398` 同款「用户那条消息里的要求」→「用户这条消息里的要求」。既有被断言的子串（`引用登记只说明`、`不是完整汇报`、定位行等）一字未动。
3. `src/assistant-secretary.ts:407-424` — 新增纯函数 `secretaryQuoteAnchorText(record)`：锚点段正文，带 cardKey/kind/轮次/被引用卡正文，硬要求「这条消息里的指代一律指向这张卡；先回答这张卡接着的那件事，不许把这条消息接到最近那条派活、最近那条系统通知或别的任务上；不许因为摘录短就吞掉这条消息里的要求」。
4. `src/assistant-secretary.ts:918-944` — 注册 `assistant:secretary-card-quote-anchor` 段（order=1791）。门与 1783 完全同源：只喂固定秘书会话、过期即清并落盘、真实用户消息那轮 `turn/end` 一起收掉；注销也补上。
5. `src/assistant-secretary.ts`（test surface 导出）— 补 `SECRETARY_QUOTE_ANCHOR_SECTION_ORDER`、`secretaryQuoteAnchorText`。
6. `scripts/test-assistant-secretary.mjs:704-817` — 新增 2 条回归用例（见 §6）。
7. `lib/index.js` — `node build.mjs` 构建产物（仓库惯例随源码提交）。

**没动的**：客户端 `src/client/pocket/orb/secretary-cards.ts` store（候选 1/2 已排除）；1783 段 order 与全部既有断言；路由/落盘/消费逻辑；V0 标签；hpg 定价与客服制单闭环。

## 6. 测试（先失败、后改绿；一条断言都没放宽）

### 6.1 失败测试先行（旧代码 `c075206` 构建产物上跑新用例）

```
FAIL 引用硬锚点段（复现 2026-11-25 失效现场）：贴在派活分层(1790)之后、正文点名被引用卡、不许把这条消息接到别的任务
AssertionError [ERR_ASSERTION]: 没注册 assistant:secretary-card-quote-anchor 段——引用只贴在派活分层之前，模型这一轮没被钉住，这就是用户报的失效现场
FAIL 引用锚点段与既有段互不干扰：语音输入(1785)、派活分层(1790)、朗读规范(1780)位置原样不动
AssertionError [ERR_ASSERTION]: 锚点段位置常量要导出（判据：贴在派活分层之后）
（exit code 1）
```

同轮既有 16 条用例全部 PASS —— 证明没有为凑绿动过任何既有断言。

### 6.2 新代码全量

```
PASS 27/27 assistant-secretary
PASS 58/58 secretary-cards
npm run check（node --check 全部 6 个 lib 产物）：通过
node build.mjs：[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js
```

冒烟 `scripts/smoke-secretary-page.mjs`（真机 Chrome + 现网宿主 3081，连跑 3 次取稳定性）：

- 第 1 次：SMOKE FAIL 1 项（非引用项）；第 2 次：SMOKE FAIL 3 项（合成通知卡渲染 2 项 + 插话用户卡渲染 1 项）；第 3 次：**SMOKE PASS 全部通过**。
- 判定：失败集合在三次同代码运行间漂移（1→3→0），且失败项全部依赖现网会话的现场状态（合成通知投递时机、插话那一刻秘书是否「跑任务中」）；引用相关断言（:1616 引用 chip 全流程、:1012 通知卡 `[[session:…]]` chip）**三轮全 PASS**。另：冒烟跑的是宿主持有的旧内存代码 + 逐字节相同的 client.js，本轮改动在代码层面不可能影响这几项。故记为现场抖动，不是回归。
- 第 3 轮引用断言原始行（节录）：`PASS 点卡片引用后输入框那侧出现「带引用」提示… "meta":"第 584 轮 · 用户消息卡","preview":"本地部署的大模型为什么执行任务时出现这个错误[图1:image.p…"` —— 冒烟现场点的就是事故那张卡。

### 6.3 全套逐脚本（test-*.mjs 全量，共 85 个；原始 exit code + 脚本自述末行）

**83/85 exit 0；2 个失败均已用 stash 验证在旧代码 `c075206` 上同样失败（环境前置缺失，非本轮回归）：**

- `test-secretary-session-log-write.mjs` exit 1：`Error: 宿主真实解析器不可用，已拒绝写入会话日志：D:\deepseek-harness\packages\session\session-format-v3-to-v4\lib\index.js（不存在）；D:\DSH Desktop\resources\app.asar\...（不存在）` —— 本机没有 DSH 源码 checkout / 安装目录这两条路径，import 阶段即拒。
- `test-mobile-proxy.mjs` exit 1：`AssertionError: gzip 浏览器也必须收到精简后的 boot graph (true !== false)` —— 移动代理 gzip 用例，与秘书引用链路无关，旧代码同样失败。

```
test-assistant-archive.mjs                    exit=0  PASS 10/10
test-assistant-card.mjs                       exit=0  ok test-assistant-card: 12 assertions
test-assistant-config-write.mjs               exit=0  PASS 11/11
test-assistant-cu-watch.mjs                   exit=0  PASS 16/16 assistant-cu-watch
test-assistant-diagnostics.mjs                exit=0  PASS 6/6
test-assistant-dispatch.mjs                   exit=0  PASS 32/32 assistant-dispatch
test-assistant-home.mjs                       exit=0  ok test-assistant-home: 41 assertions
test-assistant-memory.mjs                     exit=0  PASS 7/7
test-assistant-open-diag.mjs                  exit=0  PASS 5/5 assistant-open-diag
test-assistant-proactive.mjs                  exit=0  PASS 9/9 assistant-proactive
test-assistant-secretary.mjs                  exit=0  PASS 27/27 assistant-secretary
test-assistant-tts.mjs                        exit=0  PASS 5/5 assistant-tts
test-assistant-tts-worker.mjs                 exit=0  PASS 7/7 assistant-tts-worker
test-bottom-overlay.mjs                       exit=0  PASS 15/15
test-clipboard.mjs                            exit=0  PASS 6/6
test-composer-focus-gate.mjs                  exit=0  ok test-composer-focus-gate
test-composer-inline-image.mjs                exit=0  25/25 PASS
test-composer-ledger.mjs                      exit=0  test-composer-ledger: PASS 10/10
test-composition-gate.mjs                     exit=0  test-composition-gate: PASS 27/27
test-console-assets.mjs                       exit=0  console-assets: exact JPEG bytes + lazy Blob + GET/HEAD/405 OK
test-console-filter.mjs                       exit=0  ok test-console-filter: 7 assertions
test-coordinate-mode.mjs                      exit=0  6/6 通过
test-cu-bridge.mjs                            exit=0  18 cases passed
test-cu-capture-scale.mjs                     exit=0  PASS 14/14
test-cu-code-agent-notice.mjs                 exit=0  PASS 12/12
test-cu-observation-surface.mjs               exit=0  PASS 15/15
test-cu-title-bold.mjs                        exit=0  test-cu-title-bold: 全绿
test-desktop-ball-gestures.mjs                exit=0  PASS 6/6 desktop-ball-gestures
test-downlink-lanes.mjs                       exit=0  PASS 11/11
test-face-cache.mjs                           exit=0  PASS 6/6
test-first-run-guide.mjs                      exit=0  PASS 5/5
test-local-store.mjs                          exit=0  PASS 7/7
test-mobile-boot.mjs                          exit=0  mobile-boot: graph + combo + preload + external guard OK; real-size batches=4074428 / 4072448 / 4068777
test-mobile-drawer-chrome.mjs                 exit=0  ok test-mobile-drawer-chrome
test-mobile-drawer-nav-close.mjs              exit=0  PASS 13/13
test-mobile-perf-policy.mjs                   exit=0  PASS 5/5
test-mobile-proxy.mjs                         exit=1  AssertionError: gzip 浏览器也必须收到精简后的 boot graph（旧代码同失败，环境/既有问题）
test-mobile-scan-facts.mjs                    exit=0  PASS 10/10
test-mobile-session-pagination.mjs            exit=0  mobile-session-pagination: 8/8 通过
test-mobile-session-scrollable.mjs            exit=0  ok test-mobile-session-scrollable — PASS 10/10
test-mobile-settings-live.mjs                 exit=0  PASS 14/14 mobile-settings-live
test-mobile-settings-sheet.mjs                exit=0  PASS 32/32 mobile-settings-sheet
test-mobile-toggle-zone.mjs                   exit=0  ok test-mobile-toggle-zone
test-mobile-uplink-history.mjs                exit=0  mobile-uplink-history: 5/5 通过
test-model-settings-notice.mjs                exit=0  model-settings-notice: first scan + nested/characterData/detached + 20k-node incremental guard OK
test-native-input-policy.mjs                  exit=0  [test-native-input-policy] 6/6 passed
test-new-project-default.mjs                  exit=0  PASS 11/11
test-path-guard.mjs                           exit=0  PASS 8/8
test-pc-file.mjs                              exit=0  PASS 9/9
test-perf-counters.mjs                        exit=0  PASS 9/9
test-pocket-drawer-dismiss.mjs                exit=0  ok test-pocket-drawer-dismiss — PASS 8/8
test-pocket-first-run.mjs                     exit=0  PASS 5/5
test-pocket-runtime.mjs                       exit=0  pocket-runtime: HMR reuse + revision replacement + delayed disposal OK
test-pocket-session.mjs                       exit=0  pocket-session: persistent across restart + isolated per home OK
test-project-exit.mjs                         exit=0  PASS 11/11
test-quality-gate.mjs                         exit=0  PASS 7/7
test-release-consistency.mjs                  exit=0  PASS 6/6
test-secretary-card-render.mjs                exit=0  PASS answerInlineTokens marks strong and model code labels
test-secretary-cards.mjs                      exit=0  PASS 58/58 secretary-cards
test-secretary-card-visual.mjs                exit=0  CARD VISUAL PASS
test-secretary-dispatch.mjs                   exit=0  PASS 12/12 secretary-dispatch
test-secretary-log-repair.mjs                 exit=0  PASS round trip compress and decompress preserves repaired text
test-secretary-notice-turn.mjs                exit=0  PASS 5/5 secretary-notice-turn
test-secretary-open-guard.mjs                 exit=0  PASS 5/5 secretary-open-guard
test-secretary-open-rebuild.mjs               exit=0  PASS 12/12 secretary-open-rebuild
test-secretary-open-recovery.mjs              exit=0  PASS 10/10 secretary-open-recovery
test-secretary-pagination-context.mjs         exit=0  PASS 26/26 secretary-pagination-context
test-secretary-pagination-dom.mjs             exit=0  PASS 卡片分页 DOM 验收全部通过（tmp-secretary-pager-dom.png）
test-secretary-quote-chip-visual.mjs          exit=0  QUOTE CHIP VISUAL PASS（截图 5 张）
test-secretary-session-log-write.mjs          exit=1  Error: 宿主真实解析器不可用（本机无 DSH checkout/安装目录，旧代码同失败，环境前置缺失）
test-secretary-speech-chunks.mjs              exit=0  PASS 16/16 secretary-speech-chunks
test-secretary-turn-tail-complete-hide.mjs    exit=0  PASS 7/7 secretary-turn-tail-complete-hide
test-session-focus.mjs                        exit=0  PASS 13/13
test-session-folder.mjs                       exit=0  PASS 21/21
test-session-index.mjs                        exit=0  PASS 4/4
test-session-list-filter.mjs                  exit=0  session-list-filter: 8/8 通过
test-session-rank.mjs                         exit=0  PASS 21/21
test-session-status.mjs                       exit=0  PASS 8/8
test-split-entry.mjs                          exit=0  PASS 4/4
test-split-observer.mjs                       exit=0  split-observer: lazy install + external split + idempotent dispose OK
test-tuoguan-autoanswer.mjs                   exit=0  PASS 19/19
test-tuoguan-autocontinue.mjs                 exit=0  PASS 19/19
test-turn-guard.mjs                           exit=0  turn-guard: 全部用例通过
test-uninstall-plan.mjs                       exit=0  PASS 5/5
test-web-routes.mjs                           exit=0  web-routes: legacy takeover + lifecycle + 3 HMR generations OK
TOTAL: 85 scripts, 2 failed（均为旧代码上同样失败的环境前置缺失，见上）
```

另：`npm run lint` exit 1 为**既有**状态——被点的 5 个文件（`secretary-context-measure-20261124.md`、`secretary-fix-20261124.md`、`secretary-interrupt-card-20261124.md`、`秘书会话-可行性调研.md`、`重做-…/风格说明.md`）全是本轮之前就存在的报告/文档；本报告已自查不含黑名单标识，未给 lint 新增任何一条。`npm run typecheck` exit 2：本机没有 TypeScript 编译器（脚本自述「跑不起来」，不是「没通过」），与本轮改动无关。

## 7. 提交

本地 commit、不 push；只 `git add` 自己改的 4 个文件（`src/assistant-secretary.ts`、`scripts/test-assistant-secretary.mjs`、`lib/index.js`、本报告）；`.tmp/`、`outputs/`、`tmp-*.png` 保持未跟踪。commit 短号与 stat 以 `git log -1` / 最终回复为准（本报告随该 commit 入库，无法在文内自指）。

## 8. 遗留与说明

- 宿主未重启（用户红线）：运行中的宿主仍在用旧内存代码，新锚点段要宿主下次加载插件后生效；客户端 bundle 已随 build 更新，刷新页面即拿到。
- 冒烟脚本会在真实秘书会话里留测试消息（turn 592「（冒烟测试）…」），与既有惯例一致。
- 探针脚本都在未跟踪的 `.tmp/`，未入库。
