// Tests for the scheduling-negotiation persona block.
//   cd packages/bridge-core && npx tsx --test src/natural-scheduling.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { agentPersonaPrompt, schedulingBlock, inferStyle } from "./natural.ts";

const style = inferStyle(["hey", "yeah for sure", "lol ok"]);

test("scheduling block is absent by default", () => {
  const prompt = agentPersonaPrompt("Ada", style, false, {});
  assert.doesNotMatch(prompt, /SCHEDULING —/);
});

test("scheduling block is injected when schedulingEnabled with free slots", () => {
  const prompt = agentPersonaPrompt("Ada", style, false, {
    schedulingEnabled: true,
    freeSlotsBlock: "after 6pm weekdays, Saturday morning",
  });
  assert.match(prompt, /SCHEDULING —/);
  assert.match(prompt, /after 6pm weekdays, Saturday morning/);
  // Must still teach the [CALENDAR:...] marker only on agreement.
  assert.match(prompt, /\[CALENDAR:title\|start-iso/);
  assert.match(prompt, /only after explicit agreement/i);
});

test("scheduling block is REACTIVE — never tells the model to volunteer/propose", () => {
  const block = schedulingBlock("Ada", "after 6pm weekdays");
  // The old proactive wording is gone — the bot must not push meetings.
  assert.doesNotMatch(block, /\bPROPOSE\b/);
  assert.doesNotMatch(block, /pencil one in/i);
  // And it explicitly tells the model not to push or use corporate filler.
  assert.match(block, /don't volunteer|don't push/i);
  assert.match(block, /discuss further|circle back/i);
});

test("scheduling block keeps the work-hours guardrail intact", () => {
  const prompt = agentPersonaPrompt("Ada", style, false, {
    schedulingEnabled: true,
    freeSlotsBlock: "Saturday morning",
  });
  // The new block re-asserts the guardrail...
  assert.match(prompt, /NEVER offer or agree to a slot inside Ada's stated work hours/i);
  // ...and the original SCHEDULING guardrail line is still present.
  assert.match(prompt, /NEVER offer or agree to sync inside Ada's stated work hours/i);
});

test("schedulingEnabled with no free slots falls back to reframe-only", () => {
  const prompt = agentPersonaPrompt("Ada", style, false, {
    schedulingEnabled: true,
  });
  assert.match(prompt, /don't have Ada's open slots/i);
  assert.match(prompt, /don't name a specific time/i);
});

test("schedulingBlock is exported and pure", () => {
  const a = schedulingBlock("Alex", "Sunday afternoon");
  const b = schedulingBlock("Alex", "Sunday afternoon");
  assert.equal(a, b);
  assert.match(a, /Sunday afternoon/);
});
