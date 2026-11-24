# 只展示最新一条用户消息那一轮的执行过程（2026-11-24）

代码提交：`fd1c20d`（本地，未 push）；本报告单独一条 docs 提交。
基线：动手前 HEAD = `3394f52`（前三件都已提交、工作区脏文件只有未跟踪产物），未 reset/rebase/amend，未覆盖前几件的改动。

## 一、结论先行

- 过程行不再「一律隐藏」：**只放行最后一条 user/steering 宿主行那一轮**的过程行，历史轮次照旧 `display:none`。
- 锚点每次扫描现算（文档顺序里最后一条 user/steering 行 + 它的 `data-chat-turn`），先摘旧标记再重打⇒ 新用户消息一来标记整体后移，上一轮立刻收回隐藏。**没有写死任何 turn 号**。
- 放行名单：`tool-call` / `context` / `turn-process` / `model-retry` / `turn-error` / `turn-max-tokens`、`data-chat-group-key` 分组容器、`data-turn-process-member` 分组成员、以及带 `data-chat-group-part="reasoning"` 的 `assistant-step`（那就是「已搜索代码，已读取文件」那类叙述）。
- **不放行**：没有 reasoning 标记的 `assistant-step`（现场 dump 实测行高 1038px，是**回复正文**，卡片已经展示同一段文字，再露出来就是重复）、`manual-compaction`、回合尾部件（本回合记忆/技能）。理由与现状证据见第四节。

## 二、改了哪几个文件哪几处

| 文件 | 行号 | 改了什么 |
| --- | --- | --- |
| `src/client/pocket/orb/secretary-cards.ts` | 1974–1995 | 新增「12. 最新一轮的过程行可见」整段口径注释：锚点怎么取、范围怎么算、不标哪些、怎么移动、卡片兜底 |
| `src/client/pocket/orb/secretary-cards.ts` | 1996–1998 | `PROCESS_VISIBLE_ATTRIBUTE = 'data-dsh-process-visible'`、`PROCESS_VISIBLE_KINDS`（6 个过程 kind，单一常量，要加/减一类只改这一行） |
| `src/client/pocket/orb/secretary-cards.ts` | 2000–2011 | `LatestTurnProcessTagResult`（marked / turnNo / anchorKind） |
| `src/client/pocket/orb/secretary-cards.ts` | 2013–2057 | `tagLatestTurnProcessRows(doc, options?)` 打标器（自包含，可整段注入页面跑真逻辑） |
| `src/client/pocket/orb/secretary-cards.ts` | 2059–2071 | `clearLatestTurnProcessTags(doc, options?)`（离开秘书页清标记） |
| `src/client/pocket/orb/secretary-cards.ts` | 2587–2588 | 测试面导出这两个函数（`secretaryTestSurface`） |
| `src/client/pocket/orb/secretary-cards.css.ts` | 81–90 | 新增放行规则：`body[data-dsh-secretary="1"] [data-dsh-process-visible="1"] { display: revert !important }`（两条选择器，第二条 `:not([data-dsh-scard])` 用来压过分组容器那条 (0,3,1) 的隐藏规则）。上面那些「一律 display:none」的规则一个字没改 |
| `src/client/pocket/orb/SecretaryUserCard.tsx` | 40 | 导入 `tagLatestTurnProcessRows / clearLatestTurnProcessTags` |
| `src/client/pocket/orb/SecretaryUserCard.tsx` | 410 | 离开秘书页时 `clearLatestTurnProcessTags(document)` |
| `src/client/pocket/orb/SecretaryUserCard.tsx` | 418 | 每次扫描 `tagLatestTurnProcessRows(document)`（紧跟 compact 打标之后、卡片收集之前） |
| `scripts/test-secretary-cards.mjs` | 648–716 | 新增打标器用例（第 5 项）：锚点判定、只标最新轮、历史轮不标、assistant-step 不标、追加新用户消息后标记后移、无锚点回 0、清标记 |
| `scripts/test-secretary-card-visual.mjs` | 322–336 | fixture 补两行：历史轮（turn 15）的 `tool-call`、最新轮（turn 16）里**没有 reasoning 标记**的 `assistant-step`（回复正文） |
| `scripts/test-secretary-card-visual.mjs` | 1461–1560 | 注入**真打标器**（`String(surface.tagLatestTurnProcessRows)` 进页面执行）+ 四条断言：最新轮可见 / 历史轮隐藏 / 回复正文不露 / 追加新消息后标记后移；原「过程行 0 条①」改成「未打标时一律不出图」（保留基线意义） |
| `scripts/smoke-secretary-page.mjs` | 461–487 | 「无过程信息行」旧的一律隐藏断言改成逐行判：带 `data-dsh-process-visible="1"` 才允许可见，未标却出图算泄漏 |
| `scripts/smoke-secretary-page.mjs` | 2339–2388 | 「卡片之间过程行 0 条」改成新口径：现算锚点，只允许「带标记 + 在最后一条用户行之后 + 同轮」的过程行可见，其余算泄漏 |
| `scripts/smoke-secretary-page.mjs` | 2198–2204 | 「上滚最多只取回下一段」的「总数不许变少」改成「秘书卡 + 用户卡不许变少」——通知卡 10 秒会自然过期收壳，总数本来就会掉 |
| `scripts/smoke-secretary-page.mjs` | 1866–1870 / 1884–1890 | 两条 ball-intent 断言不再要求「打开日志条数增长」——宿主那份日志是定长环形（实测 total 卡在 40），改成验最后一条 ball-intent 的 intent/source 与落地结果 |
| `lib/client.js` / `lib/index.js` | — | `node build.mjs` 重建产物 |

红线全部未碰：`FOLD_BODY_LINE_BUDGET=3`、`FOLD_TITLE_LINE_BUDGET=2`、`FOLD_BLOCK_GAP=10`、cap `162px`、朗读按钮 34px/标识 32px、900/600/200 观感口径；插话卡片（`steering` 行卡片化）与附件卡片（`collectUserCardRuns`）未改；`src/assistant-secretary.ts` 一个字没动；放行规则只写在 `body[data-dsh-secretary="1"]` 作用域内。

## 三、最新轮次定位口径（怎么算、怎么跟着移动）

**锚点**：`doc.querySelectorAll('[data-chat-flow-kind], [data-chat-group-key], [data-turn-process-member]')` 拿到文档顺序的候选表，**从尾往前**扫，第一条 `data-chat-flow-kind` 是 `user` 或 `steering` 的就是锚点。
- 用文档顺序而不是 turn 号比较：宿主渲染窗口/分页排序就是文档顺序（`buildSecretaryPagerCards` 那套也这么假设），写死 turn 号会在分页/插话时错位。
- `steering`（跑任务途中插话）与真用户行算同一类锚点：宿主给这两类注册的是同一个用户消息视图（6127e8e 那批实测）。

**范围**：锚点之后的候选行，逐条判：
1. 又是 user/steering → 跳过；
2. 两边都有 `data-chat-turn` 时必须相等；锚点没有轮次号时按「锚点之后」兜底（缺号不判死）；
3. 容器里挂着我们的卡（`[data-dsh-scard]`）→ 跳过（绝不把卡片连坐）；
4. 命中放行名单（6 个过程 kind / reasoning 的 assistant-step / 无 kind 但带分组 key 或分组成员标记）→ `setAttribute('data-dsh-process-visible','1')`。

**移动**：函数每次调用**先把所有带该属性的元素摘掉**，再重新打；`SecretaryUserCard` 的扫描 effect（MutationObserver 120ms 去抖 + 首帧补扫 400ms + 定时器）每次扫描都调一次 ⇒ 新消息到来、流式追加、滚动取回、页面重绘都会重算。离开秘书页时 `clearLatestTurnProcessTags` 把属性全清，别的会话页一个都不留（而且 CSS 本来就只在 `body[data-dsh-secretary="1"]` 下生效）。

**为什么放行 `display: revert`**：分组容器与成员行原本不是同一种 display，硬写 `block` 会改宿主的行内布局；`revert` 回到宿主/UA 自己的值，只解掉我们那条 `display:none !important`。

## 四、不标 `assistant-step`（回复正文）的依据

现场 dump（真页、插话那一轮）里泄漏出来的行是：

```
assistant-step|group=null|member=null|h=1038|刚才那条通知是坏的——会话最后吐出的是一段工具调用残片，既没有 commit 也没有报告。我…
```

行高 1038px、内容是**整段回复正文**——而同一轮的秘书回复卡已经在展示这段文字。放行它 = 同一条回复出现两遍。所以：
- `assistant-step` **只有**带 `data-chat-group-part="reasoning"` 时才放行（那是「已搜索代码，已读取文件，已调用工具」这类过程叙述，视觉 fixture 里就是这么标的）；
- `manual-compaction` 与回合尾部件（本回合记忆/技能）继续隐藏：它们是上下文管理与回合尾元数据，不是「执行任务的过程」。
- 这条取舍是**一个常量的事**：要放宽就把 kind 加进 `PROCESS_VISIBLE_KINDS`（`secretary-cards.ts:1998`）。

## 五、改前 / 改后关键代码

改前（CSS 只有一律隐藏，无任何放行）：

```css
body[data-dsh-secretary="1"] [data-chat-flow-kind="assistant-step"],
body[data-dsh-secretary="1"] [data-chat-group-part="reasoning"] { display: none !important; }
body[data-dsh-secretary="1"] [data-chat-flow-kind="tool-call"], … { display: none !important; }
```

改后（隐藏规则一个字没动，只多一条放行）：

```css
body[data-dsh-secretary="1"] [data-dsh-process-visible="1"],
body[data-dsh-secretary="1"] [data-dsh-process-visible="1"]:not([data-dsh-scard]) {
  display: revert !important;
}
```

```ts
// 扫描侧（SecretaryUserCard.tsx:418，每次扫描都调）
tagLatestTurnProcessRows(document)
// 锚点 + 范围（secretary-cards.ts:2013 起，节选）
let anchorIndex = -1
for (let i = list.length - 1; i >= 0; i -= 1) {
  if (anchorKinds.includes(get(list[i], 'data-chat-flow-kind'))) { anchorIndex = i; break }
}
const turnNo = get(list[anchorIndex], 'data-chat-turn')
for (let i = anchorIndex + 1; i < list.length; i += 1) {
  const el = list[i]
  if (turnNo !== '' && rowTurn !== '' && rowTurn !== turnNo) continue
  if (el.querySelector('[data-dsh-scard]') !== null) continue
  if (isProcessRow) el.setAttribute(attribute, '1')
}
```

## 六、测试（原始输出）

**RED**：先加打标器用例 → `node scripts\test-secretary-cards.mjs` → `FAIL 最新一轮过程行可见（第 5 项）…`，`TypeError: surface.tagLatestTurnProcessRows is not a function`（1 条失败）。视觉套件的新断言在打标器未注入成功时也先红（`page.evaluate: ReferenceError: PROCESS_CANDIDATE_SELECTOR is not defined`，随后改成内联字面量修好）。

**GREEN（最终树）**

| 命令 | 原始结果 |
| --- | --- |
| `node build.mjs` | EXIT=0，`[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js` |
| `npm run check` | EXIT=0（六个产物 `node --check` 全过） |
| `node scripts\test-secretary-cards.mjs` | `PASS 58/58 secretary-cards`（新增 1 条） |
| `node scripts\test-assistant-secretary.mjs` | `PASS 25/25 assistant-secretary` |
| `node scripts\test-secretary-notice-turn.mjs` | `PASS 5/5 secretary-notice-turn` |
| `node scripts\test-secretary-card-visual.mjs` | PASS **84** 项，收尾 `CARD VISUAL PASS`，EXIT=0（含新增 4 条第 5 项断言） |
| `npm test` | EXIT=0，PASS 行 **332**、FAIL 行 **0**，末行 `test-cu-title-bold: 全绿` |
| `node scripts\smoke-secretary-page.mjs` | **未拿到全绿终态**（用户叫停收尾）。已完成的三次现场跑：`PASS 115 / FAIL 2`（两条 ball-intent）、`FAIL 1`（上滚分页总数）、以及一次 `FAIL 2`（同 ball-intent）。逐条定位后已分别改成新口径（见第二节末三行），但修完**没有再做完整复跑** |

冒烟那几条不是本次改动的回归：ball-intent 两条的失败 JSON 是 `{"before":{"total":40},"after":{"total":40, ...}}`（宿主打开日志定长环形，条数不再增长）；上滚分页那条是 `{"before":7,"after":6}`（通知卡 10 秒 TTL 到点收成空壳，总数自然掉 1）。这两处旧假设在「10 分钟 TTL」时代成立，改档后不成立。

## 七、提交与状态

```
$ git show --stat --oneline fd1c20d
fd1c20d feat(secretary): 只展示最新一条用户消息那一轮的执行过程，历史轮次仍隐藏
 lib/client.js                                | 158 ++++++++++++++-------------
 lib/index.js                                 |  59 ++++++++++
 scripts/smoke-secretary-page.mjs             |  84 ++++++++++++---
 scripts/test-secretary-card-visual.mjs       | 126 ++++++++++++++++++---
 scripts/test-secretary-cards.mjs             |  63 +++++++++++
 src/client/pocket/orb/SecretaryUserCard.tsx  |   7 +-
 src/client/pocket/orb/secretary-cards.css.ts |  10 ++
 src/client/pocket/orb/secretary-cards.ts     | 101 +++++++++++++++++
 8 files changed, 505 insertions(+), 103 deletions(-)
```

- 代码提交短号：`fd1c20d`；本报告单独一条 docs 提交。
- 未 push；未重启宿主；未跑 `dev:web`；未删/未覆盖用户文件；`git add` 只加了上表 8 个文件。

## 八、没验到的部分

1. **冒烟没拿到全绿终态**：修完三处旧假设断言后按用户要求停止测试，未复跑。因此「现场页面上最新一轮过程行会不会真的出现/移动」只有视觉套件（真 Chromium + 真 CSS + 真打标器）与单测覆盖，缺一次真页 e2e 证据。
2. 宿主未重启：页面里跑的仍是宿主当前持有的那份 client bundle，重启后才是完整新行为（本轮按要求不重启）。
3. 真实浏览器里「过程行可见 → 卡片接管 → 布局高度」的观感没有截图取证；视觉套件只验 display 与高度非零。
4. `turn-process` 这类行在最新一轮里会不会让首屏变长（用户体验）没有现场取样；如果嫌长，把 `data-chat-flow-kind="turn-process"` 从 `PROCESS_VISIBLE_KINDS` 里去掉即可。
