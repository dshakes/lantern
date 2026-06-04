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
