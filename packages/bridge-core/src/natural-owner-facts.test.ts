// Regression tests for the owner-facts guardrail + persona injection.
//   cd packages/bridge-core && npx tsx --test src/natural-owner-facts.test.ts
//
// The bot told a contact "I'm not even married" — a fabricated denial of
// an owner fact, the single worst failure. detectBotTells must suppress
// such self-negating identity claims, and agentPersonaPrompt must inject
// ownerFacts / addressRule / recentBotReplies when supplied.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectBotTells, agentPersonaPrompt, inferStyle } from "./natural.ts";

const style = inferStyle([]);

// ── Bot-tell net: self-negating owner facts ──

const SELF_NEGATING = [
  "I'm not even married",
  "i'm not married",
  "I am not married lol",
  "haha I'm not engaged",
  "I don't have a wife",
  "i dont have kids",
  "I do not have children",
  "don't have a husband",
];

test("detectBotTells suppresses self-negating owner facts", () => {
  for (const d of SELF_NEGATING) {
    const v = detectBotTells(d);
    assert.equal(v.ok, false, `should suppress: ${JSON.stringify(d)}`);
  }
});

const HUMAN_OK = [
  "happy anniversary to us!",
  "yeah married life is good",
  "the kids are great, thanks for asking",
  "lol not sure tbh",
  "ok sounds good",
];

test("detectBotTells leaves genuine replies untouched", () => {
  for (const d of HUMAN_OK) {
    const v = detectBotTells(d);
    assert.equal(v.ok, true, `should pass: ${JSON.stringify(d)} → ${v.reason}`);
  }
});

// ── Persona injection ──

test("agentPersonaPrompt injects ownerFacts as ground truth", () => {
  const p = agentPersonaPrompt("Shekhar", style, false, {
    ownerFacts: "Owner facts (TRUE — never deny or contradict these): married to Manasa.",
  });
  assert.ok(p.includes("married to Manasa"), "ownerFacts not injected");
  assert.ok(/TRUE/.test(p), "ground-truth framing missing");
});

test("agentPersonaPrompt renders addressRule (addressAs + neverCall)", () => {
  const p = agentPersonaPrompt("Shekhar", style, false, {
    addressRule: { addressAs: "Sujith", neverCall: ["bava", "anna"] },
  });
  assert.ok(p.includes('Address this contact as "Sujith"'), "addressAs missing");
  assert.ok(p.includes("NEVER call them: bava, anna"), "neverCall missing");
});

test("agentPersonaPrompt lists recentBotReplies for anti-repetition", () => {
  const p = agentPersonaPrompt("Shekhar", style, false, {
    recentBotReplies: ["best to wait for Shekhar directly on this one."],
  });
  assert.ok(p.includes("ALREADY sent"), "anti-repetition block missing");
  assert.ok(p.includes("best to wait for Shekhar directly"), "recent reply not listed");
});

test("ownerFacts injected for group prompts too", () => {
  const p = agentPersonaPrompt("Shekhar", style, true, {
    ownerFacts: "Owner facts (TRUE — never deny or contradict these): married to Manasa.",
  });
  assert.ok(p.includes("married to Manasa"), "facts should apply in groups");
});
