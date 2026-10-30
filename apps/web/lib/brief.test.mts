import test from "node:test";
import assert from "node:assert/strict";
import { applyRank, buildBriefItems, buildRankPrompt, parseRank, rankCacheKey } from "./brief.ts";

const now = Date.parse("2026-10-30T12:00:00Z");
const items = buildBriefItems({
  now,
  holds: [{ id: "d1", displayName: "Raju", inboundText: "can you send 70k?", draftText: "sure", channel: "whatsapp", createdAt: "2026-10-30T10:00:00Z" }],
  lifeEvents: [{ id: "e1", kind: "fraud_alert", summary: "Card charge $900", urgency: "high", channel: "imessage", createdAt: "2026-10-30T11:00:00Z" }],
  commitments: [{ id: "c1", title: "Send the deck", urgency: "medium", createdAt: "2026-10-29T00:00:00Z" }],
  threads: [
    { id: "t1", label: "Madhu waiting 3d", channel: "whatsapp" },
    { id: "t1", label: "Madhu waiting 3d", channel: "whatsapp" },
  ],
});

test("base order: held replies first; threads de-duplicated", () => {
  assert.equal(items[0].key, "hold:d1");
  assert.equal(items.length, 4);
  assert.equal(items.filter((i) => i.kind === "thread").length, 1);
});

test("rank may only reorder and annotate existing items", () => {
  const raw = '{"order":["life_event:e1","bogus:1","hold:d1"],"why":{"life_event:e1":"possible fraud","bogus:1":"x"}}';
  const ranked = applyRank(items, parseRank(raw, items));
  assert.deepEqual(ranked.slice(0, 2).map((i) => i.key), ["life_event:e1", "hold:d1"]);
  assert.equal(ranked.length, items.length);
  assert.equal(ranked[0].why, "possible fraud");
  assert.ok(!ranked.some((i) => i.key === "bogus:1"));
});

test("bad ranker output degrades to the base order", () => {
  assert.equal(parseRank("I think the fraud one", items), null);
  assert.deepEqual(applyRank(items, null).map((i) => i.key), items.map((i) => i.key));
});

test("prompt lists every key; cache key is order-independent", () => {
  const p = buildRankPrompt(items);
  for (const i of items) assert.ok(p.includes(`[${i.key}]`));
  assert.equal(rankCacheKey(items), rankCacheKey([...items].reverse()));
});
