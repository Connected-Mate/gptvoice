#!/usr/bin/env node
// Record a short EN + FR demo of every voice, measure it (pitch, melody, pace)
// and write data/voice-metrics.json. The catalog in src/voices.js derives its
// register tags from these measurements.
//   node scripts/voice-samples.js
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSpeech } from "../src/tts.js";
import { decodeToPcm } from "../src/transcribe.js";
import { analyzePcm } from "../src/analysis.js";
import { VOICE_IDS } from "../src/voices.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEXT = {
  en: (v) => `Hello, I'm ${v}. I can narrate your stories, voice your videos, and bring your characters to life.`,
  fr: (v) => `Bonjour, je suis ${v}. Je peux raconter vos histoires, doubler vos vidéos et donner vie à vos personnages.`,
};
const metrics = {};
await Promise.all(
  VOICE_IDS.map(async (voice) => {
    metrics[voice] = {};
    for (const lang of ["en", "fr"]) {
      const text = TEXT[lang](voice.charAt(0).toUpperCase() + voice.slice(1));
      const file = path.join(ROOT, "samples/voices", `${voice}-${lang}.mp3`);
      await fs.rm(file, { force: true });
      // Same smooth pipeline as every user file, verified by independent transcription.
      const r = await generateSpeech({ text, voice, language: lang === "fr" ? "French" : "English", out: file, verify: true });
      const pcm = await decodeToPcm(file);
      const a = analyzePcm(pcm);
      metrics[voice][lang] = { ...a, wordsPerSec: Math.round((text.split(/\s+/).length / a.activeSec) * 100) / 100, accuracy: (r.verifiedAccuracy ?? r.accuracy) / 100 };
      process.stderr.write(`${voice} ${lang} f0=${a.f0Median}Hz spread=${a.f0Semitones}st ${a.durationSec}s acc=${r.verifiedAccuracy}%\n`);
    }
  }),
);
const sorted = Object.fromEntries(Object.entries(metrics).sort());
await fs.writeFile(path.join(ROOT, "data/voice-metrics.json"), JSON.stringify(sorted, null, 2) + "\n");
console.log(JSON.stringify(sorted, null, 2));
