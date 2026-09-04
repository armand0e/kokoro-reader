import { chunkText, splitSentences, toSpeechText } from "../src/shared/chunker.js";
import assert from "node:assert/strict";

const t1 = "Dr. Smith went to Washington. He arrived at 3.30 p.m. on Jan. 5th! Was it worth it? Yes. It really was, e.g. for the museums.";
const s1 = splitSentences(t1).map((s) => t1.slice(s.start, s.end));
console.log(s1);
assert.equal(s1[0], "Dr. Smith went to Washington.");
assert.equal(s1[1], "He arrived at 3.30 p.m. on Jan. 5th!");
assert.equal(s1[2], "Was it worth it?");
assert.equal(s1[3], "Yes.");
assert.equal(s1[4], "It really was, e.g. for the museums.");

const c1 = chunkText(t1);
console.log(c1.map((c) => c.text));
// "Yes." is short → merged with the following sentence
assert.ok(c1.some((c) => c.text.includes("Yes. It really was")));
for (const c of c1) assert.equal(t1.slice(c.start, c.end), c.text);

// Long text gets split under the cap
const long = Array.from({ length: 60 }, (_, i) => `clause number ${i}`).join(", ") + ".";
const c2 = chunkText(long);
assert.ok(c2.length > 1);
for (const c of c2) {
  assert.ok(c.text.length <= 300, `chunk too long: ${c.text.length}`);
  assert.equal(long.slice(c.start, c.end), c.text);
}
console.log(`long text → ${c2.length} chunks, max ${Math.max(...c2.map((c) => c.text.length))} chars`);

// Quotes and closing brackets stay attached
const t3 = 'She said "Go away!" Then she left (quietly). The end';
const s3 = splitSentences(t3).map((s) => t3.slice(s.start, s.end));
console.log(s3);
assert.equal(s3[0], 'She said "Go away!"');
assert.equal(s3[1], "Then she left (quietly).");
assert.equal(s3[2], "The end");

// No chunk without letters/digits
assert.deepEqual(chunkText("... --- ***"), []);

assert.equal(toSpeechText("Heading text"), "Heading text.");
assert.equal(toSpeechText("Done!"), "Done!");
assert.equal(toSpeechText("  spaced   out  "), "spaced out.");

console.log("chunker tests passed");
