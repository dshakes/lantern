import { test } from "node:test";
import assert from "node:assert/strict";
import { introspectStaleness } from "./introspect-staleness.ts";

const H = 3_600_000;
test("fresh run is not stale", () => assert.deepEqual(introspectStaleness(0, 35 * H), { stale: false, ageHours: 35 }));
test("36h boundary is stale", () => assert.equal(introspectStaleness(0, 36 * H).stale, true));
test("never succeeded is stale", () => assert.deepEqual(introspectStaleness(null, 1), { stale: true, ageHours: null }));
test("custom threshold", () => assert.equal(introspectStaleness(0, 5 * H, 6).stale, false));
