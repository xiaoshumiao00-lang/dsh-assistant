const skip = [...document.querySelectorAll('button')].find(b => /后一跳|跳过/.test(b.textContent));
if (document.body.innerText.includes('这个悬浮球是干什么的') && skip) { skip.click(); await new Promise(r => setTimeout(r, 500)); }
const row = [...document.querySelectorAll('[data-row-key^="workspace:"]')].find(e => e.textContent.includes('09-英文翻译'));
if (row) { row.click(); await new Promise(r => setTimeout(r, 800)); }
const keys = [...document.querySelectorAll('[data-row-key]')].map(e => e.getAttribute('data-row-key'));
return { keys: keys.slice(0, 12), text: document.body.innerText.slice(0, 200) };
