import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildTimeline,
  eventAtCursor,
  cursorIndex,
  computeStats,
  type FlightEvent,
} from "../lib/flight-recorder.ts";

function ev(overrides: Partial<FlightEvent> & { seq: number; ts: string }): FlightEvent {
  return { kind: "log", data: {}, ...overrides };
}

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z"; // +1000ms
const T2 = "2026-01-01T00:00:02.000Z"; // +2000ms
const T3 = "2026-01-01T00:00:03.000Z"; // +3000ms

// ---------------------------------------------------------------------------
// buildTimeline
// ---------------------------------------------------------------------------

test("buildTimeline: empty input returns empty array", () => {
  assert.deepEqual(buildTimeline([]), []);
});

test("buildTimeline: single event has relativeMs=0", () => {
  const tl = buildTimeline([ev({ seq: 1, ts: T0 })]);
  assert.equal(tl.length, 1);
  assert.equal(tl[0].relativeMs, 0);
});

test("buildTimeline: events sorted by seq, not by ts order in input", () => {
  // Pass in reverse-seq order; buildTimeline must sort by seq.
  const tl = buildTimeline([
    ev({ seq: 3, ts: T2 }),
    ev({ seq: 1, ts: T0 }),
    ev({ seq: 2, ts: T1 }),
  ]);
  assert.equal(tl[0].seq, 1);
  assert.equal(tl[1].seq, 2);
  assert.equal(tl[2].seq, 3);
});

test("buildTimeline: relativeMs is ms from the first event's ts", () => {
  const tl = buildTimeline([
    ev({ seq: 1, ts: T0 }),
    ev({ seq: 2, ts: T1 }),
    ev({ seq: 3, ts: T3 }),
  ]);
  assert.equal(tl[0].relativeMs, 0);
  assert.equal(tl[1].relativeMs, 1000);
  assert.equal(tl[2].relativeMs, 3000);
});

test("buildTimeline: clock skew (ts before first) clamps to 0, not negative", () => {
  // Seq ordering is authoritative; a later-seq event with earlier ts clamps.
  const tl = buildTimeline([
    ev({ seq: 1, ts: T1 }), // t0 = T1
    ev({ seq: 2, ts: T0 }), // ts < t0 — clamp to 0
  ]);
  assert.equal(tl[0].relativeMs, 0);
  assert.equal(tl[1].relativeMs, 0); // clamped
});

test("buildTimeline: preserves all original event fields", () => {
  const tl = buildTimeline([ev({ seq: 1, ts: T0, stepId: "s1", kind: "step_started", data: { name: "foo" } })]);
  assert.equal(tl[0].stepId, "s1");
  assert.equal(tl[0].kind, "step_started");
  assert.deepEqual(tl[0].data, { name: "foo" });
});

// ---------------------------------------------------------------------------
// eventAtCursor
// ---------------------------------------------------------------------------

test("eventAtCursor: returns null for empty timeline", () => {
  assert.equal(eventAtCursor([], 500), null);
});

test("eventAtCursor: cursor before all events returns first event", () => {
  const tl = buildTimeline([ev({ seq: 1, ts: T1 }), ev({ seq: 2, ts: T2 })]);
  // Both have relativeMs >= 0; cursor at -1 is before first.
  const result = eventAtCursor(tl, -1);
  assert.equal(result?.seq, 1);
});

test("eventAtCursor: cursor exactly on an event returns that event", () => {
  const tl = buildTimeline([
    ev({ seq: 1, ts: T0 }),
    ev({ seq: 2, ts: T1 }),
    ev({ seq: 3, ts: T2 }),
  ]);
  const result = eventAtCursor(tl, 1000);
  assert.equal(result?.seq, 2);
  assert.equal(result?.relativeMs, 1000);
});

test("eventAtCursor: cursor between events returns the one before", () => {
  const tl = buildTimeline([
    ev({ seq: 1, ts: T0 }),
    ev({ seq: 2, ts: T2 }), // +2000ms
  ]);
  const result = eventAtCursor(tl, 1500);
  assert.equal(result?.seq, 1);
});

test("eventAtCursor: cursor past all events returns last event", () => {
  const tl = buildTimeline([
    ev({ seq: 1, ts: T0 }),
    ev({ seq: 2, ts: T1 }),
  ]);
  const result = eventAtCursor(tl, 999_999);
  assert.equal(result?.seq, 2);
});

// ---------------------------------------------------------------------------
// cursorIndex
// ---------------------------------------------------------------------------

test("cursorIndex: empty timeline returns 0", () => {
  assert.equal(cursorIndex([], 500), 0);
});

test("cursorIndex: returns index of last event at or before cursor", () => {
  const tl = buildTimeline([
    ev({ seq: 1, ts: T0 }), // relativeMs=0   idx=0
    ev({ seq: 2, ts: T1 }), // relativeMs=1000  idx=1
    ev({ seq: 3, ts: T2 }), // relativeMs=2000  idx=2
  ]);
  assert.equal(cursorIndex(tl, 0), 0);
  assert.equal(cursorIndex(tl, 999), 0);
  assert.equal(cursorIndex(tl, 1000), 1);
  assert.equal(cursorIndex(tl, 1001), 1);
  assert.equal(cursorIndex(tl, 2000), 2);
  assert.equal(cursorIndex(tl, 5000), 2);
});

// ---------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------

test("computeStats: empty timeline returns all zeros", () => {
  const s = computeStats([]);
  assert.equal(s.totalEvents, 0);
  assert.equal(s.steps, 0);
  assert.equal(s.retries, 0);
  assert.equal(s.durationMs, 0);
});

test("computeStats: counts total events including non-step kinds", () => {
  const tl = buildTimeline([
    ev({ seq: 1, ts: T0, kind: "log" }),
    ev({ seq: 2, ts: T1, kind: "llm_complete" }),
    ev({ seq: 3, ts: T2, kind: "step_started", stepId: "s1" }),
  ]);
  assert.equal(computeStats(tl).totalEvents, 3);
});

test("computeStats: counts unique step_started stepIds as steps", () => {
  const tl = buildTimeline([
    ev({ seq: 1, ts: T0, kind: "step_started", stepId: "s1" }),
    ev({ seq: 2, ts: T1, kind: "step_started", stepId: "s2" }),
    ev({ seq: 3, ts: T2, kind: "step_completed", stepId: "s1" }),
  ]);
  assert.equal(computeStats(tl).steps, 2);
});

test("computeStats: step_started without stepId does not increment steps", () => {
  const tl = buildTimeline([
    ev({ seq: 1, ts: T0, kind: "step_started" }), // no stepId
  ]);
  assert.equal(computeStats(tl).steps, 0);
});

test("computeStats: retries counts extra step_started for same stepId beyond first", () => {
  const tl = buildTimeline([
    ev({ seq: 1, ts: T0, kind: "step_started", stepId: "s1" }),
    ev({ seq: 2, ts: T1, kind: "step_started", stepId: "s1" }), // retry #1
    ev({ seq: 3, ts: T2, kind: "step_started", stepId: "s1" }), // retry #2
    ev({ seq: 4, ts: T3, kind: "step_started", stepId: "s2" }),
  ]);
  const s = computeStats(tl);
  assert.equal(s.retries, 2); // s1 retried twice; s2 never
  assert.equal(s.steps, 2);   // two distinct stepIds
});

test("computeStats: durationMs is relativeMs of last event", () => {
  const tl = buildTimeline([
    ev({ seq: 1, ts: T0 }),
    ev({ seq: 2, ts: T3 }),
  ]);
  assert.equal(computeStats(tl).durationMs, 3000);
});
