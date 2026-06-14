// Owner-handoff detection for the takeover pause.
//
// When the owner types manually into a contact's thread, the bridge pauses
// auto-reply for that contact (the "you took over" pause). The default pause
// is short (60 min) — fine for a quick interjection. But when the owner's
// manual message is an explicit HANDOFF or COMMITMENT — "Human here, I'll
// call you this evening", "I'll handle this", "let me reply" — a 60-minute
// pause is far too short: the bot resumed hours later and re-proposed a
// meeting the owner had already said they'd handle (real bug from the field).
//
// This detector recognizes those handoff/commitment signals so the bridge
// can apply a much longer pause (default 12h) instead. Deterministic regex,
// no LLM — it runs on the owner's own outbound text.

const HANDOFF_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // Explicit "the human is here / taking over" markers.
  { re: /\bhuman\s+here\b/i, reason: "human-here" },
  { re: /\b(?:real|actual)\s+(?:me|one|person)\s+here\b/i, reason: "real-me-here" },
  { re: /\bme\s+now\b/i, reason: "me-now" },
  // Commitment to follow up directly (call / text / reply / reach out).
  { re: /\b(?:i'?ll|i\s+will|will|gonna|going\s+to|let\s+me)\s+(?:call|ring|phone|dial)\s+(?:you|u|ya|him|her|them|back)?\b/i, reason: "will-call" },
  { re: /\b(?:i'?ll|i\s+will|let\s+me|gonna|going\s+to)\s+(?:text|message|msg|ping|reply|respond|get\s+back\s+to|reach\s+out\s+to|hit\s+up|email)\b/i, reason: "will-follow-up" },
  { re: /\bcall\s+(?:you|u|ya)\s+(?:this\s+)?(?:evening|tonight|tomorrow|later|soon|in\s+a\s+bit|back)\b/i, reason: "call-you-later" },
  // Taking the thread over.
  { re: /\b(?:i'?ll|i\s+will|let\s+me|i'?ve\s+got|i\s+got)\s+(?:handle|take|got|deal\s+with|sort)\s+(?:this|it|that)?\b/i, reason: "ill-handle-this" },
  { re: /\b(?:i'?ll|let\s+me)\s+(?:take\s+(?:this|it)\s+from\s+here|jump\s+in|step\s+in|take\s+over)\b/i, reason: "take-over" },
];

export interface HandoffVerdict {
  matched: boolean;
  reason: string;
}

/** True when the owner's manual message signals they're personally taking
 *  over the thread or committing to follow up (call/text/reply) directly.
 *  Exported for tests. */
export function detectOwnerHandoff(text: string): HandoffVerdict {
  const t = (text || "").trim();
  if (t.length < 3) return { matched: false, reason: "" };
  for (const p of HANDOFF_PATTERNS) {
    if (p.re.test(t)) return { matched: true, reason: p.reason };
  }
  return { matched: false, reason: "" };
}

/**
 * Pause duration (ms) to apply when the owner manually types into a contact
 * thread. A plain interjection gets `defaultMs`; an explicit handoff/
 * commitment gets the longer `handoffMs` so the bot doesn't barge back into
 * a thread the owner said they'd handle. Returns the larger of the two when
 * a handoff is detected so a longer default is never shortened.
 */
export function ownerTakeoverPauseMs(
  text: string,
  defaultMs: number,
  handoffMs: number,
): { ms: number; handoff: HandoffVerdict } {
  const handoff = detectOwnerHandoff(text);
  const ms = handoff.matched ? Math.max(defaultMs, handoffMs) : defaultMs;
  return { ms, handoff };
}
