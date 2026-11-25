# composer 图片光标标记（图片内联到正文位置）— 取证与实现报告（2026-11-25）

## 结论先行

- **宿主 composer 输入框不是 textarea，是 Lexical contenteditable**：`div[data-composer-input][contenteditable=true][role=textbox][data-lexical-editor=true]`（真页面快照实测 + 源码双重证据）。
- **「真内联缩略图」不可行（不改宿主的前提下）**：编辑器节点类型在 `createEditor` 时固定为 `[ReferenceChipNode, CommandChipNode, TextRefNode, QuoteNode]`，Lexical 不支持事后注册节点类型，decorator portal 也由宿主渲染——插件要做正文里的缩略图节点必须改宿主源码。**按预案走「光标标记」兜底**：图片进附件管线时，在当前光标处插入 `[图N:文件名]` 纯文本标记，编号 = 图片在 wire 用户消息里的序号（只数 image 类附件），删图后自动清残标 + 重编号。
- **映射规则（确定性）**：wire 用户消息内容 = `[...附件块(按 attachmentIds 顺序), 文本块]`（图片块全部排在文本块之前）。模型看到的第 N 个图片块 ↔ 文本里写的 `[图N:名字]`。带名字的标记靠名字认图（同名多张按出现次序一一对应）；无名字的 `[图N]` 按「第 N 张图」序号语义。chip 条保留不动（上传进度/重试/删除还靠它）。
- **没有改宿主任何文件**；全部走宿主公开通道：`inputActions.captureInsertion()` + `inputActions.insertText(text, span)`（draftRev CAS），附件状态走 `useInput`（标准 props）+ `conversation.resolveDraftAttachments`（PcFilePickerOverlay 已在用的同一服务面）。上方 chip 条一行没动。

## 一、宿主 composer 取证（app.asar 0.2.2，只读；提取到 .tmp/host-re 阅读）

### 1. 输入框形态
- `ComposerContentEditable.tsx:38-49`（@deepseek-ai/dsh-client-ui-conversation/src/client/input/editor/）：`<div contentEditable role="textbox" aria-multiline="true" data-composer-input>`，由 `editor.setRootElement(el)` 绑定 shell 持有的 Lexical editor。
- 编辑器创建：`input/editor/runtime.ts:85-89` — `createEditor({ namespace:'dsh-composer', nodes:[ReferenceChipNode, CommandChipNode, TextRefNode, QuoteNode] })`。**节点类型此处定死，是「真内联」不可行的根因。**
- 真页面快照（只读探针，Playwright→http://127.0.0.1:3081 本机 GUI，token 页用 ~/.dsh/dsh-pocket/token-lan 进）：`[data-composer-input]` 实测 `contenteditable="true" role="textbox" aria-multiline="true" data-lexical-editor="true" data-phase="plain"`，证据存 `.tmp/composer-dom-snapshot.json`。

### 2. 附件 chip 条挂在哪
- 卡片 DOM（InputBar.tsx:458-503）：`div[data-composer-card]` 的直接子节点顺序 = `[data-composer-overlay]` → **`div[data-slot="conversation.input.attachments"]`（附件 chip 条槽位）** → `div[data-input-scroll]`（编辑器滚动口，内含 `[data-composer-input]`）→ `div.row`（工具行）。真页面快照的子节点序列与源码一致。
- chip 条实现（@deepseek-ai/dsh-client-ui-attachment/src/client/ComposerAttachments.tsx:49-158）：`attachments`（输入顺序）→ `AttachmentRail`（`div.rail[role=group] > div.item`，AttachmentRail.tsx:148-157）；图片项 `div.imageItem > button.thumbnail > img[alt=文件名] + button.remove`（96-153 行），文件项 FileCard。**rail 顺序 = attachments 数组顺序，无拖拽重排。**

### 3. 附件状态在哪
- `InputState.attachmentIds: readonly DraftAttachmentId[]`（contract/input.ts:306-310）——**有序、只追加**：`addAttachments` 尾部追加（input/facade.ts:335-341），`removeAttachment` 过滤（362-369）。
- 浏览器侧附件对象：`ConversationController.draftAttachments: Map<DraftAttachmentId, ComposerAttachment>`（service.ts:160）；`resolveDraftAttachments(ids)` 按请求顺序返回（service.ts:462-469）。图片对象 `{kind:'image', id, file, previewUrl, width?, height?}`（contract/slots.ts:43-52）。
- 图片**一律**走上传管线：`apply.ts:522` `if (path === '' || (!directory && isImageMediaType(file.type))) uploads.push(file)`——桌面端有真实路径的图片也不走 `@path` 引用；非图片文件且有宿主路径才变成正文 `@path` 引用 chip（apply.ts:526-534 + facade.ts:349 addFiles）。
- 粘贴路径：编辑器内 PASTE_COMMAND（keymap.ts:282-298，文件走 `handlers.intakeFiles`，**不动光标**）；编辑器外 document 级 paste 路由（file-intake.ts:65-77）；「＋」文件选择框（InputBar.tsx:280-285）。全部汇入 `intakeFiles → addFiles`。

### 4. 提交时 text+attachment 如何组装（RPC 与模型视角）
- 提交机：`facade.ts:402-435 submit()` 发出 `enter` 事件，携带 `draft`（clipboard 投影）、`attachmentIds`（**有序快照**）（421-430 行）→ default-sink → `sinkSerialized`（727-749）→ `deps.defaultSink(text, attachmentIds, …)`（hub.ts:128, 269-281）→ `ConversationController.sendSession`（service.ts:234-315）。
- **组装规则（service.ts:302）**：`content = [...uploaded, ...(text === '' ? [] : [{ type:'text', text }])]`——**附件块按 attachmentIds 顺序在前，文本块在最后**。`session.prompt(content, mode, signal, requestId)`（service.ts:309）发 RPC。
- wire 类型（dsh-api-session-controller/src/types.ts:80-88 `PromptContentPart`）：`{type:'text',text}` / `{type:'image',mediaType,data,name?}` / `{type:'file',receiptId}`。已上传图片以 `{type:'file',receiptId}` 引用（service.ts:277），子代理续聊未上传图片内联 base64（276 行）；`encodeImage` 带上 `name: file.name`（service.ts:616-622）。
- 宿主侧 admission：commands.ts:321-387 `prompt()` → `admitPromptContent`（362 行）→ `createUserMessage({content, source})` → `agent.followup`。**模型按内容块顺序看到：第 1..N 个图片块，然后一个文本块**——这就是「第 N 张图」的锚。
- 图片数量/尺寸限制：intake 预检（InputBar.tsx:247-275）+ 宿主提交时复检。

### 5. 宿主是否已有正文内联引用语法
- `@文件`/`@文件夹`：有，但**只对桌面端有真实路径的非图片文件**（apply.ts:526-534 生成 ReferenceChipNode；提交时 `serializeReference` 展开成 `@path` 文本）。图片被 522 行强制排除。
- `![]()`、image.png 式图片标记：**没有**。user-text 规则只注册了 sessionReferenceRule + 两个空白规则（apply.ts:165-166），且那是会话记录渲染层，不是 composer。
- 公开写入通道（本实现依赖）：`InputActions.captureInsertion()`（contract/input.ts:273-274 → facade.ts:150，返回带 draftRev 的 detect 坐标选区 span）、`InputActions.insertText(text, span)`（contract/input.ts:275-280 → facade.ts:151-155，draftRev CAS + frozen 拒绝 → runtime.ts:282-287 `insertAsyncText`，PASTE_TAG 独立撤销步）。
- 坐标系：InputState.draft = clipboard 投影（chip 展开成 clipboardText）；insertText 的 span = detect 投影（chip=1 个 U+FFFC）。换算 `detect = clipboard − Σ(chip.length−1)`（projection.ts:145-154 同式）。chip 跨度从 localStorage 草稿镜像读：`dsh.conversation.<sid>` = `{draft:{text,references,quotes},view,viewRequest}`（stores.ts:8,43-56；宿主每次 publish 同步写，facade.ts:874-882；真页面 localStorage 实测同形）。

## 二、实现（dsh-assistant，全部在 src/client 新模块，走现有 client 注入链）

**路线选择**：真内联需改宿主（节点注册），不做；光标标记兜底落地。兜底代价（如实说明）：
1. 标记是纯文本不是缩略图——正文里看到的是 `[图1:a.png]` 字样，图片本体仍在上方 chip 条（chip 条保留，用户可对照）。
2. 用户手动大改标记文字（改名/删数字）后，reconcile 按规则清残标，不保证读懂用户意图。
3. 同名图片靠出现次序对齐，用户手动交换两个同名标记的位置会造成身份对调（序号仍自洽）。

**改动文件**：
- `src/client/pocket/orb/composerInlineImage.ts`（新增，304 行）：纯核心 + driver，零依赖。标记格式/扫描/消毒（`formatImageMarker`/`scanImageMarkers`/`sanitizeImageName`）、图片子序列与 diff（`imageAttachmentsOf`/`diffImageIds`）、自愈计划（`planReconcile`：带名标记按名字队列对齐、无名标记按序号语义、残标删除带一个尾随空格）、clipboard→detect 换算（`detectOffsetOfClipboardOffset` + `readChipSpansFromStorage`，镜像 text 与 live draft 一致才动手）、`createComposerInlineImageDriver`（新增图片光标处插标记一批一次 insertText；自愈每轮渲染最多 MAX_EDITS_PER_CALL=4 处、靠渲染轮收敛；frozen 不动作；localStorage `dsh-assistant.composerInlineImage`='0' 可关）。
- `src/client/pocket/orb/ComposerInlineImageBridge.tsx`（新增，84 行）：React 桥，不可见（return null），从槽位标准 props 拿 `useInput`/`inputActions`，每渲染把最新 InputState 喂 driver；卸载/换会话 forgetSession。
- `src/client/pocket/orb/orb-apply.tsx`（+8 行：19 import、63-75 注册）：注册到 `conversation.input.left`（与 PcFileInputBridge 同一不可见 list 槽位，id `assistant-composer-inline-image`，order 40），inject 工厂下发 sessionId + conversationApi。
- `scripts/test-composer-inline-image.mjs`（新增，447 行，25 条断言）。
- `package.json`（test 链接入，插在 test-composer-ledger 之后）。
- 构建产物 `lib/client.js` 随之更新。

## 三、测试原始数字

**旧代码 FAIL / 新代码 PASS（同一测试文件，先对改动前旧 bundle 跑、再对 build 后跑）**：
- 旧 bundle（build 前）：`24/25 PASS`，exit=1——唯一 FAIL 是构建产物断言「lib/client.js 缺 assistant-composer-inline-image」（功能尚不存在），原始日志 `.tmp/inline-image-old-fail.log`。
- 新 bundle（build 后）：`25/25 PASS`，exit=0，原始日志 `.tmp/inline-image-new-pass.log`。
- 25 条覆盖：标记格式/消毒/扫描、图片子序列（文件不进编号）、id diff、detect 换算、镜像一致性校验、reconcile（改名/删除/同名次序/无名序号语义/空计划）、driver 集成（粘贴 3 张一批一次插入、混排只编图片、删中间张重编号、连续删两张、含 @文件 chip 的坐标换算精确、CAS 冲突拒写、frozen 不插、空名 [图N]、手改名字清残标、会话切换 adopting、开关关闭、readStorage 异常不崩）。

**构建与静态检查**：
- `node build.mjs` exit=0（lib/index.js、lib/pocket.js、lib/client.js、lib/computer-use*.js 全部产出）。
- `npm run check` exit=0。
- `npm run lint` exit=1——**与本次无关**：15 处全是既有 .md 报告里的本机个人化标识（C::\Users\<ACCOUNT>、<NAME-CJK>），新文件零命中。
- `npm run typecheck` exit=2——**与本次无关**：本机没装 typescript（脚本自报【跑不起来】，需联网 npm install）。

**指定回归（原始输出）**：
- test-secretary-cards：`PASS 58/58 secretary-cards`，exit=0
- test-secretary-card-visual：`CARD VISUAL PASS`，exit=0
- test-assistant-secretary：`PASS 25/25 assistant-secretary`，exit=0
- test-pocket-drawer-dismiss：`ok test-pocket-drawer-dismiss — PASS 8/8`，exit=0
- test-mobile-drawer-nav-close：`PASS 13/13`，exit=0
- test-mobile-settings-sheet：`PASS 32/32 mobile-settings-sheet`，exit=0

**全套逐脚本**（npm test 链 78 个脚本逐个跑，原始总数）：见下方「全套逐脚本结果」节（跑完回填）。

**已知红（与本改动无关的证明）**：
- `test-secretary-session-log-write.mjs` exit=1：报「宿主真实解析器不可用…D:\deepseek-harness\packages\session\session-format-v3-to-v4\lib\index.js（不存在）」——它要读宿主源码 checkout 的 session-format 包，本机没有该目录；它只 import node 内置模块，不碰本次任何文件。
- `test-mobile-proxy.mjs` exit=1：只 import `../src/pocket-host/proxy.mjs`（本次未改），失败在模块加载阶段，与 composer 无关。

## 四、未验证项 / 边界

- **宿主未重启**：按规矩没重启宿主、没 dev:web；`lib/client.js` 已重建，**刷新页面后生效**（桌面端刷新或重开窗口）。
- **真机未验**：真实粘贴/选图→光标落标记→发送→模型按序号对图，这条端到端没在真实会话里跑过（规矩：绝不在真实会话发消息）。离线假宿主完整复刻了 facade.ts 的 CAS/frozen/detect 语义，真页面只做了只读 DOM/localStorage 快照。
- 真内联缩略图（decorator 节点）如将来要做，必须宿主在 createEditor 的 nodes 里加类型并提供 decorator 渲染位——需要用户拍板是否向上游提。
- 手机端同链路（同一 InputBar/composer），样式未单独验。

## 五、全套逐脚本结果

```
TOTAL ok=79 failed=2 of 81
FAILED: test-secretary-session-log-write.mjs   ← 已知红，与本改动无关（见上）
FAILED: test-mobile-proxy.mjs                  ← 已知红，与本改动无关（见上）
```

（81 = npm test 链里全部 test-*.mjs；逐个独立跑取退出码，单项日志在 .tmp/per-test-<name>.log。`npm test` 用 && 链会在 session-log-write 处截停，逐脚本跑法不受截停影响。）
