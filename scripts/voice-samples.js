#!/usr/bin/env node
// Record a short EN + FR demo of every voice, measure it (pitch, melody, pace)
// and write data/voice-metrics.json. The catalog in src/voices.js derives its
// register tags from these measurements.
//   node scripts/voice-samples.js
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getValidCredentials } from "../src/auth.js";
import { synthesizeChunk } from "../src/realtime.js";
import { buildInstructions } from "../src/direction.js";
import { encode, trimSilence } from "../src/audio.js";
import { analyzePcm } from "../src/analysis.js";
import { wordAccuracy } from "../src/accuracy.js";
import { VOICE_IDS } from "../src/voices.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEXT = {
  en: (v) => `Hello, I'm ${v}. I can narrate your stories, voice your videos, and bring your characters to life.`,
  fr: (v) => `Bonjour, je suis ${v}. Je peux raconter vos histoires, doubler vos vidéos et donner vie à vos personnages.`,
};
const creds = await getValidCredentials();
const metrics = {};
await Promise.all(
  VOICE_IDS.map(async (voice) => {
    metrics[voice] = {};
    for (const lang of ["en", "fr"]) {
      const text = TEXT[lang](voice.charAt(0).toUpperCase() + voice.slice(1));
      let best;
      for (let i = 0; i < 3; i++) {
        const r = await synthesizeChunk(creds, { instructions: buildInstructions(text, { language: lang === "fr" ? "French" : "English" }), voice });
        const acc = wordAccuracy(text, r.transcript, lang).accuracy;
        if (!best || acc > best.acc) best = { ...r, acc };
        if (acc === 1) break;
      }
      const pcm = trimSilence(best.pcm);
      await fs.writeFile(path.join(ROOT, "samples/voices", `${voice}-${lang}.mp3`), await encode(pcm, "mp3"));
      const a = analyzePcm(pcm);
      metrics[voice][lang] = { ...a, wordsPerSec: Math.round((text.split(/\s+/).length / a.durationSec) * 100) / 100, accuracy: best.acc };
      process.stderr.write(`${voice} ${lang} f0=${a.f0Median}Hz spread=${a.f0Semitones}st ${a.durationSec}s acc=${best.acc}\n`);
    }
  }),
);
const sorted = Object.fromEntries(Object.entries(metrics).sort());
await fs.writeFile(path.join(ROOT, "data/voice-metrics.json"), JSON.stringify(sorted, null, 2) + "\n");
console.log(JSON.stringify(sorted, null, 2));
