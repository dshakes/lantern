// Regression tests for the reply-QUALITY upgrade (W-quality batch):
//
//  1. detectBotTells now catches two REAL leaked drafts the owner saw reach
//     a contact:
//       - "This is just Best Buy marketing spam. No reply."   (spam verdict)
//       - "yeah same ashby link again — i can't actually open external links"
//                                                            (capability disclaimer)
//     plus the padded-modal form ("can't actually open", "cannot even read").
//  2. The [[NO_REPLY]] abstain sentinel is recognized deterministically.
//  3. Owner-voice + per-contact verbatim samples can be relevance-ranked to
//     the current inbound (cheap token overlap, recency fallback).
//
// As always: the guards must NOT false-positive on normal human replies.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  agentPersonaPrompt,
  countTrailingUnanswered,
  detectBotTells,
  inferStyle,
  isNoReplySentinel,
  NO_REPLY_SENTINEL,
} from "./natural.ts";
import { ownerVoiceExemplars } from "./owner-voice.ts";
import { computeContactStyle } from "./per-contact-style.ts";

const style = inferStyle([]);

// ── 1. The two real leaks (and close cousins) are now suppressed ──────────

const KNOWN_LEAKS: string[] = [
  // The two REAL drafts from the owner's logs:
  "This is just Best Buy marketing spam. No reply.",
  "yeah same ashby link again — i can't actually open external links",
  // Padded-modal capability disclaimers the un-padded regex missed:
  "i can't actually open that",
  "i cannot even read the attachment",
  "can't really see the image",
  // Capability-disclaimer class (link/image/external):
  "I can't open links so not sure what that is",
  "unable to view the photo you sent",
  "I don't have the ability to access external websites",
  // Self-narrated spam/marketing verdicts:
  "that's spam",
  "looks like promotional junk",
  "this is just an automated message",
  // Trailing no-reply verdict:
  "interesting stuff but no reply",
];

for (const leak of KNOWN_LEAKS) {
  test(`suppresses leaked draft: ${leak.slice(0, 45)}…`, () => {
    const v = detectBotTells(leak);
    assert.equal(v.ok, false, `expected suppression for: ${leak}`);
  });
}

// ── 1b. Normal human replies are NOT false-positived ──────────────────────

const SAFE_REPLIES: string[] = [
  "yeah I'll take a look at that link in a bit",
  "haha same here, lemme open it tonight",
  "got it, thanks for sending the photo over",
  "sure, send me the website and I'll check it out",
  "that marketing deck looked solid btw", // contains "marketing" but not a spam verdict
  "I can do Friday around 6",
  "ok will read it later",
  "nice, the external recruiter reached out to me too", // "external" but no disclaimer
  "let me see what I can do",
  "no worries, whenever you get a chance",
];

for (const reply of SAFE_REPLIES) {
  test(`does NOT suppress normal reply: ${reply.slice(0, 45)}…`, () => {
    const v = detectBotTells(reply);
    assert.equal(v.ok, true, `expected pass, got reason="${v.reason}" for: ${reply}`);
  });
}

// ── 2. Abstain sentinel ────────────────────────────────────────────────────

test("isNoReplySentinel recognizes the bare token + padded forms", () => {
  assert.equal(isNoReplySentinel(NO_REPLY_SENTINEL), true);
  assert.equal(isNoReplySentinel("[[NO_REPLY]]"), true);
  assert.equal(isNoReplySentinel("  [[NO_REPLY]]  "), true);
  assert.equal(isNoReplySentinel("[[NO_REPLY]]."), true);
  assert.equal(isNoReplySentinel("```\n[[NO_REPLY]]\n```"), true);
  assert.equal(isNoReplySentinel("`[[NO_REPLY]]`"), true);
});

test("isNoReplySentinel does NOT fire on real replies", () => {
  assert.equal(isNoReplySentinel("yeah sounds good"), false);
  assert.equal(isNoReplySentinel(""), false);
  assert.equal(
    isNoReplySentinel("not replying to that [[NO_REPLY]] just kidding lol"),
    false,
    "token embedded in a real sentence is NOT an abstain",
  );
});

// ── 3. Relevance ranking (owner-voice + per-contact) ───────────────────────

test("ownerVoiceExemplars ranks by overlap with the inbound (recency fallback)", () => {
  const samples = [
    { text: "dropping the kids at soccer practice", ts: 100 },
    { text: "let's grab dinner this weekend", ts: 90 },
    { text: "the deploy went out clean this morning", ts: 80 },
  ];
  // Inbound about deploys should surface the deploy sample first.
  const ranked = ownerVoiceExemplars(samples, {
    relevantTo: "did the deploy ship yet?",
  });
  assert.equal(
    ranked[0],
    "the deploy went out clean this morning",
    "expected the deploy-shaped sample ranked first",
  );

  // No overlap → pure recency (most-recent first), backward-compatible.
  const recency = ownerVoiceExemplars(samples, {
    relevantTo: "completely unrelated zzzqqq",
  });
  assert.equal(recency[0], "dropping the kids at soccer practice");
});

test("computeContactStyle relevance ranking is backward-compatible when relevantTo absent", () => {
  // ≥3 of each so verbatim qualifies (3-15 word window).
  const messages = [
    "running late for the standup meeting today",
    "lunch plans this saturday afternoon work",
    "the standup got moved to noon instead",
    "saturday brunch sounds great to me",
    "standup recap is in the shared doc",
  ];
  const noRank = computeContactStyle(messages);
  // Default: most-recent first (reverse insertion order), capped at 10.
  assert.deepEqual(noRank.verbatimSamples[0], "standup recap is in the shared doc");

  const ranked = computeContactStyle(messages, {
    relevantTo: "is the standup still happening?",
  });
  // A standup-shaped sample should lead.
  assert.ok(
    ranked.verbatimSamples[0].includes("standup"),
    `expected a standup sample first, got "${ranked.verbatimSamples[0]}"`,
  );
});

// ── 4. Persona-prompt items (sentinel instruction + backlog hint) ──────────

test("agentPersonaPrompt instructs the model to emit the abstain sentinel", () => {
  const p = agentPersonaPrompt("Ada", style, false, { contactName: "Sujith" });
  assert.ok(
    p.includes(NO_REPLY_SENTINEL),
    "persona prompt should mention the [[NO_REPLY]] abstain token",
  );
  // Anti-disclaimer rule is present.
  assert.ok(
    /NEVER state a capability or limitation/i.test(p),
    "persona prompt should carry the anti-disclaimer rule",
  );
});

test("agentPersonaPrompt surfaces the unanswered-backlog hint when > 1", () => {
  const withBacklog = agentPersonaPrompt("Ada", style, false, {
    contactName: "Sujith",
    unansweredBacklog: 3,
  });
  assert.ok(
    /3 unanswered messages from Sujith/i.test(withBacklog),
    "expected the backlog hint to name the count + contact",
  );

  // 0/1 → no hint (single fresh message is the normal case).
  const single = agentPersonaPrompt("Ada", style, false, {
    contactName: "Sujith",
    unansweredBacklog: 1,
  });
  assert.ok(!/unanswered messages/i.test(single), "no hint for a single message");
});

// ── 5. countTrailingUnanswered (iMessage chronological transcript) ─────────

test("countTrailingUnanswered counts the trailing run of 'them:' lines", () => {
  assert.equal(
    countTrailingUnanswered("you: hey\nthem: you around?\nthem: ping\nthem: still there?"),
    3,
  );
  // A trailing owner reply ends the run.
  assert.equal(
    countTrailingUnanswered("them: hi\nyou: hey\nthem: cool"),
    1,
  );
  assert.equal(countTrailingUnanswered("you: only me\nyou: still me"), 0);
  assert.equal(countTrailingUnanswered(""), 0);
  // Unprefixed lines are ignored.
  assert.equal(countTrailingUnanswered("random note\nthem: hi\nthem: yo"), 2);
});
