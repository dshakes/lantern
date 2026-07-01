import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCalendarEvent } from "./mac-actions.js";

const NOW = Date.parse("2026-07-01T12:00:00");

test("accepts a valid future event", () => {
  const r = validateCalendarEvent({ title: "Coffee", start: "2026-07-02T10:00:00", end: "2026-07-02T11:00:00" }, NOW);
  assert.equal(r.ok, true);
});

test("rejects an unparseable start", () => {
  const r = validateCalendarEvent({ title: "Junk", start: "not-a-date" }, NOW);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /unparseable/);
});

test("rejects a past start (the garbage-booking bug)", () => {
  const r = validateCalendarEvent({ title: "Old", start: "2026-06-20T09:00:00" }, NOW);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /past/);
});

test("rejects an inverted range (end before start)", () => {
  const r = validateCalendarEvent({ title: "Bad", start: "2026-07-02T11:00:00", end: "2026-07-02T10:00:00" }, NOW);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /end/);
});

test("allows a start within the 5-min grace window", () => {
  const r = validateCalendarEvent({ title: "Now-ish", start: "2026-07-01T11:58:00" }, NOW);
  assert.equal(r.ok, true);
});
