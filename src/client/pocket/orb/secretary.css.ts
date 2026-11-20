// 个人秘书全屏页。只复用 mobile.css.ts / orb.css.ts 已有的 --dsw-alias-* 令牌，
// 不引入新配色；所有颜色都有和现有页面同值的 fallback。
export const SECRETARY_CSS = `
[data-pocket-secretary="page"] {
  position: fixed;
  inset: 0;
  z-index: 10075;
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
[data-pocket-secretary="page"] *,
[data-pocket-secretary="page"] *::before,
[data-pocket-secretary="page"] *::after { box-sizing: border-box; }

[data-pocket-secretary="header"] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 52px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  background: var(--dsw-alias-bg-base, #ffffff);
}
[data-pocket-secretary="back"] {
  flex: none;
  width: 30px;
  height: 34px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font: inherit;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
[data-pocket-secretary="back"]:active { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06)); }
[data-pocket-secretary="title"] {
  flex: none;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: .1px;
  color: var(--dsw-alias-label-primary, inherit);
}
[data-pocket-secretary="folder"] {
  min-width: 0;
  max-width: 46%;
  height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 999px;
  background: var(--dsw-alias-fill-l1, rgba(0, 0, 0, .03));
  color: var(--dsw-alias-label-secondary, #6b7280);
  font: inherit;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-pocket-secretary="header-spacer"] { flex: 1; }
[data-pocket-secretary="header-state"] {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--dsw-alias-state-success-primary, #16a34a);
  font-size: 11px;
  font-weight: 500;
}
[data-pocket-secretary="header-state"]::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

[data-pocket-secretary="tabs"] {
  flex: none;
  display: flex;
  align-items: stretch;
  gap: 22px;
  height: 42px;
  padding: 0 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  background: var(--dsw-alias-bg-base, #ffffff);
}
[data-pocket-secretary="tab"] {
  position: relative;
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}
[data-pocket-secretary="tab"][data-active="1"] { color: var(--dsw-alias-state-business-primary, #4f6ef7); }
[data-pocket-secretary="tab"][data-active="1"]::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--dsw-alias-state-business-primary, #4f6ef7);
}

[data-pocket-secretary="warning"] {
  flex: none;
  margin: 8px 12px 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-state-warn-primary, #b45309);
  border-radius: 10px;
  background: var(--dsw-alias-fill-l1, rgba(0, 0, 0, .03));
  color: var(--dsw-alias-state-warn-primary, #b45309);
  font-size: 11px;
  line-height: 1.45;
}

[data-pocket-secretary="scroll"] {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  padding: 10px 12px 18px;
}
[data-pocket-secretary="section-head"] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 2px 8px;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-size: 11px;
}
[data-pocket-secretary="section-title"] { font-weight: 500; }
[data-pocket-secretary="empty"] {
  padding: 34px 16px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-size: 13px;
  line-height: 1.7;
}
[data-pocket-secretary="empty"] strong {
  display: block;
  margin-bottom: 4px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 14px;
  font-weight: 600;
}
[data-pocket-secretary="loading"] {
  padding: 18px 4px;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-size: 12px;
}

[data-pocket-secretary="card"] {
  width: 100%;
  margin: 0 0 10px;
  padding: 11px 12px 9px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  box-shadow: 0 2px 8px rgba(0, 0, 0, .035);
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
}
[data-pocket-secretary="card"][data-role="user"] {
  background: var(--dsw-alias-fill-l1, rgba(0, 0, 0, .03));
  box-shadow: none;
}
[data-pocket-secretary="card"]:active { border-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, .12)); }
[data-pocket-secretary="card-head"] {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-bottom: 6px;
}
[data-pocket-secretary="dot"] {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary, #16a34a);
}
[data-pocket-secretary="card"][data-role="user"] [data-pocket-secretary="dot"] {
  background: var(--dsw-alias-label-tertiary, #8b93a1);
}
[data-pocket-secretary="who"] {
  flex: none;
  color: var(--dsw-alias-state-business-primary, #4f6ef7);
  font-size: 11px;
  font-weight: 600;
}
[data-pocket-secretary="card"][data-role="user"] [data-pocket-secretary="who"] {
  color: var(--dsw-alias-label-secondary, #6b7280);
}
[data-pocket-secretary="card-title"] {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13.5px;
  font-weight: 600;
}
[data-pocket-secretary="card-title"]::before { content: " · "; color: var(--dsw-alias-label-tertiary, #8b93a1); font-weight: 400; }
[data-pocket-secretary="card"][data-role="user"] [data-pocket-secretary="card-title"],
[data-pocket-secretary="card"][data-role="user"] [data-pocket-secretary="card-title"]::before { display: none; }
[data-pocket-secretary="body"] {
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 13px;
  line-height: 1.62;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
[data-pocket-secretary="body"][data-clamped="1"] {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
}
[data-pocket-secretary="card-foot"] {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-size: 10.5px;
}
[data-pocket-secretary="card-time"] { flex: 1; }
[data-pocket-secretary="card-action"] {
  flex: none;
  height: 24px;
  padding: 0 9px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary, #4f6ef7);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font: inherit;
  font-size: 10.5px;
  font-weight: 500;
  cursor: pointer;
}
[data-pocket-secretary="card-action"][data-quiet="1"] {
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
}

[data-pocket-secretary="trace"] { display: grid; gap: 7px; }
[data-pocket-secretary="trace-row"] {
  display: grid;
  grid-template-columns: 52px 1fr;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
}
[data-pocket-secretary="trace-meta"] {
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  line-height: 1.5;
}
[data-pocket-secretary="trace-type"] {
  display: block;
  color: var(--dsw-alias-state-business-primary, #4f6ef7);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-pocket-secretary="trace-text"] {
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

[data-pocket-secretary="composer"] {
  flex: none;
  padding: 8px 12px 6px;
  border-top: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  background: var(--dsw-alias-bg-base, #ffffff);
}
[data-pocket-secretary="dispatch-row"] {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 2px 7px;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-size: 10.5px;
}
[data-pocket-secretary="dispatch-path"] {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
[data-pocket-secretary="mini-btn"] {
  flex: none;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
[data-pocket-secretary="modes"] {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0 1px 6px;
}
[data-pocket-secretary="mode"] {
  height: 23px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
}
[data-pocket-secretary="mode"][data-active="1"] {
  border-color: transparent;
  background: var(--dsw-alias-fill-l1, rgba(0, 0, 0, .04));
  color: var(--dsw-alias-label-primary, inherit);
  font-weight: 600;
}
[data-pocket-secretary="input-row"] {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 7px 8px 7px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  border-radius: 20px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .035);
}
[data-pocket-secretary="input"] {
  flex: 1;
  min-width: 0;
  min-height: 26px;
  max-height: 112px;
  padding: 4px 0;
  border: 0;
  outline: 0;
  resize: none;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 14px;
  line-height: 1.45;
}
[data-pocket-secretary="input"]::placeholder { color: var(--dsw-alias-label-tertiary, #8b93a1); }
[data-pocket-secretary="send"] {
  flex: none;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary, #4f6ef7);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font: inherit;
  font-size: 19px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
}
[data-pocket-secretary="send"]:disabled {
  background: var(--dsw-alias-fill-l1, rgba(0, 0, 0, .06));
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  cursor: default;
}
[data-pocket-secretary="statusbar"] {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 25px;
  padding: 0 14px 4px;
  color: var(--dsw-alias-label-tertiary, #8b93a1);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
}
[data-pocket-secretary="statusbar"] span {
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-pocket-secretary="status-good"] { color: var(--dsw-alias-state-success-primary, #16a34a); }
[data-pocket-secretary="status-warn"] { color: var(--dsw-alias-state-warn-primary, #b45309); }
[data-pocket-secretary="toast"] {
  position: fixed;
  left: 50%;
  bottom: calc(98px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  max-width: calc(100vw - 32px);
  padding: 8px 12px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, #f3f4f6);
  color: var(--dsw-alias-label-primary, inherit);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .12));
  box-shadow: 0 6px 18px rgba(0, 0, 0, .12);
  font-size: 12px;
  z-index: 10076;
}
`
