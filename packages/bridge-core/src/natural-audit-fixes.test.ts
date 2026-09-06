// Tests for the persona/pacing/memory audit fixes (#2 urgency, #4 cue
// suppression, #5 episode relevance ranking, #6 new bot-tells).
//   cd packages/bridge-core && node --import=tsx/esm --test src/natural-audit-fixes.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { agentPersonaPrompt, detectBotTells, groupRepliesEnabled, isBlockedGroupSend, type StyleProfile } from "./natural.ts";
import { degradedVoiceAck } from "./language.ts";
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

// AI_TELL_WORDS matched as a raw SUBSTRING, so ordinary human drafts were
// suppressed: "as personal as it gets" tripped "as per", "kindlyn said she'd
// come" tripped "kindly". A suppressed draft falls through to the canned
// greeting table or to silence — so a substring collision costs a real reply.
test("AI tell-words match on word boundaries, not substrings", () => {
  for (const human of [
    "as personal as it gets honestly",
    "kindlyn said she'd come",
    "she's a great navigator on road trips",
  ]) {
    assert.equal(detectBotTells(human, "hey").ok, true, `suppressed human text: ${human}`);
  }

  // The guard must still do its job on the real thing, including inflections.
  for (const tell of [
    "kindly let me know your availability",
    "let me delve into that for you",
    "rest assured it will be handled",
    "as per our discussion earlier",
    "i will facilitate the process",
    "he delved into it already",
  ]) {
    assert.equal(detectBotTells(tell, "hey").ok, false, `leaked AI tell: ${tell}`);
  }
});

// The owner asked for NO bot replies in any group thread, on either channel
// (2026-08-24). Implemented as one switch rather than by clearing the
// per-group monitoring lists, because those are persisted state that drifts
// (4 WhatsApp groups + 1 iMessage chat were already monitored) AND because the
// celebratory-wish path deliberately replies in UNMONITORED groups — so
// clearing the lists would not have stopped group replies at all.
test("group replies are OFF unless explicitly enabled", () => {
  // Default: absent / empty / falsy values must all mean OFF.
  for (const env of [{}, { LANTERN_GROUP_REPLIES: "" }, { LANTERN_GROUP_REPLIES: "0" },
                     { LANTERN_GROUP_REPLIES: "off" }, { LANTERN_GROUP_REPLIES: "false" },
                     { LANTERN_GROUP_REPLIES: "no" }]) {
    assert.equal(groupRepliesEnabled(env as NodeJS.ProcessEnv), false,
      `should be OFF for ${JSON.stringify(env)}`);
  }
  // Only an explicit opt-in turns it back on.
  for (const v of ["1", "true", "on", "ON", " true "]) {
    assert.equal(groupRepliesEnabled({ LANTERN_GROUP_REPLIES: v } as NodeJS.ProcessEnv), true,
      `should be ON for ${JSON.stringify(v)}`);
  }
});

// A fourth group path: the voice-note ack fires during media annotation,
// before the reply pipeline, and posted in a WhatsApp group one second ahead
// of the gate's own "group msg ignored" line for the same message. The fix is
// a SEND-BOUNDARY block — complete by construction — plus an ack that no
// longer promises anything.
test("isBlockedGroupSend blocks @g.us at the boundary when groups are off", () => {
  assert.equal(isBlockedGroupSend("14085008008-1441049465@g.us", {} as NodeJS.ProcessEnv), true);
  assert.equal(isBlockedGroupSend("15126088977@s.whatsapp.net", {} as NodeJS.ProcessEnv), false);
  assert.equal(isBlockedGroupSend("241141156987027@lid", {} as NodeJS.ProcessEnv), false);
  // Explicit opt-in re-enables group sends.
  assert.equal(isBlockedGroupSend("14085008008-1441049465@g.us", { LANTERN_GROUP_REPLIES: "1" } as NodeJS.ProcessEnv), false);
});

test("the voice-note ack promises nothing", () => {
  for (const opts of [{ isOwner: false }, { isOwner: false, contactWritesTelugu: true }]) {
    const ack = degradedVoiceAck(opts);
    assert.doesNotMatch(ack, /get back|call chesta|malli|listen properly|will /i, `ack promises: ${ack}`);
    assert.doesNotMatch(ack, /[ఀ-౿]/, "no native script inside a romanized line");
  }
});
