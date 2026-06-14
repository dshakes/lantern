// Tests for the current-time anchor injected into the persona prompt.
// Regression: the bot re-proposed "after 6pm today" at 8:19pm because the
// model was never told the current time.
//   cd packages/bridge-core && npx tsx --test src/natural-now-context.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { agentPersonaPrompt, formatNowContext, type StyleProfile } from "./natural.ts";

const STYLE: StyleProfile = {
  formality: "casual",
  mostlyLowercase: true,
  usesAbbreviations: true,
  usesEmojis: true,
  minimalPunctuation: true,
  avgWordsPerMessage: 5,
};

test("formatNowContext renders the wall clock in the owner's timezone", () => {
  // 2026-06-13T20:19:00-07:00 → 8:19 PM Los Angeles, a Saturday.
  const now = new Date("2026-06-14T03:19:00Z");
  const ctx = formatNowContext(now, "America/Los_Angeles");
  assert.match(ctx, /Saturday/);
  assert.match(ctx, /Jun 13, 2026/);
  assert.match(ctx, /8:19/);
  assert.match(ctx, /8:19\s*PM/i);
  // The load-bearing instruction: don't propose a time already passed.
  assert.match(ctx, /already passed/i);
});

test("formatNowContext never throws on a bad timezone", () => {
  const now = new Date("2026-06-14T03:19:00Z");
  assert.doesNotThrow(() => formatNowContext(now, "Not/AReal_Zone"));
});

test("agentPersonaPrompt injects the time anchor when now is provided", () => {
  const prompt = agentPersonaPrompt("Shekhar", STYLE, false, {
    now: new Date("2026-06-14T03:19:00Z"),
    ownerTimezone: "America/Los_Angeles",
    schedulingEnabled: true,
    freeSlotsBlock: "after 6pm weekdays, saturday morning",
  });
  assert.match(prompt, /Right now it is/);
  assert.match(prompt, /already passed/i);
});

test("agentPersonaPrompt stays clock-free when now is omitted (pure)", () => {
  const prompt = agentPersonaPrompt("Shekhar", STYLE, false, {});
  assert.doesNotMatch(prompt, /Right now it is/);
});
