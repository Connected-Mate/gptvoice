// The voice catalog.
//
// The realtime endpoint accepts exactly these 10 voices: any other name is
// rejected with this list ("sol" exists but answers "not available for your
// organization"). Verified 2026-10-05 against gpt-realtime-1.5 / -2 / -mini.
//
// Register, melody and pace tags are MEASURED (scripts/voice-samples.js →
// data/voice-metrics.json: median pitch, pitch spread, words per second,
// loudness on an EN + FR demo). Gender follows OpenAI's own presentation of
// each voice and agrees with the measured pitch. "character" tags are an
// editorial, subjective description.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VOICE_IDS = ["alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse"];
export const DEFAULT_VOICE = "marin";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const BASE = {
  alloy: { gender: "neutral", character: ["balanced", "clear", "versatile"], bestFor: ["e-learning", "assistant", "explainer"] },
  ash: { gender: "male", character: ["direct", "grounded", "mature"], bestFor: ["documentary", "corporate", "trailer"] },
  ballad: { gender: "male", character: ["expressive", "gentle", "storyteller"], bestFor: ["audiobook", "poetry", "character"] },
  cedar: { gender: "male", character: ["natural", "warm", "confident"], bestFor: ["narration", "podcast", "ad"], recommended: true },
  coral: { gender: "female", character: ["warm", "friendly", "lively"], bestFor: ["ad", "kids", "social video"] },
  echo: { gender: "male", character: ["calm", "steady", "resonant"], bestFor: ["meditation", "documentary", "announcement"] },
  marin: { gender: "female", character: ["natural", "polished", "warm"], bestFor: ["narration", "audiobook", "podcast"], recommended: true },
  sage: { gender: "female", character: ["gentle", "soft", "thoughtful"], bestFor: ["meditation", "intimate", "e-learning"] },
  shimmer: { gender: "female", character: ["bright", "airy", "youthful"], bestFor: ["ad", "social video", "character"] },
  verse: { gender: "male", character: ["versatile", "smooth", "storyteller"], bestFor: ["audiobook", "trailer", "character"] },
};

function loadMetrics() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "voice-metrics.json"), "utf8"));
  } catch {
    return {};
  }
}

const avg = (m, k) => (m?.en && m?.fr ? (m.en[k] + m.fr[k]) / 2 : (m?.en ?? m?.fr)?.[k]);

// Register is judged relative to the voice's gender range (male ≈ 85-180 Hz, female ≈ 165-255 Hz).
function measuredTags(gender, m) {
  const tags = [];
  const f0 = avg(m, "f0Median");
  const spread = avg(m, "f0Semitones");
  const wps = avg(m, "wordsPerSec");
  const db = avg(m, "loudnessDb");
  if (f0) {
    if (gender === "male") tags.push(f0 < 120 ? "deep" : f0 < 150 ? "mid-low" : "light");
    else if (gender === "female") tags.push(f0 < 170 ? "low" : f0 < 200 ? "mid" : "bright");
    else tags.push(f0 < 150 ? "mid-low" : "mid");
  }
  if (spread) tags.push(spread >= 3.2 ? "melodic" : spread <= 2.4 ? "steady" : "natural-intonation");
  if (wps) tags.push(wps >= 2.75 ? "brisk" : wps <= 2.4 ? "unhurried" : "medium-pace");
  if (db != null && db < -30) tags.push("soft-spoken");
  return { tags, f0: f0 ? Math.round(f0) : null, spread: spread ? Math.round(spread * 10) / 10 : null, wps: wps ? Math.round(wps * 100) / 100 : null, loudnessDb: db != null ? Math.round(db) : null };
}

const METRICS = loadMetrics();

export const VOICES = Object.fromEntries(
  VOICE_IDS.map((id) => {
    const b = BASE[id];
    const m = measuredTags(b.gender, METRICS[id]);
    return [
      id,
      {
        id,
        gender: b.gender,
        tags: [...m.tags, ...b.character],
        measured: { pitchHz: m.f0, pitchSpreadSemitones: m.spread, wordsPerSec: m.wps, loudnessDb: m.loudnessDb },
        character: b.character,
        bestFor: b.bestFor,
        recommended: Boolean(b.recommended),
        samples: {
          en: path.join(ROOT, "samples", "voices", `${id}-en.mp3`),
          fr: path.join(ROOT, "samples", "voices", `${id}-fr.mp3`),
        },
      },
    ];
  }),
);

/** Gain (dB) that brings this voice's typical level to the common reference. */
export function voiceGainDb(id, referenceDb = -20) {
  const db = VOICES[id]?.measured.loudnessDb;
  return db == null ? 0 : Math.max(-6, Math.min(12, referenceDb - db));
}

/** Filter the catalog. gender: male|female|neutral; tags: all must match (substring, case-insensitive). */
export function findVoices({ gender, tags, favorites, favoritesOnly } = {}) {
  const want = (Array.isArray(tags) ? tags : tags ? [tags] : []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  const fav = new Set(favorites ?? []);
  return Object.values(VOICES).filter((v) => {
    if (gender && v.gender !== String(gender).toLowerCase()) return false;
    if (favoritesOnly && !fav.has(v.id)) return false;
    const hay = [...v.tags, ...v.bestFor].map((t) => t.toLowerCase());
    return want.every((t) => hay.some((h) => h.includes(t)));
  });
}

export function describeVoice(v, favorites = []) {
  const star = favorites.includes(v.id) ? " ★" : "";
  const rec = v.recommended ? " (recommended)" : "";
  const m = v.measured.pitchHz ? ` · pitch ~${v.measured.pitchHz} Hz, ${v.measured.wordsPerSec} words/s` : "";
  return `${v.id}${star}${rec} — ${v.gender}; ${v.tags.join(", ")}; best for ${v.bestFor.join(", ")}${m}`;
}
