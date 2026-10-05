#!/usr/bin/env node
// A/B test: does each control measurably change the audio?
// Same sentence, same voice; baseline vs. each control value, several takes.
// Measures duration, median pitch, pitch spread (melody), loudness, voiced ratio,
// plus word accuracy by independent transcription (a control must not break the words).
//   node bench/ab-controls.js [--voice marin] [--reps 2]
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSpeech } from "../src/tts.js";
import { analyzePcm } from "../src/analysis.js";
import { decodeToPcm, transcribeFile } from "../src/transcribe.js";
import { wordAccuracy } from "../src/accuracy.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const voice = arg("voice", "marin");
const reps = Number(arg("reps", 2));
const TEXT = "The storm came early that night, and the old keeper climbed the stairs to light the lamp once more.";

const CASES = [
  ["baseline", {}],
  ["speed 0.75", { speed: 0.75 }],
  ["speed 1.3", { speed: 1.3 }],
  ["pitch very-low", { pitch: "very-low" }],
  ["pitch very-high", { pitch: "very-high" }],
  ["volume whisper", { volume: "whisper" }],
  ["volume shout", { volume: "shout" }],
  ["intonation flat", { intonation: "flat" }],
  ["intonation expressive", { intonation: "expressive" }],
  ["intensity 0", { intensity: 0, emotion: "excitement" }],
  ["intensity 1", { intensity: 1, emotion: "excitement" }],
  ["emotion sadness", { emotion: "sadness" }],
  ["emotion excitement", { emotion: "excitement" }],
  ["emotion anger", { emotion: "anger" }],
  ["pauses tight", { pauses: "tight" }],
  ["pauses dramatic", { pauses: "dramatic" }],
  ["narration trailer", { narration: "trailer" }],
  ["narration ad", { narration: "ad" }],
  ["narration meditation", { narration: "meditation" }],
  ["pitch_shift -4", { pitch_shift: -4 }],
  ["pitch_shift +4", { pitch_shift: 4 }],
  ["accent Scottish", { accent: "strong Scottish" }],
  ["cue [pause 1s]", { text: "The storm came early that night, [pause 1s] and the old keeper climbed the stairs to light the lamp once more." }],
  ["cue [whispers]", { text: "[whispers] The storm came early that night, and the old keeper climbed the stairs to light the lamp once more." }],
  ["cue [excited]", { text: "[excited] The storm came early that night, and the old keeper climbed the stairs to light the lamp once more." }],
  ["cue [sad]", { text: "[sad] The storm came early that night, and the old keeper climbed the stairs to light the lamp once more." }],
  ["cue [sighs]", { text: "[sighs] The storm came early that night, and the old keeper climbed the stairs to light the lamp once more." }],
  ["cue [laughs]", { text: "[laughs] The storm came early that night, and the old keeper climbed the stairs to light the lamp once more." }],
];

const only = arg("only", "");
if (only) CASES.splice(0, CASES.length, ...CASES.filter(([n]) => n === "baseline" || n.includes(only)));
const outDir = path.join(ROOT, "samples", "ab");
const results = {};
let next = 0;
const jobs = CASES.flatMap(([name, opts]) => Array.from({ length: name === "baseline" ? reps + 2 : reps }, (_, r) => ({ name, opts, r })));
async function worker() {
  while (next < jobs.length) {
    const { name, opts, r } = jobs[next++];
    const slug = name.replace(/\+/g, " plus ").replace(/ -(?=\d)/g, " minus ").replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "").toLowerCase();
    const file = path.join(outDir, r === 0 ? `${voice}-${process.env.GPTVOICE_PROMPT || "v2"}-${slug}.mp3` : `.take-${voice}-${process.env.GPTVOICE_PROMPT || "v2"}-${slug}-${r}.mp3`);
    await fs.rm(file, { force: true });
    const res = await generateSpeech({ text: TEXT, voice, ...opts, out: file, normalize: false });
    const pcm = await decodeToPcm(res.savedPath);
    const a = analyzePcm(pcm);
    const heard = (await transcribeFile(res.savedPath, { language: "en" })).text;
    const acc = wordAccuracy(TEXT, heard, "en").accuracy;
    (results[name] ??= []).push({ ...a, acc });
    if (r > 0) await fs.rm(res.savedPath, { force: true });
    process.stderr.write(`${name} #${r} dur=${a.durationSec} f0=${a.f0Median} spread=${a.f0Semitones} dB=${a.loudnessDb} voiced=${a.voicedRatio} acc=${acc.toFixed(2)}\n`);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));

const mean = (xs, k) => xs.reduce((s, x) => s + x[k], 0) / xs.length;
const base = results.baseline;
const noise = (k) => Math.max(...base.map((x) => x[k])) - Math.min(...base.map((x) => x[k]));
const keys = [["durationSec", "s"], ["f0Median", "Hz"], ["f0Semitones", "st"], ["loudnessDb", "dB"], ["voicedRatio", ""]];
console.log(`\nVoice ${voice}. Baseline (${base.length} takes): ` + keys.map(([k, u]) => `${k}=${mean(base, k).toFixed(2)}${u} (±${(noise(k) / 2).toFixed(2)})`).join(", "));
console.log("control                  Δdur(s)  Δpitch(Hz)  Δmelody(st)  Δloud(dB)  Δvoiced   accuracy  verdict");
const table = [];
for (const [name] of CASES.slice(1)) {
  const xs = results[name];
  const d = Object.fromEntries(keys.map(([k]) => [k, mean(xs, k) - mean(base, k)]));
  const strong = keys.filter(([k]) => Math.abs(d[k]) > Math.max(noise(k), 1e-9) * 1.0 && Math.abs(d[k]) > { durationSec: 0.4, f0Median: 8, f0Semitones: 0.4, loudnessDb: 2, voicedRatio: 0.06 }[k]);
  const verdict = strong.length ? `changes ${strong.map(([k]) => k.replace(/Sec|Median|Semitones|Db|Ratio/, "")).join("+")}` : "no measurable change";
  const acc = mean(xs, "acc");
  table.push({ name, ...d, accuracy: acc, verdict });
  console.log(
    `${name.padEnd(24)} ${d.durationSec.toFixed(2).padStart(7)}  ${d.f0Median.toFixed(0).padStart(10)}  ${d.f0Semitones.toFixed(2).padStart(11)}  ${d.loudnessDb.toFixed(1).padStart(9)}  ${d.voicedRatio.toFixed(2).padStart(7)}   ${(acc * 100).toFixed(0).padStart(6)}%   ${verdict}`,
  );
}
await fs.writeFile(path.join(ROOT, "data", `ab-controls-${voice}-${process.env.GPTVOICE_PROMPT || "v2"}${only ? `-${only.replace(/[^a-z0-9]+/gi, "")}` : ""}.json`), JSON.stringify({ voice, text: TEXT, baseline: base, results, table }, null, 2) + "\n");
