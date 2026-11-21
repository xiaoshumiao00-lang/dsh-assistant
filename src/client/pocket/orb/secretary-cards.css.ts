/**
 * 秘书回复卡片 + 朗读操作区样式（只对个人秘书固定会话生效）。
 *
 * 底色用柔和的浅灰蓝（#f7f8fb），圆角/描边沿用 pocket 卡片令牌；
 * 秘书会话里原始 markdown 气泡由 body[data-dsh-secretary="1"] 隐藏，
 * 回复统一走卡片；其它会话这些选择器一律不命中，外观零变化。
 */
export const SECRETARY_CARD_CSS = `
body[data-dsh-secretary="1"] [data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"]) {
  display: none !important;
}
[data-dsh-scard="card"] {
  background: #f7f8fb;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 14px;
  padding: 12px 14px;
  margin: 6px 0 2px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[data-dsh-scard="head"] {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
[data-dsh-scard="badge"] {
  flex: none;
  font-size: 11px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 999px;
  color: #6d5ef0;
  background: #efedfd;
  border: 1px solid #d8d2f7;
}
[data-dsh-scard="title"] {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
}
[data-dsh-scard="body"] {
  font-size: 14px;
  line-height: 1.65;
  color: var(--dsw-alias-label-primary, inherit);
  white-space: pre-wrap;
  word-break: break-word;
}
[data-dsh-speak="wrap"] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
[data-dsh-speak="button"] {
  width: 30px;
  height: 30px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  background: #f4f6fd;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
[data-dsh-speak="button"]:active { background: #e9edf8; }
[data-dsh-speak="button"][data-status="playing"] {
  color: #6d5ef0;
  border-color: #d8d2f7;
  background: #efedfd;
}
[data-dsh-speak="button"][data-status="error"] {
  color: #dc2626;
  border-color: #fecaca;
  background: #fef2f2;
}
[data-dsh-speak="ref"] {
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  background: #ffffff;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-speak="ref"]:active { background: #f4f6fd; }
@media (max-width: 640px) {
  [data-dsh-scard="card"] { padding: 10px 12px; }
  [data-dsh-scard="body"] { font-size: 13.5px; }
}
`
