// Splits a block of text into sentence-sized chunks with character offsets, so the content script
// can map every chunk back to a DOM Range for highlighting. Kokoro is happiest with 100–200 tokens,
// and hard-truncates at 510, so chunks are capped well below that.

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "sgt", "col", "gen", "rep", "sen", "gov", "lt", "maj", "capt",
  "st", "mt", "ft", "etc", "co", "inc", "ltd", "corp", "dept", "vs", "no", "fig", "figs", "eq", "approx", "est",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun", "e.g", "i.e", "u.s", "u.k", "ph.d", "a.m", "p.m",
]);

const MAX_CHUNK = 300; // characters
const MIN_MERGE = 40; // sentences shorter than this get merged with the next one
const SENTENCE_END = /[.!?…]+["'”’)\]]*/g;

function isAbbreviation(text, endIdx) {
  // endIdx points at the first char after the terminal punctuation run.
  let i = endIdx - 1;
  while (i >= 0 && /[.!?…"'”’)\]]/.test(text[i])) i--;
  let j = i;
  while (j >= 0 && /[A-Za-z.]/.test(text[j]) && !/\s/.test(text[j])) j--;
  const word = text.slice(j + 1, i + 1).toLowerCase().replace(/\.$/, "");
  if (!word) return false;
  if (ABBREVIATIONS.has(word)) return true;
  if (word.length === 1) return true; // initials: "J. K. Rowling"
  return false;
}

/** Returns sentence spans [{start,end}] for text (end exclusive). */
export function splitSentences(text) {
  const spans = [];
  let start = 0;
  SENTENCE_END.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const punct = m[0][0];
    const next = text.slice(end).match(/^\s*(\S)?/);
    const nextChar = next && next[1];
    const atEnd = end >= text.length || !nextChar;
    if (!atEnd) {
      // Need whitespace after the punctuation to be a boundary (avoids "3.14", "example.com").
      if (!/\s/.test(text[end])) continue;
      if (punct === "." && isAbbreviation(text, end)) continue;
      // Lowercase continuation after a period is usually not a sentence boundary.
      if (punct === "." && /[a-z]/.test(nextChar)) continue;
    }
    spans.push({ start, end });
    start = end;
    if (atEnd) break;
  }
  if (start < text.length) spans.push({ start, end: text.length });
  // Trim whitespace inside spans.
  return spans
    .map(({ start, end }) => {
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      return { start, end };
    })
    .filter((s) => s.end > s.start);
}

/** Split an over-long span at natural pause points. */
function hardSplit(text, span) {
  const out = [];
  let { start, end } = span;
  while (end - start > MAX_CHUNK) {
    const window = text.slice(start, start + MAX_CHUNK);
    let cut = -1;
    for (const re of [/[;:—–]\s[^;:—–]*$/, /,\s[^,]*$/, /\s\S*$/]) {
      const mm = window.match(re);
      if (mm && mm.index > MAX_CHUNK * 0.4) {
        cut = mm.index + (re.source.startsWith("\\s") ? 0 : 1);
        break;
      }
    }
    if (cut <= 0) cut = MAX_CHUNK;
    let e = start + cut;
    while (e > start && /\s/.test(text[e - 1])) e--;
    out.push({ start, end: e });
    start = start + cut;
    while (start < end && /\s/.test(text[start])) start++;
  }
  if (end > start) out.push({ start, end });
  return out;
}

/**
 * Chunk a block of text for TTS.
 * @returns {{start:number,end:number,text:string}[]}
 */
export function chunkText(text) {
  const sentences = splitSentences(text).flatMap((s) => (s.end - s.start > MAX_CHUNK ? hardSplit(text, s) : [s]));
  const chunks = [];
  let cur = null;
  for (const s of sentences) {
    if (cur && cur.end - cur.start < MIN_MERGE && s.end - cur.start <= MAX_CHUNK) {
      cur.end = s.end;
    } else {
      if (cur) chunks.push(cur);
      cur = { start: s.start, end: s.end };
    }
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => ({ ...c, text: text.slice(c.start, c.end) })).filter((c) => /[\p{L}\p{N}]/u.test(c.text));
}

/** Text as sent to the synthesizer: make sure it ends with punctuation so prosody closes cleanly. */
export function toSpeechText(text) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return t;
  return /[.!?…:;,]["'”’)\]]*$/.test(t) ? t : `${t}.`;
}
