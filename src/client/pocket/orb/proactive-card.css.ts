/**
 * 主动服务卡片样式（只给标准会话页里的「本轮尾部」卡片用）。
 *
 * 配色/圆角/间距全部沿用 pocket 与宿主会话页已有的 CSS 变量（--dsw-alias-*），
 * 不新增任何颜色；卡片本身只是把消息内容排成一张卡，不是另一套页面外壳。
 */
export const PROACTIVE_CSS = `
[data-dsh-proactive="wrap"] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 10px 0 4px;
}
[data-dsh-proactive="card"] {
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 14px;
  background: var(--dsw-alias-bg-base, #ffffff);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .04);
}
[data-dsh-proactive="card"]:active { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .03)); }
[data-dsh-proactive="head"] {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
[data-dsh-proactive="badge"] {
  flex: none;
  font-size: 11px;
  line-height: 1;
  padding: 4px 7px;
  border-radius: 999px;
  color: var(--dsw-alias-state-success-primary, #16a34a);
  border: 1px solid currentColor;
  background: var(--dsw-alias-fill-l1, rgba(0, 0, 0, .03));
}
[data-dsh-proactive="title"] {
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-proactive="summary"] {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #6b7280);
  white-space: pre-wrap;
}
[data-dsh-proactive="items"] {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
[data-dsh-proactive="item"] {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary, inherit);
  display: flex;
  gap: 6px;
}
[data-dsh-proactive="item"]::before {
  content: "·";
  flex: none;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
}
[data-dsh-proactive="details"] {
  font-size: 13px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #6b7280);
  white-space: pre-wrap;
  border-top: 1px dashed var(--dsw-alias-border-l2, #e5e7eb);
  padding-top: 8px;
}
[data-dsh-proactive="foot"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
[data-dsh-proactive="foot-actions"] {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
[data-dsh-proactive="ref"] {
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  background: #ffffff;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-proactive="ref"]:active { background: #f4f6fd; }
[data-dsh-proactive="time"] {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-variant-numeric: tabular-nums;
}
[data-dsh-proactive="toggle"] {
  border: 0;
  background: transparent;
  padding: 2px 0;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer;
}
@media (max-width: 640px) {
  [data-dsh-proactive="title"] { font-size: 13.5px; }
}
`
