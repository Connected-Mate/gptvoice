#!/usr/bin/env node
// Long-narration liveliness: same long FR text, several voice/direction variants.
// Measures overall melody, sentence-to-sentence pitch and pace variation, loudness range.
//   node bench/monotony.js
import fs from "node:fs/promises";
import path from "node:path";
import { generateSpeech } from "../src/tts.js";
import { inspectAudio } from "../src/inspect.js";
import { ITEMS } from "./listening-items.js";

const OUT = path.resolve("samples/listening-test/after/08-variants");
await fs.mkdir(OUT, { recursive: true });
const text = ITEMS.find((i) => i.id === "08-fr-long-2min").text;
export const VARIANTS = [
  { id: "marin-storyteller", label: "marin + old-storyteller", opts: { voice: "marin", acting: "old-storyteller" } },
  { id: "cedar-storyteller", label: "cedar + old-storyteller", opts: { voice: "cedar", acting: "old-storyteller" } },
  { id: "verse-audiobook", label: "verse + audiobook", opts: { voice: "verse", narration: "audiobook" } },
  { id: "coral-audiobook", label: "coral + audiobook", opts: { voice: "coral", narration: "audiobook" } },
  { id: "marin-director", label: "marin + audiobook + director pass", opts: { voice: "marin", narration: "audiobook", director: true } },
  { id: "coral-director", label: "coral + audiobook + director pass", opts: { voice: "coral", narration: "audiobook", director: true } },
  { id: "verse-director", label: "verse + audiobook + director pass", opts: { voice: "verse", narration: "audiobook", director: true } },
  { id: "cedar-storyteller-director", label: "cedar + old-storyteller + director pass", opts: { voice: "cedar", acting: "old-storyteller", director: true } },
];
const sd = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
export function liveliness(r) {
  const s = r.sentences.filter((x) => x.pitchHz && x.wordsPerSec);
  const ref = s.reduce((a, x) => a + x.pitchHz, 0) / s.length;
  return {
    melodySt: r.melodySemitones,
    sentencePitchSdSt: Math.round(sd(s.map((x) => 12 * Math.log2(x.pitchHz / ref))) * 100) / 100,
    sentenceRateSd: Math.round(sd(s.map((x) => x.wordsPerSec)) * 100) / 100,
    sentenceLoudSdDb: Math.round(sd(s.map((x) => x.loudnessDb)) * 100) / 100,
    durationSec: r.durationSec,
  };
}
const resultsFile = path.join(OUT, "results.json");
let results = {};
try {
  results = JSON.parse(await fs.readFile(resultsFile, "utf8"));
} catch {}
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : "";
// Baseline: the current test-8 "after" render.
const base = path.resolve("samples/listening-test/after/08-fr-long-2min.mp3");
results.baseline = { label: "marin + audiobook (current)", file: "../08-fr-long-2min.mp3", ...liveliness(await inspectAudio(base, { transcribe: false })), accuracy: JSON.parse(await fs.readFile(path.resolve("samples/listening-test/after/results.json"), "utf8"))["08-fr-long-2min"].verifiedAccuracy };
await Promise.all(
  VARIANTS.filter((v) => !only || v.id === only).map(async (v) => {
    const file = path.join(OUT, `${v.id}.mp3`);
    for (const ext of [".mp3", ".srt", ".timings.json"]) await fs.rm(file.replace(/\.mp3$/, ext), { force: true });
    const r = await generateSpeech({ ...v.opts, text, language: "French", out: file, verify: true, subtitles: true, manifest: true });
    const m = liveliness(await inspectAudio(file, { transcribe: false }));
    results[v.id] = { label: v.label, file: `${v.id}.mp3`, ...m, accuracy: r.verifiedAccuracy, director: r.director ?? null };
    console.error(`${v.id}: melody ${m.melodySt} st, sentence pitch sd ${m.sentencePitchSdSt} st, rate sd ${m.sentenceRateSd}, loud sd ${m.sentenceLoudSdDb} dB, ${m.durationSec}s, acc ${r.verifiedAccuracy}%`);
  }),
);
await fs.writeFile(resultsFile, JSON.stringify(results, null, 2) + "\n");
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(28)} melody=${v.melodySt} pitchSd=${v.sentencePitchSdSt} rateSd=${v.sentenceRateSd} loudSd=${v.sentenceLoudSdDb} dur=${v.durationSec}s acc=${v.accuracy}`);
