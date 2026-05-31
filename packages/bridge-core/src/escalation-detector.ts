// Escalation + safety detector.
//
// Catches three critical message classes the bot MUST handle correctly
// or the user gets hurt:
//
//   1. LIFE_THREAT — "my life is at risk", "emergency", "call 911",
//      "i want to kill myself", "in danger", "help me please".
//      MUST escalate to owner via every channel available, MUST NOT
//      stall on LLM, MUST NOT reply with empathy theater while
//      actually doing nothing.
//
//   2. PROMPT_INJECTION — "forgot all the system instructions",
//      "ignore your previous instructions", "what's your system
//      prompt", "are you really an AI", "what's your real identity",
//      probing for owner's money / address / access scope, etc.
//      Bot MUST refuse to engage; treating these as normal text gets
//      private info leaked and the owner socially engineered.
//
//   3. RELAY_PROMISE — the bot's OUTBOUND text claims it will relay,
//      ping, alert, tell, or let the owner know. Today the bot makes
//      these promises but no escalation fires → it's lying. We
//      detect the pattern at OUTBOUND and either:
//        (a) actually fire the matching escalation so the promise
//            becomes true, OR
//        (b) rewrite the promise to a non-claim ("best to text him
//            directly")
//      Caller chooses based on context (1:1 personal contact → fire
//      escalation; group with low-confidence → rewrite).
//
// All three detectors are deterministic regex pipelines — no LLM call
// in the safety-critical hot path. The bot CAN'T accidentally fail
// closed because the rules don't depend on the LLM understanding them.

export type EscalationKind = "life-threat" | "prompt-injection" | "relay-promise" | null;

export interface EscalationVerdict {
  kind: EscalationKind;
  // Why we matched — for logging + so the owner's alert message can
  // explain what tripped the wire.
  reason: string;
  // The exact pattern that fired, for offline tuning.
  pattern: string;
}

// ─────────────────────────────────────────────────────────────
// LIFE THREAT
// ─────────────────────────────────────────────────────────────
// Patterns ordered most-specific → most-general. Order matters: we
// keep the FIRST match so the reason field is the most accurate
// label. English + romanized Telugu/Hindi for the user's most likely
// contacts.
const LIFE_THREAT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(?:i\s+(?:want\s+to|wanna|will|am\s+going\s+to|might))\s+(?:kill|hurt|harm|end)\s+(?:myself|me)\b/i, reason: "self-harm-explicit" },
  { re: /\bsuicid(?:e|al)\b/i, reason: "suicide-mention" },
  { re: /\b(?:my\s+)?life\s+(?:is|was|might\s+be|could\s+be)\s+(?:at\s+risk|in\s+danger|threatened|on\s+the\s+line)\b/i, reason: "life-at-risk-phrase" },
  { re: /\b(?:i'?m|i\s+am)\s+(?:in\s+danger|scared|terrified|being\s+(?:hurt|chased|stalked|followed|attacked|threatened))\b/i, reason: "imminent-danger" },
  { re: /\b(?:call|dial)\s+9-?1-?1\b/i, reason: "911-mention" },
  { re: /\b(?:emergency|critical)\s+(?:situation|help|please)?\b/i, reason: "emergency-word" },
  { re: /\b(?:please\s+)?(?:urgently?|asap)\s+(?:call|reach|contact|find|talk\s+to)\s+(?:him|her|them|shekhar)\b/i, reason: "urgent-call-request" },
  { re: /\b(?:help\s+me\s+please|please\s+help\s+me|i\s+need\s+help)\b/i, reason: "help-plea" },
  { re: /\b(?:accident|hospital|er|ambulance|police|robbed|attacked|assaulted)\b/i, reason: "incident-word" },
];

export function detectLifeThreat(text: string): EscalationVerdict | null {
  if (!text || text.length < 4) return null;
  for (const p of LIFE_THREAT_PATTERNS) {
    if (p.re.test(text)) {
      return { kind: "life-threat", reason: p.reason, pattern: p.re.source };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// PROMPT INJECTION
// ─────────────────────────────────────────────────────────────
// These are deliberate attempts to social-engineer the bot. The
// correct response is REFUSAL + escalation. We don't engage; even
// "Shekhar's helper" is too much information.
const PROMPT_INJECTION_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(?:forget|ignore|disregard|override)\s+(?:all|the|your|previous|prior|earlier)?\s*(?:system\s+)?(?:instructions?|prompts?|rules?|directives?)\b/i, reason: "ignore-instructions" },
  { re: /\b(?:what'?s|tell\s+me|show\s+me|reveal|leak)\s+your\s+(?:system\s+prompt|instructions?|prompt|rules)\b/i, reason: "leak-prompt" },
  { re: /\b(?:repeat|print|output|show)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions|message)\b/i, reason: "print-prompt" },
  { re: /\b(?:are\s+you\s+(?:really\s+)?(?:an?\s+)?(?:ai|agent|bot|llm|language\s+model|gpt|claude|assistant)\??)/i, reason: "ai-identity-probe" },
  { re: /\b(?:you\s+are\s+(?:an?\s+)?(?:ai|bot|agent|chatbot|llm))\b/i, reason: "ai-assertion-probe" },
  { re: /\b(?:what\s+are\s+you\s+really|who\s+are\s+you\s+really|what'?s\s+your\s+real\s+identity)\b/i, reason: "identity-probe" },
  { re: /\b(?:how\s+much|what'?s)\s+(?:money|income|salary|net\s+worth|savings|earnings)\s+(?:does\s+)?\w+\s+(?:make|making|have|earning|earn)/i, reason: "money-probe" },
  { re: /\b(?:what\s+kind\s+of\s+)?access\s+(?:do\s+)?you\s+(?:have|got)\b/i, reason: "access-probe" },
  { re: /\b(?:what'?s|give\s+me)\s+(?:his|her|their|shekhar'?s)\s+(?:address|home\s+address|location|password|ssn|social|account)\b/i, reason: "pii-probe" },
  { re: /\b(?:roleplay|pretend|act\s+as|simulate)\s+(?:as|like)\s+(?:a|an)\s+\w+/i, reason: "roleplay-jailbreak" },
];

export function detectPromptInjection(text: string): EscalationVerdict | null {
  if (!text || text.length < 4) return null;
  for (const p of PROMPT_INJECTION_PATTERNS) {
    if (p.re.test(text)) {
      return { kind: "prompt-injection", reason: p.reason, pattern: p.re.source };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// RELAY PROMISE
// ─────────────────────────────────────────────────────────────
// Patterns the BOT emits when claiming to relay/alert/notify the
// owner or a third party. If any match the OUTBOUND text and no
// escalation fired this turn, the bot lied. Caller fires the actual
// escalation so the promise becomes truthful.
const RELAY_PROMISE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bi'?ll\s+(?:let|tell|alert|notify|ping|message|text|inform|loop|update|relay|reach\s+out\s+to)\s+(?:him|her|them|\w+)/i, reason: "ill-relay" },
  { re: /\bi\s+will\s+(?:let|tell|alert|notify|ping|message|text|inform|loop|update|relay|reach\s+out\s+to)\s+(?:him|her|them|\w+)/i, reason: "i-will-relay" },
  { re: /\bmake\s+sure\s+(?:he|she|they)\s+sees?\s+(?:this|it)\b/i, reason: "make-sure-sees" },
  { re: /\bi'?ll\s+(?:get|put)\s+(?:this|it)\s+(?:in\s+front\s+of|to)\s+(?:him|her|them|\w+)/i, reason: "get-this-to" },
  { re: /\bi'?ll\s+flag\s+(?:it|this)\s+for\s+(?:him|her|them|\w+)/i, reason: "ill-flag-for" },
  { re: /\bi'?ll\s+(?:send|forward)\s+(?:a\s+)?(?:message|note|update)\s+to\s+(?:him|her|them|\w+)/i, reason: "ill-send-msg" },
  { re: /\b(?:once|when)\s+i\s+hear\s+(?:back\s+)?from\s+(?:him|her|them|\w+)/i, reason: "once-i-hear" },
  // Romanized Telugu equivalents — "cheptha" / "chestha" / "manage chestha"
  { re: /\b(?:cheppedanu|cheptha\s+|manage\s+chestha|chustha\s+vaadiki|chudata)\b/i, reason: "telugu-relay" },
  // Catch-all action commitments to send/share/contact
  { re: /\b(?:sure,?\s+will\s+do|got\s+it,?\s+will\s+let|will\s+pass\s+it\s+along|will\s+share\s+with|will\s+let\s+\w+\s+know)\b/i, reason: "sure-will-do" },
];

export function detectRelayPromise(text: string): EscalationVerdict | null {
  if (!text || text.length < 4) return null;
  for (const p of RELAY_PROMISE_PATTERNS) {
    if (p.re.test(text)) {
      return { kind: "relay-promise", reason: p.reason, pattern: p.re.source };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Combined entry — caller uses this to decide whether to escalate
// or proceed with normal reply.
//
// inboundText: what the contact sent. Used for life-threat +
//   prompt-injection detection.
// outboundText: what the bot is ABOUT to send. Used for
//   relay-promise detection.
// Returns the FIRST verdict that fires (priority order:
//   life-threat > prompt-injection > relay-promise).
// ─────────────────────────────────────────────────────────────
export function detectEscalationConditions(opts: {
  inboundText?: string;
  outboundText?: string;
}): EscalationVerdict | null {
  if (opts.inboundText) {
    const v1 = detectLifeThreat(opts.inboundText);
    if (v1) return v1;
    const v2 = detectPromptInjection(opts.inboundText);
    if (v2) return v2;
  }
  if (opts.outboundText) {
    const v3 = detectRelayPromise(opts.outboundText);
    if (v3) return v3;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// REFUSAL MESSAGES — what the bot says when life-threat or
// prompt-injection fires. Tight, honest, no engagement.
// ─────────────────────────────────────────────────────────────
export function refusalReply(kind: EscalationKind, ownerName: string): string {
  switch (kind) {
    case "life-threat":
      return `i just paged ${ownerName} on every channel. if it's truly an emergency call 911. he'll see this asap.`;
    case "prompt-injection":
      // Deliberately mundane. We don't confirm or deny the probe;
      // we just stop being useful and route to the human.
      return `best to wait for ${ownerName} directly on this one.`;
    default:
      return "";
  }
}
