import { spawn } from 'node:child_process';
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--remote-debugging-port=9223','--user-data-dir=D:/dsh-assistant/.dbg-chrome','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ver; for(let i=0;i<40;i++){try{ver=await fetch('http://127.0.0.1:9223/json/version').then(r=>r.json());break}catch{}await sleep(500)}
const ws=new WebSocket(ver.webSocketDebuggerUrl);let id=0;const pend=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}});
await new Promise(r=>ws.addEventListener('open',r,{once:true}));
const send=(method,params={},sessionId)=>new Promise(res=>{const mid=++id;pend.set(mid,res);ws.send(JSON.stringify({id:mid,method,params,...(sessionId?{sessionId}:{})}))});
const created=await fetch('http://127.0.0.1:9223/json/new?'+encodeURIComponent('about:blank'),{method:'PUT'}).then(r=>r.json());
const a=await send('Target.attachToTarget',{targetId:created.id,flatten:true});
console.log('ATTACH',JSON.stringify(a).slice(0,400));
const sid=a.result?.sessionId;
const r1=await send('Runtime.evaluate',{expression:'1+1',returnByValue:true},sid);
console.log('EVAL',JSON.stringify(r1).slice(0,300));
ws.close();chrome.kill();process.exit(0);
