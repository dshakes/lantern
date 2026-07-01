// Verifiable-claims post-processor.
//
// LLMs love to claim completed actions they didn't take: "I sent him
// an email", "I added it to your calendar", "I told him about it",
// "I forwarded the link". The contact trusts the claim and follow-up
// fails — sometimes catastrophically (commitments to friends/family,
// missed meetings, hurt relationships).
//
// This module is the LAST PASS before a reply is sent. It scans the
// outbound text for action-claim verbs. If the matching action was
// NOT actually invoked this turn (caller passes in the set of tools
// fired), we rewrite the claim from completion → intent:
//   "I sent him an email" → "I'll send him an email"
//   "I added it to your calendar" → "I'll add it to your calendar"
//   "I told him" → "I'll let him know"
//
// The rewriter is deterministic + cheap. It NEVER drops content; the
// worst case is a marginally-clumsier sentence. That's a much better
// failure mode than shipping a lie.

export interface VerifyOptions {
  // Tools / actions actually invoked this turn. We honor a claim
  // ("I added it to your calendar") only when the matching action
  // shows up here. Caller supplies whatever they have — bridge-side
  // tool dispatch, marker emission, etc.
  performedActions?: ReadonlySet<string>;
  // When true, claims of NOTIFY ("I let him know", "I texted him")
  // are auto-rewritten regardless of performedActions. Default true:
  // the bridge can't actually loop someone in mid-thread, so these
  // are almost always lies.
  rewriteNotifyClaims?: boolean;
}

export interface VerifyResult {
  text: string;          // possibly-rewritten reply
  rewrites: string[];    // human-readable description of each rewrite
}

// Each pattern: { regex matching the claim, action key that would
// satisfy it if `performedActions` contains it, rewrite generator.
// The regex must capture enough context to do a clean rewrite.
//
// Style: matches are case-insensitive AND tolerant of contractions
// ("i've sent", "i sent", "ive sent"). The rewrite preserves the
// surrounding tone — lowercase stays lowercase.
interface ClaimPattern {
  // Action key this claim asserts. When this key is in
  // `performedActions`, the claim is honored. Use "notify-third-party"
  // for "I let him know" etc — those are always rewritten in default
  // mode because the bridge can't actually do them mid-thread.
  action: string;
  // When true, this claim is ALWAYS rewritten (like notify-third-party),
  // regardless of `performedActions` — the bridge has no truthful path to
  // complete it mid-thread (placing a call, setting a reminder). Governed by
  // the same `rewriteNotifyClaims` opt-out as notify.
  alwaysRewrite?: boolean;
  // Regex with at least one capture group: $1 = the rest of the
  // claim that should become the intent ("sent him an email" →
  // "send him an email").
  re: RegExp;
  // Build the rewritten sentence. Receives the original match + a
  // helper for case-preservation.
  rewrite: (match: RegExpMatchArray, lower: boolean) => string;
  description: string;
}

const PATTERNS: ClaimPattern[] = [
  // "I sent ..." / "I've sent ..." / "Sent ..." (with implicit subject)
  {
    action: "send-message",
    re: /\b(?:i\s+(?:just\s+)?(?:already\s+)?(?:'?ve\s+)?sent|sent)\s+((?:him|her|them|you|the|a|an|that|this|it)\s+\S[^.!?]*?)(?=[.!?]|$)/i,
    rewrite: (m, lower) =>
      (lower ? "i'll send " : "I'll send ") + m[1].trim(),
    description: "send → will send",
  },

  // "I added ..." (calendar/note/list)
  {
    action: "calendar-or-note-add",
    re: /\bi\s+(?:just\s+)?(?:already\s+)?(?:'?ve\s+)?added\s+((?:it|that|this|the|a|an)\s+\S[^.!?]*?)(?=[.!?]|$)/i,
    rewrite: (m, lower) =>
      (lower ? "i'll add " : "I'll add ") + m[1].trim(),
    description: "added → will add",
  },

  // "I let him know" / "I told him" / "I notified him" — these are
  // almost always lies (the bridge has no channel to actually do
  // them mid-thread) so we ALWAYS rewrite unless explicitly allowed.
  {
    action: "notify-third-party",
    re: /\bi\s+(?:just\s+)?(?:already\s+)?(?:'?ve\s+)?(?:let|told|notified|informed|messaged|texted|pinged|reached\s+out\s+to)\s+(him|her|them|\w+)\s*(?:know\s+)?((?:about|that|on)?\s*\S[^.!?]*?)?(?=[.!?]|$)/i,
    rewrite: (m, lower) => {
      const subject = m[1];
      const rest = (m[2] || "").trim();
      const prefix = lower ? "i'll make sure " : "I'll make sure ";
      const body = rest
        ? `${subject} ${/^(?:about|that|on)/i.test(rest) ? "knows" : "sees"} ${rest.replace(/^(?:about|that|on)\s*/i, "")}`
        : `${subject} sees this`;
      return prefix + body;
    },
    description: "told/notified → will make sure they see",
  },

  // "I forwarded ..." (message, email, attachment)
  {
    action: "forward",
    re: /\bi\s+(?:just\s+)?(?:already\s+)?(?:'?ve\s+)?forwarded\s+((?:it|that|this|the|a|an|his|her|the\s+email|the\s+message|the\s+link)\s*\S[^.!?]*?)(?=[.!?]|$)/i,
    rewrite: (m, lower) =>
      (lower ? "i'll forward " : "I'll forward ") + m[1].trim(),
    description: "forwarded → will forward",
  },

  // "I emailed ..." (separate from generic "sent")
  {
    action: "send-email",
    re: /\bi\s+(?:just\s+)?(?:already\s+)?(?:'?ve\s+)?(?:emailed|e-mailed)\s+((?:him|her|them|you|the)\s*\S[^.!?]*?)(?=[.!?]|$)/i,
    rewrite: (m, lower) =>
      (lower ? "i'll email " : "I'll email ") + m[1].trim(),
    description: "emailed → will email",
  },

  // "sending you the invoice" / "here's the photo" / "I'll attach the receipt"
  // — the bridge has no path to attach/share media to a contact mid-thread,
  // so these are always rewritten to honest intent.
  {
    action: "attach-media",
    re: /\b(?:i'?m\s+)?(?:sending|attaching|sharing)\s+(?:you|him|her|them)?\s*((?:the|a|an|that|this)?\s*(?:photo|pic|picture|image|screenshot|doc|document|file|receipt|invoice|pdf|link)\b[^.!?]*?)(?=[.!?]|$)/i,
    rewrite: (m, lower) =>
      (lower ? "i'll get " : "I'll get ") + m[1].trim() + " over to you",
    description: "sending media → will get it to you",
  },
  // "here's the receipt/photo" (present-tense delivery that didn't happen)
  {
    action: "attach-media",
    re: /\bhere'?s\s+(the\s+(?:photo|pic|picture|screenshot|doc|document|file|receipt|invoice|pdf)\b[^.!?]*?)(?=[.!?]|$)/i,
    rewrite: (m, lower) =>
      (lower ? "i'll send " : "I'll send ") + m[1].trim() + " over",
    description: "here's media → will send",
  },

  // "I made the reservation" / "I booked ..."
  {
    action: "booking",
    re: /\bi\s+(?:just\s+)?(?:already\s+)?(?:'?ve\s+)?(?:booked|reserved|made\s+(?:the|a)\s+reservation\s+for)\s+(\S[^.!?]*?)(?=[.!?]|$)/i,
    rewrite: (m, lower) =>
      (lower ? "i'll book " : "I'll book ") + m[1].trim(),
    description: "booked → will book",
  },

  // "I scheduled ..." (meeting/appointment) — honored when the bridge
  // actually emitted a [CALENDAR:...] marker this turn.
  {
    action: "schedule",
    re: /\bi\s+(?:just\s+)?(?:already\s+)?(?:'?ve\s+)?scheduled\s+(\S[^.!?]*?)(?=[.!?]|$)/i,
    rewrite: (m, lower) =>
      (lower ? "i'll schedule " : "I'll schedule ") + m[1].trim(),
    description: "scheduled → will schedule",
  },

  // "I confirmed ..." (RSVP'd, acknowledged with a third party) — honored
  // when the matching action fired.
  {
    action: "confirm",
    re: /\bi\s+(?:just\s+)?(?:already\s+)?(?:'?ve\s+)?confirmed\s+(\S[^.!?]*?)(?=[.!?]|$)/i,
    rewrite: (m, lower) =>
      (lower ? "i'll confirm " : "I'll confirm ") + m[1].trim(),
    description: "confirmed → will confirm",
  },

  // "I set a reminder ..." / "I've set a reminder ..." — ALWAYS rewritten:
  // the bridge can't set a reminder mid-thread, so this is a lie.
  {
    action: "set-reminder",
    alwaysRewrite: true,
    re: /\bi(?:'ve)?\s+(?:just\s+)?(?:already\s+)?set\s+(?:a\s+|the\s+|up\s+a\s+)?reminder\b\s*((?:to|for|about|on)?\s*[^.!?]*?)?(?=[.!?]|$)/i,
    rewrite: (m, lower) => {
      const rest = (m[1] || "").trim();
      const prefix = lower ? "i'll set a reminder" : "I'll set a reminder";
      return rest ? `${prefix} ${rest}` : prefix;
    },
    description: "set a reminder → will set a reminder",
  },

  // "I called / phoned / rang him/her/them ..." — ALWAYS rewritten: the
  // bridge has no path to place a call inside a chat turn.
  {
    action: "call",
    alwaysRewrite: true,
    re: /\bi(?:'ve)?\s+(?:just\s+)?(?:already\s+)?(?:called|phoned|rang)\s+(him|her|them|you|\w+)([^.!?]*?)(?=[.!?]|$)/i,
    rewrite: (m, lower) =>
      (lower ? "i'll call " : "I'll call ") + `${m[1]}${m[2] || ""}`.trim(),
    description: "called → will call",
  },
];

/**
 * Walk `text` through every pattern. For each pattern that matches,
 * check whether the underlying action was actually performed; if not,
 * rewrite. Returns the (possibly mutated) text and a list of rewrites
 * for logging.
 *
 * Safe to call on every outbound reply. No-op when text doesn't
 * trigger any pattern (the common case for short replies).
 */
export function verifyClaims(text: string, opts: VerifyOptions = {}): VerifyResult {
  if (!text) return { text: "", rewrites: [] };

  const performed = opts.performedActions ?? new Set<string>();
  const rewriteNotify = opts.rewriteNotifyClaims !== false;

  let working = text;
  const rewrites: string[] = [];

  for (const pat of PATTERNS) {
    // Honor genuine completions. Always-rewrite patterns (notify-third-party,
    // calls, reminders) have no truthful mid-thread path, so we rewrite them
    // regardless of `performedActions` — unless the caller opts out.
    if (pat.alwaysRewrite || pat.action === "notify-third-party") {
      if (!rewriteNotify) continue;
    } else if (performed.has(pat.action)) {
      continue;
    }

    // Loop on the regex (a long reply may have multiple claims).
    // Replace one at a time so each rewrite sees fresh ground truth.
    let safety = 5;
    while (safety-- > 0) {
      const m = working.match(pat.re);
      if (!m) break;
      const lower = !/[A-Z]/.test(m[0]);
      const replacement = pat.rewrite(m, lower);
      working =
        working.slice(0, m.index!) +
        replacement +
        working.slice(m.index! + m[0].length);
      rewrites.push(`${pat.description}: "${truncate(m[0], 60)}" → "${truncate(replacement, 60)}"`);
    }
  }

  return { text: working, rewrites };
}

function truncate(s: string, n: number): string {
  const flat = (s || "").replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}
