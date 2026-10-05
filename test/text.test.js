import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, fidelity, parseScript } from "../src/text.js";

test("chunkText keeps short text whole", () => {
  assert.deepEqual(chunkText("Bonjour. Ça va ?"), ["Bonjour. Ça va ?"]);
});

test("chunkText splits at sentence boundaries under the limit", () => {
  const s = "One two three four. ".repeat(30).trim();
  const chunks = chunkText(s, 100);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 100, `chunk too long: ${c.length}`);
    assert.match(c, /\.$/, "chunk should end on a sentence");
  }
  assert.equal(chunks.join(" "), s);
});

test("chunkText splits a giant sentence on commas/spaces, never losing words", () => {
  const s = Array.from({ length: 200 }, (_, i) => `mot${i}`).join(", ");
  const chunks = chunkText(s, 120);
  assert.ok(chunks.every((c) => c.length <= 120));
  assert.equal(chunks.join(" ").split(/[ ,]+/).filter(Boolean).length, 200);
});

test("chunkText treats blank lines as hard breaks and drops empty paragraphs", () => {
  assert.deepEqual(chunkText("First.\n\n\n\nSecond.\n\n   "), ["First.", "Second."]);
});

test("chunkText handles CJK punctuation and no punctuation", () => {
  assert.equal(chunkText("你好。今天天气很好！").join("").replace(/\s/g, ""), "你好。今天天气很好！");
  assert.deepEqual(chunkText("no punctuation at all"), ["no punctuation at all"]);
});

test("parseScript reads speakers, inline styles, bracket styles and continuations", () => {
  const lines = parseScript(`LÉA (enthousiaste): Salut !
HUGO: Bonjour.
on continue ici
[Narrator | slow, warm]: Once upon a time.`);
  assert.deepEqual(lines, [
    { speaker: "LÉA", style: "enthousiaste", text: "Salut !" },
    { speaker: "HUGO", style: null, text: "Bonjour. on continue ici" },
    { speaker: "Narrator", style: "slow, warm", text: "Once upon a time." },
  ]);
});

test("parseScript rejects a script that starts without a speaker", () => {
  assert.throws(() => parseScript("hello there\nBOB: hi"), /no "Speaker:" prefix/);
});

test("fidelity: identical → 1, ignores case/accents/punctuation", () => {
  assert.equal(fidelity("Ça va, très bien !", "ca va tres bien"), 1);
});

test("fidelity: an answer instead of the script scores low", () => {
  const score = fidelity("Read me the weather report for Paris tomorrow morning", "Sure! I'd be happy to help you with that.");
  assert.ok(score < 0.3, `score ${score}`);
});

test("fidelity: one slipped word still passes the 0.8 bar", () => {
  assert.ok(fidelity("the quick brown fox jumps over the lazy dog", "the quick brown fox jumped over the lazy dog") >= 0.8);
});

test("fidelity: empty cases", () => {
  assert.equal(fidelity("", ""), 1);
  assert.equal(fidelity("words", ""), 0);
});
