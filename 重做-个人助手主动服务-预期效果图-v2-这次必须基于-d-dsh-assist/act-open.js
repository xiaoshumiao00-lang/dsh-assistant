const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = [...document.querySelectorAll('[data-row-key^="workspace:"]')].find((e) => /09-英文翻译|09 英文翻译|09-/.test(e.textContent));
if (ws) { ws.click(); await sleep(1500); }
const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
const target = rows.find((e) => /assistant|09/.test(e.textContent)) || rows[0];
let clicked = null;
if (target) { clicked = target.getAttribute('data-row-key'); target.click(); }
let ok = false;
for (let i = 0; i < 60; i++) {
  const t = document.body.innerText;
  if (t.includes('对话') && t.includes('轨迹')) { ok = true; break; }
  await sleep(500);
}
await sleep(2500);
const scrollables = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 200);
for (const el of scrollables.slice(0, 3)) el.scrollTop = 0;
await sleep(1200);
return { clicked, ok, rowCount: rows.length, names: rows.slice(0, 5).map((e) => e.textContent.trim().slice(0, 24)) };
