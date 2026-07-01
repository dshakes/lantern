import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCalendarEvent, checkCalendarConflict, type CalendarEventRead } from "./mac-actions.js";

const NOW = Date.parse("2026-07-01T12:00:00");

// ── checkCalendarConflict (real-calendar double-book guard) ──
const existing: CalendarEventRead[] = [
  { calendar: "Home", title: "Dentist", start: new Date("2026-07-02T10:00:00"), end: new Date("2026-07-02T11:00:00") },
];

test("rejects an event overlapping an existing one", () => {
  const r = checkCalendarConflict({ title: "Coffee", start: "2026-07-02T10:30:00", end: "2026-07-02T11:30:00" }, existing);
  assert.equal(r.conflict, true);
  assert.equal((r as { title: string }).title, "Dentist");
});

test("allows a non-overlapping event", () => {
  const r = checkCalendarConflict({ title: "Coffee", start: "2026-07-02T14:00:00", end: "2026-07-02T15:00:00" }, existing);
  assert.equal(r.conflict, false);
});

test("allows an adjacent event that only touches the boundary", () => {
  // starts exactly when Dentist ends — half-open [start,end), so no overlap.
  const r = checkCalendarConflict({ title: "Coffee", start: "2026-07-02T11:00:00", end: "2026-07-02T12:00:00" }, existing);
  assert.equal(r.conflict, false);
});

test("no-end existing event is treated as a 30-min block", () => {
  const openEnded: CalendarEventRead[] = [
    { calendar: "Home", title: "Call", start: new Date("2026-07-02T09:00:00"), end: null },
  ];
  assert.equal(checkCalendarConflict({ title: "X", start: "2026-07-02T09:15:00" }, openEnded).conflict, true);
  assert.equal(checkCalendarConflict({ title: "X", start: "2026-07-02T09:45:00" }, openEnded).conflict, false);
});

test("empty / undefined event list never conflicts", () => {
  assert.equal(checkCalendarConflict({ title: "X", start: "2026-07-02T10:30:00" }, []).conflict, false);
  assert.equal(checkCalendarConflict({ title: "X", start: "2026-07-02T10:30:00" }, undefined).conflict, false);
});

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
