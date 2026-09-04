// Thin Kokoro-82M wrapper on top of transformers.js. Based on kokoro-js (Apache-2.0) but with:
//  - voice style vectors loaded from the extension bundle (offline, instant)
//  - optional voice blending (weighted mix of two style vectors)
//  - trailing/leading silence trimming for gapless sentence playback
import { StyleTextToSpeech2Model, AutoTokenizer, Tensor, env } from "@huggingface/transformers";
import { phonemize } from "./phonemize.js";
import { SAMPLE_RATE, trimSilence } from "./audio.js";
export { SAMPLE_RATE, trimSilence, encodeWav } from "./audio.js";

export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const STYLE_DIM = 256;
const MAX_TOKENS = 509;

export class KokoroEngine {
  /**
   * @param {object} opts
   * @param {(id:string)=>Promise<ArrayBuffer>} opts.loadVoice loads a `<voice>.bin` style file
   * @param {string} [opts.wasmPaths] directory holding the onnxruntime wasm/mjs files
   */
  constructor({ loadVoice, wasmPaths }) {
    this.loadVoice = loadVoice;
    this.wasmPaths = wasmPaths;
    this.model = null;
    this.tokenizer = null;
    this.device = null;
    this.dtype = null;
    this.voiceCache = new Map();
  }

  static async webgpuAvailable() {
    try {
      if (typeof navigator === "undefined" || !navigator.gpu) return false;
      const adapter = await navigator.gpu.requestAdapter();
      return !!adapter;
    } catch {
      return false;
    }
  }

  /**
   * @param {{device:"webgpu"|"wasm"|"cpu", dtype:string, progress?:(p:any)=>void}} opts
   */
  async load({ device, dtype, progress }) {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = typeof caches !== "undefined";
    const wasmEnv = env.backends?.onnx?.wasm;
    if (wasmEnv && this.wasmPaths) wasmEnv.wasmPaths = this.wasmPaths;
    const hw = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1;
    if (wasmEnv) {
      wasmEnv.numThreads = typeof self !== "undefined" && self.crossOriginIsolated ? Math.max(1, Math.min(4, hw - 1)) : 1;
      wasmEnv.proxy = false;
    }

    const progress_callback = progress || null;
    const [model, tokenizer] = await Promise.all([
      StyleTextToSpeech2Model.from_pretrained(MODEL_ID, { dtype, device, progress_callback }),
      AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback }),
    ]);
    this.model = model;
    this.tokenizer = tokenizer;
    this.device = device;
    this.dtype = dtype;
  }

  get ready() {
    return !!this.model;
  }

  async dispose() {
    try {
      await this.model?.dispose?.();
    } catch {}
    this.model = null;
    this.tokenizer = null;
  }

  async getVoice(id) {
    if (this.voiceCache.has(id)) return this.voiceCache.get(id);
    const buf = await this.loadVoice(id);
    const arr = new Float32Array(buf);
    this.voiceCache.set(id, arr);
    return arr;
  }

  /**
   * @param {string} text
   * @param {{voice?:string, speed?:number, blendVoice?:string|null, blendRatio?:number}} opts
   * @returns {Promise<{audio: Float32Array, sampleRate: number, phonemes: string}>}
   */
  async generate(text, { voice = "af_heart", speed = 1, blendVoice = null, blendRatio = 0.5 } = {}) {
    if (!this.model) throw new Error("Model not loaded");
    const lang = voice.startsWith("b") ? "b" : "a";
    const phonemes = await phonemize(text, lang);
    if (!phonemes) return { audio: new Float32Array(0), sampleRate: SAMPLE_RATE, phonemes };

    const { input_ids } = this.tokenizer(phonemes, { truncation: true });
    const numTokens = Math.min(Math.max(input_ids.dims.at(-1) - 2, 0), MAX_TOKENS);
    const offset = numTokens * STYLE_DIM;

    let style = (await this.getVoice(voice)).slice(offset, offset + STYLE_DIM);
    if (blendVoice && blendVoice !== "none" && blendVoice !== voice && blendRatio > 0) {
      const other = (await this.getVoice(blendVoice)).slice(offset, offset + STYLE_DIM);
      const r = Math.min(1, Math.max(0, blendRatio));
      const mixed = new Float32Array(STYLE_DIM);
      for (let i = 0; i < STYLE_DIM; i++) mixed[i] = style[i] * (1 - r) + other[i] * r;
      style = mixed;
    }

    const inputs = {
      input_ids,
      style: new Tensor("float32", style, [1, STYLE_DIM]),
      speed: new Tensor("float32", [speed], [1]),
    };
    const { waveform } = await this.model(inputs);
    const audio = trimSilence(waveform.data instanceof Float32Array ? waveform.data : Float32Array.from(waveform.data));
    return { audio, sampleRate: SAMPLE_RATE, phonemes };
  }
}
