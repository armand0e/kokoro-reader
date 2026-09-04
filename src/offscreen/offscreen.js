// Offscreen document: hosts the inference worker, owns the AudioContext and the playback queue.
// It only has access to chrome.runtime, so everything else is routed through the service worker.
import { DEFAULT_SETTINGS, resolveModelConfig } from "../shared/settings.js";
import { encodeWav, SAMPLE_RATE } from "../engine/audio.js";
import { toSpeechText } from "../shared/chunker.js";

const TARGET = "offscreen";
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

let settings = { ...DEFAULT_SETTINGS };
let webgpu = null; // null = unknown yet
let hwThreads = 1;

const model = {
  status: "unloaded", // unloaded | loading | ready | error
  device: null,
  dtype: null,
  error: null,
  note: null, // e.g. "WebGPU unavailable, using WASM"
  progress: { pct: 0, loaded: 0, total: 0, file: "" },
};
const fileProgress = new Map();

// ---------- worker RPC ----------
let nextId = 1;
const pending = new Map();
function call(msg, transfer) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
}
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "progress") {
    onProgress(m.progress);
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  if (m.type === "error") {
    pending.delete(m.id);
    p.reject(new Error(m.error));
  } else if (m.type === "cancelled") {
    pending.delete(m.id);
    p.reject(Object.assign(new Error("cancelled"), { cancelled: true }));
  } else {
    pending.delete(m.id);
    p.resolve(m);
  }
};
worker.onerror = (e) => {
  console.error("worker error", e);
  model.status = "error";
  model.error = e.message || "Worker crashed";
  emitState();
};

function onProgress(p) {
  if (!p || !p.file) return;
  if (p.status === "initiate" || p.status === "download" || p.status === "progress") {
    fileProgress.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
  } else if (p.status === "done") {
    const cur = fileProgress.get(p.file);
    if (cur) cur.loaded = cur.total || cur.loaded;
  }
  let loaded = 0;
  let total = 0;
  for (const f of fileProgress.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  model.progress = { pct: total ? Math.round((loaded / total) * 100) : 0, loaded, total, file: p.file };
  throttledEmit();
}

// ---------- model lifecycle ----------
let loadPromise = null;
async function ensureModel() {
  if (model.status === "ready") return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    model.status = "loading";
    model.error = null;
    fileProgress.clear();
    emitState();
    if (webgpu === null) {
      const probe = await call({ type: "probe" });
      webgpu = !!probe.webgpu;
      hwThreads = probe.threads || 1;
    }
    let { device, dtype } = resolveModelConfig(settings, webgpu);
    model.note = settings.device === "webgpu" && !webgpu ? "WebGPU not available on this device — using WASM (CPU)." : null;
    try {
      const r = await call({ type: "load", device, dtype });
      model.device = r.device;
      model.dtype = r.dtype;
    } catch (err) {
      if (device === "webgpu") {
        // Fall back to CPU inference rather than failing outright.
        console.warn("WebGPU load failed, falling back to wasm:", err);
        model.note = `WebGPU failed (${trimErr(err)}) — using WASM (CPU).`;
        fileProgress.clear();
        emitState();
        const r = await call({ type: "load", device: "wasm", dtype: settings.dtype === "auto" ? "q8" : dtype });
        model.device = r.device;
        model.dtype = r.dtype;
        webgpu = false;
      } else {
        throw err;
      }
    }
    model.status = "ready";
    model.progress = { ...model.progress, pct: 100 };
    emitState();
    // Warm up (compiles WebGPU shaders / JITs the wasm) so the first real sentence is instant.
    try {
      await call({ type: "generate", epoch: -1, text: "Ready.", options: { voice: settings.voice, speed: 1 } });
    } catch {}
  })();
  try {
    await loadPromise;
  } catch (err) {
    model.status = "error";
    model.error = trimErr(err);
    emitState();
    throw err;
  } finally {
    loadPromise = null;
  }
}

async function reloadModel() {
  if (loadPromise) await loadPromise.catch(() => {});
  stopSession("stopped");
  try {
    await call({ type: "dispose" });
  } catch {}
  model.status = "unloaded";
  model.device = null;
  model.dtype = null;
  webgpu = null;
  await ensureModel();
}

function trimErr(err) {
  const s = String(err?.message || err);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

// ---------- audio ----------
let ctx = null;
let gain = null;
function audioContext() {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    gain = ctx.createGain();
    gain.connect(ctx.destination);
  }
  gain.gain.value = settings.volume ?? 1;
  return ctx;
}

// ---------- playback session ----------
let session = null;
let epoch = 0;
const cache = new Map(); // key -> Float32Array

function voiceKey() {
  const blend = settings.blendVoice && settings.blendVoice !== "none" ? `+${settings.blendVoice}:${settings.blendRatio}` : "";
  return `${settings.voice}${blend}@${settings.speed}`;
}

function newSession({ tabId, chunks, startIndex, title }) {
  return {
    tabId,
    title: title || "",
    chunks, // [{text}]
    index: Math.min(Math.max(0, startIndex || 0), chunks.length - 1),
    status: "buffering", // buffering | playing | paused | ended | stopped
    sources: new Map(), // idx -> {src, startAt, duration}
    playhead: 0,
    scheduledUpTo: -1,
    pumping: false,
  };
}

async function play(payload) {
  stopSession("stopped", true); // notifies the previous tab so it clears its highlight
  session = newSession(payload);
  session.status = "buffering";
  emitState();
  try {
    await ensureModel();
  } catch (err) {
    session = null;
    emitState();
    return;
  }
  if (!session) return;
  await startFrom(session.index);
}

async function startFrom(index) {
  if (!session) return;
  epoch++;
  worker.postMessage({ type: "cancel", epoch: epoch - 1 });
  stopSources();
  const c = audioContext();
  if (c.state === "suspended") await c.resume().catch(() => {});
  session.index = index;
  session.playhead = c.currentTime + 0.02;
  session.scheduledUpTo = index - 1;
  session.status = session.sources.size ? "playing" : "buffering";
  emitState();
  pump();
}

function stopSources() {
  if (!session) return;
  for (const { src } of session.sources.values()) {
    try {
      src.onended = null;
      src.stop();
    } catch {}
  }
  session.sources.clear();
}

function stopSession(status = "stopped", emit = true) {
  if (!session) return;
  epoch++;
  worker.postMessage({ type: "cancel", epoch: epoch - 1 });
  stopSources();
  session.status = status;
  const s = session;
  session = null;
  cache.clear();
  if (emit) emitState({ endedSession: { tabId: s.tabId, status } });
}

async function ensureAudio(idx, myEpoch) {
  const key = `${idx}|${voiceKey()}`;
  if (cache.has(key)) return cache.get(key);
  const text = toSpeechText(session.chunks[idx].text);
  const r = await call({
    type: "generate",
    epoch: myEpoch,
    text,
    options: { voice: settings.voice, speed: settings.speed, blendVoice: settings.blendVoice, blendRatio: settings.blendRatio },
  });
  cache.set(key, r.audio);
  // Evict audio we've already played.
  if (session) {
    for (const k of cache.keys()) {
      const i = Number(k.split("|")[0]);
      if (i < session.index - 1) cache.delete(k);
    }
  }
  return r.audio;
}

async function pump() {
  if (!session || session.pumping) return;
  session.pumping = true;
  const myEpoch = epoch;
  const s = session;
  try {
    while (session === s && epoch === myEpoch) {
      const idx = s.scheduledUpTo + 1;
      if (idx >= s.chunks.length) break;
      if (idx - s.index > (settings.lookahead ?? 3)) break;
      let audio;
      try {
        audio = await ensureAudio(idx, myEpoch);
      } catch (err) {
        if (err?.cancelled || session !== s || epoch !== myEpoch) return;
        console.warn("generation failed for chunk", idx, err);
        audio = new Float32Array(0); // skip the chunk but keep going
      }
      if (session !== s || epoch !== myEpoch) return;
      scheduleChunk(idx, audio);
      s.scheduledUpTo = idx;
    }
  } finally {
    if (session === s) {
      s.pumping = false;
      // Someone (seek / voice change) bumped the epoch while we were awaiting → run again for the new epoch.
      if (epoch !== myEpoch) pump();
    }
  }
}

function scheduleChunk(idx, audio) {
  const s = session;
  const c = audioContext();
  const gap = settings.sentenceGap ?? 0.12;
  const len = Math.max(1, audio.length);
  const buffer = c.createBuffer(1, len, SAMPLE_RATE);
  if (audio.length) buffer.copyToChannel(audio, 0);
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(gain);
  const startAt = Math.max(s.playhead, c.currentTime + 0.005);
  const duration = buffer.duration;
  s.sources.set(idx, { src, startAt, duration });
  s.playhead = startAt + duration + gap;
  src.onended = () => {
    if (session !== s || s.sources.get(idx)?.src !== src) return;
    s.sources.delete(idx);
    onChunkEnded(idx);
  };
  src.start(startAt);
  if (idx === s.index) {
    s.status = c.state === "running" ? "playing" : "paused";
    emitState();
  }
}

function onChunkEnded(idx) {
  const s = session;
  if (!s) return;
  const next = idx + 1;
  if (next >= s.chunks.length) {
    s.status = "ended";
    const ended = s;
    session = null;
    cache.clear();
    emitState({ endedSession: { tabId: ended.tabId, status: "ended" } });
    return;
  }
  s.index = next;
  s.status = s.sources.has(next) ? (ctx?.state === "running" ? "playing" : "paused") : "buffering";
  emitState();
  pump();
}

async function pause() {
  if (!session || !ctx) return;
  await ctx.suspend();
  session.status = "paused";
  emitState();
}

async function resume() {
  if (!session || !ctx) return;
  await ctx.resume();
  session.status = session.sources.has(session.index) ? "playing" : "buffering";
  emitState();
  pump();
}

async function toggle() {
  if (!session) return;
  if (session.status === "paused") return resume();
  return pause();
}

function seek(delta) {
  if (!session) return;
  const target = Math.min(session.chunks.length - 1, Math.max(0, session.index + delta));
  if (ctx?.state === "suspended") ctx.resume().catch(() => {});
  startFrom(target);
}

function seekTo(index) {
  if (!session) return;
  if (ctx?.state === "suspended") ctx.resume().catch(() => {});
  startFrom(Math.min(session.chunks.length - 1, Math.max(0, index)));
}

/** Voice/speed changed: keep the sentence currently playing, regenerate everything after it. */
function applyVoiceChange() {
  if (!session) return;
  const s = session;
  epoch++;
  worker.postMessage({ type: "cancel", epoch: epoch - 1 });
  const current = s.sources.get(s.index);
  for (const [idx, entry] of [...s.sources]) {
    if (idx !== s.index) {
      try {
        entry.src.onended = null;
        entry.src.stop();
      } catch {}
      s.sources.delete(idx);
    }
  }
  const c = audioContext();
  s.playhead = current ? current.startAt + current.duration + (settings.sentenceGap ?? 0.12) : c.currentTime + 0.02;
  s.scheduledUpTo = s.index;
  if (!current) {
    // nothing is playing right now → restart the current sentence with the new voice
    s.scheduledUpTo = s.index - 1;
  }
  pump();
}

// ---------- preview ----------
let previewSrc = null;
async function preview({ voice, text }) {
  await ensureModel();
  const sample = text || "Hi there! This is how I sound. I can read any web page for you, right here in your browser.";
  const r = await call({
    type: "generate",
    epoch: -1,
    text: sample,
    options: { voice: voice || settings.voice, speed: settings.speed, blendVoice: settings.blendVoice, blendRatio: settings.blendRatio },
  });
  const c = audioContext();
  if (c.state === "suspended") await c.resume().catch(() => {});
  if (previewSrc) {
    try {
      previewSrc.stop();
    } catch {}
  }
  const buffer = c.createBuffer(1, Math.max(1, r.audio.length), SAMPLE_RATE);
  if (r.audio.length) buffer.copyToChannel(r.audio, 0);
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(gain);
  src.start();
  previewSrc = src;
  return { ok: true, ms: r.ms };
}

// ---------- WAV export ----------
let exportJob = null;
async function exportWav({ chunks, filename, saveAs = true }) {
  if (exportJob) throw new Error("An export is already running");
  exportJob = { index: 0, total: chunks.length, cancelled: false };
  emitState();
  try {
    await ensureModel();
    const parts = [];
    let totalLen = 0;
    const gap = new Float32Array(Math.round(SAMPLE_RATE * (settings.sentenceGap ?? 0.12)));
    for (let i = 0; i < chunks.length; i++) {
      if (exportJob.cancelled) throw new Error("Export cancelled");
      const r = await call({
        type: "generate",
        epoch: -1,
        text: toSpeechText(chunks[i].text),
        options: { voice: settings.voice, speed: settings.speed, blendVoice: settings.blendVoice, blendRatio: settings.blendRatio },
      });
      parts.push(r.audio, gap);
      totalLen += r.audio.length + gap.length;
      exportJob.index = i + 1;
      throttledEmit();
    }
    const all = new Float32Array(totalLen);
    let off = 0;
    for (const p of parts) {
      all.set(p, off);
      off += p.length;
    }
    const blob = new Blob([encodeWav(all)], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    await chrome.runtime.sendMessage({ target: "background", type: "download", url, filename, saveAs });
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return { ok: true, seconds: totalLen / SAMPLE_RATE };
  } finally {
    exportJob = null;
    emitState();
  }
}

// ---------- cache management ----------
async function cacheInfo() {
  const out = { entries: 0, bytes: 0 };
  try {
    const c = await caches.open("transformers-cache");
    const keys = await c.keys();
    for (const req of keys) {
      const res = await c.match(req);
      if (!res) continue;
      out.entries++;
      const len = Number(res.headers.get("content-length"));
      if (len) out.bytes += len;
      else out.bytes += (await res.clone().arrayBuffer()).byteLength;
    }
  } catch (e) {
    out.error = String(e);
  }
  return out;
}
async function clearCache() {
  stopSession("stopped");
  try {
    await call({ type: "dispose" });
  } catch {}
  model.status = "unloaded";
  model.device = null;
  model.dtype = null;
  await caches.delete("transformers-cache");
  emitState();
  return { ok: true };
}

// ---------- state broadcasting ----------
function publicState(extra) {
  return {
    model: { ...model, webgpu, threads: hwThreads },
    session: session
      ? {
          tabId: session.tabId,
          title: session.title,
          index: session.index,
          total: session.chunks.length,
          status: session.status,
          text: session.chunks[session.index]?.text || "",
        }
      : null,
    export: exportJob ? { index: exportJob.index, total: exportJob.total } : null,
    settings: { voice: settings.voice, speed: settings.speed },
    ...extra,
  };
}
function emitState(extra) {
  chrome.runtime.sendMessage({ target: "background", type: "state", state: publicState(extra) }).catch(() => {});
}
let emitTimer = null;
function throttledEmit() {
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    emitState();
  }, 120);
}

// ---------- message handling ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== TARGET) return false;
  handle(msg)
    .then((r) => sendResponse({ ok: true, result: r }))
    .catch((err) => sendResponse({ ok: false, error: trimErr(err) }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case "settings": {
      const prev = settings;
      settings = { ...DEFAULT_SETTINGS, ...msg.settings };
      if (gain) gain.gain.value = settings.volume ?? 1;
      const modelChanged = prev.device !== settings.device || prev.dtype !== settings.dtype;
      const voiceChanged =
        prev.voice !== settings.voice || prev.speed !== settings.speed || prev.blendVoice !== settings.blendVoice || prev.blendRatio !== settings.blendRatio;
      if (modelChanged && model.status !== "unloaded") await reloadModel();
      else if (voiceChanged) applyVoiceChange();
      emitState();
      return;
    }
    case "preload":
      if (msg.settings) settings = { ...DEFAULT_SETTINGS, ...msg.settings };
      ensureModel().catch(() => {});
      return;
    case "play":
      if (msg.settings) settings = { ...DEFAULT_SETTINGS, ...msg.settings };
      await play(msg);
      return;
    case "pause":
      return pause();
    case "resume":
      return resume();
    case "toggle":
      return toggle();
    case "stop":
      return stopSession("stopped");
    case "next":
      return seek(+1);
    case "prev":
      return seek(-1);
    case "seekTo":
      return seekTo(msg.index);
    case "getState":
      return publicState();
    case "preview":
      return preview(msg);
    case "exportWav":
      return exportWav(msg);
    case "cancelExport":
      if (exportJob) exportJob.cancelled = true;
      return;
    case "cacheInfo":
      return cacheInfo();
    case "clearCache":
      return clearCache();
    case "reloadModel":
      return reloadModel();
    case "ping":
      return "pong";
    default:
      throw new Error(`Unknown offscreen message: ${msg.type}`);
  }
}

// Let the service worker know we're alive (it will push settings and maybe ask for a preload).
chrome.runtime.sendMessage({ target: "background", type: "offscreenReady" }).catch(() => {});
