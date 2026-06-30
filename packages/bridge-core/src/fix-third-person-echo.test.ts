import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fixThirdPersonEcho } from "./natural.ts";

test("fixes 'she i'll' → 'she'll' (the grocery-list bug)", () => {
  assert.equal(
    fixThirdPersonEcho("she i'll send you a grocery list"),
    "she'll send you a grocery list",
  );
});

test("handles he/they and capitalization", () => {
  assert.equal(fixThirdPersonEcho("He i'll call you"), "He'll call you");
  assert.equal(fixThirdPersonEcho("they i'll come over"), "they'll come over");
  assert.equal(fixThirdPersonEcho("She I'll be late"), "She'll be late");
});

test("fixes 'she i'm/i've' → 'she's'", () => {
  assert.equal(fixThirdPersonEcho("she i'm heading out"), "she's heading out");
  assert.equal(fixThirdPersonEcho("he i've finished"), "he's finished");
  assert.equal(fixThirdPersonEcho("they i'm leaving"), "they're leaving");
});

test("leaves correct text untouched", () => {
  assert.equal(fixThirdPersonEcho("she'll send you a grocery list"), "she'll send you a grocery list");
  assert.equal(fixThirdPersonEcho("I'll send it"), "I'll send it"); // owner's own first person
  assert.equal(fixThirdPersonEcho("she said she would"), "she said she would");
  assert.equal(fixThirdPersonEcho(""), "");
});
