import { describe, it, expect } from "vitest";
import { matchesRecentSend, selfChatBreakerDecision } from "./session.js";

// Regression for the self-chat runaway: the bot re-ingested its OWN self-chat
// sends as fresh owner queries and replied to itself — 678 chat.db rows / 109
// LLM runs in one hour, all self-chat, ZERO contact sends. Two independent
// defenses:
//   1. matchesRecentSend — a long reply sent over SMS Text Message Forwarding
//      is SEGMENTED into chat.db rows; each fragment byte-differs from the full
//      send and evaded a full-message-equality echo guard. Fragment (substring)
//      matching closes that hole.
//   2. selfChatBreakerDecision — a hard sliding-window cap so ANY loop, whatever
//      the echo guard misses, is self-limiting.

const NOW = 1_800_000_000_000;
const TTL = 24 * 60 * 60_000;

describe("matchesRecentSend — segment-aware echo guard", () => {
  const sends = [
    { text: "old unrelated ack 👍", ts: NOW - 60_000 },
    {
      // A long brief the bot sent; SMS splits it into pieces on delivery.
      text: "🗂 on your plate (50): 1 Confirm to Nagendra whether the on-site meeting stands. 2 Decide whether to push the Crispy Cones Brambleton launch. 3 Reply: Meeting Link - Factored.",
      ts: NOW - 30_000,
    },
  ];

  it("matches an exact (whitespace/case-normalized) recent send", () => {
    expect(matchesRecentSend("OLD   unrelated   ACK 👍", sends, { now: NOW, ttlMs: TTL })).toBe(true);
  });

  it("matches a long SMS-segmented FRAGMENT that is a substring of a recent send", () => {
    // This exact substring arrives as its own chat.db row after segmentation.
    const fragment = "Decide whether to push the Crispy Cones Brambleton launch.";
    expect(matchesRecentSend(fragment, sends, { now: NOW, ttlMs: TTL })).toBe(true);
  });

  it("does NOT swallow a genuine short owner message (below the fragment floor)", () => {
    expect(matchesRecentSend("ok", sends, { now: NOW, ttlMs: TTL })).toBe(false);
    expect(matchesRecentSend("what's up", sends, { now: NOW, ttlMs: TTL })).toBe(false);
    // A long owner message that is NOT a substring of any send is fresh input.
    expect(
      matchesRecentSend("hey can you find my passport expiry date please", sends, { now: NOW, ttlMs: TTL }),
    ).toBe(false);
  });

  it("respects the TTL and empty input", () => {
    const stale = [{ text: "🗂 on your plate (50): 1 Confirm to Nagendra whether the on-site meeting stands.", ts: NOW - TTL - 1 }];
    expect(matchesRecentSend("Confirm to Nagendra whether the on-site meeting stands.", stale, { now: NOW, ttlMs: TTL })).toBe(false);
    expect(matchesRecentSend("   ", sends, { now: NOW, ttlMs: TTL })).toBe(false);
  });

  it("custom fragMinLen floor is honored", () => {
    const s = [{ text: "the local index is only showing older ones (jun/may)", ts: NOW }];
    expect(matchesRecentSend("older ones", s, { now: NOW, ttlMs: TTL, fragMinLen: 5 })).toBe(true); // 10 chars ≥ 5
    expect(matchesRecentSend("older ones", s, { now: NOW, ttlMs: TTL, fragMinLen: 24 })).toBe(false); // below default floor
  });
});

describe("selfChatBreakerDecision — hard loop cap", () => {
  const OPTS = { windowMs: 120_000, max: 12 };

  it("allows normal bursts under the cap and records each attempt", () => {
    let times: number[] = [];
    for (let i = 0; i < 12; i++) {
      const d = selfChatBreakerDecision(times, NOW + i * 1000, OPTS);
      expect(d.tripped).toBe(false);
      times = d.times;
    }
    expect(times.length).toBe(12);
  });

  it("trips once the window is at capacity, without recording further attempts", () => {
    const times = Array.from({ length: 12 }, (_, i) => NOW + i * 100); // 12 within 1.2s
    const d = selfChatBreakerDecision(times, NOW + 1300, OPTS);
    expect(d.tripped).toBe(true);
    expect(d.times.length).toBe(12); // stays capped; the tripped attempt is not added
  });

  it("self-heals: old timestamps age out of the window and replies resume", () => {
    const old = Array.from({ length: 12 }, (_, i) => NOW + i * 100); // all ~NOW
    // 3 minutes later, all 12 are outside the 2-min window → pruned → allowed.
    const d = selfChatBreakerDecision(old, NOW + 3 * 60_000, OPTS);
    expect(d.tripped).toBe(false);
    expect(d.times).toEqual([NOW + 3 * 60_000]);
  });

  it("caps a runaway: rapid-fire attempts trip after `max`", () => {
    let times: number[] = [];
    let allowed = 0;
    for (let i = 0; i < 200; i++) {
      const d = selfChatBreakerDecision(times, NOW + i, OPTS); // 200 in 200ms (a loop)
      if (!d.tripped) allowed++;
      times = d.times;
    }
    expect(allowed).toBe(12); // only the first 12 got through; the loop was capped
  });
});
