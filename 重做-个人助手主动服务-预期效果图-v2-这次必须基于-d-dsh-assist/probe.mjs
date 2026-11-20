// Attach to an existing page: node probe.mjs <scriptFile|expr> [out.png]
import { writeFileSync, readFileSync } from 'node:fs';
const [scriptArg, outPng] = process.argv.slice(2);
const expr = scriptArg.endsWith('.js') ? readFileSync(scriptArg, 'utf8') : scriptArg;
const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
const page = list.find(t => t.type === 'page' && t.url.includes('3081')) ?? list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
await send('Runtime.enable');
const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(r.result?.result?.value ?? r, null, 1).slice(0, 6000));
if (r.error || r.result?.exceptionDetails) console.error('EXC', JSON.stringify(r.result?.exceptionDetails?.exception?.description ?? r.error).slice(0, 1500));
if (outPng) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));
}
ws.close(); process.exit(0);
