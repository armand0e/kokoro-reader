// Build script: bundles the extension into ./dist (load that folder as an unpacked extension).
import * as esbuild from "esbuild";
import { cp, mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const watch = process.argv.includes("--watch");
const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const dist = path.join(root, "dist");

// Only the voices exposed in the UI are shipped (top 3 female + top 3 male by grade / public opinion).
const SHIPPED_VOICES = ["af_heart", "af_bella", "bf_emma", "am_michael", "am_fenrir", "am_puck"];

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  await cp(path.join(root, "src/manifest.json"), path.join(dist, "manifest.json"));
  await cp(path.join(root, "src/popup/popup.html"), path.join(dist, "popup/popup.html"));
  await cp(path.join(root, "src/popup/popup.css"), path.join(dist, "popup/popup.css"));
  await cp(path.join(root, "src/options/options.html"), path.join(dist, "options/options.html"));
  await cp(path.join(root, "src/options/options.css"), path.join(dist, "options/options.css"));
  await cp(path.join(root, "src/offscreen/offscreen.html"), path.join(dist, "offscreen/offscreen.html"));
  await cp(path.join(root, "src/content/content.css"), path.join(dist, "content.css"));
  await cp(path.join(root, "src/icons"), path.join(dist, "icons"), { recursive: true });

  // ONNX Runtime WASM backend (served from the extension itself, no CDN).
  const ortDir = path.join(root, "node_modules/onnxruntime-web/dist");
  await mkdir(path.join(dist, "ort"), { recursive: true });
  for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
    await cp(path.join(ortDir, f), path.join(dist, "ort", f));
  }

  // Voice style vectors (bundled, so voices never need a network round-trip).
  await mkdir(path.join(dist, "voices"), { recursive: true });
  for (const v of SHIPPED_VOICES) {
    await cp(path.join(root, "node_modules/kokoro-js/voices", `${v}.bin`), path.join(dist, "voices", `${v}.bin`));
  }

  // Third-party licenses.
  await mkdir(path.join(dist, "licenses"), { recursive: true });
  for (const [pkg, file] of [
    ["kokoro-js", "LICENSE"],
    ["phonemizer", "LICENSE"],
    ["@huggingface/transformers", "LICENSE"],
    ["onnxruntime-web", "LICENSE"],
  ]) {
    const src = path.join(root, "node_modules", pkg, file);
    if (existsSync(src)) await cp(src, path.join(dist, "licenses", `${pkg.replace("/", "_")}.txt`));
  }
}

const common = {
  bundle: true,
  platform: "browser",
  target: ["chrome116"],
  logLevel: "info",
  sourcemap: false,
  legalComments: "none",
  minify: false,
};

const builds = [
  // Service worker (ES module).
  { entryPoints: [path.join(root, "src/background.js")], outfile: path.join(dist, "background.js"), format: "esm" },
  // Content script must be a classic script.
  { entryPoints: [path.join(root, "src/content/content.js")], outfile: path.join(dist, "content.js"), format: "iife" },
  // Offscreen document (audio player + coordinator) and its inference worker.
  { entryPoints: [path.join(root, "src/offscreen/offscreen.js")], outfile: path.join(dist, "offscreen/offscreen.js"), format: "esm" },
  {
    entryPoints: [path.join(root, "src/offscreen/worker.js")],
    outfile: path.join(dist, "offscreen/worker.js"),
    format: "esm",
    minify: true,
    // transformers.js references these node built-ins behind runtime guards; mark them empty.
    external: [],
    define: { "process.env.NODE_ENV": '"production"' },
  },
  { entryPoints: [path.join(root, "src/popup/popup.js")], outfile: path.join(dist, "popup/popup.js"), format: "esm" },
  { entryPoints: [path.join(root, "src/options/options.js")], outfile: path.join(dist, "options/options.js"), format: "esm" },
];

async function run() {
  await rm(dist, { recursive: true, force: true });
  await copyStatic();
  if (watch) {
    const ctxs = await Promise.all(builds.map((b) => esbuild.context({ ...common, ...b })));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("watching…");
  } else {
    await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
    const sizes = [];
    for (const b of builds) {
      const s = await stat(b.outfile);
      sizes.push(`${path.relative(dist, b.outfile)}: ${(s.size / 1024).toFixed(0)} KB`);
    }
    console.log(sizes.join("\n"));
    console.log(`\nBuilt → ${dist}`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
