import { writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const DIR = process.cwd();
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TOK = process.env.POCKET_TOKEN;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=9225', `--user-data-dir=${DIR}/.chrome-cdp4`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver = null;
for (let i = 0; i < 60 && !ver; i++) { try { ver = await fetch('http://127.0.0.1:9225/json/version').then((r) => r.json()); } catch { await sleep(500); } }
if (!ver) { chrome.kill(); throw new Error('chrome not ready'); }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}, sessionId) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); });

async function act(page, file) {
  const src = readFileSync(`${DIR}/${file}`, 'utf8');
  const r = await page('Runtime.evaluate', { expression: `(async () => { ${src} })()`, awaitPromise: true, returnByValue: true });
  console.log('ACT', file, JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? r.error).slice(0, 3500));
}

async function openTarget(url, { width, height, mobile }) {
  const created = await fetch(`http://127.0.0.1:9225/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
  const attach = await send('Target.attachToTarget', { targetId: created.id, flatten: true });
  const sessionId = attach.result?.sessionId;
  if (!sessionId) throw new Error('no sessionId ' + JSON.stringify(attach).slice(0, 200));
  const page = (method, params = {}) => send(method, params, sessionId);
  await page('Page.enable'); await page('Runtime.enable');
  await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
  await page('Page.navigate', { url });
  await sleep(9000);
  return { page, id: created.id };
}

async function snap(page, out) {
  const shot = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (shot.error) { console.log('SHOT_ERR', JSON.stringify(shot.error)); return; }
  writeFileSync(`${DIR}/${out}`, Buffer.from(shot.result.data, 'base64'));
  console.log('SAVED', out);
}

// ---- mobile ----
const mob = await openTarget(`http://127.0.0.1:3081/?token=${TOK}`, { width: 390, height: 844, mobile: true });
await mob.page('Runtime.evaluate', { expression: 'void 0', returnByValue: true });
await act(mob.page, 'act-dismiss.js');
await sleep(1200);
await snap(mob.page, 'ref-pocket.png');
await act(mob.page, 'act-open.js');
await snap(mob.page, 'ref-pocket-chat.png');
await act(mob.page, 'act-classes.js');
await send('Target.closeTarget', { targetId: mob.id });

// ---- desktop ----
const desk = await openTarget(`http://127.0.0.1:3081/?token=${TOK}&dsh-layout=desktop`, { width: 1440, height: 900, mobile: false });
await snap(desk.page, 'ref-web.png');
await act(desk.page, 'act-open.js');
await snap(desk.page, 'ref-web-chat.png');
await send('Target.closeTarget', { targetId: desk.id });

ws.close();
chrome.kill();
process.exit(0);

