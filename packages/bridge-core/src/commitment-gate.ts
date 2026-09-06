// commitment-gate.ts — HOLD, don't send, when a contact reply commits the owner.
//
// The incident this exists for (2026-09-03 → 09-06): a relative in distress
// asked the owner for money for a family function. Over three days the bot,
// in the owner's voice, in romanized Telugu, replied ~60 times: "70k pampista"
// (I'll send 70k), "dabbulu sarjesta" (I'll arrange the money), "ha ippude
// pampista" (yes, sending now) — and "ippude call chesta" for a call it never
// made — to someone who wrote that she was sitting at a temple crying. Every
// reply scored MEDIUM or HIGH. Nothing held. The owner got 53 routine 🟡 audit
// pings, each sent AFTER the message had gone.
//
// Why every existing guard missed, and what this does differently:
//   - The tier scorer's only money signal was `$` + digits. "70k", "dabbulu",
//     "paisa" scored zero.                      → multilingual backstop here.
//   - The persona had a "never commit the owner" rule: English prose, no
//     money, no enforcement. A prompt rule is advice, not a guard.
//                                               → this is a GATE at the send
//                                                 boundary; the reply is held.
//   - The promise detector fired after sending and filed a to-do.
//                                               → hold-and-page, not
//                                                 page-after-send.
//
// Two layers, and the reply is held if EITHER says so:
//   1. judge   — one purpose-keyed LLM call. Reasoned, so it works in any
//                language and on paraphrase ("I'll sort it out", "sarjesta").
//   2. backstop — deterministic, multilingual (en / romanized te / hi) money
//                and give-verb patterns. Runs ALWAYS, including when the LLM
//                call fails, so the gate can never fail open on an outage.
//
// This module is pure (no I/O, no bridge state). Callers wire the llmCall with
// a `${jid}::commitgate` session key — never the contact's live session.

export type CommitmentReason =
  | "money-request"   // the contact is asking the owner for money
  | "money-promise"   // the draft promises / offers / arranges money
  | "action-promise"  // the draft promises a call, visit, delivery, payment on the owner's behalf
  | "none";

export interface CommitmentVerdict {
  hold: boolean;
  reason: CommitmentReason;
  /** The words that triggered it — for the owner page and the log. */
  quote?: string;
  /** Which layer decided. "both" when the LLM and the backstop agree. */
  source: "llm" | "backstop" | "both" | "none";
}

export type LlmCall = (prompt: string) => Promise<string>;

// ── Backstop patterns ────────────────────────────────────────────────────────
// Romanized Telugu/Hindi spellings vary; these are deliberately broad stems.
// False positives here cost one owner tap; false negatives cost the owner's
// money and a relative's trust. Bias accordingly.
const MONEY_NOUN =
  /\b(?:money|cash|funds?|advance|dabb\w*|paisa|paise|paisalu|rupay\w*|rupees?|rs\.?|lakh?s?|laksha\w*|udhaar|loan|emi|upi|phonepe|gpay|paytm|transfer|wire|bank)\b|[₹$]/i;
const AMOUNT =
  /\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:k|lakhs?|lakh|l|rs|thousand|crores?|cr)\b|[₹$]\s?\d+|\b(?:thirty|forty|fifty|sixty|seventy|eighty|ninety|twenty|ten)\s*(?:five|k|thousand)\b/i;
// First-person give/send/arrange verbs — English + romanized Telugu + Hindi.
const GIVE_VERB =
  /\b(?:(?:i(?:'ll| will| can| am going to)?\s+)?(?:send|sending|give|giving|pay|paying|transfer|wire|arrange|arranging|sort\s+(?:it\s+)?out)|pamp\w*|pampist\w*|pampinch\w*|ist(?:a|ha|anu|hanu)|iyy\w*|ivv\w*|sarjest\w*|sardhest\w*|sarichest\w*|chest(?:a|ha|anu|hanu)\b|chust(?:a|ha|anu|hanu)\b|ves(?:i|a|ta|tha)\w*|vey\w*|pett\w*|pedat\w*|bhej\w*|bhijwa\w*|de\s*d\w*|dunga|dedunga|kar\s*dunga)\b/i;
// Promises of a concrete action on the owner's behalf.
const ACTION_PROMISE =
  /\b(?:i(?:'ll| will)\s+(?:call|ring|phone|come|visit|drop\s+by|be\s+there|bring|book)|call\s+chest\w*|call\s+chesta|vast\w*\s+(?:nenu|ippudu)|phone\s+chest\w*|milta\s+hu|aa\s*(?:jaunga|raha))\b/i;

/** Deterministic multilingual fail-safe. Pure. */
export function commitmentBackstop(inbound: string, draft: string, recentTranscript = ""): CommitmentVerdict {
  const inb = (inbound || "").trim();
  const out = (draft || "").trim();
  // Money is usually agreed ONCE and then followed by dozens of bare
  // "sending now" / "pampista" turns — the incident's dominant shape. The
  // current pair alone carries no money word; the thread does. Scan the
  // recent transcript (last ~1.5k chars) for the money context.
  const thread = `${(recentTranscript || "").slice(-1500)}\n${inb}\n${out}`;
  const moneyInThread = MONEY_NOUN.test(thread) || AMOUNT.test(thread);

  // The contact is asking for money — even a perfect deflection should be
  // seen by the owner before it goes, because "let me check" is itself hope.
  // An explicit AMOUNT in the inbound ("80k", "2 lakhs", "$500") is enough on
  // its own: the incident's first turn was an itemized bill ("mutton 20k,
  // groceries 14k … total 80k") with no give-verb, and "sare chustha" (ok,
  // I'll look into it) in reply was the moment acceptance was implied. A bare
  // money NOUN ("went to the bank") still needs a give/send verb.
  if (inb && (AMOUNT.test(inb) || (MONEY_NOUN.test(inb) && GIVE_VERB.test(inb)))) {
    const q = inb.match(AMOUNT)?.[0] ?? inb.match(MONEY_NOUN)?.[0] ?? inb.slice(0, 40);
    return { hold: true, reason: "money-request", quote: q, source: "backstop" };
  }
  // The draft promises money: a give/send verb in the draft while money is
  // anywhere in the exchange. "ha ippude pampista" alone says nothing about
  // money — but after "70k isthe function…" it means "sending the 70k now".
  if (moneyInThread && GIVE_VERB.test(out)) {
    const q = out.match(GIVE_VERB)?.[0] ?? out.slice(0, 40);
    return { hold: true, reason: "money-promise", quote: q, source: "backstop" };
  }
  if (ACTION_PROMISE.test(out)) {
    return { hold: true, reason: "action-promise", quote: out.match(ACTION_PROMISE)?.[0], source: "backstop" };
  }
  return { hold: false, reason: "none", source: "none" };
}

function buildPrompt(inbound: string, draft: string, contactName?: string, recentTranscript?: string): string {
  const who = contactName ? `${contactName}` : "a contact";
  return [
    `You are a safety judge for a personal assistant that texts AS its owner. ${who} sent a message and the assistant drafted a reply in the owner's voice. Decide whether the reply must be HELD for the owner instead of sent.`,
    ``,
    `HOLD if ANY of these is true, in ANY language (English, romanized Telugu, Hindi, mixed):`,
    `  1. The contact is asking the owner for money, a loan, a payment, or to cover a cost ("70k isthe function avutundi", "dabbulu levu, pampu", "can you send 500?").`,
    `  2. The reply promises, offers, or implies the owner WILL give/send/arrange/transfer money — now or later ("70k pampista", "dabbulu sarjesta", "ippude pampista", "I'll sort it out", "sending now, check in a bit").`,
    `  3. The reply commits the owner to a concrete action on someone's behalf: a call, a visit, a payment, a delivery, showing up ("call chesta ayanatho", "I'll be there Saturday").`,
    `Do NOT hold ordinary conversation, sympathy without a commitment ("badha padaku"), or thanks.`,
    ``,
    recentTranscript ? `Recent thread (money may have been agreed earlier — a bare "sending now" after that is still a money promise):\n${recentTranscript.slice(-1200)}\n` : ``,
    `Their message: ${(inbound || "").slice(0, 600)}`,
    `Drafted reply: ${(draft || "").slice(0, 400)}`,
    ``,
    `Output ONLY JSON, no prose: {"hold": true|false, "reason": "money-request"|"money-promise"|"action-promise"|"none", "quote": "the exact words that triggered it, or empty"}`,
  ].join("\n");
}

function parseVerdict(raw: string): CommitmentVerdict | null {
  const m = (raw || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { hold?: unknown; reason?: unknown; quote?: unknown };
    const reasons: CommitmentReason[] = ["money-request", "money-promise", "action-promise", "none"];
    const reason = reasons.includes(j.reason as CommitmentReason) ? (j.reason as CommitmentReason) : "none";
    const hold = j.hold === true && reason !== "none";
    return { hold, reason: hold ? reason : "none", quote: typeof j.quote === "string" ? j.quote.slice(0, 120) : undefined, source: "llm" };
  } catch {
    return null;
  }
}

/**
 * Reasoned judgment + deterministic backstop. The reply is held if EITHER
 * says so. Never throws; an LLM failure degrades to backstop-only, so the
 * gate never fails open.
 */
export async function judgeCommitment(opts: {
  inbound: string;
  draft: string;
  contactName?: string;
  /** Recent turns of THIS thread — money is agreed once, then promised bare. */
  recentTranscript?: string;
  llmCall?: LlmCall;
}): Promise<CommitmentVerdict> {
  const backstop = commitmentBackstop(opts.inbound, opts.draft, opts.recentTranscript);
  let llm: CommitmentVerdict | null = null;
  if (opts.llmCall) {
    try {
      llm = parseVerdict(await opts.llmCall(buildPrompt(opts.inbound, opts.draft, opts.contactName, opts.recentTranscript)));
    } catch {
      llm = null;
    }
  }
  if (llm?.hold && backstop.hold) return { ...llm, source: "both", quote: llm.quote || backstop.quote };
  if (llm?.hold) return llm;
  if (backstop.hold) return backstop;
  return { hold: false, reason: "none", source: llm ? "llm" : "none" };
}

/** The owner page for a held reply. Deliberately NOT the 🟡 audit-ping shape:
 *  53 of those were sent about the incident and none registered as urgent. */
export function commitmentHoldPage(opts: {
  contactLabel: string;
  inbound: string;
  draft: string;
  verdict: CommitmentVerdict;
}): string {
  const what =
    opts.verdict.reason === "money-request" ? "is asking you for MONEY"
    : opts.verdict.reason === "money-promise" ? "— the draft PROMISES MONEY on your behalf"
    : "— the draft COMMITS you to an action";
  const q = opts.verdict.quote ? ` ("${opts.verdict.quote}")` : "";
  return [
    `⚠️ HELD — ${opts.contactLabel} ${what}${q}. I have NOT replied.`,
    ``,
    `They: ${opts.inbound.slice(0, 240)}`,
    ``,
    `Draft (not sent): ${opts.draft.slice(0, 300)}`,
    ``,
    `Reply yourself, or type what to send and I'll send THAT. I will not send the draft unless you say "send".`,
  ].join("\n");
}
