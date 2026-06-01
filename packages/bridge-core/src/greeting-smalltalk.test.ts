// Regression tests for the greeting/small-talk fast-path predicate.
//
// SMALL_TALK strings must route to lightweight natural chat (no agentic
// tool pipeline) — they're pure openers. ACTIONABLE strings must FAIL the
// predicate so they still reach the pipeline (file/Gmail/Calendar tools).
// The bug this guards: "Hi. Hi." and "Hi, how are you?" were spending
// ~1.2s spinning up tools because the period separator / "how are you"
// tail weren't recognised as small-talk.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isGreetingSmallTalk } from "./personal-docs.ts";

const SMALL_TALK = [
  "Hi. Hi.",
  "Hi, how are you?",
  "hi",
  "hey",
  "hello how are you",
  "hello how are you doing",
  "hey how's it going",
  "good morning",
  "good morning!",
  "good night",
  "what's up",
  "whats up",
  "sup",
  "namaste",
  "hey hey",
  "hi how r u",
  "hope you're doing well",
];

const ACTIONABLE = [
  "hi when does my passport expire",
  "hey can you check my email",
  "good morning, set a reminder for 9am",
  "how do I renew my license",
  "what's up with my flight booking",
  "hello, draft a reply to manasa",
  "morning — what's on my calendar today",
];

for (const t of SMALL_TALK) {
  test(`small-talk fast-path: ${JSON.stringify(t)}`, () => {
    assert.equal(isGreetingSmallTalk(t), true, `expected small-talk: ${t}`);
  });
}

for (const t of ACTIONABLE) {
  test(`actionable stays on pipeline: ${JSON.stringify(t)}`, () => {
    assert.equal(isGreetingSmallTalk(t), false, `expected NOT small-talk: ${t}`);
  });
}
