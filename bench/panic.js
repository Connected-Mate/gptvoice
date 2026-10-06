#!/usr/bin/env node
// Panic v2: rebuild the "panicked" mode and measure it against a neutral read.
import fs from "node:fs/promises";
import path from "node:path";
import { getValidCredentials } from "../src/auth.js";
import { synthesizeChunk, transcribePcm } from "../src/realtime.js";
import { buildInstructions } from "../src/direction.js";
import { performScript } from "../src/performer.js";
import { smoothTrim, roomTone, encode, normalizeLoudness, fadeEdges, crossfadeConcat } from "../src/audio.js";
import { decodeToPcm } from "../src/transcribe.js";
import { contourPcm, windowStats, segmentSpeech } from "../src/analysis.js";
import { wordAccuracy } from "../src/accuracy.js";

const OUT = path.resolve("samples/listening-test/panic");
const TEXT = "They're coming, they're right behind me, we have to go, now, run!";
const creds = await getValidCredentials();
const words = TEXT.split(/\s+/).length;

export function panicMetrics(pcm) {
  const c = contourPcm(pcm);
  const st = windowStats(c);
  const { pauses } = segmentSpeech(c, { minPauseSec: 0.12 });
  const r = (v) => Math.round(v * 100) / 100;
  return { wps: r(words / st.activeSec), pitchHz: st.f0Median, melodySt: st.f0Semitones, pauses: pauses.length, meanPauseSec: pauses.length ? r(pauses.reduce((a, p) => a + p.duration, 0) / pauses.length) : 0, activeSec: r(st.activeSec) };
}
async function save(name, pcm, script) {
  const p = smoothTrim(pcm);
  const file = path.join(OUT, `${name}.mp3`);
  await fs.writeFile(file, await encode(fadeEdges(crossfadeConcat([roomTone(250), normalizeLoudness(p), roomTone(400)], { xfadeMs: 40 })), "mp3"));
  const heard = await transcribePcm(creds, Buffer.concat([roomTone(300), p, roomTone(300)]), { language: "en" });
  return { file: `panic/${name}.mp3`, script, accuracy: Math.round(wordAccuracy(TEXT, heard, "en").accuracy * 1000) / 10, heard, ...panicMetrics(p) };
}
const res = {};
const take = async (name, { voice, model = "gpt-realtime-1.5", controls = { language: "English" }, script = TEXT, preItems = [] }) => {
  const r = await synthesizeChunk(creds, { instructions: buildInstructions(script, controls), voice, model, preItems });
  res[name] = { voice, model, ...(await save(name, r.pcm, script)) };
  process.stderr.write(`${name}: ${JSON.stringify(res[name]).slice(0, 220)}\n`);
  return r;
};
// Before (v1 prompt) = the existing acting take for echo; neutral references.
res["before-echo"] = { voice: "echo", model: "gpt-realtime-1.5", file: "acting/gpt-realtime-1.5/panicked.mp3", ...panicMetrics(smoothTrim(await decodeToPcm(path.resolve("samples/listening-test/acting/gpt-realtime-1.5/panicked.mp3")))), accuracy: null };
res["neutral-echo"] = { voice: "echo", model: "gpt-realtime-1.5", file: "acting/gpt-realtime-1.5/panicked.neutral.mp3", ...panicMetrics(smoothTrim(await decodeToPcm(path.resolve("samples/listening-test/acting/gpt-realtime-1.5/panicked.neutral.mp3")))), accuracy: null };
const performed = (await performScript(TEXT, { emotion: "pure panic: fast, breathless, broken sentences" })).script;
await Promise.all([
  take("neutral-marin", { voice: "marin" }),
  take("v2-echo", { voice: "echo", controls: { acting: "panicked", language: "English" } }),
  take("v2-marin", { voice: "marin", controls: { acting: "panicked", language: "English" } }),
  take("v2-performer-echo", { voice: "echo", controls: { acting: "panicked", language: "English" }, script: performed }),
  take("v2-performer-marin", { voice: "marin", controls: { acting: "panicked", language: "English" }, script: performed }),
  take("v2-rt21-echo", { voice: "echo", model: "gpt-realtime-2.1", controls: { acting: "panicked", language: "English" }, script: performed }),
  take("v2-rt21-marin", { voice: "marin", model: "gpt-realtime-2.1", controls: { acting: "panicked", language: "English" }, script: performed }),
]);
// Audio reference: the most panicked take so far (fastest + highest), sent as a delivery reference.
const cands = Object.entries(res).filter(([k]) => k.startsWith("v2-") && res[k].accuracy >= 90);
const score = (x, n) => (x.wps / n.wps - 1) * 10 + 12 * Math.log2(x.pitchHz / n.pitchHz) / 2 + (x.pauses - n.pauses);
const best = cands.sort((a, b) => score(b[1], res[`neutral-${b[1].voice}`]) - score(a[1], res[`neutral-${a[1].voice}`]))[0];
const refPcm = smoothTrim(await decodeToPcm(path.join(OUT, `${best[0]}.mp3`)));
const refItems = [
  { type: "message", role: "user", content: [{ type: "input_audio", audio: refPcm.toString("base64") }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "The audio above is a DELIVERY REFERENCE: match its panic, speed, breathlessness and broken rhythm — never its voice." }] },
];
await Promise.all([
  take("v2-ref-echo", { voice: "echo", controls: { acting: "panicked", language: "English" }, script: performed, preItems: refItems }),
  take("v2-ref-marin", { voice: "marin", controls: { acting: "panicked", language: "English" }, script: performed, preItems: refItems }),
]);
for (const [k, v] of Object.entries(res)) if (!k.startsWith("neutral")) v.panicScore = Math.round(score(v, res[`neutral-${v.voice}`]) * 10) / 10;
res._meta = { text: TEXT, performed, reference: best[0] };
await fs.writeFile(path.join(OUT, "results.json"), JSON.stringify(res, null, 2) + "\n");
for (const [k, v] of Object.entries(res)) if (!k.startsWith("_")) console.log(k.padEnd(20), "wps", v.wps, "pitch", v.pitchHz, "pauses", v.pauses, "acc", v.accuracy, "panicScore", v.panicScore ?? "-");
console.log("performed:", performed, "| reference:", best[0]);
