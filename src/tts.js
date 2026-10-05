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
import { wordAccuracy, describeDiff } from "./accuracy.js";
import { MAX_PITCH_SHIFT, applyGainDb, encode, pitchShift, joinPcm, normalizeLoudness, pcmDurationSec, resolveFormat, saveAudio, silence, trimSilence, withExtension } from "./audio.js";
import { MAX_TEXT_CHARS, chunkText, parseScript } from "./text.js";

const CONCURRENCY = Math.max(1, Number(process.env.GPTVOICE_CONCURRENCY) || 3);
const RETRY_BASE_MS = Number(process.env.GPTVOICE_RETRY_BASE_MS ?? 2000);
const MIN_ACCURACY = 0.9; // against the model's own transcript
const MIN_VERIFIED_ACCURACY = 0.85; // against independent STT (which has its own errors)
const MAX_REDOS = 2;
const CHUNK_PAUSE_MS = 250;
const PARAGRAPH_PAUSE_MS = 700;
const DIALOGUE_PAUSE_MS = 450;
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
          err.message = `${err.message} — your ChatGPT plan's voice limit was hit. Wait a few minutes and try again.`;
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
  const cue = { directions: u.directions, sounds: u.sounds };
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
      heard = await withRetry((c) => transcribePcm(c, trimSilence(r.pcm), { language: lang }), creds);
      verified = accuracyOf(u, heard, lang);
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

export function buildSrt(segments) {
  // segments: [{ start, duration, text, speaker? }]
  const cues = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    const sentences = chunkText(seg.text, 90);
    const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
    let t = seg.start;
    for (const s of sentences) {
      const d = (seg.duration * s.length) / total;
      cues.push({ start: t, end: t + d, text: seg.speaker ? `${seg.speaker}: ${s}` : s });
      t += d;
    }
  }
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
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
    const pieces = protectedRaw ? chunkText(protectedRaw) : [""];
    pieces.forEach((piece, i) => {
      const raw = piece.replaceAll(HINT_SPACE, " ");
      const sounds = i === 0 ? seg.sounds : [];
      const opener = sounds.map((x) => x.sound).join(" ");
      units.push({
        script: [opener, scriptOf(raw)].filter(Boolean).join(" "),
        expected: expectedOf(raw),
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

async function render(units, { out, format, baseDir, subtitles, model, verify, normalize = true, redos, getCreds, onProgress }) {
  if (!units.length) throw new VoiceError("there is nothing to speak (only cues, no words)", "invalid");
  const fmt = resolveFormat(out, format);
  const target = withExtension(out, fmt);
  const creds = credentialSource(getCreds);
  await creds.get(); // fail fast on "not signed in" before any work

  let done = 0;
  const spoken = await mapLimit(units, CONCURRENCY, async (u) => {
    const r = await speakUnit(creds, u, { model, verify, redos });
    onProgress?.(++done, units.length);
    // Even out the level differences between voices (sage is ~14 dB quieter than marin).
    const pcm = applyGainDb(pitchShift(trimSilence(r.pcm), u.pitchShift || 0), voiceGainDb(u.voice));
    return { ...u, pcm, transcript: r.transcript, own: r.own, verified: r.verified, heard: r.heard };
  });

  const parts = [];
  const segments = [];
  let cursor = 0;
  spoken.forEach((u, i) => {
    const gapMs = i === 0 ? u.pauseBefore : u.pauseBefore;
    if (gapMs > 0) {
      parts.push(silence(gapMs));
      cursor += gapMs / 1000;
    }
    parts.push(u.pcm);
    const duration = pcmDurationSec(u.pcm);
    segments.push({ start: cursor, duration, text: u.expected, speaker: u.speaker });
    cursor += duration;
    if (u.pauseAfter) {
      parts.push(silence(u.pauseAfter));
      cursor += u.pauseAfter / 1000;
    }
  });
  let pcm = joinPcm(parts);
  if (normalize) pcm = normalizeLoudness(pcm);
  const bytes = await encode(pcm, fmt);
  const { savedPath, versioned } = await saveAudio(target, baseDir, bytes);

  let subtitlesPath = null;
  if (subtitles) {
    subtitlesPath = savedPath.slice(0, -path.extname(savedPath).length) + ".srt";
    await fs.writeFile(subtitlesPath, buildSrt(segments));
  }

  // Word-weighted accuracy over the whole file.
  let words = 0;
  let ownSum = 0;
  let verSum = 0;
  let verWords = 0;
  const warnings = [];
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
  const { text, out, format, baseDir = process.cwd(), subtitles = false, model, verify = false, normalize = true, redos, getCreds, onProgress } = opts;
  const t = validateText(text);
  if (!out) throw new VoiceError("an output path is required (e.g. narration.mp3)", "invalid");
  const settings = await resolveSettings(opts);
  const units = [];
  t.split(/\n\s*\n/).forEach((para, p) => {
    if (!para.trim()) return;
    units.push(...unitsFor(para, settings, { firstPause: p > 0 && units.length ? PARAGRAPH_PAUSE_MS : 0 }));
  });
  return render(units, { out, format, baseDir, subtitles, model, verify, normalize, redos, getCreds, onProgress });
}

/**
 * Dialogue: several speakers, one file. Pass either `script` ("NAME: line" per
 * line, "NAME (direction): line" for a per-line direction) or `lines`
 * ([{speaker, text, style?, voice?}]). `voices` maps speaker → voice or preset
 * name; unmapped speakers get distinct voices automatically. Global controls
 * (emotion, speed, …) apply to every line.
 */
export async function generateDialogue(opts) {
  const { script, lines, voices = {}, format, out, baseDir = process.cwd(), subtitles = false, model, verify = false, normalize = true, redos, getCreds, onProgress } = opts;
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
  const result = await render(units, { out, format, baseDir, subtitles, model, verify, normalize, redos, getCreds, onProgress });
  result.cast = Object.fromEntries([...cast.entries()].map(([k, v]) => [k, v.voice]));
  return result;
}
