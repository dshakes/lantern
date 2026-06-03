// Anticipation engine — the "Jarvis acts before being asked" layer.
//
// A futuristic assistant doesn't wait for a command; it watches the
// signals and surfaces the right nudge at the right moment: "your
// anniversary is tomorrow", "you haven't replied to your sister in 4
// days", "your 3pm starts in 10 min — here's the thread", "you told
// Raju you'd send the doc — still open?".
//
// This module is the BRAIN, not the plumbing. It is a PURE function:
// the bridge gathers the signals (profile facts, awaiting-reply list,
// upcoming calendar events, open commitments) and passes them in;
// `computeProactiveNudges` ranks + dedupes them and hands back a clean
// list the bridge can render to the owner's self-chat.
//
// DESIGN INVARIANTS (read before extending):
//   - PURE + DETERMINISTIC. No I/O, no clock reads, no LLM. The caller
//     passes `now` and every signal. Identical input → identical output,
//     so it's fully unit-testable and replay-safe.
//   - OWNER-ONLY. Every nudge is for the owner's eyes. Callers MUST gate
//     on isOwnerChat before surfacing — this module assumes that's done.
//   - DEDUPE-FRIENDLY. Each nudge carries a stable `dedupeKey` so the
//     bridge can persist "already fired" and never re-nag the same thing
//     the same day.
//   - NATURAL PHRASING. `formatNudgeForOwner` returns a human one-liner,
//     never robotic field-dumps.
//
// Ranking uses the shared contact-priority model where a contact is
// involved, so a high-priority person's overdue reply outranks a cold
// contact's, and a closer relationship's birthday outranks an
// acquaintance's.

import { contactPriority, type ContactSignals } from "./contact-priority.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Public types ─────────────────────────────────────────────────────

/** What kind of proactive nudge this is. Drives icon + phrasing. */
export type NudgeKind =
  | "relationship-date" // upcoming birthday / anniversary
  | "overdue-reply" // contact awaiting a reply for > N days
  | "pre-meeting" // a calendar event starting soon
  | "commitment"; // owner said they'd do something, not yet done

/** A single ranked, dismissable proactive nudge. */
export interface ProactiveNudge {
  kind: NudgeKind;
  /** Owner-facing one-liner (already natural). Same as
   *  `formatNudgeForOwner(nudge)`; precomputed for convenience. */
  text: string;
  /** 0..100 — higher fires first. Derived deterministically from the
   *  signal type + (where relevant) the contact's priority + urgency. */
  priority: number;
  /** Stable key so the bridge won't re-fire the same nudge. Bucketed by
   *  day where appropriate (a birthday nudge is "once today", not "once
   *  ever"). */
  dedupeKey: string;
  /** When the underlying thing is due, epoch ms. Present for dated nudges
   *  (relationship date at local midnight, meeting start). Omitted for
   *  open-ended ones (overdue replies, commitments). */
  dueAt?: number;
}

// ── Input signal shapes (gathered by the bridge, passed in) ──────────

/** A parsed key date from the owner profile's ## Facts / relationships.
 *  The bridge resolves `OwnerFacts.keyDates` + relationship birthdays
 *  into this flat shape. `date` is "YYYY-MM-DD" (year may be the origin
 *  year; we match on month/day for recurrence). */
export interface KeyDateSignal {
  /** Human label, e.g. "wedding anniversary", "Mom's birthday". */
  label: string;
  /** "YYYY-MM-DD". The year is the ORIGINAL year; matching is by
   *  month/day so it recurs annually. */
  date: string;
  /** Optional contact this date belongs to (for priority weighting +
   *  phrasing). e.g. a relationship birthday. */
  contact?: string;
  /** Optional priority signals for the contact, to weight the nudge. */
  contactSignals?: ContactSignals;
}

/** A contact the owner has NOT yet replied to. */
export interface AwaitingReplySignal {
  /** Stable contact handle (phone / jid / email) — used in dedupeKey. */
  handle: string;
  /** Display name for phrasing; falls back to handle. */
  displayName?: string;
  /** Epoch ms of the contact's last inbound message that's still
   *  unanswered. Older = more overdue. */
  lastInboundAt: number;
  /** Optional priority signals so high-priority overdue replies rank
   *  above cold ones. */
  contactSignals?: ContactSignals;
}

/** An upcoming calendar event. */
export interface UpcomingEventSignal {
  /** Event title for phrasing. */
  title: string;
  /** Epoch ms when the event starts. */
  startAt: number;
  /** Optional contact/thread tied to the meeting, surfaced in the nudge
   *  so the owner can jump to context. */
  withContact?: string;
  /** Stable id for dedupe (calendar uid). Falls back to title+startAt. */
  eventId?: string;
}

/** An open commitment the owner made ("I'll send you the doc") that is
 *  not yet fulfilled. Shape mirrors call-commitments.ts loosely but is
 *  generalized so message-derived commitments fit too. */
export interface OpenCommitmentSignal {
  /** Stable id for dedupe. */
  id: string;
  /** The verbatim-ish commitment line ("send Raju the deck"). */
  line: string;
  /** Optional contact the commitment is owed to. */
  contact?: string;
  /** Epoch ms when the commitment was made — older = more nagging. */
  madeAt?: number;
  /** Optional priority signals for the owed-to contact. */
  contactSignals?: ContactSignals;
}

/** Everything the engine needs. The bridge gathers these (I/O lives
 *  there); the engine just ranks. All fields optional so a caller can
 *  pass only the signals it has. */
export interface ProactiveInput {
  /** Reference "now", epoch ms. REQUIRED — keeps the engine pure. */
  now: number;
  /** Upcoming relationship dates (anniversaries, birthdays). */
  keyDates?: KeyDateSignal[];
  /** Contacts awaiting a reply. */
  awaitingReply?: AwaitingReplySignal[];
  /** Upcoming calendar events. */
  upcomingEvents?: UpcomingEventSignal[];
  /** Open, unfulfilled commitments. */
  commitments?: OpenCommitmentSignal[];
  /** Tuning knobs (all have sane defaults). */
  config?: ProactiveConfig;
}

export interface ProactiveConfig {
  /** How many days ahead a relationship date fires a nudge (default 1 —
   *  "tomorrow"). A date today (0 days) always fires. */
  relationshipLookaheadDays?: number;
  /** A reply is "overdue" after this many days unanswered (default 2). */
  overdueReplyDays?: number;
  /** A meeting nudge fires when it starts within this many minutes
   *  (default 15). Already-started meetings (negative delta) are dropped. */
  preMeetingWindowMin?: number;
  /** A commitment nudges after it's been open this many hours (default 4).
   *  Commitments without `madeAt` always qualify. */
  commitmentAgeHours?: number;
  /** Cap on returned nudges (default 8) — keeps the self-chat digest
   *  short. Lowest-priority overflow is dropped. */
  maxNudges?: number;
}

const DEFAULTS: Required<ProactiveConfig> = {
  relationshipLookaheadDays: 1,
  overdueReplyDays: 2,
  preMeetingWindowMin: 15,
  commitmentAgeHours: 4,
  maxNudges: 8,
};

// ── Base priorities per kind (before per-signal adjustment) ──────────
// A meeting in 10 minutes is the most time-critical thing; a birthday
// tomorrow is important but not "right now". Overdue replies + open
// commitments float by contact priority + age.
const BASE = {
  "pre-meeting": 90,
  "relationship-date": 70,
  "overdue-reply": 45,
  commitment: 40,
} as const satisfies Record<NudgeKind, number>;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Parse a "YYYY-MM-DD" into {y,mo,d} (1-based month). Null if malformed. */
function parseYMD(date: string): { y: number; mo: number; d: number } | null {
  const m = (date || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y: parseInt(m[1], 10), mo, d };
}

/**
 * Whole-day delta until the NEXT annual recurrence of a month/day,
 * computed in UTC for determinism. 0 = today, 1 = tomorrow, etc. We
 * normalize both "now" and the target to UTC midnight so the result is
 * a clean integer day count independent of the time-of-day in `now`.
 */
function daysUntilAnnual(now: number, mo: number, d: number): number {
  const n = new Date(now);
  const todayUTC = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  // Candidate this year (handle Feb-29 by clamping into the month).
  let year = n.getUTCFullYear();
  let target = Date.UTC(year, mo - 1, d);
  // If the constructed date rolled over (e.g. Feb 29 in a non-leap
  // year became Mar 1), or it's already in the past, advance a year.
  if (target < todayUTC) {
    year += 1;
    target = Date.UTC(year, mo - 1, d);
  }
  return Math.round((target - todayUTC) / DAY_MS);
}

/** Local-midnight epoch for a given annual recurrence (used as dueAt). */
function nextAnnualMidnight(now: number, mo: number, d: number): number {
  const days = daysUntilAnnual(now, mo, d);
  const n = new Date(now);
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) + days * DAY_MS;
}

/** Day bucket (UTC date string) for dedupe keys that should fire once
 *  per day, not once per call. */
function dayBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Priority contribution of a contact (0..1 fraction of contactPriority). */
function contactWeight(handle: string | undefined, signals: ContactSignals | undefined, now: number): number {
  if (!handle && !signals) return 0;
  const p = contactPriority(handle || "", { ...signals, now });
  return p.score / 100;
}

// ── The engine ───────────────────────────────────────────────────────

/**
 * Rank + dedupe proactive nudges from already-gathered signals.
 *
 * PURE: no I/O, no clock reads. `input.now` is the reference time.
 * Returns nudges sorted by priority desc (ties broken by dueAt asc, then
 * dedupeKey for full determinism), capped at config.maxNudges.
 */
export function computeProactiveNudges(input: ProactiveInput): ProactiveNudge[] {
  const cfg = { ...DEFAULTS, ...(input.config ?? {}) };
  const now = input.now;
  const out: ProactiveNudge[] = [];

  // 1) Relationship dates — birthdays / anniversaries within lookahead.
  for (const kd of input.keyDates ?? []) {
    const ymd = parseYMD(kd.date);
    if (!ymd) continue;
    const days = daysUntilAnnual(now, ymd.mo, ymd.d);
    if (days < 0 || days > cfg.relationshipLookaheadDays) continue;
    // Closer date + higher-priority contact ⇒ higher priority. Today
    // beats tomorrow.
    const proximity = (cfg.relationshipLookaheadDays - days) /
      Math.max(1, cfg.relationshipLookaheadDays); // 1 today → 0 at edge
    const cw = contactWeight(kd.contact, kd.contactSignals, now);
    const priority = clamp(BASE["relationship-date"] + proximity * 12 + cw * 10, 0, 100);
    const nudge: ProactiveNudge = {
      kind: "relationship-date",
      text: "",
      priority,
      // Bucket by the date label + the recurrence year so it can fire on
      // each of the lookahead days but not twice in one call.
      dedupeKey: `reldate:${slug(kd.label)}:${recurrenceYear(now, ymd.mo, ymd.d)}-${pad(ymd.mo)}-${pad(ymd.d)}:${days}d`,
      dueAt: nextAnnualMidnight(now, ymd.mo, ymd.d),
    };
    nudge.text = phraseRelationshipDate(kd, days);
    out.push(nudge);
  }

  // 2) Overdue replies — unanswered past the threshold, ranked by
  //    contact priority then age.
  const overdueMs = cfg.overdueReplyDays * DAY_MS;
  for (const ar of input.awaitingReply ?? []) {
    const ageMs = now - ar.lastInboundAt;
    if (ageMs < overdueMs) continue;
    const days = Math.floor(ageMs / DAY_MS);
    const cw = contactWeight(ar.handle, ar.contactSignals, now);
    // Age adds a little urgency but contact priority dominates — a VIP
    // overdue 2 days should outrank a stranger overdue 10.
    const ageBoost = clamp((days - cfg.overdueReplyDays) * 1.5, 0, 12);
    const priority = clamp(BASE["overdue-reply"] + cw * 35 + ageBoost, 0, 100);
    const nudge: ProactiveNudge = {
      kind: "overdue-reply",
      text: "",
      priority,
      // Once per day per contact — re-nags tomorrow if still unanswered.
      dedupeKey: `overdue:${ar.handle}:${dayBucket(now)}`,
    };
    nudge.text = phraseOverdueReply(ar, days);
    out.push(nudge);
  }

  // 3) Pre-meeting prep — starts within the window, not already begun.
  const windowMs = cfg.preMeetingWindowMin * 60 * 1000;
  for (const ev of input.upcomingEvents ?? []) {
    const deltaMs = ev.startAt - now;
    if (deltaMs < 0 || deltaMs > windowMs) continue;
    const mins = Math.round(deltaMs / 60000);
    // The sooner it starts, the higher — inside the last 5 min it tops out.
    const imminence = clamp((windowMs - deltaMs) / windowMs, 0, 1);
    const priority = clamp(BASE["pre-meeting"] + imminence * 8, 0, 100);
    const nudge: ProactiveNudge = {
      kind: "pre-meeting",
      text: "",
      priority,
      // Bucket per event start so the same meeting nudges once (re-fires
      // are guarded by the bridge persisting this key).
      dedupeKey: `meeting:${ev.eventId || slug(ev.title)}:${ev.startAt}`,
      dueAt: ev.startAt,
    };
    nudge.text = phrasePreMeeting(ev, mins);
    out.push(nudge);
  }

  // 4) Commitments — open past the age threshold (or undated).
  const commitAgeMs = cfg.commitmentAgeHours * 60 * 60 * 1000;
  for (const c of input.commitments ?? []) {
    if (typeof c.madeAt === "number" && now - c.madeAt < commitAgeMs) continue;
    const cw = contactWeight(c.contact, c.contactSignals, now);
    const ageHrs = typeof c.madeAt === "number" ? (now - c.madeAt) / (60 * 60 * 1000) : 0;
    const ageBoost = clamp(ageHrs * 0.5, 0, 15);
    const priority = clamp(BASE.commitment + cw * 25 + ageBoost, 0, 100);
    const nudge: ProactiveNudge = {
      kind: "commitment",
      text: "",
      priority,
      // Once per day per commitment id.
      dedupeKey: `commitment:${c.id}:${dayBucket(now)}`,
    };
    nudge.text = phraseCommitment(c);
    out.push(nudge);
  }

  // Rank: priority desc, then soonest dueAt, then dedupeKey for total
  // determinism on ties.
  out.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const ad = a.dueAt ?? Infinity;
    const bd = b.dueAt ?? Infinity;
    if (ad !== bd) return ad - bd;
    return a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0;
  });

  return out.slice(0, cfg.maxNudges);
}

// ── Phrasing ──────────────────────────────────────────────────────────
// Owner-facing one-liners. Natural, lowercase-ish, never robotic. These
// are the strings the bridge sends to self-chat.

/** Render a nudge as the owner-facing one-liner. Equivalent to the
 *  precomputed `nudge.text`, exposed so callers can re-render if they
 *  store the structured nudge. Deterministic, pure. */
export function formatNudgeForOwner(nudge: ProactiveNudge): string {
  return nudge.text;
}

function phraseRelationshipDate(kd: KeyDateSignal, days: number): string {
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  const label = kd.label.trim();
  // "your anniversary is tomorrow" / "Mom's birthday is today — want me to draft a note?"
  const isOwnersOwn = /\b(anniversary|our )\b/i.test(label) && !kd.contact;
  const subject = isOwnersOwn ? `your ${stripPossessive(label)}` : label;
  const tail = days <= 1 ? " — want me to draft something?" : "";
  return `heads up: ${subject} is ${when}${tail}`;
}

function phraseOverdueReply(ar: AwaitingReplySignal, days: number): string {
  const who = (ar.displayName || ar.handle).trim();
  const span = days === 1 ? "a day" : `${days} days`;
  return `you haven't gotten back to ${who} in ${span} — want me to take a crack at it?`;
}

function phrasePreMeeting(ev: UpcomingEventSignal, mins: number): string {
  const when = mins <= 0 ? "now" : mins === 1 ? "in 1 min" : `in ${mins} min`;
  const title = ev.title.trim();
  const withWho = ev.withContact ? ` with ${ev.withContact.trim()}` : "";
  return `${title}${withWho} starts ${when} — pulling up the thread`;
}

function phraseCommitment(c: OpenCommitmentSignal): string {
  const line = c.line.trim().replace(/^i'?ll\s+/i, "").replace(/[.!]+$/, "");
  const who = c.contact ? ` ${c.contact.trim()}` : "";
  // "still need to send Raju the deck — want me to handle it?"
  return `still on your plate: ${line}${who ? ` (for${who})` : ""} — want me to handle it?`;
}

// ── small helpers ─────────────────────────────────────────────────────

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function slug(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "x";
}

function stripPossessive(label: string): string {
  return label.replace(/^(your|my|our)\s+/i, "");
}

/** The calendar year the NEXT recurrence of mo/d falls in, given now. */
function recurrenceYear(now: number, mo: number, d: number): number {
  const n = new Date(now);
  const todayUTC = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  let year = n.getUTCFullYear();
  if (Date.UTC(year, mo - 1, d) < todayUTC) year += 1;
  return year;
}
