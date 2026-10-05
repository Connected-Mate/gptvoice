import { test } from "node:test";
import assert from "node:assert/strict";
import { smoothTrim, crossfadeConcat, fadeEdges, roomTone, silence, pcmDurationSec, SAMPLE_RATE } from "../src/audio.js";
import { smoothness } from "../src/quality.js";
import { relocateCues } from "../src/cues.js";
import { tone } from "./helpers/mock-server.js";

const levelDb = (pcm, fromS, toS) => {
  const a = Math.round(fromS * SAMPLE_RATE);
  const b = Math.round(toS * SAMPLE_RATE);
  let e = 0;
  for (let i = a; i < b; i++) e += (pcm.readInt16LE(i * 2) / 32768) ** 2;
  return 10 * Math.log10(e / (b - a) || 1e-20);
};

// A "word" whose last 300 ms decays from -20 to about -55 dBFS, like a real syllable tail.
function decayingWord() {
  const n = Math.round(0.8 * SAMPLE_RATE);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const attack = Math.min(1, t / 0.02); // natural 20 ms attack
    const env = attack * (t < 0.5 ? 0.1 : 0.1 * 10 ** ((-35 * (t - 0.5)) / 0.3 / 20));
    b.writeInt16LE(Math.round(32767 * env * Math.sin(2 * Math.PI * 180 * t)), i * 2);
  }
  return Buffer.concat([silence(300), b, silence(400)]);
}

test("smoothTrim keeps the natural decay of the last syllable (old trim cut it)", () => {
  const out = smoothTrim(decayingWord());
  // Sound lasts 0.8 s; kept: 40 ms head + 0.8 s + up to 160 ms tail.
  assert.ok(pcmDurationSec(out) >= 0.82 && pcmDurationSec(out) <= 1.01, `kept ${pcmDurationSec(out)}s`);
});

test("smoothTrim fades in and out when the take starts/ends while sounding (no step at the edges)", () => {
  const out = smoothTrim(tone(500)); // sound from the very first to the very last sample
  assert.ok(Math.abs(out.readInt16LE(0)) < 50, `first sample ${out.readInt16LE(0)}`);
  assert.ok(Math.abs(out.readInt16LE(out.length - 2)) < 50, "last sample near zero");
  assert.equal(smoothness(out).abruptOnsets + smoothness(out).abruptOffsets, 0);
});

test("room tone is low-level noise, not digital zero", () => {
  const r = roomTone(1000);
  const db = levelDb(r, 0, 1);
  assert.ok(db > -74 && db < -70, `room tone ${db} dB`);
  assert.equal(smoothness(r).digitalSilence.count, 0);
});

test("equal-power crossfade: no click at the join and length = sum − overlap", () => {
  const a = tone(500);
  const b = Buffer.alloc(a.length);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE + 1.3)), i * 2);
  const hard = Buffer.concat([a, silence(300), b]);
  const smooth = crossfadeConcat([a, roomTone(300 + 80), b], { xfadeMs: 40 });
  assert.ok(Math.abs(pcmDurationSec(smooth) - (0.5 + 0.38 + 0.5 - 0.08)) < 0.002);
  const qHard = smoothness(hard);
  const qSmooth = smoothness(smooth);
  assert.ok(qHard.clicks + qHard.abruptOnsets + qHard.abruptOffsets > 0, "the hard version is detected");
  assert.equal(qSmooth.clicks + qSmooth.abruptOnsets + qSmooth.abruptOffsets, 0, JSON.stringify(qSmooth));
});

test("crossfadeConcat reports where each segment starts", () => {
  const starts = [];
  crossfadeConcat([tone(200), silence(0), tone(200)], { xfadeMs: 40, starts });
  assert.equal(starts.length, 3);
  assert.equal(starts[0], 0);
  assert.equal(starts[2], Math.round(0.2 * SAMPLE_RATE) - Math.round(0.04 * SAMPLE_RATE));
});

test("fadeEdges silences the very first and last samples", () => {
  const out = fadeEdges(tone(500));
  assert.equal(out.readInt16LE(0), 0);
  assert.ok(Math.abs(out.readInt16LE(out.length - 2)) < 20);
});

test("detector: a mid-word cut spliced to digital silence is flagged; a clean take is not", () => {
  const w = decayingWord();
  const cut = Buffer.concat([w.subarray(0, Math.round(0.55 * SAMPLE_RATE) * 2), silence(500)]);
  const q = smoothness(cut, [0.55]);
  assert.ok(q.abruptOffsets >= 1, JSON.stringify(q));
  assert.equal(q.hotJoins, 1);
  const clean = smoothness(smoothTrim(w));
  assert.equal(clean.abruptOffsets + clean.abruptOnsets, 0);
});

test("sentence-safe cues: mid-sentence pause → '…', mid-sentence direction → sentence start, boundary cues kept", () => {
  assert.equal(relocateCues("A voice… [pause 0.6s] one tool changes everything."), "A voice… one tool changes everything.");
  assert.equal(relocateCues("Wait, [pause 1s] what?"), "Wait… what?");
  assert.equal(relocateCues("It was late. Then [excited] they arrived!"), "It was late. [excited] Then they arrived!");
  assert.equal(relocateCues("Done. [pause 1s] Next."), "Done. [pause 1s] Next.");
  assert.equal(relocateCues("End here [pause 2s]"), "End here [pause 2s]");
  assert.equal(relocateCues("We did it, [laughs] all of us!"), "We did it, [laughs] all of us!", "sounds stay inline");
});

test("director heuristic gives one direction per paragraph, energetic for exclamations", async () => {
  const { heuristicDirections } = await import("../src/director.js");
  const d = heuristicDirections(["Calm opening.", "Run! Now! Go!", "« Who is there? » she asked.", "The end."]);
  assert.equal(d.length, 4);
  assert.match(d[1], /energetic/);
  assert.match(d[2], /quoted lines/);
  assert.match(d[3], /resolution/);
});
