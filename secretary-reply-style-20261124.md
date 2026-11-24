# 个人秘书回复卡片：简洁硬约束落地报告（2026-11-24）

代码提交：`4997445`（本地，未 push）
基线：任务给的 HEAD 是 `537a1c5`；动手前实测 HEAD 已是 `b7a6ae8`（多一条 docs 报告提交，本地领先 18 条），按现状继续，未 reset/rebase/amend。

## 一、结论先行

- 注入段 `SECRETARY_SPEECH_STYLE_TEXT` 加了三条可执行口径（五、六、七）并扩了第四条：第一句直接回答、默认 3 到 5 句、正文约 300 字上限、禁止照抄/整段转述 CU 回执、先对准用户问的那个任务。
- 渲染侧**未改**：卡片已经做到「结论行 18px/600 加重 + 每段一行 14px/26px」，折叠只裁 `max-height`，DOM 全文与复制全文一个字不少（依据见第四节）。
- 四个源改动文件：1 处源码、2 处测试、1 个重建产物。实测 4 files changed, 54 insertions(+), 6 deletions(-)。

## 二、改了哪几个文件哪几处

| 文件 | 行号 | 改了什么 |
| --- | --- | --- |
| `src/assistant-secretary.ts` | 925–931 | 常量上方注释重写：写明 2026-11-24 简洁硬约束的来历与五/六/七三条覆盖什么 |
| `src/assistant-secretary.ts` | 938 | 第四条扩写：加「也不许整段转述」「禁止把回执里的日志原文堆进回复」；「保留关键硬事实」保留原顺序（文件名、大小、哈希、数字、提交号、判据、结论、待办）；`read` 落盘路径读回全文那句原样保留 |
| `src/assistant-secretary.ts` | 939 | 新增第五条：结论先行（第一句直接回答、不许铺垫、不许先复述） |
| `src/assistant-secretary.ts` | 940 | 新增第六条：长度硬上限（3 到 5 句、最多 5 个要点独占一行、约 300 字） |
| `src/assistant-secretary.ts` | 941 | 新增第七条：对准任务（先判断用户问的是哪件事，只答那件） |
| `scripts/test-assistant-secretary.mjs` | 670 | 旧断言名「注入段仍是那 4 条」改成「注入段原有的二、三、四条仍在（编号顺序不许变，新口径只许往后加）」——旧措辞不再留成正确断言；断言本身（`二、`/`三、`/`四、` 都在）保留 |
| `scripts/test-assistant-secretary.mjs` | 673–701 | 新增一条断言用例「简洁硬约束（2026-11-24）」，逐条验 300 字上限、3 到 5 句、最多 5 个要点、每个要点独占一行、第一句直接回答、不许铺垫、不许先复述、禁止照抄、日志、整段转述、read 落盘路径、硬事实；并断言旧「原样转述」口径不许回来 |
| `scripts/smoke-secretary-page.mjs` | 896–910 | 通知行判据改成与客户端 `isSyntheticNoticeUserText`（`src/secretary-card-shared.ts:37-50`）同一套：首行「（系统通知…）」头 或 正文含 `[[session:…]]` 引用行；**不再用「正文里出现『系统通知』四个字」的子串判据**（根因见第五节） |
| `lib/index.js` | — | `node build.mjs` 重建产物（+4/−1 行） |

未动（红线全部保持）：`SECRETARY_READONLY_TOOLS`、`SECRETARY_GOAL_TOOLS`、`secretaryToolDenied`、通知回合闸、`steering` 插话卡片行、附件卡片规则、`FOLD_*` 预算与 162px 上限、朗读按钮/32px 标识、900/600/200 观感口径。

## 三、新增约束句子原文（最终态，可逐字对照）

第四条（整句，改后）：

> 四、不许整大段原封不动照抄 Computer Use 会话的回复，也不许整段转述：先给结论，自己整理成简短的中文回复，只保留关键硬事实（文件名、大小、哈希、数字、提交号、判据、结论、待办）；禁止照抄表格与长路径，禁止把回执里的日志原文堆进回复，禁止把通知原文再抄一遍。必须先拿到完整内容再整理——原文被裁就按通知里的落盘路径用 read 整段读回，不许只依据被裁的摘录作答。

第五条（新增）：

> 五、结论先行是硬口径：开头第一句直接回答用户这条消息问的那件事，答案先落地；不许铺垫、不许先复述用户的问题再回答（「好的」「关于你说的这件事」这类开场白不算第一句）。

第六条（新增）：

> 六、长度硬上限：默认 3 到 5 句讲完；确需展开时最多 5 个要点，每个要点独占一行，不把几个要点揉进一个长段；一次回复正文不超过约 300 字，超过 300 字就是没整理，必须压回 300 字以内再发。

第七条（新增）：

> 七、对准任务再回答：回复前先判断用户这条消息问的是哪个任务，只针对那件事给结论，不堆无关细节，不把别的任务的进展塞进这条回复。

保留未动：第一条（口语化短句、不要 markdown 符号/表格/列表符号）、第二条（数字一律保留阿拉伯写法，2026-11-24 口径，一字未动）、第三条（`[[session:会话id|会话标题]]` 引用）。

注入段长度：改前 564 字符 → 改后 841 字符（每轮多 277 字符，属注入侧成本，已记在这里备查）。

## 四、渲染侧判断：不需要改，依据如下

判断：**不改** `SecretaryReplyCard.tsx` 与 `secretary-cards.ts` 的渲染逻辑。四项要求已经由现有实现保证，且"折叠"是纯视觉的，正文从不被切碎或截断：

1. **结论行加重 + 要点分行已实现**：`secretary-cards.ts:627-640` `parseAnswerBody` 把首行拆成 `title`、其余每行一个 `paragraphs[]`；首行超 48 字时只在**句末标点**处切开，后半句下沉为段落（切在句界、不切字、不丢字）。`SecretaryReplyCard.tsx:521-523` 渲染 `title` + 全部 `paragraphs`；`secretary-cards.css.ts:346-361` 给 `title` 18px/600 加粗主色、`para` 14px/400/26px 次要色——正是"结论行加重、要点分行"。
2. **重点加重还有第二条通道**：`secretary-cards.ts:642-678` `answerInlineTokens` 把 `**…**` 渲染成 `<strong>`（`css.ts:362-365` 600 加粗），要点内重点不需要改渲染。
3. **折叠只是视觉折叠**：`secretary-cards.ts:779-784` `cardFoldStyle` 只写 `max-height`；`css.ts:307-317` 折叠态给 `title` 两行行夹、给 `content` 162px 上限；`css.ts:318-328` 展开态 `line-clamp:none` + `max-height:none !important`。正文 DOM 始终是全文（`SecretaryReplyCard.tsx:520-543` 渲染 title + 全部 para + 全部引用 chip），`overflow && !open` 只额外渲染一个装饰性 `…`（`:541`），不替换任何文字。
4. **复制与朗读拿的都是全文**：`SecretaryReplyCard.tsx:444` `speechText = normalizeForSpeech(body)`、`:556` `CopyAnswerButton fullText={display}`——复制的不是裁剪后的可见部分。
5. **窗口外的老卡也没丢内容**：`SecretaryCollapsedCard.tsx:50-58,90` 把老卡压成一行折叠行，点开显示 `pager.previewText(cardKey) || fallbackText` 全文预览（只有这一行的**标题**是截短的，正文可展开）。
6. **折叠判据全按内容高度**：`SecretaryReplyCard.tsx:256-275` `measureFoldClip` 读 `offsetTop/offsetHeight/scrollHeight`，不按字符数算，所以给模型加长度上限不会和折叠算法打架。

因此本次的短板不在渲染侧，而在"模型是否按行、按长度输出"——那正是第三节注入段解决的。为改而改（例如在渲染侧再按句号切段）等于替模型重排正文，会与"不许把内容切碎"这条红线相冲突，故不做。

残余限制（如实记录）：若模型偶发把 300 字揉成一行不换行，卡片仍会把它渲染成"结论行（首句）+ 一个长段落"，视觉上不如分点清爽。这是模型输出格式问题，注入段第六/七条已按"每个要点独占一行"约束它；渲染侧不代劳重排。

## 五、测试（命令 + 原始结果）

顺序：先加断言跑 RED，再改源码到绿。

RED 记录（旧注入段 564 字符时）：

- `node scripts\test-assistant-secretary.mjs` → `PASS 24/25`，1 条 FAIL：
  `FAIL 简洁硬约束（2026-11-24）：300 字上限、3 到 5 句、最多 5 个要点、第一句直接回答、禁止照抄`
  `AssertionError [ERR_ASSERTION]: 注入段必须写清一次回复正文约 300 字的上限`（首个断言就挂）
- 逐项清点旧文案缺哪些字样：缺 `300 字`、`3 到 5 句`、`最多 5 个要点`、`第一句`、`直接回答`、`日志`、`整段转述`、`每个要点独占一行`；已有 `禁止照抄`、`硬事实`。

GREEN（改后，全部原始输出）：

| 命令 | 原始结果 |
| --- | --- |
| `node build.mjs` | `[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js`，进程 EXIT=0 |
| `npm run check` | EXIT=0（`node --check` 六个产物全过，无报错） |
| `node scripts\test-assistant-secretary.mjs` | `PASS 25/25 assistant-secretary` |
| `node scripts\test-secretary-notice-turn.mjs` | `PASS 5/5 secretary-notice-turn` |
| `node scripts\test-secretary-cards.mjs` | `PASS 55/55 secretary-cards`（含「折叠预算 3/2/10、首帧上限 162px、朗读 34px 与标识 32px、观感 900/600/200」那条硬约束用例） |
| `node scripts\test-secretary-card-visual.mjs` | `PASS` 81 项，收尾 `CARD VISUAL PASS` |
| `node scripts\smoke-secretary-page.mjs` | `PASS` 131 项 / `FAIL` 0，收尾 `SMOKE PASS 全部通过` |
| `npm test` | EXIT=0；全链 PASS 行 329 条，末行 `test-cu-title-bold: 全绿`（无任何 FAIL 行） |

冒烟那项"假失败"的根因（已修，如实记录）：首两跑各 `FAIL 1 项`，报「每条通知行都归到卡片 … `{"noticeRows":3,"noticeCarded":2}`」。临时加诊断字段取证后确认那条"通知行"其实是**用户真消息**——正文「个人秘书会话页面的系统通知的存活时间由 10 分钟改为 10 秒钟。」被旧判据 `/系统通知/.test(rowText)` 当成通知行，于是"通知行 = 通知卡 + 空壳"的等式永远差 1。改成与客户端 `isSyntheticNoticeUserText` 同一套判据后：`{"noticeRows":4,"noticeCarded":4,"noticeExpiredShells":0}`，断言通过。诊断字段已删除，最终该文件只有判据那一处 +12/−3。

补充：`npm test` 不含 `smoke-secretary-page.mjs`，且冒烟那次修的是测试脚本，未触及 `lib/`，所以上表 npm test 结果仍然代表当前构建态。

## 六、提交与状态

```
$ git show --stat --oneline 4997445
4997445 fix(secretary): 回复口径落硬约束：第一句直接回答、默认 3 到 5 句、正文约 300 字、禁止照抄 CU 回执
 lib/index.js                         |  5 ++++-
 scripts/smoke-secretary-page.mjs     | 15 ++++++++++++---
 scripts/test-assistant-secretary.mjs | 32 +++++++++++++++++++++++++++++++-
 src/assistant-secretary.ts           |  8 +++++++-
 4 files changed, 54 insertions(+), 6 deletions(-)
```

- 代码提交短号：`4997445`；本报告单独一条 docs 提交（内容即本文件）。
- 未 push：`origin/main` 仍是 `5843725`，本地领先条数已相应增加；无任何 push 动作。
- 未重启宿主、未跑 `dev:web`、未改 `apps/web` 之外的宿主产物。
- 未删/未覆盖任何用户文件；`git add` 只加了上表 4 个文件（报告单独加）。

## 七、没验到的部分

1. 真实宿主里模型拿到新注入段后的**实际回复长度**没做端到端取证（要等下一次真实对话；本轮不重启宿主、不跑 dev:web，故无法现场观察新卡）。
2. 300 字上限只在提示词层约束，客户端**没有**硬截断（有意不做：截断会丢信息）。若模型不服从，卡片仍会显示全文并折叠。
3. 冒烟测试里「现场历史恰好有通知卡」的那几项（第 1 项现场过期核对、第 3 项 compact 现场核对）本轮现场仍跳过（窗口里没有对应行），判据由 `test-secretary-cards.mjs` 与视觉套件覆盖。
4. 模型侧对"3 到 5 句"的服从度、以及"每个要点独占一行"的排版遵从度，需要后续用真实对话样本抽查。
