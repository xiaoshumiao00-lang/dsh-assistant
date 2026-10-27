// 悬浮球样式（独立字符串，由 orb-apply 注入 <style>）。
// 设计令牌与 mobile.css.ts 一致（--dsw-alias-* 带 fallback）；z-index 收口在本文件。

export const ORB_CSS = `
/* 统一 border-box：页面内不少元素是 width:100% + 左右 padding，
 * 默认 content-box 会多出 24-28px 把页面撑出横向滚动条——正好和左滑手势冲突。
 * 只作用于悬浮球页面内部，不影响宿主其它 UI。 */
[data-pocket-orb="page"],
[data-pocket-orb="page"] *,
[data-pocket-orb="page"] *::before,
[data-pocket-orb="page"] *::after {
  box-sizing: border-box;
}
[data-pocket-orb="page"] {
  position: fixed;
  inset: 0;
  z-index: 3200;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  overflow: hidden;
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}

[data-pocket-orb="header"] {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  flex: none;
}
[data-pocket-orb="title"] {
  font-size: 15px;
  font-weight: 600;
  flex: 1;
}
[data-pocket-orb="header-btn"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 10px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}
[data-pocket-orb="header-btn"]:active {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
}

[data-pocket-orb="body"] {
  flex: 1;
  overflow-y: auto;
  /* 关键：禁止横向滚动——左滑手势在行内处理，页面本身不能有左右滚动条 */
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  padding: 12px;
  box-sizing: border-box;
}

/* 目标条：新会话 = 项目目录选择；已有会话 = 会话信息 + 查看执行 */
[data-pocket-orb="target"] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 10px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  font-size: 13px;
}
[data-pocket-orb="target-path"] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
[data-pocket-orb="target-btn"] {
  flex: none;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
[data-pocket-orb="target-btn"][data-primary="1"] {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f6ef7));
  color: var(--dsw-alias-label-primary-foreground, #fff);
}

/* 会话历史 */
[data-pocket-orb="history-title"] {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  margin: 14px 2px 6px;
}

/* 左滑行容器：操作按钮垫在底下，行内容在上层左右滑动。
 * overflow:hidden 是必须的——否则 translateX 会把页面撑出横向滚动条，
 * 与左滑手势直接冲突（用户滑动时页面跟着左右晃）。 */
[data-pocket-orb="swipe-row"] {
  position: relative;
  width: 100%;
  margin-bottom: 6px;
  border-radius: 12px;
  overflow: hidden;
  box-sizing: border-box;
  /* 让浏览器把横向手势交给我们处理，纵向滚动仍然交给页面 */
  touch-action: pan-y;
}
[data-pocket-orb="swipe-actions"] {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 168px;
  display: flex;
  align-items: stretch;
  z-index: 0;
}
[data-pocket-orb="swipe-btn"] {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 0 4px;
  border: none;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.2;
  color: #fff;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
[data-pocket-orb="swipe-btn"]:disabled {
  opacity: .55;
  cursor: default;
}
[data-pocket-orb="swipe-btn"][data-action="pin"] {
  background: var(--dsw-alias-brand-primary, #4f6ef7);
}
[data-pocket-orb="swipe-btn"][data-action="rename"] {
  background: var(--dsw-alias-label-tertiary, #8b93a1);
}
[data-pocket-orb="swipe-btn"][data-action="archive"] {
  background: var(--dsw-alias-state-warn-primary, #b45309);
}
[data-pocket-orb="history-row"] {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  will-change: transform;
}
[data-pocket-orb="history-row"][data-current="1"] {
  border-color: var(--dsw-alias-brand-primary, #4f6ef7);
}
/* 重命名内联表单：替换行内容，宽度与行一致 */
[data-pocket-orb="rename-form"] {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
[data-pocket-orb="rename-input"] {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-brand-primary, #4f6ef7);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 14px;
  outline: none;
  box-sizing: border-box;
}
[data-pocket-orb="rename-ok"],
[data-pocket-orb="rename-cancel"] {
  flex: none;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
[data-pocket-orb="rename-ok"] {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f6ef7));
  color: #fff;
}
[data-pocket-orb="rename-cancel"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  color: var(--dsw-alias-label-secondary, #6b7280);
}
[data-pocket-orb="history-main"] {
  flex: 1;
  min-width: 0;
}
[data-pocket-orb="history-name"] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-pocket-orb="history-sub"] {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-pocket-orb="dot"] {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-border-l1, rgba(0, 0, 0, .18));
}
[data-pocket-orb="dot"][data-running="1"] {
  background: var(--dsw-alias-state-success-primary, #16a34a);
  animation: pocket-orb-pulse 1.2s ease-in-out infinite;
}
@keyframes pocket-orb-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .45; transform: scale(.8); }
}
/* 会话列表分页：一次只挂 40 行，其余按需追加 */
[data-pocket-orb="history-more"] {
  display: block;
  width: 100%;
  margin: 2px 0 10px;
  padding: 10px 12px;
  border: 1px dashed var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
[data-pocket-orb="history-empty"] {
  padding: 24px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary, #8b93a1);}

/* 输入区（吸底） */
[data-pocket-orb="composer"] {
  flex: none;
  border-top: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  background: var(--dsw-alias-bg-layer-1, #fff);
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px));
}
[data-pocket-orb="chips"] {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
[data-pocket-orb="chip"] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 999px;
  background: var(--dsw-alias-bg-base, #fafafa);
  font-size: 12px;
}
[data-pocket-orb="chip-name"] {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-pocket-orb="chip-x"] {
  border: none;
  background: none;
  padding: 0 2px;
  font-size: 13px;
  line-height: 1;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  cursor: pointer;
}
[data-pocket-orb="chip-img"] {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  object-fit: cover;
  flex: none;
}

[data-pocket-orb="input-row"] {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
[data-pocket-orb="textarea"] {
  flex: 1;
  min-height: 44px;
  max-height: 40vh;
  padding: 11px 12px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 14px;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 16px;
  line-height: 1.5;
  resize: none;
  outline: none;
}
[data-pocket-orb="textarea"]:focus {
  border-color: var(--dsw-alias-brand-primary, #4f6ef7);
}
[data-pocket-orb="icon-btn"] {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 18px;
  cursor: pointer;
}
[data-pocket-orb="send-btn"] {
  flex: none;
  height: 44px;
  padding: 0 18px;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f6ef7));
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}
[data-pocket-orb="send-btn"]:disabled {
  opacity: .5;
  cursor: default;
}

/* 语音录音态：与输入框同高同圆角，避免录音时整行跳动 */
[data-pocket-orb="input-shell"] {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
}
/* 录音按钮在输入框内部右侧，紧挨发送键；输入框给它留出右内边距，文字不会压到图标。
 * 尺寸与 DSH 原生输入框那个触发按钮一致（28px 宽的可点区域、32px 圆形悬停底）。 */
[data-pocket-orb="inline-mic"] {
  position: absolute;
  right: 4px;
  bottom: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .55));
  font-family: inherit;
  cursor: pointer;
  /* 长按不能触发滚动/选中/系统菜单，否则松手事件会被系统抢走 */
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
[data-pocket-orb="inline-mic"][data-recording] {
  color: #e5484d;
  /* 录音中给个淡红底，方块在哪里一眼能看到 */
  background: rgba(229, 72, 77, .12);
}
[data-pocket-orb="inline-mic"]:disabled {
  opacity: .5;
}
[data-pocket-orb="rec-hint"] {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .55));
  white-space: nowrap;
}
[data-pocket-orb="rec-row"][data-cancel] {
  border-color: #e5484d;
}
[data-pocket-orb="rec-row"][data-cancel] [data-pocket-orb="rec-hint"] {
  color: #e5484d;
}
[data-pocket-orb="inline-mic"]:active {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
}
[data-pocket-orb="input-shell"] [data-pocket-orb="textarea"] {
  width: 100%;
  padding-right: 50px;
}
[data-pocket-orb="rec-row"] {
  flex: 1;
  min-width: 0;
  height: 44px;
  /* 右边留给录音按钮（录音时它固定在输入框右下角） */
  padding: 0 50px 0 12px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-brand-primary, #4f6ef7);
  border-radius: 14px;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-pocket-orb="rec-dot"] {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #e5484d;
  animation: pocket-orb-rec-pulse 1s ease-in-out infinite;
}
[data-pocket-orb="rec-time"] {
  flex: none;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .55));
}
[data-pocket-orb="rec-bars"] {
  flex: 1;
  min-width: 0;
  height: 28px;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 2px;
}
[data-pocket-orb="rec-bar"] {
  display: block;
  flex: none;
  width: 3px;
  min-height: 3px;
  border-radius: 2px;
  background: var(--dsw-alias-brand-primary, #4f6ef7);
  transition: height .1s linear;
}
@keyframes pocket-orb-rec-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .25; }
}

/* 附件菜单 / / 命令弹层 */
[data-pocket-orb="menu"] {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% + 8px);
  /* 必须高于会话行：左滑行有 position:relative + z-index:1，菜单若留 auto
   * 会被历史列表盖住（模型胶囊点开后看不到菜单）。 */
  z-index: 30;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .14);
  overflow: hidden;
  max-height: 46vh;
  overflow-y: auto;
}
/* 菜单头：技能/命令计数（可对照电脑端数量） */
[data-pocket-orb="menu-head"] {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 6px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .06));
  background: var(--dsw-alias-bg-layer-1, #fff);
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
}
[data-pocket-orb="menu-item"] {
  display: block;
  width: 100%;
  padding: 12px 14px;
  border: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .06));
  background: none;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
[data-pocket-orb="menu-item"]:last-child {
  border-bottom: none;
}
[data-pocket-orb="menu-item"]:active {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
}
[data-pocket-orb="menu-item-desc"] {
  display: block;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  margin-top: 2px;
}
[data-pocket-orb="menu-anchor"] {
  position: relative;
  /* 整个输入区（含向上展开的附件/模型菜单）提到会话列表之上。
   * 左滑行有 z-index:1，如果这里留 auto，菜单会和列表争层级。 */
  z-index: 20;
}

/* 电脑路径浏览器（底部抽屉）
 * 这套抽屉也被工作台「选择位置」复用（渲染在 [data-pocket-orb="page"] 之外），
 * 所以 border-box 与文字色必须自己兜住，不能指望 page 上的全局规则。 */
[data-pocket-orb="sheet"],
[data-pocket-orb="sheet"] *,
[data-pocket-orb="sheet"] *::before,
[data-pocket-orb="sheet"] *::after {
  box-sizing: border-box;
}
[data-pocket-orb="sheet-mask"] {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, .4);
}
[data-pocket-orb="sheet"] {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 41;
  height: 72vh;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, inherit);
  border-radius: 16px 16px 0 0;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
[data-pocket-orb="sheet-head"] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
}
/* 地址栏：整条可点 = 一键复制当前绝对路径；右侧文字给出「复制地址 / 已复制 / 复制失败」反馈 */
[data-pocket-orb="path-bar"] {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 12px 0;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 9px;
  background: var(--dsw-alias-fill-l1, rgba(0, 0, 0, .04));
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
[data-pocket-orb="path-bar"]:active {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .08));
}
[data-pocket-orb="path-text"] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 路径从盘符开始读：避免长路径把叶子目录挤掉时看起来像从中间开始 */
  direction: ltr;
  unicode-bidi: plaintext;
}
[data-pocket-orb="path-copy"] {
  flex: none;
  /* 「复制地址 / 已复制 / 复制失败」字数不同：留固定宽度，路径文字不跟着跳 */
  min-width: 4em;
  text-align: right;
  font-weight: 600;
  color: var(--dsw-alias-brand-primary, #4f6ef7);
}
[data-pocket-orb="path-bar"][data-copied="done"] [data-pocket-orb="path-copy"] {
  color: var(--dsw-alias-state-success-primary, #2e7d32);
}
[data-pocket-orb="path-bar"][data-copied="fail"] [data-pocket-orb="path-copy"] {
  color: var(--dsw-alias-state-error-primary, #d54941);
}
[data-pocket-orb="crumbs"] {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  white-space: nowrap;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
[data-pocket-orb="crumb"] {
  border: none;
  background: none;
  padding: 4px 6px;
  color: var(--dsw-alias-brand-primary, #4f6ef7);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  flex: none;
}
/* 盘符条：当前所在盘加粗高亮 */
[data-pocket-orb="crumb"][data-current="1"] {
  font-weight: 700;
  color: var(--dsw-alias-label-primary, inherit);
  text-decoration: underline;
}
[data-pocket-orb="sheet-list"] {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
[data-pocket-orb="entry"] {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 11px 14px;
  border: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .05));
  background: none;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
[data-pocket-orb="entry-icon"] {
  flex: none;
  font-size: 15px;
}
[data-pocket-orb="entry-name"] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-pocket-orb="entry-meta"] {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
}
[data-pocket-orb="sheet-foot"] {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
}
[data-pocket-orb="sheet-btn"] {
  flex: 1;
  height: 40px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
}
[data-pocket-orb="sheet-btn"][data-primary="1"] {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f6ef7));
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
[data-pocket-orb="sheet-status"] {
  padding: 24px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
}

/* toast */
[data-pocket-orb="toast"] {
  position: absolute;
  left: 50%;
  bottom: calc(96px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  max-width: 300px;
  padding: 10px 16px;
  border-radius: 10px;
  background: rgba(17, 24, 39, .92);
  color: #fff;
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .22);
  z-index: 50;
}

/* 抽屉入口按钮（宽屏隐藏）；悬浮球在电脑端也保留 —— dsh-assistant 点击它打开控制室 */
@media (min-width: 1024px) {
  [data-mobile-nav="orb"] {
    display: none !important;
  }
}
[data-mobile-nav="orb"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
[data-mobile-nav="orb"]:active {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
}

/* 悬浮球按钮（关闭态常驻；可拖动，left/top 由内联样式注入） */
[data-pocket-orb="ball"] {
  position: fixed;
  z-index: 3200;
  width: 52px;
  height: 52px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 50%;
  background: var(--dsw-alias-button-floating-fill, #ffffff);
  font-size: 24px;
  line-height: 1;
  cursor: grab;
  box-shadow: 0 4px 16px rgba(0, 0, 0, .22);
  -webkit-tap-highlight-color: transparent;
  /* 拖动时不要触发页面滚动 / 长按选择 / 系统菜单 */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
[data-pocket-orb="ball"]:active {
  cursor: grabbing;
  transform: scale(.94);
}

/* 输入框下方的模型选择行：前台 + 后台两个胶囊同一行靠右，窄屏各自压缩出省略号、绝不换行 */
[data-pocket-orb="model-row"] {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: nowrap;
  gap: 8px;
  margin-top: 8px;
  min-width: 0;
}
[data-pocket-orb="model-btn"] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 auto;
  min-width: 0;
  max-width: calc(50% - 4px);
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-family: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
[data-pocket-orb="model-btn-label"] {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-pocket-orb="model-btn"]:active {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
}

/* 会话行模式徽章：🖱️ GUI（蓝，Computer Use）/ 💬 标准（灰）——一眼区分 */
[data-pocket-orb="preset-badge"] {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  white-space: nowrap;
}
[data-pocket-orb="preset-badge"][data-mode="computer-use"] {
  background: rgba(79, 110, 247, .14);
  color: var(--dsw-alias-brand-primary, #4f6ef7);
}
[data-pocket-orb="preset-badge"][data-mode="standard"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
  color: var(--dsw-alias-label-secondary, #6b7280);
}
`

// 隐藏 DSH 官方「语音输入」插件自带的那颗麦克风：
// 它的界面打包在 app.asar 里，位置与音波样式都改不了；统一用悬浮球这一套，
// 避免同一个输入框出现两个手感不同的录音入口。
// 选择器用「官方哈希类 + 类名后缀」双保险，官方插件重新打包后仍能命中。
export const VOICE_DEDUP_CSS = `
[data-slot="conversation.composer.dock"] [class*="triggerAnchor"],
[data-slot="conversation.composer.dock"] [class*="Gyyz9a_trigger"],
.Gyyz9a_triggerAnchor,
.Gyyz9a_trigger {
  display: none !important;
}

/* 原生输入框里我们自己的录音按钮（官方那颗已被上面隐藏） */
[data-pocket-mic="button"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, .55));
  cursor: pointer;
}
[data-pocket-mic="button"][data-recording] {
  color: #e5484d;
  background: rgba(229, 72, 77, .12);
}
[data-pocket-mic="button"]:disabled {
  opacity: .5;
  cursor: default;
}
[data-pocket-mic="busy"] {
  margin-left: 2px;
  font-size: 11px;
}
[data-pocket-mic="notice"] {
  align-self: center;
  max-width: 220px;
  margin-left: 6px;
  font-size: 11px;
  line-height: 1.3;
  color: var(--dsh-alias-label-secondary, rgba(0, 0, 0, .6));
}
`
