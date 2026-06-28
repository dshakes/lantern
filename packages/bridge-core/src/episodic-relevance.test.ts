// Tests for #5 — episode relevance ranking (token-overlap with the inbound,
// recency as the tiebreak) so an on-topic older episode isn't dropped for
// newer irrelevant ones.
//   cd packages/bridge-core && node --import=tsx/esm --test src/episodic-relevance.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { rankEpisodesByRelevance, type Episode } from "./episodic-memory.ts";

const mk = (topic: string, outcome: string, ts: number): Episode => ({
  jid: "x", date: "2026-06-01", topic, outcome, ts,
});

test("#5 an on-topic older episode outranks newer off-topic ones", () => {
  const now = Date.now();
  const episodes: Episode[] = [
    mk("lunch plans", "grabbed tacos downtown", now - 1_000),
    mk("gym schedule", "moved leg day to friday", now - 2_000),
    mk("weekend hike", "did the ridge trail", now - 3_000),
    // 20 days old but the only one about a refi:
    mk("house refi", "gave them Sarah the mortgage agent's number", now - 20 * 86_400_000),
  ];
  const ranked = rankEpisodesByRelevance(episodes, "any update on the house refi / mortgage?", 2);
  assert.equal(ranked[0].topic, "house refi", "on-topic older episode should rank first");
});

test("#5 with no usable inbound tokens, ranking is pure recency (newest first)", () => {
  const episodes = [
    mk("t", "o1", 100),
    mk("t", "o3", 300),
    mk("t", "o2", 200),
  ];
  const ranked = rankEpisodesByRelevance(episodes, "ok", 3); // "ok" is a stopword → no tokens
  assert.deepEqual(ranked.map((e) => e.ts), [300, 200, 100]);
});

test("#5 single/empty input is returned untouched (sliced)", () => {
  assert.deepEqual(rankEpisodesByRelevance([], "anything", 5), []);
  const one = [mk("t", "o", 1)];
  assert.deepEqual(rankEpisodesByRelevance(one, "anything", 5), one);
});
