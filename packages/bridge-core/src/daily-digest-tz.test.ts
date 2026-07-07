// Regression: msUntilNextDigest read the target hour from the owner-TZ
// formatter but the minutes/seconds from process-local time. In a half-hour
// zone (Asia/Kolkata +5:30) that differs from the process zone, the digest
// fired up to 30 min off. Read all parts from the same owner-TZ formatter.
//
// Force a WHOLE-hour process zone so the old (process-minute) code would use
// :00 minutes and disagree with Kolkata's :30 — deterministic in any CI zone.
process.env.TZ = "America/New_York";

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { msUntilNextDigest } from "./daily-digest.ts";

test("msUntilNextDigest uses owner-TZ minutes for a half-hour zone", () => {
  // 2026-07-07T00:00:00Z === 05:30 Asia/Kolkata. Target 08:00 IST → 2.5h away.
  const now = new Date(Date.UTC(2026, 6, 7, 0, 0, 0));
  const ms = msUntilNextDigest(now, { hour: 8, timezone: "Asia/Kolkata" });
  // 2.5h = 9,000,000 ms. The old code (process-local minutes = :00 in EDT)
  // would have returned 3h = 10,800,000 ms — firing at 08:30 IST.
  assert.equal(ms, 9_000_000);
});

test("msUntilNextDigest returns -1 when disabled", () => {
  assert.equal(msUntilNextDigest(new Date(), { hour: -1 }), -1);
});
