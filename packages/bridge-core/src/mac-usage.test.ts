// Unit tests for the PURE mac-usage logic (parsing + aggregation +
// summarization). No real knowledgeC.db — rows are mocked, so this runs
// anywhere (the actual DB read is integration, gated on Full Disk Access).
//
// Coverage:
//   - Mac-absolute-time <-> Unix conversion (the 978307200 epoch offset).
//   - per-bundle aggregation (minutes, sessions, last-used; bad rows dropped).
//   - bundle-id -> friendly name (known map + unknown fallback).
//   - summaryLine phrasing (single / multi app; part-of-day).
//   - empty / all-noise input -> empty summary.
//   - owner-context block gating.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  MAC_EPOCH_OFFSET_SEC,
  macAbsoluteToUnixMs,
  unixMsToMacAbsolute,
  friendlyAppName,
  aggregateUsage,
  activeHoursOf,
  summarizeUsage,
  buildSummaryLine,
  usageContextBlock,
  type UsageRow,
} from "./mac-usage.ts";

// A fixed local-hour function so part-of-day phrasing is deterministic across
// machines/timezones: treat the Mac-second values as if hour = (sec/3600 mod 24).
const fixedHour = (h: number) => () => h;

// Helper: build a usage row from friendly inputs. startSec/durSec are in
// Mac-absolute seconds / seconds.
function row(bundleId: string, startMacSec: number, durSec: number): UsageRow {
  return { bundleId, startMac: startMacSec, endMac: startMacSec + durSec };
}

test("Mac-absolute-time converts to Unix ms with the 2001 epoch offset", () => {
  assert.equal(MAC_EPOCH_OFFSET_SEC, 978_307_200);
  // Mac time 0 == 2001-01-01T00:00:00Z == Unix 978307200s.
  assert.equal(macAbsoluteToUnixMs(0), 978_307_200_000);
  // A known instant: 2024-01-01T00:00:00Z is Unix 1704067200s.
  // Mac seconds = 1704067200 - 978307200 = 725760000.
  assert.equal(macAbsoluteToUnixMs(725_760_000), 1_704_067_200_000);
});

test("Unix ms -> Mac-absolute round-trips", () => {
  const unixMs = 1_704_067_200_000;
  const macSec = unixMsToMacAbsolute(unixMs);
  assert.equal(macSec, 725_760_000);
  assert.equal(macAbsoluteToUnixMs(macSec), unixMs);
});

test("friendlyAppName maps known bundle ids and falls back to last segment", () => {
  assert.equal(friendlyAppName("com.apple.Safari"), "Safari");
  assert.equal(friendlyAppName("com.tinyspeck.slackmacgap"), "Slack");
  assert.equal(friendlyAppName("com.microsoft.VSCode"), "VS Code");
  assert.equal(friendlyAppName("com.apple.dt.Xcode"), "Xcode");
  assert.equal(friendlyAppName("com.apple.MobileSMS"), "Messages");
  // Unknown -> last dotted segment, verbatim.
  assert.equal(friendlyAppName("com.acme.FooBar"), "FooBar");
  // No dots -> whole string.
  assert.equal(friendlyAppName("standalone"), "standalone");
  // Empty -> Unknown, never throws.
  assert.equal(friendlyAppName(""), "Unknown");
});

test("aggregateUsage sums minutes per bundle and counts sessions", () => {
  const rows: UsageRow[] = [
    row("com.apple.dt.Xcode", 1000, 600), // 10 min
    row("com.apple.dt.Xcode", 5000, 1200), // 20 min (later session)
    row("com.tinyspeck.slackmacgap", 8000, 300), // 5 min
  ];
  const agg = aggregateUsage(rows);
  // Xcode dominates -> first.
  assert.equal(agg[0].app, "Xcode");
  assert.equal(agg[0].minutes, 30);
  assert.equal(agg[0].sessions, 2);
  assert.equal(agg[1].app, "Slack");
  assert.equal(agg[1].minutes, 5);
  assert.equal(agg[1].sessions, 1);
  // last-used reflects the latest ZENDDATE (Xcode session 2 ends at 5000+1200).
  assert.equal(agg[0].lastUsedMs, macAbsoluteToUnixMs(6200));
});

test("aggregateUsage drops malformed rows (no bundle id, zero/negative duration)", () => {
  const rows: UsageRow[] = [
    row("", 1000, 600), // no bundle id
    { bundleId: "com.apple.Safari", startMac: 2000, endMac: 2000 }, // zero duration
    { bundleId: "com.apple.Safari", startMac: 5000, endMac: 4000 }, // negative
    row("com.apple.Safari", 6000, 120), // valid: 2 min
  ];
  const agg = aggregateUsage(rows);
  assert.equal(agg.length, 1);
  assert.equal(agg[0].app, "Safari");
  assert.equal(agg[0].minutes, 2);
});

test("activeHoursOf collects distinct local hours of usage starts", () => {
  // Two rows; localHourOf forced to 9 then... we need per-call values, so use a
  // map keyed by startMac.
  const rows: UsageRow[] = [row("com.apple.Safari", 100, 600), row("com.apple.dt.Xcode", 200, 600)];
  const localHourOf = (ms: number) => (ms === macAbsoluteToUnixMs(100) ? 9 : 14);
  const hours = activeHoursOf(rows, localHourOf);
  assert.deepEqual(hours, [9, 14]);
});

test("summarizeUsage: heads-down single app, morning phrasing", () => {
  const rows: UsageRow[] = [row("com.apple.dt.Xcode", 1000, 3600)]; // 60 min
  const s = summarizeUsage(rows, { localHourOf: fixedHour(9) });
  assert.equal(s.totalMinutes, 60);
  assert.deepEqual(s.topApps, [{ app: "Xcode", minutes: 60 }]);
  assert.equal(s.summaryLine, "Heads-down in Xcode this morning.");
});

test("summarizeUsage: two heavy apps + a lighter tail, morning", () => {
  const rows: UsageRow[] = [
    row("com.apple.dt.Xcode", 1000, 3600), // 60 min
    row("com.microsoft.VSCode", 5000, 2400), // 40 min
    row("com.tinyspeck.slackmacgap", 9000, 300), // 5 min
  ];
  const s = summarizeUsage(rows, { localHourOf: fixedHour(10) });
  assert.equal(s.summaryLine, "Heads-down in Xcode + VS Code this morning; some Slack.");
  assert.deepEqual(
    s.topApps.map((a) => a.app),
    ["Xcode", "VS Code", "Slack"],
  );
});

test("summarizeUsage: afternoon spanning into evening -> 'today'", () => {
  const rows: UsageRow[] = [row("com.apple.Safari", 100, 600), row("com.spotify.client", 200, 600)];
  // morning start (8) + evening start (20) -> spans -> "today".
  const localHourOf = (ms: number) => (ms === macAbsoluteToUnixMs(100) ? 8 : 20);
  const s = summarizeUsage(rows, { localHourOf });
  assert.match(s.summaryLine, /today\b/);
  assert.deepEqual(s.activeHours, [8, 20]);
});

test("summarizeUsage: empty input yields an empty summary (no overhead)", () => {
  const s = summarizeUsage([], { localHourOf: fixedHour(9) });
  assert.equal(s.summaryLine, "");
  assert.equal(s.totalMinutes, 0);
  assert.deepEqual(s.topApps, []);
  assert.deepEqual(s.activeHours, []);
  assert.deepEqual(s.apps, []);
});

test("summarizeUsage: all-noise (sub-minute) input yields no summary line", () => {
  // 30 seconds of Finder -> rounds to 0/1 min; minMinutes default 1 filters it.
  const rows: UsageRow[] = [row("com.apple.finder", 1000, 20)];
  const s = summarizeUsage(rows, { localHourOf: fixedHour(11) });
  assert.equal(s.summaryLine, "");
});

test("buildSummaryLine respects minMinutes noise filter", () => {
  const apps = aggregateUsage([
    row("com.apple.dt.Xcode", 1000, 3600), // 60 min
    row("com.apple.finder", 5000, 90), // ~2 min
  ]);
  // minMinutes=5 drops Finder; only Xcode remains.
  assert.equal(buildSummaryLine(apps, [9], 5), "Heads-down in Xcode this morning.");
});

test("usageContextBlock gates on a present summary line and is owner-framed", () => {
  // Empty summary -> empty block (zero prompt overhead).
  assert.equal(usageContextBlock(null), "");
  assert.equal(usageContextBlock({ summaryLine: "" } as never), "");
  const block = usageContextBlock({
    summaryLine: "Heads-down in Xcode this morning.",
  } as never);
  assert.match(block, /owner-only/i);
  assert.match(block, /never share with a contact/i);
  assert.match(block, /Heads-down in Xcode/);
});

test("usageContextBlock accepts a bare summary-line string", () => {
  assert.equal(usageContextBlock(""), "");
  assert.equal(usageContextBlock("   "), "");
  const block = usageContextBlock("Heads-down in VS Code this afternoon.");
  assert.match(block, /owner-only/i);
  assert.match(block, /Heads-down in VS Code/);
});
