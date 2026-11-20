import { spawn } from 'node:child_process';
const DIR = process.cwd();
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=9240', `--user-data-dir=${DIR}/.chrome-verify`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver = null;
for (let i = 0; i < 60 && !ver; i++) { try { ver = await fetch('http://127.0.0.1:9240/json/version').then((r) => r.json()); } catch { await sleep(400); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}, sessionId) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); });
const created = await fetch(`http://127.0.0.1:9240/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' }).then((r) => r.json());
const attach = await send('Target.attachToTarget', { targetId: created.id, flatten: true });
const sid = attach.result?.sessionId;
if (!sid) { console.log('ATTACH FAIL'); chrome.kill(); process.exit(1); }
await send('Page.enable', {}, sid);
await send('Runtime.enable', {}, sid);
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false }, sid);
await send('Page.navigate', { url: `file:///${DIR.replace(/\\/g, '/')}/mockup.html` }, sid);
await sleep(1500);
const probe = `(() => {
  const q = (s) => document.querySelector(s);
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), b: Math.round(b.bottom), r: Math.round(b.right) }; };
  const conv = q('.conv');
  const msgs = [...document.querySelectorAll('.phone .msg')].map((m) => ({ rect: r(m), clipped: m.scrollWidth > m.clientWidth + 1, over: m.getBoundingClientRect().bottom > conv.getBoundingClientRect().bottom }));
  const overflowing = [...document.querySelectorAll('.canvas *')].filter((el) => el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible').map((el) => ({ cls: String(el.className).slice(0, 30), sw: el.scrollWidth, cw: el.clientWidth, txt: el.textContent.trim().slice(0, 24) }));
  return {
    canvas: r(q('.canvas')),
    bodyScroll: { w: document.body.scrollWidth, h: document.body.scrollHeight },
    conv: { rect: r(conv), scrollH: conv.scrollHeight, clientH: conv.clientHeight, overflowed: conv.scrollHeight - conv.clientHeight },
    msgs,
    overlays: ['desk', 'd-composer', 'desk-ball', 'toast', 'phone', 'conv'].map((c) => ({ cls: c, rect: r(q('.' + c) || q(c)) })),
  };
})()`;
const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true }, sid);
console.log(JSON.stringify(r.result?.result?.value ?? r, null, 1).slice(0, 4000));
const shot = await send('Page.captureScreenshot', { format: 'png' }, sid);
const fs = await import('node:fs');
fs.writeFileSync(`${DIR}/mockup-check.png`, Buffer.from(shot.result.data, 'base64'));
console.log('SAVED mockup-check.png');
ws.close(); chrome.kill(); process.exit(0);
