// Tests for detectBotClocked — the SOFT "contact figured out / is needling
// the bot" detector that pages the owner but never refuses or silences.
//   cd packages/bridge-core && npx tsx --test src/bot-clocked.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectBotClocked } from "./escalation-detector.ts";

test("flags the real field phrasings that outed the bot", () => {
  const clocked = [
    "Oh it's your LLM again haha - I'd love to sync with you soon",
    "Haha this LLM response, hilarious. if you're not able to help me out lmk",
    "Bad robot",
    "is this a bot?",
    "are you a bot",
    "u a robot?",
    "are you chatgpt",
    "lol your bot replied again",
    "this is a bot isn't it",
    "am i talking to a bot",
    "you're not really a human are you",
    "that bot reply was wild",
  ];
  for (const t of clocked) {
    assert.ok(detectBotClocked(t), `expected bot-clocked match for: ${JSON.stringify(t)}`);
  }
});

test("does NOT fire on ordinary chat", () => {
  const benign = [
    "hey no worries — I'm headed there next week",
    "did you happen to have a glance at what I sent over?",
    "shot a call man - lmk when works",
    "can we chat after 6pm today?",
    "i bought a new robot vacuum lol", // 'robot' but not a bot accusation
    "let's grab lunch tomorrow",
    "thanks man, appreciate it",
  ];
  for (const t of benign) {
    assert.equal(detectBotClocked(t), null, `false positive on: ${JSON.stringify(t)}`);
  }
});

test("verdict carries kind + reason for the owner heads-up", () => {
  const v = detectBotClocked("bad robot");
  assert.equal(v?.kind, "bot-clocked");
  assert.ok(v?.reason && v.reason.length > 0);
});

test("empty / tiny input is safe", () => {
  assert.equal(detectBotClocked(""), null);
  assert.equal(detectBotClocked("hi"), null);
});
