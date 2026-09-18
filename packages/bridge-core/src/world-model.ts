// world-model.ts — keep the owner's PRESENT-TENSE self-model current from
// the owner's own cross-app evidence, on a cadence, without the owner typing.
//
// The gap (2026-09-18): the store's grand-opening date moved from the 10th
// to the 18th. Apple Mail had daily Square sales reports and vendor
// confirmations; the device calendar had the day; a contact on iMessage had
// asked "still on for the 18th?" nine days earlier. None of it reached the
// profile — `## Public` said "September 10" because a human wrote that once
// and nothing ever revised it — so on opening day the bot corrected a friend
// from an eight-day-stale line. Every fact the bot knew about the owner's
// life had to be TYPED by the owner; this module derives it.
//
// Shape: pure. The bridge gathers inputs (recent mail subjects, upcoming
// calendar, the current Now/Public lines), one purpose-keyed LLM call
// (`owner::worldmodel`, never a contact's session) returns strict JSON, and
// `applyWorldModel` writes DATED lines into the profile:
//   - `## Now` items are upserted (the section the persona reads
//     present-tense; expires via `until:`).
//   - `## Public (managed)` is rewritten wholesale — the bot OWNS that
//     section; the owner's hand-written `## Public` is never touched.
// Anti-hallucination: every item must cite a `source` that literally
// appears in the inputs (a subject or an event title); anything unsourced,
// undated, or dated in the past is dropped. Fail-safe end to end — any
// error means "no change", never a wrong line.

import { upsertNowLine } from "./owner-profile-auto-update.js";

export interface WorldModelItem { text: string; until: string; source: string }
export interface WorldModel { now: WorldModelItem[]; public: WorldModelItem[] }

export interface WorldModelInputs {
  todayISO: string;
  ownerName: string;
  /** "date · from · subject" lines, newest first. */
  mailLines: string[];
  /** Formatted upcoming-calendar block (may be ""). */
  calendarBlock: string;
  currentNow: string[];
  currentPublic: string[];
}

export const MANAGED_PUBLIC_HEADER = "## Public (managed)";
const MAX_ITEMS = 6;
const MAX_TEXT = 160;
const MAX_HORIZON_DAYS = 120;

export function buildWorldModelPrompt(i: WorldModelInputs): string {
  return [
    `Today is ${i.todayISO}. You maintain ${i.ownerName}'s PRESENT-TENSE world model: the short list of what is going on in ${i.ownerName}'s life right now that an assistant texting AS ${i.ownerName} must know so it never contradicts a friend or asserts a stale date.`,
    ``,
    `INPUTS`,
    `Recent mail (date · from · subject), newest first:`,
    i.mailLines.length ? i.mailLines.slice(0, 80).join("\n") : "(none)",
    ``,
    `Upcoming calendar:`,
    i.calendarBlock.trim() || "(none)",
    ``,
    `Current "## Now" lines (may be stale):`,
    i.currentNow.length ? i.currentNow.map((l) => `- ${l}`).join("\n") : "(none)",
    `Current "## Public" lines (may be stale):`,
    i.currentPublic.length ? i.currentPublic.map((l) => `- ${l}`).join("\n") : "(none)",
    ``,
    `TASK — output STRICT JSON only: {"now":[{"text":"…","until":"YYYY-MM-DD","source":"…"}],"public":[{"text":"…","until":"YYYY-MM-DD","source":"…"}]}`,
    `- now: things happening this week or the next two (a store opening, a trip, a visitor, a delivery, a deadline, an event) that a friend would expect ${i.ownerName} to know. Present tense, one line each, ≤ ${MAX_TEXT} chars. "until" = the last day the line is true.`,
    `- public: announced / business news ANY contact may be told (an opening date, a launch, a move). NEVER private matters — money, health, legal, immigration, family conflict, anything a stranger should not hear.`,
    `- If a current line's date conflicts with fresher evidence (a confirmation, a sales report, a calendar entry), output the CORRECTED item. Write the date explicitly in the text when the item is about a date ("grand opening Sept 18").`,
    `- "source" MUST be an exact subject line or calendar title copied from the inputs above. No source → do not output the item. Never infer an event from a single marketing email.`,
    `- At most ${MAX_ITEMS} items per list. Nothing to say → empty lists. No prose.`,
  ].join("\n");
}

function isISO(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
}

/** Tolerant parse + hard validation. `evidence` is the concatenated inputs
 *  the prompt showed; a source that does not appear in it verbatim
 *  (case-insensitive, ≥ 8 chars) is a hallucination and drops the item. */
export function parseWorldModel(raw: string, todayISO: string, evidence: string): WorldModel {
  const empty: WorldModel = { now: [], public: [] };
  const m = (raw || "").match(/\{[\s\S]*\}/);
  if (!m) return empty;
  let j: { now?: unknown; public?: unknown };
  try { j = JSON.parse(m[0]); } catch { return empty; }
  const ev = evidence.toLowerCase();
  const max = new Date(Date.parse(todayISO) + MAX_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
  const clean = (list: unknown): WorldModelItem[] => {
    if (!Array.isArray(list)) return [];
    const out: WorldModelItem[] = [];
    for (const it of list) {
      if (!it || typeof it !== "object") continue;
      const { text, until, source } = it as Record<string, unknown>;
      if (typeof text !== "string" || typeof until !== "string" || typeof source !== "string") continue;
      const t = text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
      const src = source.trim();
      if (t.length < 4 || src.length < 8 || !ev.includes(src.toLowerCase())) continue;
      if (!isISO(until) || until < todayISO || until > max) continue;
      if (out.some((o) => o.text.toLowerCase() === t.toLowerCase())) continue;
      out.push({ text: t, until, source: src });
      if (out.length >= MAX_ITEMS) break;
    }
    return out;
  };
  return { now: clean(j.now), public: clean(j.public) };
}

/** Rewrite the bot-owned `## Public (managed)` section and upsert `## Now`
 *  lines. Returns the new markdown and a human list of what changed; md is
 *  unchanged (and changes empty) when the model adds nothing new. */
export function applyWorldModel(md: string, model: WorldModel, todayISO: string): { md: string; changes: string[] } {
  const changes: string[] = [];
  let out = md;
  for (const it of model.now) {
    const next = upsertNowLine(out, it.text, it.until);
    if (next !== null) { out = next; changes.push(`now: ${it.text} (through ${it.until})`); }
  }
  const lines = out.split(/\r?\n/);
  const hIdx = lines.findIndex((l) => l.trim().toLowerCase() === MANAGED_PUBLIC_HEADER.toLowerCase());
  const body = [
    MANAGED_PUBLIC_HEADER,
    `<!-- Bot-owned: rebuilt from your mail + calendar on a cadence (refreshed ${todayISO}). Hand edits here are overwritten; put permanent notes under "## Public". -->`,
    ...model.public.map((it) => `- ${it.text} | until: ${it.until}`),
  ];
  if (hIdx === -1) {
    if (model.public.length > 0) {
      out = `${out.replace(/\s*$/, "")}\n\n${body.join("\n")}\n`;
      for (const it of model.public) changes.push(`public: ${it.text} (through ${it.until})`);
    }
    return { md: out, changes };
  }
  let end = lines.length;
  for (let i = hIdx + 1; i < lines.length; i++) if (/^#{2,6}\s+/.test(lines[i])) { end = i; break; }
  const oldItems = lines.slice(hIdx + 1, end).filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.trim());
  const newItems = model.public.map((it) => `- ${it.text} | until: ${it.until}`);
  if (oldItems.join("\n") !== newItems.join("\n")) {
    for (const l of newItems) if (!oldItems.includes(l)) changes.push(`public: ${l.replace(/^- /, "").replace(/ \| until: (\S+)$/, " (through $1)")}`);
    lines.splice(hIdx, end - hIdx, ...body, "");
    out = lines.join("\n");
  }
  return { md: out, changes };
}

/** One short owner FYI so a wrong derivation is one glance from a correction. */
export function formatWorldModelFyi(changes: string[]): string {
  const shown = changes.slice(0, 5).map((c) => `• ${c}`).join("\n");
  const more = changes.length > 5 ? `\n(+${changes.length - 5} more)` : "";
  return `🧭 updated what I know from your mail + calendar:\n${shown}${more}\nwrong? tell me in one line and I'll fix it.`;
}
