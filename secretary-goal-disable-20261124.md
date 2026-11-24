# 个人秘书「自己立目标」禁用报告（2026-11-24 · 第三批）

用户原话：「个人秘书为什么会自己建立目标啊，应该不需要自己建立目标，直接派发给 computer use 会话去完成就行了，由他们建立目标完成任务才对吧，请你禁用个人秘书建立目标完成任务。」

## 0. 状态

✅ 已改、已本地 commit（`cb12788`）、未 push。**插件改动要宿主重新加载插件才生效，本批按红线没有重启宿主** —— 现网那一轮注入的闸话仍是旧口径（见 §5）。

## 1. 改动位置与改前/改后代码要点（`src\assistant-secretary.ts`）

### 1.1 `secretaryToolDenied` —— goal 类从放行翻成拒绝

改前（`:221-223`）：
```ts
  if (SECRETARY_READONLY_TOOLS.has(name)) return false
  if (SECRETARY_GOAL_TOOLS.has(name)) return false
  if (SECRETARY_ALLOWED_TOOLS.has(name)) return false
```
改后（`:221-223`）：
```ts
  if (SECRETARY_READONLY_TOOLS.has(name)) return false
  if (SECRETARY_GOAL_TOOLS.has(name)) return true // 2026-11-24 用户明确指令：秘书侧不立目标，goal 类一律拒绝（目标归 Computer Use 会话自己立）
  if (SECRETARY_ALLOWED_TOOLS.has(name)) return false
```
`SECRETARY_GOAL_TOOLS`（`:158-160`，名单 `create_goal` / `update_goal` / `get_goal`）保留下来，但语义从「放行名单」变成「显式拒绝名单」；`create_goal` 等不会掉进前缀兜底（`web_` / `session_` / `mnemon_`）所以拒绝是点名生效，不靠默认分支。

### 1.2 `secretaryNoticeTurnAllowed` —— 通知回合不再放行 goal

改前（`:241-245`）：
```ts
  if (SECRETARY_READONLY_TOOLS.has(name)) return true
  if (SECRETARY_GOAL_TOOLS.has(name)) return true
  return false
```
改后（`:241-245`）：
```ts
  if (SECRETARY_READONLY_TOOLS.has(name)) return true
  // 2026-11-24 用户明确指令：通知回合也不放行目标类；create_goal/update_goal/get_goal 落到默认拒绝
  return false
```

### 1.3 两条 deny reason（`:775` 通知回合闸、`:781` 秘书只读闸）

改前 `:781` 里那句话：
```
读文件 read/glob/grep、立目标 create_goal/update_goal/get_goal、只读联网 web_search/web_fetch 都是放行的
```
改后：
```
读文件 read/glob/grep 与只读联网 web_search/web_fetch 是放行的；create_goal / update_goal / get_goal 已被禁用——目标由 Computer Use 会话自己立、自己完成，秘书请用 secretary_dispatch 派活，不要自己建目标
```
`:775`（通知回合）加了同一口径：
```
…再派活都不行）。立目标也一样被拒（create_goal/update_goal/get_goal）——目标由 Computer Use 会话自己立、自己完成，这一轮秘书不做目标管理；确实还要动手就用 secretary_dispatch 改派。完成就把那条…
```
两处 reason 里原有的「必须立即调用 secretary_dispatch / 已派活 vs 已入队」话、以及通知回合「完整汇报、先给结论、不照抄」的口径都没改。

### 1.4 注释改档（同一文件，不动行为）

`:150-156`（goal 名单的说明：两轮语义都写清，2026-11-23 的放行理由标成「当时」）、`:168-170`（通知登记表说明）、`:199-206`（放行清单从「三类」改成「两类」并单列 goal 类已拒）、`:232-239`（通知回合放行只剩纯读类）。
另 `src\client\secretary-dispatch.ts:142` 那句旧注释（写着 goal 类放行）也一并改成新口径，只是注释，不改判断逻辑。

## 2. 明确没动的部分

- `SECRETARY_READONLY_TOOLS`（`read` / `glob` / `grep` / `read_image`）照旧放行；`web_search` / `web_fetch`、`secretary_dispatch`、日程四件套、`mnemon_*` / `session_*` 前缀放行都没碰。
- A/B/C 派活分层段（order 1790）、汇报口径段（order 1780 那四条款）、卡片引用段（1783）、语音输入段（1785）、注入段数字口径（上一批改的 `:932`）—— 本批一字未改（diff 里 1780 段没有 `-` 行）。
- 通知回合「通知 → 再派活 → 再通知」那道闸的其余逻辑（登记表、回合结束恢复、白名单）只加了 goal 这句话，回路判据没改。
- 卡片观感口径 900 / 600 / 200、上一批用户卡附件改动（`970ea46`）都没被覆盖。
- 闸只作用于固定秘书会话：`tools/pre-execute` 里 `caller !== activeSessionId → next()` 那两条守卫没动，Computer Use 会话与子代理仍能自己立目标（测试 `工具闸只对固定秘书会话生效` 仍绿）。

## 3. RED（先改测试，实现未改时跑出来的原始行）

`node scripts\test-assistant-secretary.mjs` → exit 1，2 条 FAIL：
```
FAIL 工具闸：只禁动手类（写/编辑/补丁/终端/屏幕/子代理）+ 秘书侧 goal 类一律拒绝（2026-11-24 用户明确指令）
AssertionError [ERR_ASSERTION]: create_goal 必须由 Computer Use 会话自己立，秘书侧不许放行
  actual: false, expected: true
FAIL 纯读类真的穿过 tools/pre-execute；goal 类在闸口被拒并给出「派活而不是立目标」的话（2026-11-24）
AssertionError [ERR_ASSERTION]: create_goal 在固定秘书会话里必须被拒（用户 2026-11-24 明确禁止秘书自己立目标）
  actual: true, expected: false
```
`node scripts\test-secretary-notice-turn.mjs` → exit 1，1 条 FAIL：
```
FAIL 通知回合只禁动手类；用户真实回合恢复放行
AssertionError [ERR_ASSERTION]: create_goal 在通知回合必须被拒
```
（原始记录：`.tmp\red-goal-secretary.txt`、`.tmp\red-goal-notice.txt`）

改的测试断言：`scripts\test-assistant-secretary.mjs`（用例标题与断言组：goal 三件从「放行」翻成「拒绝」，`read` / `glob` / `grep` / `read_image` 仍断言放行；闸口那半段还要断言 deny reason 含「目标由 Computer Use 会话自己立」与 `secretary_dispatch`）；`scripts\test-secretary-notice-turn.mjs`（goal 三件在通知回合断言 `kind === deny`，文件头口径注释同步）。旧断言没有留下当正确断言。

## 4. GREEN 原始输出

```
[dsh-assistant build] done: lib/index.js, lib/pocket.js, lib/client.js, lib/computer-use*.js
BUILD EXIT=0
CHECK EXIT=0                     （npm run check：6 个 node --check 全过）
PASS 工具闸：只禁动手类（写/编辑/补丁/终端/屏幕/子代理）+ 秘书侧 goal 类一律拒绝（2026-11-24 用户明确指令）
PASS 纯读类真的穿过 tools/pre-execute；goal 类在闸口被拒并给出「派活而不是立目标」的话（2026-11-24）
PASS 只读工具闸显式放行派活：secretary_dispatch 可建/续独立 CU 会话
PASS 工具闸只对固定秘书会话生效
PASS 24/24 assistant-secretary        EXIT=0
PASS 通知回合只禁动手类；用户真实回合恢复放行
PASS 5/5 secretary-notice-turn       EXIT=0
PASS 46/46 secretary-cards           EXIT=0
PASS 32/32 assistant-dispatch        EXIT=0
```

`npm test` 原始数字（`.tmp\npmtest-goal2.txt`，344 行）：
```
mobile-uplink-history: 5/5 通过
mobile-session-pagination: 8/8 通过
ok test-assistant-home: 41 assertions
PASS 7/7                      （test-assistant-memory）
ok test-assistant-card: 12 assertions
PASS 24/24 assistant-secretary
PASS 12/12 secretary-dispatch
PASS 32/32 assistant-dispatch
PASS 16/16 assistant-cu-watch
PASS 5/5 secretary-notice-turn
PASS 8/8 secretary-session-log-write
（test-secretary-log-repair、test-secretary-card-render 逐条打印用例名，全 PASS）
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
FAIL 真会话 surface 折叠读回：宿主压缩 shadow 的旧轮不在模型投影里、卡片事件仍在日志里
FAIL 1/26 secretary-pagination-context
[exit code: 1]
```
即：整条链 76 个脚本里 **1 个 FAIL**（`secretary-pagination-context`，断言「卡片取数不受 compaction 影响」，现网 407 条无正文 assistant 轮 → 比率 0.835 < 0.9），链在那儿断开后其余 75 个单独跑：`FAILED-NOW: 0` / `ALL-OTHER-PASS`（`.tmp\run-rest-goal.txt`）。这条 FAIL 与前两批报告记录的同一条，属现网数据漂移，本批没去修。

## 5. 没验到 / 现网生效问题

插件的 `lib/index.js` 已经带上新闸口径（`node build.mjs` EXIT=0、`node --check` 全过、测试层断言全绿），但**宿主进程还是旧口径在跑**：上一批取证时实测真会话最新 prompt 快照（seq 9202 / 9216）里注入段仍是旧那句，同一句「立目标 create_goal/update_goal/get_goal、只读联网…都是放行的」也还在闸话里 —— 因为 `lib/index.js` 是宿主 require 进来的服务端插件，页面重新加载只换客户端 bundle，换不了这一段。要真的生效，需要宿主重新加载插件（重启宿主），本批红线是不重启 —— 所以「现网秘书真的被拒掉 create_goal」这一层没验到，只验到构建产物 + 测试断言这一层。**重启待用户确认。**

另外没做的：没有把 1790 段（派活分层段）里那句「立长期目标」的指引改成新口径 —— 按用户指令这段本轮不许动，只列在下面作待确认项。

## 6. 待用户确认的冲突（只核查、没改）

`src\assistant-dispatch.ts:414`（派活分层段 order 1790）现在仍写着让秘书立目标，与闸已拒矛盾，原文：

```
立长期目标（create_goal / update_goal / get_goal）也必须是「派活驱动」的目标：秘书会话里 create_goal 的 objective 必须写明动手部分由 secretary_dispatch 派 Computer Use 会话完成、你只做读回与汇报（例：「objective：由 Computer Use 会话改完 X 并跑测试；秘书只读回报告并整理成简短回复」）。需要看屏幕、操作应用、读写本机文件、生成文件的复杂任务，不许你在秘书会话里亲自一步步做完，必须先派 secretary_dispatch 再读回结果，先派再读。
```

冲突点：这一段教秘书「立派活驱动的 goal」，而本次改动后秘书调 `create_goal` 会直接被拒（拿到 deny reason）。实际后果是模型试一次就被拒、然后改走派活 —— 表达上仍是矛盾的指引，且 `scripts\test-assistant-dispatch.mjs:219` 那条 `assert.match(text, /objective/)` 就是钉这段的。建议下一批（要用户确认）：把 `:414` 改成「目标由 Computer Use 会话自己立，秘书不立目标」，并同步改那条断言。

## 7. 提交与 diff 摘要

```
cb12788 fix(secretary): 禁用个人秘书立目标——create_goal/update_goal/get_goal 在固定秘书会话与通知回合一律拒绝（用户明确指令）
 lib/index.js                           |  7 +++----
 scripts/test-assistant-secretary.mjs   | 22 ++++++++++++++++-----
 scripts/test-secretary-notice-turn.mjs |  8 +++++---
 src/assistant-secretary.ts             | 35 +++++++++++++++++-----------------
 src/client/secretary-dispatch.ts       |  2 +-
 5 files changed, 44 insertions(+), 30 deletions(-)
```
这份报告单独走第二条 `docs(secretary): …` 提交。`git add` 只逐条列上面这 5 个文件（加报告），没有 `git add -A`；`git status -sb` → `## main...origin/main [ahead 14]`（提交完报告后是 ahead 15）：**没有 push**、没有 fetch、没有重启宿主、没有跑 `pnpm run dev:web`、没有删任何文件、没有 rebase/amend 他人提交（`fd45ffe`、`1ab32c2`、`970ea46`、`18f928c`、`49ad5c8` 等都在原地）；未跟踪的 `.tmp\`、`outputs\`、`secretary-attachment-card-20261124.md` 之外的临时产物没动。

