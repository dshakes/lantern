// Tests for the time-travel recap: request grammar, window parsing, prompt,
// deterministic fallback.
//   cd packages/bridge-core && npx tsx --test src/time-travel.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  looksLikeRecapRequest, parseRecapWindow, buildRecapPrompt, buildRecapFallback,
  finalizeRecap, type RecapRequest, type RecapItem,
} from "./time-travel.ts";

test("looksLikeRecapRequest: triggers vs normal chat", () => {
  for (const s of ["what did I miss", "what happened while I was out", "catch me up", "recap", "while I was gone", "whatd i miss"]) {
    assert.equal(looksLikeRecapRequest(s), true, s);
  }
  for (const s of ["what did Arun say about the trip to the lake house next month", "miss you", "tell Sam I'll be late"]) {
    assert.equal(looksLikeRecapRequest(s), false, s);
  }
});

test("parseRecapWindow: explicit windows, else null", () => {
  const now = new Date(2026, 6, 6, 15, 0, 0).getTime();
  assert.equal(parseRecapWindow("what did I miss in the last 3 hours", now), now - 3 * 3_600_000);
  assert.equal(parseRecapWindow("recap last 30 min", now), now - 30 * 60_000);
  assert.equal(parseRecapWindow("what happened overnight", now), now - 9 * 3_600_000);
  const today = parseRecapWindow("what did I miss today", now)!;
  assert.equal(new Date(today).getHours(), 0);
  assert.equal(parseRecapWindow("what did I miss", now), null); // caller default
});

const ITEMS: RecapItem[] = [
  { kind: "life_event", subject: "Amex", detail: "flagged a $420 charge", at: 100, weight: 3 },
  { kind: "message", subject: "Madhu", detail: "asked if you're still on for Friday", at: 200, weight: 2 },
  { kind: "auto_action", subject: "week-ahead skill", detail: "sent your Sunday preview", at: 150, weight: 0 },
];

test("buildRecapPrompt: includes items, ranks by weight, forbids invention", () => {
  const req: RecapRequest = { since: 0, now: 4 * 3_600_000, items: ITEMS };
  const p = buildRecapPrompt(req);
  assert.match(p, /the last 4h/);
  assert.match(p, /Amex: flagged a \$420 charge/);
  assert.match(p, /Never invent/);
  // highest weight first
  assert.ok(p.indexOf("Amex") < p.indexOf("Madhu"));
});

test("buildRecapFallback: truthful, top-4, empty case", () => {
  assert.match(buildRecapFallback({ since: 0, now: 3_600_000, items: [] }), /all quiet/);
  const f = buildRecapFallback({ since: 0, now: 3_600_000, items: ITEMS });
  assert.match(f, /Amex: flagged a \$420 charge/);
  assert.ok(f.indexOf("Amex") < f.indexOf("Madhu")); // weight-ranked
});

test("finalizeRecap: uses LLM text, falls back on empty", () => {
  const req: RecapRequest = { since: 0, now: 3_600_000, items: ITEMS };
  assert.equal(finalizeRecap("Amex flagged a charge — worth a look.", req), "Amex flagged a charge — worth a look.");
  assert.match(finalizeRecap("  ", req), /Amex/); // empty → fallback
  assert.match(finalizeRecap(null, req), /Amex/);
});
