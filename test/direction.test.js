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
  assert.match(i, /exactly as written/);
  assert.match(i, /# Performance \(mandatory\)/);
  assert.match(i, /Never say the directions themselves aloud/);
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
