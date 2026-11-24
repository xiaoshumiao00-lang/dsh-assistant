/**
 * 个人秘书卡片样式（卡片规范 v1.1，2026-11-21 第二批）——三种卡共用同一套外壳规格，主题色分开：
 *   - 秘书回复卡（data-dsh-scard-kind="assistant"）：白底 + 紫色强调（#534AB7 / #3C3489 / #EEEDFE）；
 *   - 用户卡（data-dsh-scard-kind="user"）：浅蓝底 #EEF4FF + 冷蓝强调 #184A80（标识与芯片同色系）；
 *   - 通知卡（data-dsh-scard-kind="notice"）：中性灰底 #F6F7F9 + 强调 #5C6470 / #3F444D，chip 底 #E9EBF0。
 * 主题全部走 `--dsh-card-*` 变量，视觉测试靠比对这三组变量确认三种卡不会同色。
 *
 *   - 卡片：宽 ≤620px、16px 圆角、0.5px 浅灰边 #E5E6EB、无阴影、overflow hidden；
 *   - 未读红点：秘书侧发的卡（assistant/notice）顶部一颗 8px #D83A2B 圆点，已读后整颗消失；
 *   - 头部：32px 标识 + 名称/身份标签，右端只有 34px 朗读按钮（朗读按钮与图标尺寸不动）；
 *   - 正文：17px 标题、**15px/1.8 正文**（13→15、15→17、chip 12→13、脚部时间 11→12）、
 *     行内标签与引用 chip 13px；折叠态最多 **3 行正文**，末尾「…」省略标记（不用渐变遮罩）；
 *   - 卡体可点击展开/收起（role=button + aria-expanded，Enter/Space 同样切换）；
 *   - 底部操作栏右对齐：**引用 → 时间（HH:MM）紧贴复制按钮左侧** → 复制 → 分隔线 → 展开全文；
 *   - ≤520px：卡片 100%，脚部时间仍然显示，朗读按钮仍在右上角。
 *
 * 只对个人秘书固定会话生效：原始 markdown 气泡、过程信息行（含 reasoning 分组行，2026-11-24 起一律不出图）、
 * 消息操作行与空壳都被隐藏；对话流里只剩卡片（秘书回复卡 / 用户卡 / 通知卡 / 折叠行）。
 */
export const SECRETARY_CARD_CSS = `
/* 原始 markdown 气泡 + 过程行：秘书回复统一走卡片，assistant-step 一律不出图。
 * 2026-11-24 用户实报（安卓 10:09 截图）：旧规则用 :not([data-chat-group-part="reasoning"])
 * 把 reasoning 分组行放了过来，那正是带放大镜的「已搜索代码并调用工具」「已搜索代码，已读取文件，已调用工具等」。
 * 用户口径是「个人秘书页面只显示卡片消息，过程消息一条都不能有」→ 去掉 :not 排除；
 * 再按 group-part 属性兜一条，宿主以后把 reasoning 拆成别的 kind 时同样压掉。 */
body[data-dsh-secretary="1"] [data-chat-flow-kind="assistant-step"],
body[data-dsh-secretary="1"] [data-chat-group-part="reasoning"] {
  display: none !important;
}
/* 过程信息行：已完成/用时/处理失败/已重试模型请求/本轮运行失败 —— 渲染层真正不输出 */
body[data-dsh-secretary="1"] [data-chat-flow-kind="turn-process"],
body[data-dsh-secretary="1"] [data-chat-flow-kind="model-retry"],
body[data-dsh-secretary="1"] [data-chat-flow-kind="turn-error"],
body[data-dsh-secretary="1"] [data-chat-flow-kind="turn-max-tokens"],
body[data-dsh-secretary="1"] [data-chat-flow-kind="compaction"] {
  display: none !important;
}
/* compact 提示两行（2026-11-23 用户点名要压掉的第 3 项）：
 *  宿主编排器把「一次压缩事务」汇成一个 kind="manual-compaction" 的对话节点（宿主
 *  src/client/conversation-nodes/command.ts + src/client/chat/CompactionCommandCard.tsx），
 *  那一行的正文来自 i18n：message.compaction.commandTitle="compact" 加
 *  message.compaction.completed="已压缩 {items} 条历史记录（约 {tokens} tokens）"；
 *  失败分支走 GenericCommandCard 的 outcome 文本（"Compaction could not produce a useful summary. …"）。
 *  上面那条已有的规则只压 kind="compaction"（独立摘要行），**漏了 kind="manual-compaction"**——
 *  这一条把它补上；再兜两条：带宿主自己的压缩标记属性（data-compaction-icon）的宿主行、以及扫描层按文字判据
 *  标上 data-dsh-scard-compact="hint" 的行，一并不出图。判据只在秘书页生效，别的会话一个字都不动。 */
body[data-dsh-secretary="1"] [data-chat-flow-kind="manual-compaction"],
body[data-dsh-secretary="1"] [data-dsh-scard-compact="hint"],
body[data-dsh-secretary="1"] [data-chat-flow-kind]:has(> [data-slot="conversation.chat.node"] [data-compaction-icon]) {
  display: none !important;
}
/* 2026-11-24 现场 DOM dump（真页 http://127.0.0.1:3081，用户截图里那几行遗留过程消息）——补上漏掉的三类：
 *  1) 工具调用那一类行：宿主语义标记给的是「工具调用」kind，现场行高 28px、还带分组成员标记属性；
 *  2) 过程分组行：分组容器带分组 key 属性、自身没有对话流的语义 kind 属性（现场行高 20px，
 *     文字就是「已读取文件」「已搜索代码，已读取文件，已调用工具」）——旧规则全按语义 kind 匹配，
 *     这一类从来没有被压过，这就是截图里过程消息冒出来的直接原因；
 *  3) 上下文行：宿主语义标记给的是「上下文」kind（跨会话召回、注入的上下文那一类），同样算过程行。
 * 判据一律带「这一档里挂着我们的卡就不动它」的兜底，卡片不会被顺手压没。 */
body[data-dsh-secretary="1"] [data-chat-flow-kind="tool-call"],
body[data-dsh-secretary="1"] [data-chat-flow-kind="context"],
body[data-dsh-secretary="1"] [data-chat-group-key]:not(:has([data-dsh-scard])),
body[data-dsh-secretary="1"] [data-turn-process-member]:not(:has([data-dsh-scard])) {
  display: none !important;
}
/* 回合尾那一档：秘书回复卡与回合尾原生小部件挂在同一个槽容器里（现场 dump 里两者都是它的直接子代），
 * 所以整档不能一刀压掉——只压「没有卡片标记」的直接子代：记忆回合尾部件（截图那行「本回合记忆召回 1」，
 * 来自 dsh-mnemon 插件）、技能回合尾部件、宿主自己的回合尾部件一律不出图，卡片与折叠行照旧出图。 */
body[data-dsh-secretary="1"] [data-slot="conversation.chat.turnTail"] > :not([data-dsh-scard]) {
  display: none !important;
}
/* 消息下方原生操作行（复制/赞/踩/分享/记忆/时间，宿主 MessageIconActions 根节点带 data-clock）：
 * 渲染层隐藏、不留行高；时间已在卡片底行里，不重复显示 */
body[data-dsh-secretary="1"] [data-clock] {
  display: none !important;
}
/* 空占位条：卡片/操作区的空壳不生成盒子 */
body[data-dsh-secretary="1"] [data-dsh-scard="card"][data-empty="1"],
body[data-dsh-secretary="1"] [data-dsh-speak="wrap"][data-empty="1"] {
  display: none !important;
}
/* 2026-11-24 第 5 项（用户原话「秘书执行任务的过程可以展示，只展示最新用户一条任务的执行过程」）：
 * 上面那些「过程行一律 display:none」的规则照旧管历史轮次；扫描层（secretary-cards.ts 的
 * tagLatestTurnProcessRows）只给**最后一条 user/steering 行那一轮**的过程行打 data-dsh-process-visible="1"，
 * 这里把打了标的放出来。判据与卡种无关、与轮次号无关，标记跟着最新一条用户消息移动，
 * 新消息一来上一轮立刻回到上面那些隐藏规则里。用 revert 回到宿主/UA 自己的 display（分组容器与
 * 成员行原本就不是同一种 display），不硬写 block。只在秘书页生效。 */
body[data-dsh-secretary="1"] [data-dsh-process-visible="1"],
body[data-dsh-secretary="1"] [data-dsh-process-visible="1"]:not([data-dsh-scard]) {
  display: revert !important;
}

/* ── 用户卡 / 通知卡接管宿主用户行 ──
 * 真实用户消息与合成通知被做成卡片后，那条气泡本身不再显示（时间/操作行也已在卡片底行里）。
 * 完整卡（2026-11-24 附件批次改了口径）接管整条宿主行：图片/文件嵌进卡片内部，原生附件芯片不再出图；
 * 分页窗口外的那一行（折叠行）也接管气泡：老卡压成一行时同样不许冒原文。 */
body[data-dsh-secretary="1"] [data-chat-flow-kind="user"]:has(> [data-dsh-scard="card"][data-dsh-scard-kind="user"], > [data-dsh-scard="card"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"] { display: none !important; } body[data-dsh-secretary="1"] [data-chat-flow-kind="user"]:has(> [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"]:not(:has(img)) {
  display: none !important;
}
body[data-dsh-secretary="1"] [data-chat-flow-kind="user"]:has(> [data-dsh-scard="card"][data-dsh-scard-kind="user"], > [data-dsh-scard="card"][data-dsh-scard-kind="notice"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="notice"]) [data-slot="conversation.user.text.node"] > span:not([data-dsh-scard]) {
  display: none !important;
}
/* 兜底（2026-11-24）：卡片确实在行里、只是被 React 包进更深一层容器时，上面那条「直接子代」判据会漏，
 * 宿主气泡就冒回来（安卓那次截图里用户消息仍是原生气泡，桌面上同一条消息是卡片）。这条按后代再压一次，
 * 完整卡整条压掉（附件已嵌进卡片内部），折叠行那种仍带 :not(:has(img)) 例外——老消息的附件芯片照旧留着。 */
body[data-dsh-secretary="1"] [data-chat-flow-kind="user"]:has([data-dsh-scard="card"][data-dsh-scard-kind="user"], [data-dsh-scard="card"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"] { display: none !important; } body[data-dsh-secretary="1"] [data-chat-flow-kind="user"]:has([data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"]:not(:has(img)) {
  display: none !important;
}
/* 2026-11-24 现场 DOM dump（用户实报「秘书跑任务途中插话没有以卡片形式展示」）：宿主把跑任务途中的插话
 * 挂成语义 kind 为「steering」那一类行，宿主在渲染注册表里给这一类与真用户行注册的是**同一个**用户消息视图
 * （同一套 userRow / bubble / 附件行），插件此前只收真用户行 → 插话那条从来没有卡片接管它，
 * 原生气泡就自己冒出来了（现场行高 398px、hasCard=false）。判据与用户行同一套：直接子代 + 后代兜底两条都写，
 * 完整卡整条压掉（附件嵌进卡片内部），折叠行那条保留 :not(:has(img)) 例外。 */
body[data-dsh-secretary="1"] [data-chat-flow-kind="steering"]:has(> [data-dsh-scard="card"][data-dsh-scard-kind="user"], > [data-dsh-scard="card"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"] {
  display: none !important;
}
body[data-dsh-secretary="1"] [data-chat-flow-kind="steering"]:has(> [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"]:not(:has(img)) {
  display: none !important;
}
body[data-dsh-secretary="1"] [data-chat-flow-kind="steering"]:has(> [data-dsh-scard="card"][data-dsh-scard-kind="user"], > [data-dsh-scard="card"][data-dsh-scard-kind="notice"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="notice"]) [data-slot="conversation.user.text.node"] > span:not([data-dsh-scard]) {
  display: none !important;
}
body[data-dsh-secretary="1"] [data-chat-flow-kind="steering"]:has([data-dsh-scard="card"][data-dsh-scard-kind="user"], [data-dsh-scard="card"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"] { display: none !important; } body[data-dsh-secretary="1"] [data-chat-flow-kind="steering"]:has([data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"]:not(:has(img)) {
  display: none !important;
}

/* ── 卡片外壳 + 主题变量（秘书回复卡 = 紫；用户卡 = 冷蓝） ── */
[data-dsh-scard="card"] {
  --dsh-card-surface: #ffffff;
  --dsh-card-accent: #534ab7;
  --dsh-card-accent-deep: #3c3489;
  --dsh-card-accent-wash: #eeedfe;
  --dsh-card-accent-wash-deep: #e8e6fd;
  --dsh-card-accent-line: #cecbf6;
  --dsh-card-foot-surface: #fafafb;
  --dsh-card-border: #e5e6eb;
  --dsh-card-separator: #d5d8dd;
  --dsh-card-text: #1f2329;
  --dsh-card-text-soft: #4e5969;
  --dsh-card-text-muted: #8a9099;
  --dsh-card-focus-ring: #afa9ec;
  box-sizing: border-box;
  position: relative;
  width: 100%;
  max-width: 620px;
  margin: 12px auto;
  overflow: hidden;
  background: var(--dsh-card-surface);
  border: 0.5px solid var(--dsh-card-border);
  border-radius: 16px;
  box-shadow: none;
}
[data-dsh-scard="card"][data-dsh-scard-kind="user"] {
  --dsh-card-surface: #eef4ff;
  --dsh-card-accent: #184a80;
  --dsh-card-accent-deep: #12395f;
  --dsh-card-accent-wash: #ffffff;
  --dsh-card-accent-wash-deep: #dfe9f7;
  --dsh-card-accent-line: #c9dcf7;
  --dsh-card-foot-surface: #e3edf9;
  --dsh-card-focus-ring: #7fb0ee;
}
/* 通知卡（合成通知做成卡，2026-11-21 第三批需求）：中性灰系，跟紫卡/蓝卡一眼分开 */
[data-dsh-scard="card"][data-dsh-scard-kind="notice"] {
  --dsh-card-surface: #f6f7f9;
  --dsh-card-accent: #5c6470;
  --dsh-card-accent-deep: #3f444d;
  --dsh-card-accent-wash: #e9ebf0;
  --dsh-card-accent-wash-deep: #dfe2e6;
  --dsh-card-accent-line: #cfd3d9;
  --dsh-card-foot-surface: #eef0f3;
  --dsh-card-focus-ring: #9aa1ab;
}
/* 未读红点（秘书侧发的卡才有：kind=assistant 与 kind=notice）：8px 圆点 #D83A2B，
 * 贴在卡头顶边、标识组左侧；已读后组件直接不渲染这个节点（不留灰点、不淡出）。 */
[data-dsh-scard="unread-dot"] {
  position: absolute;
  top: 15px;
  left: 9px;
  z-index: 1;
  width: 8px;
  height: 8px;
  margin: 0;
  background: #d83a2b;
  border: 0;
  border-radius: 999px;
  box-shadow: none;
  pointer-events: none;
}

/* ── 头部 ── */
[data-dsh-scard="head"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 0;
}
[data-dsh-scard="identity"] {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
[data-dsh-scard="mark"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
  color: var(--dsh-card-accent);
  background: var(--dsh-card-accent-wash);
  border-radius: 10px;
}
[data-dsh-scard="mark"] svg {
  display: block;
  width: 24px;
  height: 24px;
}
[data-dsh-scard="name"] {
  flex: 0 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--dsh-card-text);
}
[data-dsh-scard="tag"] {
  flex: none;
  margin-left: 2px;
  padding: 0 7px;
  font-size: 11px;
  line-height: 18px;
  color: var(--dsh-card-accent-deep);
  background: var(--dsh-card-accent-wash);
  border-radius: 6px;
}

/* ── 头部右端的朗读按钮（卡片内唯一朗读入口） ── */
[data-dsh-speak="button"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 34px;
  height: 34px;
  padding: 0;
  color: var(--dsh-card-text-soft);
  background: var(--dsh-card-surface);
  border: 0.5px solid var(--dsh-card-border);
  border-radius: 8px;
  cursor: pointer;
  transition: color 160ms ease, background-color 160ms ease, border-color 160ms ease;
}
[data-dsh-speak="button"]:hover,
[data-dsh-speak="button"]:focus-visible,
[data-dsh-speak="button"][data-status="playing"],
[data-dsh-speak="button"][data-status="paused"],
[data-dsh-speak="button"][aria-pressed="true"] {
  color: var(--dsh-card-accent);
  background: var(--dsh-card-accent-wash);
  border-color: var(--dsh-card-accent-line);
}
[data-dsh-speak="button"][data-status="loading"] {
  color: var(--dsh-card-accent-deep);
  background: var(--dsh-card-accent-wash);
  border-color: var(--dsh-card-accent-line);
}
[data-dsh-speak="button"][data-status="error"] {
  color: #b42318;
  background: #fff1f0;
  border-color: #f1c3c1;
}
[data-dsh-speak="icon"] {
  display: block;
  width: 17px;
  height: 17px;
}

/* ── 正文（字号整体加大两号：标题 17px、正文 15px/1.8、行内标签 13px、引用 chip 13px） ── */
[data-dsh-scard="body"] {
  padding: 16px 20px 20px;
  -webkit-tap-highlight-color: transparent;
}
/* 卡体可点击展开/收起：只在真有溢出时给指针光标，键盘可达（Enter/Space 同样切换） */
[data-dsh-scard="card"][data-overflow="1"] [data-dsh-scard="body"] {
  cursor: pointer;
}
[data-dsh-scard="body"]:focus-visible {
  outline: 2px solid var(--dsh-card-focus-ring);
  outline-offset: 2px;
  border-radius: 10px;
}
[data-dsh-scard="content"] {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
  transition: max-height 160ms ease;
}
/* 正文块一律不许被 flex 压缩：折叠态的裁剪要靠 overflow:hidden 切在行尾，
   不是把块挤成 0 高（实测 flex-shrink 默认 1 会让 -webkit-box 的标题块塌成 0 高）。 */
[data-dsh-scard="content"] > [data-dsh-scard="title"],
[data-dsh-scard="content"] > [data-dsh-scard="para"],
[data-dsh-scard="content"] > [data-dsh-scard="attachment"],
[data-dsh-scard="content"] > [data-dsh-scard="ref"] {
  flex: 0 0 auto;
}
/* 折叠态固定高度（2026-11-22 修「长卡整段平铺」）：
   1) 卡标题先被行夹裁到 2 行 —— 现网实测旧口径把整段首段（230–255px）全部露出，折叠 max-height 涨到 321–346px；
   2) 正文区有一条**首帧就生效**的上限（结论 2 行 54px + 间距 10px + 详情 3 行 78px + 两个块间距 20px = 162px，
      与 foldCollapsedCapPx 同一个数），JS 量完落点后写进行内样式覆盖它；没溢出就写 maxHeight:none 显式放开。
      这条兜底专门治「测量发生在布局稳定前」的现网时序：卡片刚挂载那一帧不再整段平铺。
      2026-11-23 字号改档（结论 18px/1.5、详情 14px/26px）后总量仍是 162px，只是构成从 51+81 变成 54+78。 */
[data-dsh-scard="card"]:not([data-open="1"]) [data-dsh-scard="title"] {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  max-height: calc(1.5em * 2); /* 结论 18px / 1.5 → 两行 54px；按行高算，不看字符数 */
  overflow: hidden;
}
[data-dsh-scard="card"]:not([data-open="1"]) [data-dsh-scard="content"] {
  max-height: var(--dsh-card-fold-cap, 162px);
}
[data-dsh-scard="card"][data-open="1"] [data-dsh-scard="title"] {
  display: block;
  -webkit-line-clamp: none;
  line-clamp: none;
  max-height: none;
  overflow: visible;
}
[data-dsh-scard="card"][data-open="1"] [data-dsh-scard="content"] {
  max-height: none !important;
  overflow: visible;
}
/* 折叠态被切掉的行：末尾打「…」省略标记（不是渐变遮罩，背景跟卡面同色盖住残字）
 * 行箱跟正文同一档字号（14px / 26px），量出来才对得上 foldClipFromBlocks 的落点。 */
[data-dsh-scard="ellipsis"] {
  position: absolute;
  right: 0;
  bottom: 0;
  padding: 0 4px 0 6px;
  font-size: 14px;
  line-height: 26px;
  color: var(--dsh-card-text-muted);
  background: var(--dsh-card-surface);
  pointer-events: none;
}
/* 结论—细节的字级分工（2026-11-23 第 2 项需求，纯视觉层）：
 *   结论 = 卡标题那一行 → 稍大一号、加粗、主文字色（18px / 600 / 行高 27px）；
 *   细节 = 正文段落 → 稍小一号、次要文字色（14px / 400 / 行高 26px）；
 * 「展开全文」点开以后正文全在，一个字都不少（这条改动只动字号，不许删信息）。 */
body[data-dsh-secretary="1"] [data-dsh-scard="card"] [data-dsh-scard="body"] [data-dsh-scard="title"] {
  margin: 0;
  font-size: 18px !important;
  font-weight: 600 !important;
  line-height: 1.5 !important;
  color: var(--dsh-card-text) !important;
}
body[data-dsh-secretary="1"] [data-dsh-scard="card"] [data-dsh-scard="body"] [data-dsh-scard="para"] {
  margin: 0;
  font-size: 14px !important;
  font-weight: 400 !important;
  line-height: 26px !important;
  color: var(--dsh-card-text-soft) !important;
  white-space: pre-wrap;
  word-break: break-word;
}
body[data-dsh-secretary="1"] [data-dsh-scard="card"] [data-dsh-scard="body"] [data-dsh-scard="para"] strong {
  font-weight: 600 !important;
  color: var(--dsh-card-text) !important;
}
body[data-dsh-secretary="1"] [data-dsh-scard="card"] [data-dsh-scard="body"] [data-dsh-scard="model-code"] {
  display: inline-block;
  padding: 2px 5px;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace !important;
  font-size: 13px !important;
  line-height: 20px !important;
  color: var(--dsh-card-accent-deep) !important;
  background: var(--dsh-card-accent-wash);
  border-radius: 5px;
}
[data-dsh-scard="ref"] {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 7px 10px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsh-card-accent-deep);
  background: var(--dsh-card-accent-wash);
  border: 0.5px solid var(--dsh-card-accent-line);
  border-radius: 8px;
  cursor: pointer;
}
[data-dsh-scard="ref"]:hover { background: var(--dsh-card-accent-wash-deep); }
/* 附件嵌在卡片内部（2026-11-24 附件批次）：图片出缩略图 + 文件名，文件出文件名 + 大小/类型那行。
 * 卡片自己的圆角、间距与配色变量（跟正文同一档 14px/20px），不新增观感口径，也不动折叠预算。 */
body[data-dsh-secretary="1"] [data-dsh-scard="attachment"] {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 0.5px solid var(--dsh-card-accent-line);
  border-radius: 10px;
  background: var(--dsh-card-accent-wash);
  color: var(--dsh-card-text-soft);
  font-size: 14px;
  line-height: 20px;
  max-width: 100%;
}
body[data-dsh-secretary="1"] [data-dsh-scard="attachment-thumb"] {
  flex: 0 0 auto;
  width: auto;
  max-width: 220px;
  max-height: 140px;
  border-radius: 8px;
  object-fit: contain;
  background: var(--dsh-card-surface);
}
body[data-dsh-secretary="1"] [data-dsh-scard="attachment-name"] {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsh-card-accent-deep);
}
body[data-dsh-secretary="1"] [data-dsh-scard="attachment-meta"],
body[data-dsh-secretary="1"] [data-dsh-scard="attachment-status"] {
  flex: 0 0 auto;
  color: var(--dsh-card-text-muted);
  font-size: 12px;
}
body[data-dsh-secretary="1"] [data-dsh-scard="attachment-icon"] {
  flex: 0 0 auto;
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--dsh-card-accent);
}
@media (max-width: 420px) {
  body[data-dsh-secretary="1"] [data-dsh-scard="attachment-thumb"] { max-width: 148px; max-height: 108px; }
}
[data-dsh-scard="ref-icon"] { flex: none; }
[data-dsh-scard="ref-title"] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 底部操作栏：时间挪到最右、紧贴复制按钮左侧（DOM 顺序：时间 + 复制 → 分隔线 → 展开全文） ── */
[data-dsh-scard="foot"] {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding: 10px 14px 10px 20px;
  background: var(--dsh-card-foot-surface);
  border-top: 0.5px solid var(--dsh-card-border);
}
[data-dsh-scard="time"] {
  flex: none;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsh-card-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
[data-dsh-scard="actions"] {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-wrap: nowrap;
  min-width: 0;
}
[data-dsh-scard="copy"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--dsh-card-text-muted);
  background: transparent;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
[data-dsh-scard="copy"]:hover {
  color: var(--dsh-card-text);
  background: var(--dsh-card-surface);
}
[data-dsh-scard="copy-status"] {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsh-card-text-muted);
  white-space: nowrap;
}
/* 引用按钮（第 4 项需求）：脚部**时间左边**那颗，规格与时间右边那棵复制按钮一模一样
 * （30×30、同一灰 var(--dsh-card-text-muted)、同一 hover、同一 8px 圆角、同一 16px 图标），
 * 只是图标换成引号形。点下去 = 把这张卡登记成「下一条消息要回复的对象」；
 * 登记态换成打勾图标（accent 色）+ 旁边一句状态文字，反馈口径与复制那棵一致。 */
[data-dsh-scard="quote"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--dsh-card-text-muted);
  background: transparent;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
[data-dsh-scard="quote"]:hover {
  color: var(--dsh-card-text);
  background: var(--dsh-card-surface);
}
[data-dsh-scard="quote"][data-quoted="1"] {
  color: var(--dsh-card-accent);
}
[data-dsh-scard="quote-status"] {
  flex: 0 0 auto;
  min-width: 0;
  max-width: 132px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsh-card-text-muted);
}
/* ── 输入框旁边那颗「带引用」提示（2026-11-23 追加需求）────────────────
 * 落点：src/client/pocket/orb/SecretaryQuoteChip.tsx（宿主 conversation.input.right 槽位）。
 * 数值一律照卡片脚部那两棵按钮抄（muted #8A9099、8px 圆角、同 hover、16px 图标、同 160ms 过渡），
 * 只把 accent 换成那张卡自己的主题色（紫 / 冷蓝 / 灰），好让人一眼对上接的是哪张卡。
 * 没引用时组件根本不渲染（这些规则也就用不上）——不许留占位条。 */
[data-dsh-squote="chip"] {
  --dsh-squote-muted: #8a9099;
  --dsh-squote-soft: #4e5969;
  --dsh-squote-text: #1f2329;
  --dsh-squote-hover-surface: #fafafb;
  --dsh-squote-accent: #534ab7;
  --dsh-squote-wash: #eeedfe;
  --dsh-squote-line: #cecbf6;
  --dsh-squote-focus-ring: #afa9ec;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  flex: 0 1 auto;
  min-width: 0;
  /* 宽度上限必须按「工具行自己的宽度」算，不能按视口算：宿主 InputBar 的 .row 是 flex-wrap:wrap，
     而 .trailing 是 flex:none（整组不 shrink），flex-wrap 又是按每一项的假想宽度（content 宽度截到 max-width）决定换不行的——
     桌面那次错位（715 宽窗口里「托管 + 提示 + 模型 + 发送」被顶到输入框工具行之下的独立一行）正是这么来的。
     宿主 .row 带 container-type:inline-size，所以这里用 cqw 直接问那一行；同一行里另外那几件（+ / 仅可查看 / 托管 / 模型 / 发送 + gap）实测合计约 334px，
     这里扣 340 留 6px 余量，下限 140px 是提示自己 min-content 的量，上限 420px 是宽桌面那种行里也不许占得太多的量。 */
  max-width: clamp(140px, calc(100cqw - 340px), 420px);
  height: 30px;
  padding: 0 0 0 10px;
  background: var(--dsh-squote-wash);
  border: 0.5px solid var(--dsh-squote-line);
  border-radius: 8px;
  color: var(--dsh-squote-text);
  font-size: 13px;
  line-height: 18px;
  /* 内容一律不许溢出盒子：窄起来先让 meta 走省略号，那颗 × 永远留在 composer 那一行里 */
  overflow: hidden;
}
/* 三种卡的主题色在这里换：紫卡 → 提示也紫，蓝卡 → 蓝，灰通知卡 → 灰 */
[data-dsh-squote="chip"][data-dsh-squote-kind="user"] {
  --dsh-squote-accent: #184a80;
  --dsh-squote-wash: #eef4ff;
  --dsh-squote-line: #c9dcf7;
  --dsh-squote-focus-ring: #7fb0ee;
}
[data-dsh-squote="chip"][data-dsh-squote-kind="notice"] {
  --dsh-squote-accent: #5c6470;
  --dsh-squote-wash: #f6f7f9;
  --dsh-squote-line: #cfd3d9;
  --dsh-squote-focus-ring: #9aa1ab;
}
[data-dsh-squote="flag"] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  min-width: 0;
  color: var(--dsh-squote-accent);
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
}
[data-dsh-squote="flag"] svg {
  display: block;
  flex: none;
  width: 16px;
  height: 16px;
}
[data-dsh-squote="meta"] {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsh-squote-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dsh-squote="preview"] {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--dsh-squote-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 宿主那一行（.row 有 container-type:inline-size）窄到 720px 以下时，「· 卡片种类」这一截先收掉：
   腾出来的宽度留给摘要——问的是那一行自己，不是浏览器视口，所以带侧栏的窄桌面窗也照得下。 */
@container (max-width: 720px) {
  [data-dsh-squote="meta-kind"] {
    display: none;
  }
}
/* 取消入口那颗 ×：与卡脚那棵复制/引用按钮完全同一规格（30×30、同 muted、同 8px 圆角、同 hover） */
[data-dsh-squote="cancel"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--dsh-squote-muted);
  background: transparent;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
  transition: color 160ms ease, background-color 160ms ease;
}
[data-dsh-squote="cancel"]:hover,
[data-dsh-squote="cancel"]:focus-visible {
  color: var(--dsh-squote-text);
  background: var(--dsh-squote-hover-surface);
}
[data-dsh-squote="cancel"]:focus-visible {
  outline: 2px solid var(--dsh-squote-focus-ring);
  outline-offset: 2px;
}
[data-dsh-squote="cancel"] svg {
  display: block;
  width: 16px;
  height: 16px;
}
/* 过期自动收掉时不留盒子（与卡片 data-dsh-scard-expired 那条同一个效果）：
 * 组件其实已经 return null，这条只兜「宿主 slot 出错边界吃掉组件」时的残留节点。 */
[data-dsh-squote="chip"][data-empty="1"] {
  display: none !important;
}
/* 过期自动消失的通知卡：外壳仍然要挂在那里（它撑着「宿主气泡不许冒回来」的那条 :has 判据），
 * 但盒子不输出——与上面那条 data-empty="1" 的空壳规则同一个效果。 */
[data-dsh-scard="card"][data-dsh-scard-expired="1"] {
  display: none !important;
}
[data-dsh-scard="separator"] {
  flex: none;
  width: 0.5px;
  height: 14px;
  margin: 0 5px;
  background: var(--dsh-card-separator);
}
[data-dsh-scard="expand"] {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  height: 30px;
  padding: 0 7px;
  font-size: 12px;
  color: var(--dsh-card-accent);
  background: transparent;
  border: 0;
  cursor: pointer;
}
[data-dsh-scard="expand"]:hover {
  color: var(--dsh-card-accent-deep);
}
[data-dsh-scard="expand-text"] { white-space: nowrap; }
[data-dsh-scard="expand-arrow"] {
  flex: none;
  transition: transform 160ms ease;
}
[data-dsh-scard="card"][data-open="1"] [data-dsh-scard="expand-arrow"] {
  transform: rotate(180deg);
}

/* 所有卡片内按钮的焦点环：键盘 Tab 可达，不移除浏览器默认 outline。 */
[data-dsh-scard="card"] button:focus-visible,
[data-dsh-speak="button"]:focus-visible {
  outline: 2px solid var(--dsh-card-focus-ring);
  outline-offset: 2px;
}

/* ── 折叠行（第四批需求 A：分页窗口之外的老卡压成一行）──
 * 一行只有时间 + 该条首行前 24 字短标题；点它只开本地原文预览，不会把整张老卡拉回渲染。 */
[data-dsh-scard="collapsed-row"] {
  display: block;
  width: 100%;
  max-width: 620px;
  margin: 0 auto;
  border: 0;
  border-bottom: 0.5px solid #e5e6eb;
  background: transparent;
}
[data-dsh-scard="collapse-row"] {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 34px;
  margin: 0;
  padding: 6px 12px;
  border: 0;
  background: transparent;
  color: #4b5561;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
[data-dsh-scard="collapse-row"]:hover {
  background: #f6f7f9;
}
[data-dsh-scard="collapse-time"] {
  flex: 0 0 auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #9aa1ab;
}
[data-dsh-scard="collapse-title"] {
  flex: 1 1 auto;
  font-size: 13px;
  line-height: 1.5;
  color: #4b5561;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-scard="collapse-caret"] {
  flex: 0 0 auto;
  font-size: 12px;
  color: #b4bac3;
}
[data-dsh-scard="collapse-preview"] {
  display: block;
  width: 100%;
  max-width: 620px;
  margin: 0 auto;
  padding: 8px 12px 12px;
  border-radius: 10px;
  background: #f6f7f9;
  color: #5c6470;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
[data-dsh-scard="earlier-hint"] {
  display: flex;
  justify-content: center;
  width: 100%;
  max-width: 620px;
  margin: 0 auto;
  padding: 8px 12px;
}
[data-dsh-scard="earlier-hint-text"] {
  font-size: 12px;
  color: #9aa1ab;
}

@media (prefers-reduced-motion: reduce) {
  [data-dsh-scard="content"],
  [data-dsh-speak="button"],
  [data-dsh-scard="expand-arrow"],
  [data-dsh-squote="cancel"] {
    transition: none !important;
  }
}

@media (max-width: 520px) {
  [data-dsh-scard="card"] {
    width: 100%;
    max-width: 620px;
    border-radius: 16px;
  }
  [data-dsh-scard="head"] {
    padding: 16px 16px 0;
  }
  [data-dsh-scard="body"] {
    padding: 14px 16px 18px;
  }
  [data-dsh-scard="foot"] {
    padding: 10px 12px 10px 16px;
  }
  /* 2026-11-21 改动：脚部时间在手机上也要显示（三种卡都有 HH:MM），只是紧贴复制按钮左侧 */
  [data-dsh-scard="time"] {
    display: inline-block;
  }
  [data-dsh-scard="unread-dot"] {
    left: 7px;
  }
  [data-dsh-speak="button"] {
    width: 34px;
    height: 34px;
  }
  [data-dsh-scard="actions"] {
    flex-wrap: nowrap;
  }
  /* 窄屏：引用提示别把模型胶囊与发送钮挤没，也别把那一行顶成第二行（同样按那一行自己的宽度算） */
  [data-dsh-squote="chip"] {
    max-width: clamp(140px, calc(100cqw - 300px), 240px);
  }
}

@media (max-width: 360px) {
  [data-dsh-scard="identity"] {
    flex-wrap: wrap;
  }
  [data-dsh-scard="tag"] {
    margin-left: 0;
  }
  [data-dsh-scard="expand-text"] {
    white-space: normal;
  }
}

/* 手机端输入框那一行（2026-11-23 追加需求）：
 * 手机 WebView 也有 1080 宽那种（CSS 宽度 ≠ 520），所以手机这一档一律靠 (pointer: coarse) 判，
 * 与 pocket 布局 isPhoneComposerLayout() 用的是同一个判据。
 * 现场实测过一版：composer 卡片只有 380px 宽、那一行只留 278px，那颗提示只分到 164px，
 * 一行式布局会把「第 245 轮」和摘要拦腰截断（截图里就是那样）——手机上这一档改成自己换两行：
 * 第一行「带引用 + 第 N 轮」+ 那颗 × 顶到右边，第二行整行放那张卡正文开头一小段。
 * 高度 auto（至少 34px）、那颗 × 也 34×34 够点、摘要 14px、meta 13px，宽度上限按那一行自己算（clamp/100cqw）。 */
@media (pointer: coarse) {
  [data-dsh-squote="chip"] {
    height: auto;
    min-height: 34px;
    align-items: center;
    flex-wrap: wrap;
    row-gap: 4px;
    gap: 4px;
    padding: 4px 6px 4px 10px;
    font-size: 14px;
    line-height: 20px;
    /* 现场实测那一行只给得起 162px（那一行里另外那几件 + 权限胶囊 + 托管 + 模型 + 发送 + gap 实测合计 116px）：
       扣 190 让上限落回 174px 这一量级（现场那 162px 由 flex 自己收到），下限 160px 比「带引用 + 第 N 轮 + ×」
       那一行的实测量（42+51+34+gap 8+padding 16 = 151px）还留 9px 余量——低于这个就会自己换第三行、盒子长到 88px（现场跑测逮到过）；
       上限 340px 留给 1080 宽那种手机 WebView。 */
    max-width: clamp(160px, calc(100cqw - 190px), 340px);
  }
  [data-dsh-squote="flag"] {
    font-size: 14px;
    font-weight: 600;
  }
  /* 手机端这一档先把那颗引号小图标收掉：现场那一行只给得起 164px，先让「带引用 + 第 N 轮 + ×」这一行完整落得下 */
  [data-dsh-squote="flag"] svg {
    display: none;
  }
  /* 卡片种类那一截也收掉（卡本身看得出来是什么卡），只留「第 N 轮」 */
  [data-dsh-squote="meta-kind"] {
    display: none;
  }
  [data-dsh-squote="meta"] {
    font-size: 13px;
    /* 轮次号这一段在手机上不许被截：它拿自己的自然宽度（flex: 0 0 auto），宁可摘要那一行让位 */
    flex: 0 0 auto;
    overflow: visible;
    text-overflow: clip;
  }
  [data-dsh-squote="preview"] {
    font-size: 14px;
    flex: 1 1 100%;
    order: 3;
  }
  [data-dsh-squote="cancel"] {
    width: 34px;
    height: 34px;
    order: 2;
    margin-left: auto;
  }
}
`
