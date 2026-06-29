// Tests for owner natural-language command parsing.
//   cd packages/bridge-core && npx tsx --test src/nl-commands.test.ts
//
// The load-bearing invariant: a command word inside a conversational SENTENCE
// must NOT fire that command. The bot used to match verbs anywhere ("ping me
// how the HM round went" → pong; "pause and tell me…" → muted). Every terse
// command is now full-body anchored; this test guards the whole class so the
// same brand-damaging misfire can't creep back in one verb at a time.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseNLCommand } from "./nl-commands.ts";

test("standalone commands still fire", () => {
  const cases: Array<[string, string]> = [
    ["ping", "ping"],
    ["ping?", "ping"],
    ["mute", "mute"],
    ["pause", "mute"],
    ["quiet", "mute"],
    ["mute everyone", "mute"],
    ["pause for 2 hours", "mute"],
    ["resume", "unmute"],
    ["unmute", "unmute"],
    ["status", "status"],
    ["how are you", "status"],
    ["help", "help"],
    ["resume all", "resume-all"],
  ];
  for (const [input, action] of cases) {
    assert.equal(parseNLCommand(input)?.action, action, `"${input}" should be ${action}`);
  }
});

test("REGRESSION: command words inside a sentence must NOT fire a command", () => {
  // Each of these STARTS with a command verb (so it clears the verb gate) but
  // is a real request — it must return null (→ reach the assistant).
  const mustNotFire = [
    "Ping me how did the HM round go",
    "ping me about the deck tomorrow",
    "ping Raju when he lands",
    "pause and tell me how the deal went",
    "mute the background noise question",
    "quiet update on the project please",
    "stop me if this sounds wrong",
    "status of the funding round?",
    "how are things going with the launch",
    "help me draft a reply to Sam",
    "resume the meeting notes from yesterday",
    "off to the gym, hold my calls later",
    "on second thought, what's my schedule",
    "wake me up at 7 tomorrow",
    "list the open action items for me",
    "show me the latest news",
  ];
  for (const input of mustNotFire) {
    const r = parseNLCommand(input);
    assert.equal(r, null, `"${input}" must NOT fire a command (got ${JSON.stringify(r)})`);
  }
});
