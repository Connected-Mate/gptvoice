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

/**
 * @returns {{durationSec, activeSec, f0Median, f0Semitones, loudnessDb, voicedRatio}}
 *  f0Semitones = spread (std-dev) of pitch in semitones = how "melodic" the intonation is.
 */
export function analyzePcm(pcm) {
  const x = toFloat(pcm);
  const frame = Math.round(0.04 * SAMPLE_RATE);
  const hop = Math.round(0.01 * SAMPLE_RATE);
  const minLag = Math.floor(SAMPLE_RATE / 500);
  const maxLag = Math.ceil(SAMPLE_RATE / 60);
  const f0s = [];
  const energies = [];
  let active = 0;
  let frames = 0;
  for (let s = 0; s + frame + maxLag < x.length; s += hop) {
    frames++;
    let e = 0;
    for (let i = 0; i < frame; i++) e += x[s + i] * x[s + i];
    const rms = Math.sqrt(e / frame);
    if (rms < 0.01) continue; // silence
    active++;
    energies.push(rms);
    const f0 = yinFrame(x, s, frame, minLag, maxLag);
    if (f0 > 60 && f0 < 500) f0s.push(f0);
  }
  const f0Median = median(f0s);
  const semis = f0s.map((f) => 12 * Math.log2(f / (f0Median || 1)));
  const meanSemi = semis.reduce((a, b) => a + b, 0) / (semis.length || 1);
  const sd = Math.sqrt(semis.reduce((a, b) => a + (b - meanSemi) ** 2, 0) / (semis.length || 1));
  const meanSq = energies.reduce((a, b) => a + b * b, 0) / (energies.length || 1);
  return {
    durationSec: round(x.length / SAMPLE_RATE),
    activeSec: round((active * hop) / SAMPLE_RATE),
    f0Median: Math.round(f0Median),
    f0Semitones: round(sd),
    loudnessDb: round(10 * Math.log10(meanSq || 1e-12)),
    voicedRatio: round(f0s.length / (active || 1)),
    frames,
  };
}

const round = (v) => Math.round(v * 100) / 100;
