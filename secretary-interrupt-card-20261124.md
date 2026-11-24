# 个人秘书页「插话未卡片化 + 过程行残留」修复报告（2026-11-24）

## 0. 结论与状态

- ✅ 两个 bug 都修了，而且都在**真页现场**验过一遍：
  - ① 秘书跑任务途中用户插话（宿主挂在 `data-chat-flow-kind="steering"` 那一类行）现在出**冷蓝用户卡**（浅蓝 `#eef4ff`、头部「你」+「用户消息」芯片、朗读 34px、底行时间/复制），原生气泡被整条接管、不出图。
  - ② 卡片之间不再出现过程行：`已调用工具并搜索代码` / `已调用工具` / `已读取文件` / `本回合记忆召回 1` 这类一律隐藏（真页现场扫描 `leakedRows=[] tailExtras=[] titleLeaks=[]`）。
- ✅ 本地 commit `6127e8e`（未 push）；只改代码 + 测试，宿主**没有重启**、没有 rebase/amend、没有删任何用户文件。
- ⚠️ 有一项是测试口径纠正（不是产品修复）：`test-secretary-pagination-context.mjs` 的「卡片取数不受 compaction 影响」分母改口径，见第 7 节遗留项。

一句话根因：插件的卡片收集器与 CSS 只认宿主 `kind="user"` 那一类行，**漏了 `kind="steering"`（跑任务途中的插话）**——宿主给这两种 kind 注册的是同一张用户消息视图，所以插话那条从来没有卡片接管它，原生气泡自己冒出来；同时旧 CSS 全按 kind 匹配，**漏了工具调用 kind、上下文 kind、带分组 key 的容器行、分组成员标记与回合尾槽容器里的原生部件**，这几类正是截图里那些过程消息。

---

## 1. 证据口径（哪些是现场 dump，哪些是日志推断）

| 证据 | 口径 |
|---|---|
| `data-chat-flow-kind="steering"` 那条行的属性、行高、有没有卡、气泡 display | **真页现场 dump**（`.tmp\dom-dump-live3.txt` / `dom-dump-live4.txt` / `dom-dump-live5.txt`，playwright 本地 Chrome 打开 `http://127.0.0.1:3081` 固定秘书会话 `session-83bca3e3-bcd1-49f0-8b3c-2ec9edae14e3`） |
| 过程行在修之前的可见清单（分组行 h=20、工具行 h=28 等） | **真页现场扫描**（`.tmp\red-smoke.txt` 的「过程行现场事实」） |
| 会话日志里插话是一条 `user/message` 事件（seq 9288，id `08ae5714-059e-407d-8ae0-40df53983508`） | **日志推断**（`.tmp\log-probe3.txt`，读 `session.v4.jsonl.zstd`） |
| 宿主为什么把插话挂成 steering | **宿主产物代码 grep**（`C::\Users\<ACCOUNT>\.dsh\temp-asar-extract\dsh\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\client.js`，14 处命中） |

---

## 2. 真页现场 DOM dump 原文（修之前）

`.tmp\dom-dump-live3.txt`（关键行，逐字照抄）：

```text
DUMP3 steering [{"turn":"390","key":"13:input-message08ae5714-059e-407d-8ae0-40df53983508","processMember":null,"h":398,"hasCard":false,"bubbleCls":"DuJD4G_bubble","text":"帮我优化下个人秘书页面，当秘书正在执行任务时，如果用户再插话，这个插话没有以卡片的形式展示"}]
DUMP3 kindsSeen ["assistant-step","manual-compaction","steering","tool-call","turn-process","turn-tail","user"]
DUMP3 processMember {"total":18,"kinds":["assistant-step|part=reasoning|tag=DIV","tool-call|part=null|tag=DIV","assistant-step|part=response|tag=DIV"],"inTurnTail":0}
DUMP3 groupContainers {"total":4,"samples":[{"attrs":"class=_9YPp_G_root data-chat-group-key=[\"process\",\"14:assistant-step390:1\",\"reasoning\"] data-chat-flow-key=[...] data-chat-anchor-key=group:[...] data-chat-turn=390","h":20,"display":"block","text":"已读取文件","hasCard":false}]}
DUMP3 tailSlots {"total":104,"tailLike":[... "conversation.chat.turnTail" ×多次]}
DUMP3 cardParents [{"kind":"turn-tail","parentAttrs":"data-slot=conversation.chat.turnTail style=display: contents;","ancestorSlot":"conversation.chat.turnTail"},{"kind":"user","parentAttrs":"class=CZ3m0q_flowItem data-chat-anchor-key=13:input-message22efac3b-…"}]
```

`.tmp\dom-dump-live4.txt`（过程行在出图、以及正文里能读到那些字）：

```text
DUMP4 leaked {"已调用工具":4,"本回合记忆":2,"记忆召回":2,"已搜索代码":1,"已读取文件":2,"正在调用工具":0}
DUMP4 rendered [{"tag":"DIV","attrs":"class=_9YPp_G_root data-chat-group-key=[\"process\",\"14:assistant-step390:1\",\"reasoning\"] …","text":"已读取文件","h":20,"display":"block"},{"tag":"DIV","attrs":"class=CZ3m0q_flowItem data-chat-anchor-key=9:tool-callcall_bf…"}]
DUMP4 tails [{"attrs":"data-slot=conversation.chat.turnTail style=display: contents;","childCount":1,"children":[{"tag":"ARTICLE","attrs":"data-dsh-scard=card data-dsh-scard-kind=assistant data-dsh-scard-turn=390 …"}]}]
```

`.tmp\red-smoke.txt`（同一页、修复未落地时的过程行扫描）：

```text
过程行现场事实：{"rowsTotal":33,"visibleTotal":11,"cardBackedVisible":3,"leakedRows":[
 "null|group=[\"process\",\"14:assistant-step390:1\",\"reasoning\"]|member=null|h=20|已读取文件",
 "tool-call|group=null|member=true|h=28|",
 "null|group=[\"process\",\"14:assistant-step390:2\",\"reasoning\"]|member=null|h=20|已搜索代码，已读取文件，已调用工具",
 "tool-call|group=null|member=true|h=28|" ×4
 ],"tailExtras":[],"titleLeaks":["已读取文件","已搜索代码，已读取文件，已调用工具", …]}
SMOKE FAIL 6 项
```

宿主产物代码（`dsh-client-ui-chat/lib/client.js` grep 片段，说明两种 kind 用同一张视图）：

```text[6] … "Right-aligned bubble shared by user and steering rows." function UserStyleBubble({ content, renderMessageImages, …
[13] … User and admitted-steering keyed Chat renderer." const UserMessageNodeView = (0, react.memo)(f…
[0] … :is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]) …  ← 宿主自己的 CSS 也是把 user 与 steering 当同一类行配对处理
```

---

## 3. 根因（文件 + 行号 + 代码原文）

### 根因 ①：收集器只收 `kind="user"` 的行，插话那条收不到

`src/client/pocket/orb/secretary-cards.ts`（HEAD 版，第 1091-1105 行）：

```ts
export function collectSecretaryCardRows(doc: Document): SecretaryCardRow[] {
  const out: SecretaryCardRow[] = []
  for (const row of doc.querySelectorAll('[data-chat-flow-kind="user"]')) {   // ← 只有 user，steering 从来收不到
```

同一文件第 1131 行（扫描层取卡文本时认行）：

```ts
      const row = element.closest('[data-chat-flow-kind="user"]') ?? element
```

挂载层 `src/client/pocket/orb/SecretaryUserCard.tsx` 第 409 行靠这条收集器出卡：

```tsx
      const next = collectSecretaryCardRows(document)
```

→ 现场 dump 里 `kind="steering"` 的行 `hasCard=false`、行高 398/450px，宿主气泡（`DuJD4G_bubble`）照旧出图。

### 根因 ②：CSS 全按 kind 匹配，漏了 4 类过程行

`src/client/pocket/orb/secretary-cards.css.ts`（HEAD 版）里只有：

```css
body[data-dsh-secretary="1"] [data-chat-flow-kind="assistant-step"], …   /* 第 26 行起，只按 kind 压 assistant-step */
body[data-dsh-secretary="1"] [data-chat-flow-kind]:has(> [data-slot="conversation.chat.node"]) …   /* 第 50 行 */
```

现场 dump 实测：分组容器行**自己根本没有 `data-chat-flow-kind` 属性**（只有 `data-chat-group-key`，行高 20px，文字就是「已读取文件」「已搜索代码，已读取文件，已调用工具」）；工具调用行 `kind="tool-call"` 行高 28px；回合尾那个槽容器（`data-slot="conversation.chat.turnTail"`，`style="display: contents"`）里挂着 dsh-mnemon 的「本回合记忆 / 召回 1」部件——这些 HEAD 版一条规则都没压到。

---

## 4. 修复前 / 修复后关键代码

### 4.1 收集器：用户行 kind 白名单（新增，同一文件第 1069-1080 行，注释从 1069 起、常量 1074-1080）

```ts
export const USER_FLOW_KIND_USER = 'user'
export const USER_FLOW_KIND_STEERING = 'steering'
export const SECRETARY_USER_FLOW_KINDS = [USER_FLOW_KIND_USER, USER_FLOW_KIND_STEERING]
/** 收集器与 CSS 共用的行选择器（顺序无关，两个 kind 都要在里面）。 */
export const SECRETARY_USER_ROW_SELECTOR = SECRETARY_USER_FLOW_KINDS
  .map((kind) => `[data-chat-flow-kind="${kind}"]`)
  .join(', ')
```

before → after（收集器与扫描层，同一文件）：

```diff
-  for (const row of doc.querySelectorAll('[data-chat-flow-kind="user"]')) {
+  for (const row of doc.querySelectorAll(SECRETARY_USER_ROW_SELECTOR)) {
…
-      const row = element.closest('[data-chat-flow-kind="user"]') ?? element
+      const row = element.closest(SECRETARY_USER_ROW_SELECTOR) ?? element
```

测试面（同一文件第 2282-2285 行）一并导出：`SECRETARY_USER_ROW_SELECTOR / SECRETARY_USER_FLOW_KINDS / USER_FLOW_KIND_USER / USER_FLOW_KIND_STEERING`。

### 4.2 插话行的气泡接管（`secretary-cards.css.ts`，新增第 102-113 行，判据与用户行同一套）

```css
body[data-dsh-secretary="1"] [data-chat-flow-kind="steering"]:has(> [data-dsh-scard="card"][data-dsh-scard-kind="user"], > [data-dsh-scard="card"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"] {
  display: none !important;
}
body[data-dsh-secretary="1"] [data-chat-flow-kind="steering"]:has(> [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"]:not(:has(img)) {
  display: none !important;
}
body[data-dsh-secretary="1"] [data-chat-flow-kind="steering"]:has(> [data-dsh-scard="card"][data-dsh-scard-kind="user"], > [data-dsh-scard="card"][data-dsh-scard-kind="notice"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="notice"]) [data-slot="conversation.user.text.node"] > span:not([data-dsh-scard]) {
  display: none !important;
}
body[data-dsh-secretary="1"] [data-chat-flow-kind="steering"]:has([data-dsh-scard="card"][data-dsh-scard-kind="user"], [data-dsh-scard="card"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"] { display: none !important; }
body[data-dsh-secretary="1"] [data-chat-flow-kind="steering"]:has([data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"]:not(:has(img)) { display: none !important; }   /* 后代兜底，源码里两条并成一档 */
```

### 4.3 过程行隐藏（`secretary-cards.css.ts`，新增第 59-68 行：四条 kind/属性规则在第 59-63 行，回合尾兜底那条在第 68 行）

```css
body[data-dsh-secretary="1"] [data-chat-flow-kind="tool-call"],
body[data-dsh-secretary="1"] [data-chat-flow-kind="context"],
body[data-dsh-secretary="1"] [data-chat-group-key]:not(:has([data-dsh-scard])),
body[data-dsh-secretary="1"] [data-turn-process-member]:not(:has([data-dsh-scard])) {
  display: none !important;
}

/* 回合尾那一档只压没卡片标记的直接子代（卡片照旧出图）*/
body[data-dsh-secretary="1"] [data-slot="conversation.chat.turnTail"] > :not([data-dsh-scard]) {
  display: none !important;
}
```

`src/client/pocket/orb/SecretaryUserCard.tsx` 只改注释（第 13-15 行挂载口径与第 373-375 行挂载层说明）：把「含跑任务途中插话那一类行」写进挂载口径，代码逻辑没动。

**没动过的东西**（硬约束确认用例守着）：折叠预算 `FOLD_BODY_LINE_BUDGET=3` / `FOLD_TITLE_LINE_BUDGET=2` / `FOLD_BLOCK_GAP=10`、首帧上限 162px、朗读 34px、标识 32px、观感口径 900/600。CSS 第一条规则 `[data-chat-flow-kind="assistant-step"]` 一字未改（它是视觉/分页脚本抽 CSS 的锚点）。

---

## 5. 修复后真页现场 dump（证明真生效，不是只过静态套件）

`.tmp\dom-dump-live5.txt`（同一页、修复已进 bundle 之后）：

```text
DUMP5 styleHits {"styleTags":183,"steering":5,"toolCall":1,"contextKind":1,"groupKey":2,"turnTailChildRule":1,"assistantStep":1}
DUMP5 steering [{…,"data-chat-flow-kind=\"steering\"","data-chat-turn":"410","outerHead":"<div class=\"CZ3m0q_flowItem\" … data-chat-flow-kind=\"steering\" …><div data-slot=\"conversation.chat.node\" style=\"display: contents;\"><div class=\"DuJD4G_userRow\">…","h":191,"bubbleDisplay":"none","cards":["card:user"],"clock":"18:28","processMember":null}]
DUMP5 userRows [{"turn":"410",…},{"turn":"411","cards":["card:user"],"h":191}]
DUMP5 secretaryFlag "1"
```

`scripts\smoke-secretary-page.mjs` 最后一段真页取证（`.tmp\green-smoke5.txt`）：

```text
插话现场事实：{"现场kind":["steering"],"facts":[{"flowKind":"steering","rowKey":"13:input-messagede739962-2211-49cf-8447-db8630f02fdb","rowTurn":"417","rowVisible":true,"rowHeight":211,"rowText":"你 用户消息 （冒烟测试）跑任务途中插的那句话：桌面的软件程序这件事记一下 18:40","hasUserCard":true,"cardKind":"user","cardBg":"rgb(238, 244, 255)","cardSurfaceVar":"#eef4ff","nameText":"你","tagText":"用户消息","speakSize":34,"footTimeText":"18:40","footCopy":true,"bubbleDisplay":"none","bubbleHeight":0}]}
过程行现场事实：{"rowsTotal":29,"visibleTotal":8,"cardBackedVisible":8,"kindsSeen":["turn-process","assistant-step","steering","turn-tail","user","manual-compaction","tool-call"],"leakedRows":[],"tailExtras":[],"titleLeaks":[]}
SMOKE PASS 全部通过
```

现场 kinds 实测清单（这一页正在用的）：`user`、`steering`、`assistant-step`、`tool-call`、`turn-process`、`turn-tail`、`manual-compaction`、`context`（宿主注册另有 `command`；`queued` 不是 kind，是排队输入的状态）。

---

## 6. RED → GREEN 证据

### 6.1 `scripts\test-secretary-cards.mjs`（先加用例、未改代码 → RED）

`.tmp\red-cards.txt`：9 条用例 FAIL（`AssertionError` 计数 9；stderr 里 PowerShell 把长行包了一层，所以 `FAIL ` 字样出现 10 次），用例名照抄：

```text
FAIL 插话卡片化①：宿主执行中把用户插话挂成 kind="steering" 的行（现场 dump 的那个 kind）……收集器收成一条 user 卡行
FAIL 插话卡片化②：steering 行走「文本 run + 附件」的同一套块口径（附件前后的文字一样不许丢）
FAIL 插话卡片化③：卡片必须接管 steering 行的原生气泡（CSS 那一套 :has 判据要给 steering 也留一份）
FAIL 插话卡片化④：扫描层（分页窗口/朗读 key）也要认出挂在 steering 行里的卡
FAIL 过程行隐藏①：单条工具行（现场 dump 的 kind="tool-call"）与上下文行一律不出图
FAIL 过程行隐藏②：过程分组行（[data-chat-group-key]，截图那 3 行的第一行就是它的标题）压掉，但带卡的行不许顺手压掉
FAIL 过程行隐藏③：分组成员标记 data-turn-process-member 也压掉（现场 dump：tool-call 行都带 data-turn-process-member="true"，turn-tail 行一个都不带）
FAIL 过程行隐藏④：回合尾那一档只压非卡子代——assistant 卡照旧挂着，dsh-mnemon「本回合记忆 召回 1」与 skill turn-tail 一律不出图
FAIL 硬约束确认：折叠预算 3/2/10、首帧上限 162px、朗读 34px 与标识 32px、观感口径 900/600/200 一个都不许动
```

改代码 + `node build.mjs` 之后（`.tmp\green-cards2.txt`）：

```text
PASS 55/55 secretary-cards
```

### 6.2 `scripts\smoke-secretary-page.mjs`（现场 RED → 现场 GREEN）

- 修复前第 1 次跑（`.tmp\red-smoke.txt`）：`SMOKE FAIL 6 项`，其中本批两条新用例：
  - `FAIL 真页现场：秘书跑任务途中用户插话出用户卡… — {"rowKey":"13:input-message08ae5714-…","rowTurn":"390","rowHeight":450,"hasUserCard":false,"bubbleDisplay":"contents"}`
  - `FAIL 真页现场：卡片之间过程行 0 条… — visible=11 cardBacked=3 leaked=[分组行 h=20「已读取文件」、tool-call h=28 ×5、分组行 h=20「已搜索代码，已读取文件，已调用工具」] titleLeaks=[…]`
- 对照组：修复前用 HEAD 版冒烟脚本跑同一页（`.tmp\smoke-baseline.txt`）`SMOKE PASS 全部通过`；后来会话状态变了，HEAD 版脚本重跑也 FAIL 5 项（`.tmp\smoke-baseline2.txt`）——说明那几条既有用例的失败是**现场会话状态**带出来的（见遗留项），不是本批代码引起。
- 修复后（`.tmp\green-smoke5.txt`）：`SMOKE PASS 全部通过`，133 条 PASS、0 条 FAIL，含本批两条新用例（第 5 节原文）。

### 6.3 `scripts\test-secretary-card-visual.mjs`（固定形状进行物）

- 新增进行物是照现场 dump 形状搭的：`data-probe="steering-row"`（带附件、带第二个气泡）、`data-probe="process-group-row"`、`data-probe="tool-call-row"`、`data-probe="context-row"`、`data-probe="turn-tail-row"`（里面有 `${tailAssistantCard}` 折叠行 + `mnemon-tail-widget`「本回合记忆/召回 1」+ `skill-tail-widget`）。
- RED（`.tmp\green-visual.txt` 那轮，未加新用例前只有旧用例）→ 加完新用例、代码未修时 `CARD VISUAL FAIL 1`（`.tmp\green-visual2.txt`，80 PASS）。
- GREEN（`.tmp\visual3.txt`）：`CARD VISUAL PASS`，81 条 PASS，关键四条：

```text
PASS 插话卡片化：跑任务途中的插话（现场 dump 的 steering 那一类行）做成冷蓝用户卡、原话与附件都收进卡片、整条宿主行被接管 — {"steeringRowCount":1,"rowHeight":283,"rowCardCount":1,"hostNodeDisplay":"none","hostRunVisible":false,"hostAttachVisible":false,"cardVisible":true,"cardBg":"rgb(238, 244, 255)","cardSurfaceVar":"#eef4ff","nameText":"你","tagText":"用户消息",…,"cardParaCount":2,"cardAttachCount":1}
PASS 过程行 0 条①：分组行（现场 dump 带分组 key 那种）、工具行、上下文行、分组成员标记一律不出图 — {"groupDisplay":"none","groupMemberDisplay":"none","toolDisplay":"none","contextDisplay":"none"}
PASS 过程行 0 条②：回合尾那一档只压没卡片标记的部件——秘书卡照旧出图，记忆/技能回合尾部件（截图那行「本回合记忆召回 1」）不出图 — {"tailCardVisible":true,"mnemonDisplay":"none","skillDisplay":"none"}
PASS 过程行 0 条③：卡片之间的可见行只剩卡（照 dump 的那三类行没有一个在出图）
```

### 6.4 其它相关套件（同一轮全绿）

```text
PASS 24/24 assistant-secretary
PASS 5/5 secretary-notice-turn
PASS 卡片分页 DOM 验收全部通过（tmp-secretary-pager-dom.png）      ← scripts\test-secretary-pagination-dom.mjs
PASS 26/26 secretary-pagination-context                              ← 口径纠正后（见 7.3）
```

### 6.5 全量 `npm test`（70 条链式脚本）

```text
npm test exit=0
```

链上关键几条原文：`PASS 7/7`、`PASS 24/24 assistant-secretary`、`PASS 12/12 secretary-dispatch`、`PASS 32/32 assistant-dispatch`、`PASS 16/16 assistant-cu-watch`、`PASS 5/5 secretary-notice-turn`、`PASS 8/8 secretary-session-log-write`、`PASS 9/9 assistant-proactive`、`PASS 5/5 / 10/10 / 12/12 / 5/5`（open-guard / open-recovery / open-rebuild / open-diag）、`PASS 6/6 desktop-ball-gestures`、**`PASS 55/55 secretary-cards`**、`PASS 16/16 secretary-speech-chunks`、`PASS 7/7 assistant-tts-worker`、**`PASS 26/26 secretary-pagination-context`**、`PASS 5/5 assistant-tts`、`test-composition-gate: PASS 27/27`、`test-composer-ledger: PASS 10/10` … 链上 0 条 FAIL。
`npm run check` → `check exit=0`（6 个 bundle 语法检查）；`node build.mjs` → `build exit=0`（`lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js`）。
`smoke-secretary-page` 与 `test-secretary-card-visual` 不在 npm 链里，单独跑过（第 6.2 / 6.3 节）。

---

## 7. 遗留项（照实说）

1. **回合尾那条规则顺手也压掉宿主自己的回合尾部件**：不只记忆/技能部件，宿主挂在 `conversation.chat.turnTail` 里的其它部件（例如宿主自己的回合尾状态行）也一律不出图——这是按需求②「卡片之间不留过程行」的口径有意这么做，判据带 `:not([data-dsh-scard])` 兜底所以卡片不会被误压。若以后要留宿主某个回合尾部件，得单独加白名单。
2. **卡片 key 的两套口径没合流**：DOM 侧插话卡的 key 是 `user:13:input-message<uuid>`（挂在行 key 上），会话日志侧事件 key 是 `<uuid>`；朗读/引用 store 用的 key 差异本批没改（`secretary-card-shared.ts` 一字未动），只是把 steering 行纳入同一套收集口径。
3. **`test-secretary-pagination-context.mjs` 改了断言分母（测试口径纠正，不是产品修复）**：原来 `cards >= messageEvents.length * 0.9` 把「只有工具调用、正文为空的 assistant 事件」（现场实测 464/886 条）和「一轮多步塌成一张卡」都算进分母，现网跑多了就掉到 0.827 而误判 FAIL。现在按「本该出卡的事件」算：带正文 `user/message` 全数 + 带正文 `assistant/message` 按轮去重，现场核对原文已打印（`卡片取数现场核对：… 该出卡 N 条 → 取回 N 张`）。改后 `PASS 26/26`。
4. **冒烟取证会往固定秘书会话灌 1-2 条消息、收不回来**：本段取证放在脚本最后跑（不打扰前面既有用例），注入话术带脚本自己那套「（冒烟测试）」标记、并且不带长英文词——否则窗口里第一张用户卡被顶掉，`用户卡头部…` 那条现场断言（要求正文带「冒烟测试」）会 FAIL；带长英文词（现场实测 `workbuddy` 这种不许换行的词）会让引用提示折成 3 行、88px > 既有用例校准的 72px 上限。**顺带发现一个不在本批范围内的现网现象**：引用提示摘要遇到不许断行的长英文词会长到 88px 越过 72px 校准上限，若要修得改 chip 的折行/截断口径。
5. **现场既有用例的稳定性**：18:03 那次 HEAD 版冒烟 `SMOKE PASS 全部通过`（`.tmp\smoke-baseline.txt`），后来同一版本脚本重跑 `SMOKE FAIL 5 项`（`.tmp\smoke-baseline2.txt`：`用户卡头部…`、`所有按钮可键盘聚焦 {"keyboard":{"skip":true}}`、`第 4 项引用按钮 {"cards":8,"cardsWithButton":7}`、`合成通知… null`、`通知卡头部… null`）——这些是固定会话卡窗口/压缩状态带出来的脆弱现场断言，本批没去改它们；本批取证结束后再跑是 `SMOKE PASS 全部通过`（133 条 PASS）。
6. **宿主没重启**：生效走的是「`node build.mjs` 重出 bundle + 页面重载」这条路，现场 dump（第 5 节）已验 `styleHits steering=5/toolCall=1/turnTailChildRule=1` 与插话行 `cards:["card:user"]`。持久生效要等宿主下一次注入新版本，本批没去动宿主进程。
7. **未 push、未 amend、未 rebase**：只本地 commit `6127e8e`（HEAD 之前是 `e3b97b3`，再往前有 `970ea46` 那批复用的 API 口径：`collectUserCardRuns / userCardRunText / userCardAttachments / buildUserCardBody` 全部沿用，未推翻）。
8. **取证脚本与中间产物未入库**：`.tmp\` 下 dom-dump/log-probe/red-*/green-* 全部留作证据（未 `git add`，也没有删除）；测试跑出的 `tmp-*.png` 截图同样未入库，其中本批新增的是 `tmp-secretary-interrupt-card.png`。

---

## 8. 改动文件与提交

`git show --stat 6127e8e`（真实数字）：

```text
6127e8e  fix(secretary): 跑任务途中的插话（宿主 steering 行）卡片化，卡片之间过程行一律不出图  2026-11-24 18:41:35 +0800

 lib/client.js                                 | 182 +++++++++++++++-----------
 lib/index.js                                  |  12 +-
 scripts/smoke-secretary-page.mjs              | 140 ++++++++++++++++++++
 scripts/test-secretary-card-visual.mjs        | 144 ++++++++++++++++++++
 scripts/test-secretary-cards.mjs              | 149 ++++++++++++++++++++-
 scripts/test-secretary-pagination-context.mjs |  17 ++-
 src/client/pocket/orb/SecretaryUserCard.tsx   |   5 +-
 src/client/pocket/orb/secretary-cards.css.ts  |  36 +++++
 src/client/pocket/orb/secretary-cards.ts      |  31 ++++-
 9 files changed, 630 insertions(+), 86 deletions(-)
```

产品代码 3 个文件：`secretary-cards.ts`（+31）、`secretary-cards.css.ts`（+36）、`SecretaryUserCard.tsx`（注释 +5/-4）；测试 4 个脚本；构建产物 `lib/client.js`、`lib/index.js`（随 `node build.mjs` 一起提交，口径与前面几批一致）。
