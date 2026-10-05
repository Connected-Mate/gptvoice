#!/usr/bin/env node
// Command-line voice generation. Handy for testing and as a Bash-callable
// fallback when MCP isn't wired up.
//
//   node src/speak.js -t "Hello there" -o hello.mp3 --voice cedar --style "warm, slow"
//   node src/speak.js -f chapter1.txt -o chapter1.mp3 --subtitles
//   node src/speak.js --dialogue scene.txt -o scene.mp3 --cast "ALICE=coral,BOB=cedar"
//   node src/speak.js --transcribe interview.m4a
//   node src/speak.js --voices

import fs from "node:fs/promises";
import { VOICES } from "./realtime.js";
import { generateDialogue, generateSpeech } from "./tts.js";
import { transcribeFile } from "./transcribe.js";

const USAGE = `Usage:
  speak -t "text" | -f file.txt   -o out.mp3 [--voice marin] [--style "..."] [--format mp3|wav|m4a] [--subtitles]
  speak --dialogue script.txt     -o out.mp3 [--cast "ALICE=coral,BOB=cedar"] [--style "..."] [--subtitles]
  speak --transcribe audio.mp3    [--language fr]
  speak --voices`;

function parseArgs(argv) {
  const out = { baseDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value after ${a}\n\n${USAGE}`);
      return v;
    };
    if (a === "--text" || a === "-t") out.text = next();
    else if (a === "--file" || a === "-f") out.file = next();
    else if (a === "--out" || a === "-o") out.out = next();
    else if (a === "--voice" || a === "-v") out.voice = next();
    else if (a === "--style" || a === "-s") out.style = next();
    else if (a === "--format") out.format = next();
    else if (a === "--subtitles") out.subtitles = true;
    else if (a === "--dialogue" || a === "-d") out.dialogue = next();
    else if (a === "--cast") out.cast = next();
    else if (a === "--transcribe") out.transcribe = next();
    else if (a === "--language") out.language = next();
    else if (a === "--voices") out.listVoices = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown option ${a}\n\n${USAGE}`);
  }
  return out;
}

function parseCast(cast) {
  const map = {};
  for (const pair of String(cast || "").split(",")) {
    if (!pair.trim()) continue;
    const [name, voice] = pair.split("=").map((s) => s?.trim());
    if (!name || !voice) throw new Error(`bad --cast entry "${pair}" (expected NAME=voice)`);
    map[name] = voice;
  }
  return map;
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err?.code || err?.message}`);
  }
}

const progress = (d, n) => process.stderr.write(`\r  speaking passage ${d}/${n}…`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  if (args.listVoices) {
    for (const [k, v] of Object.entries(VOICES)) console.log(`${k.padEnd(8)} ${v}`);
    return;
  }
  if (args.transcribe) {
    process.stderr.write("Transcribing…\n");
    const r = await transcribeFile(args.transcribe, { baseDir: args.baseDir, language: args.language });
    console.log(r.text);
    return;
  }
  if (!args.out) throw new Error(`--out is required\n\n${USAGE}`);
  let r;
  if (args.dialogue) {
    const script = await readText(args.dialogue);
    r = await generateDialogue({ script, voices: parseCast(args.cast), style: args.style, format: args.format, out: args.out, baseDir: args.baseDir, subtitles: args.subtitles, onProgress: progress });
  } else {
    const text = args.file ? await readText(args.file) : args.text;
    if (!text) throw new Error(`give text with -t "..." or -f file.txt\n\n${USAGE}`);
    r = await generateSpeech({ text, voice: args.voice, style: args.style, format: args.format, out: args.out, baseDir: args.baseDir, subtitles: args.subtitles, onProgress: progress });
  }
  process.stderr.write("\n");
  console.log(`${r.savedPath}  (${r.durationSec}s${r.versioned ? ", versioned to avoid overwrite" : ""})`);
  if (r.subtitlesPath) console.log(r.subtitlesPath);
  for (const w of r.warnings) console.error("⚠ " + w);
}

main().catch((err) => {
  console.error("\n✗ " + (err?.message || err));
  process.exit(1);
});
