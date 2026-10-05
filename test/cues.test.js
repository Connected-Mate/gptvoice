import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCues, applyPronunciations, soundFor, hasStageDirections, MAX_PAUSE_MS } from "../src/cues.js";

test("pause cues become exact silences, merged when stacked", () => {
  const s = parseCues("One. [pause 1.5s] Two. [pause 300ms] Three. [short pause][long pause]");
  assert.deepEqual(s.map((x) => [x.script, x.pauseAfterMs]), [["One.", 1500], ["Two.", 300], ["Three.", 1900]]);
  assert.equal(parseCues("[pause] Hi")[0].pauseAfterMs, 800);
  assert.equal(parseCues("Hi [pause 99s]")[0].pauseAfterMs, MAX_PAUSE_MS);
  assert.equal(parseCues("Bonjour [pause 1,5 s] toi")[0].pauseAfterMs, 1500);
});

test("directions are removed from the script and applied to the following words", () => {
  const s = parseCues("[whispers] Quiet now. [excited] They are here!");
  assert.deepEqual(s.map((x) => [x.script, x.directions]), [["Quiet now.", ["whispers"]], ["They are here!", ["excited"]]]);
  assert.ok(s.every((x) => !/\[|\]/.test(x.script)), "no bracket ever reaches the voice");
});

test("sound cues map to onomatopoeia + performance note (EN and FR)", () => {
  assert.deepEqual(soundFor("laughs"), { sound: "Ha ha ha!", how: "genuine laughter" });
  assert.equal(soundFor("soupire").sound, "Haaah…");
  assert.equal(soundFor("whispers"), null);
  const s = parseCues("[sighs] Long day.");
  assert.equal(s[0].sounds[0].sound, "Haaah…");
  assert.equal(s[0].expected, "Long day.");
});

test("pronunciation hints: inline and dictionary; voice gets the respelling, checks get the word", () => {
  const s = parseCues("Hello {Nguyen|win}, welcome to the SNCF.", { SNCF: "S N C F" });
  assert.equal(s[0].script, "Hello win, welcome to the S N C F.");
  assert.equal(s[0].expected, "Hello Nguyen, welcome to the SNCF.");
  assert.equal(applyPronunciations("York and New York", { York: "yawk", "New York": "nu yawk" }), "{York|yawk} and {New York|nu yawk}");
  assert.equal(applyPronunciations("SNCFs", { SNCF: "x" }), "SNCFs", "whole words only");
});

test("hasStageDirections ignores pauses", () => {
  assert.equal(hasStageDirections("a [pause 1s] b"), false);
  assert.equal(hasStageDirections("a [laughs] b"), true);
});
