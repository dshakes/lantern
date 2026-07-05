// EVENT SCOUT — proactive local-event discovery for the owner's family.
//
// The bridge runs a weekly web_search-grounded LLM scan for upcoming
// events near the owner (kids events, fireworks, Indian community
// gatherings, circus, expos, light shows, …), texts the owner a numbered
// list in self-chat, and on "book 1,3" adds the picks to Calendar.app
// with alarm reminders via MacActions.
//
// This module is PURE (no I/O, no clock reads beyond args) — the bridge
// session owns the timer, the LLM call (`${owner}::eventscout` session
// key, webSearch:true), the state file, and the MacActions calls.
// Discovery itself is LLM reasoning over live web search, never a
// hardcoded scrape list — the prompt names sources as starting points
// and instructs the model to search beyond them.
//
// CATEGORY MECHANISM: the category list lives in EventScoutState and is
// owner-editable from self-chat ("events add <cat>" / "events drop <cat>"
// / "events categories") — tuning coverage never needs a code change.

export interface ScoutEvent {
  title: string;
  date: string; // YYYY-MM-DD
  time?: string; // HH:MM 24h, omitted when unknown
  venue?: string;
  city?: string;
  category?: string;
  cost?: string;
  url?: string;
}

export interface EventScoutState {
  categories: string[];
  location: string;
  audience: string;
  windowDays: number;
  // eventKey → epoch ms first shown. Dedupes across scans so the owner
  // sees each event once; GC'd by the session on persist.
  seen: Record<string, number>;
  // Last scan's ranked list — what "book 1,3" indexes into (globally,
  // regardless of which page an event appeared on).
  pending: ScoutEvent[];
  // Pagination cursor: how many of `pending` have been shown so far
  // (picks message sets it to the pick count; "events more" advances it).
  shown: number;
  lastScanAt: number;
}

export const DEFAULT_SCOUT_CATEGORIES = [
  "fireworks",
  "kids & family events",
  "Indian community events (Telugu/Indian shows, concerts, festivals, melas, temple events)",
  "circus",
  "exhibitions & expos",
  "light shows",
  "fairs & carnivals",
  "county / state / DC public events",
];

export function defaultScoutState(): EventScoutState {
  return {
    categories: [...DEFAULT_SCOUT_CATEGORIES],
    location:
      process.env.LANTERN_EVENT_SCOUT_LOCATION ||
      "Chantilly, VA 20152 (Loudoun County — Northern Virginia / DC metro)",
    audience:
      process.env.LANTERN_EVENT_SCOUT_AUDIENCE ||
      "family with a young kid (~4-5 years old); Indian (Telugu) family — Indian community events matter as much as county/state ones",
    windowDays: 60,
    seen: {},
    pending: [],
    shown: 0,
    lastScanAt: 0,
  };
}

export const SCOUT_PAGE_SIZE = 6;

// One page of the ranked list, numbered GLOBALLY (7., 8., …) so
// "book 12" is unambiguous no matter which page it appeared on.
export function formatScoutPage(ordered: ScoutEvent[], start: number, state: EventScoutState): string {
  const pageEnd = Math.min(start + SCOUT_PAGE_SIZE, ordered.length);
  const left = ordered.length - pageEnd;
  return [
    `🎪 events ${start + 1}-${pageEnd} of ${ordered.length}:`,
    ...renderGrouped(ordered, start, pageEnd),
    "",
    left > 0
      ? `reply "book ${start + 1},${start + 2}" to calendar-block · "events more" for the next ${Math.min(SCOUT_PAGE_SIZE, left)}`
      : `that's everything — "book <n>" to calendar-block, "scan events" to look again`,
  ].join("\n");
}

// ── Prompt ──────────────────────────────────────────────────────────

// One scan = one LLM call PER CATEGORY BATCH. A single call covering all
// categories runs many web searches and blows past the bridge's 180s SSE
// turn timeout (verified live: AbortError → empty reply → 0 events).
// Batching keeps each call fast AND guarantees every category gets its
// own dedicated search pass. The session merges + dedupes by eventKey.
export function chunkCategories(categories: string[], size = 3): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < categories.length; i += size) out.push(categories.slice(i, i + size));
  return out;
}

export function buildScoutPrompt(state: EventScoutState, now: Date, categories?: string[]): string {
  const today = isoDate(now);
  const end = isoDate(new Date(now.getTime() + state.windowDays * 24 * 60 * 60 * 1000));
  const cats = (categories ?? state.categories).map((c) => `- ${c}`).join("\n");
  return [
    `You are an event scout for a family in ${state.location}. Audience: ${state.audience}.`,
    `Today is ${today}. Using web search, find REAL upcoming events from ${today} through ${end}.`,
    "",
    "Cover EVERY one of these categories (search each one explicitly):",
    cats,
    "",
    "Search broadly and cross-check multiple sources — county parks & recreation calendars (Loudoun County, Fairfax County), Eventbrite, Ticketmaster, Sulekha and other Indian community listings (Telugu associations, temples, Indian concert promoters), Dulles Expo Center schedule, Macaroni KID, FunInFairfaxVA, Washingtonian / KidFriendly DC family roundups, and official city/county/state pages for fireworks, festivals and light shows. These are starting points, not the full list — follow whatever sources the searches surface.",
    "",
    "Rules:",
    "- ONLY real events you actually found via search, with their real dates and venues. NEVER invent or guess an event, date, or venue. Omit anything you cannot confirm.",
    `- Within roughly 40 miles of ${state.location}.`,
    "- Prefer events suitable for a 4-5 year old, plus the big general ones (fireworks, expos, light shows).",
    "- 3-10 events, sorted by date, no duplicates. Be quick — a few solid finds per category beats an exhaustive sweep.",
    "",
    "Return ONLY this JSON object — no prose, no markdown fences:",
    '{"events":[{"title":"...","date":"YYYY-MM-DD","time":"HH:MM","venue":"...","city":"...","category":"...","cost":"free | $xx | unknown","url":"..."}]}',
    'Omit "time"/"url" when unknown.',
  ].join("\n");
}

// ── Parsing the LLM result (tolerant) ───────────────────────────────

export function parseScoutEvents(raw: string): ScoutEvent[] {
  const text = (raw || "").replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const arr = (parsed as { events?: unknown }).events;
  if (!Array.isArray(arr)) return [];
  const out: ScoutEvent[] = [];
  for (const e of arr) {
    if (out.length >= 25) break;
    if (!e || typeof e !== "object") continue;
    const ev = e as Record<string, unknown>;
    const title = clamp(str(ev.title), 120);
    const date = str(ev.date);
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const time = str(ev.time);
    out.push({
      title,
      date,
      time: /^\d{1,2}:\d{2}$/.test(time) ? time : undefined,
      venue: clamp(str(ev.venue), 120) || undefined,
      city: clamp(str(ev.city), 60) || undefined,
      category: clamp(str(ev.category), 60) || undefined,
      cost: clamp(str(ev.cost), 40) || undefined,
      url: clamp(str(ev.url), 300) || undefined,
    });
  }
  out.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  return out;
}

export function eventKey(ev: ScoutEvent): string {
  return `${ev.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}:${ev.date}`;
}

export function isPastEvent(ev: ScoutEvent, now: Date): boolean {
  return ev.date < isoDate(now);
}

// ── Curation (agentic ranking pass) ─────────────────────────────────
// A flat 19-item list is unusable. After the scan, one cheap no-tools
// LLM call ranks the finds for THIS family and the owner gets only the
// top picks with a one-line why; "events more" shows the rest. Picks
// are moved to the front of pending so numbering is sequential and
// "book 1" always means the top pick.

export interface ScoutPick {
  n: number; // 1-based index into the list given to the curator
  why: string;
}

export function buildCurationPrompt(events: ScoutEvent[], state: EventScoutState): string {
  const lines = events.map(
    (e, i) => `${i + 1}. ${e.date}${e.time ? " " + e.time : ""} — ${e.title}${e.venue ? " @ " + e.venue : ""}${e.city ? ", " + e.city : ""} (${e.cost || "cost unknown"}) [${e.category || "general"}]`,
  );
  return [
    `You are picking the best upcoming events for: ${state.audience}. Home base: ${state.location}.`,
    "Candidates:",
    ...lines,
    "",
    "Pick the 4-6 BEST for this family. Judge by: fit for a 4-5 year old, how special/rare the event is, Indian community relevance, distance, cost, and date spread (don't pick 4 things on the same day; skip near-duplicate listings of the same event).",
    "Return ONLY JSON, no prose:",
    '{"picks":[{"n":<candidate number>,"why":"<ONE short reason, max 12 words>"}]}',
  ].join("\n");
}

export function parseCuration(raw: string, count: number): ScoutPick[] {
  const text = (raw || "").replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const arr = (parsed as { picks?: unknown }).picks;
  if (!Array.isArray(arr)) return [];
  const seen = new Set<number>();
  const out: ScoutPick[] = [];
  for (const p of arr) {
    if (out.length >= 6 || !p || typeof p !== "object") continue;
    const n = Number((p as Record<string, unknown>).n);
    const why = str((p as Record<string, unknown>).why);
    if (!Number.isInteger(n) || n < 1 || n > count || seen.has(n)) continue;
    seen.add(n);
    out.push({ n, why: clamp(why, 80) });
  }
  return out;
}

// Display order: grouped by category (as labeled by the scan LLM —
// "Indian community events" together, "fireworks" together, …), date
// order within each group. Stable so equal keys keep scan order.
export function sortByCategory(events: ScoutEvent[]): ScoutEvent[] {
  return [...events].sort((a, b) => {
    const g = groupLabel(a).localeCompare(groupLabel(b));
    return g !== 0 ? g : (a.date + (a.time || "")).localeCompare(b.date + (b.time || ""));
  });
}

function groupLabel(ev: ScoutEvent): string {
  return (ev.category || "other").toLowerCase();
}

// Reorder: picks first (curator order), the rest category-grouped after.
// Returns the reordered list + the picks' why-lines.
export function applyCuration(events: ScoutEvent[], picks: ScoutPick[]): { ordered: ScoutEvent[]; whys: string[] } {
  const picked = picks.map((p) => events[p.n - 1]);
  const pickedSet = new Set(picked);
  const rest = sortByCategory(events.filter((e) => !pickedSet.has(e)));
  return { ordered: [...picked, ...rest], whys: picks.map((p) => p.why) };
}

// Render a numbered slice with a "▸ category" header wherever the group
// changes — skipped entirely when the whole list is a single group.
function renderGrouped(ordered: ScoutEvent[], start: number, end: number): string[] {
  const multiGroup = new Set(ordered.map(groupLabel)).size > 1;
  const lines: string[] = [];
  for (let i = start; i < end; i++) {
    const ev = ordered[i];
    if (multiGroup && (i === start || groupLabel(ev) !== groupLabel(ordered[i - 1]))) {
      lines.push(`▸ ${ev.category || "other"}`);
    }
    const where = ev.venue ? ` @ ${ev.venue}${ev.city ? ", " + ev.city : ""}` : ev.city ? ` @ ${ev.city}` : "";
    lines.push(`${i + 1}. ${friendlyDate(ev.date)}${ev.time ? " " + ev.time : ""} — ${ev.title}${where}${ev.cost ? ` (${ev.cost})` : ""}`);
  }
  return lines;
}

export function formatScoutPicks(ordered: ScoutEvent[], whys: string[], state: EventScoutState): string {
  const k = whys.length;
  const lines = ordered.slice(0, k).map((ev, i) => {
    const where = ev.venue ? ` @ ${ev.venue}${ev.city ? ", " + ev.city : ""}` : ev.city ? ` @ ${ev.city}` : "";
    const cost = ev.cost ? ` (${ev.cost})` : "";
    return `${i + 1}. ${friendlyDate(ev.date)}${ev.time ? " " + ev.time : ""} — ${ev.title}${where}${cost}\n   ↳ ${whys[i]}`;
  });
  return [
    `🎪 top ${k} picks for the next ${Math.round(state.windowDays / 30)} months (of ${ordered.length} found):`,
    ...lines,
    "",
    `reply "book 1,3" to calendar-block · "events more" for all ${ordered.length} · "events categories" to tune`,
  ].join("\n");
}

// ── Owner-facing formatting ─────────────────────────────────────────
// "🎪 " (list) and "🎟 " (status/ack) are registered in bot-self.ts —
// any new emit here MUST start with one of those prefixes.

export function formatScoutList(events: ScoutEvent[], state: EventScoutState): string {
  return [
    `🎪 events — next ${Math.round(state.windowDays / 30)} months near you:`,
    ...renderGrouped(events, 0, events.length),
    "",
    `reply "book 1,3" (or "book all") to add to calendar with reminders · "events categories" to tune what I scan for`,
  ].join("\n");
}

export function formatCategories(state: EventScoutState): string {
  return [
    "🎟 event categories:",
    ...state.categories.map((c) => `- ${c}`),
    "",
    `"events add <category>" / "events drop <category>" · location: ${state.location} ("events location <place>" to change) · "scan events" to scan now`,
  ].join("\n");
}

// ── Owner command grammar (self-chat) ───────────────────────────────
// Anchored + strict so normal chat never trips it. None of these verbs
// collide with the nl-commands MUTE_VERBS vocabulary.

export type ScoutCommand =
  | { action: "scan" }
  | { action: "list-all" }
  | { action: "list-categories" }
  | { action: "add-category"; value: string }
  | { action: "remove-category"; value: string }
  | { action: "set-location"; value: string };

export function parseScoutCommand(text: string): ScoutCommand | null {
  const t = (text || "").trim();
  if (/^(?:scan|find|check)\s+events$/i.test(t) || /^events?\s+scan$/i.test(t)) {
    return { action: "scan" };
  }
  if (/^events$/i.test(t) || /^events?\s+(?:more|all)$/i.test(t) || /^more\s+events$/i.test(t)) {
    return { action: "list-all" };
  }
  if (/^events?\s+categories$/i.test(t)) return { action: "list-categories" };
  let m = t.match(/^events?\s+add\s+(.{2,80})$/i);
  if (m) return { action: "add-category", value: m[1].trim() };
  m = t.match(/^events?\s+(?:drop|remove)\s+(.{2,80})$/i);
  if (m) return { action: "remove-category", value: m[1].trim() };
  m = t.match(/^events?\s+location\s+(.{2,120})$/i);
  if (m) return { action: "set-location", value: m[1].trim() };
  return null;
}

export interface BookSelection {
  all: boolean;
  nums: number[]; // 1-based indexes into state.pending
}

export function parseBookReply(text: string): BookSelection | null {
  const m = (text || "").trim().match(/^book\s+(all|[\d\s,and&+]+)$/i);
  if (!m) return null;
  if (/^all$/i.test(m[1])) return { all: true, nums: [] };
  const nums = [...new Set((m[1].match(/\d{1,2}/g) || []).map(Number))].filter((n) => n >= 1);
  return nums.length ? { all: false, nums } : null;
}

// ── Calendar spec for a booked event ────────────────────────────────

export function calendarSpecFor(ev: ScoutEvent): {
  title: string;
  start: string;
  end: string;
  notes: string;
  alarmsMinutesBefore: number[];
} {
  const time = ev.time || "10:00";
  const start = `${ev.date}T${time}:00`;
  const [h, mm] = time.split(":").map(Number);
  const endH = Math.min(h + 2, 23); // default 2h block
  const end = `${ev.date}T${String(endH).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
  const notes = [
    ev.venue && `Venue: ${ev.venue}${ev.city ? ", " + ev.city : ""}`,
    ev.category && `Category: ${ev.category}`,
    ev.cost && `Cost: ${ev.cost}`,
    ev.url,
    "(booked by Lantern event scout)",
  ]
    .filter(Boolean)
    .join("\n");
  // Reminders: 1 day + 2 hours before, as Calendar sound alarms.
  return { title: ev.title, start, end, notes, alarmsMinutesBefore: [1440, 120] };
}

// ── helpers ─────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function friendlyDate(iso: string): string {
  const [y, mo, da] = iso.split("-").map(Number);
  const d = new Date(y, mo - 1, da);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}
