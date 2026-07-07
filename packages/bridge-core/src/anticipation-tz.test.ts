// Regression: relationship-date (birthday/anniversary) nudges fired on the
// WRONG day because the day math used UTC parts. On the owner's Mac in a
// negative-offset zone, an evening-before instant (= next-day UTC) made the
// engine say "your anniversary is today" a full day early — and the dedupe
// key then suppressed the real, on-the-day ping.
//
// Force a negative-offset zone so this is deterministic in any CI timezone.
process.env.TZ = "America/New_York";

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeProactiveNudges } from "./anticipation.ts";

test("relationship-date uses LOCAL calendar day, not UTC (no day-early fire)", () => {
  // 2026-06-03 00:30 UTC === 2026-06-02 20:30 EDT. Anniversary is June 3.
  // LOCAL date is still June 2, so June 3 must read as TOMORROW, not today.
  const now = Date.UTC(2026, 5, 3, 0, 30, 0);
  const nudges = computeProactiveNudges({
    now,
    keyDates: [{ label: "wedding anniversary", date: "2017-06-03" }],
  });
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].kind, "relationship-date");
  assert.match(nudges[0].text, /tomorrow/i);
  assert.doesNotMatch(nudges[0].text, /today/i);
});

test("relationship-date says 'today' only when it is the local day", () => {
  // 2026-06-03 16:00 UTC === 2026-06-03 12:00 EDT — local date IS June 3.
  const now = Date.UTC(2026, 5, 3, 16, 0, 0);
  const nudges = computeProactiveNudges({
    now,
    keyDates: [{ label: "wedding anniversary", date: "2017-06-03" }],
  });
  assert.equal(nudges.length, 1);
  assert.match(nudges[0].text, /today/i);
});
