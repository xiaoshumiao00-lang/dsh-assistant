结论：新代码已加载（宿主进程启动 2026-11-25 17:35:27，晚于 lib\index.js 构建 2026-11-25 17:02:11；端口 56673 与 3081 都由 pid 42724 持有，该进程即 17:35:27 启动的 DeepSeek Harness）。因此 10250 硬块段在 17:51 那轮的 prompt 里本来就在，模型仍接错卡 = 模型侧未遵守，不是「需要重启」。

# 引用修复生效核查（只读取证，2026-11-25）

## 1) 宿主相关进程
Get-Process | Where-Object {$_.ProcessName -match 'deepseek|dsh|electron|node'} | Select ProcessName,Id,StartTime | Sort StartTime

ProcessName         Id     StartTime
node                24860  2026/11/21 9:47:09
node                26368  2026/11/21 9:47:20
node                6000   2026/11/21 9:49:41
node                54652  2026/11/25 16:45:36   ← workbuddy-sheetagent mcp/start.mjs，无关
node                55128  2026/11/25 16:45:36   ← 命令行空
DeepSeek Harness    39500  2026/11/25 17:35:27
DeepSeek Harness    53628  2026/11/25 17:35:27
DeepSeek Harness    36636  2026/11/25 17:35:27
DeepSeek Harness    49812  2026/11/25 17:35:27
DeepSeek Harness    42724  2026/11/25 17:35:27   ← 持 56673(GUI) 与 3081(pocket)
electron            43184  2026/11/25 17:35:29
electron            23012  2026/11/25 17:35:29
electron            36992  2026/11/25 17:35:29
electron            57332  2026/11/25 17:35:29
DeepSeek Harness    51464  2026/11/25 17:35:34   ← audio utility
DeepSeek Harness    42296  2026/11/25 17:53:46

命令原文补充：Get-NetTCPConnection -LocalPort 56673 -State Listen → OwningProcess=42724；3081 同 42724。

## 2) 文件时间 / git
Get-Item:
- D:\dsh-assistant\lib\index.js               2026/11/25 17:02:11  522735
- D:\dsh-assistant\lib\client.js              2026/11/25 17:02:11  1671823
- D:\dsh-assistant\src\assistant-secretary.ts 2026/11/25 17:02:03  70876

git -C D:\dsh-assistant log -1 --format="%H %ci %s"
144f192fb8e869ac122e897d20cb6b544ce1eaed 2026-11-25 17:04:25 +0800 fix(secretary): 引用改成结构化硬注入——本轮 prompt 最末产出「必须回答的卡」(全文+附件+禁令)，并堵登记侧三条静默丢路（2026-11-25 第 2 次报障：602 软约束失败 + 603 无登记）

git -C D:\dsh-assistant status --short（前 5 行）
?? .tmp/
?? outputs/
?? tmp-secretary-card-collapsed.png
?? tmp-secretary-card-desktop.png
?? tmp-secretary-card-expanded.png

## 3) 常量是否在 lib\index.js（grep 行号）
L5292: var SECRETARY_QUOTE_ANCHOR_SECTION_ORDER = 1791;
L5293: var SECRETARY_QUOTE_CARD_SECTION_ORDER = 10250;
L5907: order: SECRETARY_QUOTE_ANCHOR_SECTION_ORDER,
L5932: order: SECRETARY_QUOTE_CARD_SECTION_ORDER,
L6190: SECRETARY_QUOTE_ANCHOR_SECTION_ORDER,
L6191: SECRETARY_QUOTE_CARD_SECTION_ORDER,

## 4) 引用状态文件
C::\Users\<ACCOUNT>\.dsh\profiles\desktop\dsh-assistant-secretary-quote.json
LastWriteTime 2026/11/25 17:51:22, Length 85

{
  "version": 1,
  "updatedAt": "2026-11-25T09:51:22.619Z",
  "quoteBySession": {}
}
（09:51:22Z UTC = 17:51:22 北京；quoteBySession 当前为空，updatedAt 即最近一次写入/消费时间，仅凭单次快照无法区分「登记写入」与「turn/end 消费写入」。）

## 5) 判据与结论
判据：宿主启动时间 vs lib\index.js 修改时间。
- lib\index.js 修改：2026-11-25 17:02:11
- 宿主进程（pid 42724，持 GUI 端口 56673 与 3081）：2026-11-25 17:35:27
- 17:35:27 > 17:02:11 ⇒ 新代码已加载。

推论：17:51 那轮（含 17:51:22 的引用状态写入）跑的就是含 10250「必须回答的卡」硬块的新代码，模型仍指到别的卡（毕设题目那条）⇒ 问题不在「需要重启」，在模型对该硬块的服从性；下一步若要继续修，方向应是让硬块更强约束（例如把卡正文与本轮用户消息直接拼在同一条 wire 消息里、或按 quote 重置最近任务上下文），这属于新的改动，本轮按指令未做任何修改。