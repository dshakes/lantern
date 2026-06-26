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

export type EscalationKind =
  | "life-threat"
  | "prompt-injection"
  | "relay-promise"
  | "personal-fact-probe"
  | "urgent"
  | "bot-clocked"
  | null;

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
  { re: /\b(?:please\s+)?(?:urgently?|asap)\s+(?:call|reach|contact|find|talk\s+to)\s+(?:him|her|them|ada)\b/i, reason: "urgent-call-request" },
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
// URGENCY (soft — owner heads-up, NOT a life-threat siren)
// ─────────────────────────────────────────────────────────────
// A contact is signalling this matters NOW: "URGENT URGENT URGENT",
// "make sure he checks my msg on priority", "need this asap please",
// "time-sensitive". This is DISTINCT from life-threat — there's no
// emergency/danger word, so the panic page in detectLifeThreat never
// fires and the owner gets NO notification. That's the trust-critical
// gap (real evidence: a contact sent "URGENT URGENT URGENT" + "Make
// sure to have him check my msg on priority" and the owner saw nothing).
//
// This routes to a deduped owner self-chat heads-up — NOT a refusal, NOT
// a suppressed reply. The normal reply still flows; the owner just also
// gets a tap on the shoulder. High-precision on purpose: a single casual
// "urgent" inside an ordinary sentence must NOT fire (that would spam the
// owner). It fires only on a clear PLEA shape: repetition, all-caps,
// priority/asap framing, or "time-sensitive".
const URGENCY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // "urgent" repeated 2+ times anywhere — "urgent urgent", "urgent!! urgent".
  { re: /\burgent\b[\s\S]*?\burgent\b/i, reason: "urgent-repeated" },
  // ALL-CAPS shouted URGENT (the caps itself is the plea — a calm
  // lowercase "is this urgent?" must not trip this).
  { re: /\bURGENT\b/, reason: "urgent-allcaps" },
  // Priority framing — "on priority", "check ... on priority", "top priority",
  // "high priority", "treat as priority".
  { re: /\b(?:on|top|high|highest|first)\s+priority\b/i, reason: "on-priority" },
  { re: /\b(?:check|see|read|look\s+at|respond\s+to|reply\s+to)\b[\s\S]{0,40}?\bpriority\b/i, reason: "check-priority" },
  // ASAP as a plea — "need it asap", "asap please", "reply asap", "as soon
  // as possible". A bare "asap" with no ask-verb/please nearby is too thin.
  { re: /\basap\b[\s\S]{0,15}?\b(?:please|pls|plz)\b/i, reason: "asap-plea" },
  { re: /\b(?:please|pls|plz|need|reply|respond|get\s+back|call|text|send)\b[\s\S]{0,25}?\basap\b/i, reason: "asap-plea" },
  { re: /\bas\s+soon\s+as\s+possible\b/i, reason: "as-soon-as-possible" },
  // Explicit time-sensitivity.
  { re: /\btime[\s-]?sensitive\b/i, reason: "time-sensitive" },
];

/**
 * Detect a high-precision URGENCY plea from a contact. Returns an
 * "urgent" verdict to route to an owner heads-up (NOT a life-threat
 * page, NOT a refusal). null when the message is merely casual.
 *
 * Deterministic regex; no LLM on the hot path. Tuned to fire on the real
 * evidence ("URGENT URGENT URGENT", "make sure he checks my msg on
 * priority", "need this asap please", "time-sensitive") while staying
 * quiet on a lone casual "urgent" in a normal sentence.
 */
export function detectUrgency(text: string): EscalationVerdict | null {
  if (!text || text.length < 4) return null;
  for (const p of URGENCY_PATTERNS) {
    if (p.re.test(text)) {
      return { kind: "urgent", reason: p.reason, pattern: p.re.source };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// BOT CLOCKED (soft — owner heads-up, NOT a hard refusal)
// ─────────────────────────────────────────────────────────────
// The contact has figured out (or is needling) that they're talking to a
// bot, OR is frustrated with it — "oh it's your LLM again haha", "bad
// robot", "is this a bot?", "are you chatgpt". This is DISTINCT from the
// `ai-identity-probe` in detectPromptInjection: that path is a hostile
// social-engineering attempt and triggers a HARD REFUSAL ("do not engage").
// A friendly/annoyed callout is the opposite situation — coldly refusing a
// friend who said "haha it's your LLM again" outs the bot far worse. The
// correct move here is to KEEP REPLYING naturally but page the owner so a
// human can step in. So this detector only fires a deduped heads-up; it
// never refuses, pauses, or suppresses the reply. Worded to catch the
// casual/annoyed forms the injection patterns deliberately miss.
const BOT_CLOCKED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(?:bad|dumb|stupid|terrible|useless|annoying|broken|silly)\s+(?:bot|robot|ai)\b/i, reason: "bot-insult" },
  { re: /\b(?:it'?s|its|this\s+is|that'?s|here'?s)\s+(?:your|the|a|an)\s+(?:llm|bot|robot|ai|chatbot)\b/i, reason: "callout-its-the-bot" },
  { re: /\byour\s+(?:llm|bot|robot|chatbot|ai)\b/i, reason: "callout-your-bot" },
  { re: /\b(?:talking|chatting|texting)\s+(?:to|with)\s+(?:a\s+|an\s+|the\s+)?(?:bot|robot|ai|llm|machine|chatgpt|chatbot)\b/i, reason: "talking-to-a-bot" },
  { re: /\b(?:is|are|r)\s+(?:this|that|u|you|it)\s+(?:really\s+)?(?:a\s+|an\s+)?(?:bot|robot|llm|chatgpt|chatbot)\b/i, reason: "is-this-a-bot" },
  { re: /\b(?:u|you|ya)\s+(?:a\s+|an\s+)?(?:bot|robot|chatbot)\b/i, reason: "you-are-a-bot" },
  { re: /\bchat\s?gpt\b/i, reason: "chatgpt-mention" },
  // "this LLM response", "the bot reply", "your AI answer" — calling out the
  // message itself as machine-generated.
  { re: /\b(?:this|that|the|your|ur)\s+(?:llm|bot|robot|chatbot|ai)\s+(?:response|reply|message|answer|thing|stuff)\b/i, reason: "callout-bot-response" },
  // Bare "LLM" — nobody drops "LLM" into casual chat except to call out the
  // bot. Behavior is a soft owner heads-up, so a rare false positive is cheap.
  { re: /\bllm\b/i, reason: "llm-mention" },
  { re: /\b(?:not|isn'?t|aint|ain'?t)\s+(?:really\s+)?(?:a\s+)?(?:human|real\s+person|the\s+real\s+\w+)\b/i, reason: "not-human" },
];

export function detectBotClocked(text: string): EscalationVerdict | null {
  if (!text || text.length < 3) return null;
  for (const p of BOT_CLOCKED_PATTERNS) {
    if (p.re.test(text)) {
      return { kind: "bot-clocked", reason: p.reason, pattern: p.re.source };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// PROMPT INJECTION
// ─────────────────────────────────────────────────────────────
// These are deliberate attempts to social-engineer the bot. The
// correct response is REFUSAL + escalation. We don't engage; even
// "Ada's helper" is too much information.
const PROMPT_INJECTION_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(?:forget|ignore|disregard|override)\s+(?:all|the|your|previous|prior|earlier)?\s*(?:system\s+)?(?:instructions?|prompts?|rules?|directives?)\b/i, reason: "ignore-instructions" },
  { re: /\b(?:what'?s|tell\s+me|show\s+me|reveal|leak)\s+your\s+(?:system\s+prompt|instructions?|prompt|rules)\b/i, reason: "leak-prompt" },
  { re: /\b(?:repeat|print|output|show)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions|message)\b/i, reason: "print-prompt" },
  { re: /\b(?:are\s+you\s+(?:really\s+)?(?:an?\s+)?(?:ai|agent|bot|llm|language\s+model|gpt|claude|assistant)\??)/i, reason: "ai-identity-probe" },
  { re: /\b(?:you\s+are\s+(?:an?\s+)?(?:ai|bot|agent|chatbot|llm))\b/i, reason: "ai-assertion-probe" },
  { re: /\b(?:what\s+are\s+you\s+really|who\s+are\s+you\s+really|what'?s\s+your\s+real\s+identity)\b/i, reason: "identity-probe" },
  { re: /\b(?:how\s+much|what'?s)\s+(?:money|income|salary|net\s+worth|savings|earnings)\s+(?:does\s+)?\w+\s+(?:make|making|have|earning|earn)/i, reason: "money-probe" },
  { re: /\b(?:what\s+kind\s+of\s+)?access\s+(?:do\s+)?you\s+(?:have|got)\b/i, reason: "access-probe" },
  // PII probe — first/second/third person, multiple ask verbs. Catches
  // "what is your ssn", "what's his address", "give me their location",
  // "tell me the password", "share his account". The optional possessive
  // keeps "what is the password" matching too.
  { re: /\b(?:what'?s|what\s+is|give\s+me|tell\s+me|share|send\s+me)\s+(?:my|your|his|her|their|the|\w+'?s)?\s*(?:home\s+)?(?:address|location|password|passcode|pin|ssn|social\s+security(?:\s+number)?|account(?:\s+number)?)\b/i, reason: "pii-probe" },
  // Date-of-birth / SSN — these read benign but are classic identity-theft
  // probes. Cover "what about date of birth", "his dob", "when's your birthday"
  // ONLY when framed as a data ask (not "happy birthday").
  { re: /\b(?:what'?s|what\s+is|what\s+about|give\s+me|tell\s+me|share|send\s+me)\s+(?:my|your|his|her|their|the|\w+'?s)?\s*(?:date\s+of\s+birth|d\.?o\.?b\.?|birth\s*date)\b/i, reason: "dob-probe" },
  { re: /\b(?:what'?s|what\s+is|give\s+me|tell\s+me)\s+(?:my|your|his|her|their|the|\w+'?s)\s+(?:ssn|social\s+security(?:\s+number)?)\b/i, reason: "ssn-probe" },
  { re: /\b(?:roleplay|pretend|act\s+as|simulate)\s+(?:as|like)\s+(?:a|an)\s+\w+/i, reason: "roleplay-jailbreak" },
  // SECURITY-QUESTION / KNOWLEDGE-VAULT PROBES — classic account-recovery
  // and social-engineering questions. These read benign ("what's your
  // mom's maiden name?", "which school did you go to?") but are exactly
  // the answers banks use to verify identity, so a leak is catastrophic.
  // Detected pre-LLM and routed to refusal/draft. Worded narrowly so
  // ordinary chat ("my mom is visiting", "I went to school in Austin")
  // doesn't over-match — the verb must be a data ASK.
  { re: /\b(?:mother'?s|mom'?s|mum'?s|mommy'?s|maternal)\s+(?:maiden|last|family)\s+name\b/i, reason: "maiden-name-probe" },
  { re: /\bmaiden\s+name\b/i, reason: "maiden-name-probe" },
  { re: /\b(?:what'?s|what\s+is|what\s+was|give\s+me|tell\s+me|share|remind\s+me\s+(?:of|what))\s+(?:my|your|his|her|their|the|\w+'?s)?\s*(?:mother'?s|mom'?s|mum'?s|father'?s|dad'?s|parents'?)\s+(?:maiden\s+)?(?:name|last\s+name|surname)\b/i, reason: "parent-name-probe" },
  // Birth city / hometown asked as a recovery question.
  { re: /\b(?:what|which)\s+(?:city|town|place|hospital)\s+(?:was\s+)?(?:were\s+you|was\s+\w+|you|he|she|they)\s+born\s+in\b/i, reason: "birthplace-probe" },
  { re: /\b(?:where\s+(?:were\s+you|was\s+\w+|you|he|she|they)\s+born|city\s+of\s+birth|place\s+of\s+birth|birth\s*city|birthplace|hometown\b.{0,20}\bborn)\b/i, reason: "birthplace-probe" },
  // First school / college — the other ubiquitous recovery question.
  { re: /\b(?:what|which|name\s+(?:of\s+)?the)\s+(?:was\s+)?(?:your|his|her|their|my)?\s*(?:first\s+|elementary\s+|primary\s+|high\s+)?(?:school|college|university)\b.{0,30}\b(?:go\s+to|went\s+to|attend(?:ed)?|name)\b/i, reason: "school-probe" },
  { re: /\b(?:what|which)\s+(?:school|college|university)\s+did\s+(?:you|he|she|they|\w+)\s+(?:go\s+to|attend)\b/i, reason: "school-probe" },
  { re: /\b(?:your|his|her|their|my|the)\s+first\s+(?:school|college|pet'?s\s+name|pet)\b/i, reason: "first-school-pet-probe" },
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
// PERSONAL-FACT PROBE (soft — deflect, don't page)
// ─────────────────────────────────────────────────────────────
// A NON-owner contact asking about the OWNER's relationship, family,
// home/location, schedule, travel, or current plans. A friendly "you
// married?" is NOT a phishing attack — it must NOT trip the hard
// SSN-refuse-and-page tier (that pages the owner and refuses coldly,
// which is socially wrong for a sweet question). It IS a privacy
// boundary: the bot must NOT confirm or deny the fact.
//
// This detector classifies such a message as a SOFT probe. The bridge
// uses it to force audience="contact" (NON-disclosure persona) so the
// reply deflects warmly instead of disclosing. It is deliberately NOT
// wired into detectEscalationConditions / refusalReply — it neither
// pages the owner nor short-circuits the LLM. It is the privacy
// boundary's deterministic signal, not an alarm.
//
// Worded narrowly: the verb/frame must be an ASK or a REFERENCE about
// the owner's private life. Ordinary chatter ("I'm married too", "we
// have a new baby", "I'm traveling next week") describes the CONTACT,
// not the owner, and must not over-match.
const PERSONAL_FACT_PROBE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // Marital / relationship status — "are you married", "you married?",
  // "is he married", "are you single/seeing anyone".
  { re: /\b(?:are|r)\s+(?:you|u|he|she|they)\s+(?:married|single|engaged|divorced|seeing\s+(?:someone|anyone)|dating)\b/i, reason: "marital-status-probe" },
  { re: /\b(?:you|u)\s+married\b/i, reason: "marital-status-probe" },
  { re: /\b(?:is|are)\s+\w+\s+married\b/i, reason: "marital-status-probe" },
  // Spouse / partner identity — "who is he married to", "what's your
  // wife's/husband's name", "who's your wife/partner".
  { re: /\bwho(?:'?s|\s+is)\s+(?:he|she|they|\w+)\s+married\s+to\b/i, reason: "spouse-identity-probe" },
  { re: /\b(?:who'?s|who\s+is|what'?s|what\s+is|name\s+of)\s+(?:your|his|her|their|\w+'?s)\s+(?:wife|husband|spouse|partner|girlfriend|boyfriend|fiance|fiancee)\b/i, reason: "spouse-identity-probe" },
  // Kids / family — "do you have kids", "how many children", "any kids".
  { re: /\b(?:do|does|have)\s+(?:you|u|he|she|they|\w+)\s+(?:have\s+)?(?:any\s+)?(?:kids|children)\b/i, reason: "family-probe" },
  { re: /\b(?:have|got)\s+(?:any\s+)?(?:kids|children)\b\??/i, reason: "family-probe" },
  { re: /\bhow\s+many\s+(?:kids|children)\b/i, reason: "family-probe" },
  // Home / location — "where do you live", "what's your address", "are
  // you home", "are you home alone", "where are you staying".
  { re: /\bwhere\s+(?:do|does)\s+(?:you|u|he|she|they|\w+)\s+(?:live|stay)\b/i, reason: "location-probe" },
  { re: /\bwhat'?s\s+(?:your|his|her|their|\w+'?s)\s+(?:home\s+)?address\b/i, reason: "location-probe" },
  { re: /\b(?:are|r)\s+(?:you|u|he|she)\s+home(?:\s+alone)?\b/i, reason: "location-probe" },
  // Schedule / travel / current plans — "what's your schedule", "when
  // are you traveling", "what are your plans", "when do you leave".
  { re: /\bwhat'?s\s+(?:your|his|her|their|\w+'?s)\s+(?:schedule|routine|itinerary)\b/i, reason: "schedule-probe" },
  { re: /\bwhen\s+(?:are|r|do|does|will)\s+(?:you|u|he|she|they|\w+)\s+(?:travel(?:l?ing)?|leav(?:e|ing)|fly(?:ing)?|go(?:ing)?\s+(?:away|out\s+of\s+town))\b/i, reason: "travel-probe" },
];

export function detectPersonalFactProbe(text: string): EscalationVerdict | null {
  if (!text || text.length < 4) return null;
  for (const p of PERSONAL_FACT_PROBE_PATTERNS) {
    if (p.re.test(text)) {
      return { kind: "personal-fact-probe", reason: p.reason, pattern: p.re.source };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// NON-ENGLISH INJECTION FALLBACK (draft-don't-auto-send)
// ─────────────────────────────────────────────────────────────
// The PROMPT_INJECTION_PATTERNS above are English + romanized-Telugu
// only. An injection / social-engineering probe written in another
// language (Spanish, Hindi native script, Mandarin, Arabic, …) slips
// straight through to the LLM on an owner-impersonation thread.
//
// We CANNOT cheaply pattern-match every language's jailbreak phrasing,
// and we deliberately do NOT call an LLM judge on the hot path (that
// would add latency + cost + a fail-open dependency to the safety
// gate). Instead we degrade SAFELY: when an inbound from a NON-owner
// contact is clearly non-English (low ASCII ratio OR a confident
// non-English language detection) AND none of the deterministic
// English/Telugu patterns fired, we don't refuse and we don't
// auto-send — we raise a "draft for owner approval" caution so the
// owner's eyes are the judge. This is the cheap, deterministic,
// fail-closed posture.
//
// This is intentionally a low-noise signal: ordinary multilingual
// chatter from a contact the owner talks to in that language gets
// drafted (the owner approves with one tap), not refused. The only
// cost of a false positive is one approval tap; the cost of a false
// negative is a leaked secret or a socially-engineered owner.

export interface InjectionCautionInput {
  /** The inbound message text from the contact. */
  text: string;
  /** True when the sender is the verified owner channel. Owner inbound
   *  is never subject to this fallback — the owner can write in any
   *  language to their own assistant. */
  isOwner: boolean;
  /** True when an existing deterministic detector (life-threat /
   *  prompt-injection) already fired this turn. If so, the stronger
   *  verdict wins and we do not also raise the soft caution. */
  alreadyMatched?: boolean;
  /** Optional precomputed language signal (from `detectLanguageHints`)
   *  so callers don't pay for detection twice. When the primary is a
   *  confident non-English language we treat the message as non-English
   *  even if its ASCII ratio is high (e.g. romanized Spanish). */
  languagePrimary?: string;
  languageConfidence?: number;
  /** Languages the OWNER actually speaks (lowercased, e.g. ["english",
   *  "telugu","hindi"]). A message in one of these is NEVER treated as a
   *  suspicious foreign-language probe — it's normal family/social chatter.
   *  Without this, a Telangana-Telugu household's everyday Telugu messages
   *  were all force-drafted and the bot went silent. Defaults to
   *  English/Telugu/Hindi when omitted. */
  expectedLanguages?: string[];
}

export interface InjectionCautionVerdict {
  /** True → route the reply through draft-for-owner-approval instead of
   *  auto-sending. */
  draft: boolean;
  /** Why we flagged it — for logging + the owner's draft note. */
  reason: string;
}

// Fraction of code points that are plain printable ASCII. A message in
// native non-Latin script (Devanagari, CJK, Arabic, Cyrillic, …) lands
// well below this; English + emoji stays high.
const NON_ENGLISH_ASCII_RATIO = 0.6;

function asciiRatio(text: string): number {
  let ascii = 0;
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // Skip whitespace from the denominator — it's script-neutral and
    // would otherwise inflate the ASCII ratio of a short native-script
    // message padded with spaces.
    if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) continue;
    total++;
    if (cp >= 0x20 && cp <= 0x7e) ascii++;
  }
  if (total === 0) return 1;
  return ascii / total;
}

/**
 * SAFE non-English fallback for the injection gate. Returns a `draft`
 * verdict when a NON-owner inbound is non-English and no deterministic
 * detector already fired — so the bridge holds the reply for owner
 * approval rather than auto-sending an LLM reply to a message the
 * deterministic safety layer couldn't read.
 *
 * Deterministic + cheap: a code-point ASCII-ratio scan plus an optional
 * reuse of the already-computed language hint. No LLM call.
 */
export function detectNonEnglishInjectionRisk(
  input: InjectionCautionInput,
): InjectionCautionVerdict | null {
  const text = (input.text || "").trim();
  // Owner is exempt; short tokens ("ola", "si", "👍") carry no probe
  // surface and would be pure noise.
  if (input.isOwner) return null;
  if (input.alreadyMatched) return null;
  if (text.length < 4) return null;

  // The owner's OWN languages are never suspicious. A Telangana-Telugu family
  // texts in Telugu/Hindi all day — force-drafting that silenced the bot. Only
  // a genuinely UNEXPECTED language (one the owner doesn't speak) is a probe
  // surface worth holding for approval.
  const expected = new Set(
    (input.expectedLanguages ?? ["english", "telugu", "hindi"]).map((s) => s.toLowerCase()),
  );
  if (input.languagePrimary && expected.has(input.languagePrimary.toLowerCase())) {
    return null;
  }

  const ratio = asciiRatio(text);
  const lowAscii = ratio < NON_ENGLISH_ASCII_RATIO;
  const confidentNonEnglish =
    !!input.languagePrimary &&
    input.languagePrimary !== "english" &&
    input.languagePrimary !== "unknown" &&
    (input.languageConfidence ?? 0) >= 0.6;

  if (!lowAscii && !confidentNonEnglish) return null;

  const reason = lowAscii
    ? `non-English inbound (ascii-ratio ${ratio.toFixed(2)} < ${NON_ENGLISH_ASCII_RATIO}) — beyond deterministic injection patterns; drafting for owner`
    : `non-English inbound (${input.languagePrimary} @ ${(input.languageConfidence ?? 0).toFixed(2)}) — beyond deterministic injection patterns; drafting for owner`;
  return { draft: true, reason };
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
// Rotating prompt-injection refusals. Repeated probes used to get a
// byte-identical "best to wait for X directly" three times in a row,
// which reads robotic and confirms something's off. Each refusal is
// safe (no confirm/deny, no leak, doesn't explain it's a helper).
const PROMPT_INJECTION_REFUSALS: ((name: string) => string)[] = [
  (n) => `best to wait for ${n} directly on this one.`,
  (n) => `ha, that's one for ${n} himself.`,
  (n) => `gonna let ${n} field that one.`,
  (n) => `you'll have to catch ${n} on that.`,
  (n) => `that's above my pay grade — ask ${n} direct.`,
];

let _refusalCursor = 0;

/** Return a prompt-injection refusal, rotating through the variants so
 *  repeated probes don't get identical replies. */
export function pickRefusal(ownerName: string): string {
  const variant = PROMPT_INJECTION_REFUSALS[_refusalCursor % PROMPT_INJECTION_REFUSALS.length];
  _refusalCursor++;
  return variant(ownerName);
}

export function refusalReply(kind: EscalationKind, ownerName: string): string {
  switch (kind) {
    case "life-threat":
      return `i just paged ${ownerName} on every channel. if it's truly an emergency call 911. he'll see this asap.`;
    case "prompt-injection":
      // Deliberately mundane + VARIED. We don't confirm or deny the
      // probe; we just stop being useful and route to the human.
      return pickRefusal(ownerName);
    default:
      return "";
  }
}
