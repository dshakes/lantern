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
} from "./mac-actions.ts";

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
