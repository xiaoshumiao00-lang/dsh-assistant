import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const DIR = process.cwd();
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TOK = process.env.POCKET_TOKEN;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9230', `--user-data-dir=${DIR}/.chrome-cdp9`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver = null;
for (let i = 0; i < 60 && !ver; i++) { try { ver = await fetch('http://127.0.0.1:9230/json/version').then((r) => r.json()); } catch { await sleep(500); } }
if (!ver) { chrome.kill(); throw new Error('chrome not ready'); }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}, sessionId) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); });

const created = await fetch(`http://127.0.0.1:9230/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' }).then((r) => r.json());
const attach = await send('Target.attachToTarget', { targetId: created.id, flatten: true });
const sid = attach.result?.sessionId;
if (!sid) { console.log('ATTACH FAIL', JSON.stringify(attach).slice(0, 300)); chrome.kill(); process.exit(1); }
const page = (m, p) => send(m, p, sid);
await page('Page.enable'); await page('Runtime.enable');
await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await page('Page.navigate', { url: `http://127.0.0.1:3081/?token=${TOK}` });
await sleep(12000);
const src = readFileSync(`${DIR}/act-css.js`, 'utf8');
const r = await page('Runtime.evaluate', { expression: `(async () => { ${src} })()`, awaitPromise: true, returnByValue: true });
const v = r.result?.result?.value;
writeFileSync(`${DIR}/live-rules.txt`, Array.isArray(v) ? v.join('\n') : JSON.stringify(r.result?.exceptionDetails ?? r.error, null, 1));
console.log('RULES', Array.isArray(v) ? v.length : 'none');
ws.close(); chrome.kill(); process.exit(0);
