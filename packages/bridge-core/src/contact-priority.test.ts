// Tests for the per-contact priority model.
//   cd packages/bridge-core && npx tsx --test src/contact-priority.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { contactPriority, classifyRelationship } from "./contact-priority.ts";

const NOW = 1_700_000_000_000;

test("classifyRelationship maps family / work / unknown", () => {
  assert.equal(classifyRelationship("wife"), "family");
  assert.equal(classifyRelationship("brother-in-law"), "family");
  assert.equal(classifyRelationship("bava"), "family"); // Telugu kinship
  assert.equal(classifyRelationship("my manager"), "work");
  assert.equal(classifyRelationship("recruiter"), "work");
  assert.equal(classifyRelationship("best friend"), "close");
  assert.equal(classifyRelationship(""), "unknown");
  assert.equal(classifyRelationship("some rando"), "unknown");
});

test("family contact with activity scores HIGH; unknown cold contact scores LOW", () => {
  const family = contactPriority("+1555", {
    relationship: "wife",
    messageCount: 50,
    lastInboundAt: NOW - 60_000, // 1 min ago
    medianReplyLatencyMs: 2 * 60 * 1000, // 2 min — owner answers fast
    now: NOW,
  });
  assert.equal(family.tier, "high");
  assert.equal(family.relationshipClass, "family");

  const unknown = contactPriority("+1999", {
    relationship: "unknown person",
    messageCount: 1,
    lastInboundAt: NOW - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    now: NOW,
  });
  assert.equal(unknown.tier, "low");
  assert.equal(unknown.relationshipClass, "unknown");

  assert.ok(family.score > unknown.score);
});

test("VIP flag lifts an otherwise unknown contact", () => {
  const base = contactPriority("+1", { messageCount: 2, now: NOW });
  const vip = contactPriority("+1", { messageCount: 2, vip: true, now: NOW });
  assert.ok(vip.score > base.score);
  assert.ok(vip.reasons.some((r) => r.includes("vip")));
});

test("deterministic: identical signals → identical output", () => {
  const sig = { relationship: "manager", messageCount: 10, lastInboundAt: NOW - 3600_000, now: NOW };
  const a = contactPriority("h", sig);
  const b = contactPriority("h", sig);
  assert.deepEqual(a, b);
});

test("recency decays the score over time", () => {
  const recent = contactPriority("h", { relationship: "friend", lastInboundAt: NOW - 60_000, now: NOW });
  const stale = contactPriority("h", {
    relationship: "friend",
    lastInboundAt: NOW - 14 * 24 * 60 * 60 * 1000,
    now: NOW,
  });
  assert.ok(recent.score > stale.score);
});

test("score is clamped to 0..100", () => {
  const maxed = contactPriority("h", {
    relationship: "wife",
    vip: true,
    messageCount: 1000,
    lastInboundAt: NOW,
    medianReplyLatencyMs: 0,
    now: NOW,
  });
  assert.ok(maxed.score <= 100 && maxed.score >= 0);
});
