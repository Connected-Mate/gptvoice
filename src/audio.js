// Audio helpers: PCM16 manipulation, WAV/MP3/M4A encoding, safe saving.
//
// The realtime model streams mono 16-bit little-endian PCM at 24 kHz. Everything
// here works on that format until the final encode.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Mp3Encoder } from "@breezystack/lamejs";

export const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;

export const FORMATS = ["mp3", "wav", "m4a"];

export function pcmDurationSec(pcm, rate = SAMPLE_RATE) {
  return pcm.length / BYTES_PER_SAMPLE / rate;
}

export function silence(ms, rate = SAMPLE_RATE) {
  const samples = Math.max(0, Math.round((ms / 1000) * rate));
  return Buffer.alloc(samples * BYTES_PER_SAMPLE);
}

// Trim leading/trailing near-silence so concatenated chunks get even pauses.
// Keeps a small margin so word onsets/tails are never clipped.
export function trimSilence(pcm, { threshold = 500, marginMs = 60, rate = SAMPLE_RATE } = {}) {
  const n = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (n === 0) return pcm;
  let start = 0;
  while (start < n && Math.abs(pcm.readInt16LE(start * 2)) < threshold) start++;
  if (start === n) return Buffer.alloc(0);
  let end = n - 1;
  while (end > start && Math.abs(pcm.readInt16LE(end * 2)) < threshold) end--;
  const margin = Math.round((marginMs / 1000) * rate);
  const s = Math.max(0, start - margin);
  const e = Math.min(n, end + 1 + margin);
  return pcm.subarray(s * 2, e * 2);
}

// ---------------------------------------------------------------------------
// Smooth assembly (see docs/VOICE-BEST-PRACTICES.md): keep natural tails,
// fade edges, fill gaps with low room tone, equal-power crossfade every join.
// ---------------------------------------------------------------------------

export const ROOM_TONE_DB = -72; // under ACX's -60 dB noise-floor ceiling, inaudible at normal levels

// Deterministic PRNG so renders (and tests) are reproducible.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Soft, slightly low-passed noise at `levelDb` dBFS RMS: "room tone" instead of digital zero. */
export function roomTone(ms, { levelDb = ROOM_TONE_DB, seed = 7, rate = SAMPLE_RATE } = {}) {
  const n = Math.max(0, Math.round((ms / 1000) * rate));
  if (levelDb === -Infinity || levelDb == null) return Buffer.alloc(n * 2);
  const rnd = mulberry32(seed + n);
  const y = new Float32Array(n);
  let lp = 0;
  let e = 0;
  for (let i = 0; i < n; i++) {
    lp = 0.85 * lp + 0.15 * (rnd() * 2 - 1);
    y[i] = lp;
    e += lp * lp;
  }
  const g = n ? 10 ** (levelDb / 20) / Math.sqrt(e / n || 1) : 0;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y[i] * g * 32767))), i * 2);
  return out;
}

const toF = (pcm) => {
  const n = Math.floor(pcm.length / 2);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;
  return x;
};
const toPcm = (x) => {
  const out = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), i * 2);
  return out;
};

function nearestZeroCrossing(x, i, radius) {
  for (let d = 0; d <= radius; d++) {
    for (const j of [i - d, i + d]) {
      if (j > 0 && j < x.length && (x[j - 1] <= 0) !== (x[j] <= 0)) return j;
    }
  }
  return i;
}

/**
 * Trim leading/trailing silence WITHOUT eating the natural decay of the last
 * syllable: the cut follows sound down to `floorDb` (or 50 dB under the peak),
 * keeps `headMs`/`tailMs` of room around it, snaps to zero crossings, then
 * applies a raised-cosine fade-in/out. (The old trim at -36 dB cut 115-360 ms
 * of audible tail on 7 of 8 test takes.)
 */
export function smoothTrim(pcm, { floorDb = -58, relDb = -50, headMs = 40, tailMs = 160, fadeInMs = 15, fadeOutMs = 120, rate = SAMPLE_RATE } = {}) {
  const x = toF(pcm);
  if (x.length === 0) return pcm;
  const F = Math.round(0.005 * rate);
  const lv = [];
  let peak = -200;
  for (let s = 0; s < x.length; s += F) {
    let e = 0;
    const end = Math.min(x.length, s + F);
    for (let i = s; i < end; i++) e += x[i] * x[i];
    const d = 10 * Math.log10(e / (end - s) || 1e-20);
    lv.push(d);
    if (d > peak) peak = d;
  }
  const thr = Math.max(floorDb, peak + relDb);
  const first = lv.findIndex((d) => d > thr);
  if (first < 0) return Buffer.alloc(0);
  let last = lv.length - 1;
  while (last > first && lv[last] <= thr) last--;
  let a = Math.max(0, first * F - Math.round((headMs / 1000) * rate));
  let b = Math.min(x.length, (last + 1) * F + Math.round((tailMs / 1000) * rate));
  a = nearestZeroCrossing(x, a, Math.round(0.002 * rate));
  b = nearestZeroCrossing(x, b, Math.round(0.002 * rate));
  const y = x.slice(a, Math.max(a, b));
  const fi = Math.min(y.length >> 1, Math.round((fadeInMs / 1000) * rate));
  const fo = Math.min(y.length >> 1, Math.round((fadeOutMs / 1000) * rate));
  for (let i = 0; i < fi; i++) y[i] *= Math.sin((Math.PI / 2) * (i / fi));
  for (let i = 0; i < fo; i++) y[y.length - 1 - i] *= Math.sin((Math.PI / 2) * (i / fo));
  return toPcm(y);
}

/**
 * Replace runs of exact digital silence (> `minMs`) inside a take with room
 * tone, crossfaded in and out, so the background never "drops out".
 */
export function fillDigitalSilence(pcm, { minMs = 40, rate = SAMPLE_RATE } = {}) {
  const x = toF(pcm);
  const min = Math.round((minMs / 1000) * rate);
  const fade = Math.round(0.01 * rate);
  let changed = false;
  let i = 0;
  while (i < x.length) {
    if (Math.abs(x[i]) > 3e-5) {
      i++;
      continue;
    }
    let j = i;
    while (j < x.length && Math.abs(x[j]) <= 3e-5) j++;
    if (j - i >= min) {
      const tone = toF(roomTone(((j - i) / rate) * 1000, { seed: i }));
      for (let k = 0; k < tone.length && i + k < j; k++) {
        const g = Math.min(1, k / fade, (j - i - 1 - k) / fade);
        x[i + k] += tone[k] * Math.max(0, g);
      }
      changed = true;
    }
    i = j;
  }
  return changed ? toPcm(x) : pcm;
}

/** Fade the very start and end of a whole file (raised cosine). */
export function fadeEdges(pcm, { inMs = 10, outMs = 150, rate = SAMPLE_RATE } = {}) {
  const y = toF(pcm);
  const fi = Math.min(y.length >> 1, Math.round((inMs / 1000) * rate));
  const fo = Math.min(y.length >> 1, Math.round((outMs / 1000) * rate));
  for (let i = 0; i < fi; i++) y[i] *= Math.sin((Math.PI / 2) * (i / fi));
  for (let i = 0; i < fo; i++) y[y.length - 1 - i] *= Math.sin((Math.PI / 2) * (i / fo));
  return toPcm(y);
}

/**
 * Concatenate segments with an equal-power (sin/cos) crossfade of `xfadeMs` at
 * every join, so no join is a hard cut. Each overlap shortens the total by
 * the crossfade length; callers that need exact gaps add it to the gap.
 */
export function crossfadeConcat(segments, { xfadeMs = 40, rate = SAMPLE_RATE, starts = [] } = {}) {
  const all = segments.map(toF);
  const xs = all.filter((x) => x.length);
  if (!xs.length) return Buffer.alloc(0);
  const X = Math.round((xfadeMs / 1000) * rate);
  let total = xs[0].length;
  for (let k = 1; k < xs.length; k++) total += xs[k].length - Math.min(X, xs[k].length >> 1, xs[k - 1].length >> 1);
  const out = new Float32Array(total);
  out.set(xs[0], 0);
  let end = xs[0].length;
  // Report each input segment's start sample (empty segments get the current position).
  let ki = 0;
  const report = (pos) => {
    while (ki < all.length && all[ki].length === 0) starts[ki++] = pos;
    starts[ki++] = pos;
  };
  report(0);
  for (let k = 1; k < xs.length; k++) {
    const seg = xs[k];
    const ov = Math.min(X, seg.length >> 1, xs[k - 1].length >> 1);
    const start = end - ov;
    report(start);
    for (let i = 0; i < ov; i++) {
      const t = (i + 0.5) / ov;
      out[start + i] = out[start + i] * Math.cos((Math.PI / 2) * t) + seg[i] * Math.sin((Math.PI / 2) * t);
    }
    out.set(seg.subarray(ov), start + ov);
    end = start + seg.length;
  }
  return toPcm(out.subarray(0, end));
}

// Join PCM segments with a pause between each (no pause before the first).
export function joinPcm(segments, pauseMs = 0) {
  const parts = [];
  segments.forEach((seg, i) => {
    if (i > 0 && pauseMs > 0) parts.push(silence(pauseMs));
    parts.push(seg);
  });
  return Buffer.concat(parts);
}

export function applyGainDb(pcm, db) {
  if (!db) return pcm;
  const g = 10 ** (db / 20);
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * g))), i);
  }
  return out;
}

/**
 * Bring speech to a consistent level: RMS over active (non-silent) 20 ms frames
 * to `targetDb` dBFS, never letting peaks exceed `peakDb`. Silence stays silent.
 */
export function normalizeLoudness(pcm, { targetDb = -19, peakDb = -2 } = {}) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return pcm;
  const frame = 480;
  let sum = 0;
  let count = 0;
  let peak = 0;
  for (let s = 0; s < n; s += frame) {
    let e = 0;
    const end = Math.min(n, s + frame);
    for (let i = s; i < end; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      e += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    const rms = Math.sqrt(e / (end - s));
    if (rms > 0.01) {
      sum += e;
      count += end - s;
    }
  }
  if (!count || !peak) return pcm;
  const currentDb = 10 * Math.log10(sum / count);
  const gainDb = Math.min(targetDb - currentDb, peakDb - 20 * Math.log10(peak));
  return applyGainDb(pcm, Math.abs(gainDb) < 0.1 ? 0 : gainDb);
}

// ---------------------------------------------------------------------------
// Pitch shifting (real DSP, voice-independent): WSOLA time-stretch by r, then
// resample by r. Duration is preserved; formants shift with pitch, so keep it
// within about ±4 semitones for a natural sound.
// ---------------------------------------------------------------------------

function wsolaStretch(x, factor) {
  // factor > 1 → longer output. Waveform-similarity overlap-add.
  const N = 720; // 30 ms at 24 kHz
  const Hs = N / 2;
  const Ha = Hs / factor;
  const tol = 240; // ±10 ms search
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const outLen = Math.ceil(x.length * factor) + N;
  const out = new Float32Array(outLen);
  const norm = new Float32Array(outLen);
  let prev = 0; // analysis start of the previous frame
  for (let k = 0; ; k++) {
    const synth = k * Hs;
    const nominal = Math.round(k * Ha);
    if (nominal + N + tol >= x.length || synth + N >= outLen) break;
    let start = nominal;
    if (k > 0) {
      // Best match to the natural continuation of the previous frame.
      const target = prev + Hs;
      let best = -Infinity;
      for (let off = -tol; off <= tol; off += 2) {
        const s = nominal + off;
        if (s < 0) continue;
        let c = 0;
        for (let i = 0; i < Hs; i += 2) c += x[s + i] * x[target + i];
        if (c > best) {
          best = c;
          start = s;
        }
      }
    }
    for (let i = 0; i < N; i++) {
      out[synth + i] += x[start + i] * win[i];
      norm[synth + i] += win[i];
    }
    prev = start;
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-3) out[i] /= norm[i];
  return out.subarray(0, Math.ceil(x.length * factor));
}

export const MAX_PITCH_SHIFT = 12;

export function pitchShift(pcm, semitones) {
  const st = Number(semitones);
  if (!st) return pcm;
  if (!(Math.abs(st) <= MAX_PITCH_SHIFT)) throw new Error(`pitch_shift must be between -${MAX_PITCH_SHIFT} and ${MAX_PITCH_SHIFT} semitones`);
  const n = Math.floor(pcm.length / 2);
  if (n < 2000) return pcm;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;
  const r = 2 ** (st / 12);
  const stretched = wsolaStretch(x, r);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const p = i * r;
    const i0 = Math.floor(p);
    const i1 = Math.min(stretched.length - 1, i0 + 1);
    const v = i0 < stretched.length ? stretched[i0] + (stretched[i1] - stretched[i0]) * (p - i0) : 0;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  return out;
}

export function pcmToWav(pcm, rate = SAMPLE_RATE, channels = 1) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Parse a PCM16 WAV file, returning mono 24 kHz PCM (downmix + linear resample).
export function wavToPcm24k(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    if (id === "fmt ") {
      let format = body.readUInt16LE(0);
      // WAVE_FORMAT_EXTENSIBLE (what afconvert writes): the real format is in the SubFormat GUID.
      if (format === 0xfffe && body.length >= 26) format = body.readUInt16LE(24);
      fmt = {
        format,
        channels: body.readUInt16LE(2),
        rate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === "data") {
      data = body;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV file is missing its fmt or data chunk");
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error("only 16-bit PCM WAV is supported");
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2);
    mono[i] = sum / fmt.channels;
  }
  const outFrames = Math.floor((frames * SAMPLE_RATE) / fmt.rate);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    const src = (i * fmt.rate) / SAMPLE_RATE;
    const i0 = Math.floor(src);
    const i1 = Math.min(frames - 1, i0 + 1);
    const v = mono[i0] + (mono[i1] - mono[i0]) * (src - i0);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

export function pcmToMp3(pcm, { rate = SAMPLE_RATE, kbps = 96 } = {}) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const enc = new Mp3Encoder(1, rate, kbps);
  const out = [];
  const block = 1152 * 16;
  for (let i = 0; i < samples.length; i += block) {
    const b = enc.encodeBuffer(samples.subarray(i, i + block));
    if (b.length) out.push(Buffer.from(b));
  }
  const tail = enc.flush();
  if (tail.length) out.push(Buffer.from(tail));
  return Buffer.concat(out);
}

// AAC/M4A via macOS's built-in `afconvert` (no extra dependency). Other OSes: use mp3/wav.
export async function pcmToM4a(pcm) {
  if (process.platform !== "darwin") {
    throw new Error("m4a output needs macOS (afconvert). Use format mp3 or wav instead.");
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gptvoice-"));
  const wav = path.join(dir, "in.wav");
  const m4a = path.join(dir, "out.m4a");
  try {
    await fs.writeFile(wav, pcmToWav(pcm));
    const r = spawnSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "64000", wav, m4a], { encoding: "utf8" });
    if (r.error || r.status !== 0) throw new Error(`afconvert failed: ${r.error?.message || r.stderr || r.status}`);
    return await fs.readFile(m4a);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function encode(pcm, format) {
  switch (format) {
    case "wav":
      return pcmToWav(pcm);
    case "mp3":
      return pcmToMp3(pcm);
    case "m4a":
      return pcmToM4a(pcm);
    default:
      throw new Error(`unsupported format "${format}" — use one of: ${FORMATS.join(", ")}`);
  }
}

// Pick the output format: explicit wins, else from the extension, else mp3.
export function resolveFormat(out, format) {
  if (format) {
    const f = String(format).toLowerCase();
    if (!FORMATS.includes(f)) throw new Error(`unsupported format "${format}" — use one of: ${FORMATS.join(", ")}`);
    return f;
  }
  const ext = path.extname(out || "").slice(1).toLowerCase();
  return FORMATS.includes(ext) ? ext : "mp3";
}

// Make sure the path ends with the right extension for the chosen format.
export function withExtension(out, format) {
  const ext = path.extname(out);
  if (ext.slice(1).toLowerCase() === format) return out;
  if (FORMATS.includes(ext.slice(1).toLowerCase())) return out.slice(0, -ext.length) + "." + format;
  return out + "." + format;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// If `requested` exists, append -v2, -v3 ... so we never overwrite.
async function pickNonOverwritePath(requested, maxVersion = 999) {
  if (!(await pathExists(requested))) return requested;
  const dir = path.dirname(requested);
  const ext = path.extname(requested);
  const stem = path.basename(requested, ext);
  for (let n = 2; n <= maxVersion; n++) {
    const candidate = path.join(dir, `${stem}-v${n}${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`could not find a free filename under ${dir}/${stem}-vN${ext}`);
}

/**
 * Save audio bytes, resolving `out` relative to baseDir unless absolute, and
 * versioning the name if it already exists.
 * @returns {Promise<{savedPath: string, versioned: boolean}>}
 */
export async function saveAudio(out, baseDir, bytes) {
  const requested = path.isAbsolute(out) ? out : path.resolve(baseDir, out);
  try {
    await fs.mkdir(path.dirname(requested), { recursive: true });
  } catch (err) {
    throw new Error(`cannot create folder ${path.dirname(requested)}: ${err?.code || err?.message}`);
  }
  const savedPath = await pickNonOverwritePath(requested);
  try {
    // `wx` = fail instead of clobbering if another process grabbed the name meanwhile.
    await fs.writeFile(savedPath, bytes, { flag: "wx" });
  } catch (err) {
    if (err?.code === "EEXIST") return saveAudio(out, baseDir, bytes);
    throw new Error(`cannot write ${savedPath}: ${err?.code || err?.message}`);
  }
  return { savedPath, versioned: savedPath !== requested };
}
