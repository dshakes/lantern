// Tests that agentPersonaPrompt injects the emotional-register addendum.
//   cd packages/bridge-core && npx tsx --test src/natural-emotional-register.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { agentPersonaPrompt, inferStyle } from "./natural.ts";

const style = inferStyle(["hey", "yeah for sure", "lol ok"]);

test("no register → no emotional addendum (backward compatible)", () => {
  const prompt = agentPersonaPrompt("Shekhar", style, false, {});
  assert.doesNotMatch(prompt, /EMOTIONAL READ/);
});

test("explicit neutral → no addendum", () => {
  const prompt = agentPersonaPrompt("Shekhar", style, false, {
    emotionalRegister: "neutral",
  });
  assert.doesNotMatch(prompt, /EMOTIONAL READ/);
});

test("distress register injects the empathy/no-scheduling addendum", () => {
  const prompt = agentPersonaPrompt("Shekhar", style, false, {
    emotionalRegister: "distress",
  });
  assert.match(prompt, /EMOTIONAL READ/);
  assert.match(prompt, /distress/i);
  assert.match(prompt, /scheduling|tasks|logistics/i);
});

test("distress addendum lands AFTER the scheduling block so it can override it", () => {
  const prompt = agentPersonaPrompt("Shekhar", style, false, {
    schedulingEnabled: true,
    freeSlotsBlock: "Saturday morning",
    emotionalRegister: "distress",
  });
  const schedIdx = prompt.indexOf("you can negotiate times");
  const emoIdx = prompt.indexOf("EMOTIONAL READ");
  assert.ok(schedIdx >= 0, "scheduling block missing");
  assert.ok(emoIdx >= 0, "emotional addendum missing");
  assert.ok(emoIdx > schedIdx, "emotional addendum must come after scheduling");
});

test("frustration register injects acknowledge-first", () => {
  const prompt = agentPersonaPrompt("Shekhar", style, false, {
    emotionalRegister: "frustration",
  });
  assert.match(prompt, /acknowledge/i);
});

test("excitement register injects match-energy", () => {
  const prompt = agentPersonaPrompt("Shekhar", style, false, {
    emotionalRegister: "excitement",
  });
  assert.match(prompt, /match.*energy/i);
});

test("hard safety rules remain present alongside the addendum", () => {
  const prompt = agentPersonaPrompt("Shekhar", style, false, {
    emotionalRegister: "distress",
  });
  // The addendum must not displace the non-negotiable rules.
  assert.match(prompt, /Hard rules — non-negotiable/);
  assert.match(prompt, /NEVER FABRICATE A NAME/);
});
