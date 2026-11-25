# 个人秘书页「已完成，用时 N 秒」完成行隐藏（2026-11-25）

## 结论先行

- **这行是谁渲染的：宿主**，不是插件。它是 `@deepseek-ai/dsh-client-ui-chat` 的 `TurnProcessNodeView`（宿主 asar 内 `src/client/chat/TurnProcessNodeView.tsx`）渲染的 kind="turn-process" 对话流行：文案来自宿主 i18n `message.turnProcess.took = '已完成，用时 '`（`dsh-client-ui-chat/src/client/locale.ts`），结构是 `div[data-chat-flow-kind="turn-process"][data-chat-turn="N"] > [data-slot="conversation.chat.node"] > button[data-turn-process="N"][class 后缀 _root] > span[class 后缀 _label]`，可折叠时带 chevron（⌄）。**它不是插件卡片的一部分，也不是回合尾槽位里的部件**，是用户/通知卡与秘书回复卡之间的一条独立兄弟行。
- **完成态判据（宿主自己的状态，不靠文本猜时间）**：`TurnProcessNodeView` 开头就是 `if (turn?.status !== 'closed') return null`——**这轮没关闭，这行根本不渲染**。所以「kind="turn-process" 的行存在」本身 = 完成态。真页只读探针实测：完成轮 554/555/556 都有这行（556 文案「已完成，用时 40秒」，`aria-expanded="false"`、带 chevron）。
- **进行态判据**：进行中的轮次**没有** turn-process 行（宿主返回 null，DOM 里最多剩一个空座）；进行态那条「…用时 N 秒 …」提示是**另一条** `[data-chat-running]`（宿主 `RunningStatus.tsx`，文案 `chat.deepDivingFor = '深度求索中，用时 {duration} ···'`），插件从来没有规则碰它。
- **这行为何此前可见**：插件 fd1c20d 的「最新轮过程可见」打标器 `tagLatestTurnProcessRows` 把最新轮的 turn-process 行也打了 `data-dsh-process-visible="1"`，被 CSS 放行规则 `display: revert` 放出（真页实测：turn=556 行带标记、visible h=37；历史轮 554/555 无标记、hidden-by-ancestor）。
- **修法**：打标器放行名单 `PROCESS_VISIBLE_KINDS` 移出 `turn-process`（完成行不再被打标 → 回到既有隐藏规则），再加一条 CSS 兜底把「带旧标记的 turn-process 行」也压回 `display:none`。完成行隐藏、进行态一个像素不变。

## 真页只读探针（http://127.0.0.1:3081 经 pocket 代理进同一 GUI，独立浏览器，不碰当前 DSH 窗口/进程、不发消息、不点改状态控件）

改动前（旧 bundle）：

```
turn=554 marked=  state=hidden-by-ancestor text=已完成已完成
turn=555 marked=  state=hidden-by-ancestor text=已完成已完成，用时 31秒
turn=556 marked=1 state=visible(h=37)      text=已完成 已完成，用时 40秒   ← 用户红框那行
```

改动后（新 bundle，页面重载即生效，宿主未重启）：

```
turn=555 marked=  state=hidden-by-ancestor text=已完成已完成
turn=556 marked=  state=hidden-by-ancestor text=已完成已完成，用时 40秒   ← 已隐藏
turn=557 marked=  state=hidden-by-ancestor text=已完成已完成，用时 31秒
最新轮 557 的 context/tool-call/assistant-step(reasoning) 行仍带 data-dsh-process-visible="1" 放行（进行态机制不变）
[data-chat-running] 探针时不在场（当前无执行中轮次）；插件无规则命中它（grep src 无 data-chat-running）
```

验收③（「展开全文」/复制/字数/时间戳不变）：完成行不在卡片容器内（探针 rel：它是 card/notice 与 card/assistant 之间的兄弟行），卡片脚部规则一行未动；新测试「完成态②」逐控件断言脚部 时间 9:28 / 引用 / 复制 / 展开全文 全部可见。

## 改动文件 + 行号（commit 5ad7a52，本地提交，未 push，宿主未重启）

| 文件 | 行号 | 改动 |
|---|---|---|
| src/client/pocket/orb/secretary-cards.ts | 2008（名单本体）、1983–1987（范围注释） | `PROCESS_VISIBLE_KINDS` 移出 `'turn-process'`，注释写明完成/进行态判据 |
| src/client/pocket/orb/secretary-cards.css.ts | 102–104（新兜底规则）、86–88（第 5 项注释补记） | 新增 `body[data-dsh-secretary="1"] [data-chat-flow-kind="turn-process"][data-dsh-process-visible="1"] { display: none !important; }`——类名/data-* 身份锚点 + 秘书页作用域双保险，不用 :first-child/:nth-child |
| scripts/test-secretary-turn-tail-complete-hide.mjs | 新文件 244 行 | 离线假 DOM（按真页 dump 形状）+ 真 bundle CSS + 真打标器，真 Chromium 断言 |
| scripts/test-secretary-cards.mjs | 694–706 | 既有断言随新口径更新（turn-process 不打标、放行名单不含它、清标数 2→1） |
| package.json | 57 | 新测试接入 npm test 链（test-secretary-cards.mjs 之后） |
| lib/client.js / lib/index.js | 重建产物 | `node build.mjs` 输出 |

红线自查：src/assistant-secretary.ts 未碰；折叠预算 3/2/10、首帧 162px、900/600/200 未碰；SECRETARY_READONLY_TOOLS/SECRETARY_GOAL_TOOLS/secretaryToolDenied 未碰；notice TTL/arrival-store 未碰；b588eb5…31e4a27 各提交均未回退；未 push、未重启宿主、未 dev:web；只 add 了自己改的 7 个文件，tmp-*.png/.tmp/outputs/*-20261125.md 等未跟踪文件原样保留。

## numstat（git diff HEAD~1 HEAD --numstat）

```
16	2	lib/client.js
1	1	lib/index.js
1	1	package.json
6	3	scripts/test-secretary-cards.mjs
244	0	scripts/test-secretary-turn-tail-complete-hide.mjs
15	1	src/client/pocket/orb/secretary-cards.css.ts
13	3	src/client/pocket/orb/secretary-cards.ts
合计 +296 −11（7 files changed）
```

## 测试原始数字

新测试先跑旧 bundle（证明 FAIL，4 红 3 绿）：

```
tagger 完成态轮次: {"marked":1,"turnNo":"20","anchorKind":"user"}；执行中轮次: {"marked":3,"turnNo":"21","anchorKind":"user"}
FAIL 放行名单：PROCESS_VISIBLE_KINDS 不再含 turn-process（完成行不再被打标放行）
FAIL CSS 兜底：bundle 里有「完成行即使带旧标记也压回」的专门规则…
FAIL 完成态①：「已完成，用时 40秒」完成行不渲染（不打标、display:none、整行不可见）
     AssertionError: 完成行不许打标：{"marked":true,"display":"block","visible":true,"text":"已完成，用时 40秒"}
PASS 完成态②：完成行是卡片外的独立兄弟行，卡片脚部「展开全文/复制/引用/时间 9:28」一个都不许连带
PASS 执行中①：最新用户轮的过程行（tool-call/context）照旧打标放行、真实可见
FAIL 执行中②：…（空座也不许打标 —— 旧打标器连空座都标）
PASS 作用域：没有 body[data-dsh-secretary="1"] 时完成行照常可见
SECRETARY TURN-TAIL COMPLETE-HIDE FAIL 4
```

新代码 PASS（新 bundle，最终态）：

```
tagger 完成态轮次: {"marked":0,"turnNo":"20","anchorKind":"user"}；执行中轮次: {"marked":2,"turnNo":"21","anchorKind":"user"}
PASS 放行名单 / PASS CSS 兜底 / PASS 完成态① / PASS 完成态② / PASS 执行中① / PASS 执行中② / PASS 作用域
PASS 7/7 secretary-turn-tail-complete-hide
```

指定套件原始输出：

```
PASS 58/58 secretary-cards
CARD VISUAL PASS（test-secretary-card-visual.mjs，含截图 8 张）
PASS 25/25 assistant-secretary
PASS 5/5 secretary-notice-turn
PASS 26/26 secretary-pagination-context
```

构建与检查：`node build.mjs` EXIT=0；`npm run check` EXIT=0。

全套逐脚本（82 个，含新测试）：**TOTAL=82 OK=80 FAILED=2**。两个红均为既有问题、与本改动无关，已用改动前构建硬证明（git stash 后同脚本同样 exit 1）：

```
scripts/test-secretary-session-log-write.mjs  exit 1（改动前 exit 1）
  原因：宿主真实解析器路径硬编码 D:\deepseek-harness\packages\… 与 D:\DSH Desktop\… 都不存在，模块加载即抛错，与秘书卡片无关
scripts/test-mobile-proxy.mjs  exit 1（改动前 exit 1）
  原因：gzip 浏览器 boot graph 断言（test-mobile-proxy.mjs:73），本改动未碰 pocket-host/mobile 任何文件
```

## 备注

- scripts/smoke-secretary-page.mjs（手动冒烟，不在 npm test 链）里有「已完成，用时那行有意可见」的旧口径注释与判据；本次未改它，下次跑冒烟前如需可把「完成行必须隐藏」补进它的 PROCESS_NOISE 判据。
- 进行态现场（真有一个轮次在跑时的 [data-chat-running]）本次探针时秘书会话空闲、未在场；该判据来自宿主源码（ChatFlow.tsx 仅在 running/holding 时挂 RunningStatus），插件无任何规则命中 `[data-chat-running]`（grep 全 src 为零），进行态提示不受本改动影响。
- 「处理失败/已停止」与「已完成」同属 kind="turn-process"（宿主同一组件的不同分支），本次一并回到隐藏——与 secretary-cards.css.ts 第 30 行既有口径（过程信息行一律不出图）一致。
