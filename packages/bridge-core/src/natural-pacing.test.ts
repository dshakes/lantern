// Tests for natural.ts pacing realism: short-reply typing floor and
// away-lag suppression mid-active-burst. awayLagMs/typingDurationMs are
// private, so we exercise them through the public `naturalize`. Values
// are jittered, so we assert direction + bounds over many runs.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { naturalize, inferStyle } from "./natural.ts";

const STYLE = inferStyle([]); // neutral default profile

// readDelayMs is capped at 8000ms; the away lag adds 3000-8000ms on top.
// So a first-message delay > 8000ms can ONLY come from an away lag.
const READ_DELAY_CEIL = 8_000;

test("short one-word reply gets a sub-1.2s typing floor", () => {
  // "ok" is 1 word → short floor (600ms), not the 1200ms default.
  let min = Infinity;
  for (let i = 0; i < 300; i++) {
    const burst = naturalize("ok", { inbound: "you good?", style: STYLE });
    assert.equal(burst.length, 1);
    min = Math.min(min, burst[0].typingMs);
  }
  assert.ok(min >= 600, `floor should be >= 600, got ${min}`);
  assert.ok(min < 1_200, `short reply should dip below 1200ms floor, got min ${min}`);
});

test("longer reply keeps the standard 1.2s typing floor", () => {
  let min = Infinity;
  for (let i = 0; i < 300; i++) {
    const burst = naturalize(
      "yeah that works for me let us plan on it",
      { inbound: "wanna meet?", style: STYLE },
    );
    min = Math.min(min, burst[0].typingMs);
  }
  assert.ok(min >= 1_200, `long reply floor should stay >= 1200, got min ${min}`);
});

test("away lag is suppressed when inbound is fresh (< 60s)", () => {
  let max = 0;
  for (let i = 0; i < 500; i++) {
    const burst = naturalize("sure", {
      inbound: "you around?",
      style: STYLE,
      pace: { msSinceLastInbound: 5_000, isActiveBurst: false },
    });
    max = Math.max(max, burst[0].delayBeforeMs);
  }
  assert.ok(
    max <= READ_DELAY_CEIL,
    `live thread should never add away lag; max first delay ${max} exceeds read ceil`,
  );
});

test("away lag is suppressed mid active burst", () => {
  let max = 0;
  for (let i = 0; i < 500; i++) {
    const burst = naturalize("haha yeah", {
      inbound: "did you see that?",
      style: STYLE,
      pace: { isActiveBurst: true, msSinceLastInbound: 120_000 },
    });
    max = Math.max(max, burst[0].delayBeforeMs);
  }
  assert.ok(max <= READ_DELAY_CEIL, `active burst should suppress away lag; max ${max}`);
});

test("away lag still fires (sometimes) on a cold/no-hint reply", () => {
  // No pace hint → legacy 30% away-lag chance. Over 500 runs the first
  // delay should at least sometimes exceed the read-delay ceiling.
  let exceeded = 0;
  for (let i = 0; i < 500; i++) {
    const burst = naturalize("hey, been a while", {
      inbound: "you there?",
      style: STYLE,
    });
    if (burst[0].delayBeforeMs > READ_DELAY_CEIL) exceeded++;
  }
  assert.ok(exceeded > 0, "expected some away lags on cold replies");
});

test("stale inbound + not active burst still allows away lag", () => {
  let exceeded = 0;
  for (let i = 0; i < 500; i++) {
    const burst = naturalize("hey sorry", {
      inbound: "ping",
      style: STYLE,
      pace: { msSinceLastInbound: 10 * 60_000, isActiveBurst: false },
    });
    if (burst[0].delayBeforeMs > READ_DELAY_CEIL) exceeded++;
  }
  assert.ok(exceeded > 0, "stale, non-burst threads should still allow away lag");
});
