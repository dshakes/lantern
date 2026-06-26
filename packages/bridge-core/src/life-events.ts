// LIFE-EVENT ENGINE v1 — turn the noisy transactional inbound the bridge used
// to DROP as "marketing/spam" into TYPED, actionable life-events the assistant
// proactively surfaces to the OWNER (self-chat) with one-tap suggested actions.
//
// The owner's complaint: his most useful texts — a GEICO bill, a UPS delivery
// window, an Amex fraud alert, an athenahealth OTP — were suppressed alongside
// real promos. This module recognizes the actionable ones, extracts their
// fields, and decides HOW to surface them (real-time ping vs. batched digest vs.
// keep-suppressing), while still dropping true promos (DSW sale).
//
// Design rules (mirrors the other bridge-core modules):
//   * PURE logic + an OPTIONAL injected `llmCall` hook. No direct I/O — the
//     bridge owns sending, persistence, and the LLM transport.
//   * DETERMINISTIC rules run first and cover the common patterns with zero
//     LLM cost. The LLM is a fallback for ambiguous / low-confidence text only,
//     so unit tests run rules-only (no network).
//   * OWNER-FACING ONLY. Nothing here ever targets the third-party sender; the
//     bridge routes every output to the owner self-chat exclusively.

export type LifeEventKind =
  | "bill"
  | "delivery"
  | "appointment"
  | "fraud_alert"
  | "otp"
  | "travel"
  | "receipt"
  | "promo"
  | "personal"
  | "other";

export type Urgency = "now" | "soon" | "fyi";

export interface LifeEventFields {
  amount?: number;        // numeric, parsed from "$1,989.85" → 1989.85
  currency?: string;      // "USD" (only USD detected in v1)
  dueDate?: string;       // ISO date "2026-06-30" when a due/by date is found
  payee?: string;         // "GEICO", "Amex" — who you pay (bills)
  merchant?: string;      // "UPS", "BlinkRx" — the sender/brand
  trackingNo?: string;    // "1Z825..." carrier tracking number
  carrier?: string;       // "UPS" | "FedEx" | "USPS" | "DHL" | "Amazon" | ...
  eta?: string;           // human ETA verbatim: "tomorrow 10:30 AM - 12:30 PM"
  code?: string;          // OTP / verification code: "611586"
  place?: string;         // appointment / travel location
  time?: string;          // appointment / travel time verbatim
}

export interface LifeEvent {
  kind: LifeEventKind;
  confidence: number;     // 0..1
  urgency: Urgency;
  fields: LifeEventFields;
  rawText: string;
  channel: string;        // "iMessage" | "WhatsApp" | caller-supplied
}

// A one-tap action the owner can confirm. `offerAction` is the verbatim
// instruction the bridge replays through the existing PendingOffer
// (freeform-followup) machinery when the owner says "yes" — so the LLM/AppleScript
// fulfills it deterministically. `kind` lets the bridge special-case the
// deterministic paths (calendar / reminder) without an LLM round-trip.
export interface ProactiveAction {
  label: string;                  // owner-visible button text: "set reminder"
  kind:
    | "calendar"                  // add to Calendar.app (deterministic via mac-actions)
    | "reminder"                  // date-anchored reminder (deterministic)
    | "track"                     // open / search a tracking URL
    | "pay-link"                  // pull up the pay link / payee site
    | "flag-urgent"               // surface a callback number for fraud
    | "snooze"                    // re-surface later
    | "none";
  offerAction?: string;           // freeform fulfillment instruction for the LLM
  url?: string;                   // a concrete URL when we can synthesize one
  phone?: string;                 // callback number (fraud alerts)
}

export interface ProactiveDecision {
  route: "ping" | "digest" | "suppress";
  ownerMessage: string;           // short, natural owner-facing line
  actions: ProactiveAction[];
  event: LifeEvent;
}

// Per-kind owner preference, learned from accept/ignore history. The bridge
// owns persistence (life-events-prefs.json); the module stays pure and takes
// this as input. `accepts`/`ignores` are running counts.
export interface KindPref {
  accepts: number;
  ignores: number;
}
export type LifeEventPrefs = Partial<Record<LifeEventKind, KindPref>>;

// Optional injected LLM hook. Returns a structured classification for ambiguous
// text. Kept optional so rules-only paths (and unit tests) never touch it.
export interface LlmClassification {
  kind: LifeEventKind;
  confidence?: number;
  urgency?: Urgency;
  fields?: LifeEventFields;
}
export type LifeEventLlm = (text: string) => Promise<LlmClassification | null>;

export interface ClassifyOpts {
  channel?: string;
  now?: Date;            // injectable clock for due-date / urgency math + tests
  llmCall?: LifeEventLlm; // ambiguous-fallback only
  // Below confidence this, and only then, the LLM fallback is consulted.
  llmThreshold?: number; // default 0.45
}

// ── Regex building blocks ───────────────────────────────────────────────────

const MONEY_RE = /\$\s?([\d,]+(?:\.\d{2})?)/;

const BILL_RE = /\b(payment|bill|amount\s+due|balance\s+due|balance|autopay|auto-?pay|past\s+due|minimum\s+payment|statement|invoice|premium)\b/i;
const BILL_DUE_RE = /\b(due|by)\b/i;

const DELIVERY_CARRIER_RE = /\b(UPS|FedEx|USPS|DHL|Amazon|DoorDash|Instacart|Lasership|OnTrac)\b/i;
const DELIVERY_VERB_RE = /\b(deliver(?:ed|ing|y)?|arriv(?:e|es|ing)|out\s+for\s+delivery|on\s+its\s+way|shipp(?:ed|ing)|ready\s+to\s+be\s+shipped|package|parcel)\b/i;

const FRAUD_RE = /\b(fraud|suspicious|unusual\s+activity|declined?|did\s+you\s+(?:use|make|try)|security\s+alert|unauthorized|verify\s+(?:this|the)\s+(?:charge|transaction)|was\s+this\s+you)\b/i;

// OTP: a 4–8 digit code adjacent to verification language, either order.
const OTP_RE = /\b(\d{4,8})\b[^.\n]{0,24}?(code|verification|one[-\s]?time|otp|passcode|2fa|two[-\s]?factor)\b|\b(code|verification|one[-\s]?time|otp|passcode)\b[^.\n]{0,24}?\b(\d{4,8})\b/i;

const TRAVEL_RE = /\b(flight|boarding|gate|departure|itinerary|hotel|check[-\s]?in|reservation|confirmation\s*#|booking\s+reference|seat\s+\d|terminal)\b/i;

const RECEIPT_RE = /\b(receipt|order\s+(?:confirmed|confirmation|placed)|thank\s+you\s+for\s+your\s+(?:order|purchase)|your\s+order\s+(?:is|has)|order\s+#)\b/i;

const PROMO_RE = /\b(\d{1,3}\s*%\s*off|sale\b|shop\s+now|unsubscribe|limited\s+time|deal\b|deals\b|coupon|promo\b|lowest\s+price|buy\s+now|exclusive\s+offer|clearance)\b/i;

const APPT_RE = /\b(appointment|appt|your\s+visit|upcoming\s+visit|you'?re\s+(?:booked|scheduled|confirmed)|see\s+you\s+(?:on|at|tomorrow|then)|reschedule|booked\s+with|table\s+for\s+\d)\b/i;

// Carrier tracking numbers. UPS (1Z…), FedEx/USPS long digit strings.
const TRACKING_RE = /\b(1Z[0-9A-Z]{16}|\d{12,22}|[A-Z]{2}\d{9}[A-Z]{2})\b/;

// Known bill payees → canonical name (for the `payee` field + pay-link).
const KNOWN_PAYEES: Array<{ re: RegExp; name: string }> = [
  { re: /\bgeico\b/i, name: "GEICO" },
  { re: /\bamex\b|american\s+express/i, name: "Amex" },
  { re: /\bchase\b/i, name: "Chase" },
  { re: /\bcapital\s*one\b/i, name: "Capital One" },
  { re: /\bciti(?:bank)?\b/i, name: "Citi" },
  { re: /\bwells\s*fargo\b/i, name: "Wells Fargo" },
  { re: /\bbank\s+of\s+america\b|\bbofa\b/i, name: "Bank of America" },
  { re: /\bat&?t\b/i, name: "AT&T" },
  { re: /\bverizon\b/i, name: "Verizon" },
  { re: /\bt-?mobile\b/i, name: "T-Mobile" },
  { re: /\bcomcast\b|\bxfinity\b/i, name: "Xfinity" },
  { re: /\bpg&?e\b/i, name: "PG&E" },
  { re: /\bstate\s+farm\b/i, name: "State Farm" },
  { re: /\bprogressive\b/i, name: "Progressive" },
];

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// ── Field extraction helpers ────────────────────────────────────────────────

function parseAmount(text: string): { amount?: number; currency?: string } {
  const m = text.match(MONEY_RE);
  if (!m) return {};
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return {};
  return { amount: n, currency: "USD" };
}

// Extract a due date like "due Jun 30", "due 6/30", "by 06/30/2026". Anchors the
// year to `now` (next occurrence) when the text omits it.
function parseDueDate(text: string, now: Date): string | undefined {
  // "Jun 30" / "June 30" / "Jun 30, 2026"
  const named = text.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/i,
  );
  if (named) {
    const mo = MONTHS[named[1].slice(0, 3).toLowerCase()];
    const day = parseInt(named[2], 10);
    let year = named[3] ? parseInt(named[3], 10) : now.getFullYear();
    if (mo !== undefined && day >= 1 && day <= 31) {
      // If no explicit year and the date already passed this year, roll forward.
      if (!named[3]) {
        const candidate = new Date(year, mo, day);
        if (candidate.getTime() < now.getTime() - 86_400_000) year += 1;
      }
      return isoDate(year, mo, day);
    }
  }
  // "6/30" or "06/30/2026"
  const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numeric) {
    const mo = parseInt(numeric[1], 10) - 1;
    const day = parseInt(numeric[2], 10);
    let year = numeric[3]
      ? numeric[3].length === 2 ? 2000 + parseInt(numeric[3], 10) : parseInt(numeric[3], 10)
      : now.getFullYear();
    if (mo >= 0 && mo <= 11 && day >= 1 && day <= 31) {
      if (!numeric[3]) {
        const candidate = new Date(year, mo, day);
        if (candidate.getTime() < now.getTime() - 86_400_000) year += 1;
      }
      return isoDate(year, mo, day);
    }
  }
  return undefined;
}

function isoDate(year: number, monthIdx: number, day: number): string {
  const mm = String(monthIdx + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// Pull an ETA / delivery-window phrase verbatim ("tomorrow 10:30 AM - 12:30 PM",
// "by Friday", "today by 8pm").
function parseEta(text: string): string | undefined {
  const win = text.match(
    /\b((?:tomorrow|today|tonight|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2})\b[^.\n]{0,40}?\d{1,2}[:.]?\d{0,2}\s*(?:am|pm)(?:\s*[-–]\s*\d{1,2}[:.]?\d{0,2}\s*(?:am|pm))?)/i,
  );
  if (win) return win[1].replace(/\s+/g, " ").trim();
  const day = text.match(/\b(?:by\s+)?(tomorrow|today|tonight|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i);
  if (day) return day[0].replace(/\s+/g, " ").trim();
  return undefined;
}

function detectPayee(text: string): string | undefined {
  for (const p of KNOWN_PAYEES) if (p.re.test(text)) return p.name;
  return undefined;
}

function detectCarrier(text: string): string | undefined {
  const m = text.match(DELIVERY_CARRIER_RE);
  return m ? m[1].toUpperCase().replace("FEDEX", "FedEx") : undefined;
}

function extractCode(text: string): string | undefined {
  const m = text.match(OTP_RE);
  if (!m) return undefined;
  return m[1] || m[4]; // group 1 (code-first) or group 4 (label-first)
}

function extractPhone(text: string): string | undefined {
  const m = text.match(/\b(?:1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/);
  return m ? m[0].trim() : undefined;
}

// ── Core classifier ─────────────────────────────────────────────────────────

/**
 * Classify a single inbound message into a typed LifeEvent. DETERMINISTIC rules
 * run first and resolve the common cases (bill / delivery / fraud / otp / travel
 * / receipt / promo) with no LLM cost. Only ambiguous / low-confidence text
 * consults the injected `llmCall` (when provided). Synchronous-friendly: returns
 * a Promise only because of the optional LLM fallback — the rules path resolves
 * immediately.
 */
export async function classifyLifeEvent(text: string, opts: ClassifyOpts = {}): Promise<LifeEvent> {
  // Deterministic rules first — fast, no LLM. rulesDispatch is the single
  // source of truth shared with the sync entry point.
  const verdict = rulesDispatch(text, opts);

  // Only consult the injected LLM when the rules landed on a low-confidence,
  // non-actionable verdict ("personal"/"other") — i.e. genuinely ambiguous.
  const ambiguous = !isActionableKind(verdict.kind) && verdict.kind !== "promo";
  if (opts.llmCall && ambiguous && verdict.confidence < (opts.llmThreshold ?? 0.45)) {
    try {
      const out = await opts.llmCall((text || "").replace(/\s+/g, " ").trim());
      if (out && out.kind) {
        return {
          kind: out.kind,
          confidence: out.confidence ?? 0.6,
          urgency: out.urgency ?? "fyi",
          fields: out.fields ?? {},
          rawText: text || "",
          channel: opts.channel || "",
        };
      }
    } catch {
      /* LLM fallback is best-effort — fall through to the rules verdict */
    }
  }
  return verdict;
}

// Synchronous rules-only entry point — for callers/tests that never want the
// LLM. Identical dispatch to classifyLifeEvent's rules phase.
export function classifyLifeEventSync(text: string, opts: Omit<ClassifyOpts, "llmCall"> = {}): LifeEvent {
  return rulesDispatch(text, opts);
}

// The single source of truth for the deterministic dispatch, shared by the
// async classifier (rules phase) and the sync entry point.
function rulesDispatch(text: string, opts: Omit<ClassifyOpts, "llmCall"> = {}): LifeEvent {
  const channel = opts.channel || "";
  const now = opts.now || new Date();
  const raw = text || "";
  const t = raw.replace(/\s+/g, " ").trim();
  const base = (kind: LifeEventKind, confidence: number, urgency: Urgency, fields: LifeEventFields): LifeEvent =>
    ({ kind, confidence, urgency, fields, rawText: raw, channel });

  if (t.length < 4) return base("other", 0.2, "fyi", {});
  const money = parseAmount(t);
  const hasMoney = money.amount !== undefined;
  const isPromo = PROMO_RE.test(t);

  if (FRAUD_RE.test(t) && !isPromo) {
    return base("fraud_alert", 0.92, "now", { ...money, payee: detectPayee(t), merchant: detectPayee(t) });
  }
  const code = extractCode(t);
  if (code) return base("otp", 0.95, "now", { code });
  if (BILL_RE.test(t) && hasMoney && !isPromo) {
    const dueDate = parseDueDate(t, now);
    return base("bill", 0.9, billUrgency(dueDate, now), { ...money, dueDate, payee: detectPayee(t) });
  }
  const carrier = detectCarrier(t);
  if ((carrier && DELIVERY_VERB_RE.test(t)) || (/\bready\s+to\s+be\s+shipped\b/i.test(t) && !isPromo)) {
    const trackMatch = t.match(TRACKING_RE);
    return base("delivery", carrier ? 0.88 : 0.7, "soon", {
      carrier, merchant: carrier || firstWordBrand(t), eta: parseEta(t),
      trackingNo: trackMatch ? trackMatch[1] : undefined,
    });
  }
  if (TRAVEL_RE.test(t) && !isPromo && /\b\d/.test(t)) {
    return base("travel", 0.78, "soon", { time: parseEta(t), eta: parseEta(t) });
  }
  if (APPT_RE.test(t) && !isPromo) return base("appointment", 0.8, "soon", { time: parseEta(t) });
  if (RECEIPT_RE.test(t) && !isPromo) return base("receipt", 0.75, "fyi", { ...money, merchant: firstWordBrand(t) });
  if (isPromo) return base("promo", 0.85, "fyi", {});
  return base("personal", 0.4, "fyi", {});
}

// "BlinkRx: Your order…" → "BlinkRx"; falls back to undefined when the first
// token isn't a brand-shaped word.
function firstWordBrand(text: string): string | undefined {
  const m = text.match(/^\s*([A-Za-z][A-Za-z0-9&.\-]{1,24})\s*[:\-]/);
  if (m) return m[1];
  return undefined;
}

// A bill is `now` (ping) when due within 3 days, `soon` within ~14, else `fyi`.
function billUrgency(dueIso: string | undefined, now: Date): Urgency {
  if (!dueIso) return "soon";
  const due = new Date(`${dueIso}T23:59:59`);
  const days = (due.getTime() - now.getTime()) / 86_400_000;
  if (days <= 3) return "now";
  if (days <= 14) return "soon";
  return "fyi";
}

// ── Suggested actions ───────────────────────────────────────────────────────

const ACTIONABLE_KINDS: ReadonlySet<LifeEventKind> = new Set<LifeEventKind>([
  "bill", "delivery", "appointment", "fraud_alert", "otp", "travel", "receipt",
]);

export function isActionableKind(kind: LifeEventKind): boolean {
  return ACTIONABLE_KINDS.has(kind);
}

export function suggestedActionsFor(event: LifeEvent): ProactiveAction[] {
  const f = event.fields;
  switch (event.kind) {
    case "bill": {
      const payee = f.payee || f.merchant;
      const due = f.dueDate ? ` (due ${f.dueDate})` : "";
      return [
        {
          label: "set reminder",
          kind: "reminder",
          offerAction: `Set a calendar reminder to pay the ${payee || "bill"}${f.amount ? ` of $${f.amount}` : ""}${due}. Emit a [CALENDAR:Pay ${payee || "bill"}|<dueDate or +2d>T09:00|...|amount ${f.amount ?? ""}] marker.`,
        },
        {
          label: "pull pay link",
          kind: "pay-link",
          url: payLinkFor(payee),
          offerAction: `Pull up the pay link / billing page for ${payee || "this bill"} and reply with the URL.`,
        },
        { label: "snooze", kind: "snooze" },
      ];
    }
    case "delivery": {
      const track = trackingUrlFor(f.carrier, f.trackingNo);
      return [
        {
          label: "add to calendar",
          kind: "calendar",
          offerAction: `Add the ${f.carrier || "delivery"} to my calendar${f.eta ? ` for ${f.eta}` : ""}. Emit a [CALENDAR:${f.carrier || "Package"} delivery|<eta ISO>|...|${f.trackingNo ?? ""}] marker.`,
        },
        {
          label: "track",
          kind: "track",
          url: track,
          offerAction: f.trackingNo
            ? `Open the ${f.carrier || ""} tracking page for ${f.trackingNo} and reply with the status.`
            : `Find the tracking status for this ${f.carrier || "package"} and reply with it.`,
        },
      ];
    }
    case "appointment":
    case "travel":
      return [
        {
          label: "add to calendar",
          kind: "calendar",
          offerAction: `Add this ${event.kind} to my calendar. Emit a [CALENDAR:Title|start-ISO|end-ISO?|notes] marker parsed from: "${event.rawText.slice(0, 200)}".`,
        },
      ];
    case "fraud_alert": {
      const phone = extractPhone(event.rawText);
      const actions: ProactiveAction[] = [
        { label: "flag urgent", kind: "flag-urgent", phone },
      ];
      return actions;
    }
    case "otp":
      // Just surface the code — no action.
      return [];
    case "receipt":
      // FYI in the digest; no one-tap action in v1.
      return [];
    default:
      return [];
  }
}

// Best-effort pay-link / billing-page guesser for known payees. Returns a
// search URL when no canonical login page is known so the owner still gets a tap.
function payLinkFor(payee?: string): string | undefined {
  if (!payee) return undefined;
  const map: Record<string, string> = {
    "GEICO": "https://www.geico.com/login/",
    "Amex": "https://www.americanexpress.com/",
    "Chase": "https://www.chase.com/personal/credit-cards/login",
    "Capital One": "https://verified.capitalone.com/auth/signin",
    "Citi": "https://online.citi.com/",
    "AT&T": "https://www.att.com/acctmgmt/login",
    "Verizon": "https://www.verizon.com/signin",
    "Xfinity": "https://login.xfinity.com/",
  };
  return map[payee] || `https://www.google.com/search?q=${encodeURIComponent(payee + " pay bill login")}`;
}

function trackingUrlFor(carrier?: string, trackingNo?: string): string | undefined {
  if (!trackingNo) return undefined;
  const c = (carrier || "").toUpperCase();
  if (c === "UPS") return `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNo)}`;
  if (c === "FEDEX") return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNo)}`;
  if (c === "USPS") return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNo)}`;
  if (c === "DHL") return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(trackingNo)}`;
  return `https://www.google.com/search?q=${encodeURIComponent((carrier || "") + " tracking " + trackingNo)}`;
}

// ── Proactive routing decision ──────────────────────────────────────────────

const CONFIDENCE_FLOOR = 0.55;

// Money formatting for the owner line: "$1,989.85".
function fmtMoney(amount?: number, currency?: string): string {
  if (amount === undefined) return "";
  const sym = currency === "USD" || !currency ? "$" : "";
  return `${sym}${amount.toLocaleString("en-US", { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

// Pretty due date "2026-06-30" → "Jun 30".
function fmtDueShort(iso?: string): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}`;
}

/**
 * Decide HOW to surface a classified life-event to the owner, given their
 * learned per-kind preference. Returns the route, a short natural owner-facing
 * line, and the one-tap actions.
 *
 * Routing baseline (before prefs):
 *   * urgency 'now'  (fraud / otp / bill-due-soon) → ping (real-time self-chat)
 *   * actionable 'soon'/'fyi' (delivery / receipt / far-out bill) → digest
 *   * promo / personal / low-confidence / non-actionable → suppress
 *
 * Owner-model overlay: after enough IGNOREs of a kind, downgrade its route one
 * notch (ping→digest→suppress). ACCEPT history protects/keeps the route.
 */
export function proactiveDecision(event: LifeEvent, prefs: LifeEventPrefs = {}): ProactiveDecision {
  const actions = suggestedActionsFor(event);
  const ownerMessage = buildOwnerMessage(event, actions);

  // Non-actionable or low-confidence → suppress (but still recorded by caller).
  if (!isActionableKind(event.kind) || event.confidence < CONFIDENCE_FLOOR) {
    return { route: "suppress", ownerMessage, actions, event };
  }

  // Baseline route from urgency.
  let route: ProactiveDecision["route"];
  if (event.urgency === "now") route = "ping";
  else route = "digest"; // 'soon' / 'fyi' actionable → batched briefing

  // Owner-model overlay: downgrade after sustained ignores.
  route = applyPrefDowngrade(route, prefs[event.kind]);

  return { route, ownerMessage, actions, event };
}

// Downgrade ping→digest→suppress when the owner has ignored this kind enough
// (net ignores ≥ 3 → one notch; ≥ 6 → two notches). ACCEPTs offset ignores.
export function applyPrefDowngrade(route: ProactiveDecision["route"], pref?: KindPref): ProactiveDecision["route"] {
  if (!pref) return route;
  const net = (pref.ignores || 0) - (pref.accepts || 0);
  let steps = 0;
  if (net >= 6) steps = 2;
  else if (net >= 3) steps = 1;
  if (steps === 0) return route;
  const order: ProactiveDecision["route"][] = ["ping", "digest", "suppress"];
  const idx = Math.min(order.length - 1, order.indexOf(route) + steps);
  return order[idx];
}

// Build the short, natural owner-facing line per kind. Emoji-prefixed so the
// bridge's bot-self guard recognizes it (the bridge registers these prefixes).
function buildOwnerMessage(event: LifeEvent, actions: ProactiveAction[]): string {
  const f = event.fields;
  switch (event.kind) {
    case "bill": {
      const who = f.payee || f.merchant || "a bill";
      const amt = fmtMoney(f.amount, f.currency);
      const due = f.dueDate ? ` due ${fmtDueShort(f.dueDate)}` : "";
      return `💸 ${who} ${amt}${due}. reminder + pay link?`;
    }
    case "delivery": {
      const who = f.carrier || f.merchant || "a package";
      const eta = f.eta ? ` — ${f.eta.toLowerCase()}` : "";
      return `📦 ${who}${eta}. want it on your calendar?`;
    }
    case "fraud_alert": {
      const who = f.payee || f.merchant || "your card";
      const phone = extractPhone(event.rawText);
      return `⚠️ ${who} flagged a declined/suspicious charge — might be fraud.${phone ? ` want the number (${phone})?` : " want the number?"}`;
    }
    case "otp": {
      return `🔑 your code is ${f.code} — (i won't share this with anyone).`;
    }
    case "appointment": {
      const when = f.time ? ` ${f.time}` : "";
      return `📅 looks like an appointment${when}. add it to your calendar?`;
    }
    case "travel": {
      const when = f.time ? ` ${f.time}` : "";
      return `✈️ travel update${when}. add it to your calendar?`;
    }
    case "receipt": {
      const who = f.merchant || "an order";
      const amt = fmtMoney(f.amount, f.currency);
      return `🧾 ${who}${amt ? ` ${amt}` : ""} — order confirmed.`;
    }
    default:
      return "";
  }
}

// ── Owner-model-lite: pure pref mutators ────────────────────────────────────
// The bridge owns persistence (life-events-prefs.json, mode 0600). These pure
// helpers compute the next prefs object so the bridge just writes the result.

export function recordAccept(prefs: LifeEventPrefs, kind: LifeEventKind): LifeEventPrefs {
  const cur = prefs[kind] || { accepts: 0, ignores: 0 };
  return { ...prefs, [kind]: { accepts: cur.accepts + 1, ignores: cur.ignores } };
}

export function recordIgnore(prefs: LifeEventPrefs, kind: LifeEventKind): LifeEventPrefs {
  const cur = prefs[kind] || { accepts: 0, ignores: 0 };
  return { ...prefs, [kind]: { accepts: cur.accepts, ignores: cur.ignores + 1 } };
}

// The owner-facing self-chat prefixes this module emits — exported so the
// bridge's bot-self guard (bot-self.ts BOT_SELF_PREFIXES) stays in sync and the
// bridge never replies to its own life-event pings.
export const LIFE_EVENT_SELF_PREFIXES: string[] = [
  "💸 ",  // bill ping
  "📦 ",  // delivery ping/digest
  "⚠️ ",  // fraud ping (note: shared shape with other warnings)
  "🔑 ",  // otp surface
  "🧾 ",  // receipt
  "✈️ ",  // travel
];
