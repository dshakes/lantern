// Proactive inbound classifier for messages from UNKNOWN senders (non-contacts).
//
// Two jobs, both about turning noisy unknown-number traffic into signal:
//   1. APPOINTMENT — a booking/confirmation/reminder text (salon, clinic,
//      restaurant, delivery window…). The bridge surfaces it to the owner and
//      offers to add it to the calendar, so it joins the assistant's
//      intelligence (read_calendar then finds it).
//   2. SPAM / MARKETING — promos, sales, "reply STOP", OTP-farm noise. The
//      bridge suppresses it (no auto-reply, kept out of proactive surfacing).
//   3. OTHER — a real person reaching out; leave normal handling untouched.
//
// Heuristic + explainable on purpose: it gates an LLM step in the bridge
// (only APPOINTMENT candidates get an extraction round-trip), so it must be
// cheap and predictable. Conservative on spam (don't silence a real person),
// generous on appointment (a missed booking is the failure we're fixing).

export type InboundKind = "appointment" | "spam" | "other";

export interface InboundClassification {
  kind: InboundKind;
  signals: string[]; // why — for logs + debugging
}

// A date or time reference: "June 3", "6/3", "tomorrow at 3", "3:45pm", "Mon 10am".
const DATE_TIME_RE =
  /\b(?:\d{1,2}[:.]\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|tomorrow|today|tonight|next\s+(?:week|mon|tue|wed|thu|fri|sat|sun))/i;

const APPOINTMENT_WORDS_RE =
  /\b(appointment|appt|booking|booked|reservation|reserved|confirmed?|confirmation|scheduled?|rescheduled?|your\s+visit|see\s+you|upcoming\s+visit|check[-\s]?in|reminder[:,]?\s|you'?re\s+(?:booked|confirmed|scheduled)|arriving|delivery\s+(?:window|scheduled)|pick\s*up\s+(?:is\s+)?ready)\b/i;

// Unambiguous in-person / event booking language. These do NOT appear in
// payment / bill / OTP / shipping notices, so a match means a real appointment
// even if a deposit amount is mentioned. (Generic "confirmation"/"scheduled"
// are NOT here — they show up in payment receipts too.)
const PHYSICAL_APPT_RE =
  /\b(appointment|appt|reservation|reserved|booking|your\s+visit|upcoming\s+visit|check[-\s]?in|see\s+you\s+(?:then|soon|on|at|tomorrow|there)|delivery\s+window|table\s+for\s+\d|you'?re\s+booked|booked\s+with)\b/i;

// Transactional / financial / OTP / shipping notices. These frequently carry
// "confirmation" + a date but are NOT calendar appointments — offering to
// calendar them is the bug this guards against (e.g. an AT&T payment
// confirmation). When present WITHOUT a physical-appointment word, the message
// is never classified as an appointment.
const TRANSACTION_RE =
  /\b(payment|paid|pymt|transaction|txn|invoice|receipt|bill|billing|balance|amount\s+due|past\s+due|auto-?pay|statement|refund|charged|posted\s+to|noted\s+to\s+account|account\s+(?:#|no\.?|number|ending)|otp|one[-\s]?time\s+(?:code|password|pin)|verification\s+code|security\s+code|your\s+code\s+is|order\s+(?:#|number|no\.?)|has\s+shipped|tracking|you\s+sent\s+\$)\b/i;

const SPAM_WORDS_RE =
  /\b(reply\s+stop|text\s+stop|unsubscribe|opt\s*out|\d{1,3}%\s*off|sale\b|deal\b|deals\b|promo|coupon|discount|limited\s+time|act\s+now|exclusive\s+offer|click\s+(?:here|the\s+link)|shop\s+now|buy\s+now|free\s+(?:gift|trial|shipping)|winner|congratulations\s+you|claim\s+your|lowest\s+price|don'?t\s+miss)\b/i;

// A short link is a strong marketing signal from an unknown sender.
const SHORTLINK_RE = /\b(?:bit\.ly|tinyurl|t\.co|goo\.gl|ow\.ly|lnkd\.in|spr\.ly|[a-z0-9-]+\.(?:link|shop|deals?))\/\S+/i;

/**
 * Classify a message from an UNKNOWN sender. Callers should only invoke this
 * for non-contact, non-owner, non-group inbound (a real contact's text is
 * never "spam" to silence). Pure + synchronous.
 */
export function classifyUnknownInbound(text: string): InboundClassification {
  const t = (text || "").trim();
  if (!t || t.length < 4) return { kind: "other", signals: [] };
  const signals: string[] = [];

  const hasDateTime = DATE_TIME_RE.test(t);
  const hasApptWords = APPOINTMENT_WORDS_RE.test(t);
  const hasPhysicalAppt = PHYSICAL_APPT_RE.test(t);
  const hasTransaction = TRANSACTION_RE.test(t);
  const hasSpamWords = SPAM_WORDS_RE.test(t);
  const hasShortlink = SHORTLINK_RE.test(t);

  if (hasDateTime) signals.push("date/time");
  if (hasApptWords) signals.push("appointment-words");
  if (hasPhysicalAppt) signals.push("physical-appointment");
  if (hasTransaction) signals.push("transaction");
  if (hasSpamWords) signals.push("marketing-words");
  if (hasShortlink) signals.push("shortlink");

  // APPOINTMENT requires a concrete date/time + booking language, not a promo.
  // CRITICAL: a payment/bill/OTP/shipping notice ("Payment Confirmation … paid
  // 6/3") carries "confirmation" + a date but is NOT a calendar event. So a
  // transactional message only counts as an appointment when it ALSO has an
  // unambiguous in-person booking word (reservation, your visit, …) — a mere
  // "confirmation" does not turn a receipt into an appointment.
  if (hasDateTime && !hasSpamWords) {
    if (hasPhysicalAppt) return { kind: "appointment", signals };
    if (hasApptWords && !hasTransaction) return { kind: "appointment", signals };
  }

  // SPAM: explicit marketing language, or a shortlink with no appointment
  // intent. Conservative — needs a real marketing signal, not just a link to
  // a normal domain.
  if (hasSpamWords || (hasShortlink && !hasApptWords)) {
    return { kind: "spam", signals };
  }

  return { kind: "other", signals };
}
