# 个人秘书「引用不生效」第 2 次：根因取证、结构化硬手段与端到端回归（2026-11-25）

## 结论一句话

602 轮两段引用**都注入了、内容也对**，模型仍把「这个任务完成了吗」接到最近那条引用修复任务 → **软约束不够，改成把被引用卡结构化并入本轮 prompt**：新增「本轮必须回答的卡（个人秘书）」段，排在整段系统提示最末（紧贴这条用户消息），带**卡正文全文（不按 600 条摘录截）**、附件文件信息与三条硬禁令；引用记录随之补 `body`/`attachments` 字段（引用链路自有上限 20000 字，卡片展示预算 900/600/200 一个字没动）。603 轮引用段缺席的真相是**这一轮根本没有登记**：宿主引用文件与客户端 localStorage 双向零写入、602 那条已按一次性规则在 turn/end 被消耗，用户只是口头说了「引用」而没再按那颗按钮；同时登记侧确实存在三条静默丢路径（会话 id 未定、POST 失败永久锁死、请求体 4KB 上限），本轮一并修掉。

## 0. 现场与纪律

- 仓库 `D:\dsh-assistant`，开工 HEAD `2dd2d2a`（本地领先 origin/main 1 条）；本轮**只 commit 不 push**、不动 V0 标签、不重启宿主、不碰 hpg 定价与客服制单闭环。
- 取证全程只读：会话日志 zstd 只按帧解码、不回写；引用状态文件与浏览器 Local Storage leveldb 只复制出来读。
- 只改引用这条链路（登记、注入、客户端 store）；只 `git add` 自己改的文件。

## 1. A 取证（原文照贴）

### 1.1 方法

- 会话日志：`%USERPROFILE%\.dsh\sessions\--C-Users-<ACCOUNT>-.dsh-assistant--\session-83bca3e3-bcd1-49f0-8b3c-2ec9edae14e3\session.v4.jsonl.zstd`
  - 只读解码：36,066,401 B → 6,098 个 zstd 帧 → 90,761,819 字符 / 14,581 行；`tornStart=null`（无半截帧）。
  - Node 24 的 `zstdDecompressSync` 只解第一帧，所以按宿主帧边界 `scanHostZstdFrames` 逐帧解（探针脚本在未跟踪的 `.tmp/`）。
- prompt 正文取自 `system/message` 事件（`request/header` 只有 `header/reason`，不含正文）：每轮最后一条 `system/message` 就是该轮完整系统提示。
- 引用状态文件：`%USERPROFILE%\.dsh\profiles\desktop\dsh-assistant-secretary-quote.json`。
- 客户端 localStorage：宿主 GUI 跑在 `dsh-app://app` 里，数据在 `%USERPROFILE%\AppData\Roaming\@deepseek-ai\dsh-desktop\Local Storage\leveldb\001196.log`（仍在被进程写，复制出来只读解析；Chromium 的值是 UTF-16LE，按 WriteBatch 的 seq 顺序还原写序列）。

### 1.2 第一问：603 轮引用段为什么缺席——三处零写入，结论是「这次没有登记」

**证据一：宿主引用文件最后一次写盘停在 602 轮 turn/end**

```
FullName      : %USERPROFILE%\.dsh\profiles\desktop\dsh-assistant-secretary-quote.json
Length        : 85
LastWriteTime : 2026/11/25 16:42:02

{
  "version": 1,
  "updatedAt": "2026-11-25T08:42:02.269Z",
  "quoteBySession": {}
}
```

`updatedAt` = 本地 16:42:02，与 602 轮 `turn/end`（16:42:02）毫秒级吻合＝消费写盘；`quoteBySession` 空＝没有挂着任何引用。**从 16:42:02 到 603 发送（16:43:38）之间，这个文件一次都没被写过**——任何一次成功登记或取消都会 `persistQuoteState()` 改写 `updatedAt`，所以 603 发送前后宿主**没有收到过任何 POST**。（文件后来在 16:58:32 又被写过一次：那是本轮冒烟脚本自己点的「引用→取消」，写的是同一个空 map，与 603 无关。）

**证据二：601/602 有引用段，603/604 没有（逐轮 prompt 段表原文）**

```
--- turn 601 seq 14528 chars 22925
1722:# 个人秘书上下文（插件滚动摘要，最近 1 轮原文 + 摘要）
5138:# 对话回复
5677:# 私人助手（本机用户称呼，按 lint 规则隐去）
7841:# 控制室项目清单（实时快照）
8676:# 输出与朗读（个人秘书）
9519:# 卡片引用（个人秘书）          ← 1783
9826:# 语音输入（个人秘书）
10088:# 派活分层（个人秘书）
12459:# 引用锚点（个人秘书）        ← 1791（全 prompt 最末的插件段）
--- turn 602 seq 14546 chars 37757
23318:# 输出与朗读（个人秘书）
24161:# 卡片引用（个人秘书）
24468:# 语音输入（个人秘书）
24730:# 派活分层（个人秘书）
27291:# 引用锚点（个人秘书）
--- turn 603 seq 14554 chars 38858
25015:# 输出与朗读（个人秘书）
25858:# 语音输入（个人秘书）
26120:# 派活分层（个人秘书）
HAS 卡片引用段: false | HAS 锚点段: false
--- turn 604 seq 14568 chars 39251
25408:# 输出与朗读（个人秘书）
26251:# 语音输入（个人秘书）
26513:# 派活分层（个人秘书）
HAS 卡片引用段: false | HAS 锚点段: false
```

（603 里出现的「卡片引用」字样只在滚动摘要的历史轮次文案里，不是注入段；判据用完整标题 `# 卡片引用（个人秘书）` / `# 引用锚点（个人秘书）`。）

**证据三：客户端 localStorage 的写序列——16:42:02 清空之后，直到 603 这条消息发出去，引用键一次都没再写**

```
seq28906 dsh.assistant.secretary.quote-baseline:session-83bca3e3… {"cardKey":"user:13:input-message85ddfa12-aa20-49f8-b900-c45ab29cec96","turnNo":"601"}
seq28907 dsh.assistant.secretary.quote:session-83bca3e3…  {"cardKey":"user:13:input-message620571e4-fd4b-418f-952f-1aec0512b770","kind":"user","turnNo":"584","preview":"本地部署的大模型为什么执行任务时出现这个错误[图1:image.png]","refSessionIds":[],"updatedAt":1795596107296}
seq28908 dsh.conversation.session-83bca3e3… {"draft":{"text":"","references":[]},"view":null,"viewRequest":null}
seq28910 dsh.assistant.secretary.quote-baseline:session-83bca3e3… null
seq28911 dsh.assistant.secretary.quote:session-83bca3e3… null
seq28915 dsh.conversation.session-83bca3e3… {"draft":{"text":"","references":[]},…}
seq28917 dsh.conversation.session-83bca3e3… {"draft":{"text":"本地部署的大模型为什么执行任务时出现这个错误","references":[]},…}
seq28919 dsh.conversation.session-83bca3e3… {"draft":{"text":"","references":[]},…}
seq28921 dsh.conversation.session-83bca3e3… {"draft":{"text":"[图1:image.png] 我引用这个任务，但是个人秘书回复的不是这个任务卡片的内容，而是回复的其他的，这个引用还是没有真正起作用，应该回复引用dui'h","references":[]},…}
seq28923 dsh.conversation.session-83bca3e3… {"draft":{"text":"","references":[]},…}
```

- `seq28907` 的 `updatedAt=1795596107296` = **16:41:47.296**：这是 602 那次登记的点击时刻（卡片 584、轮次 584、摘录正是那句），随后 602 的 prompt（16:41:52）就带着两段引用。
- `seq28910/28911` 把引用和基线一起写成 `null`：602 消息发出去后客户端自己收掉（服务端那份由宿主在 `turn/end` 收，即 16:42:02 那次写盘）。
- `seq28917` 是用户先把卡正文那句敲进输入框（可能是想复核），`seq28921` 才是 603 这条真正的消息（文本 + `[图1:image.png]`，与日志里 603 的 user/message 逐字一致），`seq28923` 是发送后清空草稿。
- **从 16:42:02 到 16:43:38 发送之间，`dsh.assistant.secretary.quote:` 键一次都没被写。** `setQuote()`/`clearQuote()` 任何一条路径都是先 `writeCache()` 再 POST（见 `secretary-cards.ts` 的 `apply()`），所以只要用户真按了那张卡的引用按钮，本地缓存必有一次写入；没有写入 + 宿主文件 `updatedAt` 不动 = **这次点击从未发生**（既不是「登记被 602 消费掉」，也不是「POST 打不通」）。

**证据四：603 这条消息本身是「纯文本 + 一张截图」，没有任何引用标记**

```
{"type":"user/message","seq":14555,"time":1795596218817,"data":{"content":[
  {"type":"image","attachment":{"attachmentId":"sha256:eebbe54054b1671dfb302b831321ff11e8073ac7df336b2f17fd2c5d515a0f6b","mediaType":"image/png","width":687,"height":344,"bytes":29140,"name":"image.png"}},
  {"type":"text","text":"[图1:image.png] 我引用这个任务，但是个人秘书回复的不是这个任务卡片的内容，而是回复的其他的，这个引用还是没有真正起作用，应该针对性回复引用对话啊"}],
  "source":{"kind":"user","rpcId":"4ec7ff02-3ea3-4dd7-abef-946f27a66b2f","clientTimeZone":"Asia/Shanghai"},"role":"user","id":"88311db6-090b-4efc-9a67-427581b27333"}}
```

**判定**：603 轮不是「引用了但没注入」，而是**这条消息发出时没有任何引用**。「我引用这个任务」指的是 602 那一轮（16:41:47 登记、602 prompt 两段都在、602 回复串到了别的任务）。按设计引用是**一条消息即消耗**，602 的 `turn/end` 已经把它收掉了；用户接着写投诉时没有再按那颗按钮，所以 603 的 prompt 里什么都没有。

### 1.3 第二问：模型看到的是摘录还是全文？图有没有表示？

- **摘录口径**：客户端 `truncateQuotePreview()` 与宿主 `normalizeQuoteRecord()` 都用 `QUOTE_PREVIEW_MAX_CHARS = 600` 截 `preview`；1783/1791 两段都只喂 `preview`。卡 584 正文只有 24 字（`本地部署的大模型为什么执行任务时出现这个错误` + `[图1:image.png]`），**本卡没有被截断**，模型看到的就是整句；但机制上 600 字以上的卡会被截成「600 字 + …」，这正是本轮要改的（引用链路自己新增 `body` 字段，不再借摘录预算）。
- **附件**：602 prompt 里 `image.png` 出现 4 次，全部是文字标记（两段引用各一次 + 语音输入段/朗读段的「附件」口径），**没有任何 image 内容块**；602 这一轮的 `system/message` 与 `user/message` 的 content 块类型全是 `text`：

```
system/message 14537 text
user/message 14538 text
user/message 14539 text
system/message 14546 text
```

  也就是说：602 轮模型**看不到 584 那张图**，只看到 `[图1:image.png]` 这个行内标记；没有尺寸、类型、sha、也没有图本身。
- 反面证据：603 轮用户消息里带了**真的** image 块（`image/png` 687×344 29140 字节 `sha256:eebbe540…`），所以 603 轮模型看得到的是那张投诉截图，不是 584 的图。**引用注入从未带过图片本体，一个字节都没有。**

### 1.4 602 轮两段注入原文（现场原样）

```
# 卡片引用（个人秘书）
用户刚在会话页上按了「引用」，引用的就是下面这张用户消息卡；用户这条消息就是要接着它说的内容。
定位：kind=user｜轮次 584｜cardKey=user:13:input-message620571e4-fd4b-418f-952f-1aec0512b770
卡片正文摘录（不是完整汇报，只用来定位引用的是哪段话）：本地部署的大模型为什么执行任务时出现这个错误[图1:image.png]
处理要求：把用户这条消息当作对这张卡的回应；不许因为摘录短就把用户这条消息里的要求吞掉，也不许把这张卡的原有内容改写成别的说法。引用登记只说明「接着哪张卡说」，不改变任何派活与工具规则。

# 语音输入（个人秘书）…
# 派活分层（个人秘书）…

# 引用锚点（个人秘书）
这条用户消息引用的就是这张用户消息卡：cardKey=user:13:input-message620571e4-fd4b-418f-952f-1aec0512b770｜kind=user｜轮次 584。
被引用卡正文：本地部署的大模型为什么执行任务时出现这个错误[图1:image.png]
处理要求：这条消息里的指代（这个、那张、它、这条任务）一律指向这张卡；先回答这张卡接着的那件事，不许把这条消息接到最近那条派活、最近那条系统通知或别的任务上；不许因为摘录短就吞掉这条消息里的要求。引用锚点只说明「接着哪张卡说」，不改变任何派活与工具规则。
```

602 轮用户消息只有一句 `这个任务完成了吗`；模型随后答的是引用修复任务（`session/message` 14541 / 14547 的推理与回复原文见日志），即：**两段引用都在、摘要逐字对、位置也在最末，模型仍然自选了最近那条任务。**

### 1.5 顺带确认的两条结构性事实（本轮未改，留档）

1. **一次性消耗**：引用被一条真实用户消息吃掉后 `turn/end` 删除；输入框那颗「带引用」提示随之消失（chip 文案本来就写着「发出去即失效」）。
2. **旧卡没有引用入口**：分页窗口默认只完整渲染最近 `CARD_WINDOW_DEFAULT = 30` 张卡（`src/secretary-card-shared.ts:18`），更旧的卡压成一行折叠行，而折叠行只有时间 + 24 字短标题、**没有引用按钮**（`SecretaryCollapsedCard.tsx`）。16:41:47 那次登记证明卡片 584 当时在渲染窗口内（能点到）；如果页面刷新过、窗口回到 30 张，584 会变成折叠行，想引用也没有入口。这是「引用旧卡」的结构性缺口，改它要推翻「折叠行只有时间+标题」这条既有需求并改冒烟断言，本轮**没动**，建议单独定。

### 1.6 登记侧三条静默丢路径（本轮已修，见 §3）

1. `postQuote()` 在 `session === ''` 时直接 `return`（页面刚起来、store 还没拿到会话 id 时点引用 → 本地有、宿主永远没有，且不报错）；
2. 任意一次 POST 失败把 `hostBroken` 永久置真，之后所有登记都不再 POST（宿主重载/网络抖动一次就静默废掉整页的引用）；
3. 宿主引用路由借用普通 `readJsonBody` 的 `MAX_BODY_BYTES = 4096`：卡正文全文（引用链路要带到 20000 字）一进来就 413。

## 2. 根因判定

1. **602 轮（真·引用失效）**：登记、键、内容、位置全部成立，失效点是**只靠措辞约束**——引用段是系统提示里的一段说明文字，模型在多个候选任务里自己挑了最近那条。判据：prompt 里 1783 + 1791 都在、`cardKey`/轮次/摘录逐字对、1791 在派活分层之后，回复仍串任务。
2. **603 轮（用户以为引用着）**：不是「引用被提前吃掉」也不是「POST 失败」，而是**没有登记**（§1.2 三处零写入 + 该轮 prompt 无引用段 + 该轮消息是纯文本+截图）；用户说的引用是 602 那一次，已按一次性语义消费。
3. **登记侧还有三条静默丢路径**（§1.6）：它们不是 603 的直接原因（603 连 `setQuote` 都没进），但都会造成「点了引用、宿主什么都没有」的同款现象，必须堵。

## 3. 改动（只落在引用链路）

### 3.1 宿主 `src/assistant-secretary.ts`

| 行号 | 改动 | 边界 |
|---|---|---|
| 310-311 | 新增 `QUOTE_MAX_BODY_BYTES = 256 * 1024`，引用登记路由单独用它（普通路由仍是 4KB） | 只为装下卡正文全文 + 附件信息；base64 不认 |
| 322-333 | 新增 `SECRETARY_QUOTE_CARD_SECTION_ORDER = 10250` | 宿主 `systemPrompt` 段落号是纯数字排序（`dsh-system-prompt` 的 `SECTION_ORDERS` 最大项 `DEPLOYMENT_PERSONA_SUFFIX = 10200`），10250 排在它之后 = 整段系统提示最末，紧贴这条用户消息 |
| 332-343 | 新增 `QUOTE_BODY_MAX_CHARS = 20000`、`QUOTE_ATTACHMENT_MAX = 12`、`QUOTE_ATTACHMENT_TEXT_MAX = 160` | **引用链路自己的预算**；卡片展示预算（900/600/200、FOLD_*）一个字没动，`QUOTE_PREVIEW_MAX_CHARS` 仍是 600 |
| 346-367 | 新增 `SecretaryQuoteAttachment`；`SecretaryQuoteRecord` 增 `body` / `attachments` | 旧记录没有这两个字段 → 归一成空串/空数组，注入时退回 `preview`（向后兼容） |
| 388-415 | 新增 `normalizeQuoteAttachments()` / `normalizeQuoteBody()`：正文默认全文照录，超 20000 字才截断并**显式写出**「后面还有 N 字未注入」 | 截断要看得见，不许悄悄少半截 |
| 459-486 | `normalizeQuoteRecord()` 带上 `body`/`attachments`；1783 段末尾加一句「本轮系统提示最末还有一段『本轮必须回答的卡』，以那一段为准」 | 既有 1783 断言（`引用登记只说明`、`不是完整汇报`、定位行等）一字未改 |
| 500-520 | `secretaryQuoteAnchorText()` 追加禁令「不许在多个候选任务里自己挑一个来接」 | 只加强、不删既有措辞 |
| 507-548 | **新增 `secretaryQuoteCardBlockText()`**：`# 本轮必须回答的卡（个人秘书）` + 卡定位 + 卡正文全文（`—— 卡正文开始/结束 ——` 包起来）+ 附件文件信息 + 【硬要求】+【禁令】（不许接最近派活/系统通知/最近一轮进度/多候选自选/用「已完成」回答没问的事）+【附件口径】（图片本体没随引用注入、不许编造、不许假装看过图） | 纯函数，测试逐条断言 |
| 797 | 引用路由 `readJsonBody(req, QUOTE_MAX_BODY_BYTES)`，并接收 `body` / `attachments` | 只影响 `/api/assistant/secretary-quote` |
| 1060-1090 | 注册 `assistant:secretary-card-quote-card` 段（order 10250），门的口径与 1783/1791 完全同源：只喂固定秘书会话、过期即清并落盘、真实用户消息那轮 `turn/end` 一起收掉；注销补上 | 不改只读闸、不改通知回合锁定、不改派活规则 |
| 1345-1352 | 测试面导出新常量/纯函数 | — |

### 3.2 客户端 `src/client/pocket/orb/secretary-cards.ts`（store 与归一）

| 行号 | 改动 |
|---|---|
| 2244-2260 | 新增 `SecretaryQuoteAttachment`、`QUOTE_BODY_MAX_CHARS = 20000`、`QUOTE_ATTACHMENT_MAX = 12`、`QUOTE_ATTACHMENT_TEXT_MAX = 160` |
| 2266-2335 | `SecretaryQuoteRecord` 增 `body`/`attachments`；`normalizeQuoteAttachments()` / `normalizeQuoteBody()`；`normalizeQuoteRecord()` 带上这两个字段（与宿主同一口径） |
| 2363 / 2490 | `setQuote()` 接受 `body`/`attachments`，本地缓存、POST、宿主回读全带 |
| 2456-2483 | **登记侧静默丢修法**：`session === ''` 时记成 `pendingPost`，`setSession()` 拿到 id 立刻补发一次；`postQuote()` 不再被 `hostBroken` 永久锁死，失败后下一次登记照旧重试，成功即解除 |
| 2662-2665 | 测试面导出 |

### 3.3 卡片组件（只加两个透传字段）

| 文件:行号 | 改动 |
|---|---|
| `SecretaryReplyCard.tsx:152-160` | `QuoteCardButton` 新增 `body` / `attachments` 可选属性 |
| `SecretaryReplyCard.tsx:172-186` | `store.setQuote({ …, body, attachments, … })` |
| `SecretaryReplyCard.tsx:555` | 秘书回复卡：`body={display}`（回答全文） |
| `SecretaryUserCard.tsx:290-299` | 用户卡/通知卡：`body={copyText}`（消息原文，通知卡已去 `[[session:]]` 标记）、`attachments` 只传 `{name, kind, meta}`（**不传 `src`**，blob:/data: 一律不带出浏览器） |

### 3.4 构建产物与测试

- `lib/index.js`、`lib/client.js`：`node build.mjs` 重新构建（仓库惯例随源码提交）。
- `scripts/test-assistant-secretary.mjs`：新增 2 条用例（结构化卡块、全文口径），见 §4。
- `scripts/test-secretary-cards.mjs`：新增 2 条用例（body/附件全链路、静默丢补发/重试），见 §4。

### 3.5 明确没动的

卡片展示预算（900/600/200、`FOLD_*`、`QUOTE_PREVIEW_MAX_CHARS`、`QUOTE_CHIP_PREVIEW_MAX_CHARS`）、折叠行 UI、分页窗口、一次性消耗语义、只读闸/通知回合/派活分层、hpg 定价与客服制单闭环、V0 标签。

## 4. 端到端回归（先 FAIL 后 PASS，全部原始输出）

### 4.1 旧代码（HEAD `2dd2d2a` 的构建产物；把 `src`/`lib` 改动 stash 掉后跑新用例）

```
$ node scripts/test-assistant-secretary.mjs
PASS 27 条既有用例（逐条 PASS，一字未放宽）
FAIL 引用结构化卡块（第 2 次报障硬手段）：有活引用时本轮 prompt 最末产出「本轮必须回答的卡」，含全文（不截 600）+ 附件 + 三条禁令
AssertionError [ERR_ASSERTION]: 宿主要把卡正文全文原样存下来（不许按 600 摘录截）
+ actual   undefined
- expected '本地部署的大模型为什么执行任务时出现这个错误[图1:image.png]\n乙乙…乙卡正文最后一句。'
FAIL 引用正文全文口径：body 不按 600 摘录截断、超 20000 字才截断且截断可见；preview 仍是 600，卡片展示预算不动
TypeError: Cannot read properties of undefined (reading 'length')
（exit code 1；PASS 27 / FAIL 2）
```

```
$ node scripts/test-secretary-cards.mjs
PASS 58 条既有用例（逐条 PASS）
FAIL 引用登记带全文与附件（第 2 次报障）：body 不截 600、附件只传文件信息，缓存/宿主 POST/回读三处都在
AssertionError [ERR_ASSERTION]: body 必须整段留下（600 只是摘录/展示口径）
FAIL 引用登记不许静默丢（第 2 次报障登记侧）：会话 id 还没到手先记待发、setSession 后补发；POST 失败后下一次登记照旧重试
AssertionError [ERR_ASSERTION]: setSession 拿到 id 后必须把刚才那次登记补发到宿主（否则宿主 prompt 里一个字都没有）
0 !== 1
（exit code 1；PASS 58 / FAIL 2）
```

### 4.2 新代码（最终构建）

```
$ node scripts/test-assistant-secretary.mjs
PASS 引用结构化卡块（第 2 次报障硬手段）：有活引用时本轮 prompt 最末产出「本轮必须回答的卡」，含全文（不截 600）+ 附件 + 三条禁令
PASS 引用正文全文口径：body 不按 600 摘录截断、超 20000 字才截断且截断可见；preview 仍是 600，卡片展示预算不动
PASS 29/29 assistant-secretary
（exit code 0）

$ node scripts/test-secretary-cards.mjs
PASS 引用登记带全文与附件（第 2 次报障）：body 不截 600、附件只传文件信息，缓存/宿主 POST/回读三处都在
PASS 引用登记不许静默丢（第 2 次报障登记侧）：会话 id 还没到手先记待发、setSession 后补发；POST 失败后下一次登记照旧重试
PASS 60/60 secretary-cards
（exit code 0）
```

### 4.3 四条新用例钉的是什么

- **结构化卡块**：引用卡正文 694 字（>600）+ `image.png` 附件 → 断言本轮必须有一段 `assistant:secretary-card-quote-card`（order 10250）、标题 `# 本轮必须回答的卡`、含 `cardKey`/轮次/种类、**含全文（`卡正文最后一句。` 在、`…` 不在）**、含附件名与「图片本体没有随…注入」、含三条禁令、只喂固定会话、真实消息那轮 `turn/end` 后一起收掉；纯函数对空记录回空串、通知卡没轮次说「未知」、没附件说「这张卡没有附件」。
- **全文口径**：`body` 900 字整段留下、`preview` 仍 600；超 20000 字截断并在正文里显式写「超过 20000 字…未注入」；附件去重/坏值丢；9000 字正文能登记（不再 413）、`GET` 回读全文与附件。
- **客户端全链路**：`body`/`attachments` 走完 `normalize → localStorage 缓存 → POST（不含 src）→ GET 回读`。
- **静默丢**：会话 id 未定时登记先记待发、`setSession` 后补发（`POST` 计数 0 → 1、sessionId/cardKey 正确）；POST 失败一次后下一次登记仍会重试（`retried.length` 1 → 2）。

## 5. 冒烟 `scripts/smoke-secretary-page.mjs`（引用断言）

在现网宿主上跑（用户红线：**没有重启宿主**），Chrome 手机视口 + 桌面两档：

引用相关断言全 PASS（节录原始行）：

```
PASS 点卡片引用后输入框那侧出现「带引用」提示、而且挂在宿主 composer 里 — {"chip":"ok","flag":"带引用","meta":"第 583 轮 · 秘书回复卡","preview":"✅ 到手了 · 京东 48G 显卡实物最便宜 4999 元，全新正…","radius":"8px","inComposer":true,…,"cardKey":"assistant:turn:583",…}
PASS 提示带轮次号 + 卡片种类 + 那张卡正文开头一小段（不整段贴） — {"flag":"带引用","meta":"第 583 轮 · 秘书回复卡","preview":"✅ 到手了 · 京东 48G 显卡实物最便宜 4999 元，全…"}
PASS 按「取消引用」后提示立刻收掉、本地缓存那份也清干净（下一条不带引用） — {"chips":0,"cached":["null","null"]}
PASS 第 4 项现场证据：每张完整卡（秘书/用户/通知）脚部都有引用按钮、顺序是引用→时间→操作区；折叠行不带按钮 — {"cards":8,"cardsWithButton":8,"buttons":8,"collapsedRowsWithButton":0,"order":["quote,time,actions",…]}
PASS 点过引用 chip 的通知卡当场已读（红点不出现、data-unread=0；自动朗读先读过也算） — {"cardKey":"notice:13:input-message02972bf7-…","before":{"dot":true,"unread":"1"},"after":{"dot":false,"unread":"0"}}
PASS 带附件的用户消息卡（现网现场）：附件前后文字都留在卡片里、块顺序没乱 — {"order":["attachment","para"],"texts":["image.png","[图1:image.png] 我引用这个任务，…"]}
```

唯一 FAIL 是**现场折叠项**，与引用链路无关：

```
FAIL 折叠生效率 100%：每张内容超过固定上限的卡都收在 ≤162px 正文区…
{"foldedCount":6,"flatCards":[{"kind":"user","maxHeight":"none","natural":180,"clientHeight":180,"cardHeight":315,"fold":"static","ellipsis":false,"expand":false}],…}
```

判定：这是「用户卡正文/图片高度 180px、没进折叠」的现场测量项，本轮改动不碰折叠测量/CSS/预算；同一项在上一轮报告里三次同代码运行是 1→3→0 漂移的已知现场抖动。另：冒烟跑在**没重启的现网宿主**上，本轮服务端注入改动不在这一轮里生效；冒烟会在真实秘书会话里留测试痕迹（插话卡 turn 608 等），与既有惯例一致。

## 6. 全套逐脚本（最终构建，85 个 `scripts/test-*.mjs`，逐脚本 exit code）

`83/85 exit 0；2 个已知红，均已 A/B 证明旧代码（HEAD `2dd2d2a` 构建产物）同样失败：`

- `test-mobile-proxy.mjs` exit 1：`AssertionError [ERR_ASSERTION]: gzip 浏览器也必须收到精简后的 boot graph` → 旧代码同项同错（A/B：`OLD_MP_EXIT=1`，同一行断言）。
- `test-secretary-session-log-write.mjs` exit 1：`Error: 宿主真实解析器不可用，已拒绝写入会话日志：D:\deepseek-harness\packages\session\session-format-v3-to-v4\lib\index.js（不存在）；D:\DSH Desktop…（不存在）` → 旧代码同项同错（A/B：`OLD_LW_EXIT=1`）。本机没有它要求的宿主源码 checkout，属环境前置缺失。

85 个脚本逐条（原始 exit code + 脚本自述末行）：

```
test-assistant-archive.mjs                     exit=0    ok   路由注册齐三条，非 POST 一律 405，import 的坏 body 有明确错误码 / PASS 10/10
test-assistant-card.mjs                        exit=0  ok test-assistant-card: 12 assertions
test-assistant-config-write.mjs                exit=0    ok   非法 JSON / 空 body 一律 400（不能当成"没改动"静默 200） / PASS 11/11
test-assistant-cu-watch.mjs                    exit=0  PASS 项目卡数据源：注册表给显示名、removed/hidden 排除、会话归并补集 / PASS 16/16 assistant-cu-watch
test-assistant-diagnostics.mjs                 exit=0    ok   测试面存在且带了脱敏规则数量 / PASS 6/6
test-assistant-dispatch.mjs                    exit=0  PASS 宿主既没事件流也没活队列：立刻判未确认，不空等 10 秒 / PASS 32/32 assistant-dispatch
test-assistant-home.mjs                        exit=0  ok test-assistant-home: 41 assertions
test-assistant-memory.mjs                      exit=0    ok   readRuntimeMemory 把真源元数据挂到条目上（面板显示 [importance] / 分支 / 改于） / PASS 7/7
test-assistant-open-diag.mjs                   exit=0  PASS readOpenDiagTail 只给尾部（不返回整本日志） / PASS 5/5 assistant-open-diag
test-assistant-proactive.mjs                   exit=0  PASS 路由：DELETE 清空 / PASS 9/9 assistant-proactive
test-assistant-secretary.mjs                   exit=0  PASS 引用正文全文口径：body 不按 600 摘录截断、超 20000 字才截断且截断可见；preview 仍是 600，卡片展示预算不动 / PASS 29/29 assistant-secretary
test-assistant-tts.mjs                         exit=0  PASS 路由：status 回报引擎/端点/音色，且不回落其它引擎 / PASS 5/5 assistant-tts
test-assistant-tts-worker.mjs                  exit=0  PASS 池：dispose 释放全部连接并拒绝在途请求 / PASS 7/7 assistant-tts-worker
test-bottom-overlay.mjs                        exit=0    ok   被移除的节点不再参与这一段的避让计算 / PASS 15/15
test-clipboard.mjs                             exit=0    ok   空文本直接返回 false，不弹键盘也不写剪贴板 / PASS 6/6
test-composer-focus-gate.mjs                   exit=0  ok test-composer-focus-gate
test-composer-inline-image.mjs                 exit=0   / 25/25 PASS
test-composer-ledger.mjs                       exit=0    ✓ 可疑样本压成一行现场：种类@时长 + 标记 + 前几条变更（超长截断） / test-composer-ledger: PASS 10/10
test-composition-gate.mjs                      exit=0    ✓ 正常打字每 20 段合并发一次：前 19 段都不发 / test-composition-gate: PASS 27/27
test-console-assets.mjs                        exit=0  console-assets: exact JPEG bytes + lazy Blob + GET/HEAD/405 OK
test-console-filter.mjs                        exit=0  ok test-console-filter: 7 assertions
test-coordinate-mode.mjs                       exit=0   / 6/6 通过
test-cu-bridge.mjs                             exit=0   / 18 cases passed
test-cu-capture-scale.mjs                      exit=0    ok   窗口真被搬动（owner 矩形变了）时才按新 rect 重算 / PASS 14/14
test-cu-code-agent-notice.mjs                  exit=0    ok   提示词口径也不再要求「为简短而裁」：code_agent 工具描述、CU 提示词、cordis 预设三处同步 / PASS 12/12
test-cu-observation-surface.mjs                exit=0    ok   本来就在前台时不该去抢焦点（前台就是微信：一次 focusWindow 都不许有） / PASS 15/15
test-cu-title-bold.mjs                         exit=0   / test-cu-title-bold: 全绿
test-desktop-ball-gestures.mjs                 exit=0  PASS 球体 HTML：拖动中不触发长按（移动超过阈值会取消计时） / PASS 6/6 desktop-ball-gestures
test-downlink-lanes.mjs                        exit=0    ok   close() 清掉唤醒定时器：关连接后不再排队、也不再往外写 / PASS 11/11
test-face-cache.mjs                            exit=0    ok   空 id / 非法 id 直接 null，不占缓存 / PASS 6/6
test-first-run-guide.mjs                       exit=0    ok   没有 localStorage（隐私模式）时读写都不崩、状态退回 never / PASS 5/5
test-local-store.mjs                           exit=0    ok   非法 JSON / revive 抛错 / 循环引用都不能把调用方带炸 / PASS 7/7
test-mobile-boot.mjs                           exit=0  mobile-boot: graph + combo + preload + external guard OK; real-size batches=4074428 / 4072448 / 4068777
test-mobile-drawer-chrome.mjs                  exit=0  ok test-mobile-drawer-chrome
test-mobile-drawer-nav-close.mjs               exit=0  PASS 13/13
test-mobile-perf-policy.mjs                    exit=0    ok   尾快照缓存：窗口内复用（含在途），过期重取，失败不缓存 / PASS 5/5
test-mobile-proxy.mjs                          exit=1  System.Management.Automation.RemoteException / Node.js v24.13.0
test-mobile-scan-facts.mjs                     exit=0    ok   公平轮转：settle 仍优先，其余按「多久没被取样」轮转，名额不变 / PASS 10/10
test-mobile-session-pagination.mjs             exit=0  mobile-session-pagination: 8/8 通过
test-mobile-session-scrollable.mjs             exit=0  PASS 全程 frozen 判据未在「抽屉关着」时成立（逐场景断言已覆盖，这里收尾） / ok test-mobile-session-scrollable — PASS 10/10
test-mobile-settings-live.mjs                  exit=0  SKIP 页面没进手机壳（data-mobile-nav="frame" 不存在）——先确认视口 < 1024 或手机布局已生效
test-mobile-settings-sheet.mjs                 exit=0   / PASS 32/32 mobile-settings-sheet
test-mobile-toggle-zone.mjs                    exit=0  ok test-mobile-toggle-zone
test-mobile-uplink-history.mjs                 exit=0  mobile-uplink-history: 5/5 通过
test-model-settings-notice.mjs                 exit=0  model-settings-notice: first scan + nested/characterData/detached + 20k-node incremental guard OK
test-native-input-policy.mjs                   exit=0    ok  控制室：首屏只挂前 12 张，其余空闲帧补齐 / [test-native-input-policy] 6/6 passed
test-new-project-default.mjs                   exit=0    ok   宿主侧配置文件：newProjectParent / asrTerms / persona / allowedRoots 都从本地 JSON 读 / PASS 11/11
test-path-guard.mjs                            exit=0    ok   src/index.ts 里每条数据路由都过了 allowlist（静态核对，别漏路由） / PASS 8/8
test-pc-file.mjs                               exit=0   / PASS 9/9
test-perf-counters.mjs                         exit=0    ok   perfNowMs 单调可用（浏览器与 node 都有 performance） / PASS 9/9
test-pocket-drawer-dismiss.mjs                 exit=0  PASS 开着抽屉再点汉堡 ⇒ 收起（同一次点击不二次翻转） / ok test-pocket-drawer-dismiss — PASS 8/8
test-pocket-first-run.mjs                      exit=0    ok   设置文件权限是 0600（里面存着 PIN 与隧道 Token） / PASS 5/5
test-pocket-runtime.mjs                        exit=0  pocket-runtime: HMR reuse + revision replacement + delayed disposal OK
test-pocket-session.mjs                        exit=0  pocket-session: persistent across restart + isolated per home OK
test-project-exit.mjs                          exit=0   / PASS 11/11
test-quality-gate.mjs                          exit=0    ok   lint 查的是查得动的东西，且个人化残留与旧仓库名不许复现（宿主侧） / PASS 7/7
test-release-consistency.mjs                   exit=0    ok   运行时插件自名与包名一致（工作台半部不再自称 dsh-worktable） / PASS 6/6
test-secretary-card-render.mjs                 exit=0  PASS parseAnswerBody keeps one conclusion title and later paragraphs / PASS answerInlineTokens marks strong an…
test-secretary-cards.mjs                       exit=0  PASS 硬约束确认：折叠预算 3/2/10、首帧上限 162px、朗读 34px 与标识 32px、观感口径 900/600/200 一个都不许动 / PASS 60/60 secretary-cards
test-secretary-card-visual.mjs                 exit=0  dual: D:\dsh-assistant\tmp-secretary-user-card.png 900x1524px / CARD VISUAL PASS
test-secretary-dispatch.mjs                    exit=0  PASS 项目名短于 2 字不参与匹配；目录名参与匹配 / PASS 12/12 secretary-dispatch
test-secretary-log-repair.mjs                  exit=0  PASS secretary log repair drops invalid synthetic fragments and validates / PASS round trip compress and decom…
test-secretary-notice-turn.mjs                 exit=0  PASS 摘要带整段原文（不再只取首句）、缺标题时兜底 / PASS 5/5 secretary-notice-turn
test-secretary-open-guard.mjs                  exit=0  PASS 幂等落状态：内容没变就不落（防重渲染震荡） / PASS 5/5 secretary-open-guard
test-secretary-open-rebuild.mjs                exit=0  PASS 落地断言：面板被顶走（当前会话 ≠ 秘书会话）必须切控制室显示原因 / PASS 12/12 secretary-open-rebuild
test-secretary-open-recovery.mjs               exit=0  PASS unknown session 那一类错误要认得出来（实测原文） / PASS 10/10 secretary-open-recovery
test-secretary-pagination-context.mjs          exit=0  ok   真会话 surface 折叠读回：宿主压缩 shadow 的旧轮不在模型投影里、卡片事件仍在日志里 / PASS 26/26 secretary-pagination-context
test-secretary-pagination-dom.mjs              exit=0   / PASS 卡片分页 DOM 验收全部通过（tmp-secretary-pager-dom.png）
test-secretary-quote-chip-visual.mjs           exit=0  wide: D:\dsh-assistant\tmp-secretary-quote-chip-wide.png 1280x520px / QUOTE CHIP VISUAL PASS（截图 5 张）
test-secretary-session-log-write.mjs           exit=1  System.Management.Automation.RemoteException / Node.js v24.13.0
test-secretary-speech-chunks.mjs               exit=0  PASS 缓存：同一句第二次朗读零合成、首块秒播 / PASS 16/16 secretary-speech-chunks
test-secretary-turn-tail-complete-hide.mjs     exit=0  PASS 作用域：没有 body[data-dsh-secretary="1"] 时完成行照常可见（改动只作用域秘书页） / PASS 7/7 secretary-turn-tail-complete-hide
test-session-focus.mjs                         exit=0   / PASS 13/13
test-session-folder.mjs                        exit=0   / PASS 21/21
test-session-index.mjs                         exit=0   / PASS 4/4
test-session-list-filter.mjs                   exit=0   / session-list-filter: 8/8 通过
test-session-rank.mjs                          exit=0   / PASS 21/21
test-session-status.mjs                        exit=0   / PASS 8/8
test-split-entry.mjs                           exit=0   / PASS 4/4
test-split-observer.mjs                        exit=0  split-observer: lazy install + external split + idempotent dispose OK
test-tuoguan-autoanswer.mjs                    exit=0    ok   后台 Code 会话：没装门控 → 一律不代答（不猜着放行） / PASS 19/19
test-tuoguan-autocontinue.mjs                  exit=0    ok   安装器拿不到 agents / 没有事件总线时安静降级，不抛错 / PASS 19/19
test-turn-guard.mjs                            exit=0  turn-guard: 全部用例通过
test-uninstall-plan.mjs                        exit=0    ok   不是 junction 的真实目录一律不摘（避免误删用户拷进去的东西） / PASS 5/5
test-web-routes.mjs                            exit=0  web-routes: legacy takeover + lifecycle + 3 HMR generations OK
```

关键几条：

```
test-assistant-secretary.mjs :: exit=0 :: PASS 29/29 assistant-secretary
test-secretary-cards.mjs :: exit=0 :: PASS 60/60 secretary-cards
test-secretary-quote-chip-visual.mjs :: exit=0 :: QUOTE CHIP VISUAL PASS
test-secretary-pagination-context.mjs :: exit=0 :: PASS 26/26
test-secretary-pagination-dom.mjs :: exit=0 :: 卡片分页 DOM 验收全部通过
test-secretary-session-log-write.mjs :: exit=1 :: 宿主真实解析器不可用（旧代码同失败）
test-mobile-proxy.mjs :: exit=1 :: gzip boot graph（旧代码同失败）
```

## 7. 生效条件（明确写）

- **宿主服务端注入（「本轮必须回答的卡」段、引用记录 `body`/`attachments`、256KB 登记上限）必须等宿主重新加载插件才生效**。本轮按红线**没有重启**，所以这些改动现在**还没进真实秘书会话的 prompt**——602 那种「只靠措辞」的现场要等下次重启后才会换成结构化卡块。
- **客户端 `lib/client.js`**：`node build.mjs` 已产出；宿主刷新页面下发新 bundle 即生效（重启后一并生效，无需再操作）。客户端改动只有新增透传字段与 store 补发/重试，不改变任何既有 DOM 结构与样式。
- **数据兼容**：引用文件里旧记录没有 `body`/`attachments` → 归一成空，卡块正文退回 `preview`（不会报错、不会注入空块）。

## 8. 提交

本地 commit（`fix(secretary):` 前缀），不 push；只 `git add` 本轮改的文件（4 个源文件 + 2 个测试 + 2 个构建产物 + 本报告）。`.tmp/`、`outputs/`、`tmp-*.png` 保持未跟踪。commit 短号与 stat 见最终回复（报告随该 commit 入库，无法在文内自指）。

## 9. 遗留（证据不足/本轮故意不动）

1. **折叠行没有引用入口**：更旧（30 张窗口外）的卡想引用也没有按钮；改它要推翻「折叠行只有时间+短标题」的既有需求并改冒烟断言，建议单独立项。603 时 584 是否已折叠无法从日志证实（页面 16:35 boot 后没刷新、16:41:47 还能登记说明当时在窗口内）。
2. **一次性消耗语义没改**（既有断言钉住「引用只能被一条真实用户消息吃掉」）：用户想接着上一张卡继续说，必须再按一次引用；本轮只能把「按了引用就一定会被结构化钉住」做到位。
3. **本次硬手段尚未在真实模型上验证**：宿主没重启，真实轮次里还看不到卡块段；下一步只能等用户重启后取一轮真实取证（本轮不往真实秘书会话发实验消息）。
4. POST 失败重试是「下一次登记时重试」，不是后台自动重试队列：用户只点一次、宿主恰好那一刻不可用，仍需要用户再点一次（但不会再被永久锁死）。
