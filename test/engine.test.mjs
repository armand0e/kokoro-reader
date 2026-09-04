// Smoke test for the engine on Node (CPU). Downloads the q8 model (~90 MB) into ./test/.cache on first run.
// Usage: node test/engine.test.mjs [voice] [dtype]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "@huggingface/transformers";
import { KokoroEngine, encodeWav, SAMPLE_RATE } from "../src/engine/kokoro.js";
import { phonemize } from "../src/engine/phonemize.js";
import { chunkText, toSpeechText } from "../src/shared/chunker.js";

const voice = process.argv[2] || "af_heart";
const dtype = process.argv[3] || "q8";

env.cacheDir = path.resolve("test/.cache");

console.log("phonemes:", await phonemize("Dr. Smith paid $5.50 at 3:30 for 2 kokoro tickets.", "a"));

const engine = new KokoroEngine({
  loadVoice: (id) => readFile(path.resolve(`node_modules/kokoro-js/voices/${id}.bin`)).then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
});

let lastFile = "";
const t0 = performance.now();
await engine.load({
  device: "cpu",
  dtype,
  progress: (p) => {
    if (p.status === "progress" && p.file !== lastFile) {
      lastFile = p.file;
      console.log("downloading", p.file);
    }
  },
});
console.log(`model loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const text =
  "Kokoro is an open-weight text to speech model with 82 million parameters. Despite its lightweight architecture, it delivers comparable quality to larger models while being significantly faster. This Chrome extension runs it entirely on your device!";
const chunks = chunkText(text);
console.log(`${chunks.length} chunks`);
const parts = [];
for (const c of chunks) {
  const t1 = performance.now();
  const { audio, phonemes } = await engine.generate(toSpeechText(c.text), { voice, speed: 1 });
  const secs = audio.length / SAMPLE_RATE;
  console.log(`  ${(performance.now() - t1).toFixed(0)}ms → ${secs.toFixed(2)}s audio  | ${phonemes.slice(0, 60)}`);
  if (!audio.length) throw new Error("empty audio");
  parts.push(audio, new Float32Array(Math.round(SAMPLE_RATE * 0.12)));
}
// Blend test
const blended = await engine.generate("This sentence uses a fifty-fifty blend of two voices.", { voice: "af_heart", blendVoice: "am_michael", blendRatio: 0.5 });
parts.push(blended.audio);

const total = parts.reduce((n, p) => n + p.length, 0);
const all = new Float32Array(total);
let off = 0;
for (const p of parts) {
  all.set(p, off);
  off += p.length;
}
await mkdir("test/out", { recursive: true });
const outFile = path.resolve(`test/out/sample-${voice}-${dtype}.wav`);
await writeFile(outFile, Buffer.from(encodeWav(all)));
console.log(`wrote ${outFile} (${(total / SAMPLE_RATE).toFixed(1)}s)`);
await engine.dispose();
