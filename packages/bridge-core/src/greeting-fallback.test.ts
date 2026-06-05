// Regression tests for greetingReply — the safety-net that keeps the bot from
// going stone-silent on a plain "hi"/"hey".
//
// Production bug (see screenshot report): a contact texted "Hi" three times and
// got nothing back. Root cause: the LLM, posing as the owner, replied with
// "Hey! How can I help you?", which the bot-tell filter correctly suppresses as
// customer-service phrasing — but the bridge then went silent instead of
// sending anything. greetingReply gives a deterministic human opener for pure
// greetings so silence is never the outcome for "hi".

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { greetingReply } from "./natural.ts";

// Pure greetings → always a non-empty, human opener (and never a bot-tell).
const GREETINGS = [
  "Hi",
  "hi",
  "hey",
  "Hey!",
  "hello",
  "hello there",
  "yo",
  "sup",
  "hii",
  "heyy",
  "good morning",
  "Good Morning!",
  "good night",
  "namaste",
  "hola",
  "hi hi",
  "hey hey",
];

for (const g of GREETINGS) {
  test(`greetingReply returns an opener for: ${JSON.stringify(g)}`, () => {
    const r = greetingReply(g);
    assert.ok(r && r.trim().length > 0, `expected an opener for "${g}", got ${JSON.stringify(r)}`);
  });
}

// Deterministic: same inbound → same opener (no reordering under retries /
// cross-device replays).
test("greetingReply is deterministic per inbound", () => {
  assert.equal(greetingReply("hi"), greetingReply("hi"));
  assert.equal(greetingReply("good morning"), greetingReply("good morning"));
});

// Anything actionable / not a bare greeting → null (must still hit the LLM).
const NOT_GREETINGS = [
  "hi when does my passport expire",
  "hey can you check my email",
  "good morning, set a reminder for 9am",
  "hello, draft a reply to maya",
  "what's the plan for tonight",
  "are we still on for 7?",
  "", // empty
  "   ", // whitespace
  "this is a much longer message that merely opens with nothing greeting-like",
];

for (const t of NOT_GREETINGS) {
  test(`greetingReply returns null for non-greeting: ${JSON.stringify(t.slice(0, 30))}`, () => {
    assert.equal(greetingReply(t), null, `expected null for "${t}"`);
  });
}
