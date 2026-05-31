// Soft-tier reply confidence.
//
// Today the bridge has a binary gate: auto-send OR queue-for-approval.
// That's coarse. A perfect-confidence "ok, see you tomorrow" should
// fire instantly; a multi-fact medical commitment should pause for
// owner override even when the contact is familiar.
//
// This module assigns each candidate reply a tier — HIGH, MEDIUM,
// LOW — based on signals about content (sensitive topics, dollar
// amounts, dates, action verbs), contact (relationship, familiarity),
// and reply shape (length, certainty markers). The bridge routes:
//
//   HIGH   → send immediately. No interruption.
//   MEDIUM → send + cross-channel ping the owner ("FYI I just told
//            Sarah you'd be there at 2pm").
//   LOW    → draft + 30s delay window. Send if owner doesn't
//            cancel/edit in time. Pings the owner with the draft +
//            an inline "👍 to send / 👎 to hold" option.
//
// This module is the CLASSIFIER. Routing is done by the caller. The
// classification is deterministic + cheap (no LLM round-trip) so it
// runs on every outbound without latency cost.

export type ConfidenceTier = "HIGH" | "MEDIUM" | "LOW";

export interface ConfidenceContext {
  // Will be classified. Final-form reply text, post-naturalize.
  replyText: string;
  // Original inbound that prompted the reply. Helps detect "user
  // asked a sensitive question".
  inboundText: string;
  // Relationship label from owner profile, if any ("wife",
  // "manager", "old friend"). Tighter familiarity → higher tier.
  relationship?: string;
  // Whether we have prior owner samples (i.e. this contact isn't a
  // cold start).
  hasPriorSamples: boolean;
  // Whether THIS contact has been 👎'd in the past. Lower trust.
  hasPriorDislikes: boolean;
}

export interface ConfidenceVerdict {
  tier: ConfidenceTier;
  // Why we landed here — for logging + offline tuning.
  reasons: string[];
}

// Patterns that DOWNGRADE confidence (push toward LOW). Each match
// adds to the risk score. Ordered most → least concerning.
const RISK_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  // Concrete dollar amounts — money commitments are high-stakes.
  { re: /\$\s?\d{2,}/, weight: 2, label: "dollar-amount" },
  // Future date/time commitments — wrong time → real-world consequence.
  { re: /\b(?:tomorrow|tonight|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on\s+(?:mon|tue|wed|thu|fri|sat|sun)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i, weight: 2, label: "future-commitment" },
  // Medical / legal / financial vocabulary.
  { re: /\b(?:hospital|doctor|diagnos|prescription|lawyer|attorney|legal|contract|invest|insurance|tax|refund|debt|loan|mortgage)\b/i, weight: 2, label: "high-stakes-topic" },
  // First-person action claims (even after verifiable-claims rewrites
  // — defense in depth).
  { re: /\bi\s+(?:'?ll|will|just|already)?\s*(?:send|email|text|call|forward|tell|told|sent|forwarded|notified)\b/i, weight: 1, label: "action-claim" },
  // Multi-fact / numbered list / long structured reply.
  { re: /\n.*\n/, weight: 1, label: "multi-line" },
  // Long reply (humans usually don't paragraph in text threads).
  { re: /.{200,}/s, weight: 1, label: "long-reply" },
  // Death / illness / grief — never auto-send without owner eyes.
  { re: /\b(?:died|death|passed\s+away|funeral|hospice|cancer|terminal|surgery)\b/i, weight: 3, label: "grief-topic" },
];

// Patterns that UPGRADE confidence (push toward HIGH). Small simple
// replies are usually safe.
const SAFE_PATTERNS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /^(?:ok|okay|yeah|yep|sure|👍|thx|thanks|lol|haha|cool|got\s+it)\b\s*\.?\s*$/i, weight: 3, label: "pure-ack" },
  { re: /^.{0,30}$/, weight: 1, label: "short-reply" },
];

export function classifyConfidence(ctx: ConfidenceContext): ConfidenceVerdict {
  let risk = 0;
  let safety = 0;
  const reasons: string[] = [];

  for (const p of RISK_PATTERNS) {
    if (p.re.test(ctx.replyText)) {
      risk += p.weight;
      reasons.push(`-${p.weight} ${p.label}`);
    }
  }
  for (const p of SAFE_PATTERNS) {
    if (p.re.test(ctx.replyText)) {
      safety += p.weight;
      reasons.push(`+${p.weight} ${p.label}`);
    }
  }

  // Contact-trust adjustments.
  if (ctx.relationship) {
    // Familiar contact → bump confidence one notch up.
    safety += 1;
    reasons.push(`+1 known-relationship (${ctx.relationship})`);
  }
  if (!ctx.hasPriorSamples) {
    // Cold contact → bump risk.
    risk += 1;
    reasons.push(`-1 cold-contact`);
  }
  if (ctx.hasPriorDislikes) {
    // History of bad replies → demand human eyes.
    risk += 2;
    reasons.push(`-2 prior-dislikes`);
  }

  // Net score → tier.
  const net = safety - risk;
  let tier: ConfidenceTier;
  if (net >= 1) tier = "HIGH";
  else if (net >= -1) tier = "MEDIUM";
  else tier = "LOW";

  return { tier, reasons };
}

/**
 * Render a one-line tier badge for logs. Color hint via emoji.
 *   HIGH  → 🟢
 *   MEDIUM → 🟡
 *   LOW   → 🔴
 */
export function tierBadge(verdict: ConfidenceVerdict): string {
  const emoji = verdict.tier === "HIGH" ? "🟢" : verdict.tier === "MEDIUM" ? "🟡" : "🔴";
  return `${emoji} ${verdict.tier} (${verdict.reasons.join(", ")})`;
}
