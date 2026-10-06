#!/usr/bin/env node
// Inject the "Audit vs OpenAI docs" section into ../index.html (between
// <!-- audit:start --> / <!-- audit:end -->, or before <footer> the first time).
// Re-run after bench/listening-page.js regenerates the page.
//   node samples/listening-test/audit/build-audit-section.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(DIR, "..", "index.html");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const data = JSON.parse(await fs.readFile(path.join(DIR, "results.json"), "utf8"));

const COOKBOOK = "https://developers.openai.com/cookbook/examples/realtime_prompting_guide";
const VOICEP = "https://developers.openai.com/api/docs/guides/voice-prompting";
const REF = "https://developers.openai.com/api/reference/resources/realtime/client-events";
const TTS = "https://developers.openai.com/api/docs/guides/text-to-speech";

// [status, OpenAI recommendation, what GPTVoice does, where, source]
const CHECKS = [
  ["CONTRADICTS", "speed only changes playback rate; to sound faster, add a Pacing instruction", "speed is sent as the native knob only, and clip fitting relies on it", "src/realtime.js:136, src/tts.js:511-553, docs/VOICE-BEST-PRACTICES.md:17", COOKBOOK],
  ["MISSING", "Start gpt-realtime-2 with reasoning effort low (minimal for simple tasks)", "reasoning never set; the model comparison ran 2.x at server default", "src/realtime.js:130-137, skill/gptvoice/SKILL.md (Model choice)", VOICEP],
  ["MISSING", "Suppress unwanted background music / humming / sound effects", "no such rule when the text has no sound cues", "src/direction.js:284", COOKBOOK],
  ["MISSING", "Sample phrases: the model closely follows them", "none (deliberate: sample words risk being spoken)", "src/direction.js:231-253", COOKBOOK],
  ["MISSING", "Wrap text that must be repeated verbatim in an in-distribution envelope", "triple-quoted SCRIPT block instead (99 % accuracy already)", "src/direction.js:293", VOICEP],
  ["MISSING", "max_output_tokens to cap a runaway reply", "not set (default inf)", "src/realtime.js:133-136", REF],
  ["PARTIAL", "Pin the output language explicitly", "only when the caller passes language; default is “the script's own language”", "src/direction.js:212, :247", COOKBOOK],
  ["PARTIAL", "Labelled sections: Role & Objective, Personality & Tone, Reference Pronunciations, Instructions / Rules", "# Role, # Task, # Verbatim rules, # Performance, # SCRIPT", "src/direction.js:238-293", COOKBOOK],
  ["PARTIAL", "CAPITALIZE the key rules", "headings and STAY INTELLIGIBLE only; the verbatim rule itself is lowercase", "src/direction.js:246, :280", COOKBOOK],
  ["PARTIAL", "No ambiguous or conflicting instructions", "“mandatory, unmistakable” performance vs “STAY INTELLIGIBLE”; whisper = “no voiced tone at all”", "src/direction.js:139, :279-280", COOKBOOK],
  ["PARTIAL", "Variety rule against robotic delivery", "only in the audiobook style and the director pass", "src/direction.js:110, :284; src/director.js:14-19", COOKBOOK],
  ["PARTIAL", "Avoid overusing must / only / never / always (2.x follows literally)", "“Never” 6× in the rules", "src/direction.js:240-248", VOICEP],
  ["PARTIAL", "Reference Pronunciations section", "respelling substituted in the text instead (stronger for TTS)", "src/cues.js:27-40", COOKBOOK],
  ["PARTIAL", "Codes / numbers: speak each character separately", "acronym rule only", "src/direction.js:250", COOKBOOK],
  ["PARTIAL", "Avoid onomatopoeia (they create sound artifacts)", "used on purpose to make laughs and sighs (measured)", "src/cues.js:46-61", COOKBOOK],
  ["PARTIAL", "One response can switch emotions midway", "a new take at each direction change (more joins)", "src/direction.js:270-272", COOKBOOK],
  ["MATCHES", "Prefer short bullets over paragraphs", "bulleted rules and delivery", "src/direction.js:245-252, :279-282", COOKBOOK],
  ["MATCHES", "Keep the accent stable from the first word to the last", "same wording", "src/direction.js:211", VOICEP],
  ["MATCHES", "Concrete delivery lines (affect, tone, pacing, emotion, pauses)", "labelled acoustic lines", "src/direction.js:175-215", TTS],
  ["MATCHES", "marin / cedar recommended for best quality", "default marin, cedar recommended", "src/voices.js:18, :26-29", TTS],
  ["MATCHES", "Voice cannot change after audio in a session", "one session per take", "src/realtime.js:121-145", REF],
  ["MATCHES", "speed range 0.25–1.5", "validated", "src/direction.js:218-223", REF],
  ["MATCHES", "pcm output for lowest latency", "audio/pcm 24 kHz", "src/realtime.js:136", TTS],
  ["MATCHES", "Convert logic to plain text rules", "plain text rules", "src/direction.js:245-252", COOKBOOK],
  ["MATCHES", "Iterate relentlessly with measured evals", "bench/ A/B and acting batteries", "bench/*.js, data/*.json", COOKBOOK],
];

const count = (s) => CHECKS.filter((c) => c[0] === s).length;
const cls = { MATCHES: "ok", PARTIAL: "", MISSING: "warn", CONTRADICTS: "warn" };
const mean = (xs, k) => Math.round((xs.reduce((a, x) => a + x[k], 0) / xs.length) * 100) / 100;

function side(v, after) {
  const players = v.takes
    .map(
      (t, i) => `<figure><figcaption>${esc(v.label)} · take ${i + 1}</figcaption><audio controls preload="none" src="audit/${esc(t.file)}"></audio></figure>
      <dl class="m"><div><dt>Pace</dt><dd>${t.wordsPerSec} words/s</dd></div><div><dt>Pitch range</dt><dd>${t.pitchRangeSt} st</dd></div><div><dt>Melody</dt><dd>${t.melodySt} st</dd></div><div><dt>Loudness range</dt><dd>${t.loudRangeDb} dB</dd></div><div><dt>Word accuracy</dt><dd>${t.accuracy} %</dd></div></dl>`,
    )
    .join("\n");
  const avg = `<p class="note"><strong>Average:</strong> ${mean(v.takes, "wordsPerSec")} words/s · pitch range ${mean(v.takes, "pitchRangeSt")} st · melody ${mean(v.takes, "melodySt")} st · loudness range ${mean(v.takes, "loudRangeDb")} dB · accuracy ${mean(v.takes, "accuracy")} % · speed knob ${v.speed}</p>`;
  return `<div class="side${after ? " after" : ""}">${players}${avg}<details><summary>Exact prompt sent</summary><pre class="script">${esc(v.instructions)}</pre></details></div>`;
}

const VERDICTS = {
  pacing: "Doc wins. The speed knob makes the voice very fast (above 5 words/s, rushed). The pacing instruction speeds up the reading naturally (about 4.3 words/s) with the same accuracy.",
  "default-tone": "Current wins on melody. The doc-style Personality &amp; Tone block gave a slightly flatter melody but a wider loudness range. Keep the current default; adopt only the section names.",
  "language-pin": "Tie on numbers (one word heard differently on one current take). The accent on English loanwords is a judgement for your ears: compare “meeting”, “workflow”, “deadline”.",
};

const pairs = data.pairs
  .map(
    (p) => `<section id="audit-${esc(p.id)}"><h2>${esc(p.title)}</h2>
  <p class="note"><strong>OpenAI rule:</strong> ${esc(p.rule)}</p>
  <p class="script">${esc(p.text)}</p>
  <div class="pair">${side(p.current, false)}${side(p.doc, true)}</div>
  <p><strong>Verdict:</strong> ${VERDICTS[p.id] ?? ""}</p></section>`,
  )
  .join("\n");

const rows = CHECKS.map(
  ([s, rec, us, where, url]) => `<tr><td class="${cls[s]}">${s}</td><td>${esc(rec)}</td><td>${esc(us)}</td><td><code>${esc(where)}</code></td><td><a href="${url}">doc</a></td></tr>`,
).join("");

const section = `<!-- audit:start -->
<h1 class="part" id="audit">Audit vs OpenAI docs</h1>
<p class="lead">Each OpenAI voice-prompting recommendation checked against what GPTVoice does, then the three biggest gaps tested live: same text, same voice (${esc(data.voice)}), same model (${esc(data.model)}), 2 takes each. <strong>Left</strong> = current prompt, <strong>right</strong> = prompt written the way the docs recommend. Recorded ${esc(data.date.slice(0, 10))}.</p>
<div class="summary">
  <div>Matches the docs<b>${count("MATCHES")}</b></div>
  <div>Partly<b>${count("PARTIAL")}</b></div>
  <div>Missing<b>${count("MISSING")}</b></div>
  <div>Goes against the docs<b>${count("CONTRADICTS")}</b></div>
</div>
<details><summary>Full checklist (${CHECKS.length} items)</summary><div class="tablewrap"><table class="models"><thead><tr><th>Status</th><th>OpenAI recommends</th><th>GPTVoice today</th><th>Where</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div></details>
${pairs}
<!-- audit:end -->`;

let html = await fs.readFile(PAGE, "utf8");
if (html.includes("<!-- audit:start -->")) html = html.replace(/<!-- audit:start -->[\s\S]*?<!-- audit:end -->/, section);
else html = html.replace("<footer>", `${section}\n\n<footer>`);
if (!html.includes('href="#audit"')) html = html.replace(/(<p class="note"><a href="#acting">[^<]*<\/a>)/, `$1 · <a href="#audit">→ Audit vs OpenAI docs</a>`);
await fs.writeFile(PAGE, html);
console.log("audit section written:", PAGE);
