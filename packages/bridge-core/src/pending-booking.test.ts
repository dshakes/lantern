// Tests for the CONFIRM-BEFORE-BOOK gate on life-event auto-act calendar books.
//   cd packages/bridge-core && npx tsx --test src/pending-booking.test.ts
//
// The bar: an inferred life-event time is NEVER silently booked. A held booking
//   * fires the book on an in-window "yes" (resolvePendingBooking → "book"),
//   * drops on an in-window "no"          (→ "skip"),
//   * drops on TTL expiry, never booking  (→ "expired"),
//   * falls through on anything else       (→ "unrelated").

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolvePendingBooking, type PendingBooking } from "./life-events.ts";

const TTL = 10 * 60_000;
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0);

function booking(issuedAt: number): PendingBooking {
  return {
    title: "Appointment — Dentist",
    startIso: "2026-07-03T09:00:00",
    endIso: "2026-07-03T09:30:00",
    lifeEventKind: "appointment",
    idempotencyKey: "appt:dentist:0703",
    rawText: "your dentist appt is Thu Jul 3 at 9am",
    issuedAt,
  };
}

test("no pending booking → unrelated", () => {
  assert.equal(resolvePendingBooking(undefined, "yes", NOW, TTL), "unrelated");
});

test("in-window 'yes' → book", () => {
  assert.equal(resolvePendingBooking(booking(NOW - 60_000), "yes", NOW, TTL), "book");
  assert.equal(resolvePendingBooking(booking(NOW), "add it", NOW, TTL), "book");
});

test("in-window 'no' → skip", () => {
  assert.equal(resolvePendingBooking(booking(NOW - 60_000), "no", NOW, TTL), "skip");
  assert.equal(resolvePendingBooking(booking(NOW), "nah skip", NOW, TTL), "skip");
});

test("past TTL → expired, never books even on 'yes'", () => {
  assert.equal(resolvePendingBooking(booking(NOW - TTL), "yes", NOW, TTL), "expired");
  assert.equal(resolvePendingBooking(booking(NOW - TTL - 1), "yes", NOW, TTL), "expired");
});

test("unrelated chatter in-window → unrelated (falls through, no book)", () => {
  assert.equal(resolvePendingBooking(booking(NOW), "what's the weather", NOW, TTL), "unrelated");
});
