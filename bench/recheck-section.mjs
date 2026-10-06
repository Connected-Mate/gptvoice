#!/usr/bin/env node
// Inject "Acting: gpt-realtime-1.5 vs 2.1 (minimal reasoning)" into the listening
// page between <!-- recheck:start --> / <!-- recheck:end -->.
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve("samples/listening-test");
const PAGE = path.join(ROOT, "index.html");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const R = JSON.parse(await fs.readFile(path.join(ROOT, "acting-recheck", "results.json"), "utf8"));
const MODES = [["crying", "coral"], ["shouting", "ash"], ["child-wonder", "shimmer"]];
const MODELS = ["gpt-realtime-1.5", "gpt-realtime-2.1"];
const player = (rel, label) => `<figure><figcaption>${label}</figcaption><audio controls preload="none" src="acting-recheck/${esc(rel)}"></audio></figure>`;
const avg = (m, k) => MODES.reduce((s, [id]) => s + (R[`${m}|${id}|acted`][k] ?? 0), 0) / MODES.length;
let cards = "";
for (const [id, voice] of MODES) {
  cards += `<section id="recheck-${id}"><h2>${esc(id)} · voice ${voice}</h2><div class="pair">${MODELS.map((m) => {
    const a = R[`${m}|${id}|acted`];
    const n = R[`${m}|${id}|neutral`];
    return `<div class="side${m.endsWith("2.1") ? " after" : ""}">${player(a.file, `Acted · ${m}${m.endsWith("2.1") ? " (minimal reasoning)" : ""}`)}${player(n.file, `Neutral · ${m}`)}<dl class="m"><div><dt>Expressiveness (acted)</dt><dd>${a.expr}</dd></div><div><dt>Change vs its neutral</dt><dd>${a.change}</dd></div><div><dt>Words heard</dt><dd>${a.verifiedAccuracy ?? a.accuracy} %</dd></div></dl></div>`;
  }).join("")}</div></section>\n`;
}
const html = `<!-- recheck:start -->
<h1 class="part" id="recheck">Acting: gpt-realtime-1.5 vs 2.1 (minimal reasoning)</h1>
<p class="lead">Re-run after the OpenAI-docs audit: gpt-realtime-2.x now runs with minimal reasoning. 3 acting modes, one take each (12 takes). Two takes of the same line differ by about ±3, so this is a hint, not a verdict.</p>
<table class="models"><thead><tr><th>Model</th><th>Avg expressiveness (acted)</th><th>Avg change vs its own neutral</th><th>Words heard</th></tr></thead><tbody>
${MODELS.map((m) => `<tr><td>${m}</td><td>${avg(m, "expr").toFixed(1)}</td><td>${avg(m, "change").toFixed(1)}</td><td>${MODES.reduce((s, [id]) => s + (R[`${m}|${id}|acted`].verifiedAccuracy ?? R[`${m}|${id}|acted`].accuracy), 0) / 3 > 99.9 ? "100" : (MODES.reduce((s, [id]) => s + (R[`${m}|${id}|acted`].verifiedAccuracy ?? R[`${m}|${id}|acted`].accuracy), 0) / 3).toFixed(1)} %</td></tr>`).join("\n")}
</tbody></table>
<p class="note">2.1 sounded more animated overall (higher absolute expressiveness on 2 of 3 modes, and its plain reading is livelier too), while 1.5 changes more between its neutral and acted readings. Default stays 1.5; use <code>model: "gpt-realtime-2.1"</code> to try the newer model — your ears decide.</p>
${cards}
<!-- recheck:end -->`;
let page = await fs.readFile(PAGE, "utf8");
if (page.includes("<!-- recheck:start -->")) page = page.replace(/<!-- recheck:start -->[\s\S]*?<!-- recheck:end -->/, html);
else page = page.replace("<!-- levers:end -->", `<!-- levers:end -->\n${html}`);
if (!page.includes('href="#recheck"')) page = page.replace('<a href="#levers">→ Encore plus expressif</a>', '<a href="#levers">→ Encore plus expressif</a> · <a href="#recheck">→ 1.5 vs 2.1</a>');
await fs.writeFile(PAGE, page);
console.log("ok");
