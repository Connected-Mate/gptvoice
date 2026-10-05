// Controls, cues, presets and verification through the full pipeline (mock backend).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMock, smartBehavior } from "./helpers/mock-server.js";

const out = await fs.mkdtemp(path.join(os.tmpdir(), "gptvoice-ctl-"));
process.env.GPTVOICE_RETRY_BASE_MS = "5";
process.env.GPTVOICE_CONFIG = path.join(out, "config.json");
const { generateSpeech, generateDialogue } = await import("../src/tts.js");
const { savePreset } = await import("../src/config.js");
const { decodeToPcm } = await import("../src/transcribe.js");
const { pcmDurationSec } = await import("../src/audio.js");

const creds = async () => ({ access: "t", accountId: "a" });
const mocks = [];
async function mock(b) {
  const m = await startMock([b]);
  mocks.push(m);
  process.env.GPTVOICE_REALTIME_URL = m.url;
  return m;
}
after(async () => {
  for (const m of mocks) await m.close();
});
const updates = (m) => m.connections.filter((c) => !/transcription/.test(c.url)).map((c) => c.messages.find((x) => x.type === "session.update").session);

test("speed is sent natively; other controls land in the instructions", async () => {
  const m = await mock(smartBehavior());
  await generateSpeech({ text: "A calm night by the sea.", speed: 1.25, emotion: "sadness", volume: "soft", accent: "Irish", out: "s.wav", baseDir: out, getCreds: creds });
  const u = updates(m)[0];
  assert.equal(u.audio.output.speed, 1.25);
  assert.match(u.instructions, /sad: slow/);
  assert.match(u.instructions, /soft and quiet/);
  assert.match(u.instructions, /Irish accent/);
});

test("[pause 1s] inserts exactly one second of silence between passages", async () => {
  await mock(smartBehavior());
  const a = await generateSpeech({ text: "First part here. Second part here.", out: "p0.wav", baseDir: out, getCreds: creds, normalize: false });
  const b = await generateSpeech({ text: "First part here. [pause 1s] Second part here.", out: "p1.wav", baseDir: out, getCreds: creds, normalize: false });
  const d = pcmDurationSec(await decodeToPcm(b.savedPath)) - pcmDurationSec(await decodeToPcm(a.savedPath));
  // Each mock passage = 0.4 s tone + 2 × 60 ms trim margin = 0.52 s. One passage
  // vs two passages separated by exactly 1.000 s → +1.52 s.
  assert.ok(Math.abs(d - 1.52) < 0.03, `extra ${d}s`);
  assert.equal(b.passages, 2);
});

test("[whispers] and [laughs] never reach the voice as words", async () => {
  const m = await mock(smartBehavior());
  await generateSpeech({ text: "[laughs] We did it! [whispers] Now be quiet.", out: "c.wav", baseDir: out, getCreds: creds });
  const [first, second] = updates(m);
  assert.match(first.instructions, /"""\nHa ha ha! We did it!\n"""/);
  assert.match(second.instructions, /WHISPER every word/);
  assert.ok(!/\[(laughs|whispers)\]/.test(first.instructions + second.instructions));
});

test("pronunciation dictionary: voice gets the respelling, accuracy still 100%", async () => {
  const m = await mock(smartBehavior());
  const r = await generateSpeech({ text: "Welcome Mister Nguyen to the station.", pronunciations: { Nguyen: "win" }, out: "n.wav", baseDir: out, getCreds: creds });
  assert.match(updates(m)[0].instructions, /Welcome Mister win to the station/);
  assert.equal(r.accuracy, 100);
});

test("presets: saved settings apply, explicit arguments override them", async () => {
  await savePreset("doc", { voice: "cedar", narration: "documentary", speed: 0.9 });
  const m = await mock(smartBehavior());
  await generateSpeech({ text: "The river runs to the sea.", preset: "doc", speed: 1.1, out: "pr.wav", baseDir: out, getCreds: creds });
  const u = updates(m)[0];
  assert.equal(u.audio.output.voice, "cedar");
  assert.equal(u.audio.output.speed, 1.1);
  assert.match(u.instructions, /documentary narrator/);
  await assert.rejects(generateSpeech({ text: "x y z", preset: "missing", out: "x.wav", getCreds: creds }), /no preset named "missing"/);
});

test("dialogue speakers can be mapped to presets", async () => {
  await savePreset("captain", { voice: "ash", character: "an old sea captain" });
  const m = await mock(smartBehavior());
  const r = await generateDialogue({ script: "CAPTAIN: Hoist the sails now.\nMIA: Aye aye, captain!", voices: { CAPTAIN: "captain" }, out: "d.wav", baseDir: out, getCreds: creds });
  assert.equal(r.cast.captain, "ash");
  assert.match(updates(m).find((u) => u.audio.output.voice === "ash").instructions, /old sea captain/);
  await assert.rejects(generateDialogue({ script: "A: hi there", voices: { A: "nobody" }, out: "x.wav", getCreds: creds }), /neither a voice .* nor a saved preset/);
});

test("pitch_shift is validated and applied (audio processing)", async () => {
  await mock(smartBehavior());
  await assert.rejects(generateSpeech({ text: "hello", pitch_shift: 20, out: "x.wav", getCreds: creds }), /pitch_shift must be between/);
  const r = await generateSpeech({ text: "A slightly higher voice please.", pitch_shift: 3, out: "ps.wav", baseDir: out, getCreds: creds });
  assert.ok(r.durationSec > 0.3);
});

test("verify: independent transcription re-records a passage the listener did not hear right", async () => {
  let calls = 0;
  const m = await mock(smartBehavior({ heard: (s) => (++calls === 1 ? "something else entirely, sorry" : s) }));
  const r = await generateSpeech({ text: "Please read this sentence exactly as written.", verify: true, out: "v.wav", baseDir: out, getCreds: creds });
  assert.equal(r.verifiedAccuracy, 100);
  assert.equal(m.connections.filter((c) => /transcription/.test(c.url)).length, 2);
});

test("verify: whispered passages are checked on the model transcript only", async () => {
  const m = await mock(smartBehavior({ heard: () => "여기서 좀 더" }));
  const r = await generateSpeech({ text: "Do not make a single sound now.", volume: "whisper", verify: true, out: "w.wav", baseDir: out, getCreds: creds });
  assert.equal(m.connections.filter((c) => /transcription/.test(c.url)).length, 0);
  assert.equal(r.accuracy, 100);
});
