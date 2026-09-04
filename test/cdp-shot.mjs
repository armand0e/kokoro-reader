// usage: node test/cdp-shot.mjs <url> <out.png> [evalExpr]
import { writeFile } from "node:fs/promises";
const [url, out, expr] = process.argv.slice(2);
const v = await fetch("http://127.0.0.1:9222/json/version").then(r=>r.json());
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend=new Map();
ws.onmessage = e => { const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){ const p=pend.get(m.id); pend.delete(m.id); m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);} };
const send=(method,params={},sessionId)=>new Promise((res,rej)=>{pend.set(++id,{res,rej}); ws.send(JSON.stringify({id,method,params,sessionId}));});
const { targetId } = await send("Target.createTarget",{url});
const { sessionId } = await send("Target.attachToTarget",{targetId, flatten:true});
await send("Runtime.enable",{},sessionId);
await new Promise(r=>setTimeout(r,2500));
if (expr) { const r = await send("Runtime.evaluate",{expression:expr, awaitPromise:true, returnByValue:true},sessionId); console.log(JSON.stringify(r.result?.value ?? r, null, 1)); }
const shot = await send("Page.captureScreenshot",{format:"png"},sessionId);
await writeFile(out, Buffer.from(shot.data,"base64"));
await send("Target.closeTarget",{targetId});
ws.close();
