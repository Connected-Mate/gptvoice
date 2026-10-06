#!/usr/bin/env node
// Inject "Models: gpt-realtime-1.5 vs 2.1 (minimal reasoning)" + the speed check
// into the listening page between <!-- recheck:start --> / <!-- recheck:end -->.
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve("samples/listening-test");
const PAGE = path.join(ROOT, "index.html");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const R = JSON.parse(await fs.readFile(path.join(ROOT, "models12", "results.json"), "utf8"));
const CELLS = ["cry-coral", "cry-marin", "shout-ash", "shout-cedar", "excited-verse", "excited-marin"];
const M = ["gpt-realtime-1.5", "gpt-realtime-2.1"];
const player = (rel, label) => `<figure><figcaption>${label}</figcaption><audio controls preload="none" src="${esc(rel)}"></audio></figure>`;
const avg = (m) => CELLS.reduce((s, c) => s + R[`${m}|${c}`].score, 0) / CELLS.length;
const wins = CELLS.filter((c) => R[`gpt-realtime-2.1|${c}`].score > R[`gpt-realtime-1.5|${c}`].score + 2).length;
const losses = CELLS.filter((c) => R[`gpt-realtime-2.1|${c}`].score < R[`gpt-realtime-1.5|${c}`].score - 2).length;
const cards = CELLS.map((c) => `<section id="model-${c}"><h2>${esc(c)}</h2><div class="pair">${M.map((m) => {
  const x = R[`${m}|${c}`];
  return `<div class="side${m.endsWith("2.1") ? " after" : ""}">${player(x.file, esc(m) + (m.endsWith("2.1") ? " (minimal reasoning)" : ""))}<dl class="m"><div><dt>Expressiveness</dt><dd>${x.score}</dd></div><div><dt>Pitch range</dt><dd>${x.pitchRangeSt} st</dd></div><div><dt>Loudness range</dt><dd>${x.loudRangeDb} dB</dd></div><div><dt>Words heard</dt><dd>${x.acc} %</dd></div></dl></div>`;
}).join("")}</div></section>`).join("\n");
const sp = (s) => ["take1", "take2"].map((t) => R[`speed|speed-${s}-${t}`]);
const speedRow = (s) => {
  const xs = sp(s);
  return `<tr><td>${s}</td><td>${xs.map((x) => x.wps).join(" / ")} words/s</td><td>${xs.map((x) => x.acc).join(" / ")} %</td><td>${xs.map((x, i) => `<audio controls preload="none" src="${esc(x.file)}" aria-label="speed ${s} take ${i + 1}"></audio>`).join(" ")}</td></tr>`;
};
const html = `<!-- recheck:start -->
<h1 class="part" id="recheck">Models: gpt-realtime-1.5 vs 2.1 (minimal reasoning)</h1>
<p class="lead">Same acting lines (cry, shout, excited × 2 voices), one take each per model, built-in delivery reference on. One take per cell, and takes of the same line differ by about ±3: a hint, not a verdict.</p>
<table class="models"><thead><tr><th>Model</th><th>Avg expressiveness</th><th>Words heard</th></tr></thead><tbody>
${M.map((m) => `<tr><td>${m}</td><td>${avg(m).toFixed(1)}</td><td>${(CELLS.reduce((s, c) => s + R[`${m}|${c}`].acc, 0) / 6).toFixed(1)} %</td></tr>`).join("\n")}
</tbody></table>
<p class="note">2.1 clearly ahead on ${wins} of 6 lines, behind on ${losses}, about even on the rest; every word right on both. Default stays 1.5; choose <code>model: "gpt-realtime-2.1"</code> if you prefer it by ear.</p>
${cards}
<h2 id="speed-check">Speed: pacing instruction first, playback knob only as a fallback</h2>
<p class="note">Natural reading of this text ≈ 3.9 words/s. Before: speed 1.25 used the playback knob and read at 4.8–5.1 words/s (rushed). Now the voice is asked to speak faster/slower in words; the knob is only used if the pace misses the target by more than 15 %.</p>
<div class="tablewrap"><table class="models"><thead><tr><th>Speed asked</th><th>Pace (2 takes)</th><th>Words heard</th><th>Listen</th></tr></thead><tbody>${speedRow(1.25)}${speedRow(0.8)}</tbody></table></div>
<!-- recheck:end -->`;
let page = await fs.readFile(PAGE, "utf8");
if (page.includes("<!-- recheck:start -->")) page = page.replace(/<!-- recheck:start -->[\s\S]*?<!-- recheck:end -->/, html);
else page = page.replace("<!-- levers:end -->", `<!-- levers:end -->\n${html}`);
page = page.replace('<a href="#recheck">→ 1.5 vs 2.1</a>', '<a href="#recheck">→ Models 1.5 vs 2.1</a>');
await fs.writeFile(PAGE, page);
console.log(`1.5 ${avg(M[0]).toFixed(1)} · 2.1 ${avg(M[1]).toFixed(1)} · 2.1 ahead ${wins}/6, behind ${losses}/6`);
