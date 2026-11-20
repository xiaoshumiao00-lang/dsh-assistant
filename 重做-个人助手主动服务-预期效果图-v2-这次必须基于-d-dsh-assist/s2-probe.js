const skip = [...document.querySelectorAll('button')].find(b => /后一跳|跳过|Next|Skip/.test(b.textContent));
if (document.body.innerText.includes('这个悬浮球是干什么的') && skip) skip.click();
await new Promise(r => setTimeout(r, 600));
const rootStyle = getComputedStyle(document.documentElement);
const vars = {};
for (const name of ['--dsh-bg','--dsh-fg','--dsh-accent','--dsh-border','--dsh-radius','--bg','--fg','--accent','--border','--panel','--muted']) {
  const v = rootStyle.getPropertyValue(name); if (v) vars[name] = v.trim();
}
const pick = (sel) => {
  const el = document.querySelector(sel); if (!el) return null;
  const s = getComputedStyle(el);
  return { sel, bg: s.backgroundColor, color: s.color, border: s.border, radius: s.borderRadius, font: s.fontFamily, size: s.fontSize, weight: s.fontWeight, pad: s.padding };
};
return {
  vars,
  body: pick('body'),
  bodyBg: getComputedStyle(document.body).backgroundColor,
  htmlFont: getComputedStyle(document.body).fontFamily,
  probes: ['header','[data-mobile-nav="frame"]','textarea','[data-session-id]','[data-testid*="session"]'].map(pick),
  sessionEls: [...document.querySelectorAll('a,button,div')].filter(e => /会话|翻译/.test(e.textContent) && e.children.length === 0).slice(0,3).map(e => e.outerHTML.slice(0,200)),
};
