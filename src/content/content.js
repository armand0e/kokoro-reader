// Content script: extracts readable text, maps sentences back to DOM ranges for highlighting,
// implements the element picker and the floating mini player.
import { chunkText } from "../shared/chunker.js";
import { DEFAULT_SETTINGS, saveSettings } from "../shared/settings.js";

{
  const prev = window.__kokoroReaderInstance;
  let alive = false;
  try {
    alive = !!(prev && prev.alive());
  } catch {}
  if (!alive) {
    try {
      prev?.teardown?.();
    } catch {}
    main();
  }
}

function main() {
  const HOST_TAG = "kokoro-reader-ui";
  window.__kokoroReaderInstance = {
    alive() {
      try {
        return !!chrome.runtime?.id;
      } catch {
        return false;
      }
    },
    teardown() {
      document.querySelector(HOST_TAG)?.remove();
      document.querySelectorAll(".kokoro-reader-pick-overlay, .kokoro-reader-pick-label").forEach((n) => n.remove());
      document.documentElement.classList.remove("kokoro-reader-picking");
      try {
        CSS.highlights?.delete("kokoro-reader-current");
        CSS.highlights?.delete("kokoro-reader-block");
      } catch {}
    },
  };
  const HL_CURRENT = "kokoro-reader-current";
  const HL_BLOCK = "kokoro-reader-block";

  let settings = { ...DEFAULT_SETTINGS };
  chrome.storage.local.get("settings").then((s) => (settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) })).catch(() => {});

  /** Current extracted document: blocks + chunks. */
  let doc = null;
  let lastPlayerState = null;
  let lastContext = { x: 0, y: 0, target: null };
  document.addEventListener(
    "contextmenu",
    (e) => {
      lastContext = { x: e.clientX, y: e.clientY, target: e.target };
    },
    true,
  );

  // =====================================================================
  // Text extraction
  // =====================================================================
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "MATH", "CANVAS", "VIDEO", "AUDIO", "IFRAME", "OBJECT", "EMBED",
    "SELECT", "TEXTAREA", "INPUT", "BUTTON", "OPTION", "DATALIST", "HEAD", "META", "LINK", "TITLE", HOST_TAG.toUpperCase(),
  ]);
  const STRUCTURAL_TAGS = new Set(["NAV", "HEADER", "FOOTER", "ASIDE", "MENU", "DIALOG"]);
  const STRUCTURAL_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "menu", "menubar", "toolbar", "search", "dialog", "alertdialog", "tablist", "tooltip"]);
  const BLOCK_DISPLAYS = new Set(["block", "flex", "grid", "list-item", "table", "table-row", "table-cell", "table-caption", "table-row-group", "table-header-group", "table-footer-group", "flow-root", "inline-flex", "inline-grid", "inline-table", "-webkit-box"]);

  const styleCache = new WeakMap();
  function cs(el) {
    let s = styleCache.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styleCache.set(el, s);
    }
    return s;
  }

  function isHiddenEl(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    const s = cs(el);
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return true;
    if (parseFloat(s.opacity) === 0) return true;
    return false;
  }

  function isBlockLevel(el) {
    const d = cs(el).display;
    return BLOCK_DISPLAYS.has(d) || el.tagName === "BR";
  }

  function hasBlockDescendant(el) {
    const all = el.getElementsByTagName("*");
    const n = Math.min(all.length, 300);
    for (let i = 0; i < n; i++) if (isBlockLevel(all[i])) return true;
    return false;
  }

  /** Whitespace-collapsing text accumulator that remembers the source node/offset of every char. */
  function makeAcc() {
    return { chars: [], nodes: [], offs: [] };
  }
  function accAppend(acc, node, str, from, to) {
    for (let i = from; i < to; i++) {
      const ch = str[i];
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === " " || ch === "\f" || ch === "\v" || ch === "​") {
        if (acc.chars.length && acc.chars[acc.chars.length - 1] !== " ") {
          acc.chars.push(" ");
          acc.nodes.push(node);
          acc.offs.push(i);
        }
      } else {
        acc.chars.push(ch);
        acc.nodes.push(node);
        acc.offs.push(i);
      }
    }
  }
  function accSpace(acc, node) {
    if (acc.chars.length && acc.chars[acc.chars.length - 1] !== " ") {
      acc.chars.push(" ");
      acc.nodes.push(node);
      acc.offs.push(0);
    }
  }
  function accFinish(acc) {
    while (acc.chars.length && acc.chars[acc.chars.length - 1] === " ") {
      acc.chars.pop();
      acc.nodes.pop();
      acc.offs.pop();
    }
    return { text: acc.chars.join(""), nodes: acc.nodes, offs: acc.offs };
  }

  /**
   * Collect readable blocks under `root`.
   * @param {Element} root
   * @param {{mode:'smart'|'all', range?:Range}} opts
   */
  function collectBlocks(root, { mode = "smart", range = null } = {}) {
    const blocks = [];
    const smartRoot = mode === "smart" && (root === document.body || root === document.documentElement);
    const host = document.querySelector(HOST_TAG);

    function skipEl(el) {
      if (el === host || SKIP_TAGS.has(el.tagName)) return true;
      if (el.classList?.contains("kokoro-reader-pick-overlay") || el.classList?.contains("kokoro-reader-pick-label")) return true;
      if (isHiddenEl(el)) return true;
      if (range && !range.intersectsNode(el)) return true;
      const role = el.getAttribute("role");
      if (smartRoot && (STRUCTURAL_TAGS.has(el.tagName) || (role && STRUCTURAL_ROLES.has(role)))) return true;
      if (!smartRoot && mode === "smart" && (el.tagName === "NAV" || (role && role === "navigation"))) return true;
      if (!settings.readCode && el.tagName === "PRE") return true;
      return false;
    }

    function addTextNode(acc, node) {
      const str = node.nodeValue;
      let from = 0;
      let to = str.length;
      if (range) {
        if (!range.intersectsNode(node)) return;
        if (node === range.startContainer) from = range.startOffset;
        if (node === range.endContainer) to = range.endOffset;
      }
      accAppend(acc, node, str, from, to);
    }

    /** Inline UI chrome that shouldn't be spoken: [1]-style reference markers, short non-selectable widgets ("edit"). */
    function isInlineNoise(el) {
      const text = el.textContent.trim();
      if (el.tagName === "SUP" && /^\[[^\]]{1,40}\]$/.test(text)) return true; // [12], [citation needed]
      if (text.length <= 40) {
        const s = cs(el);
        if (s.userSelect === "none" || s.webkitUserSelect === "none") return true;
      }
      return false;
    }

    /** Inline elements laid out as boxes (inline-block, or with horizontal spacing) act as word boundaries. */
    function isSpacedInline(el) {
      const s = cs(el);
      if (s.display === "inline-block" || s.display === "inline-flex" || s.display === "inline-grid") return true;
      return parseFloat(s.marginLeft) >= 3 || parseFloat(s.paddingLeft) >= 3 || parseFloat(s.marginRight) >= 3 || parseFloat(s.paddingRight) >= 3;
    }

    function addInline(acc, el) {
      if (skipEl(el)) return;
      if (el.tagName === "BR") {
        accSpace(acc, el);
        return;
      }
      if (isInlineNoise(el)) return;
      const spaced = isSpacedInline(el);
      if (spaced) accSpace(acc, el);
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) addTextNode(acc, child);
        else if (child.nodeType === Node.ELEMENT_NODE) addInline(acc, child);
      }
      if (spaced) accSpace(acc, el);
    }

    function pushBlock(container, run) {
      const acc = makeAcc();
      for (const node of run) {
        if (node.nodeType === Node.TEXT_NODE) addTextNode(acc, node);
        else addInline(acc, node);
      }
      const b = accFinish(acc);
      if (!/[\p{L}\p{N}]/u.test(b.text)) return;
      // Skip visually-hidden "screen-reader only" text (1×1 clipped boxes).
      const r = container.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1) return;
      blocks.push({ el: container, ...b });
    }

    function visit(el) {
      if (skipEl(el)) return;
      let run = [];
      const flush = () => {
        if (run.length) pushBlock(el, run);
        run = [];
      };
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          run.push(child);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.tagName === "BR") {
          run.push(child);
          continue;
        }
        if (SKIP_TAGS.has(child.tagName)) {
          flush();
          continue;
        }
        if (isBlockLevel(child) || cs(child).display === "contents" || hasBlockDescendant(child)) {
          flush();
          visit(child);
        } else {
          run.push(child);
        }
      }
      flush();
    }

    visit(root);
    return blocks;
  }

  /** Find the main content container for "smart" mode. */
  function findMainRoot() {
    const body = document.body;
    const bodyLen = (body.innerText || "").length;
    const candidates = [...document.querySelectorAll("article, main, [role=main], [itemprop=articleBody], .post-content, .entry-content, .article-body, #content, #main")];
    let best = null;
    let bestLen = 0;
    for (const c of candidates) {
      if (isHiddenEl(c)) continue;
      const len = (c.innerText || "").length;
      if (len > bestLen) {
        best = c;
        bestLen = len;
      }
    }
    if (best && bestLen > 400 && bestLen > bodyLen * 0.25) return best;
    return body;
  }

  function extractPage(mode) {
    mode = mode || settings.extraction || "smart";
    let blocks = [];
    if (mode === "smart") {
      const root = findMainRoot();
      blocks = collectBlocks(root, { mode: "smart" });
      if (root !== document.body && blocks.length === 0) blocks = collectBlocks(document.body, { mode: "smart" });
      if (blocks.length === 0) blocks = collectBlocks(document.body, { mode: "all" });
    } else {
      blocks = collectBlocks(document.body, { mode: "all" });
    }
    return blocks;
  }

  function extractSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return null;
    const blocks = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      let root = range.commonAncestorContainer;
      if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentElement;
      blocks.push(...collectBlocks(root, { mode: "all", range }));
    }
    return blocks;
  }

  function buildDoc(blocks) {
    const chunks = [];
    const blockOfNode = new Map();
    blocks.forEach((b, bi) => {
      for (const c of chunkText(b.text)) chunks.push({ blockIdx: bi, start: c.start, end: c.end, text: c.text });
      let prev = null;
      for (const n of b.nodes) {
        if (n !== prev) {
          blockOfNode.set(n, bi);
          prev = n;
        }
      }
    });
    return { blocks, chunks, blockOfNode };
  }

  // =====================================================================
  // Highlighting
  // =====================================================================
  function rangeForChunk(c) {
    const b = doc.blocks[c.blockIdx];
    const r = new Range();
    r.setStart(b.nodes[c.start], b.offs[c.start]);
    r.setEnd(b.nodes[c.end - 1], b.offs[c.end - 1] + 1);
    return r;
  }
  function rangeForBlock(b) {
    const r = new Range();
    r.setStart(b.nodes[0], b.offs[0]);
    r.setEnd(b.nodes[b.nodes.length - 1], b.offs[b.nodes.length - 1] + 1);
    return r;
  }

  function clearHighlight() {
    try {
      CSS.highlights?.delete(HL_CURRENT);
      CSS.highlights?.delete(HL_BLOCK);
    } catch {}
  }

  function scrollableAncestor(el) {
    let n = el;
    while (n && n !== document.body && n !== document.documentElement) {
      const s = cs(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
      n = n.parentElement;
    }
    return null;
  }

  function scrollToRange(r) {
    const rect = r.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const startEl = r.startContainer.nodeType === Node.ELEMENT_NODE ? r.startContainer : r.startContainer.parentElement;
    const scroller = startEl && scrollableAncestor(startEl);
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      if (rect.top < sr.top + 40 || rect.bottom > sr.bottom - 40) {
        scroller.scrollBy({ top: rect.top - sr.top - scroller.clientHeight * 0.35, behavior: "smooth" });
      }
      return;
    }
    if (rect.top < 70 || rect.bottom > window.innerHeight - 70) {
      window.scrollBy({ top: rect.top - window.innerHeight * 0.35, behavior: "smooth" });
    }
  }

  function highlightChunk(idx) {
    if (!doc || !doc.chunks[idx]) return clearHighlight();
    const c = doc.chunks[idx];
    let r;
    try {
      r = rangeForChunk(c);
    } catch {
      return clearHighlight(); // DOM changed underneath us
    }
    if (settings.highlight && typeof Highlight !== "undefined" && CSS.highlights) {
      try {
        CSS.highlights.set(HL_CURRENT, new Highlight(r));
        CSS.highlights.set(HL_BLOCK, new Highlight(rangeForBlock(doc.blocks[c.blockIdx])));
      } catch {}
    } else {
      clearHighlight();
    }
    if (settings.autoScroll) scrollToRange(r);
  }

  // =====================================================================
  // Session start helpers
  // =====================================================================
  async function startSession(blocks, startIndex = 0) {
    const d = buildDoc(blocks);
    if (!d.chunks.length) {
      toast("No readable text found.");
      return { ok: false, error: "No readable text found" };
    }
    doc = d;
    ui.show();
    ui.setStatus("Starting…");
    try {
      const res = await chrome.runtime.sendMessage({
        target: "background",
        type: "cs:play",
        chunks: d.chunks.map((c) => ({ text: c.text })),
        startIndex,
        title: document.title,
      });
      if (!res?.ok) throw new Error(res?.error || "Could not start");
      return { ok: true, chunks: d.chunks.length };
    } catch (e) {
      toast(`Could not start reading: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  function readPage(mode) {
    if (!document.body) {
      toast("Nothing to read on this page.");
      return { ok: false, error: "No document body" };
    }
    const lang = (document.documentElement.lang || "").toLowerCase();
    if (lang && !lang.startsWith("en")) toast("Heads-up: this page isn't in English — Kokoro's voices are English-only, so pronunciation may be off.", 4500);
    return startSession(extractPage(mode), 0);
  }

  function readSelection() {
    const blocks = extractSelection();
    if (!blocks) {
      toast("Select some text first.");
      return { ok: false, error: "No selection" };
    }
    return startSession(blocks, 0);
  }

  function readFromHere() {
    let blocks = extractPage(settings.extraction);
    let d = buildDoc(blocks);
    const { x, y, target } = lastContext;
    let idx = locateChunk(d, x, y, target);
    if (idx < 0 && settings.extraction === "smart") {
      // The clicked element may be outside the detected main content → fall back to everything.
      blocks = extractPage("all");
      d = buildDoc(blocks);
      idx = locateChunk(d, x, y, target);
    }
    return startSession(blocks, Math.max(0, idx));
  }

  function locateChunk(d, x, y, target) {
    // 1. Precise: caret position under the pointer.
    try {
      const caret = document.caretRangeFromPoint(x, y);
      if (caret) {
        const node = caret.startContainer;
        const bi = d.blockOfNode.get(node);
        if (bi != null) {
          const b = d.blocks[bi];
          let charIdx = -1;
          for (let i = 0; i < b.nodes.length; i++) {
            if (b.nodes[i] === node && b.offs[i] >= caret.startOffset) {
              charIdx = i;
              break;
            }
          }
          if (charIdx < 0) charIdx = b.nodes.lastIndexOf(node);
          const ci = d.chunks.findIndex((c) => c.blockIdx === bi && c.start <= charIdx && charIdx < c.end);
          if (ci >= 0) return ci;
          return d.chunks.findIndex((c) => c.blockIdx === bi);
        }
      }
    } catch {}
    // 2. Fallback: first block at/after the clicked element.
    if (target && target.nodeType === Node.ELEMENT_NODE) {
      for (let bi = 0; bi < d.blocks.length; bi++) {
        const el = d.blocks[bi].el;
        if (el === target || target.contains(el) || el.contains(target)) return d.chunks.findIndex((c) => c.blockIdx === bi);
        if (target.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) return d.chunks.findIndex((c) => c.blockIdx === bi);
      }
    }
    return -1;
  }

  function control(action, extra = {}) {
    return chrome.runtime.sendMessage({ target: "background", type: "cs:control", action, ...extra }).catch(() => {});
  }

  // =====================================================================
  // Element picker
  // =====================================================================
  let picker = null;
  function startPicker() {
    if (picker) return;
    const overlay = document.createElement("div");
    overlay.className = "kokoro-reader-pick-overlay";
    const label = document.createElement("div");
    label.className = "kokoro-reader-pick-label";
    document.documentElement.append(overlay, label);
    document.documentElement.classList.add("kokoro-reader-picking");
    ui.hide();

    const st = { candidate: null, stack: [], locked: false, lockPoint: null, mouse: { x: 0, y: 0 } };

    const describe = (el) => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const cls = el.classList.length ? `.${[...el.classList].slice(0, 2).join(".")}` : "";
      const words = (el.innerText || "").split(/\s+/).filter(Boolean).length;
      return `<${tag}${id}${cls}>  ·  ${words} word${words === 1 ? "" : "s"}   —   click to read · ↑ expand · ↓ shrink · Esc cancel`;
    };
    const update = () => {
      const el = st.candidate;
      if (!el) return;
      const r = el.getBoundingClientRect();
      overlay.style.left = `${r.left}px`;
      overlay.style.top = `${r.top}px`;
      overlay.style.width = `${r.width}px`;
      overlay.style.height = `${r.height}px`;
      label.textContent = describe(el);
      const lt = r.top > 36 ? r.top - 30 : Math.min(window.innerHeight - 30, r.bottom + 6);
      label.style.top = `${lt}px`;
      label.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - label.offsetWidth - 6))}px`;
    };
    const ownEl = (el) => !el || el === overlay || el === label || el.tagName === HOST_TAG.toUpperCase() || el.closest?.(HOST_TAG);

    const onMove = (e) => {
      st.mouse = { x: e.clientX, y: e.clientY };
      if (st.locked) {
        const d = Math.hypot(e.clientX - st.lockPoint.x, e.clientY - st.lockPoint.y);
        if (d < 14) return;
        st.locked = false;
        st.stack = [];
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (ownEl(el) || el === document.documentElement || el === document.body) return;
      if (el !== st.candidate) {
        st.candidate = el;
        update();
      }
    };
    const swallow = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onClick = (e) => {
      swallow(e);
      if (e.button !== 0) return;
      pick();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        swallow(e);
        stopPicker();
        toast("Picking cancelled.");
      } else if (e.key === "ArrowUp") {
        swallow(e);
        const p = st.candidate?.parentElement;
        if (p && p !== document.documentElement) {
          st.stack.push(st.candidate);
          st.candidate = p;
          st.locked = true;
          st.lockPoint = { ...st.mouse };
          update();
        }
      } else if (e.key === "ArrowDown") {
        swallow(e);
        if (st.stack.length) {
          st.candidate = st.stack.pop();
          st.locked = true;
          st.lockPoint = { ...st.mouse };
          update();
        }
      } else if (e.key === "Enter") {
        swallow(e);
        pick();
      }
    };
    const onScroll = () => update();

    const pick = () => {
      const el = st.candidate;
      stopPicker();
      if (!el) return;
      const blocks = collectBlocks(el, { mode: "all" });
      if (!blocks.length) {
        toast("That element has no readable text.");
        return;
      }
      startSession(blocks, 0);
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup", "auxclick", "dblclick"]) document.addEventListener(t, swallow, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);

    picker = {
      stop() {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup", "auxclick", "dblclick"]) document.removeEventListener(t, swallow, true);
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onScroll);
        overlay.remove();
        label.remove();
        document.documentElement.classList.remove("kokoro-reader-picking");
      },
    };
    // Seed with whatever is under the last known pointer position.
    const seed = document.elementFromPoint(lastContext.x, lastContext.y);
    if (seed && !ownEl(seed) && seed !== document.body && seed !== document.documentElement) {
      st.candidate = seed;
      update();
    }
    label.textContent = st.candidate ? describe(st.candidate) : "Hover over an element and click to read it · Esc to cancel";
    label.style.top = st.candidate ? label.style.top : "12px";
    label.style.left = st.candidate ? label.style.left : "12px";
  }
  function stopPicker() {
    picker?.stop();
    picker = null;
  }

  // =====================================================================
  // Mini player (shadow DOM)
  // =====================================================================
  const ui = (() => {
    let host = null;
    let root = null;
    let els = null;
    let toastTimer = null;
    let hideTimer = null;

    const ICONS = {
      prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
      next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
      play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
      pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
      stop: '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>',
      pick: '<svg viewBox="0 0 24 24"><path d="M3 3h8v2H5v6H3zm10 0h8v8h-2V5h-6zM3 13h2v6h6v2H3zm11 1 7 3-3 1-1 3z"/></svg>',
      close: '<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z"/></svg>',
    };

    const CSS_TEXT = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .kr { position: fixed; right: 20px; bottom: 20px; width: 340px; max-width: calc(100vw - 24px); z-index: 2147483646;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #f4f4f5;
        background: rgba(24, 24, 27, .96); border: 1px solid rgba(255,255,255,.08); border-radius: 14px;
        box-shadow: 0 12px 40px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.2); backdrop-filter: blur(10px);
        padding: 10px 12px 12px; display: none; user-select: none; }
      .kr[data-visible="1"] { display: block; }
      .kr-top { display: flex; align-items: center; gap: 8px; cursor: grab; margin-bottom: 6px; }
      .kr-top:active { cursor: grabbing; }
      .kr-badge { font-weight: 700; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #c4b5fd; }
      .kr-status { flex: 1; color: #a1a1aa; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .kr-text { color: #e4e4e7; font-size: 13px; max-height: 3.9em; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; margin: 2px 0 8px; min-height: 1.4em; }
      .kr-bar { height: 4px; background: rgba(255,255,255,.12); border-radius: 2px; overflow: hidden; margin-bottom: 10px; cursor: pointer; }
      .kr-fill { height: 100%; width: 0; background: linear-gradient(90deg,#8b5cf6,#c4b5fd); transition: width .2s; }
      .kr-controls { display: flex; align-items: center; gap: 6px; }
      button { appearance: none; border: 0; background: rgba(255,255,255,.08); color: #f4f4f5; width: 34px; height: 34px; border-radius: 10px;
        display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; }
      button:hover { background: rgba(255,255,255,.16); }
      button.primary { background: #7c3aed; width: 42px; }
      button.primary:hover { background: #6d28d9; }
      button.icon { background: transparent; width: 28px; height: 28px; }
      button.icon:hover { background: rgba(255,255,255,.12); }
      svg { width: 18px; height: 18px; fill: currentColor; }
      select { appearance: none; border: 0; background: rgba(255,255,255,.08); color: #f4f4f5; border-radius: 10px; height: 34px; padding: 0 10px; font: inherit; cursor: pointer; }
      .kr-spacer { flex: 1; }
      .kr-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483647; background: rgba(24,24,27,.96); color: #f4f4f5;
        padding: 10px 16px; border-radius: 10px; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.35);
        border: 1px solid rgba(255,255,255,.1); display: none; max-width: 80vw; }
      .kr-toast[data-visible="1"] { display: block; }
      .kr-hint { color: #71717a; font-size: 11px; margin-top: 8px; }
    `;

    function ensure() {
      if (host && host.isConnected) return;
      host = document.createElement(HOST_TAG);
      host.style.cssText = "all:initial;position:fixed;z-index:2147483646;";
      root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = CSS_TEXT;
      const wrap = document.createElement("div");
      wrap.className = "kr";
      wrap.innerHTML = `
        <div class="kr-top" part="drag">
          <span class="kr-badge">Kokoro</span>
          <span class="kr-status">Ready</span>
          <button class="icon" data-act="pick" title="Pick an element to read">${ICONS.pick}</button>
          <button class="icon" data-act="close" title="Stop and close">${ICONS.close}</button>
        </div>
        <div class="kr-text"></div>
        <div class="kr-bar" title="Click to jump"><div class="kr-fill"></div></div>
        <div class="kr-controls">
          <button data-act="prev" title="Previous sentence (←)">${ICONS.prev}</button>
          <button class="primary" data-act="toggle" title="Play / pause (space)">${ICONS.pause}</button>
          <button data-act="next" title="Next sentence (→)">${ICONS.next}</button>
          <button data-act="stop" title="Stop">${ICONS.stop}</button>
          <span class="kr-spacer"></span>
          <select data-act="speed" title="Speed">
            ${[0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75, 2].map((s) => `<option value="${s}">${s}×</option>`).join("")}
          </select>
        </div>`;
      const toastEl = document.createElement("div");
      toastEl.className = "kr-toast";
      root.append(style, wrap, toastEl);
      document.documentElement.appendChild(host);
      els = {
        wrap,
        status: wrap.querySelector(".kr-status"),
        text: wrap.querySelector(".kr-text"),
        fill: wrap.querySelector(".kr-fill"),
        bar: wrap.querySelector(".kr-bar"),
        toggle: wrap.querySelector('[data-act="toggle"]'),
        speed: wrap.querySelector('[data-act="speed"]'),
        toast: toastEl,
      };
      els.speed.value = String(settings.speed);
      if (!els.speed.value) els.speed.value = "1";

      wrap.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === "pick") startPicker();
        else if (act === "close") {
          control("stop");
          ui.hide();
        } else control(act);
      });
      els.bar.addEventListener("click", (e) => {
        const s = lastPlayerState?.session;
        if (!s) return;
        const r = els.bar.getBoundingClientRect();
        const idx = Math.floor(((e.clientX - r.left) / r.width) * s.total);
        control("seekTo", { index: idx });
      });
      els.speed.addEventListener("change", () => saveSettings({ speed: Number(els.speed.value) }));

      // Dragging.
      const top = wrap.querySelector(".kr-top");
      let drag = null;
      top.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        const r = wrap.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        top.setPointerCapture(e.pointerId);
      });
      top.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const x = Math.max(4, Math.min(window.innerWidth - wrap.offsetWidth - 4, e.clientX - drag.dx));
        const y = Math.max(4, Math.min(window.innerHeight - wrap.offsetHeight - 4, e.clientY - drag.dy));
        wrap.style.left = `${x}px`;
        wrap.style.top = `${y}px`;
        wrap.style.right = "auto";
        wrap.style.bottom = "auto";
      });
      top.addEventListener("pointerup", () => (drag = null));
    }

    return {
      show() {
        if (!settings.miniPlayer) return;
        ensure();
        clearTimeout(hideTimer);
        els.wrap.dataset.visible = "1";
      },
      hide() {
        if (els) els.wrap.dataset.visible = "0";
      },
      hideSoon(ms) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => this.hide(), ms);
      },
      setStatus(t) {
        if (els) els.status.textContent = t;
      },
      render(state) {
        if (!settings.miniPlayer) return;
        const s = state.session;
        if (!s) return;
        ensure();
        els.wrap.dataset.visible = "1";
        const m = state.model;
        let status;
        if (m.status === "loading") status = `Loading model… ${m.progress?.pct || 0}%${m.progress?.total ? ` (${fmtMB(m.progress.loaded)} / ${fmtMB(m.progress.total)})` : ""}`;
        else if (m.status === "error") status = `Model error: ${m.error}`;
        else if (s.status === "buffering") status = `Synthesizing ${s.index + 1} / ${s.total}…`;
        else if (s.status === "paused") status = `Paused · ${s.index + 1} / ${s.total}`;
        else if (s.status === "ended") status = "Finished";
        else status = `Reading ${s.index + 1} / ${s.total}${m.device ? ` · ${m.device.toUpperCase()}` : ""}`;
        els.status.textContent = status;
        els.text.textContent = s.text || "";
        els.fill.style.width = `${((s.index + (s.status === "ended" ? 1 : 0)) / Math.max(1, s.total)) * 100}%`;
        els.toggle.innerHTML = s.status === "paused" ? ICONS.play : ICONS.pause;
        els.toggle.title = s.status === "paused" ? "Play" : "Pause";
        if (state.settings?.speed != null) els.speed.value = String(state.settings.speed);
      },
      toast(msg, ms = 2600) {
        ensure();
        els.toast.textContent = msg;
        els.toast.dataset.visible = "1";
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => (els.toast.dataset.visible = "0"), ms);
      },
    };
  })();

  function toast(msg, ms) {
    ui.toast(msg, ms);
  }
  function fmtMB(bytes) {
    return `${(bytes / 1048576).toFixed(0)} MB`;
  }

  // Keyboard control while the player is visible (only when focus isn't in an editable field).
  document.addEventListener("keydown", (e) => {
    if (!lastPlayerState?.session || picker) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.altKey && e.shiftKey) return; // extension shortcuts
    if (e.key === "ArrowRight" && e.altKey) {
      e.preventDefault();
      control("next");
    } else if (e.key === "ArrowLeft" && e.altKey) {
      e.preventDefault();
      control("prev");
    }
  });

  // =====================================================================
  // Player state updates
  // =====================================================================
  function onPlayerState(state) {
    lastPlayerState = state;
    if (!state.session) {
      clearHighlight();
      if (state.endedSession?.status === "ended") {
        ui.setStatus("Finished");
        ui.hideSoon(1800);
      } else ui.hide();
      lastPlayerState = null;
      return;
    }
    ui.render(state);
    if (doc) highlightChunk(state.session.index);
  }

  // =====================================================================
  // Messages from the service worker
  // =====================================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.settings && msg.type.startsWith("cs:")) settings = { ...DEFAULT_SETTINGS, ...msg.settings };
    const respond = (p) =>
      Promise.resolve(p)
        .then((r) => sendResponse(r ?? { ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    switch (msg.type) {
      case "player:state":
        onPlayerState(msg.state);
        sendResponse({ ok: true });
        return false;
      case "cs:settings":
        settings = { ...DEFAULT_SETTINGS, ...msg.settings };
        if (!settings.highlight) clearHighlight();
        if (!settings.miniPlayer) ui.hide();
        else if (lastPlayerState) ui.render(lastPlayerState);
        sendResponse({ ok: true });
        return false;
      case "cs:readPage":
        respond(readPage(msg.mode));
        return true;
      case "cs:readSelection":
        respond(readSelection());
        return true;
      case "cs:readFromHere":
        respond(readFromHere());
        return true;
      case "cs:pick":
        startPicker();
        sendResponse({ ok: true });
        return false;
      case "cs:getChunks": {
        const blocks = msg.selectionOnly ? extractSelection() : extractPage(msg.mode);
        const d = buildDoc(blocks || []);
        sendResponse({ ok: true, chunks: d.chunks.map((c) => ({ text: c.text })) });
        return false;
      }
      case "cs:pageInfo": {
        const sel = window.getSelection();
        sendResponse({
          ok: true,
          title: document.title,
          hasSelection: !!sel && !sel.isCollapsed && sel.toString().trim().length > 0,
          reading: !!lastPlayerState?.session,
        });
        return false;
      }
      default:
        return false;
    }
  });

  // If a session is already running for this tab (e.g. script re-injected), sync up.
  chrome.runtime.sendMessage({ target: "background", type: "cs:getState" }).then((r) => {
    const st = r?.result;
    if (st?.session && doc) onPlayerState(st);
  }).catch(() => {});
}
