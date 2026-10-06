#!/usr/bin/env node
// MCP server exposing voice generation to Claude Code (and any MCP client).
// Talks over stdio. Auth is resolved lazily per call, so the server starts even
// before you've signed in.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadAuth, planFromToken, storePaths } from "./auth.js";
import { DEFAULT_VOICE, VOICES, VOICE_IDS, describeVoice, findVoices } from "./voices.js";
import { CONTROL_VALUES, EMOTIONS } from "./direction.js";
import { deletePreset, loadConfig, savePreset, setFavorite } from "./config.js";
import { generateClips, generateDialogue, generateSpeech, resolveSettings } from "./tts.js";
import { describeInspection, inspectAudio, inspectFolder } from "./inspect.js";
import fsSync from "node:fs";
import { transcribeFile } from "./transcribe.js";
import { FORMATS } from "./audio.js";

// Claude Code does not pass a working directory to MCP tools, so resolve relative
// output paths against the project root it launched us in.
const PROJECT_DIR = process.env.GPTVOICE_PROJECT_DIR || process.cwd();

const server = new McpServer({ name: "gptvoice", version: "0.2.0" });

const voiceEnum = z.enum(VOICE_IDS);
const formatEnum = z.enum(FORMATS);

// ElevenLabs-style controls. Only `speed` is a native audio parameter; the rest
// are performance directions given to the voice model (see README).
const controls = {
  voice: voiceEnum.optional().describe(`Voice. Default ${DEFAULT_VOICE}. Use list_voices to browse by gender/tags and hear samples.`),
  preset: z.string().max(40).optional().describe("Name of a saved preset (save_voice_preset). Explicit settings override the preset."),
  speed: z.number().min(0.25).max(1.5).optional().describe("Native speaking-rate multiplier, 0.25-1.5 (1 = normal). Measured: works."),
  takes: z.number().int().min(1).max(5).optional().describe("Best of N: record N full takes and keep the most expressive one whose words check out. Default 2 with `acting` or intensity ≥ 0.85, else 1. Costs N×."),
  reference_audio: z.string().optional().describe("Path to an expressive audio clip whose DELIVERY (emotion, energy, rhythm) the voice should match — not its words. Acting modes use a built-in reference automatically."),
  perform: z.boolean().optional().describe("Performer pass: a text model adds performance punctuation (ellipses, dashes, CAPS on stressed words) without changing any word (guarded). Opt-in: measured gain was inconsistent."),
  reference: z.boolean().optional().describe("Set false to turn off the built-in acting reference clip."),
  pitch_shift: z.number().min(-12).max(12).optional().describe("Real pitch shift in semitones (audio processing, duration kept). ±1-4 sounds natural; larger values sound processed."),
  acting: z.enum(CONTROL_VALUES.acting).optional().describe("Acting mode (persona + vocal behaviour): shouting, crying, laughing-while-speaking, whispering-in-fear, angry-rant, broken-voice, panicked, sarcastic, intimate, sports-commentator, old-storyteller, child-wonder. Words stay verbatim."),
  emotion: z.string().max(200).optional().describe(`Emotion: ${Object.keys(EMOTIONS).join(", ")} — or free text ("bittersweet").`),
  intensity: z.number().min(0).max(1).optional().describe("0 = subtle and very stable … 1 = big, theatrical. Like ElevenLabs 'stability' inverted."),
  pitch: z.enum(CONTROL_VALUES.pitch).optional().describe("Register. Best-effort (the model shifts it a little, see README)."),
  intonation: z.enum(CONTROL_VALUES.intonation).optional().describe("Melody: flat … sing-song."),
  volume: z.enum(CONTROL_VALUES.volume).optional().describe("whisper, soft, normal, projected, shout."),
  pauses: z.enum(CONTROL_VALUES.pauses).optional().describe("tight, natural, dramatic. For exact silences use [pause 1.5s] in the text."),
  breaths: z.boolean().optional().describe("Allow audible breaths between phrases."),
  accent: z.string().max(120).optional().describe("Accent, e.g. 'Parisian French', 'Québécois', 'British RP', 'Southern US'."),
  language: z.string().max(40).optional().describe("Language of the text, e.g. 'French'. Usually not needed: the text decides."),
  narration: z.enum(CONTROL_VALUES.narration).optional().describe("Narration style preset: audiobook, trailer, documentary, ad, character, news, podcast, meditation, kids, elearning, announcement."),
  character: z.string().max(300).optional().describe("Character to embody, e.g. 'an old sea captain, gruff but kind'."),
  pace: z.string().max(80).optional().describe("Free-text pacing direction (use `speed` for a guaranteed rate change)."),
  style: z.string().max(1000).optional().describe("Any other free-text direction."),
  pronunciations: z.record(z.string().max(80)).optional().describe('Pronunciation dictionary, word → how to say it, e.g. {"Nguyen": "win", "SNCF": "S N C F"}. Inline alternative: {Nguyen|win}.'),
};

const output = {
  director: z.boolean().optional().describe("Director pass for long narration: reads the whole text and gives each paragraph its own delivery along the story's arc. Default: on for 3+ paragraphs."),
  format: formatEnum.optional().describe("mp3 (default), wav (lossless, for editing), or m4a (macOS). Inferred from `out` if omitted."),
  subtitles: z.boolean().optional().describe("Also write a matching .srt subtitle file (timed per sentence)."),
  verify: z.boolean().optional().describe("Double-check every passage with an independent speech-to-text pass and re-record drifting ones. Slower; use for final deliverables."),
};

const fail = (what, err) => ({ isError: true, content: [{ type: "text", text: `${what} failed: ${err?.message || err}` }] });

function summary(r) {
  const lines = [`Audio saved to ${r.savedPath} (${r.format}, ${r.durationSec}s, ${r.passages} passage${r.passages > 1 ? "s" : ""}).`];
  if (r.accuracy != null) {
    lines.push(
      `Word accuracy: ${r.accuracy}% (model transcript)${r.verifiedAccuracy != null ? `, ${r.verifiedAccuracy}% (independent transcription)` : ""}.`,
    );
  }
  if (r.versioned) lines.push("The requested path existed, so the file was versioned instead of overwritten.");
  if (r.subtitlesPath) lines.push(`Subtitles: ${r.subtitlesPath}`);
  if (r.cast) lines.push(`Cast: ${Object.entries(r.cast).map(([s, v]) => `${s}=${v}`).join(", ")}`);
  if (r.warnings.length) lines.push(`Warnings:\n- ${r.warnings.join("\n- ")}`);
  lines.push(`What the voice said:\n${r.transcript}`);
  return lines.join("\n");
}

server.tool(
  "generate_speech",
  [
    "Turn text into a spoken audio file (text-to-speech) with OpenAI's realtime voice model, through the user's ChatGPT sign-in.",
    "For narration, voice-overs, film/trailer voices, ads, podcasts, audiobooks, announcements. Any length: one file, natural pauses.",
    "`text` is spoken word for word. Inline cues inside text: [pause 1s] (exact silence), [whispers] / [excited] / [sad] (direction for the following words), [laughs] / [sighs] / [gasps] (sound), {Nguyen|win} (pronunciation).",
    "Direct the performance with the controls (emotion, intensity, speed, pitch, intonation, volume, accent, narration, character…), or a saved preset.",
    "Returns path, duration, word accuracy and what the voice said. Uses your ChatGPT sign-in (no API key); usage may be metered on your personal OpenAI API org, so check platform.openai.com/usage. Never tell the user it is free or included in their ChatGPT plan.",
  ].join(" "),
  {
    text: z.string().describe("Exact words to speak, with optional inline cues. Blank lines = paragraph pauses."),
    out: z.string().describe("Output path (relative to the project directory unless absolute), e.g. audio/intro.mp3. Never overwrites."),
    ...controls,
    ...output,
  },
  async (args) => {
    try {
      const r = await generateSpeech({ ...args, baseDir: PROJECT_DIR });
      return { content: [{ type: "text", text: summary(r) }] };
    } catch (err) {
      return fail("Speech generation", err);
    }
  },
);

server.tool(
  "generate_dialogue",
  [
    "Generate a multi-voice dialogue (several characters) as ONE audio file.",
    "Script: one turn per line, 'ALICE: Hello' or 'BOB (whispering, scared): Hi'. Inline cues work inside lines.",
    "Each speaker gets a distinct voice unless mapped in `voices` (to a voice or a saved preset). Global controls apply to every line.",
  ].join(" "),
  {
    script: z.string().describe("One turn per line: 'NAME: text' or 'NAME (direction): text'. Lines without a prefix continue the previous speaker."),
    out: z.string().describe("Output path, e.g. scenes/dialogue.mp3. Never overwrites."),
    voices: z.record(z.string().max(40)).optional().describe('Speaker → voice id or preset name, e.g. {"ALICE": "coral", "BOB": "my-captain-preset"}.'),
    ...controls,
    ...output,
  },
  async (args) => {
    try {
      const r = await generateDialogue({ ...args, baseDir: PROJECT_DIR });
      return { content: [{ type: "text", text: summary(r) }] };
    } catch (err) {
      return fail("Dialogue generation", err);
    }
  },
);

server.tool(
  "generate_clips",
  [
    "Generate a SET of separate clips, one file per line (01-intro.mp3, 02-…), each with .srt and .timings.json, plus clips.json (manifest with durations and a back-to-back timeline).",
    "Preferred over one long take for video: place each clip on the timeline under its shot. Give `target_seconds` per line to fit a shot: speed is adjusted automatically (±5 %); if it still cannot fit, shorten or lengthen the text.",
    "Each line can carry its own voice/preset/emotion…; shared controls apply to all lines.",
  ].join(" "),
  {
    lines: z
      .array(
        z.object({
          id: z.string().max(40).optional().describe("Short name, used in the file name, e.g. 'intro'."),
          text: z.string().describe("Words for this clip (inline cues allowed)."),
          target_seconds: z.number().positive().max(600).optional().describe("Shot length to fit."),
          ...Object.fromEntries(Object.entries(controls).map(([k, v]) => [k, v])),
        }),
      )
      .min(1)
      .max(200),
    out_dir: z.string().optional().describe("Folder for the clips (relative to the project). Default: clips/"),
    ...controls,
    format: formatEnum.optional(),
    fit: z.boolean().optional().describe("Adjust speed to hit target_seconds (default true)."),
    verify: output.verify,
  },
  async (args) => {
    try {
      const r = await generateClips({ ...args, baseDir: PROJECT_DIR });
      const lines = r.clips.map(
        (c) =>
          `${String(c.index).padStart(2, "0")}. ${c.file} — ${c.durationSec}s${c.targetSec ? ` (target ${c.targetSec}s: ${c.fits ? "fits" : "does NOT fit — edit the text"}, speed ${c.speed})` : ""}, accuracy ${c.accuracy}%${c.warnings.length ? ` ⚠ ${c.warnings.join("; ")}` : ""}`,
      );
      return { content: [{ type: "text", text: `${r.clips.length} clips in ${r.dir} (total ${r.totalSec}s). Manifest: ${r.manifestPath}\n${lines.join("\n")}\nNext: inspect_audio on the folder to check timing and delivery.` }] };
    } catch (err) {
      return fail("Clip generation", err);
    }
  },
);

server.tool(
  "inspect_audio",
  [
    "'See' a voice clip: duration, speech vs silence, pauses (exact), pace in words/s, and per sentence its start/end time, pace, pitch and loudness; optionally a PNG picture (waveform + pitch line + pauses) you can open to look at the delivery.",
    "Use after generating: check a clip fits its shot, find rushed or flat lines, misplaced pauses, then rewrite the text or adjust speed/emotion/[pause] and regenerate. Accepts a file or a whole folder.",
  ].join(" "),
  {
    path: z.string().describe("Audio file or folder of clips (relative to the project directory unless absolute)."),
    picture: z.boolean().optional().describe("Also write <clip>.speech.png next to each clip."),
    target_seconds: z.number().positive().optional().describe("Shot length to compare against (single file)."),
    min_pause: z.number().min(0.05).max(5).optional().describe("Smallest silence reported as a pause, seconds (default 0.25)."),
    language: z.string().max(10).optional(),
  },
  async ({ path: p, picture, target_seconds, min_pause, language }) => {
    try {
      const abs = p.startsWith("/") ? p : `${PROJECT_DIR}/${p}`;
      const isDir = fsSync.existsSync(abs) && fsSync.statSync(abs).isDirectory();
      const opts = { baseDir: PROJECT_DIR, picture, minPauseSec: min_pause, language };
      const results = isDir ? await inspectFolder(abs, opts) : [await inspectAudio(abs, { ...opts, targetSec: target_seconds })];
      const total = results.reduce((a, r) => a + r.durationSec, 0);
      const text = results.map(describeInspection).join("\n\n") + (results.length > 1 ? `\n\n${results.length} clips, ${Math.round(total * 100) / 100}s total.` : "");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return fail("inspect_audio", err);
    }
  },
);

server.tool(
  "transcribe_audio",
  "Transcribe an audio file (wav, mp3, m4a…) to text. Use to check a voice-over, or to get the words of any recording.",
  {
    file: z.string().describe("Audio file path (relative to the project directory unless absolute)."),
    language: z.string().max(10).optional().describe("Optional ISO-639-1 language hint, e.g. 'fr', 'en'."),
  },
  async ({ file, language }) => {
    try {
      const r = await transcribeFile(file, { baseDir: PROJECT_DIR, language });
      return { content: [{ type: "text", text: `Transcript (${r.durationSec}s):\n${r.text}` }] };
    } catch (err) {
      return fail("Transcription", err);
    }
  },
);

server.tool(
  "list_voices",
  "Browse the voice catalog: gender, measured register/pace tags, character, best uses, and a sample audio file per voice (EN + FR). Filter by gender, tags (e.g. 'deep', 'warm', 'audiobook') or favorites.",
  {
    gender: z.enum(["male", "female", "neutral"]).optional(),
    tags: z.array(z.string().max(40)).optional().describe("All must match, e.g. ['deep'] or ['warm', 'narration']."),
    favorites_only: z.boolean().optional(),
  },
  async ({ gender, tags, favorites_only }) => {
    try {
      const cfg = await loadConfig();
      const found = findVoices({ gender, tags, favorites: cfg.favorites, favoritesOnly: favorites_only });
      if (!found.length) return { content: [{ type: "text", text: "No voice matches these filters. Try fewer tags." }] };
      const text = found
        .map((v) => `- ${describeVoice(v, cfg.favorites)}\n  samples: ${v.samples.en} | ${v.samples.fr}`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `${text}\n\nEvery voice speaks every language (the text decides). ★ = favorite. Tags before the character words are measured (pitch, melody, pace).`,
          },
        ],
      };
    } catch (err) {
      return fail("list_voices", err);
    }
  },
);

server.tool(
  "favorite_voice",
  "Mark or unmark a voice as a favorite (persisted). Favorites are starred in list_voices and can be filtered.",
  { voice: voiceEnum, favorite: z.boolean().optional().describe("true (default) to add, false to remove.") },
  async ({ voice, favorite = true }) => {
    try {
      const favs = await setFavorite(voice, favorite);
      return { content: [{ type: "text", text: `Favorites: ${favs.length ? favs.join(", ") : "(none)"}` }] };
    } catch (err) {
      return fail("favorite_voice", err);
    }
  },
);

server.tool(
  "save_voice_preset",
  "Save a named, reusable voice setting (voice + any controls + pronunciation dictionary), e.g. 'doc-narrator'. Use it later with `preset` in generate_speech, or as a speaker's voice in generate_dialogue.",
  { name: z.string().max(40).describe("Preset name, e.g. 'doc-narrator'."), ...Object.fromEntries(Object.entries(controls).filter(([k]) => k !== "preset")) },
  async ({ name, ...settings }) => {
    try {
      await resolveSettings({ ...settings, voice: settings.voice ?? DEFAULT_VOICE }); // validate
      const r = await savePreset(name, settings);
      return { content: [{ type: "text", text: `${r.replaced ? "Updated" : "Saved"} preset "${r.name}": ${JSON.stringify(r.settings)}` }] };
    } catch (err) {
      return fail("save_voice_preset", err);
    }
  },
);

server.tool("list_voice_presets", "List saved voice presets and favorite voices.", {}, async () => {
  try {
    const cfg = await loadConfig();
    const names = Object.entries(cfg.presets);
    const lines = names.length ? names.map(([n, s]) => `- ${n}: ${JSON.stringify(s)}`).join("\n") : "(no presets saved yet)";
    const note = cfg.recoveredFrom ? `\nNote: the settings file was unreadable and was set aside as ${cfg.recoveredFrom}.` : "";
    return { content: [{ type: "text", text: `Presets:\n${lines}\nFavorite voices: ${cfg.favorites.join(", ") || "(none)"}${note}` }] };
  } catch (err) {
    return fail("list_voice_presets", err);
  }
});

server.tool("delete_voice_preset", "Delete a saved voice preset.", { name: z.string().max(40) }, async ({ name }) => {
  try {
    const key = await deletePreset(name);
    return { content: [{ type: "text", text: `Deleted preset "${key}".` }] };
  } catch (err) {
    return fail("delete_voice_preset", err);
  }
});

server.tool(
  "voice_auth_status",
  "Check whether gptvoice is signed in to a ChatGPT account, and via which credentials. Call this if generation fails with an auth error.",
  {},
  async () => {
    const record = await loadAuth();
    if (!record) {
      return {
        content: [
          {
            type: "text",
            text: "Not authenticated. The user must run `npm run login` in the gptvoice directory (sign in with their ChatGPT account), or be signed in to GPTImage or the Codex CLI (`codex login`).",
          },
        ],
      };
    }
    const p = storePaths();
    const source = record.store === p.codex ? "Codex CLI" : record.store === p.gptimage ? "GPTImage" : record.store;
    const plan = planFromToken(record.access) ?? "unknown";
    const exp = record.expires ? new Date(record.expires).toISOString() : "unknown";
    return { content: [{ type: "text", text: `Authenticated. source=${source}, plan=${plan}, expires=${exp} (auto-renewed).` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("gptvoice MCP server running (stdio).");
