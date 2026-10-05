#!/usr/bin/env node
// Command-line voice generation. Handy for testing and as a Bash-callable
// fallback when MCP isn't wired up.
//
//   speak -t "Hello there" -o hello.mp3 --voice cedar --emotion joy --speed 1.1
//   speak -f chapter1.txt -o chapter1.mp3 --narration audiobook --subtitles --verify
//   speak --dialogue scene.txt -o scene.mp3 --cast "ALICE=coral,BOB=cedar"
//   speak --voices [--gender female] [--tag warm]
//   speak --save-preset doc --voice cedar --narration documentary --speed 0.95
//   speak --presets | --delete-preset doc | --favorite cedar | --unfavorite cedar
//   speak --transcribe interview.m4a

import fs from "node:fs/promises";
import { describeVoice, findVoices } from "./voices.js";
import { generateClips, generateDialogue, generateSpeech, resolveSettings } from "./tts.js";
import { describeInspection, inspectAudio, inspectFolder } from "./inspect.js";
import { statSync } from "node:fs";
import { transcribeFile } from "./transcribe.js";
import { deletePreset, loadConfig, savePreset, setFavorite } from "./config.js";

const USAGE = `Usage:
  speak -t "text" | -f file.txt   -o out.mp3 [voice & controls] [--format mp3|wav|m4a] [--subtitles] [--verify]
  speak --dialogue script.txt     -o out.mp3 [--cast "ALICE=coral,BOB=my-preset"] [controls]
  speak --voices [--gender male|female|neutral] [--tag deep] [--favorites]
  speak --save-preset NAME [voice & controls]     speak --presets     speak --delete-preset NAME
  speak --favorite VOICE | --unfavorite VOICE
  speak --transcribe audio.mp3 [--language fr]
  speak --clips lines.json [--out-dir clips] [controls]     (lines.json: [{"id":"intro","text":"…","target_seconds":4}])
  speak --inspect clip.mp3|folder [--picture] [--target 4.5] [--min-pause 0.25]

Voice & controls:
  --voice marin  --preset NAME  --speed 0.25-1.5  --pitch-shift -12..12 (semitones)  --emotion joy|sadness|anger|fear|excitement|tenderness|calm|…
  --acting shouting|crying|laughing-while-speaking|whispering-in-fear|angry-rant|broken-voice|panicked|sarcastic|intimate|sports-commentator|old-storyteller|child-wonder
  --intensity 0-1  --pitch very-low|low|normal|high|very-high  --intonation flat|natural|expressive|sing-song
  --volume whisper|soft|normal|projected|shout  --pauses tight|natural|dramatic  --breaths
  --accent "British RP"  --language French  --narration audiobook|trailer|documentary|ad|character|news|podcast|meditation|kids|elearning|announcement
  --character "an old sea captain"  --pace "slow"  --style "free text"  --say "Nguyen=win"  (repeatable)

Inline cues in the text: [pause 1s] [whispers] [excited] [laughs] [sighs] {Nguyen|win}`;

const VALUE_FLAGS = {
  "--text": "text", "-t": "text", "--file": "file", "-f": "file", "--out": "out", "-o": "out",
  "--voice": "voice", "-v": "voice", "--preset": "preset", "--speed": "speed", "--pitch-shift": "pitch_shift", "--emotion": "emotion",
  "--intensity": "intensity", "--acting": "acting", "--pitch": "pitch", "--intonation": "intonation", "--volume": "volume",
  "--pauses": "pauses", "--accent": "accent", "--language": "language", "--narration": "narration",
  "--character": "character", "--pace": "pace", "--style": "style", "-s": "style", "--format": "format",
  "--dialogue": "dialogue", "-d": "dialogue", "--cast": "cast", "--transcribe": "transcribe",
  "--gender": "gender", "--tag": "tag", "--save-preset": "savePreset", "--delete-preset": "deletePreset",
  "--favorite": "favorite", "--unfavorite": "unfavorite", "--model": "model",
  "--clips": "clips", "--out-dir": "outDir", "--inspect": "inspect", "--target": "target", "--min-pause": "minPause",
};
const BOOL_FLAGS = { "--director": "director", "--picture": "picture", "--subtitles": "subtitles", "--verify": "verify", "--breaths": "breaths", "--voices": "listVoices", "--presets": "listPresets", "--favorites": "favoritesOnly", "--help": "help", "-h": "help" };

function parseArgs(argv) {
  const out = { baseDir: process.cwd(), tags: [], say: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS[a]) {
      out[BOOL_FLAGS[a]] = true;
      continue;
    }
    const key = VALUE_FLAGS[a] ?? (a === "--say" ? "say" : null);
    if (!key) throw new Error(`unknown option ${a}\n\n${USAGE}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value after ${a}\n\n${USAGE}`);
    if (key === "tag") out.tags.push(v);
    else if (key === "say") {
      const eq = v.indexOf("=");
      if (eq < 1) throw new Error(`bad --say "${v}" (expected WORD=pronunciation)`);
      out.say[v.slice(0, eq).trim()] = v.slice(eq + 1).trim();
    } else out[key] = v;
  }
  if (out.speed != null) out.speed = Number(out.speed);
  if (out.intensity != null) out.intensity = Number(out.intensity);
  if (out.pitch_shift != null) out.pitch_shift = Number(out.pitch_shift);
  if (Object.keys(out.say).length) out.pronunciations = out.say;
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
const CONTROL_KEYS = ["voice", "preset", "speed", "pitch_shift", "acting", "emotion", "intensity", "pitch", "intonation", "volume", "pauses", "breaths", "accent", "language", "narration", "character", "pace", "style", "pronunciations"];
const controlsOf = (a) => Object.fromEntries(CONTROL_KEYS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  if (args.listVoices) {
    const cfg = await loadConfig();
    const found = findVoices({ gender: args.gender, tags: args.tags, favorites: cfg.favorites, favoritesOnly: args.favoritesOnly });
    for (const v of found) console.log(`${describeVoice(v, cfg.favorites)}\n    ${v.samples.en}\n    ${v.samples.fr}`);
    if (!found.length) console.log("No voice matches these filters.");
    return;
  }
  if (args.listPresets) {
    const cfg = await loadConfig();
    const entries = Object.entries(cfg.presets);
    console.log(entries.length ? entries.map(([n, s]) => `${n}: ${JSON.stringify(s)}`).join("\n") : "(no presets saved yet)");
    console.log(`favorites: ${cfg.favorites.join(", ") || "(none)"}`);
    return;
  }
  if (args.savePreset) {
    const { preset, ...settings } = controlsOf(args);
    await resolveSettings({ ...settings, voice: settings.voice ?? "marin" });
    const r = await savePreset(args.savePreset, settings);
    return console.log(`${r.replaced ? "Updated" : "Saved"} preset "${r.name}": ${JSON.stringify(r.settings)}`);
  }
  if (args.deletePreset) return console.log(`Deleted preset "${await deletePreset(args.deletePreset)}".`);
  if (args.favorite || args.unfavorite) {
    const voice = (args.favorite || args.unfavorite).toLowerCase();
    await resolveSettings({ voice });
    return console.log(`favorites: ${(await setFavorite(voice, Boolean(args.favorite))).join(", ") || "(none)"}`);
  }
  if (args.inspect) {
    const isDir = statSync(args.inspect, { throwIfNoEntry: false })?.isDirectory();
    const opts = { baseDir: args.baseDir, picture: args.picture, minPauseSec: args.minPause ? Number(args.minPause) : undefined, language: args.language };
    const rs = isDir ? await inspectFolder(args.inspect, opts) : [await inspectAudio(args.inspect, { ...opts, targetSec: args.target ? Number(args.target) : undefined })];
    console.log(rs.map(describeInspection).join("\n\n"));
    return;
  }
  if (args.clips) {
    let lines;
    try {
      lines = JSON.parse(await readText(args.clips));
    } catch (err) {
      throw new Error(`cannot parse ${args.clips} as JSON: ${err.message}`);
    }
    const r = await generateClips({ ...controlsOf(args), lines, out_dir: args.outDir ?? "clips", format: args.format, baseDir: args.baseDir, verify: args.verify, onProgress: (d, n) => process.stderr.write(`\r  clip ${d}/${n}…`) });
    process.stderr.write("\n");
    for (const c of r.clips) console.log(`${c.file}  ${c.durationSec}s${c.targetSec ? ` / target ${c.targetSec}s ${c.fits ? "✓" : "✗ edit the text"} (speed ${c.speed})` : ""}`);
    console.log(`manifest: ${r.manifestPath} · total ${r.totalSec}s`);
    return;
  }
  if (args.transcribe) {
    process.stderr.write("Transcribing…\n");
    const r = await transcribeFile(args.transcribe, { baseDir: args.baseDir, language: args.language });
    console.log(r.text);
    return;
  }
  if (!args.out) throw new Error(`--out is required\n\n${USAGE}`);
  const common = { ...controlsOf(args), director: args.director || undefined, format: args.format, out: args.out, baseDir: args.baseDir, subtitles: args.subtitles, verify: args.verify, model: args.model, onProgress: progress };
  let r;
  if (args.dialogue) {
    r = await generateDialogue({ ...common, script: await readText(args.dialogue), voices: parseCast(args.cast) });
  } else {
    const text = args.file ? await readText(args.file) : args.text;
    if (!text) throw new Error(`give text with -t "..." or -f file.txt\n\n${USAGE}`);
    r = await generateSpeech({ ...common, text });
  }
  process.stderr.write("\n");
  console.log(`${r.savedPath}  (${r.durationSec}s${r.versioned ? ", versioned to avoid overwrite" : ""})`);
  if (r.accuracy != null) console.log(`word accuracy: ${r.accuracy}%${r.verifiedAccuracy != null ? ` · verified by transcription: ${r.verifiedAccuracy}%` : ""}`);
  if (r.subtitlesPath) console.log(r.subtitlesPath);
  for (const w of r.warnings) console.error("⚠ " + w);
}

main().catch((err) => {
  console.error("\n✗ " + (err?.message || err));
  process.exit(1);
});
