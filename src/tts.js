// Orchestration: narration and multi-voice dialogue → one audio file.
//
// 1. Settings are resolved: preset (if any) < explicit arguments.
// 2. Text is split into paragraphs, then at inline cues ([pause 1s], [whispers],
//    [laughs]…, see cues.js), then into sentence-aligned chunks.
// 3. Each chunk is spoken in its own short realtime session (a few in parallel,
//    order preserved) with instructions from the prompt engine (direction.js).
// 4. Every chunk is checked word by word — against the model's own transcript,
//    or, with `verify`, against an independent speech-to-text pass — and
//    re-recorded when it drifts.
// 5. Edges are trimmed, levels evened out per voice, pauses inserted exactly,
//    and the result is encoded once (MP3/WAV/M4A, optional SRT).

import path from "node:path";
import fs from "node:fs/promises";

import { getValidCredentials } from "./auth.js";
import { synthesizeChunk, transcribePcm } from "./realtime.js";
import { VoiceError } from "./errors.js";
import { DEFAULT_VOICE, VOICES, voiceGainDb } from "./voices.js";
import { START_CUE, buildInstructions, validateSpeed, deliveryLines } from "./direction.js";
import { parseCues, scriptOf, expectedOf } from "./cues.js";
import { getPreset, PRESET_FIELDS } from "./config.js";
import { directParagraphs } from "./director.js";
import { wordAccuracy, describeDiff } from "./accuracy.js";
import { MAX_PITCH_SHIFT, SAMPLE_RATE, applyGainDb, crossfadeConcat, encode, fadeEdges, fillDigitalSilence, pitchShift, normalizeLoudness, pcmDurationSec, resolveFormat, roomTone, saveAudio, smoothTrim, withExtension } from "./audio.js";
import { MAX_TEXT_CHARS, chunkText, parseScript } from "./text.js";

const CONCURRENCY = Math.max(1, Number(process.env.GPTVOICE_CONCURRENCY) || 3);
const RETRY_BASE_MS = Number(process.env.GPTVOICE_RETRY_BASE_MS ?? 2000);
const MIN_ACCURACY = 0.9; // against the model's own transcript
const MIN_VERIFIED_ACCURACY = 0.85; // against independent STT (which has its own errors)
const MAX_REDOS = 2;
// Gaps are room tone added AFTER each take's natural tail (~160 ms kept by
// smoothTrim), so the heard pause is roughly gap + 0.2 s.
const CHUNK_PAUSE_MS = 150;
const PARAGRAPH_PAUSE_MS = 600;
const DIALOGUE_PAUSE_MS = 300;
const HEAD_ROOM_MS = 250; // room tone before the first word
const TAIL_ROOM_MS = 500; // room tone after the last word
const XFADE_MS = 40; // equal-power crossfade at every join
const MAX_CHUNK_CHARS = 900; // whole sentences, ~1 paragraph per take
const CONTEXT_CHARS = 220;
const DIALOGUE_VOICE_ROTATION = ["marin", "cedar", "coral", "ash", "sage", "verse", "shimmer", "echo", "ballad", "alloy"];
// Placeholder that keeps "{New York|nu york}" in one piece while chunking.
const HINT_SPACE = "⁣";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function validateVoice(voice) {
  const v = String(voice || DEFAULT_VOICE).toLowerCase().trim();
  if (!VOICES[v]) {
    throw new VoiceError(`unknown voice "${voice}". Available voices: ${Object.keys(VOICES).join(", ")}`, "invalid");
  }
  return v;
}

function validateText(text) {
  const t = String(text ?? "").trim();
  if (!t) throw new VoiceError("there is no text to speak (the text is empty)", "invalid");
  if (t.length > MAX_TEXT_CHARS) {
    throw new VoiceError(
      `text is too long (${t.length.toLocaleString("en")} characters, max ${MAX_TEXT_CHARS.toLocaleString("en")}). Split it into several files.`,
      "invalid",
    );
  }
  return t;
}

function validatePronunciations(p) {
  if (p == null) return undefined;
  if (typeof p !== "object" || Array.isArray(p)) throw new VoiceError('pronunciations must be an object like {"Nguyen": "win"}', "invalid");
  return p;
}

/** Merge a named preset (if any) under the explicit settings, and validate everything. */
export async function resolveSettings(opts) {
  const preset = opts.preset ? await getPreset(opts.preset) : {};
  const s = {};
  for (const k of PRESET_FIELDS) s[k] = opts[k] ?? preset[k];
  if (preset.pronunciations && opts.pronunciations) s.pronunciations = { ...preset.pronunciations, ...opts.pronunciations };
  s.voice = validateVoice(s.voice);
  s.speed = validateSpeed(s.speed);
  if (s.pitch_shift != null) {
    const ps = Number(s.pitch_shift);
    if (!(Math.abs(ps) <= MAX_PITCH_SHIFT)) throw new VoiceError(`pitch_shift must be between -${MAX_PITCH_SHIFT} and ${MAX_PITCH_SHIFT} semitones`, "invalid");
    s.pitch_shift = ps;
  }
  s.pronunciations = validatePronunciations(s.pronunciations);
  deliveryLines(s); // throws on invalid control values, before any network call
  return s;
}

function controlsOf(s) {
  const { voice, speed, pitch_shift, pronunciations, ...controls } = s;
  return controls;
}

/** Credentials holder that can be force-refreshed once after a 401. `getCreds` is injectable for tests. */
function credentialSource(getCreds = getValidCredentials) {
  let current = null;
  let refreshedAfter401 = false;
  return {
    async get() {
      current ??= await getCreds();
      return current;
    },
    async refreshAfter401() {
      if (refreshedAfter401) return false;
      refreshedAfter401 = true;
      current = await getCreds({ force: true });
      return true;
    },
  };
}

async function withRetry(fn, creds, { maxAttempts = 4 } = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn(await creds.get());
    } catch (err) {
      const kind = err?.kind;
      if (kind === "auth" && (await creds.refreshAfter401().catch(() => false))) continue;
      const retryable = kind === "rate_limit" || kind === "network" || kind === "server" || kind === "timeout";
      if (!retryable || attempt >= maxAttempts) {
        if (kind === "rate_limit") {
          err.message = `${err.message} — wait a few minutes and try again.`;
        } else if (kind === "auth") {
          err.message = `${err.message} — run \`npm run login\` in the gptvoice folder to sign in again.`;
        }
        throw err;
      }
      const backoff = RETRY_BASE_MS * (kind === "rate_limit" ? 2.5 : 1) * 2 ** (attempt - 1);
      await sleep(backoff + Math.random() * RETRY_BASE_MS * 0.25);
    }
  }
}

const accuracyOf = (u, said, lang) =>
  Math.max(wordAccuracy(u.expected, said, lang).accuracy, u.alternate !== u.expected ? wordAccuracy(u.alternate, said, lang).accuracy : 0);

// Speak one chunk; re-record while the words drift from the text.
async function speakUnit(creds, u, { model, verify, redos = MAX_REDOS }) {
  const cue = { directions: u.directions, sounds: u.sounds, before: u.before, after: u.after };
  const instructions = buildInstructions(u.script, u.controls, undefined, cue);
  const cueText = START_CUE;
  const lang = /french|fran/i.test(u.controls.language || "") ? "fr" : undefined;
  const checkable = u.expected.split(/\s+/).filter(Boolean).length >= 3;
  // Speech-to-text cannot read whispers reliably (it even returns other
  // languages), so whispered passages are checked on the model's own transcript.
  const whispered = u.controls.volume === "whisper" || (u.directions ?? []).some((d) => /^(whisper|whispers|whispering|chuchote|chuchotant|murmure)$/i.test(String(d).trim()));
  verify = verify && !whispered;
  let best = null;
  for (let i = 0; i <= redos; i++) {
    const r = await withRetry((c) => synthesizeChunk(c, { instructions, cueText, voice: u.voice, speed: u.speed, model }), creds);
    if (r.pcm.length === 0) continue;
    const own = accuracyOf(u, r.transcript, lang);
    let heard = null;
    let verified = null;
    if (verify && checkable) {
      // Speech-to-text does better with a little lead-in and tail room.
      const clip = Buffer.concat([roomTone(300), smoothTrim(r.pcm), roomTone(300)]);
      heard = await withRetry((c) => transcribePcm(c, clip, { language: lang }), creds);
      verified = accuracyOf(u, heard, lang);
      if (verified < MIN_VERIFIED_ACCURACY) {
        // Speech-to-text sometimes hallucinates (it once returned Chinese for a French
        // line): get a second opinion from another model before blaming the voice.
        const second = await withRetry((c) => transcribePcm(c, clip, { language: lang, model: "whisper-1" }), creds).catch(() => "");
        const v2 = accuracyOf(u, second, lang);
        if (v2 > verified) [heard, verified] = [second, v2];
      }
    }
    const score = verified ?? own;
    if (!best || score > best.score) best = { ...r, own, heard, verified, score };
    if (!checkable) break;
    if (verified != null ? verified >= MIN_VERIFIED_ACCURACY && own >= MIN_ACCURACY : own >= MIN_ACCURACY) break;
  }
  if (!best || best.pcm.length === 0) throw new VoiceError("the voice model returned no audio for a passage", "server");
  return best;
}

// Run tasks with bounded concurrency, preserving order. Fails fast.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = null;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failed;
  return results;
}

// ---------------------------------------------------------------------------
// Subtitles (SRT): one cue per sentence, timed proportionally inside each chunk
// ---------------------------------------------------------------------------

function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
}

/** Sentence-level cues, timed proportionally inside each passage. */
export function sentenceCues(segments) {
  // segments: [{ start, duration, text, speaker? }]
  const cues = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    const sentences = chunkText(seg.text, 90);
    const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
    let t = seg.start;
    for (const s of sentences) {
      const d = (seg.duration * s.length) / total;
      cues.push({ start: t, end: t + d, text: s, speaker: seg.speaker });
      t += d;
    }
  }
  return cues;
}

export function buildSrt(segments) {
  return sentenceCues(segments).map((c) => ({ ...c, text: c.speaker ? `${c.speaker}: ${c.text}` : c.text })).map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

// ---------------------------------------------------------------------------
// Text → units (one realtime session each)
// ---------------------------------------------------------------------------

/**
 * Split one block of text (a paragraph or a dialogue turn) into units.
 * `firstPause` is the silence before the block.
 */
function unitsFor(text, settings, { firstPause, speaker, extraStyle } = {}) {
  const controls = controlsOf(settings);
  if (extraStyle) controls.style = [controls.style, extraStyle].filter(Boolean).join("; ");
  const units = [];
  let pause = firstPause;
  for (const seg of parseCues(text, settings.pronunciations)) {
    if (!seg.raw && !seg.sounds.length) {
      pause += seg.pauseAfterMs; // leading silence
      continue;
    }
    const protectedRaw = seg.raw.replace(/\{[^}]{1,170}\}/g, (h) => h.replaceAll(" ", HINT_SPACE));
    const pieces = protectedRaw ? chunkText(protectedRaw, MAX_CHUNK_CHARS) : [""];
    pieces.forEach((piece, i) => {
      const raw = piece.replaceAll(HINT_SPACE, " ");
      // Sounds are already inline ("Ha ha ha!"); keep the notes for the piece that has them.
      const sounds = seg.sounds.filter((x) => raw.includes(x.sound));
      units.push({
        script: scriptOf(raw).replace(/\s+/g, " ").trim(),
        expected: expectedOf(raw).replaceAll("\u200b", "").replace(/\s+/g, " ").trim(),
        alternate: scriptOf(raw),
        voice: settings.voice,
        speed: settings.speed,
        pitchShift: settings.pitch_shift,
        controls,
        directions: seg.directions,
        sounds,
        speaker,
        pauseBefore: pause,
      });
      pause = CHUNK_PAUSE_MS;
    });
    pause = seg.pauseAfterMs || CHUNK_PAUSE_MS;
  }
  if (units.length && pause > CHUNK_PAUSE_MS) units[units.length - 1].pauseAfter = pause; // trailing [pause]
  return units;
}

// ---------------------------------------------------------------------------
// Assembly shared by narration and dialogue
// ---------------------------------------------------------------------------

async function render(units, { out, format, baseDir, subtitles, manifest, model, verify, normalize = true, redos, padToSec, getCreds, onProgress }) {
  if (!units.length) throw new VoiceError("there is nothing to speak (only cues, no words)", "invalid");
  const fmt = resolveFormat(out, format);
  const target = withExtension(out, fmt);
  const creds = credentialSource(getCreds);
  await creds.get(); // fail fast on "not signed in" before any work

  // Continuity context for every take: the neighbouring words (with the speaker in dialogues).
  const label = (u) => (u?.expected ? (u.speaker ? `${u.speaker}: ${u.expected}` : u.expected) : "");
  units.forEach((u, i) => {
    const prev = label(units[i - 1]);
    const next = label(units[i + 1]);
    const ctx = process.env.GPTVOICE_CONTEXT !== "off";
    u.before = ctx && prev ? prev.slice(-CONTEXT_CHARS) : undefined;
    u.after = ctx && next ? next.slice(0, CONTEXT_CHARS) : undefined;
  });

  let done = 0;
  const spoken = await mapLimit(units, CONCURRENCY, async (u) => {
    const r = await speakUnit(creds, u, { model, verify, redos });
    onProgress?.(++done, units.length);
    // Even out the level differences between voices (sage is ~14 dB quieter than marin).
    const pcm = fillDigitalSilence(applyGainDb(pitchShift(smoothTrim(r.pcm), u.pitchShift || 0), voiceGainDb(u.voice)));
    return { ...u, pcm, transcript: r.transcript, own: r.own, verified: r.verified, heard: r.heard };
  });

  // Assembly: room tone head → take → room-tone gap → take … → room tone tail,
  // every join an equal-power crossfade; then loudness and edge fades.
  const parts = [{ pcm: roomTone(HEAD_ROOM_MS) }];
  spoken.forEach((u, i) => {
    const gapMs = i === 0 ? u.pauseBefore : u.pauseBefore;
    // The two crossfades around a gap eat 2 × XFADE_MS of it: add them back.
    if (gapMs > 0) parts.push({ pcm: roomTone(gapMs + 2 * XFADE_MS, { seed: i + 1 }) });
    parts.push({ pcm: u.pcm, unit: u });
    if (u.pauseAfter) parts.push({ pcm: roomTone(u.pauseAfter + 2 * XFADE_MS, { seed: 1000 + i }) });
  });
  parts.push({ pcm: roomTone(TAIL_ROOM_MS, { seed: 99 }) });
  const starts = [];
  let pcm = crossfadeConcat(parts.map((p) => p.pcm), { xfadeMs: XFADE_MS, starts });
  if (normalize) pcm = normalizeLoudness(pcm);
  // Clip shorter than its shot: extend the room-tone tail to the exact shot length.
  let paddedSec = 0;
  if (padToSec && pcmDurationSec(pcm) < padToSec) {
    paddedSec = padToSec - pcmDurationSec(pcm);
    pcm = Buffer.concat([pcm, roomTone(paddedSec * 1000, { seed: 4242 })]);
  }
  pcm = fadeEdges(pcm, { inMs: 10, outMs: 200 });
  const segments = [];
  parts.forEach((p, k) => {
    if (p.unit) segments.push({ start: starts[k] / SAMPLE_RATE, duration: pcmDurationSec(p.pcm), text: p.unit.expected, speaker: p.unit.speaker, voice: p.unit.voice });
  });
  const bytes = await encode(pcm, fmt);
  const { savedPath, versioned } = await saveAudio(target, baseDir, bytes);

  let subtitlesPath = null;
  if (subtitles) {
    subtitlesPath = savedPath.slice(0, -path.extname(savedPath).length) + ".srt";
    await fs.writeFile(subtitlesPath, buildSrt(segments));
  }

  let manifestPath = null;
  if (manifest) {
    manifestPath = savedPath.slice(0, -path.extname(savedPath).length) + ".timings.json";
    const r2 = (v) => Math.round(v * 1000) / 1000;
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          file: path.basename(savedPath),
          durationSec: r2(pcmDurationSec(pcm)),
          passages: segments.map((g) => ({ start: r2(g.start), end: r2(g.start + g.duration), text: g.text, speaker: g.speaker ?? null, voice: g.voice })),
          sentences: sentenceCues(segments).map((c) => ({ start: r2(c.start), end: r2(c.end), text: c.text, speaker: c.speaker ?? null })),
        },
        null,
        2,
      ) + "\n",
    );
  }

  // Word-weighted accuracy over the whole file.
  let words = 0;
  let ownSum = 0;
  let verSum = 0;
  let verWords = 0;
  const warnings = [];
  if (units.some((u) => u.pitchShift)) {
    warnings.push("pitch_shift is audio processing: beyond ±4 semitones it can sound robotic or phasey — listen before delivering");
  }
  spoken.forEach((u, i) => {
    const n = u.expected.split(/\s+/).filter(Boolean).length;
    if (!n) return;
    words += n;
    ownSum += u.own * n;
    if (u.verified != null) {
      verSum += u.verified * n;
      verWords += n;
    }
    const score = u.verified ?? u.own;
    const bar = u.verified != null ? MIN_VERIFIED_ACCURACY : MIN_ACCURACY;
    if (n >= 3 && score < bar) {
      const said = u.heard ?? u.transcript;
      const diff = describeDiff(wordAccuracy(u.expected, said).ops);
      warnings.push(`passage ${i + 1} may not be word-perfect (${(score * 100).toFixed(0)}%: ${diff}): heard "${said.slice(0, 120)}"`);
    }
  });

  return {
    savedPath,
    versioned,
    subtitlesPath,
    manifestPath,
    paddedSec: Math.round(paddedSec * 100) / 100,
    format: fmt,
    durationSec: Math.round(pcmDurationSec(pcm) * 100) / 100,
    passages: spoken.length,
    accuracy: words ? Math.round((ownSum / words) * 1000) / 10 : null,
    verifiedAccuracy: verWords ? Math.round((verSum / verWords) * 1000) / 10 : null,
    transcript: spoken
      .filter((u) => u.transcript)
      .map((u) => (u.speaker ? `${u.speaker}: ${u.transcript}` : u.transcript))
      .join("\n"),
    warnings,
  };
}

/**
 * Narration: one voice, any length, every control.
 * Options: text, out, voice, speed, emotion, intensity, pitch, intonation, volume,
 * pauses, breaths, accent, language, narration, character, pace, style,
 * pronunciations, preset, verify, format, subtitles, model.
 */
export async function generateSpeech(opts) {
  const { text, out, format, baseDir = process.cwd(), subtitles = false, manifest = false, model, verify = false, normalize = true, redos, padToSec, getCreds, onProgress } = opts;
  const t = validateText(text);
  if (!out) throw new VoiceError("an output path is required (e.g. narration.mp3)", "invalid");
  const settings = await resolveSettings(opts);
  const paragraphs = t.split(/\n\s*\n/).filter((p) => p.trim());
  // Director pass: one delivery direction per paragraph, following the story's arc.
  let directions = [];
  let directorSource = null;
  // Default: on for long narration (3+ paragraphs) — measured livelier and more accurate.
  const useDirector = opts.director ?? paragraphs.length >= 3;
  if (useDirector) {
    const d = await directParagraphs(paragraphs, getCreds ? { getCreds } : {});
    directions = d.directions;
    directorSource = d.source;
  }
  const units = [];
  paragraphs.forEach((para, p) => {
    units.push(...unitsFor(para, settings, { firstPause: p > 0 && units.length ? PARAGRAPH_PAUSE_MS : 0, extraStyle: directions[p] ?? undefined }));
  });
  const result = await render(units, { out, format, baseDir, subtitles, manifest, model, verify, normalize, redos, padToSec, getCreds, onProgress });
  if (useDirector) result.director = { source: directorSource, directions };
  return result;
}

/**
 * Dialogue: several speakers, one file. Pass either `script` ("NAME: line" per
 * line, "NAME (direction): line" for a per-line direction) or `lines`
 * ([{speaker, text, style?, voice?}]). `voices` maps speaker → voice or preset
 * name; unmapped speakers get distinct voices automatically. Global controls
 * (emotion, speed, …) apply to every line.
 */
export async function generateDialogue(opts) {
  const { script, lines, voices = {}, format, out, baseDir = process.cwd(), subtitles = false, manifest = false, model, verify = false, normalize = true, redos, padToSec, getCreds, onProgress } = opts;
  const turns = lines?.length ? lines.map((l) => ({ ...l })) : parseScript(script ?? "");
  if (!turns.length) throw new VoiceError("the dialogue is empty — give at least one line like `ALICE: Hello`", "invalid");
  if (!out) throw new VoiceError("an output path is required (e.g. dialogue.mp3)", "invalid");
  validateText(turns.map((t) => t.text).join("\n"));
  const base = await resolveSettings({ ...opts, voice: opts.voice ?? DEFAULT_VOICE });

  // Speaker → settings. A mapping value can be a voice id or a saved preset name.
  const cast = new Map();
  const used = new Set();
  for (const [name, v] of Object.entries(voices)) {
    const key = name.trim().toLowerCase();
    if (VOICES[String(v).toLowerCase()]) {
      cast.set(key, { ...base, voice: String(v).toLowerCase() });
    } else {
      try {
        cast.set(key, await resolveSettings({ ...opts, voice: undefined, preset: v }));
      } catch (err) {
        if (!/no preset named/.test(err?.message)) throw err;
        throw new VoiceError(`unknown voice "${v}" for ${name}: it is neither a voice (${Object.keys(VOICES).join(", ")}) nor a saved preset`, "invalid");
      }
    }
    used.add(cast.get(key).voice);
  }
  const settingsFor = (speaker) => {
    const key = String(speaker || "").trim().toLowerCase();
    if (!cast.has(key)) {
      const free = DIALOGUE_VOICE_ROTATION.find((v) => !used.has(v)) ?? DIALOGUE_VOICE_ROTATION[cast.size % DIALOGUE_VOICE_ROTATION.length];
      cast.set(key, { ...base, voice: free });
      used.add(free);
    }
    return cast.get(key);
  };

  const units = [];
  turns.forEach((turn) => {
    const text = String(turn.text ?? "").trim();
    if (!text) return;
    const s = turn.voice ? { ...settingsFor(turn.speaker), voice: validateVoice(turn.voice) } : settingsFor(turn.speaker);
    units.push(...unitsFor(text, s, { firstPause: units.length ? DIALOGUE_PAUSE_MS : 0, speaker: turn.speaker, extraStyle: turn.style }));
  });
  const result = await render(units, { out, format, baseDir, subtitles, manifest, model, verify, normalize, redos, padToSec, getCreds, onProgress });
  result.cast = Object.fromEntries([...cast.entries()].map(([k, v]) => [k, v.voice]));
  return result;
}

// ---------------------------------------------------------------------------
// Clips: one file per line, for placing on a video timeline
// ---------------------------------------------------------------------------

const slug = (s) =>
  String(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40) || "clip";

const FIT_TOLERANCE = (target) => Math.max(0.3, target * 0.05);
const NATURAL_MAX = 1.15; // beyond this the realtime voice starts to sound rushed

/**
 * Generate one clip per line: `01-intro.mp3`, `02-…` with .srt and .timings.json,
 * plus `clips.json` (the manifest). A line with `target_seconds` must not be
 * longer than its shot (±5 %): too-long takes are re-taken, then sped up gently
 * (≤ 1.15); shorter takes are padded with room tone to the exact shot length.
 * Lines take any control (voice, preset, emotion…); shared controls apply to all.
 */
export async function generateClips(opts) {
  const { lines, out_dir: outDir = "clips", format = "mp3", baseDir = process.cwd(), fit = true, verify = false, getCreds, onProgress } = opts;
  if (!Array.isArray(lines) || !lines.length) throw new VoiceError("give at least one line: [{ id, text, target_seconds? }]", "invalid");
  if (lines.length > 200) throw new VoiceError("too many lines in one call (max 200)", "invalid");
  const shared = Object.fromEntries(PRESET_FIELDS.concat(["preset", "model"]).filter((k) => opts[k] !== undefined).map((k) => [k, opts[k]]));
  const dir = path.isAbsolute(outDir) ? outDir : path.resolve(baseDir, outDir);
  const seen = new Set();
  const clips = [];
  for (const [i, line] of lines.entries()) {
    const text = validateText(line.text);
    let name = `${String(i + 1).padStart(2, "0")}-${slug(line.id ?? text.split(/\s+/).slice(0, 4).join(" "))}`;
    while (seen.has(name)) name += "-b";
    seen.add(name);
    const { id, text: _t, target_seconds: target, ...lineControls } = line;
    let speed = lineControls.speed ?? shared.speed;
    const finalFiles = [`.${format}`, ".srt", ".timings.json"].map((ext) => path.join(dir, name + ext));
    for (const f of finalFiles) await fs.rm(f, { force: true });
    // Fitting without sounding rushed (listening feedback): a voice SHORTER than
    // its shot is fine — the clip is padded with room tone to the shot length.
    // Only a take that is too long is retried: first a plain re-take (takes vary
    // by ±10 %), then a gentle speed-up capped at NATURAL_MAX. Never slowed down
    // or sped up beyond the natural range; otherwise the text must change.
    const takes = [];
    const tooLong = (d) => target && d > target + FIT_TOLERANCE(target);
    for (let attempt = 0; attempt < (fit && target ? 3 : 1); attempt++) {
      const take = await generateSpeech({ ...shared, ...lineControls, speed, text, out: path.join(dir, `${name}.take${attempt + 1}.${format}`), format, subtitles: true, manifest: true, verify, padToSec: fit && target ? target : undefined, getCreds });
      take.speechSec = take.durationSec - (take.paddedSec ?? 0);
      takes.push({ ...take, speed: speed ?? 1 });
      if (!tooLong(take.speechSec)) break;
      if (attempt === 1) {
        const current = speed ?? 1;
        const next = Math.min(NATURAL_MAX, Math.round(current * (take.speechSec / target) * 100) / 100);
        if (next <= current) break; // already at the natural limit: the text must change
        speed = next;
      }
    }
    // Prefer takes that fit, then the most natural speed, then the one that fills the shot best.
    const fitting = takes.filter((t) => !tooLong(t.speechSec));
    const best = !target
      ? takes[0]
      : fitting.length
        ? fitting.reduce((a, b) => (Math.abs(b.speed - 1) < Math.abs(a.speed - 1) || (b.speed === a.speed && b.speechSec > a.speechSec) ? b : a))
        : takes.reduce((a, b) => (b.speechSec < a.speechSec ? b : a));
    const r = { ...best };
    for (const t of takes) {
      const files = [t.savedPath, t.subtitlesPath, t.manifestPath];
      if (t === best) {
        await fs.rename(files[0], finalFiles[0]);
        await fs.rename(files[1], finalFiles[1]);
        // keep the timings manifest pointing at the final file name
        const m = JSON.parse(await fs.readFile(files[2], "utf8"));
        m.file = path.basename(finalFiles[0]);
        await fs.writeFile(finalFiles[2], JSON.stringify(m, null, 2) + "\n");
        await fs.rm(files[2], { force: true });
        [r.savedPath, r.subtitlesPath, r.manifestPath] = finalFiles;
      } else {
        for (const f of files) await fs.rm(f, { force: true });
      }
    }
    speed = best.speed;
    const fits = target ? !tooLong(r.speechSec) : null;
    clips.push({
      index: i + 1,
      id: id ?? name.slice(3),
      file: r.savedPath,
      subtitles: r.subtitlesPath,
      timings: r.manifestPath,
      durationSec: r.durationSec,
      speechSec: Math.round(r.speechSec * 100) / 100,
      targetSec: target ?? null,
      fits,
      speed,
      takes: takes.length,
      accuracy: r.verifiedAccuracy ?? r.accuracy,
      warnings: r.warnings,
      text,
    });
    onProgress?.(i + 1, lines.length);
  }
  let t = 0;
  for (const c of clips) {
    c.timelineStart = Math.round(t * 100) / 100; // back-to-back suggestion
    t += c.durationSec;
  }
  const manifestPath = path.join(dir, "clips.json");
  await fs.writeFile(manifestPath, JSON.stringify({ createdAt: new Date().toISOString(), totalSec: Math.round(t * 100) / 100, clips }, null, 2) + "\n");
  return { dir, manifestPath, clips, totalSec: Math.round(t * 100) / 100 };
}
