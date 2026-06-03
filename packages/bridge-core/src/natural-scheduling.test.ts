// Tests for the scheduling-negotiation persona block.
//   cd packages/bridge-core && npx tsx --test src/natural-scheduling.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { agentPersonaPrompt, schedulingBlock, inferStyle } from "./natural.ts";

const style = inferStyle(["hey", "yeah for sure", "lol ok"]);

test("scheduling block is absent by default", () => {
  const prompt = agentPersonaPrompt("Shekhar", style, false, {});
  assert.doesNotMatch(prompt, /you can negotiate times/i);
});

test("scheduling block is injected when schedulingEnabled with free slots", () => {
  const prompt = agentPersonaPrompt("Shekhar", style, false, {
    schedulingEnabled: true,
    freeSlotsBlock: "after 6pm weekdays, Saturday morning",
  });
  assert.match(prompt, /you can negotiate times/i);
  assert.match(prompt, /after 6pm weekdays, Saturday morning/);
  // Must still teach the [CALENDAR:...] marker only on agreement.
  assert.match(prompt, /\[CALENDAR:title\|start-iso/);
  assert.match(prompt, /only after explicit agreement/i);
});

test("scheduling block keeps the work-hours guardrail intact", () => {
  const prompt = agentPersonaPrompt("Shekhar", style, false, {
    schedulingEnabled: true,
    freeSlotsBlock: "Saturday morning",
  });
  // The new block re-asserts the guardrail...
  assert.match(prompt, /NEVER offer or agree to a slot inside Shekhar's stated work hours/i);
  // ...and the original SCHEDULING guardrail line is still present.
  assert.match(prompt, /NEVER offer or agree to sync inside Shekhar's stated work hours/i);
});

test("schedulingEnabled with no free slots falls back to reframe-only", () => {
  const prompt = agentPersonaPrompt("Shekhar", style, false, {
    schedulingEnabled: true,
  });
  assert.match(prompt, /don't have Shekhar's open slots/i);
  assert.match(prompt, /don't name a specific time/i);
});

test("schedulingBlock is exported and pure", () => {
  const a = schedulingBlock("Alex", "Sunday afternoon");
  const b = schedulingBlock("Alex", "Sunday afternoon");
  assert.equal(a, b);
  assert.match(a, /Sunday afternoon/);
  assert.match(a, /pencil one in/i);
});
