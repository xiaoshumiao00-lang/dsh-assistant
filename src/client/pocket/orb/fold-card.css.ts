/**
 * 卡片「固定高度 + 点击展开/折叠」共享实现（与秘书三种卡同一套语义，别写两份）。
 *
 * 约定（各类卡片都遵守）：
 *   卡片根节点挂  data-dsh-fold="card"  data-open="0|1"   data-overflow="1" 表示真被切掉
 *   内容主区挂    data-dsh-fold="main"   （flex:1、超出截断）
 *   底部信息行挂  data-dsh-fold="foot"   （flex:none，恒贴在卡片底部）
 *
 * 折叠态：正文最多 3 行（预算与落点由 SecretaryReplyCard.tsx 的 measureFoldClip 算出来挂成 max-height）；
 * 被切掉的行末尾打「…」省略标记（2026-11-21 改动：**不再用底部渐变遮罩**），展开态 height:auto 放全文。
 */
export const FOLD_CARD_CSS = `
[data-dsh-fold="card"] {
  box-sizing: border-box;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
[data-dsh-fold="card"][data-open="1"] {
  height: auto;
  max-height: none;
  overflow: visible;
}
[data-dsh-fold="main"] {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
[data-dsh-fold="card"][data-open="1"] [data-dsh-fold="main"] {
  overflow: visible;
}
/* 折叠态末尾的省略标记：贴在最后一行的行尾右侧，背景跟卡面同色把残字盖掉（不是渐变遮罩） */
[data-dsh-fold="card"]:not([data-open="1"])[data-overflow="1"] [data-dsh-fold="main"]::after {
  content: "…";
  position: absolute;
  right: 0;
  bottom: 0;
  padding: 0 4px 0 6px;
  font-size: 15px;
  line-height: 27px;
  color: var(--dsh-card-text-muted, #8a9099);
  background: var(--fold-bg, var(--dsh-card-surface, #ffffff));
  pointer-events: none;
}
[data-dsh-fold="foot"] {
  flex: none;
}
`
