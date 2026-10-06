#!/usr/bin/env node
// Acting battery: each mode × several realtime models, plus a neutral reading
// for comparison. Measures expressiveness and word accuracy.
//   node bench/acting.js [--models gpt-realtime-1.5,gpt-realtime-2.1] [--only id]
import fs from "node:fs/promises";
import path from "node:path";
import { generateSpeech } from "../src/tts.js";
import { decodeToPcm } from "../src/transcribe.js";
import { contourPcm, windowStats } from "../src/analysis.js";
import { ACTING } from "./acting-items.js";

const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const models = arg("models", "gpt-realtime-1.5,gpt-realtime-2,gpt-realtime-2.1,gpt-realtime-2.1-mini").split(",");
const only = arg("only", "").split(",").filter(Boolean);
const OUT = path.resolve(arg("out", "samples/listening-test/acting"));
const TAKES = Number(arg("takes", 0)) || undefined;
const resultsFile = path.join(OUT, "results.json");
let results = {};
try {
  results = JSON.parse(await fs.readFile(resultsFile, "utf8"));
} catch {}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};
// Expressiveness metrics: pitch range (semitones between 10th and 90th pct of voiced
// frames), loudness range (dB between 10th/90th pct of active 50 ms windows), pace.
function expressiveness(pcm, words) {
  const c = contourPcm(pcm);
  const f0 = [...c.f0].filter(Boolean);
  const st = windowStats(c);
  const loud = [];
  for (let k = 0; k + 5 <= c.rms.length; k += 5) {
    let e = 0;
    for (let i = k; i < k + 5; i++) e += c.rms[i] * c.rms[i];
    const db = 10 * Math.log10(e / 5 || 1e-12);
    if (db > -45) loud.push(db);
  }
  const r = (v) => Math.round(v * 10) / 10;
  return {
    pitchHz: st.f0Median,
    pitchRangeSt: f0.length ? r(12 * Math.log2(pct(f0, 0.9) / pct(f0, 0.1))) : 0,
    loudRangeDb: r(pct(loud, 0.9) - pct(loud, 0.1)),
    wordsPerSec: r(words / (st.activeSec || 1)),
    voicedRatio: st.voicedRatio,
  };
}

const jobs = [];
for (const it of ACTING) {
  if (only.length && !only.includes(it.id)) continue;
  for (const model of models) {
    jobs.push({ it, model, neutral: false });
    jobs.push({ it, model, neutral: true });
  }
}
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { it, model, neutral } = jobs[next++];
    const dir = path.join(OUT, model);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${it.id}${neutral ? ".neutral" : ""}.mp3`);
    for (const ext of [".mp3", ".srt", ".timings.json"]) await fs.rm(file.replace(/\.mp3$/, ext), { force: true });
    const text = neutral ? it.text.replace(/\[(?!pause)[^\]]*\]\s*/g, "") : it.text;
    try {
      const r = await generateSpeech({ text, voice: it.voice, acting: neutral ? undefined : it.acting, takes: TAKES, model, language: it.lang === "fr" ? "French" : "English", out: file, verify: true, subtitles: true, manifest: true });
      const words = r.transcript ? text.replace(/\[[^\]]*\]/g, "").split(/\s+/).filter(Boolean).length : 0;
      const m = expressiveness(await decodeToPcm(r.savedPath), words);
      results[`${model}|${it.id}|${neutral ? "neutral" : "acted"}`] = { file: path.relative(OUT, r.savedPath), durationSec: r.durationSec, accuracy: r.accuracy, verifiedAccuracy: r.verifiedAccuracy, warnings: r.warnings, ...m };
      process.stderr.write(`${model} ${it.id} ${neutral ? "neutral" : "acted"} acc=${r.verifiedAccuracy ?? r.accuracy} pitchRange=${m.pitchRangeSt}st loudRange=${m.loudRangeDb}dB wps=${m.wordsPerSec}\n`);
    } catch (e) {
      results[`${model}|${it.id}|${neutral ? "neutral" : "acted"}`] = { error: e.message };
      process.stderr.write(`${model} ${it.id} ERROR ${e.message}\n`);
    }
    await fs.writeFile(resultsFile, JSON.stringify(results, null, 2) + "\n");
  }
}
await Promise.all(Array.from({ length: Number(arg("concurrency", 4)) }, worker));
