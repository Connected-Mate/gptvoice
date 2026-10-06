#!/usr/bin/env node
// Expressiveness lever search (small budget): each lever vs the acting baseline
// on 3 emotions × 2 voices. Every take is checked word-for-word by transcription.
//   node bench/levers.js [--only lever]
import fs from "node:fs/promises";
import path from "node:path";
import { getValidCredentials } from "../src/auth.js";
import { synthesizeChunk, transcribePcm } from "../src/realtime.js";
import { buildInstructions } from "../src/direction.js";
import { performScript } from "../src/performer.js";
import { smoothTrim, roomTone, encode, normalizeLoudness, fadeEdges, crossfadeConcat } from "../src/audio.js";
import { decodeToPcm } from "../src/transcribe.js";
import { contourPcm, windowStats } from "../src/analysis.js";
import { wordAccuracy } from "../src/accuracy.js";
import { VOICES } from "../src/voices.js";

const OUT = path.resolve("samples/listening-test/levers");
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const only = arg("only", "");
const creds = await getValidCredentials();

export const CELLS = [
  { id: "cry-coral", emotion: "crying", acting: "crying", voice: "coral", text: "I waited all night by the phone. He never called. He promised me he would.", ref: "acting/gpt-realtime-1.5/crying.mp3" },
  { id: "cry-marin", emotion: "crying", acting: "crying", voice: "marin", text: "I waited all night by the phone. He never called. He promised me he would.", ref: "acting/gpt-realtime-1.5/crying.mp3" },
  { id: "shout-ash", emotion: "shouting", acting: "shouting", voice: "ash", text: "Hey! Over here! Grab the rope, the boat is drifting away!", ref: "acting/gpt-realtime-1.5/shouting.mp3" },
  { id: "shout-cedar", emotion: "shouting", acting: "shouting", voice: "cedar", text: "Hey! Over here! Grab the rope, the boat is drifting away!", ref: "acting/gpt-realtime-1.5/shouting.mp3" },
  { id: "excited-verse", emotion: "excited", acting: "sports-commentator", voice: "verse", text: "We did it! We actually won the whole championship, I can't believe it!", ref: "acting/gpt-realtime-1.5/sports-commentator.mp3" },
  { id: "excited-marin", emotion: "excited", acting: "child-wonder", voice: "marin", text: "We did it! We actually won the whole championship, I can't believe it!", ref: "acting/gpt-realtime-1.5/child-wonder.mp3" },
];

const SCENES = {
  crying: "You are a stage actor recording a radio drama. Your character is a young woman alone in her kitchen at dawn; the man she loved promised to call before leaving the country forever, and the phone never rang. She is breaking down as she says these words.",
  shouting: "You are a stage actor recording a radio drama. Your character is a sailor on a stormy dock at night; a friend's boat has slipped its line and is drifting toward the rocks, the wind is howling, and he must be heard over it RIGHT NOW or someone will die.",
  excited: "You are a stage actor recording a radio drama. Your character has just watched their underdog team win the championship in the last second, after twenty years of losing; they are jumping, out of breath, overflowing with joy.",
};
const PRIMING = {
  crying: ["(sobbing) No… no, no… please, not again…", "(voice breaking) I can't… I can't breathe…"],
  shouting: ["(yelling over the wind) LOOK OUT! THE ROPE!", "(screaming) NOW! DO IT NOW!"],
  excited: ["(screaming with joy) YES! YES! YES!", "(laughing, breathless) Oh my God, oh my God!"],
};

async function render(cell, lever, n = 1) {
  const controls = { acting: cell.acting, language: "English" };
  let script = cell.text;
  let preItems = [];
  if (lever === "framing") controls.character = SCENES[cell.emotion];
  if (lever === "performer" || lever === "framing+performer") script = (await performScript(cell.text, { emotion: cell.emotion })).script;
  if (lever === "framing+performer") controls.character = SCENES[cell.emotion];
  if (lever === "priming") {
    preItems = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Warm-up: stay fully in this emotional state for the whole recording." }] },
      ...PRIMING[cell.emotion].map((t) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text: t }] })),
    ];
  }
  if (lever === "audioref") {
    const ref = await decodeToPcm(path.resolve("samples/listening-test", cell.ref));
    preItems = [
      { type: "message", role: "user", content: [{ type: "input_audio", audio: smoothTrim(ref).toString("base64") }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "The audio above is a DELIVERY REFERENCE: match its emotion, energy and rhythm in your performance — not its words and not its voice." }] },
    ];
  }
  const r = await synthesizeChunk(creds, { instructions: buildInstructions(script, controls), voice: cell.voice, preItems });
  return { ...r, script };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};
export function expressiveness(pcm, voice) {
  const c = contourPcm(pcm);
  const f0 = [...c.f0].filter(Boolean);
  const st = windowStats(c);
  const loud = [];
  for (let k = 0; k + 5 <= c.rms.length; k += 5) {
    let e = 0;
    for (let i = k; i < k + 5; i++) e += c.rms[i] ** 2;
    const d = 10 * Math.log10(e / 5 || 1e-12);
    if (d > -45) loud.push(d);
  }
  const base = VOICES[voice]?.measured.pitchHz || st.f0Median || 1;
  const pitchRangeSt = f0.length ? 12 * Math.log2(pct(f0, 0.9) / pct(f0, 0.1)) : 0;
  const loudRangeDb = pct(loud, 0.9) - pct(loud, 0.1);
  const pitchShiftSt = Math.abs(12 * Math.log2((st.f0Median || base) / base));
  const r = (v) => Math.round(v * 10) / 10;
  return { pitchRangeSt: r(pitchRangeSt), loudRangeDb: r(loudRangeDb), pitchShiftSt: r(pitchShiftSt), score: r(pitchRangeSt + loudRangeDb / 2 + pitchShiftSt) };
}

async function finish(cell, lever, r, tag) {
  const pcm = smoothTrim(r.pcm);
  const file = path.join(OUT, lever, `${cell.id}${tag}.mp3`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const full = fadeEdges(crossfadeConcat([roomTone(250), normalizeLoudness(pcm), roomTone(400)], { xfadeMs: 40 }));
  await fs.writeFile(file, await encode(full, "mp3"));
  const heard = await transcribePcm(creds, Buffer.concat([roomTone(300), pcm, roomTone(300)]), { language: "en" });
  const acc = wordAccuracy(cell.text, heard, "en").accuracy;
  return { file: path.relative(path.resolve("samples/listening-test"), file), script: r.script, own: wordAccuracy(cell.text, r.transcript, "en").accuracy, accuracy: acc, heard, ...expressiveness(pcm, cell.voice) };
}

const resultsFile = path.join(OUT, "results.json");
let results = {};
try {
  results = JSON.parse(await fs.readFile(resultsFile, "utf8"));
} catch {}
const LEVERS = ["baseline", "framing", "priming", "audioref", "performer"];
const jobs = [];
for (const lever of LEVERS) if (!only || only === lever) for (const cell of CELLS) jobs.push({ cell, lever, tag: "" });
if (!only || only === "bestof") for (const cell of CELLS.slice(0, 2)) for (const k of [2, 3]) jobs.push({ cell, lever: "baseline", tag: `.take${k}` });
if (only === "framing+performer") for (const cell of CELLS) jobs.push({ cell, lever: "framing+performer", tag: "" });
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const j = jobs[next++];
    try {
      const r = await render(j.cell, j.lever);
      const m = await finish(j.cell, j.lever, r, j.tag);
      results[`${j.lever}|${j.cell.id}${j.tag}`] = m;
      process.stderr.write(`${j.lever} ${j.cell.id}${j.tag} score=${m.score} (pitchRange ${m.pitchRangeSt}st, loudRange ${m.loudRangeDb}dB, shift ${m.pitchShiftSt}st) acc=${(m.accuracy * 100).toFixed(0)}% own=${(m.own * 100).toFixed(0)}%\n`);
    } catch (e) {
      results[`${j.lever}|${j.cell.id}${j.tag}`] = { error: e.message };
      process.stderr.write(`${j.lever} ${j.cell.id} ERROR ${e.message}\n`);
    }
    await fs.writeFile(resultsFile, JSON.stringify(results, null, 2) + "\n");
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
