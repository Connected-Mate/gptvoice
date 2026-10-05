// Word accuracy: compare the text we asked for with what was actually said
// (a transcript), the way speech-recognition benchmarks do (1 - WER), after a
// normalization that makes "37", "thirty-seven" and "trente-sept" equal.

const EN_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function enBelow1000(n) {
  const out = [];
  if (n >= 100) {
    out.push(EN_ONES[Math.floor(n / 100)], "hundred");
    n %= 100;
  }
  if (n >= 20) {
    out.push(EN_TENS[Math.floor(n / 10)]);
    if (n % 10) out.push(EN_ONES[n % 10]);
  } else if (n > 0 || out.length === 0) out.push(EN_ONES[n]);
  return out;
}

function enWords(n) {
  if (n === 0) return ["zero"];
  const out = [];
  for (const [v, w] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]]) {
    if (n >= v) {
      out.push(...enBelow1000(Math.floor(n / v)), w);
      n %= v;
    }
  }
  if (n) out.push(...enBelow1000(n));
  return out;
}

const FR_ONES = ["zero", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize"];
const FR_TENS = ["", "dix", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante", "quatre vingt", "quatre vingt"];

function frBelow100(n) {
  if (n <= 16) return [FR_ONES[n]];
  if (n < 20) return ["dix", FR_ONES[n - 10]];
  const t = Math.floor(n / 10);
  let u = n % 10;
  const out = FR_TENS[t].split(" ");
  if (u === 1 && t !== 8 && t !== 9) out.push("et"); // vingt et un, soixante et onze
  if (t === 7 || t === 9) u += 10; // soixante-dix, quatre-vingt-dix
  if (u === 0) return out;
  return [...out, ...frBelow100(u)];
}

function frBelow1000(n) {
  const out = [];
  const h = Math.floor(n / 100);
  if (h) {
    if (h > 1) out.push(FR_ONES[h]);
    out.push("cent");
  }
  if (n % 100 || !h) out.push(...frBelow100(n % 100));
  return out;
}

function frWords(n) {
  if (n === 0) return ["zero"];
  const out = [];
  for (const [v, w] of [[1e9, "milliard"], [1e6, "million"], [1e3, "mille"]]) {
    if (n >= v) {
      const q = Math.floor(n / v);
      if (!(v === 1e3 && q === 1)) out.push(...frBelow1000(q));
      out.push(w);
      n %= v;
    }
  }
  if (n) out.push(...frBelow1000(n));
  return out;
}

// Written abbreviations → the words a listener hears.
const ABBREVIATIONS = {
  mme: ["madame"],
  mmes: ["mesdames"],
  mlle: ["mademoiselle"],
  m: ["monsieur"],
  dr: ["doctor"],
  mr: ["mister"],
  mrs: ["missus"],
  st: ["saint"],
  pm: ["p", "m"],
  am: ["a", "m"],
  km: ["kilometres"],
  kg: ["kilos"],
  h: ["heures"],
};
// Spelling variants that sound the same.
const SPELLING = { vingts: "vingt", cents: "cent", kilometers: "kilometres", kilometres: "kilometres", heure: "heures", ok: "okay" };
const NUMBER_WORDS = new Set([...EN_ONES, ...EN_TENS.filter(Boolean), "hundred", "thousand", "million", "billion"]);

const INTERJECTIONS = new Set(["ha", "haha", "hahaha", "hah", "heh", "hehe", "hihi", "hi", "ah", "aah", "ahh", "oh", "ohh", "hm", "hmm", "mm", "mmm", "uh", "um", "huh", "pff", "pfff", "phew", "ouf", "hein", "euh", "sigh", "sighs", "laughs", "laughter", "rires", "rire", "soupir", "soupire", "chuckles", "gasps", "coughs"]);

// Onomatopoeia used for sound cues and how transcribers spell them.
const NONWORD = /^(h+a+h*|a+h+|h+|p+f+|h+e+h*|a+h+e+m+|k+h+m+|s+n+f+|h+n+|a{2,}h*|u+g+h+|h+m+|m{2,}|h+i+)$/;

const FR_HINT = /\b(le|la|les|des|une|est|et|pas|que|qui|dans|pour|avec|vous|nous|je|il|elle|ce|cette|du|au|sur)\b/gi;
const EN_HINT = /\b(the|and|is|are|of|to|in|that|it|you|with|for|on|this|was|he|she|we|they)\b/gi;

export function guessLanguage(text) {
  const fr = (String(text).match(FR_HINT) || []).length;
  const en = (String(text).match(EN_HINT) || []).length;
  return fr > en ? "fr" : "en";
}

function numberToWords(n, lang) {
  if (!Number.isSafeInteger(n) || n > 999_999_999_999) return String(n).split("");
  return lang === "fr" ? frWords(n) : enWords(n);
}

/**
 * Normalize text to a comparable word list: lowercase, no accents/punctuation,
 * numbers spelled out, common symbols spoken, hyphens split.
 */
export function normalizeForCompare(text, lang = guessLanguage(text)) {
  let s = String(text)
    .replace(/\[[^\]]{0,80}\]/g, " ") // stage directions are not spoken
    .replace(/\{([^|}]{1,80})\|[^}]{1,80}\}/g, "$1") // pronunciation hints → written word
    .replace(/\b([ap])\.?\s?m\.(?=\W|$)|\b([ap])m\b/gi, (_, a, b) => `${a || b}m`) // p.m. = pm
    .replace(/([$€£])\s?(\d[\d.,   ]*\d|\d)/g, "$2 $1") // "$5" is said "five dollars"
    .replace(/(\d+)(st|nd|rd|th|er|ère|e|ème|eme)\b/gi, "$1") // ordinals: compare the number
    .replace(/(\d)[   ](?=\d{3}\b)/g, "$1") // 1 000 → 1000
    .replace(/(\d),(?=\d{3}\b)/g, "$1") // 1,000 → 1000 (EN thousands)
    .replace(/(\d+)[.,](\d+)/g, (_, a, b) => `${a} ${lang === "fr" ? "virgule" : "point"} ${b}`)
    .replace(/%/g, lang === "fr" ? " pour cent " : " percent ")
    .replace(/€/g, " euros ")
    .replace(/£/g, " pounds ")
    .replace(/\$/g, " dollars ")
    .replace(/(\d)\s*h\s*(\d{2})\b/gi, "$1 heures $2") // 21 h 30
    .replace(/(\d)\s*h\b/gi, "$1 heures")
    .replace(/(\d)([a-z])/gi, "$1 $2") // 21h → 21 h, 3rd handled below
    .replace(/([a-z])(\d)/gi, "$1 $2")
    .replace(/&/g, lang === "fr" ? " et " : " and ");
  s = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
  const words = [];
  for (const w of s.split(/\s+/)) {
    if (!w) continue;
    if (/^\d+$/.test(w)) words.push(...numberToWords(Number(w), lang));
    else if (w === "m" && lang !== "fr") words.push(w);
    else words.push(...(ABBREVIATIONS[w] ?? [SPELLING[w] ?? w]));
  }
  // "one hundred AND twelve" vs "112": drop the optional "and" inside numbers.
  return words.filter((w, i) => !(w === "and" && NUMBER_WORDS.has(words[i - 1]) && NUMBER_WORDS.has(words[i + 1])));
}

// "GPT Voice" heard for "GPTVoice", "week end" for "week-end"/"weekend": same words.
function mergeCompounds(words, expectedSet) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const two = words[i] + (words[i + 1] ?? "");
    const three = two + (words[i + 2] ?? "");
    if (!expectedSet.has(words[i]) && i + 2 < words.length && expectedSet.has(three)) {
      out.push(three);
      i += 2;
    } else if (!expectedSet.has(words[i]) && i + 1 < words.length && expectedSet.has(two)) {
      out.push(two);
      i += 1;
    } else out.push(words[i]);
  }
  return out;
}

// French silent endings: "ils arrivent" and "il arrive" sound identical, so a
// transcriber may write either. Compare what is HEARD: drop silent plural
// -s/-x and the silent verb ending -ent.
function heardKey(w, lang) {
  if (lang !== "fr" || w.length < 3) return w;
  let k = w;
  if (k.length > 4 && k.endsWith("ent")) k = k.slice(0, -2);
  if (/[sx]$/.test(k) && k.length > 2) k = k.slice(0, -1);
  return k;
}

/** Levenshtein alignment on words; returns edit ops. */
function align(a, b) {
  const n = a.length;
  const m = b.length;
  const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      if (a[i - 1] !== b[j - 1]) ops.push({ op: "substituted", expected: a[i - 1], said: b[j - 1] });
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ op: "missing", expected: a[i - 1] });
      i--;
    } else {
      ops.push({ op: "added", said: b[j - 1] });
      j--;
    }
  }
  return { distance: d[n][m], ops: ops.reverse() };
}

/**
 * @returns {{accuracy: number, errors: number, words: number, ops: object[]}}
 *  accuracy = 1 - WER, clamped to [0, 1].
 */
export function wordAccuracy(expected, said, lang) {
  const language = lang || guessLanguage(expected);
  const a = normalizeForCompare(expected, language);
  // Transcripts annotate non-speech as (laughs), *sighs*, [music]; and laughter
  // comes out as "ha ha". Neither is a reading error unless the text has them.
  const expectedSet = new Set(a);
  const cleaned = String(said).replace(/\([^)]{0,80}\)|\*[^*]{0,80}\*/g, " ");
  const b = mergeCompounds(
    normalizeForCompare(cleaned, language).filter((w) => expectedSet.has(w) || !(INTERJECTIONS.has(w) || NONWORD.test(w))),
    expectedSet,
  );
  if (a.length === 0) return { accuracy: b.length === 0 ? 1 : 0, errors: b.length, words: 0, ops: [] };
  if (a.length * b.length > 4_000_000) {
    // Too big to align word by word: fall back to a cheap bag-of-words estimate.
    const bag = new Map();
    for (const w of b) bag.set(w, (bag.get(w) || 0) + 1);
    let hit = 0;
    for (const w of a) if (bag.get(w)) (hit++, bag.set(w, bag.get(w) - 1));
    const errors = a.length - hit + Math.max(0, b.length - a.length);
    return { accuracy: Math.max(0, 1 - errors / a.length), errors, words: a.length, ops: [] };
  }
  const { distance, ops } = align(a.map((w) => heardKey(w, language)), b.map((w) => heardKey(w, language)));
  return { accuracy: Math.max(0, 1 - distance / a.length), errors: distance, words: a.length, ops };
}

/** Human-readable summary of the first few differences. */
export function describeDiff(ops, max = 6) {
  return ops
    .slice(0, max)
    .map((o) => (o.op === "missing" ? `missing "${o.expected}"` : o.op === "added" ? `added "${o.said}"` : `"${o.expected}" → "${o.said}"`))
    .join(", ");
}
