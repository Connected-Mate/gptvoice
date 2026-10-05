#!/usr/bin/env node
// Scan audio files for smoothness issues (clicks, hard cuts, cut-off endings…).
//   node bench/smooth-scan.js samples/demo samples/voices [--json out.json]
import fs from "node:fs/promises";
import path from "node:path";
import { decodeToPcm } from "../src/transcribe.js";
import { smoothness } from "../src/quality.js";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const targets = args.filter((a, i) => a !== "--json" && args[i - 1] !== "--json");
const files = [];
for (const t of targets) {
  const st = await fs.stat(t);
  if (st.isDirectory()) {
    for (const f of (await fs.readdir(t)).sort()) if (/\.(mp3|wav|m4a)$/i.test(f)) files.push(path.join(t, f));
  } else files.push(t);
}
const rows = [];
for (const f of files) {
  const pcm = await decodeToPcm(path.resolve(f));
  let joins = [];
  try {
    const m = JSON.parse(await fs.readFile(f.replace(/\.[^.]+$/, ".timings.json"), "utf8"));
    joins = m.passages.slice(1).map((p) => p.start);
  } catch {}
  const q = smoothness(pcm, joins);
  rows.push({ file: f, ...q });
  console.log(`${path.basename(f).padEnd(28)} clicks=${String(q.clicks).padStart(3)} abruptOn=${String(q.abruptOnsets).padStart(2)} abruptOff=${String(q.abruptOffsets).padStart(2)} head=${q.headDb}dB tail=${q.tailDb}dB${q.endsAbruptly ? " CUT-END" : ""}${q.startsAbruptly ? " HARD-START" : ""} zeroGaps=${q.digitalSilence.count}(${q.digitalSilence.seconds}s) clipped=${q.clippedSamples}`);
}
const sum = (k) => rows.reduce((a, r) => a + (typeof r[k] === "boolean" ? (r[k] ? 1 : 0) : r[k]), 0);
console.log(`\nTOTAL ${rows.length} files: clicks=${sum("clicks")} abruptOnsets=${sum("abruptOnsets")} abruptOffsets=${sum("abruptOffsets")} hardStarts=${sum("startsAbruptly")} cutEnds=${sum("endsAbruptly")} zeroGapFiles=${rows.filter((r) => r.digitalSilence.count).length} clipped=${sum("clippedSamples")}`);
if (jsonOut) await fs.writeFile(jsonOut, JSON.stringify(rows, null, 2) + "\n");
