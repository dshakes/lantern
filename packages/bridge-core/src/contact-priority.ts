// Per-contact priority / relationship-strength model.
//
// Computes a single deterministic priority score (0..100) and a coarse
// tier ("high" | "normal" | "low") for a contact from signals the bridge
// already has on hand:
//
//   - message frequency  (how chatty this thread is)
//   - recency            (how recently they last messaged)
//   - VIP flag           (owner explicitly starred them)
//   - relationship label (family/close vs work vs unknown — parsed from
//                         the owner profile's Relationships section)
//   - owner reply latency(how fast the OWNER historically replies to them
//                         — a strong revealed-preference signal: the owner
//                         answers people they care about quickly)
//
// Consumers (a sibling phase wires these): rank proactive nudges, order
// the morning brief, and nudge confidence gating (a high-priority contact
// can earn a slightly looser auto-send gate; a low-priority/unknown one a
// tighter one).
//
// Design: PURE + DETERMINISTIC. No I/O, no clock reads inside the scoring
// (the caller passes `now`), no LLM. Fully unit-testable. All weights are
// declared as named constants so the model is auditable + tunable.

export type PriorityTier = "high" | "normal" | "low";

/** Coarse relationship class derived from a free-form relationship label. */
export type RelationshipClass = "family" | "close" | "work" | "unknown";

export interface ContactSignals {
  /** Messages exchanged with this contact in the rolling window. */
  messageCount?: number;
  /** Epoch ms of the contact's most recent inbound message. */
  lastInboundAt?: number;
  /** Owner explicitly starred / pinned this contact. */
  vip?: boolean;
  /** Free-form relationship label from the owner profile ("wife",
   *  "brother", "manager", "old friend"). Classified internally. */
  relationship?: string;
  /** Median owner reply latency to this contact, in ms. Lower = the owner
   *  prioritizes them. Omit when unknown (cold contact). */
  medianReplyLatencyMs?: number;
  /** Reference "now" for recency math. Defaults to Date.now() ONLY at the
   *  public boundary; the scorer requires it explicitly so it stays pure. */
  now?: number;
}

export interface ContactPriority {
  /** 0..100, higher = more important to the owner. */
  score: number;
  tier: PriorityTier;
  /** Derived relationship class — handy for downstream display/logic. */
  relationshipClass: RelationshipClass;
  /** Per-signal contributions, for logging + offline tuning. */
  reasons: string[];
}

// ── Weights (sum of positive maxima ≈ 100) ───────────────────────────
const W_RELATIONSHIP: Record<RelationshipClass, number> = {
  family: 30,
  close: 24,
  work: 12,
  unknown: 0,
};
const W_VIP = 25; // explicit owner signal — strongest single lever
const W_FREQUENCY_MAX = 20; // saturating; many messages = an active thread
const W_RECENCY_MAX = 15; // recent contact = currently relevant
const W_LATENCY_MAX = 10; // fast owner replies = revealed preference

// Tier cutoffs on the 0..100 score.
const TIER_HIGH_MIN = 55;
const TIER_LOW_MAX = 20;

// Saturation knobs.
const FREQUENCY_SATURATION = 40; // messageCount at which frequency maxes out
const RECENCY_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const LATENCY_FAST_MS = 5 * 60 * 1000; // ≤5 min reply → full latency credit
const LATENCY_SLOW_MS = 6 * 60 * 60 * 1000; // ≥6 h reply → zero latency credit

// Relationship-label keyword → class. First match wins. Lowercased,
// whole-word matched. Family/close kinship covers English + the Telugu
// kinship terms the bridge already understands elsewhere.
const RELATIONSHIP_KEYWORDS: Array<{ re: RegExp; cls: RelationshipClass }> = [
  {
    re: /\b(wife|husband|spouse|mom|mother|dad|father|son|daughter|brother|sister|sibling|parent|grand(?:ma|pa|mother|father)|aunt|uncle|cousin|niece|nephew|in-?law|family|amma|nanna|anna|akka|bava|vadina|vodina|mama|attha|babai|chelli|thammudu|baava)\b/i,
    cls: "family",
  },
  {
    re: /\b(friend|buddy|bestie|bff|close|partner|girlfriend|boyfriend|gf|bf|roommate|bro\b|fam\b)\b/i,
    cls: "close",
  },
  {
    re: /\b(manager|boss|colleague|coworker|co-worker|client|customer|recruiter|vendor|investor|lead|director|teammate|report|hr\b|work|office|business)\b/i,
    cls: "work",
  },
];

/** Classify a free-form relationship label into a coarse class.
 *  Exported for tests + downstream display. */
export function classifyRelationship(label?: string): RelationshipClass {
  const rel = (label || "").trim().toLowerCase();
  if (!rel) return "unknown";
  for (const { re, cls } of RELATIONSHIP_KEYWORDS) {
    if (re.test(rel)) return cls;
  }
  return "unknown";
}

/** Clamp helper. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Compute a deterministic priority score + tier for a contact.
 *
 * Pure: identical signals → identical output. `now` defaults to the
 * wall clock only at this boundary; pass it explicitly in tests.
 */
export function contactPriority(handle: string, signals: ContactSignals = {}): ContactPriority {
  const now = signals.now ?? Date.now();
  const reasons: string[] = [];
  let score = 0;

  // Relationship class.
  const relationshipClass = classifyRelationship(signals.relationship);
  const relPts = W_RELATIONSHIP[relationshipClass];
  if (relPts > 0) {
    score += relPts;
    reasons.push(`+${relPts} relationship:${relationshipClass}`);
  }

  // VIP — explicit owner star.
  if (signals.vip) {
    score += W_VIP;
    reasons.push(`+${W_VIP} vip`);
  }

  // Frequency — saturating ratio. A handful of messages barely moves it;
  // an active thread maxes out.
  const count = Math.max(0, signals.messageCount ?? 0);
  if (count > 0) {
    const freqPts = Math.round(W_FREQUENCY_MAX * clamp(count / FREQUENCY_SATURATION, 0, 1));
    if (freqPts > 0) {
      score += freqPts;
      reasons.push(`+${freqPts} frequency(${count})`);
    }
  }

  // Recency — exponential decay by half-life. Just-messaged → near full;
  // weeks-old → ~0.
  if (typeof signals.lastInboundAt === "number" && signals.lastInboundAt > 0) {
    const ageMs = Math.max(0, now - signals.lastInboundAt);
    const decay = Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
    const recPts = Math.round(W_RECENCY_MAX * decay);
    if (recPts > 0) {
      score += recPts;
      reasons.push(`+${recPts} recency`);
    }
  }

  // Owner reply latency — fast replies reveal that the owner prioritizes
  // this contact. Linear between the fast/slow thresholds.
  if (typeof signals.medianReplyLatencyMs === "number" && signals.medianReplyLatencyMs >= 0) {
    const lat = signals.medianReplyLatencyMs;
    let frac: number;
    if (lat <= LATENCY_FAST_MS) frac = 1;
    else if (lat >= LATENCY_SLOW_MS) frac = 0;
    else frac = 1 - (lat - LATENCY_FAST_MS) / (LATENCY_SLOW_MS - LATENCY_FAST_MS);
    const latPts = Math.round(W_LATENCY_MAX * frac);
    if (latPts > 0) {
      score += latPts;
      reasons.push(`+${latPts} fast-reply`);
    }
  }

  score = clamp(Math.round(score), 0, 100);

  let tier: PriorityTier;
  if (score >= TIER_HIGH_MIN) tier = "high";
  else if (score <= TIER_LOW_MAX) tier = "low";
  else tier = "normal";

  return { score, tier, relationshipClass, reasons };
}
