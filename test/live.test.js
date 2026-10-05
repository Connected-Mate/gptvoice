// Live end-to-end check against OpenAI with your real sign-in.
// Opt-in only (uses your plan):  npm run test:live
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateSpeech, generateDialogue } from "../src/tts.js";
import { transcribeFile } from "../src/transcribe.js";
import { fidelity } from "../src/text.js";

const live = process.env.GPTVOICE_LIVE === "1";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gptvoice-live-"));

test("live: French narration is spoken word for word", { skip: !live && "set GPTVOICE_LIVE=1" }, async () => {
  const text = "Bonjour ! Ceci est un test en direct de GPTVoice. La voix doit lire chaque mot, sans rien ajouter.";
  const r = await generateSpeech({ text, voice: "marin", style: "calm, clear", out: "live.mp3", baseDir: dir });
  assert.ok(r.durationSec > 3 && r.durationSec < 20, `duration ${r.durationSec}`);
  const back = await transcribeFile(r.savedPath, { language: "fr" });
  const score = fidelity(text, back.text);
  assert.ok(score >= 0.85, `transcribed back: "${back.text}" (match ${score})`);
});

test("live: English dialogue with two voices", { skip: !live && "set GPTVOICE_LIVE=1" }, async () => {
  const r = await generateDialogue({
    script: "MAYA: Did you hear that noise downstairs?\nTOM (whispering): Shh. Stay quiet and listen.",
    voices: { MAYA: "coral", TOM: "cedar" },
    out: "dialogue.wav",
    baseDir: dir,
  });
  assert.equal(r.passages, 2);
  const back = await transcribeFile(r.savedPath, { language: "en" });
  const score = fidelity("Did you hear that noise downstairs? Shh. Stay quiet and listen.", back.text);
  assert.ok(score >= 0.8, `transcribed back: "${back.text}" (match ${score})`);
});
