const frame = document.querySelector('[data-dsh-frame]') || document.body;
const seen = new Map();
for (const el of frame.querySelectorAll('*')) {
  for (const c of String(el.className).split(' ')) { if (c) seen.set(c, (seen.get(c) ?? 0) + 1); }
}
const classes = [...seen.keys()].filter((c) => /(message|bubble|user|mine|assistant|turn|markdown|body|text|row|card|header|tab|composer|input|panel)/i.test(c)).slice(0, 70);
const K = ['backgroundColor', 'color', 'borderRadius', 'borderTopLeftRadius', 'borderBottomLeftRadius', 'border', 'padding', 'margin', 'fontSize', 'lineHeight', 'maxWidth', 'boxShadow'];
const grab = (el) => { if (!el) return null; const s = getComputedStyle(el); const o = { cls: String(el.className).slice(0, 70), tag: el.tagName }; for (const k of K) o[k] = s[k]; return o; };
const blocks = [...frame.querySelectorAll('[class*="_message"], [class*="_turn"], [data-turn-index]')].slice(0, 10).map((e) => grab(e));
return {
  classes,
  blocks,
  userGuess: ['[class*="userMessage"]', '[class*="_userRow"]', '[class*="mine"]', '[data-message-role="user"]'].map((sel) => ({ sel, el: grab(document.querySelector(sel)) })),
  textStart: document.body.innerText.slice(0, 160).replace(/\n/g, ' | '),
};
