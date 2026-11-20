// CDP: node cdp.mjs <url> <w> <h> <out.png> [waitMs] [actionsJsFile]
import { writeFileSync, readFileSync } from 'node:fs';

const [url, w, h, out, waitMsArg, actionsFile] = process.argv.slice(2);
const width = Number(w), height = Number(h), waitMs = Number(waitMsArg ?? 6000);

const created = await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' }).then(r => r.json());
const ws = new WebSocket(created.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 });
await send('Page.navigate', { url });
await new Promise(r => setTimeout(r, waitMs));

if (actionsFile) {
  const src = readFileSync(actionsFile, 'utf8');
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${src}})()`, awaitPromise: true, returnByValue: true });
  console.log('ACT', JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r.error).slice(0, 3000));
}

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
if (shot.error) console.log('SHOT_ERR', JSON.stringify(shot.error));
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('SAVED', out);
ws.close(); process.exit(0);
