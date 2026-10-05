import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeForCompare as norm, wordAccuracy, describeDiff, guessLanguage } from "../src/accuracy.js";

test("numbers: digits and words compare equal (EN)", () => {
  assert.equal(wordAccuracy("one hundred and twelve steps", "112 steps", "en").accuracy, 1);
  assert.equal(wordAccuracy("in 1998 at 6:45 p.m.", "in nineteen ninety-eight", "en").accuracy < 1, true); // years said as pairs differ: honest miss
  assert.deepEqual(norm("1,284 passengers", "en"), ["one", "thousand", "two", "hundred", "eighty", "four", "passengers"]);
});

test("numbers: French, incl. 71, 80, 91, thousands with spaces", () => {
  assert.deepEqual(norm("71 80 91", "fr"), ["soixante", "et", "onze", "quatre", "vingt", "quatre", "vingt", "onze"]);
  assert.deepEqual(norm("1 245 Parisiens", "fr"), ["mille", "deux", "cent", "quarante", "cinq", "parisiens"]);
  assert.equal(wordAccuracy("quatre-vingts euros", "80 €", "fr").accuracy, 1);
});

test("money, percent and times are said in spoken order", () => {
  assert.equal(wordAccuracy("rose 4.5% to $2,399, roughly €2,210", "rose 4.5% to 2,399 dollars, roughly 2,210 euros", "en").accuracy, 1);
  assert.equal(wordAccuracy("à 21 h 30", "à 21h30", "fr").accuracy, 1);
  assert.equal(wordAccuracy("at 6:45 p.m.", "at 6:45 PM", "en").accuracy, 1);
});

test("abbreviations: Mme/M./Dr", () => {
  assert.equal(wordAccuracy("Mme Martin et M. Durand", "Madame Martin et Monsieur Durand", "fr").accuracy, 1);
  assert.equal(wordAccuracy("Dr. Smith", "Doctor Smith", "en").accuracy, 1);
});

test("stage directions, annotations and laughter are not reading errors", () => {
  assert.equal(wordAccuracy("[sighs] It was long. [laughs] We made it!", "*sighs* Haaah, it was long. Ha ha ha! We made it!", "en").accuracy, 1);
  // …but a laugh the TEXT asks for must be there.
  assert.ok(wordAccuracy("Ha ha, very funny.", "Very funny.", "en").accuracy < 1);
});

test("WER counts substitutions, omissions and additions; diff is readable", () => {
  const r = wordAccuracy("the quick brown fox jumps", "the quick red fox jumps high", "en");
  assert.equal(r.errors, 2);
  assert.equal(r.words, 5);
  assert.ok(Math.abs(r.accuracy - 0.6) < 1e-9);
  assert.equal(describeDiff(r.ops), '"brown" → "red", added "high"');
  assert.equal(wordAccuracy("Sure, I can help!", "", "en").accuracy, 0);
  assert.equal(wordAccuracy("", "", "en").accuracy, 1);
});

test("compound words split by the transcriber still match", () => {
  assert.equal(wordAccuracy("Essayez GPTVoice dès aujourd'hui", "Essayez GPT Voice dès aujourd'hui", "fr").accuracy, 1);
});

test("an answer instead of the script scores near zero", () => {
  assert.ok(wordAccuracy("Can you hear me? What would you do?", "Yes, I can hear you clearly. I would call for help.", "en").accuracy < 0.3);
});

test("language guess", () => {
  assert.equal(guessLanguage("Le chat est sur la table et il dort."), "fr");
  assert.equal(guessLanguage("The cat is on the table and it sleeps."), "en");
});
