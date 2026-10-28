import { test } from "node:test";
import assert from "node:assert/strict";
import { TOUR_STEPS, parseMeta, msLeft, formatClock, isIdle, nextStep, IDLE_LIMIT_MS } from "./kiosk-logic.ts";

test("tour has the five planned steps over distinct real routes", () => {
  assert.deepEqual(TOUR_STEPS.map((s) => s.id), ["inbox", "run", "budget", "receipt", "sandbox"]);
  assert.equal(new Set(TOUR_STEPS.map((s) => s.href)).size, 5);
});

test("parseMeta rejects missing, corrupt and dateless entries", () => {
  assert.equal(parseMeta(null), null);
  assert.equal(parseMeta("{nope"), null);
  assert.equal(parseMeta('{"expiresAt":"soon"}'), null);
  assert.equal(parseMeta('{"expiresAt":"2030-01-01T00:00:00Z"}')?.mode, "replay");
});

test("countdown clamps at zero and formats m:ss", () => {
  const meta = parseMeta('{"expiresAt":"2030-01-01T00:30:00Z"}')!;
  const t0 = Date.parse("2030-01-01T00:00:00Z");
  assert.equal(formatClock(msLeft(meta, t0)), "30:00");
  assert.equal(formatClock(msLeft(meta, t0 + 29 * 60_000 + 55_000)), "0:05");
  assert.equal(msLeft(meta, t0 + 3_600_000), 0);
});

test("idle triggers at exactly the limit", () => {
  assert.equal(isIdle(0, IDLE_LIMIT_MS - 1), false);
  assert.equal(isIdle(0, IDLE_LIMIT_MS), true);
});

test("nextStep stops at the last step", () => {
  assert.equal(nextStep(0), 1);
  assert.equal(nextStep(TOUR_STEPS.length - 1), TOUR_STEPS.length - 1);
});
