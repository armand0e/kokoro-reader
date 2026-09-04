// Switch the engine to WASM/q8 via settings and verify it loads and synthesizes (the no-WebGPU path).
const v = await fetch("http://127.0.0.1:9222/json/version").then(r=>r.json());
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend=new Map();
ws.onmessage = e => { const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){ const p=pend.get(m.id); pend.delete(m.id); m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);} };
const send=(method,params={},sessionId)=>new Promise((res,rej)=>{pend.set(++id,{res,rej}); ws.send(JSON.stringify({id,method,params,sessionId}));});
const ev = async (sid, expression) => { const r = await send("Runtime.evaluate",{expression, awaitPromise:true, returnByValue:true}, sid); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text); return r.result.value; };
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const { targetInfos } = await send("Target.getTargets");
const off = targetInfos.find(t=>t.url.includes("/offscreen/offscreen.html"));
const EXT = new URL(off.url).host;
const { sessionId: so } = await send("Target.attachToTarget",{targetId: off.targetId, flatten:true});
await send("Runtime.enable",{},so);
const errs=[]; ws.addEventListener("message", e=>{ const m=JSON.parse(e.data); if (m.method==="Runtime.exceptionThrown") errs.push(m.params.exceptionDetails.text); if (m.method==="Runtime.consoleAPICalled" && m.params.type==="error") errs.push(m.params.args.map(a=>a.value||a.description).join(" ")); });
const bg = (msg) => ev(so, `chrome.runtime.sendMessage({target:'background', ...${JSON.stringify(msg)}})`);
const offs = (msg) => ev(so, `new Promise(r => chrome.runtime.onMessage.addListener(function l(m, s, sr){ if (m && m.__diag === ${JSON.stringify(msg.type)}) { chrome.runtime.onMessage.removeListener(l);} }), r(0))`);
// change settings → SW forwards to offscreen → reloadModel
await ev(so, `chrome.runtime.sendMessage({target:'background', type:'cs:getState'}).catch(()=>{})`);
const { targetInfos: t2 } = await send("Target.getTargets");
const sw = t2.find(t=>t.type==="service_worker" && t.url.includes(EXT));
const { sessionId: ss } = await send("Target.attachToTarget",{targetId: sw.targetId, flatten:true});
const setDevice = (device, dtype) => ev(ss, `chrome.storage.local.get('settings').then(s => chrome.storage.local.set({settings: {...(s.settings||{}), device: ${JSON.stringify(device)}, dtype: ${JSON.stringify(dtype)}}}))`);
const getState = () => ev(ss, `chrome.runtime.sendMessage({target:'offscreen', type:'getState'}).then(r=>r.result)`);
await setDevice("wasm", "auto");
const t0 = Date.now(); let st, lastPct=-1;
while (Date.now()-t0 < 10*60*1000) { await sleep(700); st = await getState(); if (st.model.status==="loading" && st.model.progress.pct!==lastPct) { lastPct=st.model.progress.pct; console.log(`loading ${lastPct}% ${(st.model.progress.loaded/1048576).toFixed(0)}MB ${st.model.progress.file}`);} if (st.model.status==="ready" && st.model.device==="wasm") break; if (st.model.status==="error") break; }
console.log("model:", JSON.stringify({status: st.model.status, device: st.model.device, dtype: st.model.dtype, threads: st.model.threads, error: st.model.error, note: st.model.note}), `in ${((Date.now()-t0)/1000).toFixed(0)}s`);
for (let i=0;i<2;i++) { const r = await ev(ss, `chrome.runtime.sendMessage({target:'offscreen', type:'preview', voice:'af_heart', text:'This sentence was synthesized on the CPU with WebAssembly, as a fallback for machines without WebGPU.'}).then(r=>JSON.stringify(r))`); console.log("wasm preview:", r); }
// back to auto
await setDevice("auto", "auto");
const t1 = Date.now();
while (Date.now()-t1 < 5*60*1000) { await sleep(700); st = await getState(); if (st.model.status==="ready" && st.model.device==="webgpu") break; if (st.model.status==="error") break; }
console.log("back to:", st.model.device, st.model.dtype, st.model.status, `in ${((Date.now()-t1)/1000).toFixed(0)}s`);
console.log("errors:", errs.length ? errs : "none");
ws.close();
