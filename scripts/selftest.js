#!/usr/bin/env node
// Post-install check: sign-in status + one short verified test clip.
//   npm run selftest [-- --out path.mp3]
import path from "node:path";
import os from "node:os";
import { loadAuth, planFromToken } from "../src/auth.js";
import { generateSpeech } from "../src/tts.js";

const i = process.argv.indexOf("--out");
const out = i > 0 ? process.argv[i + 1] : path.join(os.tmpdir(), "gptvoice-selftest.mp3");
const record = await loadAuth();
if (!record) {
  console.error("✗ Not signed in. Run: npm run login  (a human signs in in the browser)");
  process.exit(1);
}
console.log(`✓ Signed in (plan: ${planFromToken(record.access) ?? "unknown"})`);
try {
  const r = await generateSpeech({ text: "Hello! GPTVoice is installed and working. Bonjour, tout fonctionne.", voice: "marin", out, verify: true });
  console.log(`✓ Test clip: ${r.savedPath} (${r.durationSec}s, word accuracy ${r.verifiedAccuracy ?? r.accuracy}%)`);
  console.log("⚠ Voice calls may be billed to your personal OpenAI API org — check https://platform.openai.com/usage");
} catch (err) {
  console.error(`✗ Test clip failed: ${err?.message || err}`);
  process.exit(1);
}
