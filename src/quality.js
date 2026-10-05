// Audio smoothness checks for spoken clips: clicks/discontinuities, abrupt
// on/offsets (hard cuts into or out of digital silence), clipped endings,
// voiced audio at join points (mid-word cuts), digital-zero gaps (no room tone)
// and sample clipping. All on mono 24 kHz PCM16.

import { SAMPLE_RATE } from "./audio.js";

const toFloat = (pcm) => {
  const n = Math.floor(pcm.length / 2);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;
  return x;
};
const db = (v) => 20 * Math.log10(Math.max(v, 1e-9));
const r3 = (v) => Math.round(v * 1000) / 1000;

function rmsDb(x, from, to) {
  from = Math.max(0, from);
  to = Math.min(x.length, to);
  if (to <= from) return -180;
  let e = 0;
  for (let i = from; i < to; i++) e += x[i] * x[i];
  return db(Math.sqrt(e / (to - from)));
}

/**
 * Audible clicks: a sample-to-sample step that stands out from its
 * surroundings in a QUIET context (splices into silence, DC jumps, cut
 * waveforms). Steps inside loud speech (plosives, fricatives) are masked and
 * natural, so they are not counted.
 */
function findClicks(x, { quietDb = -38, ratio = 6 } = {}) {
  const W = Math.round(0.005 * SAMPLE_RATE);
  const clicks = [];
  // Running sums for fast local RMS of the signal and of its first difference.
  const n = x.length;
  const cs = new Float64Array(n + 1);
  const cd = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cs[i + 1] = cs[i] + x[i] * x[i];
    const d = i ? x[i] - x[i - 1] : 0;
    cd[i + 1] = cd[i] + d * d;
  }
  const quiet = 10 ** (quietDb / 20);
  for (let i = W + 1; i < n - W - 1; i++) {
    const step = Math.abs(x[i] - x[i - 1]);
    if (step < 0.01) continue;
    const before = Math.sqrt((cs[i - 1] - cs[i - 1 - W]) / W);
    const after = Math.sqrt((cs[i + 1 + W] - cs[i + 1]) / W);
    if (Math.min(before, after) > quiet && Math.max(before, after) > quiet * 2) continue; // inside sound: masked
    const dLocal = Math.sqrt(((cd[i - 1] - cd[i - 1 - W]) + (cd[i + 1 + W] - cd[i + 1])) / (2 * W)) || 1e-6;
    if (step > ratio * dLocal) {
      const t = i / SAMPLE_RATE;
      if (!clicks.length || t - clicks[clicks.length - 1] > 0.02) clicks.push(r3(t));
    }
  }
  return clicks;
}

/**
 * Abrupt edges: sound starting or stopping next to near-digital silence with
 * no ramp — it reaches (or leaves) its level within `maxRampMs`. A 10-30 ms
 * fade or a natural onset ramps; a hard cut does not.
 */
function findAbruptEdges(x, { silentDb = -60, minJumpDb = 30, maxRampMs = 2.5 } = {}) {
  const F = Math.round(0.001 * SAMPLE_RATE); // 1 ms frames
  const lv = [];
  for (let s = 0; s + F <= x.length; s += F) lv.push(rmsDb(x, s, s + F));
  const onsets = [];
  const offsets = [];
  const ramp = Math.ceil(maxRampMs);
  for (let k = 1; k + 30 < lv.length; k++) {
    // Onset: silence before, loud 30 ms later.
    if (lv[k - 1] < silentDb && lv[k] > silentDb) {
      const later = Math.max(...lv.slice(k, k + 30));
      if (later - lv[k - 1] > minJumpDb && later > -45) {
        const reach = lv.slice(k, k + 30).findIndex((v) => v >= later - 6);
        if (reach >= 0 && reach < ramp) onsets.push(r3((k * F) / SAMPLE_RATE));
      }
    }
  }
  for (let k = 30; k < lv.length - 1; k++) {
    // Offset: loud 30 ms before, silence after.
    if (lv[k + 1] < silentDb && lv[k] > silentDb) {
      const earlier = Math.max(...lv.slice(k - 29, k + 1));
      if (earlier - lv[k + 1] > minJumpDb && earlier > -45) {
        const back = lv.slice(k - 29, k + 1).reverse().findIndex((v) => v >= earlier - 6);
        if (back >= 0 && back < ramp) offsets.push(r3(((k + 1) * F) / SAMPLE_RATE));
      }
    }
  }
  return { onsets, offsets };
}

/** Runs of exact digital zero longer than `minMs` (silence with no room tone). */
function digitalSilence(x, minMs = 50) {
  const min = Math.round((minMs / 1000) * SAMPLE_RATE);
  let run = 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i <= x.length; i++) {
    if (i < x.length && x[i] === 0) run++;
    else {
      if (run >= min) {
        total += run;
        count++;
      }
      run = 0;
    }
  }
  return { count, seconds: r3(total / SAMPLE_RATE) };
}

/**
 * @param pcm   mono 24 kHz PCM16
 * @param joins optional join times (s) between passages, e.g. from .timings.json
 */
export function smoothness(pcm, joins = []) {
  const x = toFloat(pcm);
  const ms = (m) => Math.round((m / 1000) * SAMPLE_RATE);
  const head30 = rmsDb(x, 0, ms(30));
  const tail30 = rmsDb(x, x.length - ms(30), x.length);
  const edges = findAbruptEdges(x);
  const clicks = findClicks(x);
  let clipped = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= 0.999) clipped++;
  // Voiced energy right at a join = the passage was cut while sound was still going.
  const hotJoins = joins
    .map((t) => ({ t: r3(t), before: rmsDb(x, ms(t * 1000) - ms(20), ms(t * 1000)), after: rmsDb(x, ms(t * 1000), ms(t * 1000) + ms(20)) }))
    .filter((j) => j.before > -40 || j.after > -40);
  return {
    clicks: clicks.length,
    clickTimes: clicks.slice(0, 20),
    abruptOnsets: edges.onsets.length,
    abruptOffsets: edges.offsets.length,
    edgeTimes: [...edges.onsets, ...edges.offsets].sort((a, b) => a - b).slice(0, 20),
    startsAbruptly: head30 > -45,
    endsAbruptly: tail30 > -45,
    headDb: Math.round(head30),
    tailDb: Math.round(tail30),
    clippedSamples: clipped,
    digitalSilence: digitalSilence(x),
    hotJoins: hotJoins.length,
    hotJoinTimes: hotJoins.slice(0, 20).map((j) => j.t),
  };
}

export function describeSmoothness(q) {
  const issues = [];
  if (q.clicks) issues.push(`${q.clicks} click(s)/discontinuities at ${q.clickTimes.slice(0, 6).join(", ")}s`);
  if (q.abruptOnsets || q.abruptOffsets) issues.push(`${q.abruptOnsets} abrupt start(s), ${q.abruptOffsets} abrupt stop(s) (hard cuts next to silence) at ${q.edgeTimes.slice(0, 6).join(", ")}s`);
  if (q.startsAbruptly) issues.push(`no head room: sound in the first 30 ms (${q.headDb} dB)`);
  if (q.endsAbruptly) issues.push(`cut-off ending: sound in the last 30 ms (${q.tailDb} dB)`);
  if (q.hotJoins) issues.push(`${q.hotJoins} join(s) cut while voiced at ${q.hotJoinTimes.slice(0, 6).join(", ")}s`);
  if (q.clippedSamples) issues.push(`${q.clippedSamples} clipped sample(s)`);
  if (q.digitalSilence.count) issues.push(`${q.digitalSilence.count} digital-zero gap(s) (${q.digitalSilence.seconds}s without room tone)`);
  return issues.length ? `Smoothness issues: ${issues.join("; ")}.` : "Smoothness: no clicks, hard cuts, cut-off ending or clipping detected.";
}
