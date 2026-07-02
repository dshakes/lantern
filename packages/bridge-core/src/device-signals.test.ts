// Unit tests for the PURE iPhone device-signals logic (parse JSONL + summarize).
// No real fs — lines/signals are mocked, so this runs anywhere.
//
// Coverage:
//   - JSONL line parsing (valid, defaults, bad JSON, missing app/ts, bad kind,
//     appless ambient kinds, health metric/value, bare rhythm markers).
//   - window filtering (stale signals dropped).
//   - per-app grouping + opens count + "mostly X" dominant phrasing.
//   - most-recent ordering in `recent`.
//   - composite line: app + location + focus + device + health + media.
//   - latest-wins per category for location / focus.
//   - health formatting: steps (6200 -> "6.2k steps"), sleep (-> "slept Xh"),
//     workout (metric or detail-only).
//   - empty / all-stale input -> empty summaryLine.
//   - owner-context block gating + owner-only framing.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  parseSignalLine,
  parseSignals,
  summarizeDeviceSignals,
  deviceContextBlock,
  presenceFromSignals,
  latestKnownLocation,
  formatOwnerLocationBlock,
  isInnerCircle,
  type DeviceSignal,
} from "./device-signals.ts";

const NOW = 1_700_000_000_000; // fixed "now" for deterministic windows
const min = (n: number) => n * 60 * 1000;

/** Build a signal `agoMin` minutes before NOW. Extra fields (detail/metric/
 *  value/app) are spread in so ambient + health signals are easy to express. */
function sig(
  kind: DeviceSignal["kind"],
  agoMin: number,
  extra: Partial<DeviceSignal> = {},
): DeviceSignal {
  return { kind, ts: NOW - min(agoMin), ...extra };
}

/** Shorthand for an app_open signal (the common case). */
function app(name: string, agoMin: number): DeviceSignal {
  return sig("app_open", agoMin, { app: name });
}

// ─── Parsing ─────────────────────────────────────────────────────────────────
test("parseSignalLine parses a valid app_open line and keeps all fields", () => {
  const s = parseSignalLine(
    JSON.stringify({ app: "Instagram", kind: "app_open", detail: "feed", ts: NOW }),
  );
  assert.deepEqual(s, { app: "Instagram", kind: "app_open", detail: "feed", ts: NOW });
});

test("parseSignalLine defaults kind to app_open and trims app", () => {
  const s = parseSignalLine(JSON.stringify({ app: "  Slack  ", ts: NOW }));
  assert.equal(s?.app, "Slack");
  assert.equal(s?.kind, "app_open");
  assert.equal(s?.detail, undefined);
});

test("parseSignalLine coerces an unknown kind back to app_open", () => {
  const s = parseSignalLine(JSON.stringify({ app: "Maps", kind: "teleport", ts: NOW }));
  assert.equal(s?.kind, "app_open");
});

test("parseSignalLine rejects bad JSON, missing app on app_open, and missing/zero ts", () => {
  assert.equal(parseSignalLine("not json {"), null);
  assert.equal(parseSignalLine(""), null);
  assert.equal(parseSignalLine("   "), null);
  assert.equal(parseSignalLine(JSON.stringify({ kind: "app_open", ts: NOW })), null); // no app
  assert.equal(parseSignalLine(JSON.stringify({ app: "X" })), null); // no ts
  assert.equal(parseSignalLine(JSON.stringify({ app: "X", ts: 0 })), null);
  assert.equal(parseSignalLine(JSON.stringify({ app: "X", ts: "soon" })), null);
});

test("parseSignalLine parses appless ambient kinds via detail", () => {
  const loc = parseSignalLine(JSON.stringify({ kind: "location", detail: "Home", ts: NOW }));
  assert.deepEqual(loc, { kind: "location", detail: "Home", ts: NOW });

  const focus = parseSignalLine(JSON.stringify({ kind: "focus", detail: "Work", ts: NOW }));
  assert.deepEqual(focus, { kind: "focus", detail: "Work", ts: NOW });

  const dev = parseSignalLine(JSON.stringify({ kind: "device", detail: "CarPlay", ts: NOW }));
  assert.deepEqual(dev, { kind: "device", detail: "CarPlay", ts: NOW });

  const np = parseSignalLine(
    JSON.stringify({ kind: "now_playing", detail: "Song - Artist", ts: NOW }),
  );
  assert.deepEqual(np, { kind: "now_playing", detail: "Song - Artist", ts: NOW });
});

test("parseSignalLine parses health metric/value and drops a bad metric", () => {
  const steps = parseSignalLine(
    JSON.stringify({ kind: "health", metric: "steps", value: 6200, ts: NOW }),
  );
  assert.deepEqual(steps, { kind: "health", metric: "steps", value: 6200, ts: NOW });

  // detail-only health (workout) is allowed.
  const ran = parseSignalLine(JSON.stringify({ kind: "health", detail: "ran 3mi", ts: NOW }));
  assert.deepEqual(ran, { kind: "health", detail: "ran 3mi", ts: NOW });

  // unknown metric is stripped; with no detail/value left, the line is dropped.
  assert.equal(
    parseSignalLine(JSON.stringify({ kind: "health", metric: "heartrate", ts: NOW })),
    null,
  );
});

test("parseSignalLine accepts bare rhythm markers with no payload", () => {
  assert.deepEqual(parseSignalLine(JSON.stringify({ kind: "wake", ts: NOW })), {
    kind: "wake",
    ts: NOW,
  });
  assert.deepEqual(parseSignalLine(JSON.stringify({ kind: "sleep", ts: NOW })), {
    kind: "sleep",
    ts: NOW,
  });
  assert.deepEqual(parseSignalLine(JSON.stringify({ kind: "screenshot", ts: NOW })), {
    kind: "screenshot",
    ts: NOW,
  });
});

test("parseSignalLine drops an ambient kind with no payload", () => {
  assert.equal(parseSignalLine(JSON.stringify({ kind: "location", ts: NOW })), null);
  assert.equal(parseSignalLine(JSON.stringify({ kind: "focus", ts: NOW })), null);
});

test("parseSignals drops malformed lines and keeps the good ones", () => {
  const lines = [
    JSON.stringify({ app: "Instagram", ts: NOW }),
    "garbage",
    "",
    JSON.stringify({ app: "Slack", kind: "app_open", ts: NOW - 1 }),
    JSON.stringify({ ts: NOW }), // no app
    JSON.stringify({ kind: "location", detail: "Home", ts: NOW }),
  ];
  const got = parseSignals(lines);
  assert.equal(got.length, 3);
  assert.deepEqual(
    got.map((s) => s.app ?? s.detail),
    ["Instagram", "Slack", "Home"],
  );
});

// ─── Window filtering ──────────────────────────────────────────────────────--
test("summarizeDeviceSignals drops signals older than the window", () => {
  const signals = [
    app("Instagram", 30),
    app("Slack", 200), // 200 min ago — outside default 2h
  ];
  const out = summarizeDeviceSignals(signals, { nowMs: NOW });
  assert.deepEqual(
    out.topApps.map((a) => a.app),
    ["Instagram"],
  );
  assert.match(out.summaryLine, /Instagram/);
  assert.doesNotMatch(out.summaryLine, /Slack/);
});

// ─── Grouping + dominant phrasing ──────────────────────────────────────────--
test("summarizeDeviceSignals groups by app, counts opens, and notes the dominant app", () => {
  const signals = [
    app("Instagram", 10),
    app("Instagram", 20),
    app("Instagram", 30),
    app("Slack", 15),
    app("Maps", 5),
  ];
  const out = summarizeDeviceSignals(signals, { nowMs: NOW });
  assert.equal(out.topApps[0].app, "Instagram");
  assert.equal(out.topApps[0].opens, 3);
  assert.match(out.summaryLine, /^On iPhone \(last 2h\):/);
  assert.match(out.summaryLine, /Mostly Instagram/);
  // all three apps present
  for (const a of ["Instagram", "Slack", "Maps"]) assert.match(out.summaryLine, new RegExp(a));
});

test("only-app-opens still produces the classic line", () => {
  const out = summarizeDeviceSignals([app("YouTube", 5), app("LinkedIn", 8)], { nowMs: NOW });
  assert.equal(out.summaryLine, "On iPhone (last 2h): YouTube, LinkedIn.");
});

test("most-recent signal leads `recent`", () => {
  const signals = [app("Slack", 40), app("Maps", 2), app("Instagram", 20)];
  const out = summarizeDeviceSignals(signals, { nowMs: NOW });
  assert.equal(out.recent[0].app, "Maps"); // 2 min ago is newest
});

// ─── Composite line (the headline feature) ─────────────────────────────────--
test("mixed-kind input produces a composite line: app + location + focus + device + health + media", () => {
  const signals = [
    app("YouTube", 12),
    app("LinkedIn", 8),
    sig("location", 6, { detail: "Home" }),
    sig("focus", 10, { detail: "Work" }),
    sig("device", 4, { detail: "charging" }),
    sig("health", 30, { metric: "steps", value: 6200 }),
    sig("now_playing", 2, { detail: "Hardcore History" }),
  ];
  const out = summarizeDeviceSignals(signals, { nowMs: NOW });
  // Apps lead (both present); each enricher follows after the " — " divider.
  assert.match(out.summaryLine, /^On iPhone \(last 2h\): (YouTube, LinkedIn|LinkedIn, YouTube) —/);
  assert.match(out.summaryLine, /at Home/);
  assert.match(out.summaryLine, /Work focus/);
  assert.match(out.summaryLine, /charging/);
  assert.match(out.summaryLine, /6\.2k steps/);
  assert.match(out.summaryLine, /playing Hardcore History/);
  // ambient kinds never become top apps (only the two app_opens, any order)
  assert.deepEqual(
    out.topApps.map((a) => a.app).sort(),
    ["LinkedIn", "YouTube"],
  );
});

test("CarPlay device state reads as driving", () => {
  const out = summarizeDeviceSignals([app("Maps", 5), sig("device", 3, { detail: "CarPlay" })], {
    nowMs: NOW,
  });
  assert.match(out.summaryLine, /driving/);
  assert.doesNotMatch(out.summaryLine, /CarPlay/);
});

test("focus 'off' is skipped", () => {
  const out = summarizeDeviceSignals([app("Slack", 5), sig("focus", 3, { detail: "off" })], {
    nowMs: NOW,
  });
  assert.doesNotMatch(out.summaryLine, /focus/);
});

// ─── Latest-wins per category ──────────────────────────────────────────────--
test("location uses the LATEST detail (latest-wins)", () => {
  const signals = [
    sig("location", 40, { detail: "Office" }),
    sig("location", 3, { detail: "Home" }), // newer
  ];
  const out = summarizeDeviceSignals(signals, { nowMs: NOW });
  assert.match(out.summaryLine, /at Home/);
  assert.doesNotMatch(out.summaryLine, /Office/);
});

test("focus uses the LATEST mode (latest-wins)", () => {
  const signals = [
    sig("focus", 40, { detail: "Sleep" }),
    sig("focus", 3, { detail: "Work" }), // newer
  ];
  const out = summarizeDeviceSignals(signals, { nowMs: NOW });
  assert.match(out.summaryLine, /Work focus/);
  assert.doesNotMatch(out.summaryLine, /Sleep/);
});

// ─── Health formatting ─────────────────────────────────────────────────────--
test("health steps formats 6200 -> '6.2k steps' and a round 10000 -> '10k steps'", () => {
  const out1 = summarizeDeviceSignals([sig("health", 5, { metric: "steps", value: 6200 })], {
    nowMs: NOW,
  });
  assert.match(out1.summaryLine, /6\.2k steps/);

  const out2 = summarizeDeviceSignals([sig("health", 5, { metric: "steps", value: 10000 })], {
    nowMs: NOW,
  });
  assert.match(out2.summaryLine, /10k steps/);

  const out3 = summarizeDeviceSignals([sig("health", 5, { metric: "steps", value: 850 })], {
    nowMs: NOW,
  });
  assert.match(out3.summaryLine, /850 steps/);
});

test("health sleep formats value -> 'slept Xh'", () => {
  const out = summarizeDeviceSignals([sig("health", 5, { metric: "sleep", value: 6.5 })], {
    nowMs: NOW,
  });
  assert.match(out.summaryLine, /slept 6\.5h/);

  const round = summarizeDeviceSignals([sig("health", 5, { metric: "sleep", value: 8 })], {
    nowMs: NOW,
  });
  assert.match(round.summaryLine, /slept 8h/);
});

test("health workout uses metric:'workout' detail, and a detail-only health line", () => {
  const metricWorkout = summarizeDeviceSignals(
    [sig("health", 5, { metric: "workout", detail: "ran 3mi" })],
    { nowMs: NOW },
  );
  assert.match(metricWorkout.summaryLine, /ran 3mi/);

  const detailWorkout = summarizeDeviceSignals([sig("health", 5, { detail: "ran 3mi" })], {
    nowMs: NOW,
  });
  assert.match(detailWorkout.summaryLine, /ran 3mi/);
});

// ─── Ambient-only ──────────────────────────────────────────────────────────--
test("ambient-only signals still produce a line (no app opens)", () => {
  const out = summarizeDeviceSignals([sig("location", 5, { detail: "Home" })], { nowMs: NOW });
  assert.equal(out.topApps.length, 0);
  assert.match(out.summaryLine, /^On iPhone \(last 2h\): at Home\.$/);
});

// ─── Empty ─────────────────────────────────────────────────────────────────--
test("empty input yields an empty summary line", () => {
  const out = summarizeDeviceSignals([], { nowMs: NOW });
  assert.equal(out.summaryLine, "");
  assert.equal(out.topApps.length, 0);
  assert.equal(out.recent.length, 0);
});

test("all-stale input yields an empty summary line", () => {
  const out = summarizeDeviceSignals([app("Instagram", 999)], { nowMs: NOW });
  assert.equal(out.summaryLine, "");
});

test("custom window label reflects a shorter lookback", () => {
  const out = summarizeDeviceSignals([app("Slack", 10)], {
    nowMs: NOW,
    windowMs: min(30),
  });
  assert.match(out.summaryLine, /last 30m/);
});

// ─── Owner-context block ───────────────────────────────────────────────────--
test("deviceContextBlock gates on a present summary line and is owner-framed", () => {
  assert.equal(deviceContextBlock(""), "");
  assert.equal(deviceContextBlock(null), "");
  assert.equal(deviceContextBlock({ summaryLine: "" } as never), "");
  const block = deviceContextBlock("On iPhone (last 2h): Instagram. Mostly Instagram.");
  assert.match(block, /Owner iPhone activity/);
  assert.match(block, /owner-only/i);
  assert.match(block, /never reveal it to anyone but the owner/i);
  assert.match(block, /Instagram/);
});

test("deviceContextBlock accepts a full summary object", () => {
  const out = summarizeDeviceSignals([app("Slack", 10)], { nowMs: NOW });
  const block = deviceContextBlock(out);
  assert.match(block, /Slack/);
});

// ─── presenceFromSignals (contact-facing availability) ───────────────────────
test("presenceFromSignals: device driving (CarPlay / car Bluetooth) → driving, away", () => {
  const p = presenceFromSignals([sig("device", 5, { detail: "driving" })], { nowMs: NOW });
  assert.equal(p?.state, "driving");
  assert.equal(p?.away, true);
  assert.match(p!.line, /driving/i);
});

test("presenceFromSignals: CarPlay detail also maps to driving", () => {
  const p = presenceFromSignals([sig("device", 5, { detail: "CarPlay" })], { nowMs: NOW });
  assert.equal(p?.state, "driving");
});

test("presenceFromSignals: focus DND / Sleep / Available / Busy", () => {
  assert.equal(presenceFromSignals([sig("focus", 2, { detail: "DND" })], { nowMs: NOW })?.state, "dnd");
  assert.equal(presenceFromSignals([sig("focus", 2, { detail: "Sleep" })], { nowMs: NOW })?.state, "sleep");
  const free = presenceFromSignals([sig("focus", 2, { detail: "Available" })], { nowMs: NOW });
  assert.equal(free?.state, "free");
  assert.equal(free?.away, false);
  assert.equal(presenceFromSignals([sig("focus", 2, { detail: "Busy" })], { nowMs: NOW })?.state, "busy");
});

test("presenceFromSignals: fresh driving beats an OLDER focus signal", () => {
  // driving is the NEWER signal (1m) vs focus Busy (3m) → driving wins.
  const p = presenceFromSignals(
    [sig("focus", 3, { detail: "Busy" }), sig("device", 1, { detail: "driving" })],
    { nowMs: NOW },
  );
  assert.equal(p?.state, "driving");
});

// ── Regression: the "I'm home but bot says driving" blunder ──────────────────
test("presenceFromSignals: STALE driving (>30m, in 2h window) no longer says driving", () => {
  // 45m-old driving signal, nothing newer → must NOT claim 'driving right now'.
  const p = presenceFromSignals([sig("device", 45, { detail: "driving" })], { nowMs: NOW });
  assert.notEqual(p?.state, "driving");
});

test("presenceFromSignals: arriving home (newer location) clears a recent driving", () => {
  // drove 10m ago, then a location:Home signal 2m ago → home supersedes driving.
  // location:Home maps to null (not an availability signal) — and crucially NOT driving.
  const p = presenceFromSignals(
    [sig("device", 10, { detail: "driving" }), sig("location", 2, { detail: "Home" })],
    { nowMs: NOW },
  );
  assert.equal(p, null);
});

test("presenceFromSignals: Parked/Available (newer focus) clears driving → free", () => {
  // drove 10m ago, then tapped Lantern-Parked (focus:Available) 1m ago.
  const p = presenceFromSignals(
    [sig("device", 10, { detail: "driving" }), sig("focus", 1, { detail: "Available" })],
    { nowMs: NOW },
  );
  assert.equal(p?.state, "free");
  assert.equal(p?.away, false);
});

test("presenceFromSignals: geofence maps to coarse availability and NEVER leaks the place", () => {
  const gym = presenceFromSignals([sig("location", 4, { detail: "Gym" })], { nowMs: NOW });
  assert.equal(gym?.state, "busy");
  assert.doesNotMatch(gym!.line, /gym/i); // place name never echoed
  const air = presenceFromSignals([sig("location", 4, { detail: "Airport" })], { nowMs: NOW });
  assert.equal(air?.state, "busy");
  assert.doesNotMatch(air!.line, /airport/i);
  // Home is not an availability signal.
  assert.equal(presenceFromSignals([sig("location", 4, { detail: "Home" })], { nowMs: NOW }), null);
});

test("presenceFromSignals: a named Focus is never echoed verbatim (no whereabouts leak)", () => {
  const p = presenceFromSignals([sig("focus", 2, { detail: "Poolville cabin" })], { nowMs: NOW });
  assert.equal(p?.state, "busy");
  assert.doesNotMatch(p!.line, /poolville|cabin/i);
});

test("presenceFromSignals: no usable signal, stale signal, and empty → null", () => {
  assert.equal(presenceFromSignals([app("YouTube", 5)], { nowMs: NOW }), null); // app_open isn't presence
  assert.equal(presenceFromSignals([sig("device", 600, { detail: "driving" })], { nowMs: NOW }), null); // 10h stale
  assert.equal(presenceFromSignals([], { nowMs: NOW }), null);
});

// ─── latestKnownLocation + inner-circle + block (truthful spouse location) ───
test("latestKnownLocation: returns the real place within window; null when stale/absent", () => {
  assert.deepEqual(
    latestKnownLocation([sig("location", 30, { detail: "Office" })], { nowMs: NOW }),
    { place: "the office", inTransit: false, ageMin: 30 },
  );
  // Home label
  assert.equal(latestKnownLocation([sig("location", 10, { detail: "Home" })], { nowMs: NOW })?.place, "home");
  // Fresh driving newer than any location → in transit
  const t = latestKnownLocation(
    [sig("location", 40, { detail: "Office" }), sig("device", 5, { detail: "driving" })],
    { nowMs: NOW },
  );
  assert.equal(t?.inTransit, true);
  // Stale (8h) location → null (no fabrication)
  assert.equal(latestKnownLocation([sig("location", 480, { detail: "Office" })], { nowMs: NOW }), null);
  assert.equal(latestKnownLocation([], { nowMs: NOW }), null);

  // THE SWIMMING-POOL BUG: drove somewhere 20 min ago, parked + went inside, no
  // newer signal → must NOT say "on the road" (driving is stale). Honest unknown.
  assert.equal(
    latestKnownLocation([sig("device", 20, { detail: "driving" })], { nowMs: NOW }),
    null,
  );
  // Drove AWAY from a known place (driving newer than the geofence) then quiet →
  // the old place is stale (owner left it), do NOT serve it → null.
  assert.equal(
    latestKnownLocation(
      [sig("location", 90, { detail: "Home" }), sig("device", 18, { detail: "driving" })],
      { nowMs: NOW },
    ),
    null,
  );
  // Arrived: a geofence NEWER than the last driving signal → that place (arrived,
  // not driving).
  assert.equal(
    latestKnownLocation(
      [sig("device", 30, { detail: "driving" }), sig("location", 8, { detail: "Gym" })],
      { nowMs: NOW },
    )?.place,
    "the gym",
  );

  // CONNECTIVITY CONSUMPTION (iPhone posts these):
  // "parked" (CarPlay disconnected) newer than a fresh driving → NOT on the road
  // (driving ended); no destination geofence → honest unknown.
  assert.equal(
    latestKnownLocation(
      [sig("device", 6, { detail: "driving" }), sig("device", 2, { detail: "parked" })],
      { nowMs: NOW },
    ),
    null,
  );
  // Existing Lantern-Status-Available shortcut on CarPlay-Disconnect: a newer
  // focus:Available ENDS driving (parked) → not on the road; no place → unknown.
  assert.equal(
    latestKnownLocation(
      [sig("device", 5, { detail: "driving" }), sig("focus", 2, { detail: "Available" })],
      { nowMs: NOW },
    ),
    null,
  );
  // "left home" (off home wifi) newest → OUT (not home), exact spot unknown.
  assert.equal(
    latestKnownLocation([sig("device", 5, { detail: "left home" })], { nowMs: NOW })?.place,
    "out",
  );
  // home wifi connect (location:Home) newest → home.
  assert.equal(
    latestKnownLocation(
      [sig("device", 20, { detail: "left home" }), sig("location", 3, { detail: "Home" })],
      { nowMs: NOW },
    )?.place,
    "home",
  );
});

test("isInnerCircle: spouse + kids + siblings + family true; acquaintances false", () => {
  for (const r of ["wife", "husband", "spouse", "son", "daughter", "elder brother", "sister", "sister-in-law", "brother's wife"])
    assert.equal(isInnerCircle(r), true, r);
  for (const r of ["college friend", "manager", "dentist", "vendor", "friend", "", undefined])
    assert.equal(isInnerCircle(r as string), false, String(r));
});

test("formatOwnerLocationBlock: truth when shareable+known; honest-unknown when shareable+null; deflect when not shareable — never fabricate in any case", () => {
  // inner-circle + fresh signal → share the real place
  const known = formatOwnerLocationBlock({ place: "the office", inTransit: false, ageMin: 12 }, "Shekhar", "Manasa", true);
  assert.match(known, /at the office/);
  assert.match(known, /TRUE/);
  assert.match(known, /NEVER invent/i);
  // inner-circle but no signal → honest "unknown", never guess
  const unknown = formatOwnerLocationBlock(null, "Shekhar", "Manasa", true);
  assert.match(unknown, /UNKNOWN/);
  assert.match(unknown, /NEVER invent/i);
  // non-inner-circle → do not disclose, never fabricate (this is the work-number case)
  const deflect = formatOwnerLocationBlock({ place: "home", inTransit: false, ageMin: 3 }, "Shekhar", "a coworker", false);
  assert.match(deflect, /do NOT disclose/i);
  assert.doesNotMatch(deflect, /at home/); // must not leak the place
  assert.match(deflect, /NEVER invent/i);
});
