// iPhone DEVICE-CONTEXT signal for the personal harness — "learn what the owner
// is doing on his phone", richly: not just app-opens, but location, focus mode,
// device state (CarPlay/charging/AirPods), health (steps/sleep/workout),
// now-playing media, and wake/sleep/screenshot rhythm.
//
// Sibling of mac-usage.ts (Mac knowledgeC.db slice). Where mac-usage distills
// macOS foreground app-usage, this distills the iPhone activity stream that the
// owner's iOS Shortcuts automations POST into ~/.lantern/device-signals.jsonl.
// Both feed ONE short, human "what you've been doing" line into the OWNER's own
// self-chat assistant context.
//
// ─── PRIVACY POSTURE (HARD RULES, not defaults) ──────────────────────────────
//   1. LOCAL + PRIVATE. The signals never leave the owner's Mac except for the
//      iPhone→tunnel hop that delivers them. The file is owner-only (0600).
//   2. OWNER-ONLY. The summary is injected ONLY into the owner's self-chat
//      assistant context. It is NEVER added to a reply that goes to a contact —
//      a contact must never learn what the owner is doing on his phone.
//   3. SUMMARIES, NOT RAW LOGS, IN THE PROMPT. This module aggregates raw event
//      lines into one sentence. Only that sentence reaches the LLM context.
//   4. FAILS CLOSED. The reader (device-signals-reader.ts) no-ops on any failure
//      (missing file, garbage lines) — the bridge never crashes and simply has
//      no iPhone signal that tick.
//
// This file is PURE (parse JSONL lines + summarize). All I/O — reading the
// JSONL file — lives in services/imessage-bridge/src/device-signals-reader.ts
// and is injected, so this logic is unit-testable with mock lines and no fs.

// ─── Signal shape ────────────────────────────────────────────────────────────
// One line of ~/.lantern/device-signals.jsonl, written by the control-plane
// /v1/signals route from an iPhone Shortcuts automation POST.
//
// SHARED CONTRACT (the receiver writes these; the bridge reads them):
//   {kind:"app_open",    app:"YouTube", ts}
//   {kind:"location",    detail:"Home", ts}
//   {kind:"focus",       detail:"Work", ts}
//   {kind:"device",      detail:"CarPlay", ts}   (or "charging", "AirPods", "Office WiFi")
//   {kind:"health",      metric:"steps", value:6200, ts}   (metric in steps|sleep|workout)
//   {kind:"health",      detail:"ran 3mi", ts}
//   {kind:"now_playing", detail:"Song - Artist", ts}
//   {kind:"wake"|"sleep"|"screenshot", ts}
export type SignalKind =
  | "app_open"
  | "location"
  | "focus"
  | "device"
  | "health"
  | "now_playing"
  | "wake"
  | "sleep"
  | "screenshot"
  | "custom";

/** A health metric category. */
export type HealthMetric = "steps" | "sleep" | "workout";

export interface DeviceSignal {
  /** What kind of event this is. Defaults to "app_open". */
  kind: SignalKind;
  /** App name for app_open / custom (e.g. "Instagram"). Optional for the
   *  ambient kinds, which carry their payload in detail/metric/value. */
  app?: string;
  /** Free-text detail (focus mode, place, device state, track title, workout). */
  detail?: string;
  /** Health metric category (steps | sleep | workout) when kind === "health". */
  metric?: HealthMetric;
  /** Numeric value for a health metric (steps count, sleep hours, etc.). */
  value?: number;
  /** Unix epoch ms when the event happened. */
  ts: number;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────
const VALID_KINDS: ReadonlySet<string> = new Set<SignalKind>([
  "app_open",
  "location",
  "focus",
  "device",
  "health",
  "now_playing",
  "wake",
  "sleep",
  "screenshot",
  "custom",
]);

const VALID_HEALTH_METRICS: ReadonlySet<string> = new Set<HealthMetric>([
  "steps",
  "sleep",
  "workout",
]);

/** Kinds that don't need an `app` — they carry meaning in detail/metric/value
 *  (or are bare markers like wake/sleep/screenshot). */
const APPLESS_KINDS: ReadonlySet<string> = new Set<SignalKind>([
  "location",
  "focus",
  "device",
  "health",
  "now_playing",
  "wake",
  "sleep",
  "screenshot",
]);

/** Parse one JSONL line into a DeviceSignal, or null if malformed. Never
 *  throws — a bad line is simply dropped. */
export function parseSignalLine(line: string): DeviceSignal | null {
  const trimmed = (line || "").trim();
  if (!trimmed) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  const rawKind = typeof o.kind === "string" ? o.kind : "app_open";
  const kind: SignalKind = (VALID_KINDS.has(rawKind) ? rawKind : "app_open") as SignalKind;

  const ts =
    typeof o.ts === "number" && Number.isFinite(o.ts) && o.ts > 0 ? o.ts : NaN;
  if (!Number.isFinite(ts)) return null;

  const app = typeof o.app === "string" && o.app.trim() ? o.app.trim() : undefined;
  const detail =
    typeof o.detail === "string" && o.detail.trim() ? o.detail.trim() : undefined;
  const metric =
    typeof o.metric === "string" && VALID_HEALTH_METRICS.has(o.metric)
      ? (o.metric as HealthMetric)
      : undefined;
  const value =
    typeof o.value === "number" && Number.isFinite(o.value) ? o.value : undefined;

  // An app_open / custom line MUST name an app. The appless kinds need at least
  // one meaningful payload field (detail, or metric/value for health) — except
  // the bare rhythm markers (wake/sleep/screenshot) which are meaningful alone.
  if (kind === "app_open" || kind === "custom") {
    if (!app) return null;
  } else if (kind === "wake" || kind === "sleep" || kind === "screenshot") {
    // bare markers — no payload required
  } else if (!detail && metric === undefined && value === undefined) {
    return null;
  }

  const sig: DeviceSignal = { kind, ts };
  if (app) sig.app = app;
  if (detail) sig.detail = detail;
  if (metric) sig.metric = metric;
  if (value !== undefined) sig.value = value;
  return sig;
}

/** Parse an array of JSONL lines into DeviceSignals, dropping malformed ones. */
export function parseSignals(lines: string[]): DeviceSignal[] {
  const out: DeviceSignal[] = [];
  for (const line of lines || []) {
    const sig = parseSignalLine(line);
    if (sig) out.push(sig);
  }
  return out;
}

// ─── Summarization ───────────────────────────────────────────────────────────
export interface AppCount {
  app: string;
  /** Number of app_open events for this app in the window. */
  opens: number;
  /** Unix ms of the most-recent event for this app. */
  lastTs: number;
}

export interface DeviceSummary {
  /** Apps sorted by opens desc (recency tiebreak), capped to opts.topN. */
  topApps: AppCount[];
  /** The most-recent signals in the window (newest first), capped to ~6. */
  recent: DeviceSignal[];
  /** One short natural sentence, or "" when there's nothing worth saying. */
  summaryLine: string;
}

export interface SummarizeDeviceOpts {
  /** How many apps to surface in topApps + the sentence. Default 4. */
  topN?: number;
  /** Lookback window in ms. Signals older than nowMs - windowMs are ignored.
   *  Default ~2h. */
  windowMs?: number;
  /** "now" anchor, Unix ms. Defaults to Date.now(). */
  nowMs?: number;
  /** How many recent signals to keep in `recent`. Default 6. */
  recentN?: number;
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** Human "how long ago" phrasing for the window, used to anchor the sentence. */
function windowLabel(windowMs: number): string {
  const hours = windowMs / (60 * 60 * 1000);
  if (hours <= 0) return "recently";
  if (hours < 1) {
    const mins = Math.round(windowMs / (60 * 1000));
    return `last ${mins}m`;
  }
  if (hours < 1.5) return "last hour";
  return `last ${Math.round(hours)}h`;
}

/**
 * Distill iPhone activity signals into a short owner-facing line + structure.
 *
 * Filters to the lookback window, groups app_open events by app, notes the
 * most-recent, and folds in the latest location / focus / device / health /
 * now_playing as trailing clauses (latest-wins per category). Empty / all-stale
 * input yields summaryLine "".
 */
export function summarizeDeviceSignals(
  signals: DeviceSignal[],
  opts: SummarizeDeviceOpts = {},
): DeviceSummary {
  const topN = opts.topN ?? 4;
  const windowMs = opts.windowMs ?? TWO_HOURS_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const recentN = opts.recentN ?? 6;
  const cutoff = nowMs - windowMs;

  const inWindow = (signals || []).filter(
    (s) => s && Number.isFinite(s.ts) && s.ts >= cutoff && s.ts <= nowMs,
  );

  // Most-recent first.
  const recentSorted = [...inWindow].sort((a, b) => b.ts - a.ts);
  const recent = recentSorted.slice(0, recentN);

  // Per-app open counts (app_open + custom both count as "using the app").
  const byApp = new Map<string, AppCount>();
  for (const s of inWindow) {
    if (s.kind !== "app_open" && s.kind !== "custom") continue;
    if (!s.app) continue;
    const existing = byApp.get(s.app);
    if (existing) {
      existing.opens += 1;
      if (s.ts > existing.lastTs) existing.lastTs = s.ts;
    } else {
      byApp.set(s.app, { app: s.app, opens: 1, lastTs: s.ts });
    }
  }
  const apps = Array.from(byApp.values()).sort(
    (a, b) => b.opens - a.opens || b.lastTs - a.lastTs,
  );
  const topApps = apps.slice(0, topN);

  // Latest of each ambient kind (these don't count as app-opens but enrich the line).
  const latestOf = (kind: SignalKind): DeviceSignal | undefined =>
    recentSorted.find((s) => s.kind === kind);
  // Latest health signal per metric category (steps / sleep / workout).
  const latestHealth = (pred: (s: DeviceSignal) => boolean): DeviceSignal | undefined =>
    recentSorted.find((s) => s.kind === "health" && pred(s));

  const summaryLine = buildDeviceSummaryLine({
    topApps,
    windowMs,
    location: latestOf("location"),
    focus: latestOf("focus"),
    device: latestOf("device"),
    steps: latestHealth((s) => s.metric === "steps"),
    sleep: latestHealth((s) => s.metric === "sleep"),
    // workout is metric:"workout" OR a detail-only health line (e.g. "ran 3mi").
    workout: latestHealth((s) => s.metric === "workout" || (!s.metric && !!s.detail)),
    nowPlaying: latestOf("now_playing"),
  });

  return { topApps, recent, summaryLine };
}

// ─── Contact-facing availability ─────────────────────────────────────────────
// Derive owner AVAILABILITY from the latest iPhone signals, for the
// contact-facing concierge (presence.ts feeds this into "is he free?" replies).

export type SignalPresenceState = "driving" | "dnd" | "sleep" | "busy" | "free";

export interface SignalPresence {
  state: SignalPresenceState;
  /** Availability-only line for the prompt. CRITICAL: never contains a place or
   *  whereabouts — safe to surface to a contact. */
  line: string;
  /** True when the owner is unavailable (contacts get "he'll get back"). */
  away: boolean;
}

/**
 * Map the latest in-window iPhone signals to owner AVAILABILITY — never a place.
 *
 * This is what lets the phone triggers (driving, Focus/status, geofences) reach
 * the contact-facing concierge. A geofence like "Gym"/"Airport" maps to a coarse
 * activity/away state, and the place name is NEVER echoed, so the result is safe
 * to show a contact (the whereabouts guard in natural.ts is the second line of
 * defense). Returns null when no focus/device/location signal is in-window — the
 * caller then falls back to macOS Focus / calendar / free.
 *
 * Priority: driving (device) → Focus/status (focus) → geofence (location).
 */
export function presenceFromSignals(
  signals: DeviceSignal[],
  opts: { nowMs?: number; windowMs?: number } = {},
): SignalPresence | null {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? TWO_HOURS_MS;
  const cutoff = nowMs - windowMs;
  const recent = (signals || [])
    .filter((s) => s && Number.isFinite(s.ts) && s.ts >= cutoff && s.ts <= nowMs)
    .sort((a, b) => b.ts - a.ts);
  const latest = (kind: SignalKind): DeviceSignal | undefined => recent.find((s) => s.kind === kind);

  // 1. Driving — strongest, BUT the most time-sensitive and the most damaging
  //    to leak stale (telling a contact "driving rn" while you're home is a
  //    blunder). A 'driving' signal (CarPlay / car Bluetooth) goes stale fast —
  //    people park within minutes — so honor it ONLY when:
  //      (a) it's FRESH (within DRIVING_FRESH_MS, not the full 2h window), AND
  //      (b) no MORE-RECENT location or focus signal has superseded it. Arriving
  //          home (location:Home) or tapping Parked/Available (focus:Available)
  //          posts a newer signal → driving is no longer true → fall through.
  const DRIVING_FRESH_MS = 30 * 60 * 1000; // 30 min backstop when no park/home signal fires
  const devSig = latest("device");
  const dev = (devSig?.detail || "").trim().toLowerCase();
  if (devSig && /carplay|driving/.test(dev)) {
    const fresh = devSig.ts >= nowMs - DRIVING_FRESH_MS;
    const locSig = latest("location");
    const focusSig = latest("focus");
    const superseded =
      (!!locSig && locSig.ts > devSig.ts) || (!!focusSig && focusSig.ts > devSig.ts);
    if (fresh && !superseded) {
      return { state: "driving", line: "driving right now", away: true };
    }
    // else: stale or superseded by a newer location/focus → fall through to the
    // focus/geofence logic below (e.g. focus:Available → free; location:Home → null).
  }

  // 2. Focus / status button. Echo only the availability, never the raw name.
  const f = (latest("focus")?.detail || "").trim().toLowerCase();
  if (f) {
    if (/dnd|do not disturb/.test(f)) return { state: "dnd", line: "on Do Not Disturb", away: true };
    if (/sleep/.test(f)) return { state: "sleep", line: "asleep right now", away: true };
    if (/available|free/.test(f)) return { state: "free", line: "free / available", away: false };
    if (/busy|desk|work/.test(f)) return { state: "busy", line: "heads-down right now", away: true };
    // Any other named Focus → busy, availability-only (never echo the name; it
    // could be a place/whereabouts the owner named their Focus after).
    return { state: "busy", line: "tied up right now", away: true };
  }

  // 3. Geofence → COARSE availability only. The place name is never returned.
  const loc = (latest("location")?.detail || "").trim().toLowerCase();
  if (loc) {
    if (/gym|fitness|workout/.test(loc)) return { state: "busy", line: "working out right now", away: true };
    if (/airport|travel|flight/.test(loc)) return { state: "busy", line: "away right now", away: true };
    if (/office|work/.test(loc)) return { state: "busy", line: "heads-down right now", away: false };
    // "Home" or any unknown place is NOT an availability signal — fall through.
    return null;
  }

  return null;
}

// ── Truthful location (for ALLOWED close contacts only) ─────────────────────
// presenceFromSignals is availability-only and deliberately never carries a
// place. This is the SEPARATE, opt-in source of the owner's REAL place, used
// ONLY when the owner wants a specific close contact (spouse/family) to get a
// truthful "where are you" answer. Never call this for a general contact, and
// never let its output reach a contact the owner hasn't allowed.

const LOCATION_TTL_MS = 6 * 60 * 60 * 1000; // location is sticky — a desk day stays "the office" for hours

export interface KnownLocation {
  /** Natural phrase for sharing: "the office", "home", "the gym", "on the road". */
  place: string;
  /** True when the most recent trustworthy signal is fresh driving (in transit). */
  inTransit: boolean;
  /** Minutes since the backing signal. */
  ageMin: number;
}

/**
 * The owner's REAL current location, or null when there's no recent trustworthy
 * signal (in which case the bot must NOT state a location — no fabrication).
 * 6h window because location is sticky (unlike availability). Driving within the
 * last 30 min and newer than any location ⇒ in transit.
 */
export function latestKnownLocation(
  signals: DeviceSignal[],
  opts: { nowMs?: number; ttlMs?: number } = {},
): KnownLocation | null {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? LOCATION_TTL_MS;
  const cutoff = nowMs - ttlMs;
  const recent = (signals || [])
    .filter((s) => s && Number.isFinite(s.ts) && s.ts >= cutoff && s.ts <= nowMs)
    .sort((a, b) => b.ts - a.ts);
  const locSig = recent.find((s) => s.kind === "location");
  const devSig = recent.find((s) => s.kind === "device");

  const DRIVING_FRESH_MS = 30 * 60 * 1000;
  if (
    devSig &&
    /carplay|driving/.test((devSig.detail || "").toLowerCase()) &&
    devSig.ts >= nowMs - DRIVING_FRESH_MS &&
    (!locSig || devSig.ts >= locSig.ts)
  ) {
    return { place: "on the road", inTransit: true, ageMin: Math.round((nowMs - devSig.ts) / 60000) };
  }
  if (!locSig) return null;
  const raw = (locSig.detail || "").trim();
  if (!raw) return null;
  const lc = raw.toLowerCase();
  let place = raw; // default: the owner's own geofence label, verbatim
  if (/office|work/.test(lc)) place = "the office";
  else if (/^home$|at home|^house$/.test(lc)) place = "home";
  else if (/gym|fitness|workout/.test(lc)) place = "the gym";
  else if (/airport/.test(lc)) place = "the airport";
  return { place, inTransit: false, ageMin: Math.round((nowMs - locSig.ts) / 60000) };
}

// Inner circle = the people the owner has granted EXTRA privileges to (truthful
// location + agentic actions): spouse, kids, siblings, and their families.
// Classified from the owner's OWN relationship label (his data — set in
// owner-profile), not a hardcoded contact list, so a newly-labeled family
// member extends it for free.
const INNER_CIRCLE_RE =
  /\b(wife|husband|spouse|partner|son|daughter|kid|kids|child|children|koduku|kuthuru|brother|sister|sibling|bro|sis|in-?law|bava|vadina|maradalu|baava|niece|nephew|sister['’]?s|brother['’]?s)\b/i;

/** True when the contact's relationship label puts them in the owner's inner
 *  circle (spouse / siblings / their family) — the tier allowed truthful
 *  presence + agentic actions. Empty/unknown relationship → false (fail-safe). */
export function isInnerCircle(relationship?: string | null): boolean {
  return !!relationship && INNER_CIRCLE_RE.test(relationship);
}

/**
 * Build the ground-truth location block injected ONLY into an allowed close
 * contact's reply turn (spouse). It gives the LLM the FACTS and tells it to
 * answer naturally — it does NOT hand it a canned line. When `known` is null,
 * it instructs an honest "I don't know" (never a guess). The caller injects
 * this only for the allowed contact; `truthfulLocationKnown` should be set to
 * `known != null` on the bot-tell context.
 */
/**
 * Ground-truth block about the owner's whereabouts, injected into EVERY 1:1
 * reply so the model never invents a location. Three cases:
 *   - canShare + known signal → the real place, share it plainly.
 *   - canShare + no signal    → honest "I don't know", never guess.
 *   - !canShare               → do not disclose; deflect, never fabricate.
 * `canShare` is true only for inner-circle contacts with disclosure allowed.
 */
export function formatOwnerLocationBlock(
  known: KnownLocation | null,
  ownerName: string,
  contactLabel: string,
  canShare: boolean,
): string {
  const NO_FABRICATE =
    `NEVER invent a location or movement status — not "still out", "out", "on my way", "omw", ` +
    `"almost home", "heading back", "reached", "ping you when i'm close", or any made-up whereabouts. ` +
    `Fabricating where ${ownerName} is is the single worst failure; an honest "not sure" is always better.`;
  if (canShare && known) {
    const where = known.inTransit ? "on the road (driving)" : `at ${known.place}`;
    const age = known.ageMin <= 1 ? "just now" : `${known.ageMin} min ago`;
    return (
      `## ${ownerName}'s current location — TRUE, and you MAY share it plainly with ${contactLabel}\n` +
      `Latest phone signal (${age}): ${ownerName} is ${where}.\n` +
      `If ${contactLabel} asks "where are you", answer truthfully from this fact in ${ownerName}'s casual voice — one short line. ` +
      `Do NOT round or soften it into a different place. Only say "on my way"/"heading back" if the signal actually shows transit. ` +
      `Beyond this real signal, ${NO_FABRICATE}`
    );
  }
  if (canShare && !known) {
    return (
      `## ${ownerName}'s location right now — UNKNOWN\n` +
      `You have NO recent location signal — you genuinely don't know where ${ownerName} is. ` +
      `If ${contactLabel} asks "where are you", say so honestly and warmly (e.g. "not sure exactly rn, ping you in a bit"). ` +
      NO_FABRICATE
    );
  }
  // Not an inner-circle contact (or disclosure denied): never share whereabouts.
  return (
    `## ${ownerName}'s location — do NOT disclose to ${contactLabel}\n` +
    `You do NOT share ${ownerName}'s whereabouts with this contact. If they ask "where are you", ` +
    `deflect warmly WITHOUT naming a place or a movement, and keep it short ` +
    `(e.g. "caught up with a few things — what's up?"). ` +
    NO_FABRICATE
  );
}

interface BuildLineInput {
  topApps: AppCount[];
  windowMs: number;
  location?: DeviceSignal;
  focus?: DeviceSignal;
  device?: DeviceSignal;
  steps?: DeviceSignal;
  sleep?: DeviceSignal;
  workout?: DeviceSignal;
  nowPlaying?: DeviceSignal;
}

/** Map a raw device-state detail to a natural verb/noun. CarPlay → "driving";
 *  everything else passes through (lower-cased so it reads as a state). */
function deviceStatePhrase(detail: string): string {
  const d = detail.trim();
  if (/carplay/i.test(d)) return "driving";
  return d;
}

/** Compact health-steps phrasing: 6200 → "6.2k steps", 850 → "850 steps". */
function stepsPhrase(value: number): string {
  const n = Math.round(value);
  if (n >= 1000) {
    const k = n / 1000;
    // one decimal, but drop a trailing ".0" (10000 → "10k", 6200 → "6.2k").
    const label = k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
    return `${label} steps`;
  }
  return `${n} steps`;
}

/** Compact health-sleep phrasing: 6.5 → "slept 6.5h", 8 → "slept 8h". */
function sleepPhrase(value: number): string {
  const h = Math.round(value * 10) / 10;
  const label = h % 1 === 0 ? `${h}` : `${h}`;
  return `slept ${label}h`;
}

/** Build one short natural sentence from the device summary. Returns "" when
 *  there is no app activity AND no ambient signal at all. */
export function buildDeviceSummaryLine(input: BuildLineInput): string {
  const { topApps, windowMs, location, focus, device, steps, sleep, workout, nowPlaying } =
    input;
  const when = windowLabel(windowMs);

  // Lead sentence: app usage (existing behavior).
  let lead = "";
  if (topApps.length > 0) {
    const names = topApps.map((a) => a.app);
    let appsPhrase: string;
    if (names.length === 1) {
      appsPhrase = names[0];
    } else if (names.length === 2) {
      appsPhrase = `${names[0]}, ${names[1]}`;
    } else {
      appsPhrase = `${names.slice(0, -1).join(", ")} — ${names[names.length - 1]}`;
    }
    lead = `On iPhone (${when}): ${appsPhrase}`;
    // Note the dominant app if it clearly leads (more opens than #2).
    const top = topApps[0];
    const second = topApps[1];
    if (top && top.opens >= 2 && (!second || top.opens > second.opens)) {
      lead += `. Mostly ${top.app}`;
    }
  }

  // Trailing enricher clauses (latest-wins per category), in a stable order.
  const enrichers: string[] = [];

  if (location && (location.detail || location.app)) {
    enrichers.push(`at ${location.detail || location.app}`);
  }
  if (focus) {
    const mode = (focus.detail || focus.app || "").trim();
    // Skip "off" — a Focus turning off isn't worth surfacing.
    if (mode && !/^off$/i.test(mode)) enrichers.push(`${mode} focus`);
  }
  if (device) {
    const state = (device.detail || device.app || "").trim();
    if (state) enrichers.push(deviceStatePhrase(state));
  }
  if (steps && typeof steps.value === "number") {
    enrichers.push(stepsPhrase(steps.value));
  }
  if (sleep && typeof sleep.value === "number") {
    enrichers.push(sleepPhrase(sleep.value));
  }
  if (workout) {
    // metric:"workout" with a detail → use the detail ("ran 3mi"); else a
    // bare workout marker → generic "worked out".
    enrichers.push(workout.detail ? workout.detail : "worked out");
  }
  if (nowPlaying) {
    enrichers.push(
      nowPlaying.detail ? `playing ${nowPlaying.detail}` : `playing in ${nowPlaying.app}`,
    );
  }

  // Compose. If there's no app lead, anchor the enrichers with the window label
  // so an ambient-only summary still reads naturally.
  if (!lead && enrichers.length === 0) return "";
  if (!lead) {
    const body = enrichers.join(", ");
    return `On iPhone (${when}): ${body}.`;
  }
  if (enrichers.length === 0) {
    return /[.!?]$/.test(lead) ? lead : `${lead}.`;
  }
  const head = lead.replace(/\.$/, "");
  return `${head} — ${enrichers.join(", ")}.`;
}

// ─── Owner-context block ─────────────────────────────────────────────────────
// The bridge injects this (and ONLY this) into the OWNER's self-chat assistant
// prompt — never a contact reply. Mirrors mac-usage's usageContextBlock framing.
// Returns "" when there's no signal so it adds zero prompt overhead.
export function deviceContextBlock(summary: DeviceSummary | string | null | undefined): string {
  const line = (typeof summary === "string" ? summary : summary?.summaryLine)?.trim();
  if (!line) return "";
  return [
    "## Owner iPhone activity (local device signals — owner-only, never share with a contact)",
    "Background signal about what the owner has been doing on his iPhone (apps opened, location, focus mode, device state, health, now-playing). Use it only to ground a reply the owner could plausibly be asking about (\"what have I been on\", \"am I doomscrolling\", \"where am I\", \"how many steps today\"). Do NOT volunteer it and NEVER reveal it to anyone but the owner.",
    line,
  ].join("\n");
}
