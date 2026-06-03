// Regression tests for two conversation-quality bugs in natural.ts.
//
// BUG A (name fabrication — trust bug): the bot replied to a contact named
// Bhramari with "Happy anniversary Shiva, thanks man" — it INVENTED the name
// "Shiva" (a different known friend), because the sender's real name wasn't in
// context. detectBotTells must suppress a draft that addresses the contact by a
// first name absent from the inbound / contact-name / relationship context, and
// the persona must carry a hard NEVER-FABRICATE-A-NAME rule.
//
// BUG B (greeting/wish over-thinking): a simple anniversary/birthday/festival
// wish should get a short, casual thanks — not a paragraph, not a 1:1 escalation.
// shouldRespond must NOT suppress a genuine wish, and the persona must guide a
// short casual thanks.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  detectBotTells,
  extractVocativeNames,
  shouldRespond,
  agentPersonaPrompt,
  inferStyle,
} from "./natural.ts";

// ---------------------------------------------------------------------------
// BUG A — detectBotTells fabricated-name net
// ---------------------------------------------------------------------------

test("suppresses fabricated name not present in context (the Bhramari/Shiva bug)", () => {
  const v = detectBotTells(
    "Happy anniversary Shiva, thanks man",
    "Happy anniversary!", // inbound has no name
    { contactName: "Bhramari" },
  );
  assert.equal(v.ok, false, "fabricated name must be suppressed");
  assert.match(v.reason ?? "", /shiva/i);
});

test("suppresses fabricated vocative after 'thanks'", () => {
  const v = detectBotTells("thanks Rahul!", "happy birthday", {
    contactName: "Bhramari",
  });
  assert.equal(v.ok, false);
});

test("allows a name that IS the resolved contact name", () => {
  const v = detectBotTells("thanks Bhramari!", "happy anniversary", {
    contactName: "Bhramari",
  });
  assert.equal(v.ok, true, `wrongly suppressed: ${v.reason}`);
});

test("allows a name that the contact used in the inbound", () => {
  // Contact signs off with their own name; echoing it is fine.
  const v = detectBotTells("happy new year Arjun!", "happy new year - Arjun", {
    contactName: undefined,
  });
  assert.equal(v.ok, true, `wrongly suppressed: ${v.reason}`);
});

test("allows a name present in the relationship string", () => {
  const v = detectBotTells("thanks Sujith!", "happy anniversary", {
    relationship: "college friend Sujith",
  });
  assert.equal(v.ok, true, `wrongly suppressed: ${v.reason}`);
});

test("no-name warm reply is always allowed (the safe fallback)", () => {
  for (const draft of ["thank you! 🙏", "aw thanks!", "thanks man", "haha thanks 😊"]) {
    const v = detectBotTells(draft, "happy anniversary", { contactName: "Bhramari" });
    assert.equal(v.ok, true, `safe no-name reply wrongly suppressed: ${draft}`);
  }
});

test("does not false-positive on greeting + non-name word", () => {
  // "happy anniversary" → "anniversary" is not a name; "thanks again" → "again".
  for (const draft of [
    "happy anniversary 🙏",
    "thanks again!",
    "hey there",
    "good morning!",
    "thanks everyone",
  ]) {
    const v = detectBotTells(draft, "happy anniversary", { contactName: "Bhramari" });
    assert.equal(v.ok, true, `false positive on: ${draft} (${v.reason})`);
  }
});

test("backward compatible: no ctx → no fabricated-name suppression", () => {
  // Without context we can't know the name is wrong, so we must not suppress
  // (avoids regressing existing draft-only callers).
  const v = detectBotTells("thanks Shiva!");
  assert.equal(v.ok, true, `wrongly suppressed without ctx: ${v.reason}`);
});

test("extractVocativeNames pulls clear vocatives, skips stopwords", () => {
  assert.deepEqual(extractVocativeNames("happy anniversary Shiva"), ["shiva"]);
  assert.deepEqual(extractVocativeNames("thanks Rahul"), ["rahul"]);
  assert.deepEqual(extractVocativeNames("hey there"), []);
  assert.deepEqual(extractVocativeNames("thanks man"), []);
  assert.deepEqual(extractVocativeNames("just a normal sentence"), []);
});

// ---------------------------------------------------------------------------
// BUG B — wishes get a short casual thanks, never suppressed / over-thought
// ---------------------------------------------------------------------------

const WISHES = [
  "Happy anniversary!",
  "happy birthday 🎂",
  "Happy Diwali",
  "happy sankranti",
  "congrats!",
  "Congratulations on the new house",
  "puttinaroju subhakankshalu", // Telugu "happy birthday"
];

for (const w of WISHES) {
  test(`shouldRespond does NOT suppress a wish: ${JSON.stringify(w)}`, () => {
    const v = shouldRespond(w);
    assert.equal(v.respond, true, `wish wrongly suppressed: ${w}`);
  });
}

// ---------------------------------------------------------------------------
// Persona — both hard rules present
// ---------------------------------------------------------------------------

const style = inferStyle(["hey", "lol ok"]);

test("persona carries the NEVER-FABRICATE-A-NAME hard rule", () => {
  const p = agentPersonaPrompt("Shekhar", style, false, {});
  assert.match(p, /NEVER FABRICATE A NAME/i);
  assert.match(p, /do NOT use any name/i);
});

test("persona carries the celebratory-wish short-thanks guidance", () => {
  const p = agentPersonaPrompt("Shekhar", style, false, {});
  assert.match(p, /CELEBRATORY WISH RULE/i);
  assert.match(p, /one short, warm, casual thanks/i);
});

test("persona surfaces the known contact name as the only allowed name", () => {
  const p = agentPersonaPrompt("Shekhar", style, false, { contactName: "Bhramari" });
  assert.match(p, /This contact's name is "Bhramari"/);
  assert.match(p, /ONLY name you may use/i);
});

test("persona does NOT surface a phone-number-only contactName", () => {
  const p = agentPersonaPrompt("Shekhar", style, false, { contactName: "+15125551234" });
  assert.doesNotMatch(p, /ONLY name you may use/i);
});

test("group wish guidance tells the bot not to escalate to 1:1", () => {
  const p = agentPersonaPrompt("Shekhar", style, true, {});
  assert.match(p, /never turn a group wish into a private 1:1/i);
});
