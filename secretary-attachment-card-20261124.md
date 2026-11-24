# 个人秘书用户卡「附件 + 附件之后的文字」修复报告（2026-11-24）

## 0. 一句话结论

✅ 已修复并本地提交（未 push）。根因：卡片扫描层只读宿主用户行里的**第一个** `[data-slot="conversation.user.text.node"]`（`secretary-cards.ts:909` 与 `:944`），而宿主编排器把一条「文字 + 附件 + 文字」的消息排成**多个气泡**（气泡 → `[data-message-attachments]` 行 → 又一个气泡），所以附件后半段文字既进不了卡片、又被 `secretary-cards.css.ts:70-72` 压成 `display:none` —— 现网截图里看到的就是「只有前半句」。

## 1. 定位结果（改前代码原文，行号按 `fd45ffe` 那一版）

### 1.1 `src/client/pocket/orb/secretary-cards.ts`

- `902`（注释口径本身就是错）：
  ```ts
   *   - 文本从 `[data-slot="conversation.user.text.node"]` 读，卡片自身挂在行上，不会把自己读回去。
  ```
- `907-917` `collectSecretaryCardRows`：
  ```ts
  export function collectSecretaryCardRows(doc: Document): SecretaryCardRow[] {
    const out: SecretaryCardRow[] = []
    for (const row of doc.querySelectorAll('[data-chat-flow-kind="user"]')) {
      const key = row.getAttribute('data-chat-node-key') ?? row.getAttribute('data-chat-flow-key') ?? ''
      const turnNo = row.getAttribute('data-chat-turn') ?? ''
      const textEl = row.querySelector('[data-slot="conversation.user.text.node"]')   // 909 ← 只拿第一条 run
      const text = String(textEl?.textContent ?? '').trim()                            // 910
      if (text === '') continue                                                        // 911 ← 纯附件消息直接被丢掉
  ```
- `942-946` `collectSecretaryCardElements`（服务端分页/折叠行走的 DOM 兜底路径，同一个错口径）：
  ```ts
  if (kind === CARD_KIND_USER || kind === CARD_KIND_NOTICE) {
    const row = element.closest('[data-chat-flow-kind="user"]') ?? element
    text = String(row.querySelector('[data-slot="conversation.user.text.node"]')?.textContent ?? '').trim()   // 944 ← 同样只读第一条
  ```

`querySelector`（不带 All）返回**第一个**匹配 → 后半段文字从头到尾没被读过一次。

### 1.2 `src/client/pocket/orb/secretary-cards.css.ts`（改前 63-78）

- `67-69`：完整卡 + 折叠行共用一条规则，带 `:not(:has(img))` 例外——带附件的宿主行气泡**保留**：
  ```css
  body[data-dsh-secretary="1"] [data-chat-flow-kind="user"]:has(> [data-dsh-scard="card"][data-dsh-scard-kind="user"], > …, > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], > …) > [data-slot="conversation.chat.node"]:not(:has(img)) { display: none !important; }
  ```
- `70-72`：把所有纯文本 run 一律压掉（两个气泡都被藏）：
  ```css
  body[data-dsh-secretary="1"] [data-chat-flow-kind="user"]:has(> …) [data-slot="conversation.user.text.node"] > span:not([data-dsh-scard]) { display: none !important; }
  ```
- `76-78`：后代兜底，同样带 `:not(:has(img))`。

结论：卡片只有前半句（扫描层），后半句在页面上也被 `display:none`（CSS 层）→ 用户看到的截断。

### 1.3 宿主那条行的真实形状（`D:\DSH Desktop\resources\app.asar` 取证 + 现网 dump）

asar 里 `contentParts`（idx 23803141）把连续 text block 并成一条 run、每个附件起一条独立 run，`UserContent`（idx 23903489）`runs.map(...)` → `textBubble(run.text)` + `div[data-message-attachments]`。现网实测行 `13:input-messagee74d0783-…`（turn 361，15:12）：

```html
<div class="DuJD4G_userRow"><div class="DuJD4G_userStack">
  <div class="DuJD4G_bubble">…<span data-slot="conversation.user.text.node">我看个人秘书回复的文本，把数字用汉字表示的，</span></div>
  <div class="DuJD4G_attachmentRow" data-message-attachments="true">…<img src="blob:http://127.0.0.1:3081/709777f3-…" alt="image.png"></div>
  <div class="DuJD4G_bubble">…<span data-slot="conversation.user.text.node">，这样阅读起来很吃力，我建议还是保留为数字。</span></div>
</div>
```

卡片侧（改前）：`card kind= user`、`paras = ["…把数字用汉字表示的，"]` —— 只有 1 段。

## 2. 改了什么（新口径）

### 2.1 `src/client/pocket/orb/secretary-cards.ts`（+192 行）

- `889-891` 三个 selector 常量：`USER_TEXT_RUN_SELECTOR` / `USER_ATTACHMENT_ROW_SELECTOR`（`[data-message-attachments]`）/ `USER_IMAGES_SLOT_SELECTOR`。
- 新类型：`UserCardAttachment { kind:'image'|'file', name, src, meta }`、`UserCardRun`（text | attachment）、`UserCardBodyBlock`（para | attachment）。
- `941 runsFromContainer` / `973 collectUserCardRuns`：从行根按 **document 顺序**往下走，气泡叶子出一条 text run（用叶子 `textContent`，所以同一条气泡里被引用 chip 切开的片段也拼得回来），附件行出附件 run。
- `992 attachmentRunsIn`：`img` → image（名字取 `alt`，退到外层框的 `aria-label`「image.png，点击查看原图」的第一段；`title="查看原图"` 不许当文件名）；没有 img 但有 `conversation.chat.user.images` 槽 → 占位 image run（src 空）；再没有 img、没有 images 槽 → 按 `fileCard[title]` 认文件附件，`meta` = 名字后面那段（`PDF 1.2 MB`）。
- `1016 userCardRunText`：只拼 text run（附件不混进文字 → 朗读/复制/引用注入的口径仍是纯文字）。
- `1025 userCardAttachments`、`1033 buildUserCardBody`：文本 run 沿用既有 `parseUserCardBody`（按空行分段），附件块按原位置嵌进去。
- `1074 collectSecretaryCardRows`：改成先收块再判空——`if (text === '' && attachments.length === 0) continue`（纯附件消息也出卡），`runs`/`attachments` 挂进行数据。
- `1111`（改前的 `944`）：`text = userCardRunText(collectUserCardRuns(row))`。
- `SecretaryUserRow` 增字段 `runs` / `attachments`；`secretaryCardsTestSurface`（`2262+`）导出 4 个新函数 + 3 个 selector。

### 2.2 `src/client/pocket/orb/SecretaryUserCard.tsx`（+71/-…）

- `79 rowSignature`：正文 + 附件 src 快照（宿主 blob 晚一拍才出来 → 必须重渲染）；`sameRows` 比较它。
- `85 CardAttachmentBlock`：image 出 `<img data-dsh-scard="attachment-thumb">` + `attachment-name`；`onError` 退化成「IMG + 名字 + 这张图宿主那份地址已经失效」芯片；文件出 `📎 名字 + meta`。
- `161 userBody = buildUserCardBody(row.runs ?? …)`、`hasBody` 含附件、折叠 signature 含 `userBody.length` 与 `rowSignature`。
- `255-261` 正文渲染改成按块顺序（通知卡那套分支原样保留）。
- `445` MutationObserver `attributeFilter` 加 `'src'`。

### 2.3 `src/client/pocket/orb/secretary-cards.css.ts`（+56）

改前（一条规则、带 `:not(:has(img))`）：

```css
body[data-dsh-secretary="1"] [data-chat-flow-kind="user"]:has(> [data-dsh-scard="card"][data-dsh-scard-kind="user"], > …notice, > [data-dsh-scard="collapsed-row"][…user], > …notice) > [data-slot="conversation.chat.node"]:not(:has(img)) { display: none !important; }
```

改后（完整卡不带例外、折叠行保留例外）：

```css
body[data-dsh-secretary="1"] [data-chat-flow-kind="user"]:has(> [data-dsh-scard="card"][data-dsh-scard-kind="user"], > [data-dsh-scard="card"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"] { display: none !important; }
body[data-dsh-secretary="1"] [data-chat-flow-kind="user"]:has(> [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"]:not(:has(img)) { display: none !important; }
```

后代兜底那条同样拆成两条；新增 `[data-dsh-scard="attachment" / -thumb / -name / -meta / -status / -icon]` 样式（`358+`，都在 `body[data-dsh-secretary="1"]` 作用域内，复用卡片自己那套 `--dsh-card-*` 变量：0.5px 边、10px 圆角、`accent-wash` 底、14px/20px），并把它加进 `[data-dsh-scard="content"] > … { flex: 0 0 auto; }` 那一列（`261`）。窄屏多一条 `@media (max-width: 420px)` 缩略图上限。

### 2.4 没动的东西（自查过）

`HISTORY_PREVIEW_MAX_CHARS = 900`、`QUOTE_PREVIEW_MAX_CHARS = 600`、`BOOKMARK_OUTCOME_MAX_CHARS = 200`、`CONTEXT_SUMMARY_*`、`FOLD_BODY_LINE_BUDGET = 3` / `FOLD_TITLE_LINE_BUDGET = 2` / `FOLD_BLOCK_GAP = 10` / `FOLD_FALLBACK_LINE_HEIGHT_PX = 26` / 162px 上限、`foldCollapsedCapPx` / `foldClipFromBlocks`、未读红点、朗读按钮、底行引用与时间规格、`src/assistant-secretary.ts` 的 `SECRETARY_READONLY_TOOLS`/`SECRETARY_GOAL_TOOLS`/`secretaryToolDenied`/通知回合闸、`src/secretary-card-shared.ts`（服务端分页口径一字未改，diff 里没有 `eventText`/`historyItemsFromEvents`）——全部 0 改动；作用域仍在 `body[data-dsh-secretary="1"]` 之内，非秘书页没碰。

## 3. RED → GREEN（同一套新断言，先红后绿）

### 3.1 RED（`.tmp/red-cards.txt` / `.tmp/red-visual.txt`，改代码前跑出来的）

`node scripts\test-secretary-cards.mjs` → `[exit code: 1]`，5 条 FAIL：

```
FAIL 秘书页只显示卡片：…观感口径 900/600/200 一个没变
AssertionError [ERR_ASSERTION]: 完整卡必须把宿主用户行整个压掉（这一条不许带 :not(:has(img)) 例外）
FAIL 附件回归①：… AssertionError [ERR_ASSERTION]: 附件后面的文字也不许再被截掉   actual: false
FAIL 附件回归②：… TypeError: surface.buildUserCardBody is not a function
FAIL 附件回归③：… AssertionError [ERR_ASSERTION]: 纯附件消息也要挂卡片   actual: 0, expected: 1
FAIL 附件回归④：一条气泡里多个 run（引用 chip 切开的那种）不许被拆成多段
```

`node scripts\test-secretary-card-visual.mjs` → `CARD VISUAL FAIL 2`：

```
FAIL 附件回归②：… {"thumb":{"display":"inline","width":98,"height":21,"loaded":false,…}}
FAIL 附件回归③：… {"hostNodeDisplay":"block","hostAttachRendered":true,"hostRunVisible":true}
```

### 3.2 GREEN（原始输出）

| 脚本 | 原始结果 |
| --- | --- |
| `node build.mjs` | `[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js`，`EXIT=0` |
| `npm run check` | 6 个 `node --check` 全过，`EXIT=0` |
| `node scripts\test-secretary-cards.mjs` | `PASS 46/46 secretary-cards`（含 `PASS 附件回归①/②/③/④`、原来那条 900/600/200 观感口径用例照旧 PASS） |
| `node scripts\test-secretary-card-visual.mjs` | `CARD VISUAL PASS`，PASS 77 条 / FAIL 0（`附件回归②` 现在 `thumb loaded:true 76×52 inCard:true`；`附件回归③` `hostNodeDisplay:none、hostAttachRendered:false、hostRunVisible:false`） |
| `node scripts\test-assistant-secretary.mjs` | `PASS 23/23 assistant-secretary` |
| `node scripts\test-secretary-notice-turn.mjs` | `PASS 5/5 secretary-notice-turn` |
| `node scripts\smoke-secretary-page.mjs` | `PASS 128 项` + 新增两条现场断言全 PASS（详见 §4）；1 项 FAIL 是改前就有的现网依赖，见 §5 |
| `npm test` | 链在第 24 个脚本 `test-secretary-pagination-context.mjs` 断开 → `FAIL 1/26`（改前同样失败，见 §5） |
| 断开之后其余 75 个脚本单独跑 | `FAILED-NOW: 0` / `ALL-OTHER-PASS`（逐个 `PASS n/n`，全在 `.tmp/run-rest.txt`） |

`test-secretary-cards.mjs` 里那 4 条新用例是假 DOM 照现网 dump 形状搭的（`fakeHostUserRow` + `fakeTextBubble`/`fakeImageAttach`/`fakeFileAttach`），断言逐条对应：三段文字全在且顺序正确 / 附件只在卡内 / 纯附件也出卡 / 同气泡多 run 拼回一段；900/600/200 三个数仍是按当前值断言（没写死成「正确」）。

## 4. 现网现场证据（改后，真页真 bundle）

插件是 Junction（`C::\Users\<ACCOUNT>\.dsh\profiles\desktop\node_modules\dsh-assistant` → `D:\dsh-assistant`），重新 `node build.mjs` 后新加载的页面就吃到新 bundle；**没有重启宿主、没有跑 dev:web**。

`node .tmp\probe-mixed-row.mjs`（`.tmp\probe-mixed-after.txt`）：

```
=== row 13:input-messagee74d0783-… turn 361 textSlotCount 2 ===
  run[0] display=none text="我看个人秘书回复的文本，把数字用汉字表示的，"
  run[1] display=none text="，这样阅读起来很吃力，我建议还是保留为数字。"
  card kind= user  paras = ["我看个人秘书回复的文本，把数字用汉字表示的，","，这样阅读起来很吃力，我建议还是保留为数字。"]
```
（改前只有 1 段；改后两段都在卡片里）

`node .tmp\probe-card-attachment.mjs`（turn 381 那条带截图的用户消息，手机端 414×896 档）：

```json
"blocks": [
  { "sc": "para",       "text": "个人秘书为什么会自己建立目标啊…请你禁用个人秘书建立目标完成任务。" },
  { "sc": "attachment", "kindAttr": "image", "text": "image.png", "thumbLoaded": true, "thumbBox": { "w": 118, "h": 108 } }
],
"hostNodeDisplay": "none", "hostAttachRendered": false, "cardImgVisible": true
```
卡片里附件那块的真实 DOM：
```html
<div data-dsh-scard="attachment" data-dsh-scard-attachment-kind="image" title="image.png"><img data-dsh-scard="attachment-thumb" src="blob:http://127.0.0.1:3081/63708170-…" alt="image.png" loading="lazy" draggable="false"><span data-dsh-scard="attachment-name">image.png</span></div>
```
截图：`.tmp\probe-mixed.png`（桌面档）、`.tmp\probe-card-attachment.png`（手机端档）。

### 桌面档现场（1440×900，`node .tmp\probe-card-attachment-desktop.mjs` → `.tmp\probe-desktop-out.txt`）

```json
{"nodeKey":"13:input-message5d6e3d7b-…","turn":"381","order":["para","attachment"],
 "paras":["个人秘书为什么会自己建立目标啊…由他们建立目标完成任务才对吧，请你禁用个人秘书建立目标完成任务。"],
 "thumbLoaded":true,"thumbVisible":true,"thumbBox":{"w":154,"h":140},
 "hostNodeDisplay":"none","hostAttachRendered":false,"collapsedRow":false}
```
现场卡片截图：`.tmp\probe-attachment-card-desktop.png`（621×361，卡片里正文一整段 + 嵌在卡内的缩略图与 `image.png`，脚部仍是「引用 66 · 15:42 · 复制」，卡外没有任何单独的原生附件芯片）、整页 `.tmp\probe-attachment-page-desktop.png`。

smoke 新增的两条现场断言原始输出：

```
PASS 带附件的用户消息卡（现网现场）：缩略图嵌在卡片内部、宿主原生附件行不再出图、文件名在卡里 — {"nodeKey":"13:input-message5d6e3d7b-…","thumb":{"w":118,"h":108},"name":"image.png","hostNodeDisplay":"none","hostAttachRendered":false}
PASS 带附件的用户消息卡（现网现场）：附件前后文字都留在卡片里、块顺序没乱 — {"order":["para","attachment"],…}
```

## 5. 没验到 / 遗留（照实列）

1. **smoke 那 1 项 FAIL 与本批改动无关**：`FAIL 所有按钮可键盘聚焦，焦点环为 2px #AFA9EC 偏移 2px — {"keyboard":{"skip":true},…}`。它读的判据是「秘书回复卡里含 `答案折叠验收` 的 fixture 卡」，这一轮那张卡不在窗口里（`usedFixture=false`）→ 断言自己 skip 掉。这条读的是 assistant 卡的朗读按钮，我一个字没动回复卡；`.tmp\smoke-live2.log`/`smoke-live3.log`（11-23 的旧现场）里这条曾 PASS，靠的正是当时窗口里有那张 fixture 卡。
2. **`test-secretary-pagination-context.mjs` 的 `FAIL 1/26` 是现网数据漂移，改前同样失败**：断言 `cardsBefore >= messageEvents.length * 0.9`；现网真会话日志实测 `events 9107 / message 2543 / cards 2124 / ratio 0.835`，缺口 407 条全是「只有 reasoning + tool-call、没有 text 块」的 assistant 轮（按既有判据「空正文事件一律不出卡」本来就不出卡）；`user/message 1745 → user+notice 卡 1745 张`（0 张不丢）。`secretary-fix-20261124.md`（上一批报告）里同一条也是 `FAIL 1/26`，并写明「不是本次修的」。我的 diff 没碰 `secretCardSharedTestSurface`/`eventText`/`historyItemsFromEvents`（`git diff` 里搜不到这些名字）。
3. **折叠态看不到缩略图**：附件块不进 `title/para/ref` 的折叠预算（按硬约束没动几何），所以卡一旦溢出（`data-overflow="1"`，正文上限仍是 3 行）折叠态只切到文字那几行，缩略图要展开才看得到——底部 `展开全文` 入口照旧。这一条是我按「折叠预算不许动」的约束保留的结果，没做二次口径。
4. **文件附件的真机现场没验**：这一轮现网窗口里没有文件附件的用户消息（只有 `image.png`）；文件 chip 的形状与名字/大小口径由 `test-secretary-cards.mjs 附件回归②` 那条假 DOM 用例覆盖（照宿主 `fileCard[title]` 那套形状搭的）。
5. **服务端分页口径没给纯附件消息补条目**：`eventText` 只取 text 块 → 只带附件、没文字的用户消息在分页数据里 preview 仍是空（客户端 DOM 路径现在会出卡）。要不要让两条口径一致，需要动 `secretary-card-shared.ts`，那文件不在本批授权范围（上一批报告 §5 也留了同样口子），我没改。
6. 朗读/复制/引用注入用的仍是纯文本口径（附件不进字），同音字纠正规则没碰。

## 6. 提交与确认

```
970ea46 fix(secretary): 用户卡收全附件前/后的文字、图片与文件附件嵌进卡片内部（原生附件行不再单独出图）
 lib/client.js                                | 257 ++++++++++++++++-----------
 lib/index.js                                 | 125 ++++++++++++-
 scripts/smoke-secretary-page.mjs             |  45 +++++
 scripts/test-secretary-card-visual.mjs       |  90 +++++++++-
 scripts/test-secretary-cards.mjs             | 188 +++++++++++++++++---
 src/client/pocket/orb/SecretaryUserCard.tsx  |  71 ++++++--
 src/client/pocket/orb/secretary-cards.css.ts |  56 +++++-
 src/client/pocket/orb/secretary-cards.ts     | 192 +++++++++++++++++++-
 8 files changed, 863 insertions(+), 161 deletions(-)
```
（上一条代码提交之后的这份报告单独走 `docs(secretary): …`。）

- `git status -sb` → `## main...origin/main [ahead 9]`：**没有 push**（也没有 fetch）。
- 没有重启宿主进程、没有跑 `pnpm run dev:web`、没有 rebase/amend 别人的提交、没有 `git add -A`（逐条 `git add` 这 8 个文件）；未跟踪的 `.tmp/`、`outputs/`、`tmp-*.png`、上一批那份 `secretary-context-measure-20261124.md` 都没动。
- 探针脚本都放在 `.tmp\`（未跟踪，只读取证）：`probe-mixed-row.mjs`、`probe-card-attachment.mjs`、`diag-pagination-context*.mjs`。
