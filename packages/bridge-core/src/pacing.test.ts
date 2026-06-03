// Tests for human-presence pacing realism. North star: a recipient must
// never sense machine-generated timing. We assert DIRECTION and BOUNDS
// (not exact ms — values are jittered), plus the real-sample median path
// and its safe small-sample fallback.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  computeHold,
  computeHoldFromSamples,
  latenciesFromSamples,
  timeOfDayMultiplier,
  MIN_REAL_SAMPLES,
  type LatencySample,
} from "./pacing.ts";

// ---------------------------------------------------------------------------
// Time-of-day multiplier — direction + bounds
// ---------------------------------------------------------------------------

test("timeOfDayMultiplier: peak midday is quicker than evening", () => {
  const midday = timeOfDayMultiplier(13);
  const evening = timeOfDayMultiplier(22);
  assert.ok(midday < 1.0, `midday should be < 1.0, got ${midday}`);
  assert.ok(evening > 1.0, `evening should be > 1.0, got ${evening}`);
  assert.ok(midday < evening, "midday must be faster than evening");
});

test("timeOfDayMultiplier: bounded to [0.7, 1.5] across all 24 hours", () => {
  for (let h = 0; h < 24; h++) {
    const m = timeOfDayMultiplier(h);
    assert.ok(m >= 0.7 && m <= 1.5, `hour ${h} → ${m} out of bounds`);
  }
});

test("timeOfDayMultiplier: omitted/invalid hour is neutral (1.0)", () => {
  assert.equal(timeOfDayMultiplier(undefined), 1.0);
  assert.equal(timeOfDayMultiplier(NaN), 1.0);
});

test("timeOfDayMultiplier: peak hours all return the fast multiplier", () => {
  for (const h of [10, 12, 15]) {
    assert.equal(timeOfDayMultiplier(h), 0.7, `hour ${h}`);
  }
});

test("computeHold: evening holds longer than midday for the same samples", () => {
  // Average over several runs to wash out ±20% jitter.
  const samples = [8000, 9000, 10000, 11000, 12000];
  const avg = (localHour: number) => {
    let sum = 0;
    for (let i = 0; i < 200; i++) {
      sum += computeHold({
        ownerLatencies: samples,
        msSinceLastInbound: 5 * 60_000,
        isActiveBurst: false,
        localHour,
      }).holdMs;
    }
    return sum / 200;
  };
  const midday = avg(13);
  const evening = avg(22);
  assert.ok(evening > midday, `evening ${evening} should exceed midday ${midday}`);
});

// ---------------------------------------------------------------------------
// Real-sample median path
// ---------------------------------------------------------------------------

test("latenciesFromSamples: derives gaps from real (inbound,reply) pairs", () => {
  const samples: LatencySample[] = [
    { inboundTs: 1_000, replyTs: 4_000 }, // 3s
    { inboundTs: 10_000, replyTs: 15_000 }, // 5s
    { inboundTs: 20_000, replyTs: 21_000 }, // 1s
  ];
  const gaps = latenciesFromSamples(samples);
  assert.deepEqual(gaps.sort((a, b) => a - b), [1_000, 3_000, 5_000]);
});

test("latenciesFromSamples: drops overnight (>4h) and non-positive gaps", () => {
  const samples: LatencySample[] = [
    { inboundTs: 0, replyTs: 5 * 60 * 60_000 }, // 5h — dropped
    { inboundTs: 100, replyTs: 50 }, // negative — dropped
    { inboundTs: 0, replyTs: 2_000 }, // 2s — kept
  ];
  assert.deepEqual(latenciesFromSamples(samples), [2_000]);
});

test("computeHoldFromSamples: uses median of real samples (not fabricated noise)", () => {
  // Five genuine ~10s latencies. Normal path is median × 0.8 = ~8s before
  // jitter, well above the no-data default (~1.8s). Average over runs.
  const samples: LatencySample[] = [
    { inboundTs: 0, replyTs: 9_000 },
    { inboundTs: 0, replyTs: 10_000 },
    { inboundTs: 0, replyTs: 10_000 },
    { inboundTs: 0, replyTs: 11_000 },
    { inboundTs: 0, replyTs: 12_000 },
  ];
  let sum = 0;
  for (let i = 0; i < 200; i++) {
    sum += computeHoldFromSamples({
      samples,
      msSinceLastInbound: 5 * 60_000,
      isActiveBurst: false,
    }).holdMs;
  }
  const avg = sum / 200;
  // median 10s × 0.8 = 8s; jitter ±20% keeps the mean ~8s, far above 1.8s.
  assert.ok(avg > 5_000, `expected median-driven hold (~8s), got ${avg}`);
});

test("computeHoldFromSamples: falls back to safe default below MIN_REAL_SAMPLES", () => {
  assert.equal(MIN_REAL_SAMPLES, 3);
  // Only two usable samples — median is noise, must use the moderate
  // no-data default, NOT the (large) sample median.
  const samples: LatencySample[] = [
    { inboundTs: 0, replyTs: 60_000 }, // 60s
    { inboundTs: 0, replyTs: 60_000 }, // 60s
  ];
  let sum = 0;
  for (let i = 0; i < 200; i++) {
    sum += computeHoldFromSamples({
      samples,
      msSinceLastInbound: 5 * 60_000,
      isActiveBurst: false,
    }).holdMs;
  }
  const avg = sum / 200;
  // Default base ~1.8s. If it had (wrongly) used the 60s median it'd be
  // ~48s (clamped to 25s ceiling). Assert it stays near the default.
  assert.ok(avg < 5_000, `expected safe default (~1.8s), got ${avg}`);
});

test("computeHoldFromSamples: empty samples → safe default, never throws", () => {
  const v = computeHoldFromSamples({
    samples: [],
    msSinceLastInbound: 0,
    isActiveBurst: false,
  });
  assert.ok(v.holdMs >= 600 && v.holdMs <= 25_000);
});

test("computeHold: overnight-edge hours get a higher floor", () => {
  // 07:00 (just-woken edge) with zero samples → default base shrinks via
  // todMult but the edge floor keeps it from going implausibly fast.
  let min = Infinity;
  for (let i = 0; i < 300; i++) {
    const v = computeHold({
      ownerLatencies: [],
      msSinceLastInbound: 0,
      isActiveBurst: false,
      localHour: 7,
    });
    min = Math.min(min, v.holdMs);
  }
  assert.ok(min >= 1_200, `edge floor should be >= 1200ms, got min ${min}`);
});
