const skip = [...document.querySelectorAll('button')].find(b => /后一跳|跳过/.test(b.textContent));
if (document.body.innerText.includes('这个悬浮球是干什么的') && skip) { skip.click(); await new Promise(r => setTimeout(r, 500)); }
const el = [...document.querySelectorAll('*')].find(e => e.textContent.trim() === '09-英文翻译' && e.children.length === 0);
let chain = [];
if (el) {
  let n = el;
  for (let i = 0; i < 6 && n; i++) { chain.push({ tag: n.tagName, cls: String(n.className).slice(0,80), attrs: [...n.attributes].map(a=>a.name+'='+a.value.slice(0,40)).join(' ').slice(0,160) }); n = n.parentElement; }
}
const ls = { ...localStorage };
return { found: !!el, chain, lsKeys: Object.keys(ls), lsCur: ls['dsh.sessions.current'] };
