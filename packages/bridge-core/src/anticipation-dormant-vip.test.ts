// Tests for the dormant-VIP thread-warming nudge (B7).
//   cd packages/bridge-core && npx tsx --test src/anticipation-dormant-vip.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeProactiveNudges, type ProactiveInput } from "./anticipation.ts";

const NOW = Date.UTC(2026, 5, 3, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

// A high-priority (family) contact.
const VIP = { relationship: "brother", vip: true, messageCount: 40 };

test("dormant high-priority contact past the threshold fires a dormant-vip nudge", () => {
  const input: ProactiveInput = {
    now: NOW,
    dormantContacts: [
      {
        handle: "+1555",
        displayName: "Madhu",
        lastExchangeAt: NOW - 65 * DAY, // > 60d default
        contactSignals: VIP,
      },
    ],
  };
  const nudges = computeProactiveNudges(input);
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].kind, "dormant-vip");
  assert.match(nudges[0].text, /Madhu/);
  assert.match(nudges[0].text, /send a hello|reach/i);
  assert.match(nudges[0].text, /months/i); // ~2 months humanized
});

test("a contact dormant under the threshold does not fire", () => {
  const nudges = computeProactiveNudges({
    now: NOW,
    dormantContacts: [
      { handle: "+1555", lastExchangeAt: NOW - 30 * DAY, contactSignals: VIP },
    ],
  });
  assert.equal(nudges.length, 0);
});

test("a low-priority contact gone quiet does NOT fire (VIP-only)", () => {
  const nudges = computeProactiveNudges({
    now: NOW,
    dormantContacts: [
      {
        handle: "+1999",
        displayName: "Random Acquaintance",
        lastExchangeAt: NOW - 200 * DAY,
        contactSignals: { relationship: "acquaintance" }, // unknown class → low tier
      },
    ],
  });
  assert.equal(nudges.length, 0);
});

test("dormancy span humanizes: years → 'over a year'", () => {
  const nudges = computeProactiveNudges({
    now: NOW,
    dormantContacts: [
      { handle: "+1555", displayName: "Anil", lastExchangeAt: NOW - 400 * DAY, contactSignals: VIP },
    ],
  });
  assert.equal(nudges.length, 1);
  assert.match(nudges[0].text, /over a year/i);
});

test("custom dormantVipDays threshold respected", () => {
  const nudges = computeProactiveNudges({
    now: NOW,
    dormantContacts: [
      { handle: "+1555", displayName: "Madhu", lastExchangeAt: NOW - 40 * DAY, contactSignals: VIP },
    ],
    config: { dormantVipDays: 30 },
  });
  assert.equal(nudges.length, 1);
});

test("dormantVipMinTier=normal lets a normal-tier contact through", () => {
  const nudges = computeProactiveNudges({
    now: NOW,
    dormantContacts: [
      {
        handle: "+1777",
        displayName: "Coworker",
        lastExchangeAt: NOW - 90 * DAY,
        // work(12) + frequent thread(20) → normal tier (>20, <55).
        contactSignals: { relationship: "coworker", messageCount: 40 },
      },
    ],
    config: { dormantVipMinTier: "normal" },
  });
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].kind, "dormant-vip");
});

test("dormant-vip ranks BELOW an overdue reply for the same person-class", () => {
  const input: ProactiveInput = {
    now: NOW,
    awaitingReply: [
      { handle: "+1aa", displayName: "Pending", lastInboundAt: NOW - 3 * DAY, contactSignals: VIP },
    ],
    dormantContacts: [
      { handle: "+1bb", displayName: "Cold", lastExchangeAt: NOW - 90 * DAY, contactSignals: VIP },
    ],
  };
  const nudges = computeProactiveNudges(input);
  const overdue = nudges.find((n) => n.kind === "overdue-reply")!;
  const dormant = nudges.find((n) => n.kind === "dormant-vip")!;
  assert.ok(overdue && dormant);
  assert.ok(overdue.priority > dormant.priority, "overdue reply should outrank dormant warming");
});

test("dedupeKey is month-bucketed (fires once a month, not daily)", () => {
  const base: ProactiveInput = {
    now: NOW,
    dormantContacts: [
      { handle: "+1555", lastExchangeAt: NOW - 90 * DAY, contactSignals: VIP },
    ],
  };
  const a = computeProactiveNudges(base)[0];
  // One day later — SAME month bucket → same key (suppressed by the bridge).
  const b = computeProactiveNudges({ ...base, now: NOW + DAY })[0];
  assert.equal(a.dedupeKey, b.dedupeKey);
  // A month later → DIFFERENT key (re-surfaces).
  const c = computeProactiveNudges({ ...base, now: NOW + 35 * DAY })[0];
  assert.notEqual(a.dedupeKey, c.dedupeKey);
});

test("owner-only contract: nudge text only SUGGESTS, asks permission", () => {
  const [n] = computeProactiveNudges({
    now: NOW,
    dormantContacts: [
      { handle: "+1555", displayName: "Madhu", lastExchangeAt: NOW - 90 * DAY, contactSignals: VIP },
    ],
  });
  // "want me to send a hello?" — asks, never asserts it was sent.
  assert.match(n.text, /want me to/i);
  assert.doesNotMatch(n.text, /\bsent\b|\bmessaged\b|\breached out\b/i);
});

test("empty dormantContacts → no nudges (backward compatible)", () => {
  assert.deepEqual(computeProactiveNudges({ now: NOW, dormantContacts: [] }), []);
});
