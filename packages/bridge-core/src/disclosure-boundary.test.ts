// SECURITY-CRITICAL regression tests for the audience-aware disclosure
// boundary. Run with:
//   cd packages/bridge-core && npx tsx --test src/disclosure-boundary.test.ts
//
// The incident: the bot disclosed the owner's marital status to an
// UNVERIFIED contact who asked "are you married?", because owner facts +
// profile prose were injected into CONTACT replies and the persona was
// told to CONFIRM them. The fix:
//   1. agentPersonaPrompt is audience-aware. audience="contact" (the
//      default, fail-safe) gets a NON-DISCLOSURE directive and never an
//      instruction to confirm private facts. audience="owner" keeps full
//      factual access ("what's my anniversary?").
//   2. escalation-detector flags a non-owner asking about the owner's
//      relationship/family/location/schedule/travel as a SOFT
//      personal-fact probe (deflect-don't-confirm), NOT the hard
//      page-and-refuse tier.
//   3. social-graph's relatedBlock no longer has the "unless asks"
//      cross-contact escape hatch.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { agentPersonaPrompt, inferStyle } from "./natural.ts";
import {
  detectPersonalFactProbe,
  detectPromptInjection,
} from "./escalation-detector.ts";
import { formatRelatedBlock } from "./social-graph.ts";

const OWNER = "Shekhar";
const STYLE = inferStyle(["hey", "sup", "lol yeah"]);
const FACTS =
  "Owner facts (TRUE — never deny or contradict these): married to Maya; wedding anniversary June 3, 2017.";

// ── 1. Audience-aware persona ──

test("contact persona (default audience) carries the NON-DISCLOSURE directive", () => {
  const p = agentPersonaPrompt(OWNER, STYLE, false, { ownerFacts: FACTS });
  assert.ok(
    /NON-DISCLOSURE/i.test(p),
    "contact persona missing the non-disclosure directive",
  );
  // It must cover the protected categories.
  assert.ok(/marriage|married/i.test(p), "non-disclosure should cover marriage");
  assert.ok(/kids|family/i.test(p), "non-disclosure should cover family");
  assert.ok(/location|live|home/i.test(p), "non-disclosure should cover location");
  assert.ok(/schedule|travel|plans/i.test(p), "non-disclosure should cover schedule/travel/plans");
  // It must instruct DEFLECTION, not confirmation.
  assert.ok(/deflect/i.test(p), "non-disclosure should instruct deflection");
});

test("contact persona does NOT instruct confirming the owner's private facts", () => {
  const p = agentPersonaPrompt(OWNER, STYLE, false, { ownerFacts: FACTS });
  // The old leaky directive said, for a referenced fact, "respond as if
  // it's true". That instruction must NOT be present on the contact path.
  assert.ok(
    !/respond as if (?:it'?s )?true/i.test(p),
    "contact persona still tells the model to confirm facts",
  );
  // The facts may be injected as a VOICE anchor, but framed as do-not-disclose.
  if (p.includes("married to Maya")) {
    assert.ok(
      /do NOT disclose|non-disclosure/i.test(p),
      "facts injected on contact path without a do-not-disclose frame",
    );
  }
});

test("contact persona explicitly forbids fabricating a DENIAL too", () => {
  const p = agentPersonaPrompt(OWNER, STYLE, false, { ownerFacts: FACTS });
  // Anti-denial floor preserved in-prompt: never confirm AND never deny.
  assert.ok(
    /never confirm and never deny|never confirm AND never deny/i.test(p),
    "contact persona missing the never-confirm-never-deny floor",
  );
});

test("owner persona keeps FULL factual access (what's my anniversary?)", () => {
  const p = agentPersonaPrompt(OWNER, STYLE, false, {
    audience: "owner",
    ownerFacts: FACTS,
  });
  // The owner can ask their own facts and get a truthful answer.
  assert.ok(p.includes("married to Maya"), "owner persona dropped the facts");
  assert.ok(/TRUE/.test(p), "owner persona lost the ground-truth framing");
  assert.ok(
    /answer truthfully|answer his own|asking about his own/i.test(p),
    "owner persona should permit truthful self-answers",
  );
  // The owner path must NOT carry the contact non-disclosure directive.
  assert.ok(
    !/PRIVATE-FACT NON-DISCLOSURE/i.test(p),
    "owner persona wrongly carries the contact non-disclosure directive",
  );
});

test("audience defaults to contact (fail-safe) when omitted", () => {
  const omitted = agentPersonaPrompt(OWNER, STYLE, false, { ownerFacts: FACTS });
  const explicit = agentPersonaPrompt(OWNER, STYLE, false, {
    audience: "contact",
    ownerFacts: FACTS,
  });
  assert.ok(/NON-DISCLOSURE/i.test(omitted), "omitted audience not fail-safe to contact");
  assert.ok(/NON-DISCLOSURE/i.test(explicit), "explicit contact audience missing directive");
});

// ── 2. Personal-fact probe detector ──

const PROBES: Array<[string, string]> = [
  ["are you married?", "marital"],
  ["you married?", "marital"],
  ["who is he married to", "spouse"],
  ["what's your wife's name", "spouse"],
  ["do you have kids?", "family"],
  ["how many children do you have", "family"],
  ["where do you live", "location"],
  ["what's your home address", "location"],
  ["are you home alone", "location"],
  ["what's your schedule like", "schedule"],
  ["when are you traveling next", "travel"],
];

test("personal-fact probes are flagged as soft personal-fact-probe", () => {
  for (const [text] of PROBES) {
    const v = detectPersonalFactProbe(text);
    assert.ok(v, `expected probe to fire: ${JSON.stringify(text)}`);
    assert.equal(v!.kind, "personal-fact-probe");
  }
});

test("'who is he married to' is a personal-fact probe (the asked-spec case)", () => {
  const v = detectPersonalFactProbe("who is he married to");
  assert.ok(v, "spouse-identity probe should fire");
  assert.equal(v!.kind, "personal-fact-probe");
});

test("a friendly 'you married?' does NOT trip the hard SSN/page tier", () => {
  // The soft probe must not also classify as a hard prompt-injection
  // (which pages the owner + cold-refuses). A sweet question shouldn't page.
  assert.equal(
    detectPromptInjection("are you married?"),
    null,
    "marital probe wrongly escalated to the hard prompt-injection tier",
  );
});

const NON_PROBES = [
  "i'm married too!",
  "we just had a baby",
  "i'm traveling next week",
  "happy anniversary!",
  "where are you headed this weekend",
  "what's the plan for dinner",
];

test("ordinary chatter (about the CONTACT) does not over-match", () => {
  for (const b of NON_PROBES) {
    const v = detectPersonalFactProbe(b);
    assert.equal(v, null, `false positive: ${JSON.stringify(b)} → ${v?.reason}`);
  }
});

// ── 3. social-graph relatedBlock escape hatch removed ──

test("relatedBlock no longer has the 'unless asks' cross-contact hatch", () => {
  const block = formatRelatedBlock([
    {
      jid: "1555@s.whatsapp.net",
      contactName: "Madhu",
      ts: Date.now(),
      text: "asked about Sarah for the refi intro",
      fromMe: false,
      topics: ["sarah", "refi"],
    },
  ]);
  assert.ok(block.length > 0, "fixture should produce a block");
  assert.ok(
    !/unless (?:the contact |they )?(?:explicitly )?asks?/i.test(block),
    "relatedBlock still contains the 'unless asks' escape hatch",
  );
  // The hardened directive forbids disclosure even if asked.
  assert.ok(
    /even if asked/i.test(block),
    "relatedBlock missing the 'even if asked' hardening",
  );
  assert.ok(
    /NEVER mention, name, or quote/i.test(block),
    "relatedBlock missing the no-mention directive",
  );
});
