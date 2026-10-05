#!/usr/bin/env node
// Render the demo set (and the smoothness A/B extras) with the current pipeline.
//   node bench/demos.js <outDir> [--only name]
import path from "node:path";
import fs from "node:fs/promises";
import { generateSpeech, generateDialogue } from "../src/tts.js";
import { DEMOS } from "./demo-texts.js";

const out = path.resolve(process.argv[2] || "samples/demo");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : "";
await fs.mkdir(out, { recursive: true });


for (const d of DEMOS) {
  if (only && d.name !== only) continue;
  const file = path.join(out, `${d.name}.mp3`);
  for (const ext of [".mp3", ".srt", ".timings.json"]) await fs.rm(file.replace(/\.mp3$/, ext), { force: true });
  const common = { out: file, subtitles: true, manifest: true, verify: true };
  const r = d.dialogue
    ? await generateDialogue({ ...common, script: d.dialogue, voices: d.voices })
    : await generateSpeech({ ...common, text: d.text, voice: d.voice, narration: d.narration, emotion: d.emotion });
  console.log(`${d.name}: ${r.durationSec}s, ${r.passages} passages, accuracy ${r.accuracy}% / verified ${r.verifiedAccuracy}%${r.warnings.length ? " ⚠ " + r.warnings.join("; ") : ""}`);
}
