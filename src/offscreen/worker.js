// Inference worker: owns the Kokoro model so synthesis never blocks audio scheduling.
import { KokoroEngine } from "../engine/kokoro.js";

const base = new URL("../", self.location.href).href; // extension root

// transformers.js warns when the Hugging Face CDN omits content-length; harmless, and we handle unknown sizes ourselves.
const _warn = console.warn.bind(console);
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].includes("Unable to determine content-length")) return;
  _warn(...args);
};
const engine = new KokoroEngine({
  loadVoice: async (id) => {
    const res = await fetch(new URL(`voices/${id}.bin`, base));
    if (!res.ok) throw new Error(`Voice "${id}" not bundled (${res.status})`);
    return res.arrayBuffer();
  },
  wasmPaths: new URL("ort/", base).href,
});

let loading = null;
let queue = Promise.resolve();
const cancelled = new Set(); // generation epochs whose queued jobs should be skipped

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case "probe": {
        post({ type: "probe", id: m.id, webgpu: await KokoroEngine.webgpuAvailable(), threads: self.crossOriginIsolated ? navigator.hardwareConcurrency : 1 });
        break;
      }
      case "load": {
        if (engine.ready && engine.device === m.device && engine.dtype === m.dtype) {
          post({ type: "loaded", id: m.id, device: engine.device, dtype: engine.dtype });
          break;
        }
        if (loading) await loading.catch(() => {});
        if (engine.ready) await engine.dispose();
        loading = engine.load({
          device: m.device,
          dtype: m.dtype,
          progress: (p) => post({ type: "progress", id: m.id, progress: p }),
        });
        try {
          await loading;
          post({ type: "loaded", id: m.id, device: engine.device, dtype: engine.dtype });
        } finally {
          loading = null;
        }
        break;
      }
      case "generate": {
        const { id, epoch, text, options } = m;
        queue = queue
          .then(async () => {
            if (cancelled.has(epoch)) {
              post({ type: "cancelled", id });
              return;
            }
            const t0 = performance.now();
            const { audio, sampleRate, phonemes } = await engine.generate(text, options);
            // copy() so the transferred buffer has no leftover bytes from the original tensor storage
            const out = audio.slice();
            post({ type: "audio", id, audio: out, sampleRate, phonemes, ms: Math.round(performance.now() - t0) }, [out.buffer]);
          })
          .catch((err) => post({ type: "error", id, error: String(err?.message || err) }));
        break;
      }
      case "cancel": {
        cancelled.add(m.epoch);
        // keep the set small
        if (cancelled.size > 50) cancelled.delete(cancelled.values().next().value);
        break;
      }
      case "dispose": {
        await engine.dispose();
        post({ type: "disposed", id: m.id });
        break;
      }
    }
  } catch (err) {
    post({ type: "error", id: m.id, error: String(err?.message || err), fatal: m.type === "load" });
  }
};

post({ type: "ready" });
