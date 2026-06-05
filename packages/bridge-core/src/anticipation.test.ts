// Tests for the anticipation engine.
//   cd packages/bridge-core && npx tsx --test src/anticipation.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  computeProactiveNudges,
  formatNudgeForOwner,
  type ProactiveInput,
} from "./anticipation.ts";

// Fixed reference: 2026-06-03T12:00:00Z (a Wednesday).
const NOW = Date.UTC(2026, 5, 3, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

test("anniversary tomorrow fires a relationship-date nudge", () => {
  const input: ProactiveInput = {
    now: NOW,
    keyDates: [{ label: "wedding anniversary", date: "2017-06-04" }], // tomorrow (month/day)
  };
  const nudges = computeProactiveNudges(input);
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].kind, "relationship-date");
  assert.match(nudges[0].text, /anniversary/i);
  assert.match(nudges[0].text, /tomorrow/i);
  assert.ok(nudges[0].dueAt && nudges[0].dueAt > NOW);
});

test("a date 5 days out is beyond default lookahead and does not fire", () => {
  const nudges = computeProactiveNudges({
    now: NOW,
    keyDates: [{ label: "Mom's birthday", date: "1960-06-08" }], // +5 days
  });
  assert.equal(nudges.length, 0);
});

test("a date today fires and says 'today'", () => {
  const nudges = computeProactiveNudges({
    now: NOW,
    keyDates: [{ label: "our anniversary", date: "2017-06-03" }],
  });
  assert.equal(nudges.length, 1);
  assert.match(nudges[0].text, /today/i);
});

test("overdue replies rank by contact priority, not just age", () => {
  const input: ProactiveInput = {
    now: NOW,
    awaitingReply: [
      {
        // Cold stranger, overdue 10 days.
        handle: "+1999",
        displayName: "Random Vendor",
        lastInboundAt: NOW - 10 * DAY,
        contactSignals: { relationship: "vendor" },
      },
      {
        // Wife, overdue only 3 days — should still outrank the stranger.
        handle: "+1555",
        displayName: "Maya",
        lastInboundAt: NOW - 3 * DAY,
        contactSignals: {
          relationship: "wife",
          vip: true,
          messageCount: 50,
          medianReplyLatencyMs: 2 * MIN,
        },
      },
    ],
  };
  const nudges = computeProactiveNudges(input);
  assert.equal(nudges.length, 2);
  // Highest-priority first → the wife despite being less overdue.
  assert.equal(nudges[0].kind, "overdue-reply");
  assert.match(nudges[0].text, /Maya/);
  assert.match(nudges[1].text, /Random Vendor/);
  assert.ok(nudges[0].priority > nudges[1].priority);
});

test("a reply unanswered under the threshold does not nudge", () => {
  const nudges = computeProactiveNudges({
    now: NOW,
    awaitingReply: [{ handle: "+1555", lastInboundAt: NOW - 1 * DAY }], // 1 day < 2
  });
  assert.equal(nudges.length, 0);
});

test("pre-meeting fires inside the 15-min window and beats other kinds", () => {
  const input: ProactiveInput = {
    now: NOW,
    upcomingEvents: [
      { title: "Board sync", startAt: NOW + 10 * MIN, withContact: "Priya", eventId: "ev1" },
    ],
    keyDates: [{ label: "wedding anniversary", date: "2017-06-04" }], // also fires
  };
  const nudges = computeProactiveNudges(input);
  assert.equal(nudges[0].kind, "pre-meeting"); // highest base priority
  assert.match(nudges[0].text, /Board sync/);
  assert.match(nudges[0].text, /Priya/);
  assert.match(nudges[0].text, /10 min/);
});

test("a meeting already started or beyond the window is dropped", () => {
  const nudges = computeProactiveNudges({
    now: NOW,
    upcomingEvents: [
      { title: "Past", startAt: NOW - 5 * MIN, eventId: "p" },
      { title: "Far", startAt: NOW + 60 * MIN, eventId: "f" },
    ],
  });
  assert.equal(nudges.length, 0);
});

test("custom pre-meeting window respected", () => {
  const nudges = computeProactiveNudges({
    now: NOW,
    upcomingEvents: [{ title: "Standup", startAt: NOW + 25 * MIN, eventId: "s" }],
    config: { preMeetingWindowMin: 30 },
  });
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].kind, "pre-meeting");
});

test("open commitments past age threshold nudge; fresh ones don't", () => {
  const input: ProactiveInput = {
    now: NOW,
    commitments: [
      { id: "c1", line: "I'll send Raju the deck", contact: "Raju", madeAt: NOW - 6 * 60 * MIN },
      { id: "c2", line: "I'll reply later", madeAt: NOW - 30 * MIN }, // too fresh
    ],
  };
  const nudges = computeProactiveNudges(input);
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].kind, "commitment");
  assert.match(nudges[0].text, /deck/);
});

test("commitment with no madeAt always qualifies", () => {
  const nudges = computeProactiveNudges({
    now: NOW,
    commitments: [{ id: "c3", line: "send the contract" }],
  });
  assert.equal(nudges.length, 1);
});

test("dedupeKey is stable across identical calls and day-bucketed where relevant", () => {
  const input: ProactiveInput = {
    now: NOW,
    keyDates: [{ label: "wedding anniversary", date: "2017-06-04" }],
    awaitingReply: [{ handle: "+1555", lastInboundAt: NOW - 3 * DAY }],
    commitments: [{ id: "c1", line: "send doc" }],
  };
  const a = computeProactiveNudges(input);
  const b = computeProactiveNudges(input);
  assert.deepEqual(a.map((n) => n.dedupeKey), b.map((n) => n.dedupeKey));

  // Same overdue reply, one day later → a DIFFERENT key (re-nags daily).
  const later = computeProactiveNudges({
    ...input,
    now: NOW + DAY,
  });
  const overdueA = a.find((n) => n.kind === "overdue-reply")!;
  const overdueLater = later.find((n) => n.kind === "overdue-reply")!;
  assert.notEqual(overdueA.dedupeKey, overdueLater.dedupeKey);
});

test("maxNudges caps output to the highest-priority items", () => {
  const events = Array.from({ length: 12 }, (_, i) => ({
    title: `M${i}`,
    startAt: NOW + (i + 1) * MIN,
    eventId: `e${i}`,
  }));
  const nudges = computeProactiveNudges({
    now: NOW,
    upcomingEvents: events,
    config: { maxNudges: 3 },
  });
  assert.equal(nudges.length, 3);
});

test("formatNudgeForOwner returns the natural one-liner", () => {
  const [n] = computeProactiveNudges({
    now: NOW,
    keyDates: [{ label: "wedding anniversary", date: "2017-06-04" }],
  });
  assert.equal(formatNudgeForOwner(n), n.text);
  // Not robotic — no field dumps / JSON.
  assert.doesNotMatch(n.text, /[{}[\]]/);
});

test("empty input yields no nudges", () => {
  assert.deepEqual(computeProactiveNudges({ now: NOW }), []);
});
