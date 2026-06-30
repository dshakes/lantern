// Tests for the persona/pacing/memory audit fixes (#2 urgency, #4 cue
// suppression, #5 episode relevance ranking, #6 new bot-tells).
//   cd packages/bridge-core && node --import=tsx/esm --test src/natural-audit-fixes.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { agentPersonaPrompt, detectBotTells, type StyleProfile } from "./natural.ts";
import { computeHold } from "./pacing.ts";

const STYLE: StyleProfile = {
  formality: "casual",
  mostlyLowercase: true,
  usesAbbreviations: true,
  usesEmojis: true,
  minimalPunctuation: true,
  avgWordsPerMessage: 5,
};

// ── #2 urgency → reply + pacing ──────────────────────────────────────────
test("#2 inboundUrgent injects an urgency addendum into the persona prompt", () => {
  const urgent = agentPersonaPrompt("Ada", STYLE, false, { inboundUrgent: true });
  assert.match(urgent, /URGENT INBOUND/);
  assert.match(urgent, /flagging this to Ada right now|pinging him immediately/i);
  const calm = agentPersonaPrompt("Ada", STYLE, false, {});
  assert.doesNotMatch(calm, /URGENT INBOUND/);
});

test("#2 urgent pacing collapses the hold to ~floor and skips cadence math", () => {
  const urgent = computeHold({ ownerLatencies: [120_000, 90_000], msSinceLastInbound: 0, isActiveBurst: false, urgent: true });
  assert.match(urgent.reason, /urgent/i);
  assert.ok(urgent.holdMs <= 4_000, `urgent hold should be ~floor (3s), got ${urgent.holdMs}`);
  // Same latencies WITHOUT urgent pace much longer (median 105s × 1.05 → ceiling).
  const calm = computeHold({ ownerLatencies: [120_000, 90_000], msSinceLastInbound: 0, isActiveBurst: false });
  assert.ok(calm.holdMs > urgent.holdMs, `calm (${calm.holdMs}) should exceed urgent (${urgent.holdMs})`);
});

// ── #4 measured contact-style wins over inferred cues ────────────────────
test("#4 contactStyleBlock suppresses the inferred-style cues block", () => {
  const withFingerprint = agentPersonaPrompt("Ada", STYLE, false, {
    contactStyleBlock: "## How Ada writes to Sam\n> yeah on it",
  });
  assert.doesNotMatch(withFingerprint, /Inferred style for this thread/);

  const withoutFingerprint = agentPersonaPrompt("Ada", STYLE, false, {});
  assert.match(withoutFingerprint, /Inferred style for this thread/);
});

// ── #6 new bot-tells trip the filter (so the regenerate path engages) ─────
test("#6 newly-added assistant tells are caught by detectBotTells", () => {
  for (const draft of [
    "feel free to reach out anytime",
    "just wanted to check in on that",
    "no worries at all, happy to wait",
    "for sure! see you then",
    "I think maybe we can do tuesday",
  ]) {
    const v = detectBotTells(draft, "hey what's up");
    assert.equal(v.ok, false, `should flag: "${draft}"`);
  }
});

// ── placeless location fabrication ("almost home" while at the office) ──
test("detectBotTells suppresses a placeless location claim to a contact with no truthful location", () => {
  const r = detectBotTells("almost home", "where r u", { audience: "contact" });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /fabricat/i);
});

test("detectBotTells ALLOWS a location claim when truthful location was injected (inner circle)", () => {
  const r = detectBotTells("at the office, headed back soon", "where r u", {
    audience: "contact",
    truthfulLocationKnown: true,
  });
  assert.equal(r.ok, true);
});

test("detectBotTells does not touch location claims on the owner channel", () => {
  const r = detectBotTells("almost home", "where r u", { audience: "owner" });
  assert.equal(r.ok, true);
});

test("location fabrication net ignores non-location text", () => {
  assert.equal(detectBotTells("sounds good, talk later", "ok", { audience: "contact" }).ok, true);
});
