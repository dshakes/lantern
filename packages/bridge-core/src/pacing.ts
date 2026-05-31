// Conversation-pace mirror.
//
// Humans don't reply at LLM speed. With close friends, replies are
// near-instant during active conversations and slow during idle
// stretches; with work contacts they're more measured. The bot
// currently replies as fast as the LLM round-trips — a dead
// giveaway in active threads where 3s feels too fast and in idle
// threads where instant feels off.
//
// This module computes the natural reply cadence per-contact from
// recent message timestamps and returns a hold duration the caller
// applies BEFORE sending. Two inputs:
//   1. The owner's prior reply latency to THIS contact (how fast
//      they typically respond).
//   2. The current thread state (is this an active back-and-forth or
//      a cold restart?).
//
// Output is in milliseconds, capped to a sensible range (no
// 30-second pauses on quick chats, no zero-delay sends on quiet
// threads) and jittered ±20% to avoid robotic regularity.

export interface PaceContext {
  // Recent reply latencies (ms) — how long the OWNER typically takes
  // to reply to messages from this contact. Compute from chat history:
  // for each inbound→owner-reply pair, store (owner_reply_ts -
  // inbound_ts). Pass the most recent 10-20 samples.
  ownerLatencies: number[];
  // Milliseconds since the most recent inbound from this contact.
  // 0 = just arrived. > 30 min = cold restart territory.
  msSinceLastInbound: number;
  // Are we in an active back-and-forth? Heuristic: 2+ exchanges in
  // the last 5 minutes. Active conversations get tighter pacing.
  isActiveBurst: boolean;
}

export interface PaceVerdict {
  // Milliseconds to hold before sending. Always >= 0.
  holdMs: number;
  // Human-readable reason — useful for logs / tuning.
  reason: string;
}

// Hold floor: never SLOWER than this. Some delay is good (humans
// don't reply in 100ms) but excessive holds make the bot feel
// distracted.
const FLOOR_MS = 600;
// Hold ceiling: never WAIT MORE than this. Beyond ~25s the contact
// thinks the reply isn't coming. (The async LLM call already takes
// 1-3s in most cases; this is the ADDITIONAL hold.)
const CEILING_MS = 25_000;
// Active-burst clamp: when we're in a fast back-and-forth, hold
// shorter than the median so we don't break the rhythm.
const BURST_FAST_MS = 1_500;
const BURST_FAST_CEIL_MS = 5_000;

/**
 * Compute the recommended hold duration for the next outbound reply.
 *
 * Algorithm:
 *   1. Compute median owner reply latency (robust to outliers).
 *   2. Pick a base hold:
 *      - active burst → ~50% of median, capped low
 *      - cold restart (msSinceLastInbound > 30 min) → 70% of median
 *      - normal → ~80% of median
 *   3. Apply ±20% jitter so consecutive replies don't all hold the
 *      same length (humans aren't metronomes).
 *   4. Clamp to [FLOOR, CEILING].
 */
export function computeHold(ctx: PaceContext): PaceVerdict {
  const samples = ctx.ownerLatencies.filter((n) => Number.isFinite(n) && n > 0);
  if (samples.length === 0) {
    // No data — moderate default with jitter so we don't all fire
    // at exactly the same delay.
    const base = 1_800;
    return jitter(base, "no-prior-latency-samples");
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  let base: number;
  let reason: string;
  if (ctx.isActiveBurst) {
    base = Math.min(median * 0.5, BURST_FAST_MS);
    base = Math.min(base, BURST_FAST_CEIL_MS);
    reason = `active-burst (median ${median}ms × 0.5)`;
  } else if (ctx.msSinceLastInbound > 30 * 60_000) {
    base = median * 0.7;
    reason = `cold-restart (median ${median}ms × 0.7)`;
  } else {
    base = median * 0.8;
    reason = `normal (median ${median}ms × 0.8)`;
  }

  return jitter(base, reason);
}

function jitter(baseMs: number, reason: string): PaceVerdict {
  const jitterPct = 0.4 * Math.random() - 0.2; // -20% to +20%
  const held = Math.round(baseMs * (1 + jitterPct));
  const clamped = Math.max(FLOOR_MS, Math.min(CEILING_MS, held));
  return { holdMs: clamped, reason: `${reason}, jitter ${Math.round(jitterPct * 100)}%` };
}

/**
 * Helper: pull owner reply latencies from a transcript represented
 * as [{ fromMe, ts }] entries. Returns the most recent N latencies
 * (inbound→ownerReply gaps), bounded to ignore overnight pauses
 * (> 4 hours) which would skew the median.
 */
export function latenciesFromTranscript(
  msgs: Array<{ fromMe: boolean; ts: number }>,
  maxSamples = 15,
): number[] {
  const out: number[] = [];
  for (let i = msgs.length - 1; i >= 1 && out.length < maxSamples; i--) {
    const cur = msgs[i];
    const prev = msgs[i - 1];
    if (cur.fromMe && !prev.fromMe) {
      const gap = cur.ts - prev.ts;
      if (gap > 0 && gap < 4 * 60 * 60_000) out.push(gap);
    }
  }
  return out;
}
