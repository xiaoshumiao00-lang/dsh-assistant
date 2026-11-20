// One-shot capture driver: start headless chrome w/ CDP, capture pocket mobile + desktop panel + chat bubbles.
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const DIR = 'D:/dsh-assistant/重做-个人助手主动服务-预期效果图-v2-这次必须基于-d-dsh-assist';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TOK = process.env.POCKET_TOKEN;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=9222', `--user-data-dir=${DIR}/.chrome-cdp2`, 'about:blank'], { stdio: 'ignore' });

async function ready() {
  for (let i = 0; i < 40; i++) {
    try { const v = await fetch('http://127.0.0.1:9222/json/version').then(r => r.json()); if (v.webSocketDebuggerUrl) return v; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('chrome not ready');
}
const ver = await ready();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const msgs = [];
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.error) msgs.push('ERR ' + JSON.stringify(m.error).slice(0, 200)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise(r => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}, sessionId) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); });

async function newPage(url, { width, height, mobile }, label) {
  const created = await fetch(`http://127.0.0.1:9222/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then(r => r.json());
  const attach = await send('Target.attachToTarget', { targetId: created.id, flatten: true });
  const sessionId = attach.result?.sessionId;
  if (!sessionId) throw new Error('no sessionId: ' + JSON.stringify(attach).slice(0, 200));
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable'); await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
  await s('Page.navigate', { url });
  // poll for app ready inside the page
  const poll = await s('Runtime.evaluate', { expression: `(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<120;i++){if(document.querySelectorAll('[data-row-key]').length>0)return{ok:true,n:document.querySelectorAll('[data-row-key]').length,t:performance.now()|0};await sleep(500)}return{ok:false,head:document.body.innerText.slice(0,80)})()`, awaitPromise: true, returnByValue: true });
  console.log(label, 'ready', JSON.stringify(poll.result?.result?.value ?? poll.result?.exceptionDetails ?? poll.error));
  return { s, sessionId, created };
}

async function snap(s, out) {
  const shot = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (shot.error) { console.log('SHOT_ERR', JSON.stringify(shot.error)); return false; }
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('SAVED', out);
  return true;
}

const base = `http://127.0.0.1:3081/?token=${TOK}`;

// 1) mobile pocket page
const mob = await newPage(base, { width: 390, height: 844, mobile: true }, 'MOBILE');
await new Promise(r => setTimeout(r, 1500));
// dismiss first-run guide if present
await mob.s('Runtime.evaluate', { expression: `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/后一跳|跳过/.test(x.textContent));if(document.body.innerText.includes('这个悬浮球')&&b)b.click();})()`, returnByValue: true });
await new Promise(r => setTimeout(r, 1200));
await snap(mob.s, `${DIR}/ref-pocket.png`);

// 1b) drawer (session list) via keyboard-less click on the nav toggle
const drawer = await mob.s('Runtime.evaluate', { expression: `(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));const t=document.querySelector('[data-dshp-nav-toggle],.dshp-nav-toggle,button[aria-label="展开侧边栏"]');if(t){t.click();await sleep(900);}const w=[...document.querySelectorAll('[data-row-key^="workspace:"]')][0];if(w){w.click();await sleep(1200);}const rows=[...document.querySelectorAll('[data-row-key^="session:"]')].slice(0,3);return{toggle:!!t,ws:!!w,sessN:rows.length,html:rows[0]?.outerHTML?.slice(0,300)}})()`, awaitPromise: true, returnByValue: true });
console.log('DRAWER', JSON.stringify(drawer.result?.result?.value ?? drawer.result?.exceptionDetails?.exception?.description ?? drawer.error).slice(0, 900));
await snap(mob.s, `${DIR}/ref-pocket-list.png`);

// 1c) open a session to get chat bubbles
const open = await mob.s('Runtime.evaluate', { expression: `(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));const rows=[...document.querySelectorAll('[data-row-key^="session:"]')];const t=rows.find(e=>/assistant|翻译/.test(e.textContent))||rows[0];if(!t)return{no:true};t.click();for(let i=0;i<60;i++){if(document.querySelectorAll('[data-message-id],[data-role="message"],[class*="message"]').length>0)break;await sleep(500)}await sleep(2000);const b=document.querySelector('[data-message-id],[class*="message"]');return{found:!!b,cls:b?String(b.className).slice(0,120):null}})()`, awaitPromise: true, returnByValue: true });
console.log('OPEN', JSON.stringify(open.result?.result?.value ?? open.result?.exceptionDetails?.exception?.description ?? open.error).slice(0, 900));
await snap(mob.s, `${DIR}/ref-pocket-chat.png`);
await send('Target.closeTarget', { targetId: mob.created.id });

// 2) desktop layout
const desk = await newPage(`${base}&dsh-layout=desktop`, { width: 1440, height: 900, mobile: false }, 'DESKTOP');
await new Promise(r => setTimeout(r, 1500));
await snap(desk.s, `${DIR}/ref-web.png`);
await send('Target.closeTarget', { targetId: desk.created.id });

ws.close();
chrome.kill();
process.exit(0);
