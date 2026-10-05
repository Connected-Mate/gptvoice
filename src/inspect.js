// Let a coding agent "see" a voice clip: timings per sentence, pauses, pace,
// pitch and loudness per sentence, and an optional picture (PNG) of the
// waveform + pitch line, so it can rewrite lines, adjust speed/pauses, and make
// clips fit their shots.
//
// Timing sources, best first:
//   1. "<clip>.timings.json" written by GPTVoice (exact passage timings)
//   2. otherwise the clip is transcribed and the sentences are laid over the
//      detected speech segments (estimated)
// Pauses always come from the audio itself (exact to ~10 ms).

import fs from "node:fs/promises";
import path from "node:path";

import { contourPcm, segmentSpeech, windowStats, HOP_SEC } from "./analysis.js";
import { decodeToPcm, transcribeFile } from "./transcribe.js";
import { splitSentences } from "./text.js";
import { Canvas } from "./png.js";
import { VoiceError } from "./errors.js";
import { smoothness, describeSmoothness } from "./quality.js";

const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".aif", ".aiff", ".caf", ".flac", ".ogg"]);
const r2 = (v) => Math.round(v * 100) / 100;
const words = (s) => String(s).split(/\s+/).filter(Boolean).length;

async function readManifest(abs) {
  const f = abs.slice(0, -path.extname(abs).length) + ".timings.json";
  try {
    return JSON.parse(await fs.readFile(f, "utf8"));
  } catch {
    return null;
  }
}

/** Lay sentences over the speech segments in proportion to their length, snapping cuts to nearby pauses. */
function estimateSentences(text, speech, pauses) {
  const sentences = splitSentences(text);
  if (!sentences.length || !speech.length) return [];
  const spans = speech.map((s) => ({ ...s, len: s.end - s.start }));
  const talk = spans.reduce((a, s) => a + s.len, 0);
  const totalChars = sentences.reduce((a, s) => a + s.length, 0);
  const timeAt = (frac) => {
    let need = frac * talk;
    for (const s of spans) {
      if (need <= s.len) return s.start + need;
      need -= s.len;
    }
    return spans[spans.length - 1].end;
  };
  let acc = 0;
  const cuts = [spans[0].start];
  for (let i = 0; i < sentences.length - 1; i++) {
    acc += sentences[i].length;
    let t = timeAt(acc / totalChars);
    // Sentence ends usually sit on a pause; long silences are strong boundary
    // evidence (quiet or whispered speech skews the proportional estimate).
    const score = (p) => Math.abs((p.start + p.end) / 2 - t) - 1.5 * p.duration;
    const near = pauses.filter((p) => Math.abs((p.start + p.end) / 2 - t) < 1.5 && p.start > cuts[cuts.length - 1]).sort((a, b) => score(a) - score(b))[0];
    if (near) t = near.start;
    cuts.push(t);
  }
  return sentences.map((s, i) => {
    let start = cuts[i];
    if (i > 0) {
      const p = pauses.find((x) => Math.abs(x.start - cuts[i]) < 1e-6);
      if (p) start = p.end;
    }
    const end = i + 1 < cuts.length ? cuts[i + 1] : spans[spans.length - 1].end;
    return { start, end, text: s };
  });
}

/** Draw waveform envelope (top), pitch line (bottom), pause bands and sentence cuts. */
function drawPicture(c, sentences, pauses, { width = 1200, height = 320 } = {}) {
  const cv = new Canvas(width, height, [252, 252, 250]);
  const n = c.rms.length || 1;
  const xOf = (sec) => (sec / (n * HOP_SEC)) * (width - 1);
  const waveH = height * 0.55;
  const pitchTop = waveH + 10;
  const pitchH = height - pitchTop - 6;
  for (const p of pauses) cv.fill(xOf(p.start), 0, xOf(p.end), height, [255, 236, 214]); // pauses: orange band
  const maxRms = Math.max(...c.rms, 1e-6);
  for (let x = 0; x < width; x++) {
    const k0 = Math.floor((x / width) * n);
    const k1 = Math.max(k0 + 1, Math.floor(((x + 1) / width) * n));
    let m = 0;
    for (let k = k0; k < k1; k++) m = Math.max(m, c.rms[k] || 0);
    const h = (m / maxRms) * (waveH / 2 - 4);
    cv.vline(x, waveH / 2 - h, waveH / 2 + h, [38, 84, 124]); // waveform: blue
  }
  cv.hline(0, width - 1, waveH, [200, 200, 200]);
  // Pitch on a log scale, 60-400 Hz; guide lines at 100 and 200 Hz.
  const yOf = (f) => pitchTop + pitchH - (Math.log(f / 60) / Math.log(400 / 60)) * pitchH;
  for (const g of [100, 200]) cv.hline(0, width - 1, yOf(g), [225, 225, 225]);
  for (let k = 0; k < n; k++) if (c.f0[k]) cv.dot(xOf(k * HOP_SEC), yOf(Math.min(400, Math.max(60, c.f0[k]))), [196, 62, 58], 1); // pitch: red
  for (let sec = 1; sec < n * HOP_SEC; sec++) cv.vline(xOf(sec), 0, sec % 5 === 0 ? 12 : 6, [120, 120, 120]); // 1 s ticks, long every 5 s
  for (const s of sentences.slice(1)) cv.vline(xOf(s.start), 0, height - 1, [40, 140, 80]); // sentence starts: green
  return cv.toPng();
}

/**
 * Inspect one clip.
 * @param {string} file
 * @param {{baseDir?, minPauseSec?, picture?: boolean, transcribe?: boolean, targetSec?: number, language?, getCreds?}} opts
 */
export async function inspectAudio(file, { baseDir = process.cwd(), minPauseSec = 0.25, picture = false, transcribe = true, targetSec, language, getCreds } = {}) {
  const abs = path.isAbsolute(file) ? file : path.resolve(baseDir, file);
  const pcm = await decodeToPcm(abs);
  const c = contourPcm(pcm);
  if (c.durationSec < 0.1) throw new VoiceError("the audio file is empty", "invalid");
  const { speech, pauses } = segmentSpeech(c, { minPauseSec });
  const manifest = await readManifest(abs);

  let sentences = [];
  let timing = "none";
  let text = null;
  if (manifest?.sentences?.length) {
    sentences = manifest.sentences;
    timing = "exact passages (from .timings.json), sentences estimated inside each passage";
    text = manifest.passages.map((p) => (p.speaker ? `${p.speaker}: ${p.text}` : p.text)).join(" ");
  } else if (transcribe && speech.length) {
    text = (await transcribeFile(abs, { language, ...(getCreds ? { getCreds } : {}) })).text;
    sentences = estimateSentences(text, speech, pauses);
    timing = "estimated (transcribed, laid over the detected speech)";
  }

  const toFrames = (sec) => Math.round(sec / HOP_SEC);
  const detail = sentences.map((s, i) => {
    const st = windowStats(c, toFrames(s.start), toFrames(s.end));
    const dur = s.end - s.start;
    return {
      index: i + 1,
      start: r2(s.start),
      end: r2(s.end),
      durationSec: r2(dur),
      words: words(s.text),
      wordsPerSec: dur > 0 ? r2(words(s.text) / dur) : null,
      pitchHz: st.f0Median || null,
      melodySemitones: st.f0Semitones,
      loudnessDb: st.loudnessDb,
      speaker: s.speaker ?? null,
      text: s.text,
    };
  });

  const overall = windowStats(c);
  const speechSec = speech.reduce((a, s) => a + (s.end - s.start), 0);
  const totalWords = text ? words(text.replace(/\b[A-ZÀ-Ý][\p{L}' -]{0,30}:\s/gu, " ")) : null;
  const result = {
    file: abs,
    durationSec: r2(c.durationSec),
    speechSec: r2(speechSec),
    leadingSilenceSec: speech.length ? r2(speech[0].start) : r2(c.durationSec),
    trailingSilenceSec: speech.length ? r2(c.durationSec - speech[speech.length - 1].end) : 0,
    wordsPerSec: totalWords && speechSec ? r2(totalWords / speechSec) : null,
    pitchHz: overall.f0Median || null,
    melodySemitones: overall.f0Semitones,
    loudnessDb: overall.loudnessDb,
    pauses,
    longestPauseSec: pauses.length ? Math.max(...pauses.map((p) => p.duration)) : 0,
    timing,
    sentences: detail,
    text,
  };
  result.smoothness = smoothness(pcm, manifest?.passages?.slice(1).map((p) => p.start) ?? []);
  if (targetSec != null) {
    const t = Number(targetSec);
    result.target = { seconds: t, differenceSec: r2(c.durationSec - t), fits: Math.abs(c.durationSec - t) <= Math.max(0.3, t * 0.05) };
  }
  if (picture) {
    const png = abs.slice(0, -path.extname(abs).length) + ".speech.png";
    await fs.writeFile(png, drawPicture(c, sentences, pauses));
    result.picture = png;
  }
  return result;
}

/** Inspect every audio file in a folder (non-recursive), sorted by name. */
export async function inspectFolder(dir, opts = {}) {
  const abs = path.isAbsolute(dir) ? dir : path.resolve(opts.baseDir ?? process.cwd(), dir);
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    throw new VoiceError(`cannot read folder ${abs}: ${err?.code || err?.message}`, "invalid");
  }
  const files = entries.filter((e) => e.isFile() && AUDIO_EXTS.has(path.extname(e.name).toLowerCase())).map((e) => path.join(abs, e.name)).sort();
  if (!files.length) throw new VoiceError(`no audio files in ${abs}`, "invalid");
  const out = [];
  for (const f of files) out.push(await inspectAudio(f, { ...opts, baseDir: abs }));
  return out;
}

/** Plain-text report for the agent. */
export function describeInspection(r) {
  const lines = [
    `${path.basename(r.file)} — ${r.durationSec}s total, ${r.speechSec}s of speech, silence ${r.leadingSilenceSec}s before / ${r.trailingSilenceSec}s after.`,
    `Pace ${r.wordsPerSec ?? "?"} words per second of speech · pitch ~${r.pitchHz ?? "?"} Hz · melody ${r.melodySemitones} st · loudness ${r.loudnessDb ?? "?"} dB.`,
  ];
  if (r.target) lines.push(`Target ${r.target.seconds}s: ${r.target.fits ? "fits" : `${r.target.differenceSec > 0 ? "too long" : "too short"} by ${Math.abs(r.target.differenceSec)}s`}.`);
  lines.push(r.pauses.length ? `Pauses ≥ threshold: ${r.pauses.map((p) => `${p.start}–${p.end}s (${p.duration}s)`).join(", ")}.` : "No pauses above the threshold.");
  if (r.sentences.length) {
    lines.push(`Sentences (${r.timing}):`);
    for (const s of r.sentences) {
      lines.push(`  ${s.index}. ${s.start}–${s.end}s (${s.durationSec}s, ${s.wordsPerSec ?? "?"} w/s, ~${s.pitchHz ?? "?"} Hz, ${s.loudnessDb ?? "?"} dB)${s.speaker ? ` ${s.speaker}:` : ""} ${s.text}`);
    }
  }
  if (r.smoothness) lines.push(describeSmoothness(r.smoothness));
  if (r.picture) lines.push(`Picture: ${r.picture} (blue = loudness, red = pitch 60–400 Hz log scale with lines at 100/200 Hz, orange = pauses, green = sentence starts, grey ticks = seconds).`);
  return lines.join("\n");
}
