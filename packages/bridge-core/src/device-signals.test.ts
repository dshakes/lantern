// Unit tests for the PURE iPhone device-signals logic (parse JSONL + summarize).
// No real fs — lines/signals are mocked, so this runs anywhere.
//
// Coverage:
//   - JSONL line parsing (valid, defaults, bad JSON, missing app/ts, bad kind).
//   - window filtering (stale signals dropped).
//   - per-app grouping + opens count + "mostly X" dominant phrasing.
//   - most-recent ordering in `recent`.
//   - focus / location / now_playing enrichment clauses.
//   - empty / all-stale input -> empty summaryLine.
//   - owner-context block gating + owner-only framing.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  parseSignalLine,
  parseSignals,
  summarizeDeviceSignals,
  deviceContextBlock,
  type DeviceSignal,
} from "./device-signals.ts";

const NOW = 1_700_000_000_000; // fixed "now" for deterministic windows
const min = (n: number) => n * 60 * 1000;

function sig(app: string, kind: DeviceSignal["kind"], agoMin: number, detail?: string): DeviceSignal {
  return { app, kind, detail, ts: NOW - min(agoMin) };
}

// ─── Parsing ─────────────────────────────────────────────────────────────────
test("parseSignalLine parses a valid line and keeps all fields", () => {
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

test("parseSignalLine rejects bad JSON, missing app, and missing/zero ts", () => {
  assert.equal(parseSignalLine("not json {"), null);
  assert.equal(parseSignalLine(""), null);
  assert.equal(parseSignalLine("   "), null);
  assert.equal(parseSignalLine(JSON.stringify({ kind: "app_open", ts: NOW })), null);
  assert.equal(parseSignalLine(JSON.stringify({ app: "X" })), null); // no ts
  assert.equal(parseSignalLine(JSON.stringify({ app: "X", ts: 0 })), null);
  assert.equal(parseSignalLine(JSON.stringify({ app: "X", ts: "soon" })), null);
});

test("parseSignals drops malformed lines and keeps the good ones", () => {
  const lines = [
    JSON.stringify({ app: "Instagram", ts: NOW }),
    "garbage",
    "",
    JSON.stringify({ app: "Slack", kind: "app_open", ts: NOW - 1 }),
    JSON.stringify({ ts: NOW }), // no app
  ];
  const got = parseSignals(lines);
  assert.equal(got.length, 2);
  assert.deepEqual(
    got.map((s) => s.app),
    ["Instagram", "Slack"],
  );
});

// ─── Window filtering ──────────────────────────────────────────────────────--
test("summarizeDeviceSignals drops signals older than the window", () => {
  const signals = [
    sig("Instagram", "app_open", 30),
    sig("Slack", "app_open", 200), // 200 min ago — outside default 2h
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
    sig("Instagram", "app_open", 10),
    sig("Instagram", "app_open", 20),
    sig("Instagram", "app_open", 30),
    sig("Slack", "app_open", 15),
    sig("Maps", "app_open", 5),
  ];
  const out = summarizeDeviceSignals(signals, { nowMs: NOW });
  assert.equal(out.topApps[0].app, "Instagram");
  assert.equal(out.topApps[0].opens, 3);
  assert.match(out.summaryLine, /^On iPhone \(last 2h\):/);
  assert.match(out.summaryLine, /Mostly Instagram/);
  // all three apps present
  for (const a of ["Instagram", "Slack", "Maps"]) assert.match(out.summaryLine, new RegExp(a));
});

test("most-recent signal leads `recent`", () => {
  const signals = [
    sig("Slack", "app_open", 40),
    sig("Maps", "app_open", 2),
    sig("Instagram", "app_open", 20),
  ];
  const out = summarizeDeviceSignals(signals, { nowMs: NOW });
  assert.equal(out.recent[0].app, "Maps"); // 2 min ago is newest
});

// ─── Ambient enrichers ─────────────────────────────────────────────────────--
test("location, focus and now_playing enrich the line and don't count as opens", () => {
  const signals = [
    sig("Instagram", "app_open", 10),
    sig("Home", "location", 5, "Home"),
    sig("Work", "focus", 8, "Work"),
    sig("Spotify", "now_playing", 3, "Lo-fi beats"),
  ];
  const out = summarizeDeviceSignals(signals, { nowMs: NOW });
  // Only the app_open counts as a top app.
  assert.deepEqual(
    out.topApps.map((a) => a.app),
    ["Instagram"],
  );
  assert.match(out.summaryLine, /at Home/);
  assert.match(out.summaryLine, /Work focus on/);
  assert.match(out.summaryLine, /playing Lo-fi beats/);
});

test("ambient-only signals still produce a line (no app opens)", () => {
  const signals = [sig("Home", "location", 5, "Home")];
  const out = summarizeDeviceSignals(signals, { nowMs: NOW });
  assert.equal(out.topApps.length, 0);
  assert.match(out.summaryLine, /at Home/);
});

// ─── Empty ─────────────────────────────────────────────────────────────────--
test("empty input yields an empty summary line", () => {
  const out = summarizeDeviceSignals([], { nowMs: NOW });
  assert.equal(out.summaryLine, "");
  assert.equal(out.topApps.length, 0);
  assert.equal(out.recent.length, 0);
});

test("all-stale input yields an empty summary line", () => {
  const out = summarizeDeviceSignals([sig("Instagram", "app_open", 999)], { nowMs: NOW });
  assert.equal(out.summaryLine, "");
});

test("custom window label reflects a shorter lookback", () => {
  const out = summarizeDeviceSignals([sig("Slack", "app_open", 10)], {
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
  const out = summarizeDeviceSignals([sig("Slack", "app_open", 10)], { nowMs: NOW });
  const block = deviceContextBlock(out);
  assert.match(block, /Slack/);
});
