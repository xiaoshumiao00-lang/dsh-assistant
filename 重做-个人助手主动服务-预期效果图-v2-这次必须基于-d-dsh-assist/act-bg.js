const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scroller = [...document.querySelectorAll('*')].find((e) => e.className && String(e.className).includes('scrollBody')) || document.scrollingElement;
if (scroller && scroller.scrollTo) scroller.scrollTop = 0;
await sleep(1500);
const seen = new Map();
for (const el of document.querySelectorAll('div, section, p, span')) {
  const s = getComputedStyle(el);
  const bg = s.backgroundColor;
  if (bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)' || bg === 'rgb(255, 255, 255)') continue;
  const key = String(el.className).split(' ')[0] || el.tagName;
  if (seen.has(key)) continue;
  seen.set(key, { cls: key, bg, color: s.color, radius: s.borderRadius, padding: s.padding, fontSize: s.fontSize, border: s.border, boxShadow: s.boxShadow.slice(0, 80), width: s.width, maxWidth: s.maxWidth, textAlign: s.textAlign });
  if (seen.size > 22) break;
}
return { found: [...seen.values()], text: document.body.innerText.slice(0, 120).replace(/\n/g, ' | ') };
