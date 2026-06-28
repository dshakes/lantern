// Tests for the proactive-loops module.
//   cd packages/bridge-core && node --import=tsx/esm --test src/proactive-loops.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeCommuteSurface, computeEnergyNudge } from "./proactive-loops.ts"; // ponytail: .ts OK here — tsx/esm test runner
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
