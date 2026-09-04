// End-to-end test against a real Chrome with the unpacked extension loaded, driven over the DevTools protocol.
// Prereqs: chrome started with --remote-debugging-port=9222 --load-extension=dist, and a static server on :8765 serving test/page.
import { writeFile, mkdir } from "node:fs/promises";

const CDP_PORT = process.env.CDP_PORT || 9222;
const PAGE_URL = process.env.PAGE_URL || "http://127.0.0.1:8765/article.html";
const OUT = "test/out";
await mkdir(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- minimal CDP client ----------
const version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json());
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let msgId = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(`${m.error.message} ${m.error.data || ""}`));
    else resolve(m.result);
  } else if (m.method) {
    for (const l of listeners) l(m);
  }
};
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
function on(fn) {
  listeners.push(fn);
}

const consoleErrors = [];
on((m) => {
  if (m.method === "Runtime.exceptionThrown") consoleErrors.push(`[${m.sessionId?.slice(0, 6)}] EXC ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description || ""}`);
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
    consoleErrors.push(`[${m.sessionId?.slice(0, 6)}] ${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
  }
});

async function attach(targetId) {
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  return sessionId;
}
async function evaluate(sessionId, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ""}\n${expression.slice(0, 200)}`);
  return r.result.value;
}

// ---------- find the extension ----------
await send("Target.setDiscoverTargets", { discover: true });
let ext = null;
for (let i = 0; i < 40 && !ext; i++) {
  const { targetInfos } = await send("Target.getTargets");
  ext = targetInfos.find((t) => t.url.includes("/offscreen/offscreen.html"));
  if (!ext) {
    for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.endsWith("/background.js"))) {
      try {
        const s = await attach(t.targetId);
        const name = await evaluate(s, `chrome.runtime.getManifest().short_name`);
        await send("Target.detachFromTarget", { sessionId: s });
        if (name === "Kokoro Reader") {
          ext = t;
          break;
        }
      } catch {}
    }
  }
  if (!ext) await sleep(500);
}
if (!ext) throw new Error("extension targets not found — is Chrome running with --load-extension?");
const EXT_ID = new URL(ext.url).host;
log("extension id", EXT_ID);

async function swSession() {
  // The service worker may be asleep; poke it by opening a runtime page if needed.
  for (let i = 0; i < 30; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(EXT_ID));
    if (sw) return attach(sw.targetId);
    await sleep(300);
  }
  throw new Error("service worker not running");
}
let sw = await swSession();
const inSW = async (expr) => {
  try {
    return await evaluate(sw, expr);
  } catch (e) {
    if (/Session with given id not found|Target closed/i.test(e.message)) {
      sw = await swSession();
      return evaluate(sw, expr);
    }
    throw e;
  }
};

// Deterministic settings for the run (also repairs leftovers from an aborted run).
await inSW(`chrome.storage.local.set({settings: {}})`);
log("engine start reason so far:", JSON.stringify(await inSW(`chrome.storage.session.get('engineStart').then(r => r.engineStart)`)));

// Attach to offscreen document for console capture (may not exist yet).
async function attachOffscreen() {
  const { targetInfos } = await send("Target.getTargets");
  const off = targetInfos.find((t) => t.url.includes(`${EXT_ID}/offscreen`));
  if (off) {
    const s = await attach(off.targetId);
    log("attached offscreen document");
    return s;
  }
  return null;
}
let offSession = await attachOffscreen();

// ---------- open the test page ----------
const { targetId: pageTarget } = await send("Target.createTarget", { url: PAGE_URL });
const page = await attach(pageTarget);
await send("Page.enable", {}, page);
await sleep(1500);
const tabId = await inSW(`chrome.tabs.query({url: ${JSON.stringify(PAGE_URL.replace(/\/[^/]*$/, "/*"))}}).then(t => t[0]?.id)`);
if (!tabId) throw new Error("tab id not found");
log("tab id", tabId);
await send("Target.activateTarget", { targetId: pageTarget });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  log(ok ? "PASS" : "FAIL", name, detail);
}

const toTab = (msg) => inSW(`chrome.tabs.sendMessage(${tabId}, ${JSON.stringify(msg)})`);
const toOffscreen = (msg) => inSW(`chrome.runtime.sendMessage({target:'offscreen', ...${JSON.stringify(msg)}})`);
const getState = async () => (await toOffscreen({ type: "getState" }))?.result;

// 1. content script alive
const info = await toTab({ type: "cs:pageInfo" });
check("content script responds", info?.ok === true && typeof info.title === "string", JSON.stringify(info));

// 2. extraction
const smart = await toTab({ type: "cs:getChunks", mode: "smart" });
const texts = (smart?.chunks || []).map((c) => c.text);
await writeFile(`${OUT}/chunks-smart.json`, JSON.stringify(texts, null, 2));
const joined = texts.join("\n");
check("smart extraction has article text", joined.includes("Speech synthesis is the artificial production of human speech"), `${texts.length} chunks`);
check("smart extraction skips nav", !joined.includes("Home") || !joined.includes("World"), "");
check("smart extraction skips sidebar", !joined.includes("Sidebar content"));
check("smart extraction skips footer", !joined.includes("© 2026"));
check("skips sr-only text", !joined.includes("Skip to main content"));
check("skips display:none text", !joined.includes("must not be read"));
check("skips <pre> by default", !joined.includes("from_pretrained"));
check("scroller paragraphs included", joined.includes("scrollable container"));
check("list items included", joined.includes("Voder at the World's Fair"));
check("heading is its own chunk", texts.includes("The History of Speech Synthesis"));
const all = await toTab({ type: "cs:getChunks", mode: "all" });
check("all-mode includes sidebar", (all?.chunks || []).some((c) => c.text.includes("Sidebar content")), `${all?.chunks?.length} chunks`);

// 3. start reading & wait for the model
log("starting readPage…");
const startRes = await toTab({ type: "cs:readPage" });
check("readPage accepted", startRes?.ok === true, JSON.stringify(startRes));
if (!offSession) {
  await sleep(1000);
  offSession = await attachOffscreen();
}
let st = null;
let lastPct = -1;
const t0 = Date.now();
while (Date.now() - t0 < 15 * 60 * 1000) {
  st = await getState();
  if (!st) {
    await sleep(500);
    continue;
  }
  if (st.model.status === "loading" && st.model.progress.pct !== lastPct) {
    lastPct = st.model.progress.pct;
    log(`model loading ${lastPct}% (${(st.model.progress.loaded / 1048576).toFixed(0)} MB) file=${st.model.progress.file}`);
  }
  if (st.model.status === "error") break;
  if (st.session?.status === "playing") break;
  if (!st.session && st.model.status === "ready") break;
  await sleep(700);
}
log("model:", JSON.stringify({ status: st?.model.status, device: st?.model.device, dtype: st?.model.dtype, note: st?.model.note, error: st?.model.error, webgpu: st?.model.webgpu, threads: st?.model.threads }));
check("model loaded", st?.model.status === "ready", `${st?.model.device} ${st?.model.dtype} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
check("playback started", st?.session?.status === "playing", JSON.stringify(st?.session));

// audio context actually running?
if (offSession) {
  const acState = await evaluate(offSession, `(async()=>{ try { const c = new AudioContext(); const s = c.state; await c.close(); return s; } catch(e) { return 'err:'+e.message } })()`);
  check("AudioContext can run in offscreen doc (autoplay ok)", acState === "running", acState);
}

// 3b. head start: the first sentences were synthesized before playback; the transition 0→1→2 must never show "buffering".
let sawBuffering = false;
{
  const tB = Date.now();
  while (Date.now() - tB < 30000) {
    await sleep(150);
    const s2 = await getState();
    if (!s2?.session) break;
    if (s2.session.index >= 2) break;
    if (s2.session.status === "buffering" && s2.session.index > 0) sawBuffering = true;
  }
}
check("prebuffer keeps first sentences gapless", !sawBuffering);

// 4. progression: wait for the index to advance
let firstIdx = st?.session?.index ?? 0;
let advanced = false;
const t1 = Date.now();
while (Date.now() - t1 < 60000) {
  await sleep(1000);
  st = await getState();
  if (!st?.session) break;
  if (st.session.index >= firstIdx + 2) {
    advanced = true;
    break;
  }
}
check("playback advances through sentences", advanced, `index ${st?.session?.index} of ${st?.session?.total} after ${((Date.now() - t1) / 1000).toFixed(0)}s`);

// screenshot with highlight + mini player
await sleep(300);
const shot = await send("Page.captureScreenshot", { format: "png" }, page);
await writeFile(`${OUT}/reading.png`, Buffer.from(shot.data, "base64"));
const hl = await evaluate(page, `CSS.highlights ? [...CSS.highlights.keys()].join(',') : 'no-api'`);
check("CSS highlights active", hl.includes("kokoro-reader-current"), hl);
const player = await evaluate(page, `!!document.querySelector('kokoro-reader-ui')`);
check("mini player mounted", player);

// 5. pause / resume / next / prev
await toOffscreen({ type: "pause" });
await sleep(1200);
st = await getState();
const pausedIdx = st?.session?.index;
check("pause", st?.session?.status === "paused", JSON.stringify(st?.session?.status));
await sleep(2000);
st = await getState();
check("index stays while paused", st?.session?.index === pausedIdx);
await toOffscreen({ type: "resume" });
await sleep(800);
st = await getState();
check("resume", ["playing", "buffering"].includes(st?.session?.status), st?.session?.status);
const beforeNext = st?.session?.index;
await toOffscreen({ type: "next" });
await sleep(1500);
st = await getState();
check("next sentence", st?.session?.index === beforeNext + 1, `${beforeNext} → ${st?.session?.index} (${st?.session?.status})`);
await toOffscreen({ type: "prev" });
await sleep(1500);
st = await getState();
check("prev sentence", st?.session?.index === beforeNext, `${st?.session?.index} (${st?.session?.status})`);

// 6. speed / voice change mid-play via settings
await inSW(`chrome.storage.local.get('settings').then(s => chrome.storage.local.set({settings: {...(s.settings||{}), speed: 1.3, voice: 'am_michael'}}))`);
await sleep(2500);
st = await getState();
check("voice/speed change keeps playing", ["playing", "buffering"].includes(st?.session?.status) && st?.settings?.voice === "am_michael", JSON.stringify(st?.settings));
const speedShown = await evaluate(page, `(()=>{ const h=document.querySelector('kokoro-reader-ui'); return h ? 'host-closed' : 'no-host'; })()`);
check("mini player present during speed change", speedShown === "host-closed", speedShown);
await inSW(`chrome.storage.local.get('settings').then(s => chrome.storage.local.set({settings: {...(s.settings||{}), speed: 1, voice: 'af_heart'}}))`);

// 7. stop
await toOffscreen({ type: "stop" });
await sleep(800);
st = await getState();
check("stop clears session", !st?.session);
const hlAfter = await evaluate(page, `CSS.highlights ? [...CSS.highlights.keys()].join(',') : ''`);
check("highlight cleared after stop", !hlAfter.includes("kokoro-reader-current"), hlAfter);

// 8. selection reading
await evaluate(page, `(()=>{ const p=document.querySelector('.scroller p'); const s=getSelection(); s.removeAllRanges(); s.selectAllChildren(p); return s.toString().slice(0,40); })()`);
const selRes = await toTab({ type: "cs:readSelection" });
await sleep(1500);
st = await getState();
check("read selection", selRes?.ok === true && st?.session?.total >= 1 && st.session.total <= 2 && st.session.text.includes("scrollable container"), JSON.stringify(st?.session));
await toOffscreen({ type: "stop" });
await evaluate(page, `getSelection().removeAllRanges()`);

// 9. element picker via synthetic mouse events
await toTab({ type: "cs:pick" });
await sleep(300);
const bq = await evaluate(page, `(()=>{ const r=document.querySelector('blockquote').getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; })()`);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bq.x, y: bq.y }, page);
await sleep(200);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bq.x + 2, y: bq.y + 1 }, page);
await sleep(200);
const overlayLabel = await evaluate(page, `document.querySelector('.kokoro-reader-pick-label')?.textContent || ''`);
check("picker overlay shows target", overlayLabel.includes("<blockquote"), overlayLabel);
const pickShot = await send("Page.captureScreenshot", { format: "png" }, page);
await writeFile(`${OUT}/picker.png`, Buffer.from(pickShot.data, "base64"));
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: bq.x + 2, y: bq.y + 1, button: "left", clickCount: 1 }, page);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: bq.x + 2, y: bq.y + 1, button: "left", clickCount: 1 }, page);
await sleep(1500);
st = await getState();
check("picked element is read", st?.session && st.session.text.includes("The Voder was the first attempt"), JSON.stringify(st?.session));
const pickerGone = await evaluate(page, `!document.querySelector('.kokoro-reader-pick-overlay')`);
check("picker overlay removed after pick", pickerGone);
await toOffscreen({ type: "stop" });

// 10. read from here (context click position on the "Neural text-to-speech" heading)
const h2 = await evaluate(page, `(()=>{ const h=[...document.querySelectorAll('h2')].find(h=>h.textContent.includes('Neural')); h.scrollIntoView(); const r=h.getBoundingClientRect(); return {x:r.left+10, y:r.top+r.height/2}; })()`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: h2.x, y: h2.y, button: "right", clickCount: 1 }, page);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: h2.x, y: h2.y, button: "right", clickCount: 1 }, page);
await sleep(300);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, page);
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, page);
await toTab({ type: "cs:readFromHere" });
await sleep(1500);
st = await getState();
check("read from here starts at clicked heading", st?.session && st.session.text.startsWith("Neural text-to-speech"), JSON.stringify(st?.session?.text));
await toOffscreen({ type: "stop" });

// 11. preview
const pv = await toOffscreen({ type: "preview", voice: "bf_emma", text: "Hello from Emma." });
check("voice preview", pv?.ok === true, JSON.stringify(pv));

// 12. popup & options render
const { targetId: popupTarget } = await send("Target.createTarget", { url: `chrome-extension://${EXT_ID}/popup/popup.html` });
const popup = await attach(popupTarget);
await sleep(1200);
const popupChip = await evaluate(popup, `document.querySelector('#engine-chip')?.textContent`);
const popupVoices = await evaluate(popup, `[...document.querySelectorAll('#voice option')].map(o=>o.value).join(',')`);
check("popup renders engine status", /ready/i.test(popupChip || ""), popupChip);
check("popup lists 6 voices", popupVoices === "af_heart,af_bella,bf_emma,am_michael,am_fenrir,am_puck", popupVoices);
const cancelDisplay = await evaluate(popup, `getComputedStyle(document.querySelector('#btn-cancel-export')).display`);
check("popup hides Cancel button when not exporting", cancelDisplay === "none", cancelDisplay);
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 1, mobile: false }, popup);
const popShot = await send("Page.captureScreenshot", { format: "png" }, popup);
await writeFile(`${OUT}/popup.png`, Buffer.from(popShot.data, "base64"));
await send("Target.closeTarget", { targetId: popupTarget });

const { targetId: optTarget } = await send("Target.createTarget", { url: `chrome-extension://${EXT_ID}/options/options.html` });
const opt = await attach(optTarget);
await sleep(1500);
const optText = await evaluate(opt, `document.querySelector('#model-text')?.textContent + ' | ' + document.querySelector('#cache-text')?.textContent`);
check("options page shows model + cache", /loaded/i.test(optText) && /Cached model files/.test(optText), optText);
const optShot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, opt);
await writeFile(`${OUT}/options.png`, Buffer.from(optShot.data, "base64"));
await send("Target.closeTarget", { targetId: optTarget });

// 13. cache info
const ci = await toOffscreen({ type: "cacheInfo" });
check("model cached in Cache Storage", ci?.result?.entries > 0, JSON.stringify(ci?.result));

// 14. WAV export → chrome.downloads (download dir redirected to test/out, no Save-As dialog)
const dlDir = new URL(`../${OUT}/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\");
await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir, eventsEnabled: true });
let dlDone = null;
on((m) => {
  if (m.method === "Browser.downloadProgress" && m.params.state !== "inProgress") dlDone = m.params;
});
const exportStartedAt = Date.now() - 1000;
const ex = await toOffscreen({ type: "exportWav", chunks: [{ text: "This is a short export test." }, { text: "Second sentence." }], filename: "kokoro-e2e-export.wav", saveAs: false });
let dlItem = null;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  // DevTools' download override renames files to a GUID, so match on the blob: URL + completion instead of the filename.
  const items = await inSW(`chrome.downloads.search({orderBy: ['-startTime'], limit: 3}).then(d => d.map(x => ({state: x.state, error: x.error, filename: x.filename, bytes: x.totalBytes, url: x.url.slice(0, 30), start: x.startTime})))`);
  dlItem = (items || []).find((x) => x.url.startsWith("blob:") && new Date(x.start).getTime() > exportStartedAt) || null;
  if (dlItem && dlItem.state !== "in_progress") break;
}
const { existsSync, statSync } = await import("node:fs");
const wavPath = dlItem?.filename;
const wavOk = !!wavPath && existsSync(wavPath) && statSync(wavPath).size > 44;
check("WAV export downloads a file", ex?.ok === true && dlItem?.state === "complete" && wavOk, JSON.stringify({ ex: ex?.result, dl: dlItem, size: wavOk ? statSync(wavPath).size : 0 }));

// 15. idle unload: with a 1-minute idle setting the engine must dispose the model and close its document, then reload on demand.
await inSW(`chrome.storage.local.get('settings').then(s => chrome.storage.local.set({settings: {...(s.settings||{}), idleUnload: 1}}))`);
await toOffscreen({ type: "stop" });
let unloaded = false;
const tI = Date.now();
while (Date.now() - tI < 150000) {
  await sleep(2000);
  const has = await inSW(`chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(c => c.length)`);
  if (has === 0) {
    unloaded = true;
    break;
  }
}
const cachedAfter = await inSW(`caches.open('transformers-cache').then(c => c.keys()).then(k => k.some(x => /\.onnx/.test(x.url)))`);
check("engine unloads and closes when idle", unloaded && cachedAfter === true, `${((Date.now() - tI) / 1000).toFixed(0)}s, cached=${cachedAfter}`);
// popup while idle must not spin the engine back up
const { targetId: popup2 } = await send("Target.createTarget", { url: `chrome-extension://${EXT_ID}/popup/popup.html` });
const popupS2 = await attach(popup2);
await sleep(1200);
const chipIdle = await evaluate(popupS2, `document.querySelector('#engine-chip')?.textContent`);
const stillClosed = await inSW(`chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(c => c.length)`);
check("popup shows idle state without starting the engine", /idle/i.test(chipIdle || "") && stillClosed === 0, `${chipIdle} / contexts=${stillClosed}`);
await send("Target.closeTarget", { targetId: popup2 });
// reading again reloads on demand
const { targetId: pageTarget2 } = await send("Target.createTarget", { url: PAGE_URL });
await sleep(1500);
const tabId2 = await inSW(`chrome.tabs.query({url: ${JSON.stringify(PAGE_URL.replace(/\/[^/]*$/, "/*"))}}).then(t => t.at(-1)?.id)`);
await inSW(`chrome.tabs.sendMessage(${tabId2}, {type:'cs:readPage'})`);
let reloaded = null;
const tR = Date.now();
while (Date.now() - tR < 60000) {
  await sleep(700);
  reloaded = await getState();
  if (reloaded?.session?.status === "playing") break;
}
check("reading after idle reloads the model on demand", reloaded?.session?.status === "playing" && reloaded?.model?.status === "ready", `${((Date.now() - tR) / 1000).toFixed(1)}s ${reloaded?.model?.device}`);
await toOffscreen({ type: "stop" });
await send("Target.closeTarget", { targetId: pageTarget2 });
await inSW(`chrome.storage.local.get('settings').then(s => chrome.storage.local.set({settings: {...(s.settings||{}), idleUnload: 5}}))`);

// ---------- summary ----------
await send("Target.closeTarget", { targetId: pageTarget });
console.log("\n==== RESULTS ====");
for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
if (consoleErrors.length) {
  console.log("\n==== console errors/warnings ====");
  for (const e of [...new Set(consoleErrors)].slice(0, 40)) console.log(e);
}
ws.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
