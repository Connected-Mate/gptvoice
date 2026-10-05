import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { VOICES, VOICE_IDS, findVoices, voiceGainDb, describeVoice } from "../src/voices.js";

test("catalog: the 10 accepted voices, each with gender, measured tags and two sample files", () => {
  assert.equal(VOICE_IDS.length, 10);
  for (const id of VOICE_IDS) {
    const v = VOICES[id];
    assert.ok(["male", "female", "neutral"].includes(v.gender), id);
    assert.ok(v.measured.pitchHz > 80 && v.measured.pitchHz < 260, `${id} pitch ${v.measured.pitchHz}`);
    assert.ok(v.tags.length >= 4, id);
    assert.ok(fs.existsSync(v.samples.en) && fs.existsSync(v.samples.fr), `${id} samples`);
  }
});

test("measured register agrees with gender: every male voice is lower than every female voice", () => {
  const male = Object.values(VOICES).filter((v) => v.gender === "male").map((v) => v.measured.pitchHz);
  const female = Object.values(VOICES).filter((v) => v.gender === "female").map((v) => v.measured.pitchHz);
  assert.ok(Math.max(...male) < Math.max(...female));
  assert.ok(Math.min(...female) > Math.min(...male));
});

test("filters: gender, tags (all must match), favorites", () => {
  assert.deepEqual(findVoices({ gender: "female" }).map((v) => v.id).sort(), ["coral", "marin", "sage", "shimmer"]);
  assert.ok(findVoices({ tags: ["deep"] }).every((v) => v.gender === "male"));
  assert.ok(findVoices({ tags: ["audiobook"] }).length >= 2);
  assert.deepEqual(findVoices({ tags: ["deep", "female"] }), []);
  assert.deepEqual(findVoices({ favorites: ["echo"], favoritesOnly: true }).map((v) => v.id), ["echo"]);
});

test("level calibration lifts quiet voices; description shows the star", () => {
  assert.ok(voiceGainDb("sage") > 8, "sage is measured ~14 dB quieter");
  assert.ok(Math.abs(voiceGainDb("marin")) < 2);
  assert.match(describeVoice(VOICES.cedar, ["cedar"]), /^cedar ★ \(recommended\) — male;/);
});
