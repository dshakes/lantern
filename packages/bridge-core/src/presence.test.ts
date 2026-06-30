// Tests for signal-fusion truthfulness in presence.ts.
//   cd packages/bridge-core && npx tsx --test src/presence.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PresenceTracker } from "./presence.ts";
import type { SignalPresence } from "./device-signals.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

// Helper: poke the private manualOverride without going through the file system.
function setMemoryOverride(
  tracker: PresenceTracker,
  opts: {
    label: string;
    state?: "busy" | "free" | "dnd" | "sleep" | "driving" | "meeting" | "unknown";
    setAt: number;
    expiresAt: number;
    place?: string;
  },
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tracker as any).manualOverride = {
    state: opts.state ?? "busy",
    label: opts.label,
    setAt: opts.setAt,
    expiresAt: opts.expiresAt,
    place: opts.place,
    takeMessage: true,
  };
}

// (a) A place-based override set ~3h ago loses to a fresh iphone "Home" signal.
test("stale place-based override yields to fresher iphone signal", async () => {
  const now = Date.now();
  const tracker = new PresenceTracker();
  setMemoryOverride(tracker, {
    label: "at the park",
    place: "the park",
    state: "busy",
    setAt: now - 3 * HOUR,
    expiresAt: now + HOUR, // still not expired
  });

  const iphone: SignalPresence = { state: "free", line: "free / available", away: false };
  const snap = await tracker.current({ iphone, iphoneTs: now - 30_000 });

  assert.equal(snap.source, "iphone", "iphone should win over stale place override");
  assert.ok(!snap.line.includes("park"), `line must not mention old place: "${snap.line}"`);
});

// (a2) A non-place override (meeting) is intentional and NOT dropped by iphone.
test("non-place override (meeting) survives a fresher iphone free signal", async () => {
  const now = Date.now();
  const tracker = new PresenceTracker();
  setMemoryOverride(tracker, {
    label: "in a meeting",
    state: "meeting",
    setAt: now - 30 * MIN, // 30min old, no place
    expiresAt: now + HOUR,
    // no place field
  });

  const iphone: SignalPresence = { state: "free", line: "free / available", away: false };
  const snap = await tracker.current({ iphone, iphoneTs: now - 5_000 });

  assert.equal(snap.source, "override", "override without place must stick");
  assert.match(snap.line, /meeting/i);
});

// (b) A presence with no place never emits a place field.
test("snapshot never emits a place when the data has none", async () => {
  const now = Date.now();
  const tracker = new PresenceTracker();
  setMemoryOverride(tracker, {
    label: "Do Not Disturb",
    state: "dnd",
    setAt: now - MIN,
    expiresAt: now + HOUR,
    // no place
  });

  const snap = await tracker.current({});
  assert.equal(snap.place, undefined, "place must be undefined when not set");
});

// (b2) Anti-fabrication: override loaded from old file (no setAt → 0) strips place.
test("old-format override without setAt suppresses place in snapshot", async () => {
  const now = Date.now();
  const tracker = new PresenceTracker();
  setMemoryOverride(tracker, {
    label: "at the gym",
    place: "the gym",
    state: "busy",
    setAt: 0, // simulates old file format with no setAt
    expiresAt: now + HOUR,
  });

  const snap = await tracker.current({});
  assert.equal(snap.place, undefined, "place from untimstamped override must be suppressed");
  assert.match(snap.line, /gym/i, "label still appears in line");
});

// Staleness: an old override shows "as of Nm ago" in the line.
test("override older than 5min shows staleness clause", async () => {
  const now = Date.now();
  const tracker = new PresenceTracker();
  setMemoryOverride(tracker, {
    label: "driving",
    state: "driving",
    setAt: now - 20 * MIN,
    expiresAt: now + HOUR,
  });

  const snap = await tracker.current({});
  assert.match(snap.line, /as of \d+m ago/i, `expected staleness in: "${snap.line}"`);
});

// Fresh override (< 5 min) has no as-of clause.
test("fresh override (< 5min) has no as-of clause", async () => {
  const now = Date.now();
  const tracker = new PresenceTracker();
  setMemoryOverride(tracker, {
    label: "driving",
    state: "driving",
    setAt: now - 2 * MIN,
    expiresAt: now + HOUR,
  });

  const snap = await tracker.current({});
  assert.ok(!snap.line.includes("as of"), `no staleness expected in: "${snap.line}"`);
});

// Iphone staleness: old iphone signal shows as-of.
test("iphone signal older than 5min shows staleness clause", async () => {
  const now = Date.now();
  const tracker = new PresenceTracker();
  const iphone: SignalPresence = { state: "busy", line: "busy", away: true };
  const snap = await tracker.current({ iphone, iphoneTs: now - 10 * MIN });
  assert.match(snap.line, /as of \d+m ago/i, `expected staleness in: "${snap.line}"`);
});
