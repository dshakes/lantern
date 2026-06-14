// Tests for the owner-handoff takeover-pause logic.
//   cd packages/bridge-core && npx tsx --test src/owner-handoff.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectOwnerHandoff, ownerTakeoverPauseMs } from "./owner-handoff.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

test("detects explicit handoff / commitment messages", () => {
  const handoffs = [
    "Human here - Will call u this evening",
    "i'll call you later",
    "will call you tomorrow",
    "let me reply to this one",
    "i'll handle this",
    "i'll take it from here",
    "i'll text him directly",
    "gonna call her back",
    "let me jump in",
  ];
  for (const t of handoffs) {
    assert.ok(detectOwnerHandoff(t).matched, `expected handoff for: ${JSON.stringify(t)}`);
  }
});

test("does NOT treat a normal interjection as a handoff", () => {
  const normal = [
    "lol yeah",
    "ok sounds good",
    "haha true",
    "sure thing",
    "thanks!",
    "that works for me",
  ];
  for (const t of normal) {
    assert.equal(detectOwnerHandoff(t).matched, false, `false handoff on: ${JSON.stringify(t)}`);
  }
});

test("handoff gets the long pause; plain interjection gets the default", () => {
  const def = 60 * MIN;
  const handoff = 12 * HOUR;

  const a = ownerTakeoverPauseMs("Human here - Will call u this evening", def, handoff);
  assert.equal(a.ms, handoff);
  assert.equal(a.handoff.matched, true);

  const b = ownerTakeoverPauseMs("ok cool", def, handoff);
  assert.equal(b.ms, def);
  assert.equal(b.handoff.matched, false);
});

test("never shortens a default that is already longer than the handoff pause", () => {
  const def = 24 * HOUR;
  const handoff = 12 * HOUR;
  const r = ownerTakeoverPauseMs("i'll call you this evening", def, handoff);
  assert.equal(r.ms, def); // max(def, handoff)
});
