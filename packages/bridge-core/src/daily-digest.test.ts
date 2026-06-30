// Tests for looksLikeBriefingRequest — the on-demand briefing trigger.
//   cd packages/bridge-core && npx tsx --test src/daily-digest.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { looksLikeBriefingRequest } from "./daily-digest.ts";

test("triggers on explicit briefing asks", () => {
  for (const s of [
    "brief me",
    "brief me on my day",
    "morning briefing",
    "give me my briefing",
    "what's on my plate",
    "whats on my plate today",
    "what's on for today",
    "what do i have today",
    "what do i have going on today",
    "catch me up on my day",
    "run me through my day",
    "how's my day looking",
    "where do things stand",
    "my schedule today",
  ]) {
    assert.equal(looksLikeBriefingRequest(s), true, s);
  }
});

test("does NOT trigger on generic / unrelated chatter", () => {
  for (const s of [
    "what's up",
    "hi",
    "hey what's good",
    "what's the weather today",
    "what did Arun say",
    "where am I",
    "what's on Netflix tonight",
    "",
  ]) {
    assert.equal(looksLikeBriefingRequest(s), false, s);
  }
});
