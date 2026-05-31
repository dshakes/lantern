// Outbound call risk classifier.
//
// Every outbound call falls into one of three tiers. Tier dictates the
// approval workflow + the bot's autonomy during the call:
//
//   TIER A — Transactional / IVR
//     Bot calls a system or a stranger employed to handle calls
//     (pharmacy, restaurant, airline support, doctor's office line).
//     The other party is a phone tree or call-center rep. Social risk
//     is near-zero; the bot's identity doesn't matter to them.
//     Approval: auto-approved if owner explicitly invoked the call.
//
//   TIER B — Personal contact
//     Bot calls a known contact of the owner (friend, family member,
//     colleague). The recipient might EXPECT to talk to the owner.
//     Bot MUST use the soft disclosure ladder + never claim identity.
//     Approval: requires owner self-chat ack OR pre-approved contact.
//
//   TIER C — Sensitive / high-stakes
//     Medical, legal, financial, family-emergency. Even tier-B
//     contacts get bumped to C if topic matches. Bot defaults to
//     "let me run that by Shekhar first" for any commitment.
//     Approval: ALWAYS requires owner ack + bot summarizes intended
//     content first.
//
// Classification runs deterministically on (destination, contact-name,
// stated-reason, owner-approval-context). No LLM in the hot path.
// Bot never DOWNGRADES a tier — only the owner can override via
// self-chat command.

export type CallTier = "A" | "B" | "C";

export interface CallContext {
  // Destination phone in E.164 ("+15551234567"). Required.
  to: string;
  // Resolved contact name if the destination is in the owner's
  // contacts. Undefined → unknown caller.
  contactName?: string;
  // Stated reason for the call (1-line, what the owner said when
  // requesting it, or the auto-triggered context).
  reason?: string;
  // Did the owner explicitly initiate this call right now via
  // self-chat? true = auto-approved at tier A but still gated at B/C.
  ownerInitiated: boolean;
  // Has this number been pre-approved as a "tier B is fine to skip
  // pre-flight"? Set from owner profile or a persistent allowlist.
  preApprovedTierB?: boolean;
}

export interface TierVerdict {
  tier: CallTier;
  reasons: string[];           // why we landed here
  needsOwnerAck: boolean;      // gate the call on owner ack
  maxDurationMs: number;       // hard cap for this call
  allowCommitments: boolean;   // bot may make commitments without explicit ack
}

// ─────────────────────────────────────────────────────
// Patterns that BUMP a call to TIER C regardless of contact identity.
// These topics are too sensitive for bot autonomy.
// ─────────────────────────────────────────────────────
const TIER_C_TOPICS: RegExp[] = [
  /\b(?:hospital|doctor|clinic|surgery|diagnos|prescription|medication|er\b|emergency\s+room|ambulance)/i,
  /\b(?:lawyer|attorney|legal|lawsuit|sue|court|subpoena|deposition)/i,
  /\b(?:bank|wire\s+transfer|loan|mortgage|refi|investment|stock|crypto|tax\s+(?:refund|debt)|irs|audit)/i,
  /\b(?:funeral|hospice|terminal|cancer|stroke|heart\s+attack|coma|passed\s+away|died)/i,
  /\b(?:divorce|custody|breakup|cheat)/i,
  /\b(?:police|arrest|jail|bail|restraining\s+order)/i,
  /\b(?:custody|child\s+support|adoption|foster)/i,
];

// IVR / business-line indicators — bumps to TIER A.
const TIER_A_INDICATORS: RegExp[] = [
  /\b(?:cvs|walgreens|rite[\s-]?aid|pharmacy|drug\s+store)/i,
  /\b(?:reservation|opentable|booking|cancel(?:lation)?\s+(?:request|line))/i,
  /\b(?:airline|delta|united|american|southwest|alaska|jetblue|spirit|frontier|hotel)/i,
  /\b(?:comcast|xfinity|verizon|att\b|spectrum|cox|t-?mobile|att|att\.com)/i,
  /\b(?:insurance|geico|state\s+farm|progressive|allstate|aaa)/i,
  /\b(?:dmv|tsa|tsa\b|irs\b\s+phone|social\s+security\s+admin)/i,
  /\b(?:customer\s+(?:service|support)|technical\s+support|help\s+line|support\s+line|800[\s-]?\d{3}[\s-]?\d{4})/i,
  /\b(?:restaurant|hotel\s+desk|front\s+desk|concierge|reception)/i,
  /\b(?:appointment|schedule|reschedule|confirm)/i,
];

// Toll-free / 1-800 / 1-888 / 1-877 numbers are almost always
// business lines → TIER A by default.
const TOLL_FREE_RE = /^\+1\s*(?:800|888|877|866|855|844|833)/;

/**
 * Classify a candidate outbound call. Pure function — no LLM, no I/O.
 */
export function classifyOutboundCall(ctx: CallContext): TierVerdict {
  const reasons: string[] = [];
  const reason = (ctx.reason || "").trim();

  // 1. Check for TIER C topics first — they ALWAYS dominate.
  for (const re of TIER_C_TOPICS) {
    if (re.test(reason)) {
      reasons.push(`tier-c topic: ${re.source.slice(0, 30)}…`);
      return {
        tier: "C",
        reasons,
        needsOwnerAck: true,
        maxDurationMs: 10 * 60_000,
        allowCommitments: false, // bot must defer to owner
      };
    }
  }

  // 2. Toll-free / business indicators → TIER A.
  if (TOLL_FREE_RE.test(ctx.to)) {
    reasons.push("toll-free number");
    return {
      tier: "A",
      reasons,
      // Owner-initiated calls skip pre-flight; auto-triggered (e.g.
      // appointment-confirm cron) still surfaces a summary but won't
      // wait on ack — 5s implicit-approve window enforced by caller.
      needsOwnerAck: !ctx.ownerInitiated,
      maxDurationMs: 15 * 60_000, // longer cap; hold lines are slow
      allowCommitments: true,
    };
  }
  for (const re of TIER_A_INDICATORS) {
    if (re.test(reason)) {
      reasons.push(`tier-a indicator: ${re.source.slice(0, 30)}…`);
      return {
        tier: "A",
        reasons,
        needsOwnerAck: !ctx.ownerInitiated,
        maxDurationMs: 15 * 60_000,
        allowCommitments: true,
      };
    }
  }

  // 3. Known personal contact → TIER B.
  if (ctx.contactName) {
    reasons.push(`known contact: ${ctx.contactName}`);
    return {
      tier: "B",
      reasons,
      // Pre-approved contacts (owner has tagged them as "auto-ok")
      // skip the ack; everyone else needs explicit go-ahead.
      needsOwnerAck: !ctx.preApprovedTierB,
      maxDurationMs: 10 * 60_000,
      allowCommitments: true,
    };
  }

  // 4. Unknown human number — default to TIER C to be safe.
  reasons.push("unknown destination, no contact record");
  return {
    tier: "C",
    reasons,
    needsOwnerAck: true,
    maxDurationMs: 5 * 60_000,
    allowCommitments: false,
  };
}

/** Render a verdict as a one-line badge for logs / self-chat. */
export function tierBadge(v: TierVerdict): string {
  const emoji = v.tier === "A" ? "🟢" : v.tier === "B" ? "🟡" : "🔴";
  return `${emoji} TIER ${v.tier} — ${v.reasons.join("; ")}`;
}
