// Regression for the silent-drop bug: a normal "Where are you" was classified
// as a human-only escalation and the reply was SUPPRESSED (bot went silent on a
// contact during a live demo). The classifier must NOT treat ordinary
// conversational questions as escalations.
//   cd packages/bridge-core && npx tsx --test src/escalation-no-suppress.test.ts
//
// NOTE: the *gate* fix (escalation pages the owner but STILL replies, never
// pauses) lives in each bridge's session.ts; this guards the shared classifier.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectEscalation } from "./natural.ts";

// These are normal, bot-answerable messages — they must NOT escalate (and so
// must never suppress an auto-reply).
const MUST_NOT_ESCALATE = [
  "Where are you",
  "where are you?",
  "where r u",
  "are you ok",
  "are you okay?",
  "are you home",
  "are you alright",
  "call me when you're free",
  "you around?",
  "what's the plan tonight",
  "did you eat",
];

test("normal conversational questions do NOT escalate (no silent suppression)", () => {
  for (const t of MUST_NOT_ESCALATE) {
    const v = detectEscalation(t);
    assert.equal(v.escalate, false, `should NOT escalate: ${JSON.stringify(t)} (reason=${v.reason})`);
  }
});

// Genuinely human-needed / sensitive content still pages the owner (escalate:true).
// The gate replies anyway, but the owner still gets the heads-up.
const MUST_ESCALATE = [
  ["pick up the phone", "needs you specifically"],
  ["call me back", "needs you specifically"],
  ["this is an emergency, call 911", "urgency marker"],
  ["he's at the hospital after an accident", "safety/health"],
  ["please wire the payment for the invoice", "money/legal"],
  ["i'm so upset and disappointed", "emotional"],
  ["she passed away, the funeral is friday", "grief"],
] as const;

test("genuine escalations still fire (owner is still paged)", () => {
  for (const [t] of MUST_ESCALATE) {
    const v = detectEscalation(t);
    assert.equal(v.escalate, true, `should escalate (page owner): ${JSON.stringify(t)}`);
  }
});
