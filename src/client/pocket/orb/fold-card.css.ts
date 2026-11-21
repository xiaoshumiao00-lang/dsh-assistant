/**
 * 秘书卡片「固定高度 + 点击展开/折叠」共享实现（回复卡与主动服务卡共用，别写两份）。
 *
 * 约定（两类卡片都遵守）：
 *   卡片根节点挂  data-dsh-fold="card"  data-open="0|1"   --fold-bg 变量 = 卡片底色（渐隐遮罩用）
 *   内容主区挂    data-dsh-fold="main"   （flex:1、超出截断、底部渐隐遮罩盖住半行字）
 *   底部信息行挂  data-dsh-fold="foot"   （flex:none，恒贴在卡片底部）
 *
 * 折叠态高度恒定：桌面 226px / 手机（≤640px）212px；展开态 height:auto 放全文。
 * 点整张卡片切换展开/折叠由各卡片的 React 组件各自挂 onClick（状态语义一致）。
 */
export const FOLD_CARD_CSS = `
[data-dsh-fold="card"] {
  box-sizing: border-box;
  height: 226px;
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
/* 折叠态底部渐隐遮罩：盖掉被截断的半行字（颜色取卡片底色变量） */
[data-dsh-fold="card"]:not([data-open="1"]) [data-dsh-fold="main"]::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 30px;
  background: linear-gradient(to bottom, transparent, var(--fold-bg, #ffffff));
  pointer-events: none;
}
[data-dsh-fold="foot"] {
  flex: none;
}
@media (max-width: 640px) {
  [data-dsh-fold="card"] { height: 212px; }
}
`
