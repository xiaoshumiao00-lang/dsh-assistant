const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const styleOf = (el, keys) => { if (!el) return null; const s = getComputedStyle(el); const o = { cls: String(el.className).slice(0, 60) }; for (const k of keys) o[k] = s[k]; return o; };
const K = ['backgroundColor', 'color', 'borderRadius', 'border', 'padding', 'margin', 'fontSize', 'lineHeight', 'fontFamily', 'boxShadow', 'maxWidth', 'width'];
out.tokens = {};
for (const n of ['--dsw-alias-bg-base', '--dsw-alias-label-primary', '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary', '--dsw-alias-accent', '--dsw-font-text', '--ds-font', '--dsw-radius', '--dsw-alias-text-area-bg']) { const v = getComputedStyle(document.documentElement).getPropertyValue(n); if (v) out.tokens[n] = v.trim(); }
out.body = styleOf(document.body, ['backgroundColor', 'color', 'fontFamily', 'fontSize']);
out.composer = styleOf(document.querySelector('[data-composer-card="true"]'), K);
out.textarea = styleOf(document.querySelector('[data-composer-card="true"] [contenteditable], [data-composer-card="true"] textarea, [data-composer-card="true"] [role="textbox"]'), K);
out.tabs = [...document.querySelectorAll('[role="tab"], [data-tab]')].slice(0, 4).map((e) => styleOf(e, ['color', 'borderBottom', 'fontSize', 'padding']));
out.header = styleOf(document.querySelector('[data-window-drag]'), K);
out.sessionRow = styleOf(document.querySelector('[data-row-key^="session:"]'), K);
const msgHooks = [];
for (const el of document.querySelectorAll('[data-message-id], [data-message], [class*="message"], [data-turn], [data-role]')) {
  msgHooks.push({ tag: el.tagName, cls: String(el.className).slice(0, 70), attrs: [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-')).join(',') });
  if (msgHooks.length > 14) break;
}
out.msgHooks = msgHooks;
out.texts = { head: document.body.innerText.slice(0, 180).replace(/\n/g, ' | ') };
return out;
