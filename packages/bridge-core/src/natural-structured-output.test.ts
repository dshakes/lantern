// Regression: the bot sent a raw episodic-memory extraction object
// (`{"topic": "customer pipeline", "outcome": "..."}`) verbatim to a contact.
// detectBotTells must suppress ANY structured-data draft so it never ships.
//   cd packages/bridge-core && npx tsx --test src/natural-structured-output.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectBotTells } from "./natural.ts";

test("suppresses the exact JSON that leaked in the field", () => {
  const draft = '{"topic": "customer pipeline", "outcome": "They discussed companies in the current pipeline."}';
  const v = detectBotTells(draft, "we have Intuit, squarespace, recall, Wells Fargo in pipeline rn");
  assert.equal(v.ok, false);
  assert.match(v.reason, /structured|extraction/i);
});

test("suppresses fenced JSON and other structured shapes", () => {
  const drafts = [
    '```json\n{"intent": "schedule", "time": "6pm"}\n```',
    '{"action": "send_email", "to": "x@y.com"}',
    '["one", "two", "three"]',
    '{"sentiment": "positive"}',
    'sure thing {"topic": "deal", "outcome": "agreed"}', // key anywhere
  ];
  for (const d of drafts) {
    assert.equal(detectBotTells(d).ok, false, `should suppress: ${JSON.stringify(d)}`);
  }
});

test("does NOT suppress normal human texts that merely contain braces/colons", () => {
  const fine = [
    "sounds good, see you at 6",
    "lol the score was 3:1",
    "use {firstName} as the placeholder in the template", // a brace but not JSON
    "deal — let's lock it in",
    "appreciate it man",
  ];
  for (const d of fine) {
    assert.equal(detectBotTells(d).ok, true, `should NOT suppress: ${JSON.stringify(d)}`);
  }
});

test("suppresses the customer-service tells from the screenshot", () => {
  assert.equal(detectBotTells("ugh, I'm sorry about that. Lmk what you need, I'll do my best to assist.").ok, false);
  assert.equal(detectBotTells("I'll do my best to assist").ok, false);
  assert.equal(detectBotTells("sorry about that").ok, false);
});
