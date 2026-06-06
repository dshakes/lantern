// Regression tests for medium-tone Telangana dialect fidelity.
//   cd packages/bridge-core && npx tsx --test src/natural-telangana-dialect.test.ts
//
// The owner ALWAYS speaks medium-tone Telangana Telugu. The bot replied
// "ha cheppandi, repu matladtham" — "cheppandi" is the formal/standard
// "-andi" imperative; a medium-Telangana speaker says "cheppu" to a peer.
// The formal "-andi" form is CORRECT only for elders / respected people,
// so the suppressor must be register-aware (spare elder relationships) and
// the persona must steer the LLM to the casual stem by default.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  detectBotTells,
  detectTeluguBotTell,
  detectTeluguFormalImperative,
  isRespectRelationship,
  agentPersonaPrompt,
  inferStyle,
} from "./natural.ts";

const style = inferStyle([]);

// ── isRespectRelationship ──

test("isRespectRelationship: elders / authority → true", () => {
  for (const r of ["mother", "father", "mother-in-law", "uncle", "boss", "manager", "amma", "nanna", "mamayya", "senior"]) {
    assert.equal(isRespectRelationship(r), true, `expected respect: ${r}`);
  }
});

test("isRespectRelationship: peers / unknown → false", () => {
  for (const r of ["college friend", "brother", "wife", "friend", "cousin", undefined, ""]) {
    assert.equal(isRespectRelationship(r), false, `expected casual: ${r}`);
  }
});

// ── detectTeluguFormalImperative ──

test("flags formal -andi imperative for a peer (the reported bug)", () => {
  assert.ok(
    detectTeluguFormalImperative("ha cheppandi, repu matladtham", "college friend"),
    "cheppandi to a peer should be flagged",
  );
});

test("flags formal -andi imperative when relationship unknown (owner default is casual)", () => {
  assert.ok(detectTeluguFormalImperative("ha cheppandi, repu matladtham"), "unknown → casual default");
});

test("SPARES formal -andi imperative for an elder (correct register)", () => {
  assert.equal(
    detectTeluguFormalImperative("ha cheppandi, repu matladtham", "father"),
    null,
    "-andi is correct for an elder",
  );
});

test("casual imperative passes (cheppu, not cheppandi)", () => {
  assert.equal(detectTeluguFormalImperative("ha cheppu, repu matladtham", "college friend"), null);
});

test("English text with look-alike words never trips (gated by Telugu presence)", () => {
  // "Brandi" / "Sandy" contain the letters but the reply is English — no
  // Telugu tokens, not in the explicit list → must not flag.
  assert.equal(detectTeluguFormalImperative("Sounds good, I'll meet Brandi tomorrow"), null);
  assert.equal(detectTeluguFormalImperative("standing by, let me know"), null);
});

test("native-script ండి imperative flagged for a peer", () => {
  assert.ok(detectTeluguFormalImperative("సరే చెప్పండి", "friend"), "ండి imperative should flag");
});

// ── detectBotTells integration (register-aware via ctx.relationship) ──

test("detectBotTells suppresses cheppandi for a peer", () => {
  const v = detectBotTells("ha cheppandi, repu matladtham", "em chestunnav", { relationship: "college friend" });
  assert.equal(v.ok, false, "should suppress for a peer");
  assert.match(v.reason ?? "", /-andi/);
});

test("detectBotTells allows cheppandi for an elder", () => {
  const v = detectBotTells("ha cheppandi, repu matladtham", "em chestunnav", { relationship: "father" });
  assert.equal(v.ok, true, `should allow for an elder: ${v.reason}`);
});

test("detectBotTells allows the casual medium-Telangana form", () => {
  const v = detectBotTells("ha cheppu, repu matladtham", "em chestunnav", { relationship: "college friend" });
  assert.equal(v.ok, true, `casual form should pass: ${v.reason}`);
});

// ── Persona steering ──

test("persona carries the medium-tone Telangana dialect rule", () => {
  const p = agentPersonaPrompt("Shekhar", style, false, {});
  assert.match(p, /medium-tone Telangana/i, "medium-tone Telangana rule missing");
  assert.match(p, /cheppu/i, "casual imperative guidance missing");
  assert.match(p, /-andi/i, "formal -andi guidance missing");
});

// ── "ra" vocative — the cousin-chat regression ──
//
// The bot replied "Not automated ra, just quick on the reply 😊"; the owner
// never addresses anyone as "ra", and the cousin immediately said "pakka
// automated" (definitely a bot). Two layers must hold: the persona must NOT
// instruct the model to use "ra", and the runtime net must suppress "ra"
// even inside an otherwise-English reply (the gated check used to miss it).

test("detectTeluguBotTell flags a standalone 'ra' in an English reply (the reported bug)", () => {
  assert.ok(
    detectTeluguBotTell("Not automated ra, just quick on the reply"),
    "'ra' as an address particle must be flagged even in English",
  );
});

test("detectBotTells suppresses the exact cousin-chat 'ra' reply", () => {
  const v = detectBotTells("Not automated ra, just quick on the reply 😊", "Idhi automate chesnava");
  assert.equal(v.ok, false, "the 'ra' reply must be suppressed");
  assert.match(v.reason ?? "", /vocative particle/i);
});

test("all vocative address particles are flagged standalone", () => {
  for (const draft of ["enti ra", "em ro", "cheppu da", "ela unnav rey", "sare ayya", "po vora"]) {
    assert.ok(detectTeluguBotTell(draft), `should flag: ${draft}`);
  }
});

test("English look-alikes never trip the vocative net", () => {
  for (const draft of [
    "I'll have a soda.",
    "no way, that's wild",
    "I'll stay, no rush",
    "okay, sounds good",
    "ta-da! all done",
    "she's a Libra",
    "let me grab the data",
    "hooray, finally!",
  ]) {
    assert.equal(detectTeluguBotTell(draft), null, `must NOT flag: ${draft}`);
  }
});

test("garbled invented-Telugu word-salad is suppressed (nudistunnanu)", () => {
  assert.ok(detectTeluguBotTell("nudistunnanu 🙂 meeru?"), "hallucinated Telugu must be flagged");
  const v = detectBotTells("nudistunnanu 🙂 meeru?", "Edunnav");
  assert.equal(v.ok, false, "hallucinated Telugu must be suppressed");
});

test("persona no longer instructs the model to use 'ra'", () => {
  const p = agentPersonaPrompt("Shekhar", style, false, {});
  assert.doesNotMatch(p, /"thanks ra"/i, "persona must not suggest 'thanks ra'");
  assert.doesNotMatch(p, /"raa"\/"ra"/i, "persona must not give 'ra' as an imperative example");
  assert.match(p, /NEVER use the vocative\/address particles/i, "explicit 'ra' ban missing");
  assert.match(p, /DON'T INVENT TELUGU/i, "Telugu-or-English (don't-invent) rule missing");
});
