// End-to-end orchestration against a local mock of the realtime WebSocket.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMock, ttsBehavior } from "./helpers/mock-server.js";

process.env.GPTVOICE_RETRY_BASE_MS = "5";
process.env.GPTVOICE_IDLE_TIMEOUT_MS = "800";
process.env.GPTVOICE_CONCURRENCY = "2";
const { generateSpeech, generateDialogue } = await import("../src/tts.js");
const { transcribePcm } = await import("../src/realtime.js");

const out = await fs.mkdtemp(path.join(os.tmpdir(), "gptvoice-tts-"));
const creds = (calls = []) => async (opts = {}) => {
  calls.push(opts.force ? "force" : "normal");
  return { access: opts.force ? "fresh-token" : "token", accountId: "acct" };
};
const mocks = [];
async function mock(behaviors) {
  const m = await startMock(behaviors);
  mocks.push(m);
  process.env.GPTVOICE_REALTIME_URL = m.url;
  return m;
}
after(async () => {
  for (const m of mocks) await m.close();
});

test("happy path: sends auth headers, voice, verbatim instructions; writes a wav", async () => {
  const m = await mock([ttsBehavior()]);
  const r = await generateSpeech({ text: "Bonjour tout le monde, voici un test.", voice: "cedar", style: "whisper", out: "a.wav", baseDir: out, getCreds: creds() });
  assert.equal(r.format, "wav");
  assert.equal(r.passages, 1);
  assert.ok(r.durationSec > 0.4 && r.durationSec < 0.7, `duration ${r.durationSec}`);
  assert.deepEqual(r.warnings, []);
  const c = m.connections[0];
  assert.equal(c.headers.authorization, "Bearer token");
  assert.equal(c.headers["chatgpt-account-id"], "acct");
  assert.match(c.url, /model=gpt-realtime/);
  const upd = c.messages.find((x) => x.type === "session.update").session;
  assert.equal(upd.audio.output.voice, "cedar");
  assert.match(upd.instructions, /exactly as written/);
  assert.match(upd.instructions, /whisper/);
  assert.match(upd.instructions, /# SCRIPT\n"""\nBonjour tout le monde, voici un test.\n"""/);
  assert.equal(c.messages.find((x) => x.type === "conversation.item.create").item.content[0].text, "Perform the SCRIPT now.");
  const wav = await fs.readFile(r.savedPath);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
});

test("long text → several passages, joined in order, with subtitles", async () => {
  await mock([ttsBehavior()]);
  const para = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} is here to fill the paragraph nicely.`).join(" ");
  const r = await generateSpeech({ text: `${para}\n\n${para}`, out: "long.mp3", baseDir: out, subtitles: true, getCreds: creds() });
  assert.ok(r.passages >= 4, `passages ${r.passages}`);
  const srt = await fs.readFile(r.subtitlesPath, "utf8");
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.match(srt, /Sentence number 0/);
  assert.equal(r.transcript.split("\n")[0].startsWith("Sentence number 0"), true);
});

test("401 → one forced token refresh, then success", async () => {
  const m = await mock([{ status: 401, body: '{"error":"expired"}' }, ttsBehavior()]);
  const calls = [];
  const r = await generateSpeech({ text: "Refresh me please now.", out: "r.mp3", baseDir: out, getCreds: creds(calls) });
  assert.ok(r.savedPath.endsWith(".mp3"));
  assert.deepEqual(calls, ["normal", "force"]);
  assert.equal(m.connections[1].headers.authorization, "Bearer fresh-token");
});

test("persistent 401 → asks the user to log in", async () => {
  await mock([{ status: 401 }]);
  await assert.rejects(generateSpeech({ text: "Hello there my friend.", out: "x.mp3", baseDir: out, getCreds: creds() }), /401.*npm run login/);
});

test("429 is retried with backoff, then succeeds", async () => {
  const m = await mock([{ status: 429 }, { status: 429 }, ttsBehavior()]);
  const r = await generateSpeech({ text: "Patience is a virtue.", out: "p.mp3", baseDir: out, getCreds: creds() });
  assert.equal(m.connections.length, 3);
  assert.ok(r.durationSec > 0);
});

test("429 forever → plain-language plan limit message", async () => {
  await mock([{ status: 429 }]);
  await assert.rejects(generateSpeech({ text: "Too many requests here.", out: "q.mp3", baseDir: out, getCreds: creds() }), /rate limited.*Wait a few minutes/);
});

test("model paraphrases → chunk is re-recorded until it matches", async () => {
  const m = await mock([ttsBehavior({ spoken: "Sure, I can help you with that!" }), ttsBehavior()]);
  const r = await generateSpeech({ text: "Please read this sentence exactly as written.", out: "f.mp3", baseDir: out, getCreds: creds() });
  assert.equal(m.connections.length, 2);
  assert.deepEqual(r.warnings, []);
});

test("model keeps paraphrasing → file still saved, with a warning", async () => {
  await mock([ttsBehavior({ spoken: "I am an assistant, how can I help?" })]);
  const r = await generateSpeech({ text: "Please read this sentence exactly as written.", out: "w.mp3", baseDir: out, getCreds: creds() });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /may not be word-perfect/);
});

test("server error event on session.update aborts (no silent default voice)", async () => {
  await mock([ttsBehavior({ failWith: { code: "invalid_value", message: "Invalid value: 'zzz'" } })]);
  await assert.rejects(generateSpeech({ text: "Hello friend of mine.", out: "e.mp3", baseDir: out, getCreds: creds() }), /Invalid value/);
});

test("silent server → timeout, retried, then clear error", async () => {
  const m = await mock([() => {}]);
  await assert.rejects(generateSpeech({ text: "Anyone out there today?", out: "t.mp3", baseDir: out, getCreds: creds() }), /timed out/);
  assert.equal(m.connections.length, 4);
});

test("network down → plain-language network error", async () => {
  process.env.GPTVOICE_REALTIME_URL = "ws://127.0.0.1:9/v1/realtime";
  await assert.rejects(generateSpeech({ text: "Is the network up?", out: "n.mp3", baseDir: out, getCreds: creds() }), /network error.*internet/);
});

test("input validation: empty text, unknown voice, missing out, huge text", async () => {
  await assert.rejects(generateSpeech({ text: "   ", out: "x.mp3", getCreds: creds() }), /empty/);
  await assert.rejects(generateSpeech({ text: "hi", voice: "darth", out: "x.mp3", getCreds: creds() }), /unknown voice "darth".*marin/);
  await assert.rejects(generateSpeech({ text: "hi", getCreds: creds() }), /output path is required/);
  await assert.rejects(generateSpeech({ text: "a".repeat(60_001), out: "x.mp3", getCreds: creds() }), /too long/);
  await assert.rejects(generateSpeech({ text: "hi", out: "x.flac", format: "flac", getCreds: creds() }), /unsupported format/);
});

test("not signed in → fails before any connection", async () => {
  const m = await mock([ttsBehavior()]);
  const noCreds = async () => {
    throw new Error("Not authenticated. Run `npm run login`");
  };
  await assert.rejects(generateSpeech({ text: "hello there", out: "z.mp3", baseDir: out, getCreds: noCreds }), /Not authenticated/);
  assert.equal(m.connections.length, 0);
});

test("dialogue: distinct voices per speaker, explicit cast respected, one file", async () => {
  const m = await mock([ttsBehavior()]);
  const r = await generateDialogue({
    script: "ALICE: Hello Bob, how are you?\nBOB (tired): Fine, thanks Alice.\nCAROL: Hi both of you!",
    voices: { alice: "coral" },
    out: "d.mp3",
    baseDir: out,
    subtitles: true,
    getCreds: creds(),
  });
  assert.equal(r.passages, 3);
  assert.equal(r.cast.alice, "coral");
  assert.equal(new Set(Object.values(r.cast)).size, 3);
  const voices = m.connections.map((c) => c.messages.find((x) => x.type === "session.update").session.audio.output.voice);
  assert.ok(voices.includes("coral"));
  const bob = m.connections
    .map((c) => c.messages.find((x) => x.type === "session.update").session.instructions)
    .find((i) => i.includes("Fine, thanks Alice."));
  assert.match(bob, /tired/);
  assert.match(await fs.readFile(r.subtitlesPath, "utf8"), /BOB: Fine/);
});

test("dialogue: empty script and bad cast voice are rejected", async () => {
  await assert.rejects(generateDialogue({ script: "", out: "x.mp3", getCreds: creds() }), /empty/);
  await assert.rejects(generateDialogue({ script: "A: hi", voices: { A: "nope" }, out: "x.mp3", getCreds: creds() }), /unknown voice/);
});

test("transcription session: sends audio, commits, returns transcript", async () => {
  const m = await mock([
    ({ ws, send }) => {
      send({ type: "session.created" });
      ws.on("message", (d) => {
        const msg = JSON.parse(String(d));
        if (msg.type === "session.update") send({ type: "session.updated" });
        if (msg.type === "input_audio_buffer.commit") send({ type: "conversation.item.input_audio_transcription.completed", transcript: "bonjour" });
      });
    },
  ]);
  const text = await transcribePcm({ access: "t" }, Buffer.alloc(48000 * 3), { language: "fr" });
  assert.equal(text, "bonjour");
  const msgs = m.connections[0].messages;
  assert.match(m.connections[0].url, /intent=transcription/);
  assert.equal(msgs.filter((x) => x.type === "input_audio_buffer.append").length, 2);
  assert.equal(msgs.at(-1).type, "input_audio_buffer.commit");
  assert.equal(msgs[0].session.audio.input.transcription.language, "fr");
});
