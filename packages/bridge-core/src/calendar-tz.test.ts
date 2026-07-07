// Regression: all-day Google-Calendar events (date-only "YYYY-MM-DD", no
// dateTime) were parsed as midnight UTC — in a negative-offset zone that
// renders as the PRIOR evening ("Jul 6, 8:00 PM"), a wrong day + a fabricated
// time the LLM reasoned over for availability. Sibling of the CalendarEventRead
// fix (#166), different path (the connector).
//
// Force a negative-offset zone so this is deterministic in any CI timezone.
process.env.TZ = "America/New_York";

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { formatWhen } from "./calendar.ts";

test("formatWhen renders an all-day date as the correct local day (not prior evening)", () => {
  const s = formatWhen("2026-07-07");
  assert.match(s, /Jul 7/); // the actual day
  assert.match(s, /all day/i);
  assert.doesNotMatch(s, /Jul 6/); // NOT the prior day (the bug)
  assert.doesNotMatch(s, /\d\d?:\d\d|AM|PM/); // no fabricated time
});

test("formatWhen still renders timed events with their time", () => {
  const s = formatWhen("2026-07-07T14:30:00-04:00");
  assert.match(s, /2:30/);
  assert.match(s, /Jul 7/);
});
