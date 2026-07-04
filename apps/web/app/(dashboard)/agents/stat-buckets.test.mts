import { test } from "node:test";
import assert from "node:assert/strict";

import { bucketRunsByTime } from "./stat-buckets.ts";

test("bucketRunsByTime: below the honesty floor returns null, never a fake curve", () => {
  const now = Date.parse("2026-07-03T12:00:00Z");
  const runs = [
    { createdAt: new Date(now - 1_000) },
    { createdAt: new Date(now - 2_000) },
  ];
  assert.equal(bucketRunsByTime(runs, now), null);
});

test("bucketRunsByTime: runs outside the 24h window are excluded from the count and the floor", () => {
  const now = Date.parse("2026-07-03T12:00:00Z");
  const runs = [
    { createdAt: new Date(now - 25 * 3_600_000), costUsd: 5 }, // outside window
    { createdAt: new Date(now - 1 * 3_600_000), costUsd: 1 },
    { createdAt: new Date(now - 2 * 3_600_000), costUsd: 1 },
    { createdAt: new Date(now - 3 * 3_600_000), costUsd: 1 },
  ];
  const result = bucketRunsByTime(runs, now);
  assert.ok(result);
  assert.equal(result!.runCounts.reduce((a, b) => a + b, 0), 3);
  assert.equal(result!.costs.reduce((a, b) => a + b, 0), 3);
});

test("bucketRunsByTime: runs land in the correct bucket index and sum cost", () => {
  const now = Date.parse("2026-07-03T12:00:00Z");
  const windowStart = now - 24 * 3_600_000;
  const runs = [
    { createdAt: new Date(windowStart + 1_000), costUsd: 2 },
    { createdAt: new Date(windowStart + 2_000), costUsd: 2 },
    { createdAt: new Date(windowStart + 3_000), costUsd: 2 },
  ];
  const result = bucketRunsByTime(runs, now);
  assert.ok(result);
  assert.equal(result!.runCounts[0], 3);
  assert.equal(result!.costs[0], 6);
  assert.equal(result!.runCounts.length, 12);
  assert.ok(result!.runCounts.slice(1).every((n) => n === 0));
});

test("bucketRunsByTime: exactly at the floor returns data", () => {
  const now = Date.parse("2026-07-03T12:00:00Z");
  const runs = [
    { createdAt: new Date(now - 1_000) },
    { createdAt: new Date(now - 2_000) },
    { createdAt: new Date(now - 3_000) },
  ];
  assert.ok(bucketRunsByTime(runs, now));
});
