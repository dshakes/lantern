// Tests for the A5 verbatim-sample recency window in per-contact-style.ts.
//   cd packages/bridge-core && npx tsx --test src/per-contact-style-recency.test.ts
//
// The window applies to VERBATIM few-shot samples only — statistical
// features stay on the fuller set for stability — and gates gracefully
// when timestamps are missing.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeContactStyle } from "./per-contact-style.ts";

const NOW = Date.UTC(2026, 0, 1); // fixed reference now
const DAY = 24 * 60 * 60 * 1000;

test("A5: stale messages are excluded from verbatim samples", () => {
  const messages = [
    "yo dawg what is up with you", // old register (300 days ago)
    "ayy hommie that is wild fr fr", // old register (250 days ago)
    "hey want to grab coffee tomorrow", // recent (10 days ago)
    "sounds good see you then man", // recent (5 days ago)
  ];
  const timestamps = [
    NOW - 300 * DAY,
    NOW - 250 * DAY,
    NOW - 10 * DAY,
    NOW - 5 * DAY,
  ];
  const style = computeContactStyle(messages, {
    timestamps,
    now: NOW,
    verbatimWindowDays: 180,
  });

  const joined = style.verbatimSamples.join(" | ");
  assert.ok(joined.includes("grab coffee tomorrow"), "recent sample kept");
  assert.ok(joined.includes("see you then"), "recent sample kept");
  assert.ok(!joined.includes("yo dawg"), "stale sample excluded");
  assert.ok(!joined.includes("hommie"), "stale sample excluded");
});

test("A5: statistical features still use the FULL set (stability)", () => {
  const messages = [
    "yo dawg what is up with you", // old, 6 words
    "ayy hommie that is wild fr fr", // old, 7 words
    "hey want to grab coffee tomorrow", // recent
    "sounds good see you then man", // recent
  ];
  const timestamps = [NOW - 300 * DAY, NOW - 250 * DAY, NOW - 10 * DAY, NOW - 5 * DAY];

  const windowed = computeContactStyle(messages, { timestamps, now: NOW });
  const full = computeContactStyle(messages);

  // sampleCount + avgWords are computed over ALL surviving messages, so the
  // recency window must not change them.
  assert.equal(windowed.sampleCount, full.sampleCount, "sampleCount unchanged");
  assert.equal(
    windowed.avgWords.toFixed(3),
    full.avgWords.toFixed(3),
    "avgWords unchanged by verbatim window",
  );
});

test("A5: missing timestamps gate gracefully (use what's available)", () => {
  const messages = [
    "hey want to grab coffee tomorrow",
    "sounds good see you then man",
    "lol that was a fun trip honestly",
  ];
  // No timestamps at all → behave like the legacy path.
  const noTs = computeContactStyle(messages, { now: NOW });
  const legacy = computeContactStyle(messages);
  assert.deepEqual(
    noTs.verbatimSamples,
    legacy.verbatimSamples,
    "no-timestamp path matches legacy",
  );
});

test("A5: per-message undefined timestamp is treated as recent (kept)", () => {
  const messages = [
    "hey want to grab coffee tomorrow", // undefined ts → kept
    "this one is really really old register", // explicitly old → dropped
  ];
  const timestamps = [undefined, NOW - 400 * DAY];
  const style = computeContactStyle(messages, { timestamps, now: NOW });
  const joined = style.verbatimSamples.join(" | ");
  assert.ok(joined.includes("grab coffee tomorrow"), "undefined-ts message kept");
  assert.ok(!joined.includes("old register"), "explicitly-old message dropped");
});

test("A5: configurable window", () => {
  const messages = [
    "hey want to grab coffee tomorrow", // 90 days ago
    "sounds good see you then man", // 30 days ago
  ];
  const timestamps = [NOW - 90 * DAY, NOW - 30 * DAY];

  // Tight 60-day window drops the 90-day-old message.
  const tight = computeContactStyle(messages, {
    timestamps,
    now: NOW,
    verbatimWindowDays: 60,
  });
  const tightJoined = tight.verbatimSamples.join(" | ");
  assert.ok(!tightJoined.includes("grab coffee"), "90d msg dropped by 60d window");
  assert.ok(tightJoined.includes("see you then"), "30d msg kept by 60d window");

  // Wide 180-day window keeps both.
  const wide = computeContactStyle(messages, {
    timestamps,
    now: NOW,
    verbatimWindowDays: 180,
  });
  assert.equal(wide.verbatimSamples.length, 2, "both kept by 180d window");
});

test("A5: default call (no options) is unchanged — backward compatible", () => {
  const messages = ["hey want to grab coffee tomorrow", "sounds good see you then"];
  const style = computeContactStyle(messages);
  assert.equal(style.verbatimSamples.length, 2);
});
