#!/usr/bin/env node
// Prompt-engine benchmark on tricky FR + EN texts (numbers, names, acronyms,
// homographs, prompt injection, money, inline cues). Each passage is checked by
// an independent speech-to-text pass and scored as word accuracy (1 - WER),
// after normalization (numbers ↔ words, abbreviations, interjections).
//
//   first take : one recording per passage, no re-record (raw prompt quality)
//   delivered  : what users get — passages under the bar are re-recorded (≤2x)
//
//   node bench/run.js [--prompts v1,v2] [--models gpt-realtime-1.5,gpt-realtime-2] [--reps 3] [--mode first|delivered|both]
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSpeech } from "../src/tts.js";
import { CORPUS } from "./corpus.js";

const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const prompts = arg("prompts", "v2").split(",");
const models = arg("models", "gpt-realtime-1.5").split(",");
const reps = Number(arg("reps", 3));
const modes = arg("mode", "both") === "both" ? ["first", "delivered"] : [arg("mode")];
const voices = arg("voices", "marin,cedar").split(",");
const only = arg("only", "");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gptvoice-bench-"));

const jobs = [];
for (const prompt of prompts) for (const model of models) for (const mode of modes) for (const item of CORPUS) {
  if (only && !item.id.includes(only)) continue;
  for (let r = 0; r < reps; r++) jobs.push({ prompt, model, mode, item, voice: voices[r % voices.length] });
}
const rows = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const j = jobs[next++];
    process.env.GPTVOICE_PROMPT = j.prompt; // read at instruction-build time
    try {
      const r = await generateSpeech({
        text: j.item.text,
        voice: j.voice,
        language: j.item.lang === "fr" ? "French" : "English",
        model: j.model,
        verify: true,
        redos: j.mode === "first" ? 0 : undefined,
        out: path.join(dir, `${j.item.id}-${next}.wav`),
      });
      rows.push({ ...j, item: j.item.id, lang: j.item.lang, acc: r.verifiedAccuracy / 100, own: r.accuracy / 100, warnings: r.warnings });
      process.stderr.write(`${j.prompt} ${j.model} ${j.mode} ${j.voice} ${j.item.id} verified=${r.verifiedAccuracy}% own=${r.accuracy}% ${r.warnings.join(" | ").slice(0, 160)}\n`);
    } catch (e) {
      rows.push({ ...j, item: j.item.id, error: e.message });
      process.stderr.write(`${j.item.id} ERROR ${e.message}\n`);
    }
  }
}
await Promise.all(Array.from({ length: Number(arg("concurrency", 3)) }, worker));
await fs.rm(dir, { recursive: true, force: true });

const groups = {};
for (const r of rows.filter((x) => !x.error)) {
  const k = `${r.prompt} | ${r.model} | ${r.mode.padEnd(9)} | ${r.lang}`;
  (groups[k] ??= []).push(r);
}
console.log("\nprompt | model | mode      | lang   takes  word-acc(STT)  perfect  worst");
for (const [k, xs] of Object.entries(groups).sort()) {
  const mean = xs.reduce((s, x) => s + x.acc, 0) / xs.length;
  const worst = xs.reduce((a, b) => (b.acc < a.acc ? b : a));
  console.log(`${k}   ${String(xs.length).padStart(5)}  ${(mean * 100).toFixed(1).padStart(11)}%  ${String(xs.filter((x) => x.acc >= 0.999).length).padStart(3)}/${xs.length}  ${(worst.acc * 100).toFixed(0)}% ${worst.item}`);
}
const errors = rows.filter((x) => x.error);
if (errors.length) console.log(`\n${errors.length} errors: ${[...new Set(errors.map((e) => e.error))].join("; ")}`);
const out = arg("out", "");
if (out) await fs.writeFile(out, JSON.stringify(rows, null, 2) + "\n");
