// Regression tests for two live embarrassments (2026-07-08):
//   cd packages/bridge-core && npx tsx --test src/natural-third-party-facts.test.ts
//
// 1. A friend asked "is Madhu in CA" — the owner's brother lives in Dublin, CA
//    and the profile records it, but the people-graph was never injected into
//    contact replies, so the bot deflected ("not sure, lemme check with him").
//    => knownPeople must be injected + a THIRD-PARTY-FACTS rule must permit it.
// 2. Chikka asked for "pan and aadhar" — the bot parroted an internal to-do
//    ("that's still on his list — send pan and aadhar to Sarika") AND faked
//    "sending now" for ID documents it can't attach.
//    => CONTEXT-BLOCKS-ARE-PRIVATE + YOU-SEND-TEXT-ONLY rules must render for
//    contacts, and must NOT leak into the owner-audience prompt dump.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { agentPersonaPrompt, inferStyle } from "./natural.ts";

const style = inferStyle([]);
const KNOWN = "Madhu K Mudarapu: elder brother\nMadhu K Mudarapu: lives in Dublin, CA";

test("contact prompt injects knownPeople + THIRD-PARTY-FACTS rule (Madhu/CA)", () => {
  const p = agentPersonaPrompt("Shekhar", style, false, {
    audience: "contact",
    knownPeople: KNOWN,
  });
  assert.ok(p.includes("lives in Dublin, CA"), "knownPeople block not injected");
  assert.ok(p.includes("THIRD-PARTY FACTS ARE SHAREABLE"), "third-party rule missing");
});

test("contact prompt carries the no-leak + no-fake-send rules (Chikka)", () => {
  const p = agentPersonaPrompt("Shekhar", style, false, { audience: "contact" });
  assert.ok(p.includes("CONTEXT BLOCKS ARE PRIVATE"), "private-context rule missing");
  assert.ok(p.includes("NEVER FAKE A SEND"), "no-fake-send rule missing");
  assert.ok(/PAN, Aadhaar/.test(p), "sensitive-doc examples missing");
});

test("owner-audience prompt does NOT dump the people-graph or contact-only rules", () => {
  const p = agentPersonaPrompt("Shekhar", style, false, {
    audience: "owner",
    knownPeople: KNOWN,
  });
  assert.ok(!p.includes("lives in Dublin, CA"), "people-graph leaked into owner prompt");
  assert.ok(!p.includes("THIRD-PARTY FACTS ARE SHAREABLE"), "contact rule leaked to owner");
});
