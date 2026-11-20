const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
const skip = [...document.querySelectorAll('button')].find(b => /后一跳|跳过/.test(b.textContent));
if (skip) skip.click();
await new Promise(r => setTimeout(r, 800));
const guideGone = !document.body.innerText.includes('这个悬浮球是干什么的');
return { btns, guideGone, text: document.body.innerText.slice(0, 400) };
