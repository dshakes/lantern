// Tests for the Attention Engine: prompt building, tolerant ranking parse,
// and the rank-aware unified Brief (threads + LLM order + why lines).
//   cd packages/bridge-core && npx tsx --test src/attention.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildAttentionPrompt,
  parseAttentionRanking,
  candidateIds,
  refId,
  type WaitingThread,
} from "./attention.ts";
import { buildBrief, parseActionReply, type BriefInput } from "./command-center.ts";

const WAITING: WaitingThread[] = [
  { contactKey: "+15125551234", displayName: "Madhu", channel: "imessage", daysWaiting: 3, lastInbound: "did you see the deck?", vip: true },
  { contactKey: "raju@s.whatsapp.net", displayName: "Raju", channel: "whatsapp", daysWaiting: 1 },
];

function baseInput(): BriefInput {
  return {
    now: new Date(2026, 6, 6, 9, 0, 0),
    drafts: [{ id: "d1", to: "Sam", preview: "sounds good, see you then" }],
    commitments: [
      { id: "c1", title: "renew passport", status: "open", urgency: "high" } as BriefInput["commitments"][number],
    ],
    agentActivity: [],
    autoActions: [],
    fyi: [],
    waiting: WAITING,
  } as unknown as BriefInput;
}

// ── prompt ──────────────────────────────────────────────────────────────────

test("buildAttentionPrompt lists every candidate with its refId and demands strict JSON", () => {
  const p = buildAttentionPrompt({ drafts: baseInput().drafts, commitments: baseInput().commitments }, WAITING, new Date());
  assert.match(p, /draft:d1/);
  assert.match(p, /commitment:c1/);
  assert.match(p, /thread:\+15125551234/);
  assert.match(p, /\[VIP\]/);
  assert.match(p, /STRICT JSON/);
  assert.match(p, /Never invent/);
});

// ── parse ───────────────────────────────────────────────────────────────────

test("parseAttentionRanking: happy path, filters unknown ids, clamps whys", () => {
  const valid = new Set(["draft:d1", "commitment:c1", "thread:+15125551234"]);
  const raw = `Sure! Here you go:\n{"order":["thread:+15125551234","bogus:x","draft:d1","draft:d1"],"why":{"thread:+15125551234":"vip waiting three days","bogus:x":"nope","commitment:c1":"${"x".repeat(200)}"}}`;
  const r = parseAttentionRanking(raw, valid);
  assert.ok(r);
  assert.deepEqual(r.order, ["thread:+15125551234", "draft:d1"]); // unknown + dupes dropped
  assert.equal(r.whys["thread:+15125551234"], "vip waiting three days");
  assert.equal(r.whys["bogus:x"], undefined);
  assert.ok(r.whys["commitment:c1"].length <= 60);
});

test("parseAttentionRanking: garbage → null (deterministic order stands)", () => {
  const valid = new Set(["draft:d1"]);
  assert.equal(parseAttentionRanking("no json here", valid), null);
  assert.equal(parseAttentionRanking('{"order":[]}', valid), null);
  assert.equal(parseAttentionRanking('{"order":"draft:d1"}', valid), null);
  assert.equal(parseAttentionRanking('{"order":["unknown:z"]}', valid), null);
});

test("candidateIds covers all three kinds", () => {
  const ids = candidateIds({ drafts: baseInput().drafts, commitments: baseInput().commitments }, WAITING);
  assert.deepEqual(
    [...ids].sort(),
    ["commitment:c1", "draft:d1", "thread:+15125551234", "thread:raju@s.whatsapp.net"].sort(),
  );
});

// ── rank-aware Brief ────────────────────────────────────────────────────────

test("buildBrief renders waiting threads (VIP first) with draft/skip grammar", () => {
  const view = buildBrief(baseInput());
  assert.match(view.text, /Madhu 👑 waiting 3d/);
  assert.match(view.text, /did you see the deck\?/);
  const madhu = view.items.find((i) => i.ref === "thread" && i.id === "+15125551234");
  assert.ok(madhu);
  assert.equal(madhu.defaultAction, "draft");
  // Deterministic order: drafts, commitments, then threads VIP-first.
  const kinds = view.items.map((i) => i.ref);
  assert.deepEqual(kinds, ["draft", "commitment", "thread", "thread"]);
});

test("buildBrief honors rankedIds across kinds and renders whys", () => {
  const input = baseInput();
  input.rankedIds = [refId("thread", "+15125551234"), refId("commitment", "c1")];
  input.whys = { [refId("thread", "+15125551234")]: "vip waiting three days" };
  const view = buildBrief(input);
  assert.equal(view.items[0].ref, "thread"); // LLM promoted the VIP thread over the draft
  assert.equal(view.items[1].ref, "commitment");
  assert.equal(view.items[2].ref, "draft"); // unranked keeps deterministic order after ranked
  assert.match(view.text, /· vip waiting three days/);
});

test("thread action grammar: bare n drafts; 'draft 2' verb-first; 'n skip' skips", () => {
  const view = buildBrief(baseInput());
  const madhuN = view.items.find((i) => i.ref === "thread" && i.id === "+15125551234")!.n;
  const bare = parseActionReply(String(madhuN), view.items);
  assert.equal(bare?.action, "draft");
  const verbFirst = parseActionReply(`draft ${madhuN}`, view.items);
  assert.equal(verbFirst?.action, "draft");
  assert.equal(verbFirst?.item.id, "+15125551234");
  const skip = parseActionReply(`${madhuN} skip`, view.items);
  assert.equal(skip?.action, "skip");
  // "draft <n>" for a NON-thread item falls through to normal parsing, not draft.
  const draftOnDraft = parseActionReply("draft 1", view.items);
  assert.notEqual(draftOnDraft?.action, "draft");
});
