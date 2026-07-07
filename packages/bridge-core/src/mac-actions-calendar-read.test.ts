// Tests for the Apple Calendar.app read parsing/formatting.
//
// Regression: an owner asked "when is my next haircut appointment" and the
// agent said none existed, even though an iCloud event ("Appointment: Visit at
// Hair Cuttery", Jun 3 7pm) was on the device calendar. The bridge only read
// the Google Calendar connector. These lock in that the AppleScript output is
// parsed correctly and surfaced for the LLM.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  parseAppleCalendarOutput,
  formatAppleCalendarBlock,
  calendarStoreDate,
  APPLE_ABS_EPOCH,
} from "./mac-actions.ts";

// Regression: a tomorrow ALL-DAY event ("Splash Day at Goddard (Ved)") fired a
// bogus "starts in 9 min" pre-meeting nudge at 7:51pm. Cause: the Calendar
// store keeps all-day events at midnight GMT; rendering that instant in EDT
// shifts it to ~8pm the PRIOR day. calendarStoreDate must rebuild all-day
// events as LOCAL midnight of the correct calendar day.
test("calendarStoreDate: all-day event lands on local midnight of the GMT day, not the prior evening", () => {
  // Midnight GMT of 2026-07-08, expressed in Calendar-store seconds (since 2001).
  const gmtMidnight2001 = Math.floor(Date.UTC(2026, 6, 8, 0, 0, 0) / 1000) - APPLE_ABS_EPOCH;

  const allDay = calendarStoreDate(gmtMidnight2001, true);
  // Must be the 8th at 00:00 LOCAL — never the 7th evening (the bug).
  assert.equal(allDay.getFullYear(), 2026);
  assert.equal(allDay.getMonth(), 6); // July (0-based)
  assert.equal(allDay.getDate(), 8);
  assert.equal(allDay.getHours(), 0);
  assert.equal(allDay.getMinutes(), 0);

  // A TIMED event returns the exact instant unchanged.
  const timed = calendarStoreDate(gmtMidnight2001, false);
  assert.equal(timed.getTime(), (gmtMidnight2001 + APPLE_ABS_EPOCH) * 1000);
});

test("parses delimited Calendar.app output into sorted events", () => {
  const raw =
    "Home ||| Appointment: Visit at Hair Cuttery ||| 2026-6-3-19-0 ||| 2026-6-3-19-30\n" +
    "Work ||| Standup ||| 2026-6-2-9-30 ||| 2026-6-2-9-45\n";
  const events = parseAppleCalendarOutput(raw);
  assert.equal(events.length, 2);
  // sorted by start: standup (Jun 2) before haircut (Jun 3)
  assert.equal(events[0].title, "Standup");
  assert.equal(events[1].title, "Appointment: Visit at Hair Cuttery");
  assert.equal(events[1].calendar, "Home");
  assert.equal(events[1].start.getFullYear(), 2026);
  assert.equal(events[1].start.getMonth(), 5); // June (0-indexed)
  assert.equal(events[1].start.getDate(), 3);
  assert.equal(events[1].start.getHours(), 19);
});

test("skips malformed / empty lines", () => {
  const raw = "\n  \njunk-with-no-delimiters\nHome ||| OK ||| 2026-6-3-10-0\n";
  const events = parseAppleCalendarOutput(raw);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "OK");
  assert.equal(events[0].end, null); // no end field provided
});

test("formats a block the haircut appointment would surface in", () => {
  const events = parseAppleCalendarOutput(
    "Home ||| Appointment: Visit at Hair Cuttery ||| 2026-6-3-19-0 ||| 2026-6-3-19-30\n",
  );
  // now = Jun 3 morning, before the 7pm appointment
  const now = new Date(2026, 5, 3, 9, 41).getTime();
  const block = formatAppleCalendarBlock(events, { now });
  assert.ok(
    block.includes("Hair Cuttery"),
    "haircut event must appear in the block",
  );
  assert.ok(
    block.includes("Apple Calendar.app"),
    "block must label the source",
  );
});

test("excludes events that have already ended", () => {
  const events = parseAppleCalendarOutput(
    "Home ||| Old thing ||| 2026-6-3-8-0 ||| 2026-6-3-8-30\n",
  );
  const now = new Date(2026, 5, 3, 9, 41).getTime(); // after it ended
  assert.equal(formatAppleCalendarBlock(events, { now }), "");
});

test("empty input yields no block", () => {
  assert.equal(parseAppleCalendarOutput("").length, 0);
  assert.equal(formatAppleCalendarBlock([], {}), "");
});
