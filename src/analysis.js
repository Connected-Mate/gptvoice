// Objective acoustic measurements on mono 24 kHz PCM16, used to tag voices
// (register) and to A/B-test which controls really change the audio.
//
// - pitch: YIN fundamental-frequency estimate per 40 ms frame (60-500 Hz)
// - loudness: RMS in dBFS over voiced/active frames
// - pace: words per second (caller supplies the word count)

import { SAMPLE_RATE } from "./audio.js";

function toFloat(pcm) {
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

// YIN (de Cheveigné & Kawahara 2002), cumulative-mean-normalized difference.
function yinFrame(x, start, size, minLag, maxLag, threshold = 0.12) {
  const d = new Float32Array(maxLag + 1);
  for (let tau = 1; tau <= maxLag; tau++) {
    let sum = 0;
    for (let i = 0; i < size; i++) {
      const diff = x[start + i] - x[start + i + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  let running = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    running += d[tau];
    d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (d[tau] < threshold) {
      while (tau + 1 <= maxLag && d[tau + 1] < d[tau]) tau++;
      // parabolic interpolation for sub-sample accuracy
      const a = d[tau - 1] ?? d[tau];
      const b = d[tau];
      const c = d[tau + 1] ?? d[tau];
      const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
      return SAMPLE_RATE / (tau + (Number.isFinite(shift) ? shift : 0));
    }
  }
  return 0;
}

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const HOP_SEC = 0.01;

/**
 * Per-frame contour (10 ms hop): rms (linear) and f0 (Hz, 0 = unvoiced/silent).
 * @returns {{rms: Float32Array, f0: Float32Array, durationSec: number}}
 */
export function contourPcm(pcm) {
  const x = toFloat(pcm);
  const frame = Math.round(0.04 * SAMPLE_RATE);
  const hop = Math.round(HOP_SEC * SAMPLE_RATE);
  const minLag = Math.floor(SAMPLE_RATE / 500);
  const maxLag = Math.ceil(SAMPLE_RATE / 60);
  const n = Math.max(0, Math.floor((x.length - frame - maxLag) / hop) + 1);
  const rms = new Float32Array(n);
  const f0 = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const s = k * hop;
    let e = 0;
    for (let i = 0; i < frame; i++) e += x[s + i] * x[s + i];
    rms[k] = Math.sqrt(e / frame);
    if (rms[k] < 0.01) continue;
    const f = yinFrame(x, s, frame, minLag, maxLag);
    if (f > 60 && f < 500) f0[k] = f;
  }
  return { rms, f0, durationSec: x.length / SAMPLE_RATE };
}

/** Aggregate stats over frames [from, to) of a contour. */
export function windowStats(c, from = 0, to = c.rms.length) {
  const f0s = [];
  const energies = [];
  let active = 0;
  for (let k = Math.max(0, from); k < Math.min(to, c.rms.length); k++) {
    if (c.rms[k] < 0.01) continue;
    active++;
    energies.push(c.rms[k]);
    if (c.f0[k]) f0s.push(c.f0[k]);
  }
  const f0Median = median(f0s);
  const semis = f0s.map((f) => 12 * Math.log2(f / (f0Median || 1)));
  const meanSemi = semis.reduce((a, b) => a + b, 0) / (semis.length || 1);
  const sd = Math.sqrt(semis.reduce((a, b) => a + (b - meanSemi) ** 2, 0) / (semis.length || 1));
  const meanSq = energies.reduce((a, b) => a + b * b, 0) / (energies.length || 1);
  return {
    activeSec: round(active * HOP_SEC),
    f0Median: Math.round(f0Median),
    f0Semitones: round(sd),
    loudnessDb: energies.length ? round(10 * Math.log10(meanSq)) : null,
    voicedRatio: round(f0s.length / (active || 1)),
  };
}

/**
 * @returns {{durationSec, activeSec, f0Median, f0Semitones, loudnessDb, voicedRatio, frames}}
 *  f0Semitones = spread (std-dev) of pitch in semitones = how "melodic" the intonation is.
 */
export function analyzePcm(pcm) {
  const c = contourPcm(pcm);
  return { durationSec: round(c.durationSec), ...windowStats(c), frames: c.rms.length };
}

/**
 * Speech/silence segmentation from the contour. Silence = frames under a level
 * relative to the clip's speech level; gaps shorter than `bridgeSec` are bridged
 * (stops inside words), so what remains are real pauses.
 * @returns {{speech: Array<{start, end}>, pauses: Array<{start, end, duration}>}}
 */
export function segmentSpeech(c, { minPauseSec = 0.25, bridgeSec = 0.15 } = {}) {
  const sorted = [...c.rms].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
  const thr = Math.max(0.008, p90 * 0.08);
  const raw = [];
  let start = -1;
  for (let k = 0; k <= c.rms.length; k++) {
    const on = k < c.rms.length && c.rms[k] >= thr;
    if (on && start < 0) start = k;
    if (!on && start >= 0) {
      raw.push([start, k]);
      start = -1;
    }
  }
  const merged = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && (seg[0] - last[1]) * HOP_SEC < bridgeSec) last[1] = seg[1];
    else merged.push([...seg]);
  }
  // Drop blips shorter than 60 ms (clicks, breaths at the edge).
  const speech = merged.filter(([a, b]) => (b - a) * HOP_SEC >= 0.06).map(([a, b]) => ({ start: round(a * HOP_SEC), end: round(b * HOP_SEC) }));
  const pauses = [];
  for (let i = 1; i < speech.length; i++) {
    const d = speech[i].start - speech[i - 1].end;
    if (d >= minPauseSec) pauses.push({ start: speech[i - 1].end, end: speech[i].start, duration: round(d) });
  }
  return { speech, pauses };
}

const round = (v) => Math.round(v * 100) / 100;
