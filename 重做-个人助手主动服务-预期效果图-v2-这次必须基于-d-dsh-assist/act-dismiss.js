const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
localStorage.setItem('dsh.assistant.firstRunGuide.v1', JSON.stringify({ done: true, seenAll: true }));
const skip = [...document.querySelectorAll('button')].find((b) => /后一跳|跳过/.test(b.textContent));
if (skip) skip.click();
await sleep(400);
return { guideVisible: document.body.innerText.includes('这个悬浮球'), hasRows: document.querySelectorAll('[data-row-key]').length };
