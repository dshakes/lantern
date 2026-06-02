// Tests for the owner presence/status command parser.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parsePresenceCommand } from "./nl-commands.ts";

test("'I'm at the temple' → set, place captured", () => {
  const r = parsePresenceCommand("I'm at the temple");
  assert.equal(r?.action, "set");
  if (r?.action === "set") assert.match(r.label, /temple/i);
});

test("duration 'for 2h' parsed", () => {
  const r = parsePresenceCommand("I'm at the gym for 2h");
  assert.equal(r?.action, "set");
  if (r?.action === "set") assert.equal(r.durationMs, 2 * 3_600_000);
});

test("duration 'for 30 min' parsed", () => {
  const r = parsePresenceCommand("I'm in a meeting for 30 min");
  assert.equal(r?.action, "set");
  if (r?.action === "set") assert.equal(r.durationMs, 30 * 60_000);
});

test("'status: at the dentist' → set", () => {
  assert.equal(parsePresenceCommand("status: at the dentist")?.action, "set");
});

test("clear variants", () => {
  for (const c of ["I'm back", "status off", "clear my status", "I'm available"]) {
    assert.equal(parsePresenceCommand(c)?.action, "clear", c);
  }
});

test("not a presence command → null", () => {
  for (const c of ["what's my next appointment?", "call manu", "how are you", "I'm at a loss what to do?"]) {
    assert.equal(parsePresenceCommand(c), null, c);
  }
});
