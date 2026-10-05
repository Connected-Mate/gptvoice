#!/usr/bin/env node
// Build samples/listening-test/index.html: before | after players, script, metrics.
import fs from "node:fs/promises";
import path from "node:path";
import { ITEMS } from "./listening-items.js";
import { decodeToPcm } from "../src/transcribe.js";
import { smoothness } from "../src/quality.js";
import { analyzePcm } from "../src/analysis.js";

const ROOT = path.resolve("samples/listening-test");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const load = async (side) => JSON.parse(await fs.readFile(path.join(ROOT, side, "results.json"), "utf8"));
const res = { before: await load("before"), after: await load("after") };

async function measure(side, rel) {
  const abs = path.join(ROOT, side, rel);
  const pcm = await decodeToPcm(abs);
  let joins = [];
  try {
    joins = JSON.parse(await fs.readFile(abs.replace(/\.mp3$/, ".timings.json"), "utf8")).passages.slice(1).map((p) => p.start);
  } catch {}
  const q = smoothness(pcm, joins);
  const a = analyzePcm(pcm);
  // Issues within 80 ms of a join between takes (only known when timings exist).
  let joinIssues = null;
  if (joins.length) {
    const iss = [...q.clickTimes, ...q.edgeTimes];
    joinIssues = iss.filter((c) => joins.some((j) => Math.abs(j - c) < 0.08)).length + q.hotJoins;
  }
  return { q, loud: a.loudnessDb, dur: a.durationSec, joins: joinIssues, joinCount: joins.length };
}

const metricRows = (m, r) => `
  <dl class="m">
    <div><dt>Duration</dt><dd>${m.dur} s${r?.passages ? ` · ${r.passages} take${r.passages > 1 ? "s" : ""}` : ""}</dd></div>
    <div><dt>Word accuracy</dt><dd>${r?.verifiedAccuracy ?? r?.accuracy ?? "—"} %${r?.verifiedAccuracy != null ? " (independent transcription)" : ""}</dd></div>
    <div><dt>Clicks in quiet passages*</dt><dd>${m.q.clicks}</dd></div>
    ${m.joins != null ? `<div><dt>Problems at joins between takes</dt><dd class="${m.joins ? "warn" : "ok"}">${m.joins} (of ${m.joinCount} joins)</dd></div>` : ""}
    <div><dt>Hard starts / stops</dt><dd class="${m.q.abruptOnsets + m.q.abruptOffsets ? "warn" : "ok"}">${m.q.abruptOnsets} / ${m.q.abruptOffsets}</dd></div>
    <div><dt>Cut-off ending</dt><dd class="${m.q.endsAbruptly ? "warn" : "ok"}">${m.q.endsAbruptly ? "yes" : "no"}</dd></div>
    <div><dt>Dead digital silence</dt><dd class="${m.q.digitalSilence.count ? "warn" : "ok"}">${m.q.digitalSilence.count ? `${m.q.digitalSilence.count} gap(s), ${m.q.digitalSilence.seconds} s` : "none"}</dd></div>
    <div><dt>Speech level</dt><dd>${m.loud} dB RMS</dd></div>
  </dl>`;

const player = (side, rel, label) => `<figure><figcaption>${label}</figcaption><audio controls preload="none" src="${esc(`${side}/${rel}`)}"></audio></figure>`;

let sections = "";
const totals = { before: { clicks: 0, edges: 0, cut: 0, zero: 0, joins: 0, joinCount: 0 }, after: { clicks: 0, edges: 0, cut: 0, zero: 0, joins: 0, joinCount: 0 } };
const add = (side, m) => {
  totals[side].clicks += m.q.clicks;
  totals[side].edges += m.q.abruptOnsets + m.q.abruptOffsets;
  totals[side].cut += m.q.endsAbruptly ? 1 : 0;
  totals[side].zero += m.q.digitalSilence.count ? 1 : 0;
  totals[side].joins += m.joins ?? 0;
  totals[side].joinCount += m.joinCount;
};
for (const it of ITEMS) {
  const b = res.before[it.id];
  const a = res.after[it.id];
  let body = "";
  if (it.kind === "clips") {
    body += `<p class="note">Four separate clips, each fitted to its shot length (speed adjusted, best take kept).</p>`;
    for (let i = 0; i < it.lines.length; i++) {
      const bf = b.files[i];
      const af = a.files[i];
      const mb = await measure("before", bf.file);
      const ma = await measure("after", af.file);
      add("before", mb);
      add("after", ma);
      body += `<div class="clip"><h3>Shot ${i + 1} · target ${it.lines[i].target_seconds} s</h3><p class="script">${esc(it.lines[i].text)}</p>
      <div class="pair"><div class="side">${player("before", bf.file, "Before")}${metricRows(mb, { accuracy: bf.accuracy })}<p class="fit">${bf.durationSec} s — ${bf.fits ? "fits" : "does not fit"}</p></div>
      <div class="side after">${player("after", af.file, "After")}${metricRows(ma, { accuracy: af.accuracy })}<p class="fit">${af.durationSec} s — ${af.fits ? "fits" : "does not fit"}</p></div></div></div>`;
    }
  } else {
    const mb = await measure("before", b.file);
    const ma = await measure("after", a.file);
    add("before", mb);
    add("after", ma);
    body += `<div class="pair"><div class="side">${player("before", b.file, "Before")}${metricRows(mb, b)}</div><div class="side after">${player("after", a.file, "After")}${metricRows(ma, a)}</div></div>
    <details><summary>Script</summary><pre class="script">${esc(it.text)}</pre></details>`;
  }
  sections += `<section id="${it.id}"><h2>${esc(it.title)}</h2>${body}</section>\n`;
}

const t = totals;
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GPTVoice listening test</title>
<style>
:root { --bg:#f7f6f2; --fg:#1d1f1e; --muted:#5b605d; --card:#ffffff; --line:#dcd9cf; --ok:#1f7a4d; --warn:#a4400f; --accent:#24527a; }
@media (prefers-color-scheme: dark) { :root { --bg:#131514; --fg:#ecebe6; --muted:#a3a8a4; --card:#1c1f1d; --line:#323632; --ok:#6fd3a0; --warn:#f0a070; --accent:#8cbbe6; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.7rem; margin: 0 0 4px; }
h2 { font-size: 1.15rem; margin: 0 0 12px; }
h3 { font-size: 1rem; margin: 16px 0 4px; }
.lead { color: var(--muted); margin: 0 0 20px; max-width: 70ch; }
.summary { display:grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr)); gap: 8px; margin: 0 0 28px; }
.summary div { background: var(--card); border:1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.summary b { display:block; font-size: 1.1rem; }
section { background: var(--card); border:1px solid var(--line); border-radius: 10px; padding: 16px; margin: 0 0 18px; }
.pair { display:grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 720px) { .pair { grid-template-columns: 1fr; } }
.side { border-top: 3px solid var(--line); padding-top: 8px; min-width: 0; }
.side.after { border-top-color: var(--accent); }
figure { margin: 0 0 8px; }
figcaption { font-weight: 600; margin-bottom: 4px; }
audio { width: 100%; }
dl.m { display:grid; grid-template-columns: 1fr; margin: 0; font-size: .9rem; }
dl.m div { display:flex; justify-content: space-between; gap: 8px; border-bottom: 1px dotted var(--line); padding: 2px 0; }
dt { color: var(--muted); }
dd { margin: 0; text-align: right; }
.ok { color: var(--ok); } .warn { color: var(--warn); font-weight: 600; }
.script { white-space: pre-wrap; font: inherit; color: var(--fg); margin: 6px 0 0; }
details { margin-top: 10px; } summary { cursor: pointer; color: var(--accent); }
.note, .fit { color: var(--muted); font-size: .9rem; margin: 4px 0; }
footer { color: var(--muted); font-size: .85rem; margin-top: 24px; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>GPTVoice — listening test</h1>
<p class="lead">The same scripts, generated twice: <strong>Before</strong> = previous pipeline, <strong>After</strong> = new pipeline (whole sentences, natural endings kept, fades and crossfades, room tone, even loudness). Listen with headphones. Numbers are measured automatically; your ears decide.</p>
<div class="summary">
  <div>Clicks in quiet passages*<b>${t.before.clicks} → ${t.after.clicks}</b></div>
  <div>Hard starts/stops<b>${t.before.edges} → ${t.after.edges}</b></div>
  <div>Cut-off endings<b>${t.before.cut} → ${t.after.cut}</b></div>
  <div>Files with dead silence<b>${t.before.zero} → ${t.after.zero}</b></div>
  <div>Problems at joins between takes<b>${t.before.joins}/${t.before.joinCount} → ${t.after.joins}/${t.after.joinCount}</b></div>
</div>
${sections}
<footer>* "Clicks in quiet passages" counts every sharp step next to silence. Most of them are natural consonants (p, t, k) after a pause, present in both versions; the numbers that show splicing problems are "Hard starts / stops", "Cut-off ending", "Dead digital silence" and "Problems at joins between takes".<br>Local file, generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} by bench/listening-page.js. Not published.</footer>
</main>
</body>
</html>
`;
await fs.writeFile(path.join(ROOT, "index.html"), html);
console.log(JSON.stringify(totals));
