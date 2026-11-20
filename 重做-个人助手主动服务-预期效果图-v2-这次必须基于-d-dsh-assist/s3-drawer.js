const skip = [...document.querySelectorAll('button')].find(b => /后一跳|跳过|Next|Skip/.test(b.textContent));
if (document.body.innerText.includes('这个悬浮球是干什么的') && skip) { skip.click(); await new Promise(r => setTimeout(r, 500)); }
const btns = [...document.querySelectorAll('button')].slice(0, 8).map(b => ({ t: b.textContent.trim().slice(0, 20), aria: b.getAttribute('aria-label'), cls: b.className.slice(0, 60) }));
const hamburger = [...document.querySelectorAll('button')].find(b => /菜单|侧边|sidebar|menu/i.test((b.getAttribute('aria-label') || '') + b.className));
if (hamburger) hamburger.click();
await new Promise(r => setTimeout(r, 900));
const rows = [...document.querySelectorAll('[data-row-key]')].slice(0, 3).map(e => e.outerHTML.slice(0, 400));
return { btns, rows, bodyStart: document.body.innerText.slice(0, 200), drawer: !!document.querySelector('[data-dshp-drawer="open"]') };
