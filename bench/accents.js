#!/usr/bin/env node
// Accents & characters: preset (persona + phonetic habits) vs the old free-text
// accent line, and gpt-realtime-2.1 vs 1.5. Accent itself is judged by ear;
// we measure words heard (looser bar: heavy accents fool the transcriber),
// pace, pitch and melody.
import fs from "node:fs/promises";
import path from "node:path";
import { getValidCredentials } from "../src/auth.js";
import { synthesizeChunk, transcribePcm } from "../src/realtime.js";
import { buildInstructions, ACCENTS } from "../src/direction.js";
import { smoothTrim, roomTone, encode, normalizeLoudness, fadeEdges, crossfadeConcat } from "../src/audio.js";
import { contourPcm, windowStats } from "../src/analysis.js";
import { wordAccuracy } from "../src/accuracy.js";

const OUT = path.resolve("samples/listening-test/accents");
const EN = "Excuse me, I think there is a problem with the hotel room: the window does not close, and the heating is broken.";
const FR = "Excusez-moi, je crois qu'il y a un problème avec la chambre : la fenêtre ne ferme pas et le chauffage est en panne.";
export const ITEMS = [
  ["french-english", "cedar", EN, "en", "strong French"],
  ["english-french", "ash", FR, "fr", "heavy English"],
  ["marseille", "coral", FR, "fr", null],
  ["quebecois", "marin", FR, "fr", "strong Québécois"],
  ["spanish-english", "coral", EN, "en", null],
  ["italian-english", "verse", EN, "en", null],
  ["posh-british", "ballad", EN, "en", null],
  ["southern-drawl", "ash", EN, "en", "thick American Southern"],
  ["robot", "alloy", EN, "en", null],
  ["grandpa", "echo", EN, "en", null],
];
const BEFORE = new Set(["french-english", "english-french", "quebecois", "southern-drawl"]);
const RT21 = new Set(["french-english", "marseille", "italian-english", "robot"]);
const creds = await getValidCredentials();
const res = {};
const jobs = [];
for (const [id, voice, text, lang, oldAccent] of ITEMS) {
  jobs.push({ name: `${id}.preset`, id, voice, text, lang, accent: id, model: "gpt-realtime-1.5" });
  if (BEFORE.has(id)) jobs.push({ name: `${id}.before`, id, voice, text, lang, accent: oldAccent, model: "gpt-realtime-1.5" });
  if (RT21.has(id)) jobs.push({ name: `${id}.rt21`, id, voice, text, lang, accent: id, model: "gpt-realtime-2.1" });
}
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < jobs.length) {
    const j = jobs[next++];
    const r = await synthesizeChunk(creds, { instructions: buildInstructions(j.text, { accent: j.accent, language: j.lang === "fr" ? "French" : "English" }), voice: j.voice, model: j.model });
    const p = smoothTrim(r.pcm);
    const file = path.join(OUT, `${j.name}.mp3`);
    await fs.writeFile(file, await encode(fadeEdges(crossfadeConcat([roomTone(250), normalizeLoudness(p), roomTone(400)], { xfadeMs: 40 })), "mp3"));
    const heard = await transcribePcm(creds, Buffer.concat([roomTone(300), p, roomTone(300)]), { language: j.lang });
    const st = windowStats(contourPcm(p));
    res[j.name] = { id: j.id, voice: j.voice, model: j.model, accent: j.accent, text: j.text, file: `accents/${j.name}.mp3`, accuracy: Math.round(wordAccuracy(j.text, heard, j.lang).accuracy * 1000) / 10, own: Math.round(wordAccuracy(j.text, r.transcript, j.lang).accuracy * 1000) / 10, heard, wps: Math.round((j.text.split(/\s+/).length / st.activeSec) * 100) / 100, pitchHz: st.f0Median, melodySt: st.f0Semitones };
    process.stderr.write(`${j.name.padEnd(26)} acc ${res[j.name].accuracy} own ${res[j.name].own} wps ${res[j.name].wps} pitch ${st.f0Median} melody ${st.f0Semitones} | ${heard.slice(0, 70)}\n`);
  }
}));
await fs.writeFile(path.join(OUT, "results.json"), JSON.stringify(res, null, 2) + "\n");
