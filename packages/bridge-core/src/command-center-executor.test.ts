// node:test suite for command-center-executor.ts pure helpers.
// Run: npx tsx --test src/command-center-executor.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getCenterItems,
  setCenterItems,
  CENTER_STATE_TTL_MS,
  isRealTimeNudge,
  parseSnoozeMs,
} from "./command-center-executor.ts";
import type { CenterStateEntry } from "./command-center-executor.ts";
import type { BriefItem } from "./command-center.ts";

const ITEM: BriefItem = {
  n: 1,
  ref: "commitment",
  id: "c1",
  icon: "•",
  label: "test item",
  defaultAction: "done",
  actions: ["done", "snooze"],
};

// ── getCenterItems / setCenterItems ──────────────────────────────────────────

describe("getCenterItems", () => {
  it("returns null when map is empty", () => {
    const m = new Map<string, CenterStateEntry>();
    assert.strictEqual(getCenterItems(m, "chat1"), null);
  });

  it("returns items within TTL", () => {
    const m = new Map<string, CenterStateEntry>();
    const now = Date.now();
    setCenterItems(m, "chat1", [ITEM], now);
    const result = getCenterItems(m, "chat1", now + 1000);
    assert.deepEqual(result, [ITEM]);
  });

  it("returns null when entry is expired", () => {
    const m = new Map<string, CenterStateEntry>();
    const now = Date.now();
    setCenterItems(m, "chat1", [ITEM], now);
    const result = getCenterItems(m, "chat1", now + CENTER_STATE_TTL_MS + 1);
    assert.strictEqual(result, null);
  });

  it("returns null for a different chatId", () => {
    const m = new Map<string, CenterStateEntry>();
    setCenterItems(m, "chat1", [ITEM]);
    assert.strictEqual(getCenterItems(m, "chat2"), null);
  });

  it("stores the latest items when set twice", () => {
    const m = new Map<string, CenterStateEntry>();
    const now = Date.now();
    const item2: BriefItem = { ...ITEM, n: 2, id: "c2", label: "second" };
    setCenterItems(m, "chat1", [ITEM], now);
    setCenterItems(m, "chat1", [item2], now + 1000);
    const result = getCenterItems(m, "chat1", now + 2000);
    assert.deepEqual(result, [item2]);
  });
});

// ── isRealTimeNudge ──────────────────────────────────────────────────────────

describe("isRealTimeNudge", () => {
  it("pre-meeting → always real-time", () => {
    assert.ok(isRealTimeNudge({ kind: "pre-meeting", text: "Standup in 5 min" }));
  });

  it("commitment with bill keyword → real-time", () => {
    assert.ok(isRealTimeNudge({ kind: "commitment", text: "Netflix bill due tomorrow" }));
  });
  it("commitment with $ → real-time", () => {
    assert.ok(isRealTimeNudge({ kind: "commitment", text: "$49 charge on your card" }));
  });
  it("commitment with subscription → real-time", () => {
    assert.ok(isRealTimeNudge({ kind: "commitment", text: "subscription renewal today" }));
  });
  it("commitment with renew → real-time", () => {
    assert.ok(isRealTimeNudge({ kind: "commitment", text: "renew your license" }));
  });

  it("commitment without bill keyword → NOT real-time", () => {
    assert.ok(!isRealTimeNudge({ kind: "commitment", text: "call mom this week" }));
  });

  it("structured urgency overrides the text heuristic (field wins)", () => {
    // text has no bill keyword, but the commitment is urgent → real-time.
    assert.ok(isRealTimeNudge({ kind: "commitment", text: "send Raju the deck", urgency: "now" }));
    // text LOOKS like a bill ("$5 coupon"), but it's a low-urgency errand → NOT real-time.
    assert.ok(!isRealTimeNudge({ kind: "commitment", text: "review the $5 coupon", urgency: "normal" }));
    // kind-based when no urgency.
    assert.ok(isRealTimeNudge({ kind: "commitment", text: "look at this", commitmentKind: "finance" }));
    assert.ok(!isRealTimeNudge({ kind: "commitment", text: "look at this", commitmentKind: "errand" }));
  });

  it("overdue-reply → NOT real-time", () => {
    assert.ok(!isRealTimeNudge({ kind: "overdue-reply", text: "You haven't replied to Raju in 3 days" }));
  });

  it("relationship-date → NOT real-time", () => {
    assert.ok(!isRealTimeNudge({ kind: "relationship-date", text: "Your anniversary is tomorrow" }));
  });

  it("dormant-vip → NOT real-time", () => {
    assert.ok(!isRealTimeNudge({ kind: "dormant-vip", text: "You haven't spoken to Sujith in 2 months" }));
  });
});

// ── parseSnoozeMs ────────────────────────────────────────────────────────────

describe("parseSnoozeMs", () => {
  it("undefined → 3h", () => assert.strictEqual(parseSnoozeMs(), 3 * 60 * 60 * 1000));
  it("30m → 30 min", () => assert.strictEqual(parseSnoozeMs("30m"), 30 * 60 * 1000));
  it("2h → 2 hours", () => assert.strictEqual(parseSnoozeMs("2h"), 2 * 60 * 60 * 1000));
  it("3d → 3 days", () => assert.strictEqual(parseSnoozeMs("3d"), 3 * 24 * 60 * 60 * 1000));
  it("tomorrow → 24h", () => assert.strictEqual(parseSnoozeMs("tomorrow"), 24 * 60 * 60 * 1000));
  it("TOMORROW case-insensitive", () => assert.strictEqual(parseSnoozeMs("TOMORROW"), 24 * 60 * 60 * 1000));
  it("unrecognized → 3h default", () => assert.strictEqual(parseSnoozeMs("next week"), 3 * 60 * 60 * 1000));
});
