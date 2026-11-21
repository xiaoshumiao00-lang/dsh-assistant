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
 *   - 底部操作栏右对齐：**时间（HH:MM）紧贴复制按钮左侧** → 复制 → 分隔线 → 展开全文；
 *   - ≤520px：卡片 100%，脚部时间仍然显示，朗读按钮仍在右上角。
 *
 * 只对个人秘书固定会话生效：原始 markdown 气泡、过程信息行、消息操作行与空壳都被隐藏。
 */
export const SECRETARY_CARD_CSS = `
/* 原始 markdown 气泡：秘书回复统一走卡片 */
body[data-dsh-secretary="1"] [data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"]) {
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

/* ── 用户卡 / 通知卡接管宿主用户行 ──
 * 真实用户消息与合成通知被做成卡片后，那条气泡本身不再显示（时间/操作行也已在卡片底行里）。
 * 带附件的行保留宿主气泡（附件芯片不能丢），只把纯文本 run 收起来。
 * 分页窗口外的那一行（折叠行）也接管气泡：老卡压成一行时同样不许冒原文。 */
body[data-dsh-secretary="1"] [data-chat-flow-kind="user"]:has(> [data-dsh-scard="card"][data-dsh-scard-kind="user"], > [data-dsh-scard="card"][data-dsh-scard-kind="notice"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="notice"]) > [data-slot="conversation.chat.node"]:not(:has(img)) {
  display: none !important;
}
body[data-dsh-secretary="1"] [data-chat-flow-kind="user"]:has(> [data-dsh-scard="card"][data-dsh-scard-kind="user"], > [data-dsh-scard="card"][data-dsh-scard-kind="notice"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="user"], > [data-dsh-scard="collapsed-row"][data-dsh-scard-kind="notice"]) [data-slot="conversation.user.text.node"] > span:not([data-dsh-scard]) {
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
[data-dsh-scard="card"][data-open="1"] [data-dsh-scard="content"] {
  max-height: none !important;
  overflow: visible;
}
/* 折叠态被切掉的行：末尾打「…」省略标记（不是渐变遮罩，背景跟卡面同色盖住残字） */
[data-dsh-scard="ellipsis"] {
  position: absolute;
  right: 0;
  bottom: 0;
  padding: 0 4px 0 6px;
  font-size: 15px;
  line-height: 27px;
  color: var(--dsh-card-text-muted);
  background: var(--dsh-card-surface);
  pointer-events: none;
}
body[data-dsh-secretary="1"] [data-dsh-scard="card"] [data-dsh-scard="body"] [data-dsh-scard="title"] {
  margin: 0;
  font-size: 17px !important;
  font-weight: 500 !important;
  line-height: 1.5 !important;
  color: var(--dsh-card-text) !important;
}
body[data-dsh-secretary="1"] [data-dsh-scard="card"] [data-dsh-scard="body"] [data-dsh-scard="para"] {
  margin: 0;
  font-size: 15px !important;
  font-weight: 400 !important;
  line-height: 1.8 !important;
  color: var(--dsh-card-text-soft) !important;
  white-space: pre-wrap;
  word-break: break-word;
}
body[data-dsh-secretary="1"] [data-dsh-scard="card"] [data-dsh-scard="body"] [data-dsh-scard="para"] strong {
  font-weight: 500 !important;
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
  [data-dsh-scard="expand-arrow"] {
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
`
