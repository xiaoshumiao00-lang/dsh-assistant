# 个人秘书「引用不生效」第 3 次：把被引用卡正文**拼进本轮用户消息本体**（2026-11-25）

## 结论一句话

宿主的 `agent/pre-step` waterfall 就是「改这一轮用户消息本体」的合法钩子（`messages` 交出来、返回的
`decision.messages` 原样 append 成 `user/message`），所以这次**真拼进本体**：卡正文全文 + 附件文件名表示 +
四条硬指令，贴在用户原话之后、**同一条用户消息**里连续相邻；10250「本轮必须回答的卡」系统提示段整段撤掉
（同一张卡只留一个载体），引用消耗/过期/会话作用域语义一个没动。

## 0. 现场与纪律

- 仓库 `D:\dsh-assistant`，开工 HEAD `144f192`（本地领先 origin/main 2 条）。**只 commit 不 push**、
  不动 V0 标签、不重启宿主、不 `dev:web`、不碰 hpg 定价与客服制单。
- 只改引用链路：`src/assistant-secretary.ts`（登记/注入）、`scripts/test-assistant-secretary.mjs`（用例）、
  `lib/index.js`（`node build.mjs` 产物）。客户端 store / 卡片组件一个字没动（本轮不需要）。
- 宿主 asar 只读：用自写 asar 头解析按 offset 读，不写回 `D:\deepseek-harness\resources\app.asar`。
- **纪律事故（如实记录）**：`scripts/smoke-secretary-page.mjs` 有两段会往真实秘书会话发消息，纪律禁止，
  所以跑的是禁了「卡片样本」发送的副本 `.tmp/smoke-nosend.mjs`；但**漏禁「插话取证」段**（脚本
  `:2266-2313` 经 `window.__dshPromptIntoSession` 发 `TASK_TEXT` + `INTERRUPT_TEXT`），18:14 实际向
  真实秘书会话发出了 2 条冒烟消息（turn 624，用户卡正文「（冒烟测试）跑任务途中插的那句话：桌面的软件程序
  这件事记一下」）。这是本轮唯一的越界，已在此记录，未再补跑整脚本。

## 1. 宿主钩子取证（能改还是不能改，行号证据）

结论：**能改**，唯一合法点在 `agent/pre-step` waterfall。以下行号都是 asar 里的原始文件行号
（asar 虚拟路径 `D:\deepseek-harness\resources\app.asar\dsh\...`）。

### 1.1 `agent/pre-step`：把这一批被 claim 的 messages 交出来，允许替换

`dsh-agent-loop/lib/index.js`（宿主实际加载的构建产物）：

```
699:  const decision = await this.dispatch.waterfall("agent/pre-step", {
700:    messages: claimed,
701:    ...position,
702:    signal,
703:    modelSelection: selection
704:  }, () => {
705:    const sections = renderContextSections(assembly);
706:    const context = this.runtimeContext.project(sections);
707:    return Promise.resolve({
708:      kind: "enter",
709:      messages: context === void 0 ? claimed : [...claimed, context]
710:    });
711:  });
```

同文件 `:873-880`——**返回的 `decision.messages` 就是会被 append 成 `user/message` 的那批**：

```
873:  let contextAdmitted = false;
874:  if (firstAttempt) for (const message of decision.messages) if (message.source.kind === "runtime-context") {
875:    if (context !== void 0 && !contextAdmitted) {
876:      this.session.append("user/message", context, { surfaceOp: "append" });
877:      contextAdmitted = true;
878:    }
879:  } else this.session.append("user/message", message, { surfaceOp: "append" });
880:  if (context !== void 0 && !contextAdmitted) this.session.append("user/message", context, { surfaceOp: "append" });
```

`:882` 起 `const request = this.buildRequest(...)`，请求是从这份 session surface 派生的 —— 所以改
`decision.messages[i].content` 等于改「这一轮模型真正读到的那条用户消息」，不是另塞一条 system 消息。

类型契约在 `dsh-agent/src/runtime-types.ts`：

```
139: /** Whether and with which messages the loop enters a proposed step. */
140: export type PreStepDecision =
141:   | { kind: 'reject' }
142:   | {
143:     kind: 'enter'
144:     messages: UserMessage[]
...
341:     * Reject a proposed step or replace the messages that enter it. Calling
342:     * `next()` preserves the current messages.
...
352:     'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal; modelSelection: Readonly<ModelSelection> }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
```

宿主自己的插件也是这么用的（`dsh-agent/src/model-selection.ts:158-174`：`next()` 之后
`return { ...decision, messages: [...decision.messages, modelSwitchNotice(...)] }`），说明「pre-step 里
改/加 user 角色消息」是被设计支持的用法，不是钻空子。

`dsh-agent-loop/README.zh.md:121` 也写了这条链路：「驱动器组装提示词与工具，并运行 `agent/pre-step`；
fallback 在监听器执行后投影运行时上下文……仅在首次尝试追加已接纳的 `user/message` 批次」。

### 1.2 其它三条通道为什么不算数

1. **`conversation.input` 槽**：`dsh-client-ui-conversation/src/client/contract/slots.ts:307-322` 里
   `'conversation.input.dock'` / `'conversation.input.overlay'` / `'conversation.input.left'` 全是
   `{ kind: 'list'; scope: 'session' }` 的**客户端 UI 挂载点**（`docs/subsystems/slots.zh.md:190-200` 的
   composer 槽树：attachments/permission/plan/model/overlay/left/dock），只管渲染控件，没有任何消息正文
   的输入输出，改不了本轮用户消息。
2. **`llm/stream`（请求级改写）**：`dsh-llm/src/index.ts:69-77` 明确写着 loop 构建的请求
   **deep-frozen**、「its content is a pure function of the session log … listeners read it, never rewrite
   it」，在请求层改 messages 是被宿主设计禁止的。
3. **系统提示 section（上一轮做法）**：`docs/subsystems/system-prompt.zh.md:47` —— 组装后的段落由
   agent loop 渲染成文本、作为 `system/message` **surface 节点**提交。也就是说 10250 段再晚再长，结构上
   仍然只是「又一条 system 消息」，不是这一轮那条 user 消息；17:51 那轮它全文+附件+禁令都在，模型还是
   答成最近那条毕设任务，正是这个结构原因。

→ 所以本轮按用户原话**真拼进本体**，不是退而求其次的「user 前置块」。

## 2. 改动（只落在引用链路）

### 2.1 `src/assistant-secretary.ts`

| 行号 | 改动 |
|---|---|
| 325-329 | 删掉 `SECRETARY_QUOTE_CARD_SECTION_ORDER = 10250`，新增 `QUOTE_MESSAGE_BLOCK_OPEN = '【引用卡｜本轮必须回答的卡（个人秘书）】'`（既给模型边界，也给「已经拼过」的幂等判据） |
| 477 | 1783 登记段末句改口径：正文「已经拼进本条用户消息的正文末尾」，不再是「系统提示最末那一段」 |
| 502-528 | `secretaryQuoteCardBlockText()` 改成**拼进消息**的形态：卡定位（种类/轮次/cardKey）+ 正文全文（`—— 卡正文开始/结束 ——`）+ 附件文件名表示 + 【硬指令】四条（① 优先级最高 ② 忽略与引用无关的最近上下文，含上一条任务/系统通知/待办提醒 ③ 禁止多候选自选 ④ 模糊指代一律指向引用卡）+【附件口径】+「不改变任何派活与工具规则」 |
| 531-543 | 新增 `contentWithQuoteBlock()`：贴到最后一个 text 块后面（没有 text 块就补末尾），附件块顺序不动 |
| 545-578 | 新增 `spliceQuoteIntoUserMessage()` 纯函数：从后往前挑**真实用户消息**（user 角色、有 content、不是插件登记的通知卡、不是 `runtime-context` 快照），用户原话一字不改，卡块贴在其后；带 `QUOTE_MESSAGE_BLOCK_OPEN` 时判幂等，重试不叠加 |
| 968-1027 | `agent/pre-step` 监听改成「先 `next()`，再拼」：只对固定秘书会话、活引用、`decision.kind === 'enter'` 生效；过期即删并落盘；返回 `{ ...decision, messages: spliced }`。只读闸的三分支原样保留（读不到策略→告警放行、非只读→deny、只读→放行） |
| 1126-1129 | 撤掉 `assistant:secretary-card-quote-card` 段（order 10250）的注册与 disposer —— 同一张卡只留一个载体 |
| 1379-1387 | 测试面导出：`QUOTE_MESSAGE_BLOCK_OPEN` / `spliceQuoteIntoUserMessage`；去掉 `SECRETARY_QUOTE_CARD_SECTION_ORDER` |

引用语义未动：`quoteState` 仍按 `sessionId` 存、`QUOTE_TTL_MS` 仍 30 分钟、`turn/end` 用
`quoteConsumedTurn` 收掉、通知轮不算吃掉、只喂 `activeSessionId` 这一条固定秘书会话。1783/1791 两段
系统提示原样保留（只是 1783 末句改成指向消息本体），既有断言（`引用登记只说明`/`不是完整汇报`/
`不许接到最近那条…`等）一条没放宽。

### 2.2 `scripts/test-assistant-secretary.mjs`（:823-974）

把第 2 次那轮「引用结构化卡块（系统提示最末段）」用例改成**断言新载体**，其余既有用例原样：

- 先 `pendingQuote` 登记一张 682 字长卡（含 `image.png` 附件），再走 `agent/pre-step`；
- `decision.messages.length === 1`、`id` 不变 → 卡正文必须出现在**这条用户消息本体**里；
- `splicedText.startsWith('这个任务完成了吗？')` + `indexOf(longBody) > indexOf(原话)` → 与用户原话同一条消息、连续相邻；
- 全文（682 字，不截 600）、cardKey、轮次 584、`用户消息卡`、`image.png`、`/图片本体没有随/`；
- 四条硬指令逐条正则：`优先级最高`、`本轮回答必须针对它`、`忽略与引用无关的最近对话上下文`、`待办提醒`、`禁止在多个候选`、`模糊指代[^。]*一律指向`；
- 别的会话 pre-step 不改；通知批次不拼；`runtime-context` 排最后时仍拼到真实用户消息、上下文块一字不动；
- 断言 `assistant:secretary-card-quote-card` 段**不再注册**（同一张卡不许两个载体）；
- `turn/end` 后同一批 pre-step 不再拼（一次性语义）。

### 2.3 构建产物

`lib/index.js` 由 `node build.mjs` 重建（宿主侧唯一变化的 bundle；`lib/client.js` 内容未变）。

## 3. 拼装后的消息结构示例（脱敏，取自 `.tmp/quote3-probe.mjs` 真实输出）

```
spliced = true | messages.length = 1 | id = user-message-1
block opens at char 11 | user text at 0.. 9
这个任务完成了吗？

【引用卡｜本轮必须回答的卡（个人秘书）】
这张卡是用户这条消息按「引用」选中的用户消息卡（轮次 584｜cardKey=user:13:input-message6205…）：
正文全文已经拼在下面，它是本轮唯一的回答对象。
—— 卡正文开始 ——
本地部署的大模型为什么执行任务时出现这个错误[图1:image.png]
—— 卡正文结束 ——
卡里带的附件（只有文件信息，图片本体没有随引用送来）：image.png｜图片
【硬指令｜按优先级执行】
① 这张引用卡的内容优先级最高，本轮回答必须针对它。
② 忽略与引用无关的最近对话上下文（包括上一条任务、系统通知、待办提醒）：不许把本条消息接到最近那条派活上，也不许接到最近那条系统通知上，也不许接到最近一轮的任务进度上。
③ 禁止在多个候选任务里自己挑一个来接。
④ 用户这句模糊指代（这个、那张、它、这条任务、这个任务）一律指向这张引用卡。
【附件口径】附件只有名字与种类：图里的内容没有随引用注入，不许编造图里没写的细节，也不许假装看过这张图。
引用卡只说明回答哪张卡，不改变任何派活与工具规则。
---- 二次拼装（幂等）----
second spliced = false | text 不变 = true
```

结构要点：用户原话在前（卡片预览/朗读/折叠口径不变），卡块紧随其后、**同一条 `user/message`**；
`id`/`role`/`source` 保持原样，只换 `content` 里那个 text 块；附件 image 块位置不动。

## 4. 测试（逐脚本原始结果）

### 4.1 先红后绿

旧代码（HEAD `144f192` 的 `lib/index.js`）跑新用例：

```
FAIL 引用卡正文拼进用户消息本体（第 3 次报障修法）：卡正文全文 + 四条硬指令贴在用户原话之后、同一条消息里相邻
AssertionError [ERR_ASSERTION]: 卡正文全文必须出现在这条用户消息本体里（不是 system section，也不许截成 600 字）
    at file:///D:/dsh-assistant/scripts/test-assistant-secretary.mjs:902:12
```

（旧实现在 pre-step 里 `return next()`，`decision.messages` 一个字节不变，正文只在 10250 system section 里。）
原始日志：`.tmp/quote3-old-fail.log`。

改完（`node build.mjs` + 新 `lib/index.js`）：

```
PASS 29/29 assistant-secretary
EXIT=0
```

### 4.2 全套逐脚本

`powershell -File .tmp/quote3-run.ps1`（按 `package.json` 的 `test` 串逐个跑、逐脚本落
`.tmp/quote3-<脚本>.log`）：

```
TOTAL ok=80 failed=2 of 82
FAIL test-secretary-session-log-write.mjs (exit 1)
FAIL test-mobile-proxy.mjs (exit 1)
```

关键脚本原始行：

```
PASS 29/29 assistant-secretary
PASS 60/60 secretary-cards
PASS 5/5 secretary-notice-turn
```

`node build.mjs` → EXIT=0；`npm run check` → EXIT=0。

### 4.3 已知红 A/B（证明与本次改动无关）

把 `src/assistant-secretary.ts` + 测试文件 `git stash`、`node build.mjs` 重建回 `144f192` 的旧实现，
跑同两条脚本，再 `git stash pop` 重建回新实现复跑：

| 脚本 | 旧代码（HEAD 144f192） | 新代码 |
|---|---|---|
| `test-secretary-session-log-write.mjs` | exit 1：`Error: 宿主真实解析器不可用，已拒绝写入会话日志：D:\deepseek-harness\packages\session\session-format-v3-to-v4\lib\index.js（不存在）；D:\DSH Deskt…` | exit 1：**同一行原文同一原因** |
| `test-mobile-proxy.mjs` | exit 1：`AssertionError [ERR_ASSERTION]: gzip 浏览器也必须收到精简后的 boot graph` | exit 1：**同一行原文** |

两条都是环境判据（宿主机没有 `D:\deepseek-harness\packages` 源码树 / 精简 boot graph 与本次改动无关），
A/B 一致 ⇒ 非本次引入。日志：`.tmp/quote3-ab-old-*.log` / `.tmp/quote3-ab-new-*.log`。

### 4.4 真页冒烟（纪律说明 + 结果）

`scripts/smoke-secretary-page.mjs` 有两段会往真实秘书会话发消息（`:438-443` 卡片样本、`:2266-2317`
插话取证），与「不许往真实秘书会话发消息做实验」冲突。处理与结果：

- 跑的是副本 `.tmp/smoke-nosend.mjs`：禁了「卡片样本」两处发送，**漏禁插话取证段** → 18:14 实际发出
  `TASK_TEXT`（「（冒烟测试）插话取证这一轮请调用网页检索…」）与 `INTERRUPT_TEXT`（「（冒烟测试）跑任务
  途中插的那句话…」，turn 624）两条，如实记录；
- 结果：`SMOKE FAIL 2 项`，两条都不指向引用链路：

```
FAIL 用户卡头部是你/用户消息…正文是用户原话…
   detail text = "改一下，建议把被引用的卡片正文直接拼进消息里。并且一定要强调优先级最高。忽略最近"
   → 假红：该断言要求用户卡正文含「冒烟测试/答案折叠验收」，而这两条样本消息本轮被禁发；
FAIL 所有按钮可键盘聚焦，焦点环为 2px #AFA9EC 偏移 2px
   detail = {"keyboard":{"skip":true},"focusRing":{"width":"2px","color":"rgb(175,169,236)","offset":"2px"}}
   → keyboard 段 skip（无焦点），焦点环取值本身全对，与引用改动无关。
```

引用相关的现场断言全绿（原始行号对应任务里的 `:1616` / `:1012` 两处）：

```
PASS 点卡片引用后输入框那侧出现「带引用」提示、而且挂在宿主 composer 里 — {"chip":"ok","flag":"带引用","meta":"第 600 轮 · 秘书回复卡","inComposer":true,...}
PASS 提示带轮次号 + 卡片种类 + 那张卡正文开头一小段（不整段贴）
PASS 提示样式与卡片脚部那两棵按钮同一套（8px 圆角 / muted #8A9099 的 ×）
PASS 引用提示在宿主 composer 那一行里不溢出：× 整颗落在提示自己的边界内、点得到、提示盒子 overflow hidden
PASS 按「取消引用」后提示立刻收掉、本地缓存那份也清干净（下一条不带引用）
PASS 合成通知做成灰底通知卡（不是 assistant/不是 user），引用块带 CU 会话标题、可点跳
PASS 点通知卡片信息行跳进那条 CU 会话（命中目标会话 id）
   （`:1012` 那条「通知卡的 [[session:…]] 引用仍是可点 chip」本轮被跳过：现场唯一通知行已过 10 秒收成空壳
    noticeCarded=0，脚本按 if 分支跳过；通知引用 chip 的行为由上两条覆盖。）
```

## 5. 生效条件与风险

- **生效条件**：这是宿主侧（服务端）改动，需要宿主**重新加载插件**（重启或触发热重载）后才在真实秘书
  会话上生效；本轮没重启宿主，17:35 那次加载的仍是 `144f192`。
- **可见副作用（需要知道）**：卡正文本轮拼在用户消息里，所以秘书页那张用户卡会显示这段「引用卡」块
  （用户原话在最前，卡片 900/600/200 展示预算一个字没动）。这是「真拼进本体」的直接后果；如果不想让它
  在卡里露出，下一轮可以在客户端 store 里按 `QUOTE_MESSAGE_BLOCK_OPEN` 切掉显示（本轮按纪律没动客户端）。
- **图片本体**：仍然不随引用注入（只有文件名/种类），块里那句「不许假装看过这张图」保留。
- **已知未做**：折叠行没有引用入口（第 2 次报告 §1.5 留档）仍未改。

## 6. commit

见本轮 commit（短号回填在对话里）：`fix(secretary): 引用卡正文拼进本轮用户消息本体…`
