// Inline cues inside the text to speak:
//
//   [pause]  [pause 1.5s]  [pause 400ms]  [short pause]  [long pause]
//       → exact silence, inserted by GPTVoice (not left to the model)
//   [whispers] [laughs] [sighs] [excited] [sad] … any other [direction]
//       → stage direction: performed by the voice, never read aloud
//   {Nguyen|win}  {SNCF|S N C F}
//       → pronunciation hint: the voice says "win"; checks expect "Nguyen"
//
// Plus a `pronunciations` dictionary ({"Nguyen": "win"}) applied to whole words.

import { VoiceError } from "./errors.js";

const DEFAULT_PAUSE_MS = { short: 400, normal: 800, long: 1500 };
export const MAX_PAUSE_MS = 10_000;

function pauseMs(kind, amount, unit) {
  if (amount == null) return DEFAULT_PAUSE_MS[kind?.toLowerCase() || "normal"];
  const v = Number(String(amount).replace(",", "."));
  const ms = /^ms$/i.test(unit || "") ? v : v * 1000;
  if (!(ms >= 0)) throw new VoiceError(`invalid pause length in "[pause ${amount}${unit || ""}]"`, "invalid");
  return Math.min(MAX_PAUSE_MS, Math.round(ms));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Apply a {"word": "respelling"} dictionary as {word|respelling} hints (whole words, case-sensitive). */
export function applyPronunciations(text, dict) {
  if (!dict) return text;
  let out = String(text);
  const entries = Object.entries(dict).filter(([w, r]) => w && r);
  // Longest first so "New York" wins over "York".
  entries.sort((a, b) => b[0].length - a[0].length);
  for (const [word, respell] of entries) {
    if (word.length > 80 || String(respell).length > 80) throw new VoiceError(`pronunciation entry too long: "${word.slice(0, 30)}…"`, "invalid");
    const re = new RegExp(`(?<![\\p{L}\\p{N}{|])${escapeRe(word)}(?![\\p{L}\\p{N}|}])`, "gu");
    out = out.replace(re, `{${word}|${respell}}`);
  }
  return out;
}

// Non-verbal sounds. Benchmarked: describing the sound in the instructions
// ("a long weary exhale") gets the description READ ALOUD; writing it as an
// onomatopoeia at the start of the script ("Haaah…") plus a short direction
// produces the sound itself. Verification ignores these interjections.
const SOUND_GROUPS = [
  [["laugh", "laughs", "laughing", "rit", "rire", "rires", "éclate de rire"], "Ha ha ha!", "genuine laughter"],
  [["chuckle", "chuckles", "glousse", "ricane", "petit rire"], "Heh heh…", "a soft amused chuckle"],
  [["giggle", "giggles", "pouffe"], "Hi hi hi!", "a light playful giggle"],
  [["sigh", "sighs", "soupire", "soupir"], "Haaah…", "a real, weary sigh (breath, not a word)"],
  [["gasp", "gasps", "halète", "hoquet de surprise"], "Hhh!", "a sharp startled gasp (breath in, not a word)"],
  [["cough", "coughs", "tousse", "toux"], "Khm, khm.", "a short natural cough"],
  [["clears throat", "clear throat", "s'éclaircit la voix", "raclement de gorge"], "Ahem.", "a brief throat-clearing"],
  [["sniff", "sniffs", "renifle"], "Snf.", "a short sniff"],
  [["yawn", "yawns", "bâille", "baille"], "Aaah-hmm…", "an audible yawn"],
  [["sob", "sobs", "cries", "crying", "sanglote", "pleure"], "Hnnn…", "a tearful sob; keep the voice trembling afterwards"],
  [["scream", "screams", "hurle"], "Aaaah!", "a short scream"],
  [["groan", "groans", "gémit", "grogne"], "Uuugh…", "a low groan"],
  [["hum", "hums", "fredonne"], "Hmm hmm hmm…", "a few hummed notes"],
  [["breath", "breathes", "inhale", "respire", "inspire"], "Hhhh…", "one audible breath in"],
];
const SOUNDS = new Map(SOUND_GROUPS.flatMap(([names, sound, how]) => names.map((n) => [n, { sound, how }])));

/** { sound: onomatopoeia to put in the script, how: performance note } or null. */
export function soundFor(cue) {
  return SOUNDS.get(String(cue).toLowerCase().trim()) ?? null;
}

const CUE_RE = /\[([^\]]{1,80})\]/g;
const PAUSE_ONLY = /^\s*(?:(short|long)\s+)?(?:pause|silence|break)(?:\s+(\d+(?:[.,]\d+)?)\s*(ms|s|sec|seconds?)?)?\s*$/i;
const DIRECTION_GAP_MS = 250; // a direction change starts a new sentence: a sentence-length breath

// Marks an onomatopoeia inside the script: spoken by the voice, but not part of
// the words a listener is checked against ({<zero-width>|Ha ha ha!}).
const SOUND_MARK = "\u200b";
const SENTENCE_END = /[.!?…。！？]["'”»)\]]*$/;

/**
 * Sentence-safe cues (user rule: never synthesize fragments). A cue that sits
 * in the MIDDLE of a sentence would split it into separately spoken fragments,
 * each with its own start/end intonation — the main source of choppiness. So:
 *   - a mid-sentence [pause …] becomes "…" (a natural pause inside one take)
 *   - a mid-sentence direction ([whispers], [excited]…) moves to the start of
 *     its sentence (the whole sentence gets that delivery)
 *   - sound cues ([laughs]…) never split anything (spoken inline, see parseCues)
 * Cues at sentence boundaries are kept as they are.
 */
export function relocateCues(text) {
  const src = String(text);
  let out = "";
  let last = 0;
  let m;
  CUE_RE.lastIndex = 0;
  const sentenceStartIn = (str) => {
    const flat = str.replace(/\[[^\]]{1,80}\]/g, (c) => " ".repeat(c.length));
    const re = /[.!?。！？]["'”»)\]]*\s+|…["'”»)\]]*\s+(?=[\p{Lu}\[])|\n+/gu;
    let start = 0;
    let mm;
    while ((mm = re.exec(flat))) start = mm.index + mm[0].length;
    return start;
  };
  while ((m = CUE_RE.exec(src))) {
    out += src.slice(last, m.index);
    const cue = m[1].trim();
    const prior = out.replace(/(\s*\[[^\]]{1,80}\])+\s*$/g, "").trimEnd();
    const nextText = src.slice(m.index + m[0].length).replace(/^(\s*\[[^\]]{1,80}\])*\s*/, "");
    // "…" ends a sentence only when the next word starts a new one (capital letter).
    const endsSentence = /[.!?。！？]["'”»)\]]*$/.test(prior) || (/…["'”»)\]]*$/.test(prior) && /^[\p{Lu}\d"«“]/u.test(nextText));
    const atBoundary = prior === "" || nextText.trim() === "" || endsSentence || /\n\s*$/.test(out);
    if (atBoundary || soundFor(cue)) {
      out += m[0];
    } else if (PAUSE_ONLY.test(cue)) {
      // "voice, [pause] one" → "voice… one"
      const trimmed = out.trimEnd();
      out = /[,;:—–-]$/.test(trimmed) ? trimmed.slice(0, -1) + "… " : /…$/.test(trimmed) ? trimmed + " " : trimmed + "… ";
    } else {
      const at = sentenceStartIn(out);
      out = out.slice(0, at) + m[0] + " " + out.slice(at);
    }
    last = m.index + m[0].length;
  }
  return (out + src.slice(last)).replace(/[ \t]{2,}/g, " ");
}

/**
 * Split text at cues. Pause cues become exact silences. Every other [direction]
 * is taken OUT of the spoken script (so it can never be read aloud) and applied
 * to the words that follow it, up to the next cue. Sound cues are spoken
 * inline as onomatopoeia ("Ha ha ha!") with a performance note — no split.
 * Run relocateCues first so splits only happen at sentence boundaries.
 *
 * @returns {Array<{raw, script, expected, alternate, directions: string[], sounds: object[], pauseAfterMs}>}
 *  raw       = text with {word|respelling} hints (sounds are hints with an empty word)
 *  script    = words the voice receives (respellings applied, no cues)
 *  expected  = the words a listener should hear, as written (for verification)
 */
export function parseCues(text, pronunciations) {
  const src = applyPronunciations(relocateCues(text), pronunciations);
  const segments = [];
  let directions = [];
  let sounds = [];
  let last = 0;
  let buffer = "";
  const push = (pauseAfterMs) => {
    const raw = buffer.replace(/\s+/g, " ").trim();
    buffer = "";
    const script = scriptOf(raw).trim();
    const expected = expectedOf(raw).replaceAll(SOUND_MARK, "").replace(/\s+/g, " ").trim();
    if (!script) {
      // Nothing to say: fold this pause into the previous segment (or lead with silence).
      if (segments.length) segments[segments.length - 1].pauseAfterMs = Math.min(MAX_PAUSE_MS, segments[segments.length - 1].pauseAfterMs + pauseAfterMs);
      else if (pauseAfterMs) segments.push({ raw: "", script: "", expected: "", alternate: "", directions: [], sounds: [], pauseAfterMs });
      return;
    }
    segments.push({ raw, script, expected, alternate: script, directions, sounds, pauseAfterMs });
    sounds = [];
  };
  let m;
  CUE_RE.lastIndex = 0;
  while ((m = CUE_RE.exec(src))) {
    buffer += src.slice(last, m.index);
    const cue = m[1].trim();
    const pause = cue.match(PAUSE_ONLY);
    const sound = soundFor(cue);
    if (pause) {
      push(pauseMs(pause[1], pause[2], pause[3]));
    } else if (sound) {
      buffer += ` {${SOUND_MARK}|${sound.sound}} `;
      sounds = [...sounds, sound];
    } else {
      if (buffer.trim()) push(DIRECTION_GAP_MS);
      directions = [cue];
    }
    last = m.index + m[0].length;
  }
  buffer += src.slice(last);
  push(0);
  return segments;
}

const HINT_RE = /\{([^|}]{1,80})\|([^}]{1,80})\}/g;
/** Text the voice receives: {word|respelling} → respelling. */
export const scriptOf = (raw) => String(raw).replace(HINT_RE, "$2");
/** Text a listener should hear as written: {word|respelling} → word. */
export const expectedOf = (raw) => String(raw).replace(HINT_RE, "$1");

/** True when the text uses [stage directions] other than pauses. */
export function hasStageDirections(text) {
  return [...String(text).matchAll(CUE_RE)].some((m) => !PAUSE_ONLY.test(m[1]));
}
