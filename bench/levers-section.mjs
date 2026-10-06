#!/usr/bin/env node
// Inject the "Encore plus expressif" section into samples/listening-test/index.html
// between <!-- levers:start --> / <!-- levers:end --> (or before the audit section /
// footer the first time). Re-run after bench/listening-page.js regenerates the page.
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve("samples/listening-test");
const PAGE = path.join(ROOT, "index.html");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const R = JSON.parse(await fs.readFile(path.join(ROOT, "levers", "results.json"), "utf8"));
const CELLS = ["cry-coral", "cry-marin", "shout-ash", "shout-cedar", "excited-verse", "excited-marin"];
const LEVERS = [
  ["performer", "Script performer pass (punctuation / CAPS, same words)"],
  ["audioref", "Audio delivery reference (an expressive clip: “match its energy, not its words”)"],
  ["framing", "Actor framing (scene, stakes, backstory)"],
  ["priming", "Conversation priming (prior turns in the emotion)"],
];
const base = Object.fromEntries(CELLS.map((c) => [c, R[`baseline|${c}`]]));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const bMean = mean(CELLS.map((c) => base[c].score));
const rows = LEVERS.map(([id, label]) => {
  const xs = CELLS.map((c) => R[`${id}|${c}`]);
  return { id, label, d: mean(xs.map((x) => x.score)) - bMean, better: CELLS.filter((c) => R[`${id}|${c}`].score > base[c].score + 2).length, acc: mean(xs.map((x) => x.accuracy)) * 100 };
}).sort((a, b) => b.d - a.d);
const bo = ["cry-coral", "cry-marin"].map((c) => {
  const t = [R[`baseline|${c}`], R[`baseline|${c}.take2`], R[`baseline|${c}.take3`]];
  return { c, mean: mean(t.map((x) => x.score)), best: Math.max(...t.filter((x) => x.accuracy >= 0.98).map((x) => x.score)) };
});
const sign = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
const player = (rel, label) => `<figure><figcaption>${label}</figcaption><audio controls preload="none" src="${esc(rel)}"></audio></figure>`;
const metric = (x, ref) => `<dl class="m"><div><dt>Expressiveness</dt><dd>${x.score}${ref ? ` (${sign(x.score - ref.score)})` : ""}</dd></div><div><dt>Pitch range</dt><dd>${x.pitchRangeSt} st</dd></div><div><dt>Loudness range</dt><dd>${x.loudRangeDb} dB</dd></div><div><dt>Words heard</dt><dd class="${x.accuracy >= 0.98 ? "ok" : "warn"}">${Math.round(x.accuracy * 100)} %</dd></div></dl>`;

let cards = "";
for (const c of CELLS) {
  const b = base[c];
  const alts = LEVERS.map(([id, label]) => [id, label, R[`${id}|${c}`]]);
  const best = alts.reduce((a, x) => (x[2].score > a[2].score && x[2].accuracy >= 0.9 ? x : a), ["baseline", "baseline", b]);
  const promoted = R[`promoted|${c}`];
  cards += `<section id="lever-${c}"><h2>${esc(c)}</h2>
  <div class="pair"><div class="side">${player(b.file, "Baseline (acting mode, before the fix)")}${metric(b)}</div>
  <div class="side after">${player(best[2].file, `Best lever here: ${esc(best[0])}`)}${metric(best[2], b)}</div></div>
  ${promoted ? `<div class="pair"><div class="side after">${player(promoted.file, "New default: acting + built-in reference + best of 2")}${metric(promoted, b)}</div><div class="side"></div></div>` : ""}
  <details><summary>All levers for this line</summary><div class="grid3">${alts.map(([id, label, x]) => `<div class="side">${player(x.file, esc(label))}${metric(x, b)}</div>`).join("")}</div></details></section>\n`;
}

const html = `<!-- levers:start -->
<h1 class="part" id="levers">Encore plus expressif</h1>
<p class="lead">A measured search for levers that make the acting MORE expressive while keeping every word. Same 3 emotions (cry, shout, excited) × 2 voices; each lever rendered once per line and compared with the acting baseline. "Expressiveness" = pitch range + half the loudness range + how far the pitch moved from the voice's usual level. "Words heard" = independent transcription. One take per lever, and two takes of the same line differ by about ±3: treat small differences as noise.</p>
<table class="models"><thead><tr><th>Rank</th><th>Lever</th><th>Avg change</th><th>Lines clearly better (> +2)</th><th>Words heard</th></tr></thead><tbody>
${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.label)}</td><td>${sign(r.d)}</td><td>${r.better}/6</td><td>${r.acc.toFixed(1)} %</td></tr>`).join("\n")}
<tr><td>—</td><td>Best of 3 takes (keep the most expressive that checks out)</td><td>${bo.map((x) => `${x.c}: ${sign(x.best - x.mean)} vs average take`).join(" · ")}</td><td>2 lines tested</td><td>gated ≥ 98 %</td></tr>
<tr><td>✗</td><td>Sampling temperature</td><td colspan="3">Not available: the realtime API rejects <code>temperature</code> for the session and for a response.</td></tr>
<tr><td>✗</td><td>Post-DSP (compression, presence EQ)</td><td colspan="3">Rejected: compression reduced the loudness range by 4.5–6.8 dB (less expressive); presence EQ changed nothing measurable.</td></tr>
</tbody></table>
<p class="note"><strong>Found on the way, and fixed:</strong> several acting takes contained spoken stage words ("Short gasp.", "Take a deep inhale.") because the acting directions named sounds. The directions now describe vocal qualities only, and acting is checked by an independent transcription by default. After the fix: 6 of 6 acting takes word-perfect.</p>
<p class="note"><strong>Promoted to default for acting modes:</strong> the built-in delivery reference clip + best of 2 takes (gated on words). On the 3 lines re-rendered with the new default: ${["cry-coral", "shout-ash", "excited-verse"].filter((c) => R[`promoted|${c}`]).map((c) => `${c} ${sign(R[`promoted|${c}`].score - base[c].score)}`).join(", ")}. The performer pass is available as an option (<code>perform: true</code>); its gain was inconsistent.</p>
${cards}
<!-- levers:end -->`;

let page = await fs.readFile(PAGE, "utf8");
if (page.includes("<!-- levers:start -->")) page = page.replace(/<!-- levers:start -->[\s\S]*?<!-- levers:end -->/, html);
else if (page.includes("<!-- audit:start -->")) page = page.replace("<!-- audit:start -->", `${html}\n<!-- audit:start -->`);
else page = page.replace("<footer>", `${html}\n<footer>`);
if (!page.includes('href="#levers"')) page = page.replace('<a href="#acting">→ Jeu d\'acteur / Acting</a>', '<a href="#acting">→ Jeu d\'acteur / Acting</a> · <a href="#levers">→ Encore plus expressif</a>');
await fs.writeFile(PAGE, page);
console.log(rows.map((r) => `${r.id} ${sign(r.d)} ${r.better}/6 ${r.acc.toFixed(1)}%`).join("\n"));
