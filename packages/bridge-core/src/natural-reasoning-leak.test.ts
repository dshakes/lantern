// Regression tests for the reasoning-leak suppression in detectBotTells.
//
// Production bug: instead of returning an empty string (→ stay silent), the
// model emitted its internal deliberation as the message body, and the bridge
// sent it to the contact:
//   "The contact just said "Oh not started" … Nothing needs a reply here"
//   "A real person wouldn't respond to that. Empty string is the right call."
// detectBotTells must suppress these (ok=false) while leaving genuine,
// human-sounding replies untouched.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectBotTells } from "./natural.ts";

const LEAKS = [
  `The contact just said "Oh not started" — acknowledging what I'll make sure them sees Nothing needs a reply here`,
  `A real person wouldn't respond to that. Empty string is the right call.`,
  `No reply needed here.`,
  `Nothing needs a reply.`,
  `I'll stay silent on this one.`,
  `The sender is just acknowledging; I won't respond.`,
  `Empty string is the right call.`,
  // Second report (DM with Mae): bare token + decision narration that
  // slipped past the first pass.
  `empty`,
  `Empty`,
  `(empty)`,
  `Nothing new to add`,
  `nothing to add`,
  `none`,
  `no reply`,
  `The contact is just repeating "Did u start?" — I already answered this exact question earlier ("yeah around 12 min" / "yep")`,
  `I already answered this earlier`,
  `they're just repeating the question, nothing to add`,
];

for (const leak of LEAKS) {
  test(`suppresses reasoning leak: ${leak.slice(0, 40)}…`, () => {
    const v = detectBotTells(leak);
    assert.equal(v.ok, false, `expected suppression, got ok=true for: ${leak}`);
  });
}

// Genuine human replies must NOT be suppressed by the new patterns.
const REAL_REPLIES = [
  "oh nice, when did you start?",
  "haha no worries, talk later",
  "yeah sounds good, see you at 7",
  "lol same",
  "ok cool",
  "got it, thanks!",
  "you made a good call on the venue tbh", // 'call' but not a decision-narration
  "the place was totally empty lol", // contains 'empty' but not a bare token
  "anything else you want me to add?", // 'add' but not 'nothing to add'
  "i already ate, thanks though", // 'already' but not 'already answered'
  "yeah i'm repeating the same playlist haha", // 'repeating' but not about the inbound
  // Regression: the un-gated `the (contact|sender|recipient)` pattern used to
  // suppress these legit replies. The verb-gated leak pattern must leave them be.
  "sure, i'll send you the contact info in a sec",
  "the recipient address is on file, all good",
  "lemme grab the sender's number and text you",
];

for (const reply of REAL_REPLIES) {
  test(`allows genuine reply: ${reply.slice(0, 40)}`, () => {
    const v = detectBotTells(reply);
    assert.equal(
      v.ok,
      true,
      `genuine reply wrongly suppressed (${v.reason}): ${reply}`,
    );
  });
}
