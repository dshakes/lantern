// Tests for emotional-register detection + the persona addendum.
//   cd packages/bridge-core && npx tsx --test src/emotional-register.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  detectEmotionalRegister,
  emotionalRegisterAddendum,
  type EmotionalRegister,
} from "./emotional-register.ts";

function reg(text: string): EmotionalRegister {
  return detectEmotionalRegister(text).register;
}

// ── distress ──────────────────────────────────────────────────────────

test("distress: 'really rough day honestly'", () => {
  const v = detectEmotionalRegister("really rough day honestly");
  assert.equal(v.register, "distress");
  assert.ok(v.confidence > 0);
  assert.ok(v.signals.length > 0);
});

test("distress: strong cues (hospital / passed away / crying)", () => {
  assert.equal(reg("my dad's in the hospital, scared"), "distress");
  assert.equal(reg("my grandmother passed away last night"), "distress");
  assert.equal(reg("been crying all day, i can't anymore"), "distress");
});

test("distress: a strong cue reads high-confidence", () => {
  const v = detectEmotionalRegister("she passed away this morning, i'm devastated");
  assert.equal(v.register, "distress");
  assert.ok(v.confidence >= 0.8, `expected high confidence, got ${v.confidence}`);
});

test("distress: help signal", () => {
  assert.equal(reg("please help me I don't know what to do"), "distress");
});

// ── frustration ─────────────────────────────────────────────────────────

test("frustration: 'still not fixed?!'", () => {
  const v = detectEmotionalRegister("this is still not fixed?!");
  assert.equal(v.register, "frustration");
  assert.ok(v.signals.some((s) => /still not|interrobang/.test(s)));
});

test("frustration: 'ridiculous' / 'fed up' / 'are you kidding'", () => {
  assert.equal(reg("this is ridiculous, i'm fed up"), "frustration");
  assert.equal(reg("are you kidding me right now"), "frustration");
});

test("frustration: ALLCAPS anger leans frustration", () => {
  assert.equal(reg("WHY is this STILL broken"), "frustration");
});

test("frustration: 'again?' repetition cue", () => {
  assert.equal(reg("the build broke again?"), "frustration");
});

// ── excitement ──────────────────────────────────────────────────────────

test("excitement: 'GOT THE JOB!!! 🎉'", () => {
  const v = detectEmotionalRegister("GOT THE JOB!!! 🎉");
  assert.equal(v.register, "excitement");
  assert.ok(v.signals.includes("🎉") || v.signals.some((s) => /got the job/.test(s)));
});

test("excitement: 'great news' + multi-exclaim", () => {
  assert.equal(reg("great news everyone!!"), "excitement");
});

test("excitement: congrats-worthy event", () => {
  assert.equal(reg("we're engaged!! so happy"), "excitement");
  assert.equal(reg("i got promoted today"), "excitement");
});

test("excitement: celebratory emoji alone", () => {
  assert.equal(reg("🎉🥳"), "excitement");
});

// ── neutral / conservatism ──────────────────────────────────────────────

test("neutral: a plain message is neutral with zero confidence", () => {
  const v = detectEmotionalRegister("hey can you send me the address for tomorrow");
  assert.equal(v.register, "neutral");
  assert.equal(v.confidence, 0);
  assert.deepEqual(v.signals, []);
});

test("neutral: empty / whitespace", () => {
  assert.equal(reg(""), "neutral");
  assert.equal(reg("   "), "neutral");
});

test("neutral: a single weak cue below the floor stays neutral", () => {
  // "alone" alone is weight 1, below the 1.5 floor.
  assert.equal(reg("i went there alone"), "neutral");
});

test("frustration over distress when 'broken' + interrobang dominate", () => {
  // "broken" is a weak distress-adjacent word but lives in frustration lexicon;
  // ensure the frustrated reading wins on the interrobang.
  assert.equal(reg("it's broken again?!"), "frustration");
});

test("deterministic: identical input → identical verdict", () => {
  const a = detectEmotionalRegister("really rough day honestly 😭");
  const b = detectEmotionalRegister("really rough day honestly 😭");
  assert.deepEqual(a, b);
});

test("confidence is in [0,1]", () => {
  for (const t of [
    "passed away",
    "this is ridiculous?!",
    "GOT THE JOB!!! 🎉🎉🎉",
    "hi",
  ]) {
    const c = detectEmotionalRegister(t).confidence;
    assert.ok(c >= 0 && c <= 1, `confidence out of range for "${t}": ${c}`);
  }
});

// ── addendum ─────────────────────────────────────────────────────────────

test("addendum: distress suppresses scheduling + leads with empathy", () => {
  const a = emotionalRegisterAddendum("distress");
  assert.match(a, /empath/i);
  assert.match(a, /shorter/i);
  assert.match(a, /scheduling|tasks|logistics/i);
});

test("addendum: frustration says acknowledge first", () => {
  assert.match(emotionalRegisterAddendum("frustration"), /acknowledge/i);
});

test("addendum: excitement says match energy", () => {
  assert.match(emotionalRegisterAddendum("excitement"), /match.*energy/i);
});

test("addendum: neutral is empty (no modulation)", () => {
  assert.equal(emotionalRegisterAddendum("neutral"), "");
});

test("addendum: deterministic", () => {
  assert.equal(
    emotionalRegisterAddendum("distress"),
    emotionalRegisterAddendum("distress"),
  );
});
