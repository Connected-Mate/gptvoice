// Speech-to-text for an audio file (handy to check a voice-over, or to make
// subtitles from any recording).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { getValidCredentials } from "./auth.js";
import { transcribePcm, VoiceError } from "./realtime.js";
import { pcmDurationSec, wavToPcm24k } from "./audio.js";

const MAX_SECONDS = 25 * 60;
const MIN_WORDS_PER_SEC = 1;
const FALLBACK_MODEL = "whisper-1";

async function decodeToPcm(abs) {
  const buf = await fs.readFile(abs).catch((err) => {
    throw new VoiceError(`cannot read ${abs}: ${err?.code || err?.message}`, "invalid");
  });
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF") {
    try {
      return wavToPcm24k(buf);
    } catch {
      /* compressed/odd WAV: let afconvert handle it below */
    }
  }
  if (process.platform !== "darwin") {
    throw new VoiceError("on this OS only 16-bit PCM .wav files can be transcribed", "invalid");
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gptvoice-"));
  const wav = path.join(dir, "in.wav");
  try {
    const r = spawnSync("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", abs, wav], { encoding: "utf8" });
    if (r.error || r.status !== 0) throw new VoiceError(`could not decode ${path.basename(abs)} (unsupported audio format)`, "invalid");
    return wavToPcm24k(await fs.readFile(wav));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function transcribeFile(file, { baseDir = process.cwd(), language, getCreds = getValidCredentials } = {}) {
  const abs = path.isAbsolute(file) ? file : path.resolve(baseDir, file);
  const pcm = await decodeToPcm(abs);
  const secs = pcmDurationSec(pcm);
  if (secs < 0.1) throw new VoiceError("the audio file is empty", "invalid");
  if (secs > MAX_SECONDS) throw new VoiceError(`audio is too long (${Math.round(secs / 60)} min, max ${MAX_SECONDS / 60} min)`, "invalid");
  let creds = await getCreds();
  const run = async (opts) => {
    try {
      return await transcribePcm(creds, pcm, opts);
    } catch (err) {
      if (err?.kind !== "auth") throw err;
      creds = await getCreds({ force: true });
      return transcribePcm(creds, pcm, opts);
    }
  };
  let text = await run({ language });
  // Transcription models occasionally stop at the first long pause. Speech runs
  // ~2-3 words/s, so far fewer words than that means a truncated result: retry
  // once with whisper-1, which transcribes the whole buffer, and keep the longer.
  if (secs > 6 && wordCount(text) < secs * MIN_WORDS_PER_SEC) {
    const retry = await run({ language, model: FALLBACK_MODEL }).catch(() => "");
    if (wordCount(retry) > wordCount(text)) text = retry;
  }
  return { text, durationSec: Math.round(secs * 100) / 100 };
}

function wordCount(s) {
  return String(s || "").split(/\s+/).filter(Boolean).length;
}
