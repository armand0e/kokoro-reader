const v = await fetch("http://127.0.0.1:9222/json/version").then(r=>r.json());
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend=new Map();
ws.onmessage = e => { const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){ const p=pend.get(m.id); pend.delete(m.id); m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);} };
const send=(method,params={},sessionId)=>new Promise((res,rej)=>{pend.set(++id,{res,rej}); ws.send(JSON.stringify({id,method,params,sessionId}));});
const ev = async (sid, expression) => { const r = await send("Runtime.evaluate",{expression, awaitPromise:true, returnByValue:true}, sid); return r.exceptionDetails ? "EXC "+(r.exceptionDetails.exception?.description||r.exceptionDetails.text) : r.result.value; };
const { targetInfos } = await send("Target.getTargets");
const off = targetInfos.find(t=>t.url.includes("/offscreen/offscreen.html"));
const EXT = new URL(off.url).host;
const { sessionId: so } = await send("Target.attachToTarget",{targetId: off.targetId, flatten:true});
console.log("offscreen crossOriginIsolated:", await ev(so, "self.crossOriginIsolated"));
console.log("offscreen caches.open:", await ev(so, "caches.open('diag').then(()=>'ok', e=>'ERR '+e)"));
console.log("offscreen caches.keys:", await ev(so, "caches.keys().then(k=>JSON.stringify(k), e=>'ERR '+e)"));
console.log("offscreen indexedDB:", await ev(so, "new Promise(r=>{const q=indexedDB.open('diag'); q.onsuccess=()=>r('ok'); q.onerror=()=>r('ERR '+q.error);})"));
console.log("offscreen storage estimate:", await ev(so, "navigator.storage.estimate().then(e=>JSON.stringify(e), e=>'ERR '+e)"));
// popup page
const { targetId } = await send("Target.createTarget",{url:`chrome-extension://${EXT}/popup/popup.html`});
const { sessionId: sp } = await send("Target.attachToTarget",{targetId, flatten:true});
await new Promise(r=>setTimeout(r,800));
console.log("popup crossOriginIsolated:", await ev(sp, "self.crossOriginIsolated"));
console.log("popup caches.open:", await ev(sp, "caches.open('diag').then(()=>'ok', e=>'ERR '+e)"));
console.log("popup caches.keys:", await ev(sp, "caches.keys().then(k=>JSON.stringify(k), e=>'ERR '+e)"));
console.log("popup storage estimate:", await ev(sp, "navigator.storage.estimate().then(e=>JSON.stringify(e), e=>'ERR '+e)"));
await send("Target.closeTarget",{targetId});
// service worker: downloads
const sw = targetInfos.find(t=>t.type==="service_worker" && t.url.includes(EXT));
if (sw) { const { sessionId: ss } = await send("Target.attachToTarget",{targetId: sw.targetId, flatten:true});
  console.log("downloads:", await ev(ss, "chrome.downloads.search({}).then(d=>JSON.stringify(d.map(x=>({url:x.url.slice(0,60),state:x.state,error:x.error,filename:x.filename,bytes:x.totalBytes}))))"));
  console.log("sw caches.open:", await ev(ss, "caches.open('diag').then(()=>'ok', e=>'ERR '+e)"));
}
ws.close();
