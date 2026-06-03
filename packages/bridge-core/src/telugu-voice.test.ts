// Authentic-voice regression tests for the Telangana-dialect owner.
//
// NORTH STAR: the recipient must never feel they're texting a bot. These
// cover the runtime nets added to natural.ts + per-contact-style.ts:
//   - Telugu textbook long verb forms get suppressed (detectBotTells)
//   - Telugu GOOD short forms do NOT false-positive
//   - end-particles (ra/ro/ay/ayya/vora) get suppressed inside Telugu
//   - English LLM-cadence tells (em-dash, "sounds good!") get suppressed
//   - post-tool synthesis openers get stripped
//   - kinship → register cue mapping
//   - contact-style: bot-self exclusion, ack dedupe, uppercase fix

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  detectBotTells,
  detectTeluguBotTell,
  kinshipRegisterCue,
  agentPersonaPrompt,
  inferStyle,
} from "./natural.ts";
import { computeContactStyle } from "./per-contact-style.ts";

// ---------------------------------------------------------------------------
// Telugu textbook long forms — MUST be flagged (suppressed → regenerate)
// ---------------------------------------------------------------------------

const TELUGU_BAD = [
  "vacchina tarvata matladkundam",
  "nenu vacchi matladutanu",
  "nenu help chestanu ledu cheppedanu", // cheppedanu
  "repu cheptanu",
  "ok ostha, matladudham",
  "nenu chuddam repu",
  "chustanu repu ela undi",
  "nenu vasthanu repu",
  "vachedanu kani late aindi",
  "naaku telidanduku adigina",
  "naaku teliyadhu",
  "danni ivvalsindi nuvvu",
];

for (const bad of TELUGU_BAD) {
  test(`flags Telugu long form: ${bad}`, () => {
    assert.notEqual(
      detectTeluguBotTell(bad),
      null,
      `expected a Telugu bot-tell for: ${bad}`,
    );
    assert.equal(
      detectBotTells(bad).ok,
      false,
      `detectBotTells should suppress: ${bad}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Telugu GOOD short forms — MUST NOT be flagged
// ---------------------------------------------------------------------------

const TELUGU_GOOD = [
  "vasta",
  "cheptha",
  "matladtham vacchaka",
  "vacchaka matladtham",
  "nenu help chesta",
  "vacchi matladta",
  "chustha repu",
  "ostha repu",
  "telidu",
  "thelvadu",
  "ivali nuvvu",
  "ela undi",
  "repu ostunnaru",
  "em chestunnav",
  "sare baagunnav",
];

for (const good of TELUGU_GOOD) {
  test(`does NOT flag Telugu good form: ${good}`, () => {
    assert.equal(
      detectTeluguBotTell(good),
      null,
      `should be clean (good form): ${good}`,
    );
    assert.equal(
      detectBotTells(good).ok,
      true,
      `detectBotTells should pass: ${good}`,
    );
  });
}

// ---------------------------------------------------------------------------
// End-particles — flagged inside Telugu, ignored in plain English
// ---------------------------------------------------------------------------

const TELUGU_PARTICLE_BAD = [
  "repu ostunnaru ra",
  "cheppu ra",
  "ela undi ra",
  "vasta ro",
  "sare anna vora",
  "cheppu ayya",
];

for (const bad of TELUGU_PARTICLE_BAD) {
  test(`flags Telugu end-particle: ${bad}`, () => {
    assert.notEqual(detectTeluguBotTell(bad), null, `expected flag: ${bad}`);
    assert.equal(detectBotTells(bad).ok, false);
  });
}

// English words ending in those letters must NOT trip the particle net.
const ENGLISH_PARTICLE_SAFE = [
  "okay sounds fine",
  "i'll stay home",
  "on my way",
  "from the metro",
  "got the library card",
  "no way lol",
];

for (const safe of ENGLISH_PARTICLE_SAFE) {
  test(`does NOT flag English near-particle: ${safe}`, () => {
    assert.equal(detectTeluguBotTell(safe), null, `should be clean: ${safe}`);
  });
}

// ---------------------------------------------------------------------------
// English LLM-cadence tells — em-dash + assistant enthusiasm
// ---------------------------------------------------------------------------

const ENGLISH_BAD = [
  "yeah i can do that — let me check the calendar",
  "sounds good!",
  "absolutely!",
  "wonderful!",
  "that works!",
  "perfect!",
  "awesome!",
  "sure thing!",
  "happy to help, just ping me",
  "ok let me know if you need anything",
];

for (const bad of ENGLISH_BAD) {
  test(`flags English LLM-cadence tell: ${bad}`, () => {
    assert.equal(
      detectBotTells(bad).ok,
      false,
      `expected suppression for: ${bad}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Real owner-style messages — MUST NOT false-positive
// ---------------------------------------------------------------------------

const OWNER_OK = [
  "yeah for sure",
  "lol nah i'm good",
  "ok cool, see you then",
  "perfect timing", // "perfect" without trailing "!" is fine
  "sounds like a plan", // not the "sounds good!" tell
  "lemme check and get back",
  "haha true",
  "for sure, after 6 works",
  "not sure, will check with manasa",
  "ved's got school tmrw",
];

for (const ok of OWNER_OK) {
  test(`does NOT flag real owner message: ${ok}`, () => {
    assert.equal(detectBotTells(ok).ok, true, `should pass: ${ok}`);
  });
}

// ---------------------------------------------------------------------------
// Kinship register cue
// ---------------------------------------------------------------------------

test("kinship cue maps known terms", () => {
  assert.match(kinshipRegisterCue("bava") ?? "", /close male in-law/i);
  assert.match(kinshipRegisterCue("elder brother, anna") ?? "", /elder brother/i);
  assert.match(kinshipRegisterCue("akka") ?? "", /elder sister/i);
  assert.match(kinshipRegisterCue("vadina") ?? "", /sister-in-law/i);
});

test("kinship cue returns null for non-kinship relationships", () => {
  assert.equal(kinshipRegisterCue("coworker"), null);
  assert.equal(kinshipRegisterCue("college friend"), null);
  assert.equal(kinshipRegisterCue(""), null);
});

test("persona prompt injects register cue when relationship has kinship term", () => {
  const prompt = agentPersonaPrompt(
    "Shekhar",
    inferStyle(["yeah", "for sure"]),
    false,
    { relationship: "brother-in-law (bava)" },
  );
  assert.match(prompt, /Relationship register:/);
  assert.match(prompt, /close male in-law/i);
});

// ---------------------------------------------------------------------------
// Verbatim sample slice bumped to last-12
// ---------------------------------------------------------------------------

test("persona prompt keeps up to 12 owner samples", () => {
  const samples = Array.from({ length: 20 }, (_, i) => `sample line number ${i}`);
  const prompt = agentPersonaPrompt("Shekhar", inferStyle([]), false, {
    ownerSamples: samples,
  });
  const quoted = (prompt.match(/^> sample line number/gm) ?? []).length;
  assert.equal(quoted, 12, "should keep the last 12 samples");
  // Last-12 means it keeps 8..19, not 0..7.
  assert.match(prompt, /> sample line number 19/);
  assert.doesNotMatch(prompt, /> sample line number 7\b/);
});

// ---------------------------------------------------------------------------
// per-contact-style: bot-self exclusion + ack dedupe + uppercase fix
// ---------------------------------------------------------------------------

test("excludes bot-self messages from the fingerprint", () => {
  const msgs = [
    "yeah let's grab lunch sometime next week",
    "📅 added to calendar: lunch with srinivas",
    "🧠 on it",
    "haha sounds like a plan honestly",
  ];
  const style = computeContactStyle(msgs);
  // Two real human messages remain (bot lines dropped).
  assert.equal(style.sampleCount, 2);
});

test("dedupes a ring of acks so avgWords isn't collapsed", () => {
  const acks = ["ok", "ok!", "Ok", "ok 👍", "k", "yeah", "yeah", "yep"];
  const real = ["honestly that sounds like a really solid plan to me"];
  const style = computeContactStyle([...acks, ...real]);
  // ok/ok!/Ok/ok👍 collapse to 1; k, yeah(x2)→1, yep, + 1 real = 5 unique.
  assert.equal(style.sampleCount, 5);
  // With dedupe the long message pulls avgWords up; without it the ack ring
  // would crush it toward 1.
  assert.ok(style.avgWords > 2, `expected avgWords > 2, got ${style.avgWords}`);
});

test("lowercase Telugu / proper-noun messages are NOT classed as uppercase", () => {
  const msgs = [
    "repu ostunnaru kada",
    "meeting srinivas at New Jersey tmrw",
    "ved's school starts monday",
    "ela undi anna",
    "manasa said ok",
  ];
  const style = computeContactStyle(msgs);
  // None of these are sentence-cased; proper nouns shouldn't inflate it.
  assert.ok(
    style.uppercaseRate < 0.2,
    `expected low uppercaseRate, got ${style.uppercaseRate}`,
  );
});

test("genuinely sentence-cased messages still register as uppercase", () => {
  const msgs = [
    "Hey there, hope you are doing well today.",
    "Let me know when you are free to chat.",
    "I will reach out to the team about this.",
  ];
  const style = computeContactStyle(msgs);
  assert.ok(
    style.uppercaseRate > 0.6,
    `expected high uppercaseRate, got ${style.uppercaseRate}`,
  );
});
