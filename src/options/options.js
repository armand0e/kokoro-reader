import { VOICES } from "../shared/voices.js";
import { getSettings, saveSettings } from "../shared/settings.js";

const $ = (s) => document.querySelector(s);
let settings;
let state;

function bg(msg) {
  return chrome.runtime.sendMessage({ target: "background", ...msg }).then((r) => {
    if (!r) throw new Error("No response");
    if (!r.ok) throw new Error(r.error || "Failed");
    return r.result;
  });
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2500);
}

function fmtMB(b) {
  return `${(b / 1048576).toFixed(0)} MB`;
}

function fillVoices(sel, includeNone) {
  sel.innerHTML = "";
  if (includeNone) {
    const o = document.createElement("option");
    o.value = "none";
    o.textContent = "None";
    sel.appendChild(o);
  }
  for (const gender of ["Female", "Male"]) {
    const og = document.createElement("optgroup");
    og.label = gender;
    for (const [id, v] of Object.entries(VOICES)) {
      if (v.gender !== gender) continue;
      const o = document.createElement("option");
      o.value = id;
      o.textContent = `${v.name} — ${v.accent} · grade ${v.grade}`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}

const RANGE_FMT = {
  speed: (v) => `${Number(v).toFixed(2).replace(/0$/, "")}×`,
  volume: (v) => `${Math.round(v * 100)}%`,
  sentenceGap: (v) => `${Math.round(v * 1000)} ms`,
  blendRatio: (v) => `${Math.round(v * 100)}% second voice`,
};

function bind(id, { type = "value", parse = (v) => v } = {}) {
  const el = $(`#${id}`);
  if (type === "checkbox") el.checked = !!settings[id];
  else el.value = String(settings[id]);
  if (RANGE_FMT[id]) $(`#${id}-val`).textContent = RANGE_FMT[id](settings[id]);
  const handler = async () => {
    const val = type === "checkbox" ? el.checked : parse(el.value);
    settings = await saveSettings({ [id]: val });
    if (RANGE_FMT[id]) $(`#${id}-val`).textContent = RANGE_FMT[id](val);
    afterChange(id);
  };
  el.addEventListener("change", handler);
  if (el.type === "range") el.addEventListener("input", () => RANGE_FMT[id] && ($(`#${id}-val`).textContent = RANGE_FMT[id](el.value)));
}

function afterChange(id) {
  if (id === "voice") $("#voice-tagline").textContent = VOICES[settings.voice]?.tagline || "";
  if (id === "blendVoice") $("#blend-ratio-field").style.opacity = settings.blendVoice === "none" ? 0.5 : 1;
}

function render() {
  if (!state) return;
  const m = state.model || {};
  const chip = $("#engine-chip");
  chip.className = "chip";
  if (m.status === "ready") chip.textContent = `${(m.device || "").toUpperCase()} · ${m.dtype} · ready`;
  else if (m.status === "loading") {
    chip.textContent = `Loading ${m.progress?.pct ?? 0}%`;
    chip.classList.add("warn");
  } else if (m.status === "error") {
    chip.textContent = "Engine error";
    chip.classList.add("err");
  } else {
    chip.textContent = "Model not loaded";
    chip.classList.add("warn");
  }
  let text;
  if (m.status === "ready") text = `Model loaded on ${(m.device || "").toUpperCase()} (${m.dtype}).${m.idleUnload ? ` Frees memory after ${m.idleUnload} min idle.` : ""}`;
  else if (m.status === "loading") {
    const p = m.progress || {};
    text = `Downloading… ${p.estimated ? `about ${p.pct}%` : `${p.pct ?? 0}%`} (${fmtMB(p.loaded || 0)}${p.total && !p.estimated ? ` of ${fmtMB(p.total)}` : ""})`;
  }
  else if (m.status === "error") text = `Error: ${m.error}`;
  else text = m.cached ? "Model not loaded (idle). It loads automatically when you start reading." : "Model not downloaded yet.";
  $("#model-text").textContent = text;
  $("#model-bar").style.width = `${m.status === "loading" ? m.progress?.pct ?? 0 : m.status === "ready" ? 100 : 0}%`;
  $("#model-note").textContent = m.note || "";
  $("#gpu-hint").textContent = m.webgpu === true ? "WebGPU is available on this device." : m.webgpu === false ? "WebGPU is not available here — WASM (CPU) will be used." : "";
  $("#btn-load").disabled = m.status === "loading" || m.status === "ready";
  $("#btn-unload").disabled = m.status !== "ready";
}

async function refreshCache() {
  try {
    const info = await bg({ type: "ui:cacheInfo" });
    if (info.error) $("#cache-text").textContent = `Browser storage unavailable — the model will be re-downloaded each session (${info.error})`;
    else $("#cache-text").textContent = info.entries ? `Cached model files: ${info.entries} (${fmtMB(info.bytes)})` : "No model files cached yet.";
  } catch (e) {
    $("#cache-text").textContent = "";
  }
}

async function init() {
  settings = await getSettings();
  fillVoices($("#voice"), false);
  fillVoices($("#blendVoice"), true);
  bind("voice");
  bind("blendVoice");
  bind("blendRatio", { parse: Number });
  bind("speed", { parse: Number });
  bind("volume", { parse: Number });
  bind("sentenceGap", { parse: Number });
  bind("extraction");
  bind("lookahead", { parse: Number });
  bind("headStart", { parse: Number });
  bind("highlight", { type: "checkbox" });
  bind("autoScroll", { type: "checkbox" });
  bind("miniPlayer", { type: "checkbox" });
  bind("readCode", { type: "checkbox" });
  bind("device");
  bind("dtype");
  bind("idleUnload", { parse: Number });
  afterChange("voice");
  afterChange("blendVoice");

  $("#btn-preview").addEventListener("click", async () => {
    const b = $("#btn-preview");
    b.disabled = true;
    try {
      await bg({ type: "ui:preview", voice: settings.voice, text: $("#preview-text").value });
    } catch (e) {
      toast(e.message);
    } finally {
      b.disabled = false;
    }
  });
  $("#btn-load").addEventListener("click", () => bg({ type: "ui:loadModel" }).catch((e) => toast(e.message)));
  $("#btn-reload").addEventListener("click", () => bg({ type: "ui:reloadModel" }).catch((e) => toast(e.message)));
  $("#btn-unload").addEventListener("click", async () => {
    try {
      await bg({ type: "ui:unloadModel" });
      const r = await bg({ type: "ui:getState" });
      state = r.state;
      render();
      toast("Model unloaded.");
    } catch (e) {
      toast(e.message);
    }
  });
  $("#btn-clear").addEventListener("click", async () => {
    if (!confirm("Delete the cached model files? They will be downloaded again the next time you read something.")) return;
    try {
      await bg({ type: "ui:clearCache" });
      toast("Model cache cleared.");
      refreshCache();
    } catch (e) {
      toast(e.message);
    }
  });
  $("#shortcuts-link").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === "popup" && msg.type === "state") {
      const wasReady = state?.model?.status === "ready";
      state = msg.state;
      render();
      if (!wasReady && state.model?.status === "ready") refreshCache();
    }
  });
  try {
    const r = await bg({ type: "ui:getState" });
    state = r.state || { model: { status: "unloaded" } };
  } catch (e) {
    state = { model: { status: "error", error: e.message } };
  }
  render();
  refreshCache();
}

init();
