import { DEFAULT_VOICE } from "./voices.js";

export const DEFAULT_SETTINGS = {
  voice: DEFAULT_VOICE,
  blendVoice: "none", // optional second voice to blend with
  blendRatio: 0.5, // 0 = only primary voice, 1 = only blend voice
  speed: 1.0, // 0.5 – 2.0 (Kokoro's native speed parameter)
  volume: 1.0,
  device: "auto", // auto | webgpu | wasm
  dtype: "auto", // auto | fp32 | fp16 | q8 | q4 | q4f16
  preload: true, // load the model when the browser starts so reading is instant
  highlight: true, // highlight the sentence being read
  autoScroll: true,
  miniPlayer: true, // floating in-page player
  extraction: "smart", // smart (main article) | all (everything visible)
  readCode: false, // include <pre>/<code> blocks
  lookahead: 3, // sentences to synthesize ahead of playback
  sentenceGap: 0.12, // seconds of silence between sentences
};

const KEY = "settings";

export async function getSettings() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) {
      callback({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue || {}) });
    }
  });
}

/** Resolve "auto" device/dtype into concrete values. */
export function resolveModelConfig(settings, webgpuAvailable) {
  let device = settings.device;
  if (device === "auto") device = webgpuAvailable ? "webgpu" : "wasm";
  if (device === "webgpu" && !webgpuAvailable) device = "wasm";
  let dtype = settings.dtype;
  if (dtype === "auto") dtype = device === "webgpu" ? "fp32" : "q8";
  return { device, dtype };
}
