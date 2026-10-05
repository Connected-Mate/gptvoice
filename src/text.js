// Text helpers: split long narration into speakable chunks, parse dialogue
// scripts, and score how faithfully the model read a chunk.

export const MAX_TEXT_CHARS = 60_000; // ~1 hour of narration; split bigger jobs yourself
export const DEFAULT_CHUNK_CHARS = 600;

// Sentence-ish boundaries: ., !, ?, …, and CJK full stops, followed by space/end.
const SENTENCE_RE = /[^.!?…。！？\n]+(?:[.!?…。！？]+["'”»)\]]*|\n+|$)/g;

function splitLongPiece(piece, max) {
  // Fall back to commas/semicolons, then whitespace, then a hard cut.
  const out = [];
  let rest = piece.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    if (cut < max * 0.4) cut = max - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Split text into sentences (keeps their punctuation). */
export function splitSentences(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .trim()
    .match(SENTENCE_RE)
    ?.map((x) => x.trim())
    .filter(Boolean) ?? [];
}

/**
 * Split text into chunks of at most `max` characters, never mid-sentence unless a
 * single sentence is longer than `max`. Paragraph breaks always end a chunk so
 * the narration keeps its natural pauses.
 */
export function chunkText(text, max = DEFAULT_CHUNK_CHARS) {
  const chunks = [];
  for (const para of String(text).split(/\n\s*\n/)) {
    const clean = para.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const sentences = (clean.match(SENTENCE_RE) || [clean]).map((s) => s.trim()).filter(Boolean);
    let current = "";
    for (const s of sentences) {
      const pieces = s.length > max ? splitLongPiece(s, max) : [s];
      for (const p of pieces) {
        if (!current) current = p;
        else if (current.length + 1 + p.length <= max) current += " " + p;
        else {
          chunks.push(current);
          current = p;
        }
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

/**
 * Parse a dialogue script, one line per turn:
 *   ALICE: Hello there.
 *   BOB (whispering): Hi.
 *   [Narrator | slow, warm]: Once upon a time...
 * Lines without a "Speaker:" prefix continue the previous speaker's turn.
 * Returns [{ speaker, style, text }].
 */
export function parseScript(script) {
  const lines = [];
  const re = /^\s*(?:\[([^\]|]{1,40})(?:\|([^\]]{1,200}))?\]|([\p{L}\p{N}_ .'’-]{1,40}?)\s*(?:\(([^)]{1,200})\))?)\s*:\s*(.+)$/u;
  for (const raw of String(script).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const m = raw.match(re);
    if (m) {
      const speaker = (m[1] ?? m[3]).trim();
      const style = (m[2] ?? m[4] ?? "").trim() || null;
      lines.push({ speaker, style, text: m[5].trim() });
    } else if (lines.length) {
      lines[lines.length - 1].text += " " + raw.trim();
    } else {
      throw new Error(`script line has no "Speaker:" prefix: "${raw.trim().slice(0, 60)}"`);
    }
  }
  return lines;
}

function normalizeWords(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Word-level similarity between the requested text and what the model actually
 * said (its own transcript), 0..1. Uses LCS so small slips cost little but an
 * answer-instead-of-reading or skipped sentence scores low.
 */
export function fidelity(expected, actual) {
  const a = normalizeWords(expected);
  const b = normalizeWords(actual);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const prev = new Uint16Array(b.length + 1);
  const cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev.set(cur);
  }
  const lcs = prev[b.length];
  return (2 * lcs) / (a.length + b.length);
}
