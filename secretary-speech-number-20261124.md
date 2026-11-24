# 注入段「数字口径」改档报告（2026-11-24 · 朗读规范段 order 1780）

## 0. 状态

✅ 已改、已本地 commit、未 push。用户已明确批准这一条：注入段里的数字一律保留阿拉伯写法，禁止转写成汉字数字。

## 1. 定位（grep 结果 + 确切行号 + 改前原文）

候选确认：`src\assistant-secretary.ts` 的「输出与朗读」段 = 常量 `SECRETARY_SPEECH_STYLE_TEXT`（`928-935`），挂载点在 `834-872` 里 `order: 1780`（`842` 行注释：`派活规则段（1790）之前：先定表达，再谈派活`，`846` 行 `return SECRETARY_SPEECH_STYLE_TEXT`）。

全仓 grep（`念得出来|八点十二分|三公里|两公斤|摄氏度`）落在源码里的只有 2 行（其余命中是 `models/kokoro/**` 词典、`docs/鹈鹕语音播报-实现方案-20261108.md`、`README.md:96`、历史报告与 `outputs/**` 旧测试日志）：

- `src\assistant-secretary.ts:926`（注释）：
  ```ts
   * 数字/单位念读规则按用户原话：8–14℃ → 「8 到 14 摄氏度」。
  ```
- `src\assistant-secretary.ts:932`（注入段第 2 条，本次要改的那句）：
  ```ts
  '二、数字和单位要念得出来：温度写「8 到 14 摄氏度」这样的说法，时间写「八点十二分」，距离写「三公里」，重量写「两公斤」；英文缩写尽量换成读得出的中文说法，必须保留时照原文写（如车次 G1545）。',
  ```

没有任何测试断言过旧文案（`scripts/**` 里搜 `念得出来 / 八点十二分` 全 0 命中），旧句子只活在这两处源码里。

## 2. 改后原文

`src\assistant-secretary.ts:932`：

```ts
  '二、数字一律保留阿拉伯写法（这一条 2026-11-24 用户明确批准改口径）：字符数、token 数、字节数、尺寸与比例都照原样写，如 27458 字符、49915 token、9761427 字节、2617×1215；带单位的也照阿拉伯写（温度写 8 到 14 摄氏度、距离写 3 公里、重量写 2 公斤、时间写 8:12）；禁止把这些数转写成汉字数字；英文缩写尽量换成读得出的中文说法，必须保留时照原文写（如车次 G1545）。',
```

`src\assistant-secretary.ts:926`（注释跟着改口径）：

```ts
 * 数字口径（2026-11-24 用户明确批准改档）：一律保留阿拉伯写法（8 到 14 摄氏度、27458 字符、2617×1215），禁止转写成汉字数字。
```

同一个 diff 里段标题两行与第 1、3、4 条（口语化短句先给结论 / `[[session:会话id|会话标题]]` 单行引用 / 不许整大段照抄 CU 回复）一字未动 —— `git diff --stat`：

```
lib/index.js                         |  2 +-
scripts/test-assistant-secretary.mjs | 20 ++++++++++++++++++++
src/assistant-secretary.ts           |  4 ++--
3 files changed, 23 insertions(+), 3 deletions(-)
```

## 3. 测试：先 RED 再绿

新用例插在 `scripts/test-assistant-secretary.mjs` 既有「朗读规范补…」用例之后（`+20` 行，用例组数 23 → 24），断言内容：

- 注入段必须含 `数字一律保留阿拉伯写法`
- 必须出现阿拉伯数字示例：`27458`、`49915`、`9761427`、`2617×1215`、`8 到 14 摄氏度`
- 必须明确禁止汉字数字（`禁止…汉字数字`）
- 旧汉字数字示例必须清零：`念得出来`、`八点十二分`、`三公里`、`两公斤`（逐条 `!text.includes(...)`）
- 其它规则不许动：`口语化短句，先给结论`、`不要用 markdown 符号、表格、列表符号、表情符号、代码块`、`英文缩写尽量换成读得出的中文说法`、`车次 G1545`、段仍是 `二、三、四、` 四条

RED（改源码之前，`.tmp\red-number.txt`）：

```
[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js
BUILD EXIT=0
FAIL 数字口径改档（2026-11-24 用户明确批准）：注入段数字一律阿拉伯写法、汉字数字示例清零
AssertionError [ERR_ASSERTION]: 新口径必须在注入段里说清「数字一律保留阿拉伯写法」
  actual: '# 输出与朗读（个人秘书）\n' + …（仍是旧那句）
[exit code: 1]
```

GREEN（改完源码 + 重新 build）：

```
[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js
BUILD EXIT=0
CHECK EXIT=0                     （npm run check：6 个 node --check 全过）
PASS 数字口径改档（2026-11-24 用户明确批准）：注入段数字一律阿拉伯写法、汉字数字示例清零
PASS 24/24 assistant-secretary
```

各脚本原始数字：

| 脚本 | 原始结果 |
| --- | --- |
| `node build.mjs` | `BUILD EXIT=0` |
| `npm run check` | `CHECK EXIT=0` |
| `node scripts\test-assistant-secretary.mjs` | `PASS 24/24 assistant-secretary` |
| `node scripts\test-secretary-notice-turn.mjs` | `PASS 5/5 secretary-notice-turn`（`EXIT=0`） |
| `node scripts\test-secretary-cards.mjs` | `PASS 46/46 secretary-cards`（`EXIT=0`，上一批 4 条附件回归仍绿） |
| `npm test` | 第 24 个脚本断开：`FAIL 1/26 secretary-pagination-context`，`[exit code: 1]` |
| 断开之后其余 75 个脚本单独跑 | `FAILED-NOW: 0` / `ALL-OTHER-PASS`（`.tmp\run-rest-number.txt`） |

`npm test` 断开之前每个脚本的原始行（照 `.tmp\npmtest-number.txt` 逐条抄，共 344 行日志）：

```
mobile-uplink-history: 5/5 通过
mobile-session-pagination: 8/8 通过
ok test-assistant-home: 41 assertions
PASS 7/7                  （test-assistant-memory）
ok test-assistant-card: 12 assertions
PASS 24/24 assistant-secretary
PASS 12/12 secretary-dispatch
PASS 32/32 assistant-dispatch
PASS 16/16 assistant-cu-watch
PASS 5/5 secretary-notice-turn
PASS 8/8 secretary-session-log-write
PASS …                    （test-secretary-log-repair、test-secretary-card-render 逐条打印用例名）
PASS 9/9 assistant-proactive
PASS 5/5 secretary-open-guard
PASS 10/10 secretary-open-recovery
PASS 12/12 secretary-open-rebuild
PASS 5/5 assistant-open-diag
PASS 6/6 desktop-ball-gestures
PASS 46/46 secretary-cards
QUOTE CHIP VISUAL PASS（截图 5 张）
PASS 16/16 secretary-speech-chunks
PASS 7/7 assistant-tts-worker
FAIL 1/26 secretary-pagination-context
```

## 4. 现网现场取证（生效还差一步）

`node .tmp\p4.mjs`（只读，按 zstd 帧逐帧解真会话 `session.v4.jsonl.zstd`，取含注入段标记的 `system/message` 事件）：

```
总数 = 321
{"seq":9202,"type":"system/message","w":"OLD","head":"输出与朗读（个人秘书）\n…\n二、数字和单位要念得出来：温度写「8 到 14 摄氏度」这样的说法，"}
{"seq":9216,"type":"system/message","w":"OLD", …同一句… }
口径计数：{"旧口径":319,"新口径":2}（那 2 条是本会话自己正文里引用了新旧两句，不是注入段）
```

结论：源码与构建产物已改绿，但**宿主进程注入的仍是旧文案**——本次 build 之后的 prompt 快照（seq 9202 / 9216）实测还是「数字和单位要念得出来…八点十二分…三公里…两公斤」。上一批卡片修复之所以现网生效，是因为它走客户端 bundle（页面重新加载就吃到新 `lib/pocket.js` / `lib/client.js`）；而 `SECRETARY_SPEECH_STYLE_TEXT` 这段在 `lib/index.js`，是宿主进程 require 进来的插件文案，要等宿主重新加载插件才会换。本批红线是「不许重启宿主」→ 现场生效这一层没验到，只验到构建产物 + 断言这一层。

## 5. 没动 / 没验到（照实列）

1. `order 1770 / 1775 / 1783 / 1785 / 1790` 五段一字未动（diff 只有 `assistant-secretary.ts` 的 2 行）。
2. `SECRETARY_READONLY_TOOLS` / `SECRETARY_GOAL_TOOLS` / `secretaryToolDenied` / 通知回合闸没碰。
3. 卡片观感口径 `900 / 600 / 200` 没碰；`src\secretary-card-shared.ts`、`src\assistant-secretary-history.ts` 没碰；上一批（`970ea46` 用户卡附件）改动没被覆盖。
4. 客户端朗读规范化 `normalizeForSpeech`（`℃`→摄氏度、`8–14`→`8 到 14`、数字与汉字之间补空格，`src\client\pocket\orb\secretary-cards.ts:88-141`）没改：它只把符号单位念成中文，从不把阿拉伯数字转写成汉字数字，与新口径不冲突；`test-secretary-cards` 里那条 `8–14℃ → 8 到 14 摄氏度` 断言照旧 PASS。
5. `README.md:96` 里那行旧描述（「数字单位念读如『8 到 14 摄氏度』」）没改——它不在注入链路里，属仓库文档；要改另开一条。
6. `test-secretary-pagination-context` 的 `FAIL 1/26` 与上一批同样：现网数据漂移（真会话里 407 条只有 reasoning + tool-call、没有 text 块的 assistant 轮按既有判据不出卡，实测 `cards 2124 / messages 2543 = 0.835`），与本批改动无关（diff 里搜不到 `eventText` / `historyItemsFromEvents`）；本批没去修它。
7. 现网生效（宿主重新加载插件之后注入段真的换成新文案）没验到——要等宿主下次加载，本批不许重启宿主。

## 6. 提交与确认

本地代码提交：`18f928c fix(secretary): 注入段数字口径改档——一律保留阿拉伯写法、禁止转写汉字数字（用户批准）`，`git show --stat` 原始数字：

```
 lib/index.js                         |  2 +-
 scripts/test-assistant-secretary.mjs | 20 ++++++++++++++++++++
 src/assistant-secretary.ts           |  4 ++--
 3 files changed, 23 insertions(+), 3 deletions(-)
```

这份报告单独走第二条 `docs(secretary): …` 提交。`git status -sb` → `## main...origin/main [ahead 12]`：**没有 push**（也没有 fetch）；`git add` 逐条列这 3 个文件，没有 `git add -A`；未重启宿主、未跑 `pnpm run dev:web`；未碰用户的 Excel 与项目文件；未 rebase/amend 他人提交（`fd45ffe`、`1ab32c2`、`970ea46` 等仍在原地）。探针脚本 `probe-injection-text*.mjs`、`p4.mjs` 与 RED/GREEN 记录都在未跟踪的 `.tmp\` 里，没有进仓库。

