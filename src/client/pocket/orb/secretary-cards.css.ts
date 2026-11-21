/**
 * 秘书回复卡片 + 朗读气泡样式（只对个人秘书固定会话生效，2026-11-21 按手机实测反馈重做）。
 *
 * 层次：标题行（图标 +「个人秘书」标签 + 一句话摘要 + 最右朗读钮）→ 正文分段 →
 * 引用块（左细竖线 + 淡底 + 可点跳会话）→ 底部 meta（12px 灰、时间）。
 * 卡片：内边距 16、圆角 16、柔和浅蓝灰底、1px 极浅描边、轻微投影。
 *
 * 秘书会话里原始 markdown 气泡、过程信息行（turn-process / model-retry /
 * turn-error / turn-max-tokens / compaction）与空占位壳都由
 * body[data-dsh-secretary="1"] 在渲染层隐藏（display:none，不生成盒、不进 innerText）；
 * 其它会话这些选择器一律不命中，外观零变化。
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
/* 空占位条：卡片/操作区的空壳不生成盒子 */
body[data-dsh-secretary="1"] [data-dsh-scard="card"][data-empty="1"],
body[data-dsh-secretary="1"] [data-dsh-speak="wrap"][data-empty="1"] {
  display: none !important;
}

/* ── 秘书回复卡片 ── */
[data-dsh-scard="card"] {
  background: #f7f9fc;
  border: 1px solid #e9edf3;
  border-radius: 16px;
  padding: 16px;
  margin: 8px 0 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 1px 3px rgba(30, 41, 59, .05);
}
[data-dsh-scard="head"] {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
[data-dsh-scard="icon"] {
  flex: none;
  font-size: 13px;
  line-height: 1;
  color: #7c8db0;
}
[data-dsh-scard="badge"] {
  flex: none;
  font-size: 11px;
  line-height: 1;
  padding: 4px 9px;
  border-radius: 999px;
  font-weight: 500;
  color: #5b7fc0;
  background: #eef3fb;
  border: 1px solid #d4e0f3;
}
[data-dsh-scard="title"] {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #232838);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-scard="body"] {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
/* 正文段落：宿主手机布局对滚动区内 p/li 有 (0,3,3) 且 !important 的 15px 规则，
 * 这里挂 body 标记 + 卡片/正文两层属性把优先级抬到 (0,4,1) 压过它 */
body[data-dsh-secretary="1"] [data-dsh-scard="card"] [data-dsh-scard="body"] [data-dsh-scard="para"] {
  margin: 0;
  font-size: 14px !important;
  line-height: 1.6 !important;
  color: #3d4451 !important;
  white-space: pre-wrap;
  word-break: break-word;
}
[data-dsh-scard="ref"] {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #e9edf3;
  border-left: 3px solid #9db4d8;
  background: #ffffff;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #5b6472);
  cursor: pointer;
  max-width: 100%;
}
[data-dsh-scard="ref"]:active { background: #f2f5fa; }
[data-dsh-scard="ref-icon"] { flex: none; }
[data-dsh-scard="ref-title"] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-scard="meta"] {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding-top: 2px;
  border-top: 1px solid #eef1f5;
}
[data-dsh-scard="time"] {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #9aa2af);
  font-variant-numeric: tabular-nums;
}

/* ── 朗读气泡（回复卡与主动服务卡共用：小圆形、淡描边、最右） ── */
[data-dsh-speak="button"] {
  flex: none;
  width: 30px;
  height: 30px;
  margin-left: auto;
  border-radius: 999px;
  border: 1px solid #dfe5ee;
  background: #ffffff;
  color: #7c8db0;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
[data-dsh-speak="button"]:active { background: #eef2f8; }
[data-dsh-speak="button"][data-status="playing"] {
  color: #5b7fc0;
  border-color: #c3d5ef;
  background: #eef3fb;
}
[data-dsh-speak="button"][data-status="error"] {
  color: #dc2626;
  border-color: #fecaca;
  background: #fef2f2;
}
@media (max-width: 640px) {
  [data-dsh-scard="card"] { padding: 14px; }
}
`
