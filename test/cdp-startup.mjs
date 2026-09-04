// Watch what happens in the first seconds after launch: SW console + offscreen document creation.
const v = await fetch("http://127.0.0.1:9222/json/version").then(r=>r.json());
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend=new Map(); const t0=Date.now();
const log=(...a)=>console.log(`+${((Date.now()-t0)/1000).toFixed(1)}s`, ...a);
ws.onmessage = e => { const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){ const p=pend.get(m.id); pend.delete(m.id); m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);} 
  else if (m.method==="Target.targetCreated" || m.method==="Target.targetInfoChanged") { const t=m.params.targetInfo; if (t.url.includes("offscreen")) log("offscreen target:", m.method, t.url); }
  else if (m.method==="Runtime.consoleAPICalled") log("SW console:", m.params.type, m.params.args.map(a=>a.value??a.description).join(" "));
  else if (m.method==="Target.attachedToTarget") { const t=m.params.targetInfo; if (t.type==="service_worker" && t.url.includes("background.js")) { log("SW attached"); send("Runtime.enable",{},m.params.sessionId); } } };
const send=(method,params={},sessionId)=>new Promise((res,rej)=>{pend.set(++id,{res,rej}); ws.send(JSON.stringify({id,method,params,sessionId}));});
await send("Target.setDiscoverTargets",{discover:true});
await send("Target.setAutoAttach",{autoAttach:true, waitForDebuggerOnStart:false, flatten:true});
const { targetInfos } = await send("Target.getTargets");
log("initial targets:", targetInfos.filter(t=>t.url.includes("chrome-extension")).map(t=>t.type+" "+t.url.split("/").slice(3).join("/")).join(" | "));
await new Promise(r=>setTimeout(r,12000));
const { targetInfos: t2 } = await send("Target.getTargets");
log("offscreen docs now:", t2.filter(t=>t.url.includes("offscreen")).length);
// settings in storage
const sw = t2.find(t=>t.type==="service_worker" && t.url.includes("background.js"));
if (sw) { const { sessionId } = await send("Target.attachToTarget",{targetId: sw.targetId, flatten:true}); const r = await send("Runtime.evaluate",{expression:"chrome.storage.local.get('settings').then(s=>JSON.stringify(s.settings))", awaitPromise:true, returnByValue:true}, sessionId); log("stored settings:", r.result.value); const r2 = await send("Runtime.evaluate",{expression:"chrome.storage.session.get('engineStart').then(s=>JSON.stringify(s.engineStart))", awaitPromise:true, returnByValue:true}, sessionId); log("engine start reason:", r2.result.value); }
ws.close();
