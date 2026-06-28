// Tests for the proactive-loops module.
//   cd packages/bridge-core && node --import=tsx/esm --test src/proactive-loops.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  computeCommuteSurface,
  computeEnergyNudge,
  computeHealthCoachNudge,
  computeWeeklyHealthSummary,
  computeFocusGuardian,
} from "./proactive-loops.ts"; // ponytail: .ts OK here — tsx/esm test runner
import type { SignalPresence } from "./device-signals.js";
import type { Commitment } from "./commitments-edge.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.now();

function driving(): SignalPresence {
  return { state: "driving", line: "driving right now", away: true };
}

function notDriving(): SignalPresence {
  return { state: "free", line: "free / available", away: false };
}

function task(title: string): Commitment {
  return { id: title, title, status: "open" };
}

// ─── computeCommuteSurface ────────────────────────────────────────────────────

test("driving + commitments → drive nudge on first tick", () => {
  const result = computeCommuteSurface(
    driving(),
    [task("Call doctor"), task("Send report")],
    { alreadyFiredThisDrive: false, lastWasDriving: false },
  );
  assert.ok(result, "should return a result");
  assert.equal(result.kind, "drive");
  assert.match(result.text, /🚗/);
  assert.match(result.text, /Call doctor/);
  assert.match(result.text, /Send report/);
});

test("driving + no commitments → null (nothing to surface)", () => {
  const result = computeCommuteSurface(
    driving(),
    [],
    { alreadyFiredThisDrive: false, lastWasDriving: false },
  );
  assert.equal(result, null);
});

test("driving + already fired → null (fire-once guard)", () => {
  const result = computeCommuteSurface(
    driving(),
    [task("Send deck")],
    { alreadyFiredThisDrive: true, lastWasDriving: false },
  );
  assert.equal(result, null);
});

test("not driving + lastWasDriving=true → park recap with commitments", () => {
  const result = computeCommuteSurface(
    notDriving(),
    [task("Reply to Manu")],
    { alreadyFiredThisDrive: false, lastWasDriving: true },
  );
  assert.ok(result, "should return a park recap");
  assert.equal(result.kind, "park");
  assert.match(result.text, /🅿️/);
  assert.match(result.text, /Reply to Manu/);
});

test("not driving + lastWasDriving=true + no commitments → all-clear park", () => {
  const result = computeCommuteSurface(
    null, // no presence signal at all
    [],
    { alreadyFiredThisDrive: false, lastWasDriving: true },
  );
  assert.ok(result);
  assert.equal(result.kind, "park");
  assert.match(result.text, /all clear/i);
});

test("not driving + lastWasDriving=false → null (no transition)", () => {
  const result = computeCommuteSurface(
    notDriving(),
    [task("File taxes")],
    { alreadyFiredThisDrive: false, lastWasDriving: false },
  );
  assert.equal(result, null);
});

test("presence=null + lastWasDriving=false → null", () => {
  const result = computeCommuteSurface(
    null,
    [task("Something")],
    { alreadyFiredThisDrive: false, lastWasDriving: false },
  );
  assert.equal(result, null);
});

test("more than 3 commitments → first 3 listed + count tail", () => {
  const result = computeCommuteSurface(
    driving(),
    [task("A"), task("B"), task("C"), task("D"), task("E")],
    { alreadyFiredThisDrive: false, lastWasDriving: false },
  );
  assert.ok(result);
  assert.match(result.text, /\+2 more/);
});

// ─── computeEnergyNudge ───────────────────────────────────────────────────────

function sleepSignal(hours: number, msAgo = 2 * 60 * 60_000) {
  return {
    kind: "health" as const,
    metric: "sleep" as const,
    value: hours,
    ts: NOW - msAgo,
  };
}

test("short sleep < 6h → nudge with hours in text", () => {
  const result = computeEnergyNudge(
    [sleepSignal(5.2)],
    { alreadyNudgedToday: false, nowMs: NOW },
  );
  assert.ok(result, "should return a nudge");
  assert.match(result.text, /😴/);
  assert.match(result.text, /5\.2h/);
});

test("normal sleep >= 6h → null", () => {
  const result = computeEnergyNudge(
    [sleepSignal(7.5)],
    { alreadyNudgedToday: false, nowMs: NOW },
  );
  assert.equal(result, null);
});

test("sleep exactly at floor (6h) → null (not below)", () => {
  const result = computeEnergyNudge(
    [sleepSignal(6.0)],
    { alreadyNudgedToday: false, nowMs: NOW },
  );
  assert.equal(result, null);
});

test("already nudged today → null (once-per-day guard)", () => {
  const result = computeEnergyNudge(
    [sleepSignal(4.0)],
    { alreadyNudgedToday: true, nowMs: NOW },
  );
  assert.equal(result, null);
});

test("no sleep signal at all → null", () => {
  const result = computeEnergyNudge(
    [{ kind: "health", metric: "steps", value: 8000, ts: NOW - 1000 }],
    { alreadyNudgedToday: false, nowMs: NOW },
  );
  assert.equal(result, null);
});

test("sleep signal older than 8h window → null", () => {
  const nineHoursAgo = 9 * 60 * 60_000;
  const result = computeEnergyNudge(
    [sleepSignal(4.5, nineHoursAgo)],
    { alreadyNudgedToday: false, nowMs: NOW, windowMs: 8 * 60 * 60_000 },
  );
  assert.equal(result, null);
});

test("custom floor 7h — 6.5h sleep triggers nudge", () => {
  const result = computeEnergyNudge(
    [sleepSignal(6.5)],
    { alreadyNudgedToday: false, sleepFloorHours: 7, nowMs: NOW },
  );
  assert.ok(result);
  assert.match(result.text, /6\.5h/);
});

test("integer sleep hours (5h) → '5h' (no decimal)", () => {
  const result = computeEnergyNudge(
    [sleepSignal(5.0)],
    { alreadyNudgedToday: false, nowMs: NOW },
  );
  assert.ok(result);
  assert.match(result.text, /~5h/);
  // Should NOT have a decimal point for whole hours.
  assert.ok(!result.text.includes("5.0h"), "whole hours should not show .0");
});

test("empty signals → null", () => {
  const result = computeEnergyNudge(
    [],
    { alreadyNudgedToday: false, nowMs: NOW },
  );
  assert.equal(result, null);
});

// ─── computeHealthCoachNudge ──────────────────────────────────────────────────

function stepsSignal(value: number, msAgo = 60_000) {
  return { kind: "health" as const, metric: "steps" as const, value, ts: NOW - msAgo };
}

function workoutSignal(detail?: string, msAgo = 60_000) {
  return {
    kind: "health" as const,
    metric: "workout" as const,
    value: undefined as number | undefined,
    detail,
    ts: NOW - msAgo,
  };
}

test("steps below goal at midday → nudge", () => {
  const result = computeHealthCoachNudge(
    [stepsSignal(4200)],
    { alreadyNudgedToday: false, hour: 14, stepGoal: 8000, nowMs: NOW },
  );
  assert.ok(result, "should return a nudge");
  assert.match(result.text, /🏃/);
  assert.match(result.text, /4\.2k/);
  assert.match(result.text, /3\.8k/);
  assert.match(result.text, /8k goal/);
});

test("steps at or above goal → null", () => {
  const result = computeHealthCoachNudge(
    [stepsSignal(8500)],
    { alreadyNudgedToday: false, hour: 14, stepGoal: 8000, nowMs: NOW },
  );
  assert.equal(result, null);
});

test("outside nudge window (hour < 12) → null", () => {
  const result = computeHealthCoachNudge(
    [stepsSignal(3000)],
    { alreadyNudgedToday: false, hour: 9, stepGoal: 8000, nowMs: NOW },
  );
  assert.equal(result, null);
});

test("outside nudge window (hour >= 20) → null", () => {
  const result = computeHealthCoachNudge(
    [stepsSignal(3000)],
    { alreadyNudgedToday: false, hour: 21, stepGoal: 8000, nowMs: NOW },
  );
  assert.equal(result, null);
});

test("already nudged today → null", () => {
  const result = computeHealthCoachNudge(
    [stepsSignal(3000)],
    { alreadyNudgedToday: true, hour: 14, stepGoal: 8000, nowMs: NOW },
  );
  assert.equal(result, null);
});

test("workout signal today → ack (takes priority over step nudge)", () => {
  const result = computeHealthCoachNudge(
    [stepsSignal(3000), workoutSignal("ran 3mi")],
    { alreadyNudgedToday: false, hour: 15, stepGoal: 8000, nowMs: NOW },
  );
  assert.ok(result, "should return an ack");
  assert.match(result.text, /💪/);
  assert.match(result.text, /ran 3mi/);
});

test("workout with no detail → generic ack", () => {
  const result = computeHealthCoachNudge(
    [workoutSignal(undefined)],
    { alreadyNudgedToday: false, hour: 16, stepGoal: 8000, nowMs: NOW },
  );
  assert.ok(result);
  assert.match(result.text, /💪/);
  assert.ok(!result.text.includes("undefined"), "no 'undefined' in text");
});

test("no health signals → null", () => {
  const result = computeHealthCoachNudge(
    [],
    { alreadyNudgedToday: false, hour: 14, stepGoal: 8000, nowMs: NOW },
  );
  assert.equal(result, null);
});

test("signal outside 24h window → null", () => {
  const twoDaysAgo = 49 * 60 * 60_000;
  const result = computeHealthCoachNudge(
    [stepsSignal(3000, twoDaysAgo)],
    { alreadyNudgedToday: false, hour: 14, stepGoal: 8000, nowMs: NOW },
  );
  assert.equal(result, null);
});

// ─── computeWeeklyHealthSummary ───────────────────────────────────────────────

function weekSteps(days: number[], stepsPerDay = 7000): Array<ReturnType<typeof stepsSignal>> {
  // days[0] = today, days[1] = yesterday, etc.
  return days.map((d) => stepsSignal(stepsPerDay, d * 24 * 60 * 60_000));
}

test("enough step data → weekly summary with avg steps", () => {
  const signals = weekSteps([0, 1, 2, 3], 7000);
  const result = computeWeeklyHealthSummary(signals, { nowMs: NOW });
  assert.ok(result, "should return a summary");
  assert.match(result.text, /🧘/);
  assert.match(result.text, /steps/);
});

test("not enough data (< 3 days, no workouts) → null", () => {
  const result = computeWeeklyHealthSummary(
    [stepsSignal(7000)], // only 1 day
    { nowMs: NOW, minDataDays: 3 },
  );
  assert.equal(result, null);
});

test("no data → null", () => {
  const result = computeWeeklyHealthSummary([], { nowMs: NOW });
  assert.equal(result, null);
});

test("workouts alone → summary even without step/sleep data", () => {
  const signals = [workoutSignal("swam 40 laps")];
  const result = computeWeeklyHealthSummary(signals, { nowMs: NOW, minDataDays: 0 });
  assert.ok(result);
  assert.match(result.text, /workout/);
});

test("weekly summary includes sleep avg when present", () => {
  const signals = [
    ...weekSteps([0, 1, 2, 3], 7000),
    { kind: "health" as const, metric: "sleep" as const, value: 7.5, ts: NOW - 1 * 24 * 60 * 60_000 },
    { kind: "health" as const, metric: "sleep" as const, value: 6.5, ts: NOW - 2 * 24 * 60 * 60_000 },
  ];
  const result = computeWeeklyHealthSummary(signals, { nowMs: NOW });
  assert.ok(result);
  assert.match(result.text, /sleep avg/);
});

// ─── computeFocusGuardian ─────────────────────────────────────────────────────

test("focus active (dnd) → hold action", () => {
  const result = computeFocusGuardian("dnd", [], { wasFocused: false });
  assert.ok(result);
  assert.equal(result.action, "hold");
});

test("focus active (busy) → hold action", () => {
  const result = computeFocusGuardian("busy", [], { wasFocused: true });
  assert.ok(result);
  assert.equal(result.action, "hold");
});

test("focus cleared with held items → release action with text", () => {
  const held = ["meeting in 10 min", "3 steps to goal"];
  const result = computeFocusGuardian("free", held, {
    wasFocused: true,
    durationMs: 2 * 60 * 60_000,
  });
  assert.ok(result);
  assert.equal(result.action, "release");
  assert.match((result as { action: "release"; text: string }).text, /📥/);
  assert.match((result as { action: "release"; text: string }).text, /meeting in 10 min/);
  assert.match((result as { action: "release"; text: string }).text, /2h/);
});

test("focus cleared with no held items → null (nothing to recap)", () => {
  const result = computeFocusGuardian("free", [], { wasFocused: true });
  assert.equal(result, null);
});

test("no focus, was not focused → null (steady-state free)", () => {
  const result = computeFocusGuardian("free", ["something"], { wasFocused: false });
  assert.equal(result, null);
});

test("presence null (no signal) → null", () => {
  const result = computeFocusGuardian(null, [], { wasFocused: false });
  assert.equal(result, null);
});

test("focus cleared, 3+ held items → tail shows count", () => {
  const held = ["a", "b", "c", "d", "e"];
  const result = computeFocusGuardian("free", held, { wasFocused: true });
  assert.ok(result);
  assert.equal(result.action, "release");
  assert.match((result as { action: "release"; text: string }).text, /\+2 more/);
});
