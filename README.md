# Kokoro Reader

A Chrome extension that reads web pages out loud using the Kokoro neural voice. Everything runs on your own computer. The model is downloaded once, cached in the browser, and then it works offline. Nothing you read is sent anywhere.

It uses WebGPU when your machine has it and falls back to WebAssembly on the CPU when it does not, so it works on Windows, macOS and Linux.

## Quickstart

The easy way: grab the zip from the [latest release](https://github.com/armand0e/kokoro-reader/releases/latest), unzip it, open `chrome://extensions`, turn on Developer mode, click Load unpacked and pick the unzipped folder. The build is the same for every operating system.

Or build it yourself:

```bash
git clone https://github.com/armand0e/kokoro-reader.git
cd kokoro-reader
npm install
npm run build
```

Then open `chrome://extensions`, turn on Developer mode, click Load unpacked and pick the `dist` folder.

The voice model starts downloading right away (about 330 MB on WebGPU, about 90 MB on CPU). You can watch the progress in the popup. After that, open any article and click the extension icon, then Read this page. A small player appears on the page and the sentence being read is highlighted.

## What it does

* Reads the main article of a page and skips menus, sidebars and footers. You can switch to reading everything instead.
* Lets you pick a single element on the page. Hover, click, and only that part is read. Use the up and down arrow keys to grow or shrink the selection.
* Reads highlighted text, or starts from wherever you right clicked.
* Highlights each sentence as it goes and scrolls to keep it in view.
* Floating player with pause, previous and next sentence, a progress bar you can click to jump, and a speed control.
* Six voices, the three best rated female and male ones. Heart is the default. You can also blend two voices together in the settings.
* Speed from half to double, changeable while it is reading.
* Save a whole page as a WAV file.
* Loads the model only when you start reading and frees the memory again after a few idle minutes (adjustable, or keep it loaded).
* Keyboard shortcuts: Alt Shift R to read or pause, Alt Shift E to pick an element, Alt Shift S to read the selection, Alt Shift X to stop.

## How it works

The heavy lifting happens in an offscreen document with a web worker that holds the Kokoro model (via Transformers.js and ONNX Runtime). The content script pulls readable text out of the page, splits it into sentences, and remembers where each sentence lives in the DOM so it can highlight it later. Sentences are synthesized a few ahead of playback so the audio is gapless.

## Development

```bash
npm run watch          # rebuild on change
npm run test:chunker   # sentence splitter tests
npm run test:engine    # loads the model in Node and writes a sample WAV
node test/e2e.mjs      # full suite against a real Chrome, see notes in test/e2e.mjs
```

If you update the files of an unpacked install, click Reload on the extension in `chrome://extensions` so Chrome picks up the new background script.

## Credits

Kokoro by hexgrad, kokoro.js and phonemizer by Xenova, Transformers.js by Hugging Face. All Apache 2.0. Licenses are copied into `dist/licenses`.
