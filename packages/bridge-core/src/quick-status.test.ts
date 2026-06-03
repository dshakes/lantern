// Quick-status parsing: the owner fires a natural one-liner in self-chat and
// the bot stores a timed status so it can answer "did you eat?" / "are you
// home?" FACTUALLY instead of guessing.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parsePresenceCommand } from "./nl-commands.ts";

const H = 3_600_000;

test("'just ate' → status with a ~3h TTL, no take-message", () => {
  const p = parsePresenceCommand("just ate");
  assert.ok(p && p.action === "set");
  if (p.action === "set") {
    assert.equal(p.label, "just ate");
    assert.equal(p.state, "free");
    assert.equal(p.takeMessage, false);
    assert.equal(p.durationMs, 3 * H);
  }
});

test("'had lunch' also → just ate", () => {
  const p = parsePresenceCommand("had lunch");
  assert.equal(p?.action === "set" && p.label, "just ate");
});

test("'heading home' → status", () => {
  const p = parsePresenceCommand("heading home");
  assert.equal(p?.action === "set" && p.label, "heading home");
});

test("'reached home' → home, free", () => {
  const p = parsePresenceCommand("reached home");
  assert.ok(p && p.action === "set" && p.label === "home" && p.state === "free");
});

test("'going to bed' → asleep, sleep state, ~8h", () => {
  const p = parsePresenceCommand("going to bed");
  assert.ok(p && p.action === "set");
  if (p.action === "set") {
    assert.equal(p.label, "asleep");
    assert.equal(p.state, "sleep");
    assert.equal(p.durationMs, 8 * H);
  }
});

test("explicit duration overrides the smart default: 'at the gym for 1h'", () => {
  const p = parsePresenceCommand("at the gym for 1h");
  assert.ok(p && p.action === "set" && p.label === "at the gym" && p.durationMs === 1 * H);
});

test("a QUESTION is never a status set: 'are you home?'", () => {
  assert.equal(parsePresenceCommand("are you home?"), null);
});

test("'I'm back' still clears", () => {
  assert.equal(parsePresenceCommand("I'm back")?.action, "clear");
});

test("non-status chatter returns null", () => {
  assert.equal(parsePresenceCommand("can you send me the doc"), null);
});
