import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMock, smartBehavior, tone } from "./helpers/mock-server.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gptvoice-insp-"));
process.env.GPTVOICE_RETRY_BASE_MS = "5";
const { contourPcm, segmentSpeech } = await import("../src/analysis.js");
const { pcmToWav, silence } = await import("../src/audio.js");
const { inspectAudio, inspectFolder, describeInspection } = await import("../src/inspect.js");
const { generateClips } = await import("../src/tts.js");
const { splitSentences } = await import("../src/text.js");

const creds = async () => ({ access: "t", accountId: "a" });
const mocks = [];
after(async () => {
  for (const m of mocks) await m.close();
});

test("speech segmentation finds pauses to ~10 ms and ignores sub-150 ms gaps", () => {
  const pcm = Buffer.concat([silence(200), tone(800), silence(100), tone(500), silence(600), tone(700), silence(300)]);
  const { speech, pauses } = segmentSpeech(contourPcm(pcm));
  assert.equal(speech.length, 2, "the 100 ms gap is bridged");
  assert.equal(pauses.length, 1);
  assert.ok(Math.abs(pauses[0].duration - 0.6) < 0.06, `pause ${pauses[0].duration}`);
  assert.ok(Math.abs(pauses[0].start - 1.6) < 0.06, `start ${pauses[0].start}`);
});

test("inspect: uses the .timings.json sidecar, reports per-sentence stats, target fit and a valid PNG", async () => {
  const pcm = Buffer.concat([tone(1000), silence(700), tone(1500)]);
  const f = path.join(dir, "clip.wav");
  await fs.writeFile(f, pcmToWav(pcm));
  await fs.writeFile(
    path.join(dir, "clip.timings.json"),
    JSON.stringify({ file: "clip.wav", durationSec: 3.2, passages: [{ start: 0, end: 3.2, text: "One two three. Four five six seven." }], sentences: [{ start: 0, end: 1, text: "One two three." }, { start: 1.7, end: 3.2, text: "Four five six seven." }] }),
  );
  const r = await inspectAudio(f, { picture: true, targetSec: 3 });
  assert.equal(r.durationSec, 3.2);
  assert.match(r.timing, /exact passages/);
  assert.equal(r.sentences.length, 2);
  assert.equal(r.sentences[1].wordsPerSec, 2.67);
  assert.equal(r.sentences[0].pitchHz, 440);
  assert.equal(r.pauses.length, 1);
  assert.deepEqual(r.target, { seconds: 3, differenceSec: 0.2, fits: true });
  const png = await fs.readFile(r.picture);
  assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.match(describeInspection(r), /Target 3s: fits/);
});

test("inspect without sidecar transcribes and lays sentences on the speech", async () => {
  const m = await startMock([smartBehavior({ heard: () => "Hello there. How are you today?" })]);
  mocks.push(m);
  process.env.GPTVOICE_REALTIME_URL = m.url;
  const f = path.join(dir, "raw.wav");
  await fs.writeFile(f, pcmToWav(Buffer.concat([tone(700), silence(800), tone(1300)])));
  const r = await inspectAudio(f, { getCreds: creds });
  assert.match(r.timing, /estimated/);
  assert.deepEqual(r.sentences.map((s) => s.text), ["Hello there.", "How are you today?"]);
  assert.ok(Math.abs(r.sentences[0].end - 0.7) < 0.08 && Math.abs(r.sentences[1].start - 1.5) < 0.08, JSON.stringify(r.sentences));
});

test("inspectFolder: every audio file, sorted; clear error on empty folder", async () => {
  const sub = path.join(dir, "set");
  await fs.mkdir(sub);
  for (const n of ["02-b.wav", "01-a.wav"]) await fs.writeFile(path.join(sub, n), pcmToWav(tone(500)));
  await fs.writeFile(path.join(sub, "notes.txt"), "x");
  const rs = await inspectFolder(sub, { transcribe: false });
  assert.deepEqual(rs.map((r) => path.basename(r.file)), ["01-a.wav", "02-b.wav"]);
  await fs.mkdir(path.join(dir, "empty"));
  await assert.rejects(inspectFolder(path.join(dir, "empty")), /no audio files/);
});

test("generate_clips: numbered files + srt + timings + manifest; fitting tries speed and reports misfits", async () => {
  const m = await startMock([smartBehavior()]);
  mocks.push(m);
  process.env.GPTVOICE_REALTIME_URL = m.url;
  const r = await generateClips({
    lines: [
      { id: "Intro shot", text: "Welcome to the harbour tonight.", target_seconds: 1.2 },
      { id: "end", text: "And the light came home.", target_seconds: 3, voice: "cedar" },
    ],
    out_dir: "clips",
    baseDir: dir,
    getCreds: creds,
  });
  const names = (await fs.readdir(r.dir)).sort();
  assert.deepEqual(names, ["01-intro-shot.mp3", "01-intro-shot.srt", "01-intro-shot.timings.json", "02-end.mp3", "02-end.srt", "02-end.timings.json", "clips.json"]);
  assert.equal(r.clips[0].fits, true);
  assert.equal(r.clips[0].takes, 1);
  // The mock ignores speed, so ~1.2 s can never stretch to 3 s: speed drops to
  // 0.4, then the 0.25 floor, then stops (no further change possible) and reports the misfit.
  assert.equal(r.clips[1].fits, false);
  assert.equal(r.clips[1].takes, 3);
  const speeds = m.connections.filter((c) => !/transcription/.test(c.url)).map((c) => c.messages.find((x) => x.type === "session.update").session.audio.output.speed);
  assert.deepEqual(speeds, [undefined, undefined, 0.4, 0.25]);
  const manifest = JSON.parse(await fs.readFile(r.manifestPath, "utf8"));
  assert.equal(manifest.clips[1].timelineStart, manifest.clips[0].durationSec);
  const timings = JSON.parse(await fs.readFile(path.join(r.dir, "02-end.timings.json"), "utf8"));
  assert.equal(timings.file, "02-end.mp3");
  await assert.rejects(generateClips({ lines: [], getCreds: creds }), /at least one line/);
});

test("splitSentences keeps punctuation", () => {
  assert.deepEqual(splitSentences("Hi. How are you? Fine!"), ["Hi.", "How are you?", "Fine!"]);
});
