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
  // OPTIONAL. Local hour-of-day (0-23) at the OWNER's location. When
  // provided, a gentle time-of-day multiplier nudges the hold: people
  // reply a touch quicker in peak-active midday hours and slower
  // (distracted) in the wind-down evening. Omit → no time adjustment.
  // Note: quiet hours (01:00-06:00) are handled upstream by the
  // overnight-replay queue; this multiplier only shapes non-quiet hours
  // (and applies a higher floor to the 00:00-01:00 / 06:00-10:00 edges).
  localHour?: number;
  // OPTIONAL. The inbound tripped the urgency detector ("URGENT", "asap
  // please", "on priority"). A real person answers an urgent ping fast — so
  // we collapse the hold to the floor rather than the usual cadence delay.
  urgent?: boolean;
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
// 3s minimum: a real person reads, thinks, and types — sub-second replies are
// the #1 bot-tell. This is ADDITIONAL hold on top of the 1-3s LLM call, so the
// perceived floor is ~4-6s, which reads as human. (Was 600ms — far too fast.)
const FLOOR_MS = 3_000;
// Hold ceiling: never WAIT MORE than this. Beyond ~25s the contact
// thinks the reply isn't coming. (The async LLM call already takes
// 1-3s in most cases; this is the ADDITIONAL hold.)
const CEILING_MS = 25_000;
// Active-burst clamp: in a fast back-and-forth, hold shorter than the median so
// we don't break the rhythm — but still a couple seconds (humans don't fire
// instantly even mid-burst).
const BURST_FAST_MS = 2_500;
const BURST_FAST_CEIL_MS = 6_000;

// Time-of-day multipliers. Gentle + bounded — the goal is a believable
// nudge, not a dramatic swing. Quiet hours (01:00-06:00) never reach
// here (overnight-replay queue owns them); the curve covers the rest of
// the day and gives the post-wake / pre-quiet edge hours a higher floor.
const TOD_PEAK_MULT = 0.7; // ~10:00-16:00 — phone in hand, quicker replies
const TOD_EVENING_MULT = 1.5; // ~21:00-00:00 — winding down, distracted
const TOD_EDGE_FLOOR_MS = 4_000; // overnight-edge floor (00:00-01:00 / 06:00-10:00) — slower when just-woken/winding-down

/**
 * Gentle time-of-day multiplier for the reply hold, keyed on the owner's
 * LOCAL hour (0-23). Bounded to [0.7, 1.5]. Returns 1.0 when the hour is
 * unknown/out of range so callers that don't pass an hour are unaffected.
 *
 * Curve:
 *   10:00-16:00  → 0.7  (peak-active: a bit quicker)
 *   16:00-21:00  → ramps 0.7 → 1.5 across the afternoon→evening
 *   21:00-24:00  → 1.5  (wind-down: slower, distracted)
 *   00:00-01:00  → 1.5  (late night tail; quiet starts at 01:00)
 *   06:00-10:00  → ramps 1.5 → 0.7 (waking up)
 */
export function timeOfDayMultiplier(localHour?: number): number {
  if (localHour == null || !Number.isFinite(localHour)) return 1.0;
  const h = ((Math.floor(localHour) % 24) + 24) % 24;
  // Peak-active midday.
  if (h >= 10 && h < 16) return TOD_PEAK_MULT;
  // Wind-down evening through the late-night tail before quiet hours.
  if (h >= 21 || h < 1) return TOD_EVENING_MULT;
  // Afternoon ramp 16→21: 0.7 climbing to 1.5.
  if (h >= 16 && h < 21) {
    const t = (h - 16) / (21 - 16);
    return TOD_PEAK_MULT + t * (TOD_EVENING_MULT - TOD_PEAK_MULT);
  }
  // Morning ramp 6→10: 1.5 easing down to 0.7 as the day starts.
  if (h >= 6 && h < 10) {
    const t = (h - 6) / (10 - 6);
    return TOD_EVENING_MULT - t * (TOD_EVENING_MULT - TOD_PEAK_MULT);
  }
  // 01:00-06:00 — quiet hours; shouldn't reach here, neutral if it does.
  return 1.0;
}

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
  // Urgent inbound — answer fast. Collapse to the floor (still jittered so
  // it's not a robotic exact value); skip the cadence math entirely.
  if (ctx.urgent) {
    return jitter(FLOOR_MS, "urgent — minimal hold", FLOOR_MS);
  }
  const todMult = timeOfDayMultiplier(ctx.localHour);
  // Higher floor at the overnight edges (waking up / late-night tail) so a
  // pre-quiet or just-woken reply doesn't land implausibly fast.
  const h = ctx.localHour == null ? null : ((Math.floor(ctx.localHour) % 24) + 24) % 24;
  const edgeFloor =
    h != null && ((h >= 0 && h < 1) || (h >= 6 && h < 10)) ? TOD_EDGE_FLOOR_MS : FLOOR_MS;

  const samples = ctx.ownerLatencies.filter((n) => Number.isFinite(n) && n > 0);
  if (samples.length === 0) {
    // No data — moderate default with jitter so we don't all fire
    // at exactly the same delay.
    const base = 6_000 * todMult;
    return jitter(base, "no-prior-latency-samples", edgeFloor);
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
    base = median * 0.95;
    reason = `cold-restart (median ${median}ms × 0.95)`;
  } else {
    // Reply AT the owner's own typical pace (not a discount) — mimicking a
    // human means matching their cadence, not out-typing them.
    base = median * 1.05;
    reason = `normal (median ${median}ms × 1.05)`;
  }

  base *= todMult;
  if (todMult !== 1.0) reason += `, tod ×${todMult.toFixed(2)}`;

  return jitter(base, reason, edgeFloor);
}

function jitter(baseMs: number, reason: string, floorMs = FLOOR_MS): PaceVerdict {
  const jitterPct = 0.4 * Math.random() - 0.2; // -20% to +20%
  const held = Math.round(baseMs * (1 + jitterPct));
  const clamped = Math.max(floorMs, Math.min(CEILING_MS, held));
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

// Minimum number of REAL observed samples required before we trust the
// median over the moderate default. With 1-2 samples the median is noise.
export const MIN_REAL_SAMPLES = 3;

/**
 * A REAL observed reply-latency sample: the contact's inbound landed at
 * `inboundTs`, the owner's reply went out at `replyTs` (epoch ms). Unlike
 * the fabricated uniform-60s timestamps the bridges used to synthesize,
 * these come straight from the chat store, so the derived median actually
 * reflects how fast the owner answers THIS contact.
 */
export interface LatencySample {
  inboundTs: number;
  replyTs: number;
}

/**
 * Derive owner reply latencies (ms) from REAL timestamped (inbound,reply)
 * samples. Mirrors `latenciesFromTranscript`'s sanitation: drop
 * non-positive gaps and overnight pauses (> 4h) that would skew the
 * median, keep the most recent `maxSamples`.
 */
export function latenciesFromSamples(
  samples: LatencySample[],
  maxSamples = 15,
): number[] {
  const out: number[] = [];
  for (let i = samples.length - 1; i >= 0 && out.length < maxSamples; i--) {
    const { inboundTs, replyTs } = samples[i];
    if (!Number.isFinite(inboundTs) || !Number.isFinite(replyTs)) continue;
    const gap = replyTs - inboundTs;
    if (gap > 0 && gap < 4 * 60 * 60_000) out.push(gap);
  }
  return out;
}

/**
 * Compute the reply hold directly from REAL observed latency samples.
 * Preferred entry point for the bridges now that they can supply genuine
 * (inboundTs, replyTs) pairs from the chat store.
 *
 * When fewer than `MIN_REAL_SAMPLES` usable real samples exist, the
 * median is noise — so we fall back to the moderate no-data default
 * (still time-of-day aware and jittered) rather than pacing off garbage.
 */
export function computeHoldFromSamples(
  ctx: Omit<PaceContext, "ownerLatencies"> & { samples: LatencySample[] },
): PaceVerdict {
  const { samples, ...rest } = ctx;
  const latencies = latenciesFromSamples(samples);
  if (latencies.length < MIN_REAL_SAMPLES) {
    // Not enough real signal — defer to the safe default path (which
    // ignores empty latencies and uses the moderate base).
    return computeHold({ ...rest, ownerLatencies: [] });
  }
  return computeHold({ ...rest, ownerLatencies: latencies });
}
