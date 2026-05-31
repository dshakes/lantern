// Post-processor for the personal-docs agent's LLM output.
//
// Why post-process at all? The system prompt instructs the LLM to
// (a) emit dates in a friendly format and (b) ALWAYS end with an
// agentic follow-up when the answer contains an expiry / number /
// file. LLMs are nondeterministic — they follow the instructions
// most of the time but skip them ~10-20%. For a Jarvis-grade
// product, "most of the time" isn't acceptable.
//
// This module deterministically:
//   1. Rewrites ISO / numeric dates into "Sept 14, 2031" style.
//   2. Detects when the answer has an expiry/deadline/ID/file but
//      no question, and appends a natural follow-up offer.
//
// The LLM's session memory still sees the WHOLE post-processed text
// (we don't replay just the original) so the next turn's "yes"
// continuation works.

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const MONTHS_LONG: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

interface DetectedDate {
  iso: string;        // "2031-09-14"
  friendly: string;   // "Sept 14, 2031"
  daysUntil: number;  // negative if past
}

// Friendly format. Three letters + period for the month so it reads
// like a person wrote it. "Sep" → "Sept" because Sept is more
// conversational than the strict abbreviation.
function friendly(d: Date): string {
  const m = MONTHS[d.getMonth()];
  const display = m === "Sep" ? "Sept" : m;
  return `${display} ${d.getDate()}, ${d.getFullYear()}`;
}

// Parse common date patterns out of LLM output. The order matters:
// less ambiguous patterns (ISO with dashes, full month names) are
// tried first. Returns one detected date per match site so the
// caller can rewrite the original text.
export interface ParsedHit {
  raw: string;        // the literal substring as it appears in text
  date: Date;
  start: number;
  end: number;
}

export function parseDates(text: string): ParsedHit[] {
  const out: ParsedHit[] = [];
  const seenSpans: Array<[number, number]> = [];

  const tryAdd = (raw: string, date: Date, start: number, end: number) => {
    if (isNaN(date.getTime())) return;
    // No overlap with previously matched span (avoid double-rewriting)
    for (const [s, e] of seenSpans) {
      if (start < e && end > s) return;
    }
    seenSpans.push([start, end]);
    out.push({ raw, date, start, end });
  };

  // ISO yyyy-mm-dd (Spotlight stamps look like this)
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, d = parseInt(m[3], 10);
    if (mo >= 0 && mo < 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2200) {
      tryAdd(m[0], new Date(y, mo, d), m.index!, m.index! + m[0].length);
    }
  }
  // dd/mm/yyyy — Indian/EU convention, common in Indian passports
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10), y = parseInt(m[3], 10);
    // Disambiguation: if first part > 12, it's clearly the day (dd/mm)
    // If second part > 12, swap (mm/dd)
    // Otherwise default to dd/mm (passport convention in most non-US docs)
    let day: number, mo: number;
    if (a > 12) { day = a; mo = b - 1; }
    else if (b > 12) { mo = a - 1; day = b; }
    else { day = a; mo = b - 1; }
    if (mo >= 0 && mo < 12 && day >= 1 && day <= 31 && y >= 1900 && y <= 2200) {
      tryAdd(m[0], new Date(y, mo, day), m.index!, m.index! + m[0].length);
    }
  }
  // "Month Day, Year" — already friendly, but parse so we can use
  // it for follow-up detection / daysUntil math.
  const monthRe = new RegExp(`\\b(${Object.keys(MONTHS_LONG).join("|")})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "gi");
  for (const m of text.matchAll(monthRe)) {
    const mo = MONTHS_LONG[m[1].toLowerCase()];
    const d = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (mo !== undefined && d >= 1 && d <= 31 && y >= 1900 && y <= 2200) {
      tryAdd(m[0], new Date(y, mo, d), m.index!, m.index! + m[0].length);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Rewrite numeric/ISO date substrings to friendly form. Leaves
// already-friendly forms alone.
export function humanizeDates(text: string): { text: string; primaryDate?: DetectedDate } {
  const hits = parseDates(text);
  if (hits.length === 0) return { text };
  // Rewrite right-to-left so indices stay valid
  let out = text;
  const sorted = [...hits].sort((a, b) => b.start - a.start);
  for (const h of sorted) {
    // Skip if already in long-month form
    if (/\b[A-Z][a-z]+\s+\d{1,2},?\s+\d{4}\b/.test(h.raw)) continue;
    const replacement = friendly(h.date);
    out = out.slice(0, h.start) + replacement + out.slice(h.end);
  }
  // Primary date = the first non-past one we found, or the only one
  const now = new Date();
  const future = hits.filter((h) => h.date.getTime() > now.getTime());
  const primary = future[0] || hits[0];
  const daysUntil = Math.round((primary.date.getTime() - now.getTime()) / 86400000);
  return {
    text: out,
    primaryDate: { iso: primary.date.toISOString().slice(0, 10), friendly: friendly(primary.date), daysUntil },
  };
}

// Detect intent hints in the reply. Used to choose the right
// follow-up wording.
function hasNumber(text: string): boolean {
  // Heuristic: a long alphanumeric token (8+ chars with at least one
  // digit) that isn't a phone or amount. Catches passport numbers,
  // license #s, account #s, etc.
  return /[A-Z0-9-]{8,}/i.test(text) && /\d/.test(text);
}
function endsWithQuestion(text: string): boolean {
  return /\?[\s)*_~"]*$/.test(text.trim());
}
function containsRenewable(text: string): boolean {
  // Words that indicate the date is a renewable thing (worth a
  // reminder) vs. a historical event (don't offer reminder).
  return /\b(passport|license|visa|insurance|policy|membership|card|certificate|registration|permit|subscription|renewal|expir|valid until|valid through|due)\b/i.test(text);
}

// Append a natural agentic follow-up offer when the LLM forgot one.
// Idempotent: if the text already ends with a question, no change.
export function ensureFollowUp(text: string, primaryDate?: DetectedDate): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (endsWithQuestion(trimmed)) return text;

  // Date + renewable thing → reminder offer with computed days-out
  if (primaryDate && primaryDate.daysUntil > 30 && containsRenewable(trimmed)) {
    // Choose lead time based on how far out. >2 years: 6 months; >6mo: 60 days; closer: 30 days
    const lead = primaryDate.daysUntil > 730 ? "6 months" : primaryDate.daysUntil > 180 ? "60 days" : "30 days";
    return `${trimmed.replace(/\.?\s*$/, ".")} want me to add a renewal reminder ${lead} before?`;
  }
  // Past expiry → urgent renewal nudge
  if (primaryDate && primaryDate.daysUntil <= 0 && containsRenewable(trimmed)) {
    return `${trimmed.replace(/\.?\s*$/, ".")} this is already expired — want me to add a renewal task to your calendar today?`;
  }
  // ID/number → note offer
  if (hasNumber(trimmed) && !primaryDate) {
    return `${trimmed.replace(/\.?\s*$/, ".")} want me to save this as a note for easy access?`;
  }
  // No actionable signal → leave as-is (factual answer doesn't need an offer)
  return text;
}

// Single entry point for bridges: friendly dates + guaranteed
// follow-up when applicable. Returns the rewritten reply.
export function humanizeReply(text: string): string {
  const { text: dated, primaryDate } = humanizeDates(text);
  return ensureFollowUp(dated, primaryDate);
}

// Pending offer that the bridge can execute deterministically when
// the user confirms. Solves a real LLM-hallucination bug: even when
// asked to emit a [CALENDAR:...] marker on "yes", the LLM
// frequently claims the reminder is "already set" and skips the
// marker. With this offer cache, the bridge fires the AppleScript
// itself — no LLM round trip needed for the action.
export interface PendingOffer {
  kind: "calendar-reminder" | "save-note" | "freeform-followup";
  // For calendar reminders: the underlying expiry/event date and
  // how many days before to schedule the reminder.
  targetIsoDate?: string;       // e.g. "2031-09-14"
  leadDays?: number;            // 30 / 60 / 180
  title?: string;               // "Passport renewal", "Green card renewal"
  // For note saving: the content to save.
  noteTitle?: string;
  noteBody?: string;
  // For freeform follow-ups: the action the bot offered ("attach
  // the full receipt email", "forward you the calendar link", etc.)
  // captured verbatim from the bot's prior reply so the
  // confirmation-execute path can re-prompt the LLM with full
  // context.
  freeformAction?: string;       // "attach the full receipt email or any details"
  freeformInbound?: string;      // the original user inbound that prompted the offer
  freeformPriorReply?: string;   // the bot's reply that contained the offer
  // When the offer was made (for window-based expiry).
  issuedAt: number;
}

// Analyze a reply for what offer was just made. Returns null when
// no offer is detectable. Mirrors the logic in ensureFollowUp so
// the bridge can store an executable representation of the offer.
export function detectOfferInReply(text: string, primaryDate?: DetectedDate): PendingOffer | null {
  const t = text.trim();
  // Calendar reminder offer
  const calRe = /\b(?:add|set)\s+(?:a\s+)?(?:renewal\s+)?(?:reminder|event|calendar)\s+(\d+)\s+(day|days|month|months|week|weeks)\s+before/i;
  const calMatch = t.match(calRe);
  if (calMatch && primaryDate) {
    const n = parseInt(calMatch[1], 10);
    const unit = calMatch[2].toLowerCase();
    let leadDays = n;
    if (unit.startsWith("month")) leadDays = n * 30;
    else if (unit.startsWith("week")) leadDays = n * 7;
    // Title: try to extract the doc type ("passport", "license", etc.)
    const docMatch = t.match(/\b(passport|license|visa|insurance|policy|membership|card|certificate|registration|permit|subscription)\b/i);
    const docType = docMatch ? docMatch[1].toLowerCase() : "document";
    const title = `${docType.charAt(0).toUpperCase()}${docType.slice(1)} renewal reminder`;
    return {
      kind: "calendar-reminder",
      targetIsoDate: primaryDate.iso,
      leadDays,
      title,
      issuedAt: Date.now(),
    };
  }
  // Note save offer
  if (/\b(?:save|store|remember|note)\b.*\b(?:as a note|for easy access|for later)\b/i.test(t)) {
    // Extract the value to save: usually a long alphanumeric ID
    // present in the same reply.
    const idMatch = t.match(/\b([A-Z0-9-]{8,})\b/);
    if (idMatch) {
      const docMatch = t.match(/\b(passport|green\s*card|license|visa|insurance|policy|account|id)\b/i);
      const docType = docMatch ? docMatch[1].toLowerCase().replace(/\s+/g, "-") : "id";
      return {
        kind: "save-note",
        noteTitle: `${docType} number`,
        noteBody: `${docType}: ${idMatch[1]}\n\n(saved by Lantern on ${new Date().toLocaleString()})`,
        issuedAt: Date.now(),
      };
    }
  }
  // Freeform follow-up offer — broadest match: any "want me to X?" /
  // "shall I X?" / "should I X?" / "happy to X if you want" /
  // "let me know if you want X" pattern. This is the catch-all for
  // offers the schema doesn't have a specific kind for yet —
  // "attach the receipt email", "forward you the link", "pull up the
  // calendar event", etc. The text after the verb is captured verbatim
  // so the confirmation-execute path can re-prompt the LLM with the
  // full context and tools attached.
  //
  // We match the LAST such offer in the reply (multiple "?"s — the
  // most recent is the freshest intent).
  const freeformPatterns = [
    /\bwant\s+me\s+to\s+([^?]{3,180})\?/gi,
    /\bshall\s+i\s+([^?]{3,180})\?/gi,
    /\bshould\s+i\s+([^?]{3,180})\?/gi,
    /\bhappy\s+to\s+([^.!?\n]{3,180})\s+(?:if|when)\s+you\s+(?:want|need|like)/gi,
    /\blet\s+me\s+know\s+if\s+you\s+(?:want|need)\s+(?:me\s+to\s+)?([^.!?\n]{3,180})/gi,
  ];
  let bestFreeform: string | null = null;
  for (const re of freeformPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const captured = m[1].trim().replace(/[,.\s]+$/, "");
      if (captured.length >= 3) bestFreeform = captured;
    }
  }
  if (bestFreeform) {
    return {
      kind: "freeform-followup",
      freeformAction: bestFreeform,
      issuedAt: Date.now(),
    };
  }
  return null;
}

// Confirmation detection. When the user replies with one of these
// after we've issued an offer, execute the cached offer instead of
// passing through to the LLM.
export function looksLikeConfirmation(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 40) return false; // too long to be a clean affirmation
  return /^(yes|yep|yeah|yup|sure|ok|okay|please|do it|go ahead|go for it|set it|add it|save it|set the reminder|add the reminder|schedule it)\b/i.test(t);
}

// Rejection detection. When the user said NO to a pending offer.
// Drops the cached offer + sends a brief ack instead of routing to
// the agent (which would treat "no" as a fresh question and reply).
export function looksLikeRejection(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 30) return false;
  return /^(no|nope|nah|not now|not really|skip|cancel|never mind|nvm|don'?t|do not|leave it)\b/i.test(t);
}

// Combined entry point: returns the polished reply AND the offer
// (if any) so the caller can cache it for next-turn confirmation.
export function humanizeWithOffer(text: string): { reply: string; offer: PendingOffer | null } {
  const { text: dated, primaryDate } = humanizeDates(text);
  const reply = ensureFollowUp(dated, primaryDate);
  // Detect the offer from the FINAL reply (post-follow-up append).
  const offer = detectOfferInReply(reply, primaryDate);
  return { reply, offer };
}
