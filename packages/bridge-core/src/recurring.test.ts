import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerLocalClock, isDue, addReminder, loadReminders, persistReminders, removeReminder, describeCadence } from "./recurring.ts";

const dir = () => mkdtempSync(join(tmpdir(), "rec-"));
const R = (o = {}) => ({ id: "r1", title: "take meds", cadence: "daily", timeHHMM: "18:00", createdBy: "Manasa", createdMs: 1, ...o });

describe("recurring", () => {
  test("ownerLocalClock returns local parts for a tz", () => {
    // 2026-06-30T22:06:00Z → 18:06 America/New_York (EDT)
    const c = ownerLocalClock(Date.parse("2026-06-30T22:06:00Z"), "America/New_York");
    assert.equal(c.hh, 18);
    assert.equal(c.mm, 6);
  });

  test("isDue: fires within window, once per day, weekly day-gated", () => {
    assert.equal(isDue(R() as any, { hh: 18, mm: 1, dayOfWeek: 2, dateStr: "2026-06-30" }), true);
    assert.equal(isDue(R() as any, { hh: 18, mm: 30, dayOfWeek: 2, dateStr: "2026-06-30" }), false); // outside window
    assert.equal(isDue(R({ lastFiredDate: "2026-06-30" }) as any, { hh: 18, mm: 0, dayOfWeek: 2, dateStr: "2026-06-30" }), false); // already fired
    assert.equal(isDue(R({ cadence: "weekly", days: [1, 3] }) as any, { hh: 18, mm: 0, dayOfWeek: 2, dateStr: "2026-06-30" }), false); // Tue not in Mon/Wed
    assert.equal(isDue(R({ cadence: "weekly", days: [1, 3] }) as any, { hh: 18, mm: 0, dayOfWeek: 3, dateStr: "2026-07-01" }), true);
  });

  test("store: add / load / persist(fired stamp) / remove", () => {
    const d = dir();
    try {
      addReminder(d, R() as any);
      addReminder(d, R({ id: "r2", title: "water plants", timeHHMM: "09:00" }) as any);
      let all = loadReminders(d);
      assert.equal(all.length, 2);
      all[0].lastFiredDate = "2026-06-30";
      persistReminders(d, all);
      assert.equal(loadReminders(d)[0].lastFiredDate, "2026-06-30");
      assert.equal(removeReminder(d, "r1").length, 1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("describeCadence renders friendly schedule", () => {
    assert.equal(describeCadence(R() as any), "daily at 6:00pm");
    assert.match(describeCadence(R({ cadence: "weekly", days: [1, 3], timeHHMM: "09:00" }) as any), /Mon\/Wed at 9:00am/);
  });
});
