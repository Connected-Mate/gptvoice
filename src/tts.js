// Orchestration: long narration and multi-voice dialogue → one audio file.
//
// Text is split into sentence-aligned chunks, each chunk is spoken in its own
// short realtime session (a few in parallel, order preserved), silence at the
// edges is trimmed, and the pieces are joined with natural pauses. Each chunk's
// transcript is compared to the requested text; a chunk the model paraphrased
// or "answered" is re-recorded.

import path from "node:path";
import fs from "node:fs/promises";

import { getValidCredentials } from "./auth.js";
import { DEFAULT_VOICE, VOICES, VoiceError, synthesizeChunk } from "./realtime.js";
import { encode, joinPcm, pcmDurationSec, resolveFormat, saveAudio, silence, trimSilence, withExtension } from "./audio.js";
import { MAX_TEXT_CHARS, chunkText, fidelity, parseScript } from "./text.js";

const CONCURRENCY = Math.max(1, Number(process.env.GPTVOICE_CONCURRENCY) || 3);
const RETRY_BASE_MS = Number(process.env.GPTVOICE_RETRY_BASE_MS ?? 2000);
const MIN_FIDELITY = 0.8;
const MAX_FIDELITY_RETRIES = 2;
const CHUNK_PAUSE_MS = 250;
const PARAGRAPH_PAUSE_MS = 700;
const DIALOGUE_PAUSE_MS = 450;
const DIALOGUE_VOICE_ROTATION = ["marin", "cedar", "coral", "ash", "sage", "verse", "shimmer", "echo", "ballad", "alloy"];

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

/**
 * Credentials holder that can be force-refreshed once after a 401.
 * `getCreds` is injectable for tests.
 */
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

// Speak one chunk, re-recording when the transcript drifts from the text.
async function speakChunk(creds, { text, voice, style, model }) {
  let best = null;
  for (let i = 0; i <= MAX_FIDELITY_RETRIES; i++) {
    const r = await withRetry((c) => synthesizeChunk(c, { text, voice, style, model }), creds);
    const score = fidelity(text, r.transcript);
    if (!best || score > best.score) best = { ...r, score };
    // Very short lines ("Oui.", "OK!") are too short to judge reliably.
    if (score >= MIN_FIDELITY || text.split(/\s+/).length < 4) break;
  }
  if (best.pcm.length === 0) throw new VoiceError("the voice model returned no audio for a passage", "server");
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
// Assembly shared by narration and dialogue
// ---------------------------------------------------------------------------

async function render(units, { out, format, baseDir, subtitles, model, getCreds, onProgress }) {
  const fmt = resolveFormat(out, format);
  const target = withExtension(out, fmt);
  const creds = credentialSource(getCreds);
  await creds.get(); // fail fast on "not signed in" before any work

  let done = 0;
  const spoken = await mapLimit(units, CONCURRENCY, async (u) => {
    const r = await speakChunk(creds, { text: u.text, voice: u.voice, style: u.style, model });
    onProgress?.(++done, units.length);
    return { ...u, pcm: trimSilence(r.pcm), transcript: r.transcript, score: r.score };
  });

  const parts = [];
  const segments = [];
  let cursor = 0;
  spoken.forEach((u, i) => {
    if (i > 0) {
      const gap = silence(u.pauseBefore);
      parts.push(gap);
      cursor += pcmDurationSec(gap);
    }
    parts.push(u.pcm);
    const duration = pcmDurationSec(u.pcm);
    segments.push({ start: cursor, duration, text: u.text, speaker: u.speaker });
    cursor += duration;
  });
  const pcm = joinPcm(parts);
  const bytes = await encode(pcm, fmt);
  const { savedPath, versioned } = await saveAudio(target, baseDir, bytes);

  let subtitlesPath = null;
  if (subtitles) {
    subtitlesPath = savedPath.slice(0, -path.extname(savedPath).length) + ".srt";
    await fs.writeFile(subtitlesPath, buildSrt(segments));
  }

  const warnings = [];
  spoken.forEach((u, i) => {
    if (u.score < MIN_FIDELITY && u.text.split(/\s+/).length >= 4) {
      warnings.push(
        `passage ${i + 1} may not be word-perfect (match ${(u.score * 100).toFixed(0)}%): heard "${u.transcript.slice(0, 120)}"`,
      );
    }
  });

  return {
    savedPath,
    versioned,
    subtitlesPath,
    format: fmt,
    durationSec: Math.round(pcmDurationSec(pcm) * 100) / 100,
    passages: spoken.length,
    transcript: spoken.map((u) => (u.speaker ? `${u.speaker}: ${u.transcript}` : u.transcript)).join("\n"),
    warnings,
  };
}

/**
 * Narration: one voice, any length.
 */
export async function generateSpeech({ text, voice, style, format, out, baseDir = process.cwd(), subtitles = false, model, getCreds, onProgress }) {
  const t = validateText(text);
  const v = validateVoice(voice);
  if (!out) throw new VoiceError("an output path is required (e.g. narration.mp3)", "invalid");
  const units = [];
  String(t)
    .split(/\n\s*\n/)
    .forEach((para, p) => {
      chunkText(para).forEach((chunk, c) => {
        units.push({ text: chunk, voice: v, style, pauseBefore: p > 0 && c === 0 ? PARAGRAPH_PAUSE_MS : CHUNK_PAUSE_MS });
      });
    });
  return render(units, { out, format, baseDir, subtitles, model, getCreds, onProgress });
}

/**
 * Dialogue: several speakers, one file. Pass either `script` ("NAME: line" per
 * line) or `lines` ([{speaker, text, style?, voice?}]). `voices` maps speaker
 * names to voices; unmapped speakers get distinct voices automatically.
 */
export async function generateDialogue({ script, lines, voices = {}, style, format, out, baseDir = process.cwd(), subtitles = false, model, getCreds, onProgress }) {
  const turns = lines?.length ? lines.map((l) => ({ ...l })) : parseScript(script ?? "");
  if (!turns.length) throw new VoiceError("the dialogue is empty — give at least one line like `ALICE: Hello`", "invalid");
  if (!out) throw new VoiceError("an output path is required (e.g. dialogue.mp3)", "invalid");
  validateText(turns.map((t) => t.text).join("\n"));

  const map = new Map();
  for (const [name, voice] of Object.entries(voices)) map.set(name.trim().toLowerCase(), validateVoice(voice));
  const used = new Set(map.values());
  const pickVoice = (speaker) => {
    const key = String(speaker || "").trim().toLowerCase();
    if (!map.has(key)) {
      const free = DIALOGUE_VOICE_ROTATION.find((v) => !used.has(v)) ?? DIALOGUE_VOICE_ROTATION[map.size % DIALOGUE_VOICE_ROTATION.length];
      map.set(key, free);
      used.add(free);
    }
    return map.get(key);
  };

  const units = [];
  turns.forEach((turn, i) => {
    const text = String(turn.text ?? "").trim();
    if (!text) return;
    const voice = turn.voice ? validateVoice(turn.voice) : pickVoice(turn.speaker);
    const lineStyle = [style, turn.style].filter(Boolean).join("; ") || undefined;
    chunkText(text).forEach((chunk, c) => {
      units.push({
        text: chunk,
        voice,
        style: lineStyle,
        speaker: turn.speaker,
        pauseBefore: i > 0 && c === 0 ? DIALOGUE_PAUSE_MS : CHUNK_PAUSE_MS,
      });
    });
  });
  const result = await render(units, { out, format, baseDir, subtitles, model, getCreds, onProgress });
  result.cast = Object.fromEntries([...map.entries()]);
  return result;
}
