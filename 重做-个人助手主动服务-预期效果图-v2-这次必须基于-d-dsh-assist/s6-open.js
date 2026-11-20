const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 25000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (fn()) return true; } catch {} await sleep(400); } return false; }
await waitFor(() => document.querySelectorAll('[data-row-key]').length > 0);
const skip = [...document.querySelectorAll('button')].find(b => /后一跳|跳过/.test(b.textContent));
if (document.body.innerText.includes('这个悬浮球是干什么的') && skip) { skip.click(); await sleep(600); }
const row = [...document.querySelectorAll('[data-row-key^="workspace:"]')].find(e => e.textContent.includes('09-英文翻译'));
if (row) { row.click(); }
await sleep(2500);
const sess = [...document.querySelectorAll('[data-row-key^="session:"]')];
let clicked = null;
if (sess.length) {
  const target = sess.find(e => /翻译/.test(e.textContent)) ?? sess[0];
  clicked = target.textContent.trim().slice(0, 40);
  target.click();
  await sleep(4000);
}
return { n: document.querySelectorAll('[data-row-key]').length, sessCount: sess.length, names: sess.slice(0,5).map(e=>e.textContent.trim().slice(0,30)), clicked, title: document.title, text: document.body.innerText.slice(0, 300) };
