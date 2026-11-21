/**
 * 主动服务卡片样式（只给标准会话页里的「本轮尾部」卡片用，2026-11-21 按效果图重做）。
 *
 * 设计基调：白/极浅灰卡片、1px 浅描边、圆角 16、极淡阴影；
 * 类型胶囊全部柔和浅色（淡绿/淡橙/淡蓝/淡紫/淡红），不用高饱和色；
 * 折叠态高度固定，内容超出截断，底行「查看详情」就地展开。
 */
export const PROACTIVE_CSS = `
[data-dsh-proactive="wrap"] {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 10px 0 4px;
}
[data-dsh-proactive="card"] {
  position: relative;
  box-sizing: border-box;
  height: 226px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2, #e8eaef);
  border-radius: 16px;
  background: #ffffff;
  padding: 14px 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 1px 3px rgba(30, 41, 59, .05);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
[data-dsh-proactive="card"]:active { background: #fafbfc; }
[data-dsh-proactive="card"][data-open="1"] {
  height: auto;
  max-height: none;
  overflow: visible;
}
[data-dsh-proactive="head"] {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: none;
}
[data-dsh-proactive="badge"] {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  line-height: 1;
  padding: 4px 9px;
  border-radius: 999px;
  font-weight: 500;
}
[data-dsh-proactive="badge-icon"] { font-size: 11px; line-height: 1; }
[data-dsh-proactive="badge"][data-tone="serve"] { color: #15803d; background: #f0fdf4; border: 1px solid #bbf0cd; }
[data-dsh-proactive="badge"][data-tone="care"]  { color: #b45309; background: #fffbeb; border: 1px solid #fbe3b5; }
[data-dsh-proactive="badge"][data-tone="done"]  { color: #1d4ed8; background: #eff6ff; border: 1px solid #c3dafd; }
[data-dsh-proactive="badge"][data-tone="explore"] { color: #6d28d9; background: #f5f3ff; border: 1px solid #ddd3fb; }
[data-dsh-proactive="badge"][data-tone="auth"]  { color: #b91c1c; background: #fef2f2; border: 1px solid #fbd2d2; }
[data-dsh-proactive="title"] {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2430);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-proactive="main"] {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}
[data-dsh-proactive="card"][data-open="1"] [data-dsh-proactive="main"] { overflow: visible; }
/* 正文摘要：宿主手机布局对滚动区内 p 有 (0,3,3) 且 !important 的 15px 规则，抬优先级压过 */
body[data-dsh-secretary="1"] [data-dsh-proactive="card"] [data-dsh-proactive="main"] [data-dsh-proactive="summary"] {
  margin: 0;
  font-size: 15px !important;
  line-height: 1.6 !important;
  color: #3d4451 !important;
  white-space: pre-wrap;
  word-break: break-word;
}
[data-dsh-proactive="items"] {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
/* 要点行：宿主手机布局对滚动区内 li 同样有 !important 15px 规则，抬优先级压过 */
body[data-dsh-secretary="1"] [data-dsh-proactive="card"] [data-dsh-proactive="items"] [data-dsh-proactive="item"] {
  font-size: 13.5px !important;
  line-height: 1.5 !important;
  color: #3d4451 !important;
  display: flex;
  gap: 6px;
  align-items: baseline;
  min-width: 0;
}
[data-dsh-proactive="item-icon"] {
  flex: none;
  font-size: 12px;
  line-height: 1.5;
  opacity: .8;
}
[data-dsh-proactive="item-prefix"] { font-weight: 600; color: #232838; flex: none; }
[data-dsh-proactive="item-text"] { min-width: 0; word-break: break-word; }
[data-dsh-proactive="details"] {
  font-size: 13px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #5b6472);
  white-space: pre-wrap;
  border-top: 1px dashed var(--dsw-alias-border-l2, #e8eaef);
  padding-top: 8px;
}
[data-dsh-proactive="ref"] {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--dsw-alias-border-l2, #e8eaef);
  border-left: 3px solid #9db4d8;
  background: #f7f9fc;
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #5b6472);
  cursor: pointer;
  max-width: 100%;
}
[data-dsh-proactive="ref"]:active { background: #eef2f8; }
[data-dsh-proactive="ref-icon"] { flex: none; }
[data-dsh-proactive="ref-title"] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-proactive="foot"] {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid #f1f3f6;
}
[data-dsh-proactive="time"] {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #9aa2af);
  font-variant-numeric: tabular-nums;
}
[data-dsh-proactive="toggle"] {
  border: 0;
  background: transparent;
  padding: 2px 0;
  font-size: 12px;
  color: #5b7fc0;
  cursor: pointer;
}
[data-dsh-proactive="toggle"]:active { color: #3d5f9e; }
@media (max-width: 640px) {
  [data-dsh-proactive="card"] { height: 212px; padding: 12px 14px 8px; }
  [data-dsh-proactive="title"] { font-size: 14.5px; }
}
`
