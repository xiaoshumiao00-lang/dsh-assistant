const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let k = 0, last = '';
const t0 = Date.now();
while (Date.now() - t0 < 90000) {
  k = document.querySelectorAll('[data-row-key]').length;
  last = document.body.innerText.slice(0, 80).replace(/\n/g, ' | ');
  if (k > 0) break;
  await sleep(1000);
}
return { ms: Date.now() - t0, k, last };
