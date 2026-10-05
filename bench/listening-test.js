#!/usr/bin/env node
// Render the listening-test battery with THIS checkout's pipeline.
//   node bench/listening-test.js <outDir> [--only id]
// Writes <outDir>/<id>.mp3 (or a clips folder) + results.json (metrics).
import fs from "node:fs/promises";
import path from "node:path";
import { generateSpeech, generateDialogue, generateClips } from "../src/tts.js";

const out = path.resolve(process.argv[2]);
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : "";
const { ITEMS } = await import(path.resolve(process.argv[3] || "bench/listening-items.js"));
await fs.mkdir(out, { recursive: true });
const resultsFile = path.join(out, "results.json");
let results = {};
try {
  results = JSON.parse(await fs.readFile(resultsFile, "utf8"));
} catch {}
for (const it of ITEMS) {
  if (only && it.id !== only) continue;
  const t0 = Date.now();
  try {
    if (it.kind === "clips") {
      const dir = path.join(out, it.id);
      await fs.rm(dir, { recursive: true, force: true });
      const r = await generateClips({ ...it.opts, lines: it.lines, out_dir: dir, verify: true });
      results[it.id] = { files: r.clips.map((c) => ({ file: path.relative(out, c.file), durationSec: c.durationSec, targetSec: c.targetSec, fits: c.fits, accuracy: c.accuracy })), totalSec: r.totalSec };
    } else {
      const file = path.join(out, `${it.id}.mp3`);
      for (const ext of [".mp3", ".srt", ".timings.json"]) await fs.rm(file.replace(/\.mp3$/, ext), { force: true });
      const common = { out: file, subtitles: true, verify: true, manifest: true };
      const r = it.kind === "dialogue" ? await generateDialogue({ ...common, ...it.opts, script: it.text }) : await generateSpeech({ ...common, ...it.opts, text: it.text });
      results[it.id] = { file: path.relative(out, r.savedPath), durationSec: r.durationSec, passages: r.passages, accuracy: r.accuracy, verifiedAccuracy: r.verifiedAccuracy, warnings: r.warnings };
    }
    console.log(`${it.id} ok (${Math.round((Date.now() - t0) / 1000)}s)`);
  } catch (e) {
    results[it.id] = { error: e.message };
    console.log(`${it.id} ERROR ${e.message}`);
  }
  await fs.writeFile(resultsFile, JSON.stringify(results, null, 2) + "\n");
}
