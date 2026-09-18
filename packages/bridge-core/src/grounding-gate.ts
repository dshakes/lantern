// grounding-gate.ts — HOLD, don't send, when a contact reply ASSERTS something
// about the owner's own life that the bridge cannot ground, or answers loss
// with a party.
//
// Two incidents this exists for (both live, both auto-sent as HIGH/MEDIUM):
//
//   2026-09-18 07:02 (WhatsApp, Bharath). Opening day of the owner's store.
//     They: "Showtime today??"   →  Bot: "not today, sep 10 is the big day 🎉"
//     They: "18th anukuna"       →  Bot: "haha no worries, it was 10th 😄"
//     They: "Oh done ha"         →  Bot: "ha, all done and rolling now"
//   The only date the persona held was a stale `## Public` line ("grand
//   opening September 10") carrying a "do not contradict" directive. The bot
//   corrected a human — twice — about the owner's own opening day, from a
//   fact eight days out of date, then invented the outcome.
//
//   2026-09-17 05:06 (WhatsApp, replayed after quiet hours). A contact sent a
//   memorial-ceremony card (a person's photo, dates, "ceremony"). The vision
//   caption had no tone; the register table had no memorial lexeme; the
//   reply was in the register of an "exciting party".
//
// Why every existing guard missed: the tier scorer keys on reply SHAPE (short,
// no names → safe), the commitment gate on money/promises, the bot-tell filter
// on stock phrases. Nothing asked "is this reply CLAIMING a fact about the
// owner that only the owner could confirm?" or "is the tone wrong for a loss?".
// A prompt rule ("when unsure, [[NO_REPLY]]") is advice the model may ignore.
// This is a GATE at the send boundary: the reply is held, the owner is paged
// with the claim, and the owner's one line becomes the reply.
//
// Two layers; held if EITHER says so:
//   1. judge   — one purpose-keyed LLM call (`${jid}::groundgate`). Reasoned,
//                so it works on paraphrase and any language.
//   2. backstop — deterministic. Runs ALWAYS, so an LLM outage cannot fail
//                open: an explicit calendar date asserted in a reply to a
//                timing question; a date that contradicts the contact's; a
//                loss/memorial inbound answered in a celebratory register.
//
// Pure (no I/O, no bridge state). Callers wire the llmCall with a
// `${jid}::groundgate` session key — never the contact's live session.

export type GroundingReason =
  | "date-assertion"      // the draft states a specific calendar date/time for an owner event
  | "contradicts-contact" // the draft corrects the contact about the owner's own plans
  | "unverifiable-claim"  // the draft asserts an outcome/status only the owner could know
  | "register-mismatch"   // loss / memorial / illness answered in a celebratory or jokey tone
  | "none";

export interface GroundingVerdict {
  hold: boolean;
  reason: GroundingReason;
  /** The words that triggered it — for the owner page and the log. */
  quote?: string;
  source: "llm" | "backstop" | "both" | "none";
}

export type LlmCall = (prompt: string) => Promise<string>;

// ── Backstop patterns ────────────────────────────────────────────────────────
// Explicit calendar dates only — month+day, an ordinal day ("the 10th"),
// ISO, or n/n. Weekdays and "tomorrow" are deliberately NOT here: "sat works"
// is ordinary scheduling chatter and already scored by the tier's
// future-commitment rule. A bare date in a contact reply is different: the
// bridge has no way to know the owner's real calendar, so any date it states
// about the owner's world is a guess wearing the owner's voice.
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?";
const DATE_TOKEN = new RegExp(
  `\\b(?:${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+\\d{4})?|(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)\\b|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?)`,
  "gi",
);
// The contact is asking about timing / whether something happened.
const TIMING_QUESTION = /\?|\b(?:today|tonight|tomorrow|when|what day|which day|is it|was it|done|over|happened|still on|showtime|opening|launch|big day)\b/i;
// Loss / memorial / illness on the contact's side. English + the Telugu/Hindi
// memorial-rite words a card or a relative actually uses. The vision caption
// of a memorial card ("invitation for a ceremony … photo of the person") is
// matched as a shape, because the card itself rarely says "memorial".
const GRIEF =
  /\b(?:memorial|condolenc\w*|rest\s+in\s+peace|r\.?i\.?p\.?|passed\s+(?:away|on)|died|death|demise|funeral|obituary|last\s+rites|cremat\w*|prayer\s+meet\w*|shraddh\w*|shradh\w*|dasadina|dashadina|pedda\s+karma|chinna\s+karma|karma\s+ceremony|tervi|chautha|antim\s+sanskar|antyeshti|mourning|bereave\w*|in\s+loving\s+memory|no\s+more\b|is\s+no\s+more|late\s+(?:mr|mrs|smt|sri|shri|dr)\b|hospital|icu|surgery|cancer|accident)\b|(?:invitation|card|notice)[\s\S]{0,120}ceremony[\s\S]{0,200}(?:photo|picture|image)\s+of\s+(?:the|a)\s+(?:person|deceased|man|woman|lady)|🕯️|🪦|⚰️/iu;
const CELEBRATORY =
  /\b(?:party|exciting|excited|congrats|congratulations|fun|can'?t\s+wait|awesome|woohoo|cheers|celebrat\w*|enjoy|have\s+a\s+blast|let'?s\s+go|lit|epic|sounds\s+great|so\s+cool|nice\s+one|yay)\b|[🎉🥳🎊🍾🥂😂🤣😄😆]/iu;

function datesIn(s: string): string[] {
  return [...(s || "").matchAll(DATE_TOKEN)].map((m) => m[0].toLowerCase().replace(/\s+/g, " ").replace(/^the /, ""));
}

/** Deterministic fail-safe. Pure. */
export function groundingBackstop(inbound: string, draft: string): GroundingVerdict {
  const inb = (inbound || "").trim();
  const out = (draft || "").trim();
  if (!out) return { hold: false, reason: "none", source: "none" };

  // Loss answered with a party. Checked first: it is the worse failure and
  // needs no dates.
  if (inb && GRIEF.test(inb) && CELEBRATORY.test(out)) {
    return { hold: true, reason: "register-mismatch", quote: out.match(CELEBRATORY)?.[0], source: "backstop" };
  }

  const draftDates = datesIn(out);
  if (draftDates.length === 0) return { hold: false, reason: "none", source: "none" };
  const inboundDates = datesIn(inb);
  // The contact named a date; the draft named a different one. The contact
  // may well be right — they might have fresher news than the profile.
  if (inboundDates.length > 0 && draftDates.some((d) => !inboundDates.includes(d))) {
    return { hold: true, reason: "contradicts-contact", quote: draftDates.find((d) => !inboundDates.includes(d)), source: "backstop" };
  }
  // A NEW date (one the contact did not say) stated in answer to a timing
  // question is a claim about the owner's calendar the bridge cannot check.
  // Echoing the contact's own date ("still on for the 18th?" → "yep, 18th")
  // adds no information and is not held.
  const fresh = draftDates.filter((d) => !inboundDates.includes(d));
  if (inb && fresh.length > 0 && TIMING_QUESTION.test(inb)) {
    return { hold: true, reason: "date-assertion", quote: fresh[0], source: "backstop" };
  }
  return { hold: false, reason: "none", source: "none" };
}

function buildPrompt(inbound: string, draft: string, contactName?: string, recentTranscript?: string): string {
  const who = contactName ? contactName : "a contact";
  return [
    `You are a grounding judge for a personal assistant that texts AS its owner. ${who} sent a message and the assistant drafted a reply in the owner's voice. The assistant does NOT have the owner's live calendar, inbox, or knowledge of what happened today; anything it states about the owner's own life is reconstructed from notes that may be out of date. Decide whether the reply must be HELD for the owner instead of sent.`,
    ``,
    `HOLD if ANY of these is true, in ANY language (English, romanized Telugu, Hindi, mixed):`,
    `  1. date-assertion — the reply states a specific date, day, or time for something in the owner's own life or business (an opening, a trip, a delivery, an appointment) in answer to a question about it ("not today, sep 10 is the big day").`,
    `  2. contradicts-contact — the reply corrects or contradicts what the contact said about the owner's plans or events ("haha no, it was the 10th"). The contact may have fresher information than the assistant; the assistant must never correct a human about the owner's own life.`,
    `  3. unverifiable-claim — the reply asserts an outcome or status only the owner could confirm: that something is done, went well, happened, was sent, is open, is sold out ("all done and rolling now"), when the assistant has no record of it.`,
    `  4. register-mismatch — the message (or the image it describes) is about a death, memorial, funeral, illness, accident, loss, or bad news, and the reply's tone is celebratory, casual, jokey, or treats it as a party or fun event.`,
    `Do NOT hold ordinary conversation, greetings, thanks, opinions, small talk, or a reply that ASKS the contact instead of asserting. Do NOT hold a reply that plainly says the owner will get back to them.`,
    ``,
    recentTranscript ? `Recent thread:\n${recentTranscript.slice(-1200)}\n` : ``,
    `Their message: ${(inbound || "").slice(0, 600)}`,
    `Drafted reply: ${(draft || "").slice(0, 400)}`,
    ``,
    `Output ONLY JSON, no prose: {"hold": true|false, "reason": "date-assertion"|"contradicts-contact"|"unverifiable-claim"|"register-mismatch"|"none", "quote": "the exact words in the reply that triggered it, or empty"}`,
  ].join("\n");
}

const REASONS: GroundingReason[] = ["date-assertion", "contradicts-contact", "unverifiable-claim", "register-mismatch", "none"];

export function parseGroundingVerdict(raw: string): GroundingVerdict | null {
  const m = (raw || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { hold?: unknown; reason?: unknown; quote?: unknown };
    const reason = REASONS.includes(j.reason as GroundingReason) ? (j.reason as GroundingReason) : "none";
    const hold = j.hold === true && reason !== "none";
    return { hold, reason: hold ? reason : "none", quote: typeof j.quote === "string" ? j.quote.slice(0, 120) : undefined, source: "llm" };
  } catch {
    return null;
  }
}

/**
 * Reasoned judgment + deterministic backstop. Held if EITHER says so. Never
 * throws; an LLM failure degrades to backstop-only, so the gate never fails
 * open.
 */
export async function judgeGrounding(opts: {
  inbound: string;
  draft: string;
  contactName?: string;
  recentTranscript?: string;
  llmCall?: LlmCall;
}): Promise<GroundingVerdict> {
  const backstop = groundingBackstop(opts.inbound, opts.draft);
  let llm: GroundingVerdict | null = null;
  if (opts.llmCall) {
    try {
      llm = parseGroundingVerdict(await opts.llmCall(buildPrompt(opts.inbound, opts.draft, opts.contactName, opts.recentTranscript)));
    } catch {
      llm = null;
    }
  }
  if (llm?.hold && backstop.hold) return { ...llm, source: "both", quote: llm.quote || backstop.quote };
  if (llm?.hold) return llm;
  if (backstop.hold) return backstop;
  return { hold: false, reason: "none", source: llm ? "llm" : "none" };
}

/** The owner page for a held reply. Same "⚠️ HELD —" shape as the commitment
 *  gate (registered bot-self prefix), so it is never mistaken for the routine
 *  🟡 audit ping. The owner's one typed line becomes the reply. */
export function groundingHoldPage(opts: { contactLabel: string; inbound: string; draft: string; verdict: GroundingVerdict }): string {
  const q = opts.verdict.quote ? ` ("${opts.verdict.quote}")` : "";
  const what =
    opts.verdict.reason === "register-mismatch"
      ? `sent something that reads like a loss / memorial, and the draft's tone is wrong${q}`
      : opts.verdict.reason === "contradicts-contact"
        ? `said something about your plans and the draft CORRECTS them${q} — I can't verify who's right`
        : opts.verdict.reason === "date-assertion"
          ? `asked about timing and the draft states a date${q} I can't verify from your calendar or mail`
          : `asked something only you can answer and the draft CLAIMS it${q}`;
  return [
    `⚠️ HELD — ${opts.contactLabel} ${what}. I have NOT replied.`,
    ``,
    `They: ${opts.inbound.slice(0, 240)}`,
    ``,
    `Draft (not sent): ${opts.draft.slice(0, 300)}`,
    ``,
    `Type the real answer and I'll send THAT, or "send" if the draft is right. I will not send the draft on my own.`,
  ].join("\n");
}
