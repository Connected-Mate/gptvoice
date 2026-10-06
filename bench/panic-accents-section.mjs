#!/usr/bin/env node
// Inject "Panique v2" and "Accents & personnages" into the listening page
// between <!-- panic:start --> / <!-- panic:end -->.
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve("samples/listening-test");
const PAGE = path.join(ROOT, "index.html");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const P = JSON.parse(await fs.readFile(path.join(ROOT, "panic", "results.json"), "utf8"));
const A = JSON.parse(await fs.readFile(path.join(ROOT, "accents", "results.json"), "utf8"));
const player = (rel, label) => `<figure><figcaption>${label}</figcaption><audio controls preload="none" src="${esc(rel)}"></audio></figure>`;
const pct = (a, b) => `${a / b - 1 >= 0 ? "+" : ""}${Math.round((a / b - 1) * 100)} %`;

// ---- Panic
const PANIC = [
  ["v2-performer-marin", "New default (v2 prompt + performer punctuation), marin"],
  ["v2-ref-echo", "v2 + panicked delivery reference, echo"],
  ["v2-echo", "v2 prompt only, echo"],
  ["v2-performer-echo", "v2 + performer, echo"],
  ["v2-marin", "v2 prompt only, marin"],
  ["v2-rt21-echo", "gpt-realtime-2.1, echo"],
  ["v2-rt21-marin", "gpt-realtime-2.1, marin"],
  ["v2-ref-marin", "v2 + reference, marin"],
  ["v2-performer-fast-echo", "v2 + performer + speed 1.2, echo"],
  ["v2-performer-fast-marin", "v2 + performer + speed 1.2, marin"],
];
const row = (k, label) => {
  const x = P[k];
  const n = P[`neutral-${x.voice}`];
  return `<tr><td>${esc(label)}</td><td>${x.wps} (${pct(x.wps, n.wps)})</td><td>${x.pitchHz} Hz (${pct(x.pitchHz, n.pitchHz)})</td><td>${x.pauses} (neutral ${n.pauses})</td><td>${x.accuracy ?? "—"}${x.accuracy != null ? " %" : ""}</td><td><audio controls preload="none" src="${esc(x.file)}" aria-label="${esc(label)}"></audio></td></tr>`;
};
const panic = `<h1 class="part" id="panic">Panique v2</h1>
<p class="lead">"Panicked" was rebuilt: a persona with stakes (escaping a fire, warning the family), concrete physical directions (rushed, high pitch cracking upward, short shallow breathing, broken-off sentences), a performer pass that adds dashes and ellipses without changing a word, a panicked delivery reference, and both models. Measured against a neutral reading of the same line by the same voice.</p>
<p class="note">Script: “${esc(P._meta.text)}” · performer version: “${esc(P._meta.performed)}”</p>
<div class="pair"><div class="side">${player(P["before-echo"].file, "Before (v1 “panicked”), echo")}<dl class="m"><div><dt>Pace</dt><dd>${P["before-echo"].wps} words/s (${pct(P["before-echo"].wps, P["neutral-echo"].wps)} vs neutral)</dd></div><div><dt>Pitch</dt><dd>${P["before-echo"].pitchHz} Hz (${pct(P["before-echo"].pitchHz, P["neutral-echo"].pitchHz)})</dd></div></dl>${player(P["neutral-echo"].file, "Neutral reading, echo")}</div>
<div class="side after">${player(P["v2-performer-marin"].file, "After: new default, marin")}<dl class="m"><div><dt>Pace</dt><dd>${P["v2-performer-marin"].wps} words/s (${pct(P["v2-performer-marin"].wps, P["neutral-marin"].wps)})</dd></div><div><dt>Pitch</dt><dd>${P["v2-performer-marin"].pitchHz} Hz (${pct(P["v2-performer-marin"].pitchHz, P["neutral-marin"].pitchHz)})</dd></div><div><dt>Words heard</dt><dd>${P["v2-performer-marin"].accuracy} %</dd></div></dl>${player(P["v2-ref-echo"].file, "After: with reference, echo")}</div></div>
<div class="tablewrap"><table class="models"><thead><tr><th>Variant</th><th>Pace words/s</th><th>Pitch</th><th>Pauses</th><th>Words heard</th><th>Listen</th></tr></thead><tbody>${PANIC.filter(([k]) => P[k]).map(([k, l]) => row(k, l)).join("")}</tbody></table></div>
<p class="note"><strong>Honest verdict:</strong> the old version was not panicked at all — slower than neutral (−4 %), it only raised the pitch. v2 is clearly higher, cracking and urgent (+43 % to +75 % pitch) and with the performer pass or the reference it also speeds up (+11 % to +23 %). The voice still resists talking really fast, and the playback-speed knob did not help (it sped playback but the model slowed down). Promoted: v2 prompt + performer pass + the new reference clip, verified by transcription.</p>`;

// ---- Accents
const ORDER = ["french-english", "english-french", "marseille", "quebecois", "spanish-english", "italian-english", "posh-british", "southern-drawl", "robot", "grandpa"];
const VERDICT = {
  "french-english": "Works — strongest on gpt-realtime-2.1: the transcriber literally wrote “zere”, “ze window”.",
  "english-french": "Ears only — slower and flatter than the old version; accent not measurable.",
  marseille: "Ears only — 2.1 is higher and livelier.",
  quebecois: "Ears only — the old free-text line already sounded Québécois to the transcriber (91.7 %).",
  "spanish-english": "Ears only.",
  "italian-english": "Partly — 2.1 is very melodic but once said “Excusez-moi” instead of “Excuse me” (a changed word): use 1.5.",
  "posh-british": "Measurable melody (5.9 st, very sing-song) — listen.",
  "southern-drawl": "Works — slower (−13 %), lower and more melodic than the old version.",
  robot: "Works on 1.5 — melody 1.55 st (flat, monotone); 2.1 was not monotone (3.1 st).",
  grandpa: "Works — slowest of all (3.1 words/s), low and raspy.",
};
let cards = "";
for (const id of ORDER) {
  const variants = [[`${id}.before`, "Before (old free-text accent)"], [`${id}.preset`, "New preset · gpt-realtime-1.5"], [`${id}.rt21`, "New preset · gpt-realtime-2.1"]].filter(([k]) => A[k]);
  const first = A[`${id}.preset`];
  cards += `<section id="accent-${id}"><h2>${esc(id)} · voice ${esc(first.voice)}</h2><p class="note">${esc(VERDICT[id])}</p><div class="grid3">${variants
    .map(([k, label]) => `<div class="side${k.endsWith("preset") ? " after" : ""}">${player(A[k].file, label)}<dl class="m"><div><dt>Words heard</dt><dd>${A[k].accuracy} %</dd></div><div><dt>Pace</dt><dd>${A[k].wps} words/s</dd></div><div><dt>Pitch / melody</dt><dd>${A[k].pitchHz} Hz · ${A[k].melodySt} st</dd></div></dl><p class="note">Heard: “${esc(A[k].heard.slice(0, 140))}”</p></div>`)
    .join("")}</div><details><summary>Script</summary><pre class="script">${esc(first.text)}</pre></details></section>\n`;
}
const accents = `<h1 class="part" id="accents">Accents & personnages</h1>
<p class="lead">New <code>accent</code> presets: a persona (who is speaking, where they learned the language) plus concrete phonetic habits. Words stay verbatim; because heavy accents fool the transcriber, accent presets use a looser check (75 % of words heard instead of 85 %). An accent cannot be measured by a machine — the transcriber’s spelling (“ze”) and pace/melody are clues, your ears are the judge.</p>
${cards}`;

const html = `<!-- panic:start -->\n${panic}\n${accents}\n<!-- panic:end -->`;
let page = await fs.readFile(PAGE, "utf8");
if (page.includes("<!-- panic:start -->")) page = page.replace(/<!-- panic:start -->[\s\S]*?<!-- panic:end -->/, html);
else page = page.replace("<!-- recheck:end -->", `<!-- recheck:end -->\n${html}`);
if (!page.includes('href="#panic"')) page = page.replace('<a href="#recheck">→ Models 1.5 vs 2.1</a>', '<a href="#recheck">→ Models 1.5 vs 2.1</a> · <a href="#panic">→ Panique v2</a> · <a href="#accents">→ Accents & personnages</a>');
await fs.writeFile(PAGE, page);
console.log("ok");
