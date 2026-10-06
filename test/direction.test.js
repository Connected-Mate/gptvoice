import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstructions, deliveryLines, validateSpeed, expandCue, CONTROL_VALUES, START_CUE } from "../src/direction.js";

test("controls become concrete acoustic directions", () => {
  const lines = deliveryLines({ emotion: "sadness", volume: "whisper", pitch: "low", intonation: "flat", narration: "trailer", accent: "Québécois", intensity: 0.9, breaths: true });
  const all = lines.join("\n");
  assert.match(all, /slow, low and quiet/);
  assert.match(all, /WHISPER every word/);
  assert.match(all, /lower and deeper/);
  assert.match(all, /monotone/);
  assert.match(all, /movie-trailer/);
  assert.match(all, /Québécois accent/);
  assert.match(all, /maximal/);
  assert.match(all, /breaths/);
});

test("free-text emotion is accepted; bad enum values are rejected with the options", () => {
  assert.match(deliveryLines({ emotion: "bittersweet" })[0], /bittersweet/);
  assert.throws(() => deliveryLines({ pitch: "ultra" }), /unknown pitch "ultra".*very-low/);
  assert.throws(() => deliveryLines({ volume: "loud" }), /unknown volume/);
  assert.throws(() => deliveryLines({ intensity: 2 }), /between 0 and 1/);
  assert.ok(CONTROL_VALUES.narration.includes("audiobook"));
});

test("speed is validated to the API range", () => {
  assert.equal(validateSpeed(1.2), 1.2);
  assert.equal(validateSpeed(undefined), undefined);
  assert.throws(() => validateSpeed(2), /0.25 and 1.5/);
  assert.throws(() => validateSpeed(0.1), /0.25 and 1.5/);
});

test("instructions: verbatim rules, performance block, fenced script; triple quotes neutralized", () => {
  const i = buildInstructions('He said """stop""" now.', { emotion: "anger" });
  assert.match(i, /EXACTLY AS WRITTEN/);
  assert.match(i, /# Role & Objective/);
  assert.match(i, /Do not add background music, humming or sound effects/);
  assert.match(i, /# Performance \(mandatory\)/);
  assert.match(i, /NEVER speak, narrate or describe them/);
  assert.ok(i.endsWith('"""\nHe said ”””stop””” now.\n"""'));
  assert.equal(START_CUE, "Perform the SCRIPT now.");
});

test("inline cue words expand to the same strong directions (EN + FR)", () => {
  assert.match(expandCue("whispers"), /WHISPER/);
  assert.match(expandCue("chuchote"), /WHISPER/);
  assert.match(expandCue("excité"), /excited/);
  assert.equal(expandCue("like a pirate"), "like a pirate");
  assert.match(buildInstructions("Go!", {}, "v2", { directions: ["triste"] }), /sad: slow/);
  assert.match(buildInstructions("Go!", {}, "v2", { sounds: [{ sound: "Ha ha ha!", how: "genuine laughter" }] }), /contains "Ha ha ha!": perform it as genuine laughter, not as words/);
});

test("language pin only when the detection is confident", async () => {
  const { confidentLanguage } = await import("../src/accuracy.js");
  assert.equal(confidentLanguage("Le chat est sur la table et il dort dans la cuisine."), "fr");
  assert.equal(confidentLanguage("The cat is on the table and it sleeps in the kitchen."), "en");
  assert.equal(confidentLanguage("Hola, ¿cómo estás? Muy bien."), null);
  assert.equal(confidentLanguage("こんにちは、元気ですか"), null);
  const i = buildInstructions("Le manager a posté le planning dans Slack pour la réunion de demain.", {});
  assert.match(i, /Speak ONLY French/);
  assert.match(i, /Loanwords: say English words inside the French script/);
  assert.doesNotMatch(buildInstructions("Hola amigos, buenos días.", {}), /Speak ONLY/);
  assert.doesNotMatch(buildInstructions("Ha!", {}, "v2", { sounds: [{ sound: "Ha ha!", how: "laughter" }] }), /background music/);
});

test("accent presets expand into persona + phonetic habits; free text still works", async () => {
  const { ACCENTS } = await import("../src/direction.js");
  assert.ok(Object.keys(ACCENTS).includes("french-english"));
  const lines = deliveryLines({ accent: "french-english" }).join("\n");
  assert.match(lines, /Jean-Pierre from Lyon/);
  assert.match(lines, /the → ze/);
  assert.match(lines, /Keep the words exactly as written/);
  assert.match(deliveryLines({ accent: "Irish" })[0], /Irish accent/);
});
