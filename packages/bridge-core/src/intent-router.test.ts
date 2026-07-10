// Tests for the Phase 2c intent-reasoning router: flag gate (default OFF),
// prompt build, tolerant parse, decision→handler map, and the classify
// orchestrator (throwaway session key, fail-safe fallback, bounded timeout).
//   cd packages/bridge-core && npx tsx --test src/intent-router.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  intentRouterEnabled,
  buildIntentPrompt,
  parseIntentDecision,
  forcedHandler,
  classifyIntent,
  type IntentLLM,
} from "./intent-router.ts";

// ── FLAG GATE: default OFF (this is the "byte-identical when off" floor) ──
test("intentRouterEnabled: default OFF for unset / falsey / garbage", () => {
  assert.equal(intentRouterEnabled({}), false); // unset → OFF
  assert.equal(intentRouterEnabled({ LANTERN_INTENT_ROUTER: "" }), false);
  assert.equal(intentRouterEnabled({ LANTERN_INTENT_ROUTER: "0" }), false);
  assert.equal(intentRouterEnabled({ LANTERN_INTENT_ROUTER: "off" }), false);
  assert.equal(intentRouterEnabled({ LANTERN_INTENT_ROUTER: "false" }), false);
  assert.equal(intentRouterEnabled({ LANTERN_INTENT_ROUTER: "no" }), false);
  assert.equal(intentRouterEnabled({ LANTERN_INTENT_ROUTER: "maybe" }), false);
});

test("intentRouterEnabled: ON only for explicit truthy tokens", () => {
  assert.equal(intentRouterEnabled({ LANTERN_INTENT_ROUTER: "1" }), true);
  assert.equal(intentRouterEnabled({ LANTERN_INTENT_ROUTER: "true" }), true);
  assert.equal(intentRouterEnabled({ LANTERN_INTENT_ROUTER: "on" }), true);
  assert.equal(intentRouterEnabled({ LANTERN_INTENT_ROUTER: "yes" }), true);
  assert.equal(intentRouterEnabled({ LANTERN_INTENT_ROUTER: "  TRUE  " }), true); // trim + case
  assert.equal(intentRouterEnabled({ LANTERN_INTENT_ROUTER: "On" }), true);
});

// ── PROMPT BUILD (pure) ──
test("buildIntentPrompt: embeds the message safely and names the intents", () => {
  const p = buildIntentPrompt('don\'t tell "Ravi" where I am');
  assert.match(p, /disclosure_deny/);
  assert.match(p, /recap/);
  assert.match(p, /self_context/);
  assert.match(p, /thread_peek/);
  assert.match(p, /normal_reply/);
  // Message is JSON-encoded so embedded quotes can't break the prompt shape.
  assert.match(p, /Owner's message: /);
  assert.ok(p.includes(JSON.stringify('don\'t tell "Ravi" where I am')));
});

// ── TOLERANT PARSE (pure, fail-safe) ──
test("parseIntentDecision: each known kind", () => {
  assert.deepEqual(parseIntentDecision('{"kind":"recap"}'), { kind: "recap" });
  assert.deepEqual(parseIntentDecision('{"kind":"self_context"}'), { kind: "self_context" });
  assert.deepEqual(parseIntentDecision('{"kind":"thread_peek"}'), { kind: "thread_peek" });
  assert.deepEqual(parseIntentDecision('{"kind":"normal_reply"}'), { kind: "normal_reply" });
});

test("parseIntentDecision: disclosure_deny with target + deny", () => {
  assert.deepEqual(parseIntentDecision('{"kind":"disclosure_deny","target":"Ravi","deny":true}'), {
    kind: "disclosure_deny",
    target: "Ravi",
    deny: true,
  });
  // reverse (allow again)
  assert.deepEqual(parseIntentDecision('{"kind":"disclosure_deny","target":"Sam","deny":false}'), {
    kind: "disclosure_deny",
    target: "Sam",
    deny: false,
  });
});

test("parseIntentDecision: disclosure_deny defaults deny=true when omitted/garbage (privacy-protective)", () => {
  assert.deepEqual(parseIntentDecision('{"kind":"disclosure_deny","target":"Ravi"}'), {
    kind: "disclosure_deny",
    target: "Ravi",
    deny: true,
  });
  assert.deepEqual(parseIntentDecision('{"kind":"disclosure_deny","target":"Ravi","deny":"nope"}'), {
    kind: "disclosure_deny",
    target: "Ravi",
    deny: true,
  });
});

test("parseIntentDecision: disclosure_deny without a usable target → null (fallback)", () => {
  assert.equal(parseIntentDecision('{"kind":"disclosure_deny","deny":true}'), null);
  assert.equal(parseIntentDecision('{"kind":"disclosure_deny","target":"   ","deny":true}'), null);
  assert.equal(parseIntentDecision('{"kind":"disclosure_deny","target":42,"deny":true}'), null);
});

test("parseIntentDecision: extracts JSON embedded in prose", () => {
  assert.deepEqual(
    parseIntentDecision('Sure — here you go: {"kind":"recap"} hope that helps'),
    { kind: "recap" },
  );
});

test("parseIntentDecision: target clamped to 100 chars", () => {
  const long = "R".repeat(250);
  const d = parseIntentDecision(`{"kind":"disclosure_deny","target":"${long}","deny":true}`);
  assert.equal(d?.kind, "disclosure_deny");
  if (d?.kind === "disclosure_deny") assert.equal(d.target.length, 100);
});

test("parseIntentDecision: unusable input → null (regex-gate fallback)", () => {
  assert.equal(parseIntentDecision(null), null);
  assert.equal(parseIntentDecision(undefined), null);
  assert.equal(parseIntentDecision(""), null);
  assert.equal(parseIntentDecision("no json here at all"), null);
  assert.equal(parseIntentDecision("{not valid json}"), null);
  assert.equal(parseIntentDecision('{"kind":"delete_everything"}'), null); // unknown kind
  assert.equal(parseIntentDecision('{"kind":123}'), null);
  assert.equal(parseIntentDecision("}{"), null);
});

// ── DECISION → HANDLER MAP (pure routing table) ──
test("forcedHandler: only disclosure_deny + recap are force-routed", () => {
  assert.equal(forcedHandler({ kind: "disclosure_deny", target: "Ravi", deny: true }), "disclosure_deny");
  assert.equal(forcedHandler({ kind: "recap" }), "recap");
  // classified for precision, but fall through to the regex gates (the floor):
  assert.equal(forcedHandler({ kind: "self_context" }), null);
  assert.equal(forcedHandler({ kind: "thread_peek" }), null);
  assert.equal(forcedHandler({ kind: "normal_reply" }), null);
  assert.equal(forcedHandler(null), null);
});

// ── CLASSIFY ORCHESTRATOR (mock LLM — no live model) ──
const okLLM = (reply: string): IntentLLM => async () => reply;

test("classifyIntent: routes disclosure phrasings the wordlist misses", async () => {
  // Phrasings the static detectDisclosureDeny list would not match, but the
  // model reasons about — here the mock returns what such a model would.
  for (const phrasing of [
    "keep Priya in the dark about my whereabouts",
    "if Ravi asks, act like you have no idea where I am",
    "my location stays between us — don't share it with mom",
  ]) {
    const d = await classifyIntent(phrasing, okLLM('{"kind":"disclosure_deny","target":"Ravi","deny":true}'));
    assert.equal(d?.kind, "disclosure_deny");
    assert.equal(forcedHandler(d), "disclosure_deny");
  }
});

test("classifyIntent: reverse disclosure (allow again) preserves deny=false", async () => {
  const d = await classifyIntent(
    "you can let Sam know where I am again",
    okLLM('{"kind":"disclosure_deny","target":"Sam","deny":false}'),
  );
  assert.deepEqual(d, { kind: "disclosure_deny", target: "Sam", deny: false });
});

test("classifyIntent: recap / self_context / thread_peek plumb through", async () => {
  assert.equal((await classifyIntent("bring me up to speed", okLLM('{"kind":"recap"}')))?.kind, "recap");
  assert.equal((await classifyIntent("remind me what I was heads-down on", okLLM('{"kind":"self_context"}')))?.kind, "self_context");
  assert.equal((await classifyIntent("what was mom going on about", okLLM('{"kind":"thread_peek"}')))?.kind, "thread_peek");
});

test("classifyIntent: malformed / null / empty LLM output → null (fallback to gates)", async () => {
  assert.equal(await classifyIntent("hey", okLLM("totally not json")), null);
  assert.equal(await classifyIntent("hey", async () => null), null);
  assert.equal(await classifyIntent("hey", okLLM('{"kind":"nonsense"}')), null);
});

test("classifyIntent: LLM throwing never propagates → null", async () => {
  const boom: IntentLLM = async () => { throw new Error("provider down"); };
  assert.equal(await classifyIntent("hey", boom), null);
});

test("classifyIntent: empty message short-circuits without calling the LLM", async () => {
  let called = false;
  const spy: IntentLLM = async () => { called = true; return '{"kind":"recap"}'; };
  assert.equal(await classifyIntent("   ", spy), null);
  assert.equal(called, false);
});

test("classifyIntent: throwaway session key, no tools, no web search (no session pollution)", async () => {
  const seen: Array<{ key: string; opts: unknown }> = [];
  const spy: IntentLLM = async (key, _text, _hint, opts) => {
    seen.push({ key, opts });
    return '{"kind":"normal_reply"}';
  };
  await classifyIntent("a", spy, { now: () => 111 });
  await classifyIntent("b", spy, { now: () => 222 });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].key, "owner::intent::111");
  assert.equal(seen[1].key, "owner::intent::222");
  assert.notEqual(seen[0].key, seen[1].key); // fresh key each call — never a contact's live session
  assert.deepEqual(seen[0].opts, { withTools: false, webSearch: false, timeoutMs: 6000 });
});

test("classifyIntent: hung LLM is bounded → null (never blocks the reply path)", async () => {
  const hang: IntentLLM = () => new Promise(() => {}); // never resolves
  const started = Date.now();
  const d = await classifyIntent("hey", hang, { timeoutMs: 25 });
  assert.equal(d, null);
  assert.ok(Date.now() - started < 1000, "returned well before any real model timeout");
});
