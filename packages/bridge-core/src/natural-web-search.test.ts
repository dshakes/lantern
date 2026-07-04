// Tests for the LIVE-LOOKUP persona rule (canWebSearch).
// Regression: sister sent a FlightAware screenshot of FFT3990 + "flight
// redirected to Cincinnati" and the bot replied "tracking it? whose flight is
// this" then "keep me posted" ×4 — no lookup, no use of the caption's flight
// number. The rule only appears when the turn actually carries web_search.
//   cd packages/bridge-core && npx tsx --test src/natural-web-search.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { agentPersonaPrompt, type StyleProfile } from "./natural.ts";

const STYLE: StyleProfile = {
  formality: "casual",
  mostlyLowercase: true,
  usesAbbreviations: true,
  usesEmojis: true,
  minimalPunctuation: true,
  avgWordsPerMessage: 5,
};

test("canWebSearch injects the LIVE LOOKUP rule", () => {
  const p = agentPersonaPrompt("Shekhar", STYLE, false, { canWebSearch: true });
  assert.match(p, /LIVE LOOKUP/);
  assert.match(p, /web_search/);
  // Load-bearing behaviors: use identifiers from thread + image captions,
  // never deflect a live worry with "keep me posted".
  assert.match(p, /image captions/i);
  assert.match(p, /keep me posted/i);
  // Never narrate the tool to the contact.
  assert.match(p, /never mention the tool/i);
});

test("no canWebSearch → no tool talk in the prompt", () => {
  const p = agentPersonaPrompt("Shekhar", STYLE, false, {});
  assert.doesNotMatch(p, /LIVE LOOKUP/);
  assert.doesNotMatch(p, /web_search/);
});
