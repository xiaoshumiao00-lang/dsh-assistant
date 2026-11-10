# 鹈鹕（tihu）端控制工具规格书

> 状态：**只读盘点 + 重新设计**，本轮不含任何实现改动、不 commit。
> 对象：`127.0.0.1:3081/tihu` 的模拟设备页（ESP32-S3-BOX-3B · 2.4″ · 320×240 · 触摸屏），以及宿主侧 `src/tihu/lane.ts` 的协议/控制面。
> 基线：2026-11-10 工作区 `main`（含 `70ca9ac` 那批改动）。
> 目标一句话：**用户说「停止阅读」「回到主页」，电脑端 agent 调一个工具，设备立刻照做，并且回执可验证。**

---

## 0. 一页结论

1. **现在只有一个鹈鹕工具**：全局原生工具 `tihu`（`src/tihu/control.ts:554`，注册点 `src/pocket-host/index.js:373`），15 个 action，靠 `action` 字符串分派。`vendor/computer-use` 与任何 preset 里**没有**鹈鹕屏幕相关工具（全仓 grep `tihu|鹈鹕` 在 `vendor/` 零命中）。
2. **15 个 action 里只有 3 个是"真能在设备上看到效果"的**（`go_home` / `replay` / `browse`），5 个已名存实亡（`bind` / `open_bubble` / `open_recent` / `status` 的一半字段 / `stop_speaking` 的一半语义），7 个属于派单/会话管理、与"控制设备"无关。
3. **最严重的缺口：`stop_speaking` 只掐得住"还没发出去的 PCM"**。`lanes.ts` 的 `cancelSpeaking()` 只把 `speakEpoch +1`（`lane.ts:1064-1069`），而页面已经把收到的块排进了 WebAudio 时间轴（`page.ts:1180-1262`），并且**任何 `screen.frame` 都不会清队列**（`page.ts:1479-1484` 的注释明确写了）。结果：用户说「停止朗读」，设备还会把已缓冲的 1~2 句念完，屏幕也可能已经切走了 → "停了但还在说"，比不提供工具更伤信任。
4. 页面**没有暂停/继续、没有跳到第 N 段、没有"跟随某条任务"、没有宿主驱动的"进入在听"、没有宿主答待决策**。这 5 个能力都需要**新增消息**，不是改参数能解决的。
5. 设计结论：把「一个 `tihu` + action 字符串」拆成 **15 个具名工具**（`tihu_stop_speaking` …），新增 **4 类下行 + 2 类上行**，改 `page.ts` 的 **8 个函数**，废弃 3 个旧 action、改名 7 个、保留 3 个派单类不动。

---

## 1. 现状盘点（只读，含文件:行号）

### 1.1 已注册给模型的鹈鹕工具

| 项 | 内容 |
|---|---|
| 工具名 | `tihu`（唯一一个，全局，所有会话可见） |
| 定义 | `src/tihu/control.ts:554-615`（`defineTool({ name: 'tihu', … })`，`name` 在 `:564`） |
| 注册 | `src/pocket-host/index.js:373` → `registerTihuControl(ctx, tihuRuntime.control, log)`；lane 挂载失败时整个工具不注册（`:366-378`） |
| 入参 | `action`(必填 string，不用枚举) / `session` / `index` / `confirm` / `text` / `target` / `title`（`control.ts:571-607`） |
| 执行 | `createTihuControlRunner` → `actions` Map 查表（`control.ts:485-492`） |
| 系统提示段 | `tihu:control`，≤120 字，`control.ts:496-524`（order 1810） |
| 单测锚点 | `scripts/test-tihu-protocol.mjs:2246` 断言 action 全集**固定为 15 个**、`:2250` 断言提示段 ≤120 字 |

**15 个 action 逐一对照**（顺序即注册顺序）：

| # | action | 定义 | 调用的控制面方法 | 实际行为（lane.ts 实现） | 判定 |
|---|---|---|---|---|---|
| 1 | `status` | `control.ts:330` | `deviceStatus` | `lane.ts:6667-6680`：读 `lastFrames` 缓存 | ⚠️ 过期：`speaking` 恒 `false`、`pending` 恒 `[]`（`:6676-6677`），且缓存 key 用 `sessionId ?? '__unbound__'`，而写入用 `sessionId ?? device.id`（`:1196` / `:4229`）→ 未绑定时永远读不到帧 |
| 2 | `list_devices` | `:353` | `listDevices` | 列在线设备 | ✅ 可用，但缺"最近活跃时间/当前屏" |
| 3 | `bind` | `:362` | `bind` | `lane.ts:6689-6696`：**已经不是绑定**，只是 `openTask()` 的别名 | ❌ 死动作（名字与语义不符） |
| 4 | `open_bubble` | `:368` | `openBubble` | `lane.ts:6697`：固定返回「旧的待读气泡已删除」 | ❌ 死动作 |
| 5 | `progress` | `:376` | `progress` | `lane.ts:6698-6710`：会话步骤/速度/上下文 | ✅ 可用（属会话，不属设备） |
| 6 | `list_sessions` | `:399` | `listSessions` | 标题模糊匹配 | ✅ 可用 |
| 7 | `archive` | `:409` | `archiveSession` | 需 `confirm=true` | ✅ 可用（危险动作，规则正确） |
| 8 | `stop_speaking` | `:422` | `stopSpeaking` | `lane.ts:6725-6730`：`cancelRound()` + 返回「已停止播报」 | ⚠️ **只停后续合成，页面已排程的 PCM 照念** |
| 9 | `replay` | `:427` | `replay` | `lane.ts:6731-6743`：重念**最近一条完成任务**的一句话播报；不重发完成帧 | ⚠️ 语义漂移：用户以为"重读这一屏正文"，实际念的是播报短句；且页面高亮不回到第一行 |
| 10 | `go_home` | `:432` | `goHome` | `lane.ts:6744-6750`：`cancelRound()` + `sendBoard()` | ✅ 可用（屏会回棋盘，声音不一定停） |
| 11 | `browse` | `:437` | `browse` | `lane.ts:6751-6761`：翻**棋盘页**（每页 4 条），页码**不夹上限** | ⚠️ 过期：工具描述写「browse 已无翻页」（`control.ts:566`），代码里 2026-11-10 已把翻页恢复（`page.ts:697-721`） |
| 12 | `open_recent` | `:443` | `openRecent` | `lane.ts:6762-6772`：打开最近一条完成任务 | ⚠️ 与 `open_task` 语义重叠，应合并 |
| 13 | `dispatch` | `:456` | `dispatch` | 派单（建任务 + 建 CU 会话 + 回执） | ✅ 保留，不属设备控制 |
| 14 | `list_tasks` | `:469` | `listTasks` | 登记簿未归档任务 | ✅ 保留 |
| 15 | `cancel` | `:475` | `cancelTask` | 撤还没起跑的任务 | ✅ 保留 |

> 说明：`bind` / `open_bubble` / `open_recent` 三个是 2026-11-09 统一指挥改造后遗留的**空壳**，现在只会误导模型（模型看到 `bind` 会以为要"切换会话"，实际是开详情）。

### 1.2 设备缺省选取逻辑（必须改）

`control.ts:299-310` `resolveControlDevice()` 的顺序：

1. 调用方会话绑定的那台（`deviceOfSession(callerSessionId)`）；
2. 只有 1 台在线 → 用它；
3. 否则**报错**：「有 N 台鹈鹕设备在线，但没有一台绑定到当前会话…」。

问题：统一指挥之后**每台设备都绑同一条「鹈鹕指挥台」**（`lane.ts:2921-2934`），所以第 1 步在"用户在普通电脑端会话里说话"时永远不命中；一旦有第二块屏（手机 + 桌面），工具直接不可用。**缺"最近活跃的那台"这一层**，`TihuDevice`（`lane.ts:436-528`）里也没有 `lastSeenAt` 字段。

### 1.3 设备端（页面）现有的本地能力

| 能力 | 位置 | 说明 |
|---|---|---|
| 本地音频队列（24kHz PCM 无缝拼接） | `page.ts:1180-1262` | 排程到 `AudioContext` 时间轴，块间淡入淡出 + 限幅 |
| 停掉本地队列 `stopPcm()` | `page.ts:1102-1113` | **只会被"页内点按"调用**（`:2017-2018`），宿主没有任何消息能触发它 |
| 完成页高亮严格跟随真实播放 | `page.ts:808-865` | 每段 PCM 的 `onended` 推下一段，无按时间估算 |
| 点按动作条 → 发 `screen.gesture{tap,hit:'action'}` | `page.ts:2011-2033` | 页面自己**不改屏**，全部交宿主 |
| 点棋盘行 → `hit:'task'` | `page.ts:2036-2044` | 同上 |
| 滚轮/拖拽 → `swipe{dy,phase}` | `page.ts:1980-1999` | 宿主目前**完全没处理 swipe**（`lane.ts:3005-3131` 只处理 `tap`） |
| 免按住（唤醒词「你好，鹈鹕」） | `page.ts:1817-1960` | 浏览器 `SpeechRecognition`，**只能页面自己开**（点 `#wake` 按钮）；宿主无通路 |
| 「结束本次语音会话」 | `page.ts:2083-2091` | 发 `session.end`，宿主关闸门后**回棋盘**（`lane.ts:2957-2973`），页面不清 `state.done` |
| 缩放 1×/2×/实际尺寸、仅屏幕外壳 | `page.ts:1596-1623` | 纯显示，**不属于设备协议** |
| 空闲屏（结束会话后） | `page.ts:2085-2091` | 直接改 DOM 文案，不经宿主 |

### 1.4 已有的"宿主→设备"能力缺口（一句话版）

页面所有的**屏**都由宿主 `screen.frame` 决定（`page.ts:941-1028`）；页面所有的**声音**由页面自己排程，宿主只负责"发不发下一点 PCM"。
两者之间**没有反向控制通道** → 于是「停声」「暂停」「跳到第 N 段」「强制进入在听」「把音色/免按住同步过去」「确认设备真的照做了」这六件事全都做不到。

---

## 2. 协议全表（`src/tihu/protocol.ts`）

### 2.1 信封

`{ v:'0', type, id, seq, ts, payload }`（`protocol.ts:67-80`）。纪律：**字段只增不删**、**未知 type 一律忽略**（`:534-641` `parseUpstream` 永不抛错）。当前 `TIHU_PROTOCOL_VERSION = '0'`（`:23`），扩容不改版本号。

### 2.2 宿主 → 设备（下行，12 类，`protocol.ts:48-61`）

| type | 载荷要点 | 谁发 | 页面处理 | 用途分类 |
|---|---|---|---|---|
| `screen.frame` | `stage/title/bullets/progress/tone/mode/actions/board/done/steps/countdown/more/ask/taskId/statsTail`（`:265-314`） | `sendFrame`/`pushFrame`/`sendBoard` | `renderScreen`（`:941-1028`） | **屏幕导航**（唯一载体） |
| `tts.audio` | `seq/total/sampleRate=24000/format=pcm16/data/index/text/charStart/charEnd/read:'done'/final/sample`（`:167-199`） | `speakAnnouncement`/`readDoneBody`/试听 | `playPcm`（`:1494-1529`），**无"停/暂停"语义** | **朗读/播放控制**（只有"发"） |
| `transcript` | `text/final/source/retryable` | 转写 | 显示 | 输入回显 |
| `event.progress` | `stage/text/done/total` | 各处 | 事件区一行 | 诊断 |
| `event.alert` | `level/text` | 各处 | 事件区红/黄字 | 诊断 |
| `session.bound` | `sessionId/title/project/live/preset/computerUse/auto/followed` | hello 后 | 只记 `state.sessionId`（`:1578`） | **会话切换**（现在恒为指挥台） |
| `voice.list` | `voices/selected/edgeVoice/engine` | 上行 `voice.list` 应答 | 画下拉（`:1531-1548`） | **设置**（只读） |
| `voice.created` | `voice/cached` | 建克隆音色后 | 自动 `voice.select` | **设置** |
| `task.list` | `board` | `sendBoard`/`broadcastBoardSnapshot` | 画棋盘（`:1581-1583`） | 棋盘数据 |
| `task.update` | `taskId/state/capsule/sub/ring/summary` | 单行变更 | 只记事件行（`:1584-1587`） | 棋盘数据 |
| `task.notify` | `level/taskId/text/bubbleId/spoken` | 通知总线 | 只记事件行（`:1588-1590`） | 播报记录 |
| `pong` | `nonce` | 心跳 | 忽略 | 心跳 |

### 2.3 设备 → 宿主（上行，11 类，`protocol.ts:34-46`）

| type | 载荷要点 | 宿主处理 | 用途分类 |
|---|---|---|---|
| `hello` | `clientId/clientVersion/protocol/capabilities/deviceName/sessionId/auto`（`:96-118`） | `lane.ts:2910-2955`：**强制统一指挥**，绑指挥台、`sendBoard` | 连接 |
| `audio.frame` | wav/16k/单声道/16bit + `audioBase64` | ASR | 语音输入 |
| `text.input` | `text/source` | 派单器 | 文字输入 |
| `session.end` | `sessionId?/reason?`（`:334-339`） | `lane.ts:2957-2973`：关闸门 + **回棋盘** | **会话切换** |
| `screen.gesture` | `swipe{dy,phase}` \| `tap{x,y,hit?,actionId?,taskId?}`（`:343-345`，坐标越界被钳制 `:598-621`） | `lane.ts:3005-3131`：**只认 tap**；swipe 直接丢弃 | **手势 / 屏幕导航** |
| `voice.list` | `{}` | 回 `voice.list` | **设置** |
| `voice.create` | `name/wavBase64/note` | 建克隆音色 | **设置** |
| `voice.select` | `name/edgeVoice/offlineOnly` | 改设备音色（`lane.ts:3138-3152`） | **设置** |
| `tts.sample` | `text?` | 走正式链路合成一句（`lane.ts:3154-3204`） | 试听 |
| `task.reply` | `taskId?/optionIndex?(0-8)/text?/command?('open'\|'board'\|'cancel'\|'stop')`（`:455-464`） | `lane.ts:2975-3004` | **决策/轻命令** |
| `ping` | `nonce` | 回 pong | 心跳 |

### 2.4 五类能力 × 现有消息的覆盖度

| 能力 | 现状 | 结论 |
|---|---|---|
| **屏幕导航**（回主页/翻页/开详情/跟随） | `screen.frame` 单向下发，够用；`screen.gesture{tap,actionId}` 让页面按钮也能驱动宿主 | ✅ 消息够，缺的是"工具层封装 + 回执" |
| **朗读/播放控制**（停/暂停/继续/重读/跳段） | 只有 `tts.audio` 单向"发"；`stop` 只能靠宿主不再发 | ❌ **必须新增 `playback.control`** |
| **会话切换**（结束语音会话/唤醒） | `session.end` 只有上行；`voice.listen` 不存在 | ❌ **必须新增 `session.ended`（下行）+ `voice.listen`（下行）** |
| **设置**（音色/免按住/缩放） | 音色只有上行 `voice.select`；免按住/缩放是页面 localStorage + DOM | ❌ **必须新增 `device.config`（下行）** |
| **手势** | `tap` 全通，`swipe` 宿主丢弃；无"点完成页某行"的命中类型 | ⚠️ `swipe` 要么实现、要么在协议里标注保留；"跳段"用 `playback.control` 而不是新 tap 类型 |

### 2.5 手势与动作按钮全集（现状）

页面能发出的 `actionId`（`page.ts` 里写死的，全部经 `screen.gesture{tap,hit:'action'}`）：

| 屏 | 按钮 / id | 宿主处理（`lane.ts`） |
|---|---|---|
| 完成 | `stop` / `replay` / `taskBoard` | `:3115-3119` / `:3028-3045` / `:3012-3016` |
| 进度 | `taskStop` / `taskBoard` | `:3074-3078` / `:3012-3016` |
| 回执 | `taskOpen` / `taskCancel` | `:3064-3068` / `:3069-3073` |
| 待决策 | `taskAnswer1` / `taskAnswer2` / `taskBoard` | `:3046-3063` / `:3012-3016` |
| 追问 | `pick1` / `pick2` / `pickNone` | `:3079-3101` |
| 澄清 | `pick1` / `pick2` | `:3079-3101`（先判 `pendingClarify`） |
| 通用 | `boardPrev` / `boardNext` / `send` / `retry` / `taskBoard` | `:3017-3027` / `:3102-3114` |

**没有的按钮（本轮要补）**：`pause`、`resume`、`segPrev`、`segNext`、`follow`、`doneLine`。

---

## 3. 屏幕清单（设备端现在有哪几屏）

帧构造函数全在 `src/tihu/task-screens.ts`；帧的落地全在 `lane.ts`，页面只按 `screen.frame` 的字段选版式（`page.ts:941-1028`）。

| # | 屏 | 触发 | 帧来源 | 返回方式 |
|---|---|---|---|---|
| 1 | **任务棋盘** | 开机 hello、回主页、撤单后、待决策到点、回执 5 秒后（无在跑） | `boardFrame`（`task-screens.ts:22`）+ `sendBoard`（`lane.ts:4228-4249`） | 点行开详情；`boardPrev/boardNext` 就地翻页；说「回棋盘」/点主页 |
| 1e | 棋盘空态 | 任务为 0 | 同一 `boardFrame`，`board.empty=true` | 同上（不另开屏） |
| 2 | **派单回执** | `showReceipt`（`lane.ts:5286-5336`） | `receiptFrame`（`:34`），`RECEIPT_SECONDS=5`（`:19`） | 5 秒后自动分流：在跑→进度、完成→完成页、待决策→决策页、仍排队→棋盘（`:5309-5333`）；「看任务」「撤单」；任何交互取消计时 |
| 3 | **在听 · 已唤醒** | 页面本地：唤醒词命中 / `#wake` 开关 / 长按 | **无帧**，页面 `listen-on` 覆盖层（`page.ts:1829-1855`） | 说满一句停 3 秒自动发送；10 秒没说话退出；任何 `screen.frame` **不会**擦掉它（`applyScreenClass` `:602-610`） |
| 4 | **任务详情（进度）** | 点棋盘行、回执「看任务」、`followRunningTask`（只在真 `turn/start` 后） | `detailFrame`（`task-screens.ts:335`）+ `showDetail`（`lane.ts:5172-5185`）/ `taskDetailFrameOf`（`:5019-5047`） | 「停止」「主页」；每秒重画；30 秒无进度看门狗 `TIHU_PROGRESS_STALE_MS`（`:5215-5266`）；`turn/end` 后 `leaveStaleProgress` 回棋盘（`:4593-4602`） |
| 5 | **待决策** | 宿主 `approval/request` 或 `user-questions/request` 挂起且托管未开（`lane.ts:4392-4500`） | `decisionFrame`（`task-screens.ts:426`）/ `showDecision`（`lane.ts:5152-5169`） | 点选项＝`answerPendingDecision` 交回宿主；60 秒到点按默认项（审批默认 **拒绝**，`pending-interactions.ts:41-49`）；「主页」不替你答 |
| 6 | **完成（播报）** | 任务 done、`showDone`（`lane.ts:5126-5149`） | `doneFrame`（`task-screens.ts:376`） | 「停止」「重读」「主页」；读完 + 60 秒自动回棋盘（`armScreenHome` `:4617-4635`） |
| 7 | **歧义追问** | 派单落点不确定（`askWhich` `:5931`） | `askWhichFrame`（`task-screens.ts:456`） | `pick1/pick2/pickNone`；只问一次 |
| 7b | **会话衔接澄清** | 灰区且指挥台也给不出结论 | `clarifySessionFrame`（`:491`） | `pick1/pick2`（新建/接着） |
| 8 | **提示屏** | 撤单、停止、错误、电脑端未开跑等 | `noticeFrame`（`:520`） | 「主页」或下一次派单覆盖 |
| 9 | **错误屏** | 输入失败 `showInputError`（`lane.ts:2319-2329`）、派单建不起会话 `showDispatchStuck`（`:2339-2349`） | 内联 `ScreenFramePayload` | 重新说 / 回棋盘 |
| 10 | **空闲** | 页面「结束本次语音会话」后（`page.ts:2085-2091`） | **纯页面 DOM**，不经宿主 | 下一次 `screen.frame` 覆盖 |

**判定规则**（页面 `renderScreen`，`page.ts:941-1028`）：`payload.board` → 棋盘；`payload.done` → 完成页；其余 → 状态屏（含回执/进度/待决策/追问/提示/错误）。旧 `mode:'home'|'reply'` 且无 `board` 的帧**被直接丢弃**（`:949`）。

### 3.1 每屏的"进入所需数据"（工具要读的真相源）

| 屏 | 工具读什么判断"设备现在在这屏" |
|---|---|
| 棋盘 | `device.onBoard === true` + `device.screenStage === ''` |
| 回执 | `device.receiptTimer !== undefined` + `focusedTask` |
| 进度/完成/待决策 | `device.screenStage ∈ {'进度','完成','待决策'}` + `device.focusedTask` |
| 在听 | 宿主**不知道**（页面本地）→ 必须新增 `device.ack` / `playback.state` 上报 |

### 3.2 本地手势/播放控制：页面能做到哪、还缺什么

| 用户动作 | 页面本地能做到 | 还差什么 | 谁必须下发 |
|---|---|---|---|
| **停止朗读** | 点完成页「停止」→ `stopPcm()` 清空队列（`page.ts:2017-2018`） | 宿主侧没有任何消息能触发 `stopPcm` → 模型调 `stop_speaking` 只掐后续合成 | 新增 `playback.control{action:'stop'}` |
| **重读** | 点「重读」→ `stopPcm()` + `state.done.current=0` + `paintDone()`（`:2023-2029`） | 宿主 `replay` 只重念"播报短句"，不重发完成帧、不重置高亮 | 新增 `playback.control{action:'seek',segment:1}` + 宿主重发正文 |
| **回主页** | 点「主页」→ 只发 tap（`:2032`） | 屏由宿主换；页面不清本地完成态（`state.done`） | 宿主已有 `sendBoard`（够用） |
| **翻页** | 点「上一页/下一页」→ 发 tap | 页码由宿主持有；`browse` 不夹上限 | 宿主已有（需修夹页） |
| **点选**（棋盘行） | 发 tap `hit:'task'` | 宿主 `openTask` 已实现 | 宿主已有 |
| **答待决策** | 点选项 → 发 tap `taskAnswerN` | 没有"按文本答"的上行；也没有"宿主替我答"的下行 | 新增 `task.reply{optionText}` + 工具走 `answerPendingDecision` |
| **结束语音会话** | 发 `session.end` + 本地画空闲 | 宿主回的是**棋盘**（`lane.ts:2971`），不是空闲；页面完成态不清 | 新增下行 `session.ended` |
| **唤醒/进入在听** | 只有页面自己（唤醒词/`#wake`） | 宿主无任何通路（工具调不了） | 新增 `voice.listen` |
| **暂停/继续** | ❌ 没有 | 无按钮、无消息、无状态 | 新增 `playback.control{pause/resume}` |
| **跳到第 N 段** | ❌ 没有 | 只能从头 | 新增 `playback.control{seek}` |
| **设置音色** | 页面下拉 → `voice.select` | 宿主无法主动下发（只能在配置里改默认，重启/重连才生效） | 新增 `device.config` |

---

## 4. 设计原则

1. **一句话 → 一个具名工具**。模型不该先学 `action` 字符串再学参数；名字本身就是意图（`tihu_stop_speaking`）。`action` 字符串只保留给"未知动作"的报错兜底，不再作为对外契约。
2. **一次只动一台设备**（`deviceId` 可选，缺省按 §9.2 解析），除 `tihu_go_home` 的 `all:true` 与 `tihu_status` 的全局视图。
3. **回执可验证**：所有"改变设备状态"的工具，下发时带 `opId`，等设备 `device.ack{opId,ok,stage,...}`，**1.5 秒**没回执就降级返回「已下发，设备未确认」。返回给模型的文本必须包含**设备自报的当前屏/段落**，而不是宿主的猜测。
4. **幂等**：同一 `opId` 重复到达 → 页面回 `ok:true,duplicate:true`；工具重复调用同一目标已达成的动作 → 返回 `already-*` 文案，不发第二次。
5. **一个真相源**：屏状态仍以 `screen.frame` + `device.screenStage` 为准；播放状态新增 `playback.state` 上报（页面唯一写者），工具只读。
6. **危险动作显式确认**：`tihu_archive_session` 沿用 `confirm=true`（`control.ts:409-420`）；`tihu_dismiss_decision` 的 `default` 分支要在返回文案里写明"按 X 走了"，因为它是替用户拍板。
7. **触屏与语音等价**：每个工具的实现必须复用页面按钮走的那条宿主路径（`runScreenCommand` / `openTask` / `answerPendingDecision` / `sendBoard`），保证"手指点"和"嘴说"效果逐字节一致。

---

## 5. 工具清单（15 条）

> 约定：所有工具都在同一命名空间前缀 `tihu_`；`deviceId` 统一可选（缺省见 §9.2）；返回文本统一格式 **`<结果> · <设备号> · <设备回执>`**。
> **依赖消息**列里：`[旧]` = 现有协议够用；`[新]` = 本轮必须新增（见 §6）。

### A. 播放控制（4）

#### 5.1 `tihu_stop_speaking` — 立即停止当前朗读

- 入参

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `deviceId` | string | 否 | 最近活跃 | 设备 id 或页面 `clientId` |
| `scope` | `'round'` \| `'all'` | 否 | `'round'` | `round`=只停本轮正文/播报；`all`=连排队中的播报一起清 |
| `reason` | string | 否 | — | 只进日志（"用户说停止阅读"） |

- 依赖消息：`[旧]` `speakEpoch` 熔断（`lane.ts:1064-1069`）；`[新]` 下行 `playback.control{action:'stop',opId,scope}`、上行 `device.ack`
- 设备端行为：`stopPcm()`（清空 `pcmSources`、`pcmNextTime=0`）→ 记录"停在第 N 段第 M 行"→ 屏不动（停声不换屏）→ 回 ack
- 失败与边界：
  - 设备离线 → 抛「设备不在线」+ 建议 `tihu_status`
  - 本来就没在朗读 → `ok:true,idle:true`，返回「本来就没在朗读」，**不算失败**
  - 正在等用户决策 → 允许停声（待决策屏无朗读）；倒计时不动
  - 多台在线未指定 → 只停最近活跃那台，返回里写清 deviceId
- 返回给模型：`已停止朗读 · d-8f21 · 停在 完成 第 3/12 行`（无回执时：`已下发停止（设备未回执，可能卡住） · d-8f21`）
- `page.ts` 要点：`handle()` 新增分支调 `applyPlayback('stop')`；`stopPcm()` 里补 `state.pausedAt={segment,charStart}` 并上报 `playback.state`

#### 5.2 `tihu_pause_speaking` — 暂停（保留位置）

- 入参：同 5.1（无 `scope`）
- 依赖消息：`[新]` `playback.control{action:'pause'}`、`device.ack`
- 设备端行为：`stopPcm()` + 记住 `pausedAt`（段号 + 该段 `charStart`）→ **段级**续播（说明见 §9.5）
- 失败与边界：没在朗读 → `already-idle`；已在暂停 → `already-paused`（幂等）；宿主重启/设备重连后 `pausedAt` 丢失 → 返回「暂停位置已失效，用 tihu_replay 从头」
- 返回：`已暂停 · d-8f21 · 完成 第 3/12 行（继续时从本行开头念）`
- `page.ts` 要点：`applyPlayback('pause')`；`paintDone` 保持当前行高亮不推进

#### 5.3 `tihu_resume_speaking` — 继续

- 入参：`deviceId`
- 依赖消息：`[新]` `playback.control{action:'resume',from:{taskId,segment}}`；之后宿主重发 `tts.audio`（带 `read:'done'` + `charStart/charEnd`）
- 设备端行为：页面收到 resume → 若本地有 `pausedAt` 用它，否则用 `from`；宿主从该段起续发 PCM（**不是**采样级续接）
- 失败与边界：没有暂停点 → 返回「没有可继续的朗读，用 tihu_replay 重读」；任务已归档/完成页已离开 → 同上
- 返回：`已从第 3 行继续 · d-8f21`
- `page.ts` 要点：`applyPlayback('resume')` + 与宿主段号对齐（`state.done.current` 由 `from.segment` 设）

#### 5.4 `tihu_replay` — 从头重读（可指定段/卡）

- 入参

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `deviceId` | string | 否 | 最近活跃 | |
| `taskId` | string | 否 | 当前屏上的任务 | `t1` / `t7` / 序号 |
| `segment` | number | 否 | 1 | 从完成页第几段（1 起）开始念 |
| `line` | number | 否 | — | 与 `segment` 互斥；按完成页第几行定位段 |
| `force` | boolean | 否 | `false` | 正文还在读历史时是否打断重试 |

- 依赖消息：`[旧]` `showDone` + `readDoneBody`（`lane.ts:5126-5149`、`4868-5007`）；`[新]` `playback.control{seek}`、`device.ack`、`playback.state`（回报念到第几段）
- 设备端行为：重发完成帧（`done.current = segment-1`）→ `stopPcm()` → 从该段起逐段下发；页面高亮跟着真实播放走
- 失败与边界：
  - 没有已完成任务 → 「现在没有可重读的结果」（`lane.ts:6738` 同口径）
  - `segment` 越界 → 夹到 `[1, 总段数]` 并在返回里说明
  - 正在跑的任务 → 明确拒绝：「这条还在跑，只有完成页能重读」
- 返回：`正在重读「青年基金申请书 · 改写第 3 段」第 1 段（共 7 段） · d-8f21`
- `page.ts` 要点：`renderDone` 接受 `done.current` 初值；`playPcm` 从指定段起排程；`state.doneRanges` 不变

### B. 屏幕导航（4）

#### 5.5 `tihu_go_home` — 回到主页（棋盘）

- 入参

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `deviceId` | string | 否 | 最近活跃 | |
| `all` | boolean | 否 | `false` | 所有在线设备一起回 |
| `stopSpeaking` | boolean | 否 | `true` | 回主页默认同时停朗读（用户说"回到主页"通常就是要安静） |
| `page` | number | 否 | 0 | 回第几页（0 起） |

- 依赖消息：`[旧]` `sendBoard(device, resetPage)`（`lane.ts:4228-4249`）+ `noop` 计时器清理；`[新]` `playback.control{stop}`（当 `stopSpeaking`）、`device.ack`
- 设备端行为：清回执/追问/详情状态（`sendBoard` 内已做）→ 停声 → 推棋盘帧 → 页码回 0
- 失败与边界：
  - 已在棋盘 → `already-home`（仍返回当前计数，便于确认）
  - 正在待决策 → 允许回棋盘，**但不替你答**，倒计时继续；返回里提示「还有 1 条待决策在等你」
  - 设备离线 → 错误文案
- 返回：`已回主页 · d-8f21 · 棋盘第 1/2 页（等你 1 · 在跑 2 · 排队 0 · 完成 3）`
- `page.ts` 要点：无需新分支（`screen.frame` 天然换屏）；但要保证 `stopPcm` 由 `playback.control` 触发，而不是靠"帧变了自然停"（后者不成立）

#### 5.6 `tihu_board_page` — 棋盘翻页（上一页/下一页/指定页）

- 入参

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `deviceId` | string | 否 | 最近活跃 | |
| `direction` | `'prev'`\|`'next'` | 否 | `'next'` | 与 `page` 二选一 |
| `page` | number | 否 | — | 0 起；越界自动夹 |

- 依赖消息：`[旧]` `device.boardPage` + `sendBoard`（`lane.ts:4228-4249`）；`[新]` `device.ack`（可选，屏帧本身可验证）
- 设备端行为：就地换页（不重排任务、不派单），页码夹到 `[0,total-1]`
- 失败与边界：只有 1 页 → `single-page`，返回「棋盘只有 1 页」；已在最后一页按 next → 停在末页并说明（**现在的 `browse` 会无限加页码**，必须修）
- 返回：`棋盘第 2/3 页 · d-8f21`＋该页 4 行「序号. 任务名（胶囊）」
- `page.ts` 要点：无（页面已发 `boardPrev/boardNext`，共用同一宿主函数）

#### 5.7 `tihu_open_task` — 打开某张卡的详情

- 入参

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `deviceId` | string | 否 | 最近活跃 | |
| `taskId` | string | 否 | — | 任务短号 `t3` / 纯数字 `3` |
| `index` | number | 否 | — | 当前棋盘页上第几行（1 起） |
| `title` | string | 否 | — | 标题关键词（精确 > 前缀 > 包含） |
| `recent` | boolean | 否 | `false` | 最近一条已完成（替代旧 `open_recent`） |

- 依赖消息：`[旧]` `openTask`（`lane.ts:5191-5209`，按状态分流：完成→完成页 / 待决策→决策页 / 其它→进度页）
- 设备端行为：立即切屏（不等下一轮同步）；完成页是否会朗读取决于 `showDone(speak)`
- 失败与边界：`taskId` 不存在 → 列前 5 条 + 报错；多条标题命中 → 返回候选清单让模型追问（复用 `matchTaskRows`，`control.ts:211-225`）；任务已归档 → 「这条任务已归档，没有详情」
- 返回：`已打开 t3「改写第 3 段」（执行中）的进度页 · d-8f21`
- `page.ts` 要点：无新分支（`screen.frame`）

#### 5.8 `tihu_follow_task` — 跟随一条正在跑的任务

- 入参

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `deviceId` | string | 否 | 最近活跃 | |
| `taskId` | string | 否 | — | 不填＝跟随当前屏上那条 |
| `until` | `'done'`\|`'turn'` | 否 | `'done'` | `turn`=本轮结束就回棋盘；`done`=任务完成为止 |
| `autoHome` | boolean | 否 | `false` | 结束后是否自动回棋盘 |

- 依赖消息：`[旧]` `followRunningTask`（`lane.ts:4299-4320`，**只在真 `turn/start` 后允许**）+ `ensureDetailTicker`；`[新]` 无（纯宿主状态）
- 设备端行为：把 `device.focusedTask` 钉在这条任务上，进度页每秒刷「已用/tokens/最新状态行」；`onBoard=false`
- 失败与边界：
  - 任务不在跑（queued/done/awaiting）→ 按状态改为打开对应屏（回执/完成/决策），并说明「这条不在跑，给你看 X 页」
  - 任务结束 → `until='turn'` 时回棋盘；`until='done'` 时留在完成页（不朗读）
  - 已被用户手动切走（`focusedTask` 变了）→ 不抢屏，返回「用户已经切走，未跟随」
- 返回：`已跟随 t3「改写第 3 段」 · d-8f21 · 当前 第 7 步 · 已用 1m23s`
- `page.ts` 要点：无（进度帧）

### C. 会话 / 唤醒（2）

#### 5.9 `tihu_end_voice_session` — 结束本次语音会话

- 入参：`deviceId?`、`reason`（默认 `'电脑端指令'`）
- 依赖消息：`[旧]` `session.end` 的宿主语义 `endSession()`（`lane.ts:2017-2022`、`2957-2973`）；`[新]` 下行 `session.ended{sessionId,reason,at}`、`device.ack`
- 设备端行为：**关闸门**（后续工具调用不再被当成"鹈鹕语音轮"限制）→ 页面收到 `session.ended` 后画「空闲 · 已结束本次会话」并清本地完成态 → 不自动回棋盘（屏留在原地或按 `returnTo`）
- 失败与边界：
  - 本来没有活跃窗口 → `already-idle`，返回「当前没有进行中的语音会话」（幂等）
  - 正在朗读 → 同时停声（"结束会话"隐含安静）
  - 结束后用户再说话 → 照旧开新窗口（与页面按钮一致）
- 返回：`已结束本次语音会话（闸门关闭） · d-8f21 · 屏停在 空闲`
- `page.ts` 要点：新增 `session.ended` 分支 → 抽 `renderIdle(reason)`（现在这段逻辑写死在 `#end` 的 onclick 里，`:2085-2091`）；清 `state.done/doneRanges`

#### 5.10 `tihu_wake` — 唤醒 / 进入「在听 · 已唤醒」

- 入参

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `deviceId` | string | 否 | 最近活跃 | |
| `prompt` | string | 否 | — | 屏上那行小字（如「我在，说吧」）；不填用默认 |
| `timeoutMs` | number | 否 | `10000` | 多久没人说话自动退出（夹 3000–60000） |
| `stopSpeaking` | boolean | 否 | `true` | 播报中唤醒＝先停再听（与设计 §8.1「再叫一次可打断」一致） |

- 依赖消息：`[新]` 下行 `voice.listen{on:true,prompt,timeoutMs,opId}`、上行 `device.ack`、上行 `playback.state{phase:'listening'}`；`[旧]` 录音/ASR 链路（`audio.frame`）+ `text.input`
- 设备端行为：显示 `listen-on` 覆盖层（`page.ts:360-368` 的 `#listen`）→ 开麦 → 末字静音 3 秒自动发 `text.input` → 10 秒无人说话自动退出
- 失败与边界：
  - **真机（ESP32）固件本地唤醒词，宿主无法代按**：返回必须写「已通知页面进入在听；真机需固件支持 `voice.listen`，否则只在模拟页生效」
  - 浏览器未授权麦克风 → `ok:false,reason:'mic-denied'`，返回「设备没有麦克风权限」（页面 `page.ts:1469` 的 capabilities 里 `microphone` 为假时直接拒绝）
  - 已在听 → `already-listening`（幂等，只更新 prompt/timeout）
- 返回：`已进入在听（10 秒无人说话自动退出） · d-8f21`
- `page.ts` 要点：`listenBegin/listenEnd`（`:1829-1855`）抽成可外部调用的 `listenEnter({prompt,timeoutMs})` / `listenExit()`，`wake` 按钮与唤醒词共用；`device.ack` 带 `listening:true`

### D. 待决策（2）

#### 5.11 `tihu_answer_decision` — 回答屏上的选择

- 入参

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `deviceId` | string | 否 | 最近活跃 | |
| `taskId` | string | 否 | 当前屏上那条 | |
| `index` | number | 否 | — | 1 起（屏上按钮序号） |
| `text` | string | 否 | — | 选项文本（精确 > 包含）；与 `index` 二选一 |
| `by` | string | 否 | `'电脑端指令'` | 写进登记簿 `answeredBy` |

- 依赖消息：`[旧]` `answerPendingDecision(taskId,index,by)`（`lane.ts:4517-4526`）+ `task.answer`；`[新]` `task.reply{optionText}`（供真机按文本答）、`device.ack`
- 设备端行为：与屏上点 `taskAnswer1/2` **完全同一条路**：settle 掉挂着的 host `pendingInteraction`（`bridge.resolve(decision.answerOf(index))`）→ 登记簿标已答 → 离开待决策屏 → 回棋盘
- 失败与边界：
  - 没有待决策 → 返回「当前没有待决策」+ 若有其它任务的 `awaiting` 一并列出
  - `index` 越界 → 报错并列出真实选项（**不要静默夹到最后一个**，那是替用户选）
  - `text` 匹配不到 / 命中多个 → 返回选项清单让模型追问
  - 设备离线但电脑端还挂着 → 仍可答（走宿主管道），返回里注明「设备不在线，已在电脑端作答」
  - 已被超时/其它设备答过 → `already-answered`，返回实际选项与 `answeredBy`
- 返回：`已选「拒绝」（第 2 项） · t3 · d-8f21`
- `page.ts` 要点：无（宿主答完会推新帧）；若要支持"屏上直接显示已答"可选加 `task.update`

#### 5.12 `tihu_dismiss_decision` — 拒绝 / 按默认项了结 / 交回电脑端

- 入参

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `deviceId` | string | 否 | 最近活跃 | |
| `taskId` | string | 否 | 当前屏上那条 | |
| `mode` | `'default'`\|`'reject'`\|`'delegate'` | 否 | `'default'` | `default`=按 `defaultIndex` 立即了结；`reject`=若选项里有"拒绝/取消/否"就选它，否则报错；`delegate`=还给电脑端卡片（`bridge.delegate`） |

- 依赖消息：`[旧]` `settlePendingDecisionDefault`（`lane.ts:4528-…`）、`bridge.delegate`（`:4435-4456`）；`[新]` `device.ack`
- 设备端行为：`default` = 与 60 秒到点完全一致（`answeredBy='电脑端按默认项'`）；`delegate` = 设备屏退出待决策、电脑端卡片继续等
- 失败与边界：`reject` 但选项里没有否定项 → 报错，**绝不猜**；`delegate` 时设备离线 → 返回「设备本来就不在线，电脑端卡片一直在等」（幂等）
- 返回：`已按默认项「拒绝」了结（等同 60 秒超时） · t3 · d-8f21`
- `page.ts` 要点：无

### E. 状态查询（2）

#### 5.13 `tihu_status` — 设备现状（在线/当前屏/在读哪段/棋盘计数/在听/待决策）

- 入参

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `deviceId` | string | 否 | **全部** | 不填则返回所有设备一行一条 |

- 依赖消息：`[旧]` `deviceStatus`（`lane.ts:6667-6680`，需修假字段）+ `boardOf`（`task-ledger.ts`）+ `pendingBridges`；`[新]` `playback.state`（页面自报"在读哪屏哪段、暂停/停止/在听"）、`device.ack`
- 返回给模型（单台）：

```
设备 d-8f21（clientId 3f9c…）· 在线 42 分钟 · 最近活跃 3 秒前
绑定：鹈鹕指挥台 session-…（统一指挥）
屏：完成 · 第 3/12 行 · 「青年基金申请书 · 改写第 3 段」
播放：朗读中 · 第 3 段 / 共 7 段 · 已念 18 字（进度 41%）
棋盘：等你 1 · 在跑 2 · 排队 0 · 完成 3（第 1/2 页）
待决策：t5「删掉 3 个旧结果文件？」（还有 42 秒，不选按「确认删除」）
音色：edge zh-CN-YunjianNeural · 免按住 开
```

- 失败与边界：零在线 → 「当前没有鹈鹕设备在线」+ 打开 `/tihu` 的指引；`deviceId` 不存在 → 列在线 id
- `page.ts` 要点：新增 `playback.state` 上报（每段开始/结束、pause/resume/stop、listen 进出），宿主缓存成 `device.playback`
- **必须修的假字段**：`deviceStatus` 里 `speaking:false`、`pending:[]` 是占位（`lane.ts:6676-6677`），要么删掉这两个字段，要么接真实数据

#### 5.14 `tihu_list_devices` — 列在线设备

- 入参：`includeOffline`（boolean，默认 `false`；离线设备只在最近 10 分钟见过时列出）
- 依赖消息：`[旧]` `listDevices`；`[新]` 设备增加 `lastSeenAt` / `connectedAt` 字段
- 返回：每台一行 `d-8f21 · 最近活跃 3s · 完成 3/12 · 朗读中`
- 失败与边界：零在线给指引；两台以上时提示「默认控制最近活跃的那台，要指定就传 deviceId」
- `page.ts` 要点：无

### F. 设置（1，建议有条件暴露）

#### 5.15 `tihu_device_settings` — 音色 / 免按住 / 缩放

- 入参

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `deviceId` | string | 否 | 最近活跃 | |
| `key` | `'voice'`\|`'handsfree'`\|`'scale'` | 是 | — | 见 §5.16 建议 |
| `value` | string \| boolean | 是 | — | voice=音色名或 `zh-CN-*Neural`；handsfree=bool；scale=`1`\|`2`\|`actual` |

- 依赖消息：`[新]` 下行 `device.config{key,value,opId}`、`device.ack`；`voice.select` 仍是上行（页面→宿主），本工具走反向
- 设备端行为：voice→`device.voice/edgeVoice` 立即生效（后续合成用新音色）；handsfree→页面开关唤醒词聆听；scale→只改模拟页显示
- 失败与边界：音色名不在清单（`src/tihu/cloud-voices.ts`）→ 报错并给 4 个合法值；真机上 `handsfree`/`scale` 可能不支持 → 返回 `unsupported`
- 返回：`音色已切到 云健（zh-CN-YunjianNeural） · d-8f21`
- `page.ts` 要点：新增 `device.config` 分支：`voice` 只更新下拉显示（真正生效在宿主合成侧）、`handsfree` 调 `wakeStart/wakeStop`（`:1925-1960`）、`scale` 调 `applyScale`（`:1603-1611`）

### 5.16 设置类是否值得暴露给模型 —— 建议

| key | 建议 | 理由 |
|---|---|---|
| `voice` | ✅ 暴露 | 用户会说「换个声音」「用晓晓念」，且宿主已有权威清单（`cloud-voices.ts`），失败可校验 |
| `handsfree`（免按住） | ⚠️ **暴露但标 experimental** | 模拟页是浏览器 `SpeechRecognition`，真机是固件本地唤醒；宿主下发只能影响模拟页，容易让用户以为"真机也开了" |
| `scale`（1×/2×/实际尺寸） | ❌ **不暴露** | 纯模拟页显示调试，和"设备行为"无关；模型误调只会让用户看到屏变大变小 |

**结论**：`tihu_device_settings` 保留一个工具，但 `key` 的枚举只给 `voice` / `handsfree`，`scale` 写进"内部/调试专用"注释，工具描述里不出现。

### 5.17 保留不动的六条（非设备控制，只改名）

| 工具名（新） | 旧 action | 说明 | 是否属"设备控制" |
|---|---|---|---|
| `tihu_task_progress` | `progress` | 查一条会话跑到第几步/速度/上下文 | ❌ |
| `tihu_list_sessions` | `list_sessions` | 标题模糊匹配会话 | ❌ |
| `tihu_archive_session` | `archive` | 删会话（`confirm=true` 红线不变） | ❌ |
| `tihu_dispatch` | `dispatch` | 派单，指挥台唯一动手方式 | ❌ |
| `tihu_list_tasks` | `list_tasks` | 登记簿 | ❌ |
| `tihu_cancel_task` | `cancel` | 撤未起跑任务 | ❌ |

**合计模型可见工具：15（设备控制，含 1 个设置）+ 6（非设备）= 21 个。** 21 个全局工具偏多，见 §10 第 1 问的三个选项。

---

## 6. 必须新增的宿主 ↔ 设备消息

协议仍守「版本不变、字段只增、未知忽略」。以下 6 类是本轮**必须**加的，否则 §5 里 6 个工具只能是假动作。

### 6.1 下行（宿主 → 设备，4 类）

| type | payload | 用途 | 页面必须做的 |
|---|---|---|---|
| `playback.control` | `{ opId, action:'stop'\|'pause'\|'resume'\|'seek', scope?:'round'\|'all', from?:{taskId?,segment?,line?}, epoch? }` | 停/暂停/继续/跳段 | `applyPlayback()`；`stopPcm()` / 重置 `done.current`；回 `device.ack` |
| `voice.listen` | `{ opId, on:boolean, prompt?:string, timeoutMs?:number }` | 强制进入/退出「在听 · 已唤醒」 | 调 `listenEnter/listenExit`；回 ack（含 `listening`） |
| `session.ended` | `{ sessionId, reason, at }` | 结束语音会话后让页面自己画「空闲」并清完成态 | 抽 `renderIdle()`；清 `state.done/doneRanges` |
| `device.config` | `{ opId, key:'voice'\|'handsfree'\|'scale', value }` | 音色/免按住/缩放同步 | 更新下拉；`wakeStart/wakeStop`；`applyScale` |

`screen.frame` 同时**加两个可选字段**：`opId`（工具级幂等键）与 `frameSeq`（设备回执时回声）。旧固件不认就忽略，不破坏兼容。

### 6.2 上行（设备 → 宿主，2 类）

| type | payload | 用途 | 宿主必须做的 |
|---|---|---|---|
| `device.ack` | `{ opId, ok:boolean, reason?:string, duplicate?:boolean, stage?:string, screenVersion?:number }` | **回执可验证**的唯一手段 | `opId → resolve` 挂一张 1.5 秒超时的 Promise；工具返回里带上 `stage` |
| `playback.state` | `{ phase:'idle'\|'playing'\|'paused'\|'listening', taskId?, segment?, line?, total?, charStart? }` | 让宿主知道"在读第几段/暂停在哪/是否在听"（页面是唯一写者） | 缓存到 `device.playback`，供 `tihu_status` 读；`speaking` 不再靠猜 |

### 6.3 复位/重连

`hello` 之后设备必须补发一条 `playback.state{phase:'idle'}` 与 `device.ack` 快照（或一条 `device.state`），让宿主丢弃"上一轮连接留下的朗读/待决策假设"。否则断线重连后 `tihu_status` 会报旧的"朗读中"。

---

## 7. `page.ts` 必改函数（8 处）

| # | 函数/位置 | 改什么 | 为什么 |
|---|---|---|---|
| 1 | `handle()`（`page.ts:1477-1594`） | 新增 4 个 case：`playback.control` / `voice.listen` / `session.ended` / `device.config`；未知 type 仍忽略 | 现在这 4 类消息到了页面**没有任何反应** |
| 2 | 新增 `applyPlayback(action, meta)` | 从 `endDrag` 里的 `stop/replay/taskBoard/prev/next` 分支（`:2015-2032`）抽出来 | 同一个动作现在只有"手指点"能触发，宿主下发无法复用 |
| 3 | `stopPcm()`（`:1102-1113`） | 记录停在哪一段（`state.pausedAt={segment,charStart}`），并 `send('playback.state',…)` | 暂停/继续/`status` 都依赖这个位置 |
| 4 | `playPcm()`（`:1180-1262`） | 支持"从第 N 段开始"（seek）；每块带 `opId`；`final` 块后上报 `phase` | 跳段与回执 |
| 5 | `listenBegin/listenEnd`（`:1829-1855`） | 抽成 `listenEnter({prompt,timeoutMs})` / `listenExit()`，供唤醒词、`#wake` 按钮、`voice.listen` 三处共用 | 现在只能页面自己开麦 |
| 6 | `renderDone`（`:866-886`）/ `paintDone`（`:782-806`） | 接受"外部指定 current"（seek 到第 N 段）；`stage` 行显示 `完成 · 3/12` | 重读/跳段要能定点 |
| 7 | `send()`（`:1456-1462`） | 带 `opId`；收到需确认的下行时自动回 `device.ack` | 回执通路 |
| 8 | 新增 `renderIdle(reason)` | 从 `#end` 的 onclick（`:2085-2091`）抽出来 | `session.ended` 与"结束会话"共用一套空闲屏 |

**另外两处小的**：`renderActions`（`:530-542`）要能渲染新按钮 id（`pause/resume/segPrev/segNext/follow`）；`bindScreenGestures` 的 `endDrag`（`:2001-2051`）里对 `actionId` 的判断改调 `applyPlayback`，并补 `doneLine` 命中。

---

## 8. 约定（幂等 / 多设备 / 离线 / 冲突）

### 8.1 同一动作重复触发必须幂等

| 场景 | 宿主侧 | 设备侧 |
|---|---|---|
| 连发两次 `stop` | 第二次直接返回 `already-idle`，不发消息 | 收到重复 `opId` → `ack{ok:true,duplicate:true}`，不重复 `stopPcm` |
| 连发两次 `go_home` | 已在棋盘 → 不发帧，只回读棋盘计数 | 重复帧照常渲染（渲染本身幂等） |
| 连发两次 `replay` | 第二次取消上一轮（`speakEpoch+1`）并从第 1 段重来 | `seek` 是"设到 N"，不是"加 N" |
| 连发两次 `answer_decision` | 第二次返回 `already-answered` + 真正生效的选项 | —（答完屏已经换了） |
| 连发两次 `wake` | `already-listening`，只更新 prompt/timeout | 不重开麦 |

`opId` 建议格式：`<tool>-<randomId()>`（`protocol.ts:684-687` 已有 `randomId`）。页面保留最近 32 个 `opId`。

### 8.2 多台设备：默认只控"最近活跃的那台"

新解析顺序（替换 `control.ts:299-310`）：

1. 显式 `deviceId`（也接受页面 `clientId`，`lane.ts:6653-6654` 已支持）；
2. 绑定到调用方会话的那台（保留旧行为）；
3. **最近活跃的那台**（新增 `device.lastSeenAt`，任何上行走 `handleUpstream` 都刷新，含 `ping` 之外的实质消息）；
4. 唯一在线的那台；
5. 都没有 → 报错并给 `tihu_status` / 打开 `/tihu` 的指引。

并且：**只有"结果广播"类帧可以发多台**（现在 `showReceipt` 就发给所有统一设备，`lane.ts:5298-5335`），**动作类工具一律单台**，唯一例外是 `tihu_go_home{all:true}`。

### 8.3 设备离线

- 任何工具：先判 `findControlDevice(deviceId)`（`lane.ts:6653`）；undefined → 「设备 X 不在线」+ 在线清单。
- 不允许"假装成功"：`stopSpeaking` 现在离线返回的是 `错误：…` 字符串而不是 throw（`lane.ts:6727`），模型读起来像普通结果 → 统一改成 throw，让工具层给出可操作的下一步。
- `answer_decision` 是唯一"设备离线也能做"的：题目挂在宿主会话上，答完返回里注明"已在电脑端作答"。

### 8.4 正在朗读 / 正在等决策时的冲突矩阵

| 当前状态 → 要做的动作 | 停声 | 暂停 | 主页 | 开详情 | 重读 | 答决策 |
|---|---|---|---|---|---|---|
| 朗读中（完成页/播报） | 停声，留在本屏 | 停声，留位置 | 停声 + 回棋盘 | 停声 + 换屏 | 停声 + 从段 1 再念 | 不适用 |
| 待决策（倒计时中） | 静默（本来没声） | `already-idle` | 允许回棋盘，**不替你答** | 允许（但会离开待决策屏，需提示） | 拒绝 | 正常答 |
| 进度页（在跑） | 静默 | `already-idle` | 允许（任务继续跑） | 允许 | 拒绝（只有完成页能重读） | 不适用 |
| 在听 | 退出在听 + 停声 | — | 退出在听 + 回棋盘 | 退出在听 | — | — |
| 回执（5 秒倒计时） | 取消计时，停在回执 | — | 取消计时 + 回棋盘 | 打开详情（=看任务） | — | — |

**总原则**：导航类动作默认"先停声再换屏"（用户说「回到主页」时不会期望设备继续念），但**不默认替用户答决策**。

### 8.5 暂停/继续的粒度（重要限制，要写进工具描述）

页面用 WebAudio 时间轴排程（`page.ts:1218-1262`），`AudioContext.suspend()` 会冻结 `currentTime`，而页面在"未运行"时**直接丢弃**新块（`:1186-1194`），所以**采样级暂停不可靠**。
本轮采用**段级暂停**：暂停＝清空队列并记住"第 N 段第 M 行"；继续＝宿主从该段第一个字重发 `tts.audio`。
代价：继续时本行会**重念这一行**（1–3 秒重复），但绝不跳字、不错位、实现风险低。工具描述必须写明「继续会从本行开头念」。

---

## 9. 与旧工具的差异（迁移清单）

### 9.1 逐条对照

| 旧 action | 新工具 | 处理 | 说明 |
|---|---|---|---|
| `status` | `tihu_status` | **改名 + 重写** | 修 `speaking:false`/`pending:[]` 假字段；加"在读哪屏哪段/在听/待决策/最近活跃" |
| `list_devices` | `tihu_list_devices` | 改名 | 加 `lastSeenAt`、当前屏、是否朗读 |
| `bind` | —（并入 `tihu_open_task`） | **废弃** | 语义已死：它现在就是 `openTask`（`lane.ts:6689-6696`） |
| `open_bubble` | — | **删除** | 固定返回「旧的待读气泡已删除」（`lane.ts:6697`），是纯噪音 |
| `progress` | `tihu_task_progress` | 改名 | 内容是会话进度，不是设备；保留以免破坏"这条跑到哪了"的问法 |
| `list_sessions` | `tihu_list_sessions` | 改名 | 派单承接用 |
| `archive` | `tihu_archive_session` | 改名 | `confirm=true` 红线不变 |
| `stop_speaking` | `tihu_stop_speaking` | **改名 + 修语义** | 必须真的让页面 `stopPcm`，不再只是"以后不发" |
| `replay` | `tihu_replay` | **改名 + 重写** | 从"重念播报短句"改为"重发完成帧 + 从第 1 段（或指定段）念"，并重置高亮 |
| `go_home` | `tihu_go_home` | 改名 | 加 `all`/`stopSpeaking`/`page` |
| `browse` | `tihu_board_page` | **改名 + 改语义** | 旧名暗示"回答历史"，实际是棋盘翻页；新实现要夹页码上限 |
| `open_recent` | —（并入 `tihu_open_task{recent:true}`） | **合并** | 同一个"打开最近完成任务"的语义 |
| `dispatch` | `tihu_dispatch` | 改名 | 逻辑不动 |
| `list_tasks` | `tihu_list_tasks` | 改名 | 逻辑不动 |
| `cancel` | `tihu_cancel_task` | 改名 | 逻辑不动 |
| — | `tihu_pause_speaking` / `tihu_resume_speaking` / `tihu_follow_task` / `tihu_wake` / `tihu_answer_decision` / `tihu_dismiss_decision` / `tihu_device_settings` | **新增 7 个** | 见 §5 |

**净变化**：设备控制类 15 → 15（删 3 / 合并 1 / 新增 7 / 其余改名）；非设备类 4 → 6。旧形态是"1 个工具 + 15 个 action"，新形态是"21 个具名工具"。

### 9.2 迁移时要删的代码

1. `src/tihu/control.ts`
   - `defineAction('bind', …)` `:362-366`、`defineAction('open_bubble', …)` `:368-374`、`defineAction('open_recent', …)` `:443-446`；
   - `TihuControlArgs.index` 与 `normalizeControlArgs` 里的 `index` 分支（`:277`）：只有 `open_bubble` 用它，随之一并删；
   - `resolveControlDevice`（`:299-310`）整段替换为 §8.2 的五级解析；
   - 工具描述里那句过期话「棋盘固定最近 5 条，browse 已无翻页」（`:566`）；
   - `TIHU_CONTROL_SECTION_TEXT`（`:498`）要补一句"设备动作类工具必须等回执"。
2. `src/tihu/lane.ts`
   - `control` 面里 `openBubble` 占位（`:6697`）、`bind`（`:6689-6696`）；
   - `deviceStatus` 里 `speaking:false` / `pending:[]`（`:6676-6677`），改为读 `device.playback`；
   - `browse` 的页码不夹上限（`:6751-6761`）；
   - 各方法的"返回错误字符串"统一改成 throw（`:6691`、`:6713`、`:6727`、`:6733`、`:6746`、`:6753`、`:6764`）。
3. `src/tihu/protocol.ts`
   - 新增 §6 的 6 类消息 + `ScreenFramePayload.opId/frameSeq` + `TaskReplyPayload.optionText`；
   - `parseUpstream` 补两个新上行的校验分支（`parseUpstream` `:534-641`，遵守"坏帧返回 null 不抛错"）。
4. `src/tihu/page.ts`
   - 见 §7 的 8 处；
   - 删掉"只有点按才能停声"的隐式约定（`endDrag` 里 `:2015-2018` 的注释与分支要迁进 `applyPlayback`）。
5. `scripts/test-tihu-protocol.mjs`
   - `:2246` 的 action 全集断言改成新 15 条工具名；
   - 新增 6 类消息的解析/构造单测；
   - `:2250` 提示段 ≤120 字断言保留（改文案时同步）。

### 9.3 不需要删、但要在文档里降级说明的

- `runScreenCommand`（`lane.ts:6470-6524`）与 `task.reply` 的 `command`（`open/board/cancel/stop`）**继续保留**：那是"设备语音说一句"的零模型快路径，和工具是两条并行入口，不要合并（合并会让设备在模型不可用时彻底不能动）。
- `swipe` 手势宿主仍不处理（`lane.ts:3005-3131` 只认 tap）。本轮不动，但在协议注释里标"保留"。

---

## 10. 需要你拍板的三件事

1. **工具形态**（三选一）：
   - **A 全拆**：21 个具名工具（§5 的 15 个 + §5.17 的 6 个）。模型最不容易选错，但全局工具数从 1 涨到 21，每轮系统提示都多一截。
   - **B 只拆设备控制**：15 个设备工具 + 1 个 `tihu_admin`（把 6 个非设备 action 收回去）。折中，推荐。
   - **C 保持单工具**：仍是 `tihu` + 21 个 action。改动最小、测试只改断言，但"停止/回主页"这类高频动作仍要模型先记 action 名。

   拆分会动 `control.ts:554` 的注册方式与 `scripts/test-tihu-protocol.mjs:2246` 的断言，但不改任何设备逻辑。
2. **暂停/继续的粒度**：接受**段级续播**（继续时从本行开头重念 1–3 秒，实现稳、零音频风险），还是要求**采样级无缝**（必须改页面的 WebAudio 时间轴与 `AudioContext` 状态机，风险高）？
3. **多设备与广播边界**：默认"只控最近活跃的那台"是否够用？另外现在**派单回执/完成帧是广播给所有统一设备的**（`lane.ts:5298-5335`），要不要一起改成"只发最近活跃的那台"——改了会出现"第二块屏不同步"的观感，不改则两块屏可能同时说话。

---

## 附：一句话验收标准

> 用户对电脑说「停止阅读」→ 电脑端一个工具调用 → **1.5 秒内**设备停止出声、屏不换 → 工具返回里带着设备自报的「停在 完成 第 3/12 行」；再说「回到主页」→ 屏回棋盘第 1 页、设备不再念、返回里带着棋盘四段计数。任何一步设备没照做，工具返回必须是"未确认/失败 + 原因"，不允许静默成功。
