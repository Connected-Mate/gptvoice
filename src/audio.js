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

// Join PCM segments with a pause between each (no pause before the first).
export function joinPcm(segments, pauseMs = 0) {
  const parts = [];
  segments.forEach((seg, i) => {
    if (i > 0 && pauseMs > 0) parts.push(silence(pauseMs));
    parts.push(seg);
  });
  return Buffer.concat(parts);
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
