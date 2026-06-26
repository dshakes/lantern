// MAC APP-USAGE signal for the personal harness — "learn what the owner uses".
//
// Distills the owner's local macOS app-usage into ONE short, human "what
// you've been doing today" line that feeds the OWNER's own assistant context
// (proactive awareness + better-grounded self-chat replies). iPhone usage is
// deferred — this is the Mac slice only.
//
// ─── PRIVACY POSTURE (HARD RULES, not defaults) ──────────────────────────────
//   1. OFF by default. The bridge only wires this in when LANTERN_MAC_USAGE=on.
//      When off, nothing reads knowledgeC.db and nothing is stored.
//   2. OWNER-ONLY. The summary is injected ONLY into the owner's self-chat
//      assistant context (and/or the owner's daily digest). It is NEVER added
//      to a reply that goes to a contact — a contact must never learn what apps
//      the owner uses.
//   3. SUMMARIES, NOT RAW LOGS. This module aggregates rows into per-app
//      totals + one sentence. The bridge persists only a small rolling cache
//      (~/.lantern/mac-usage.json, mode 0600) — never a raw per-event log.
//   4. FAILS CLOSED. The reader (mac-usage-reader.ts) no-ops on any failure
//      (no Full Disk Access, missing DB, schema drift) — the bridge never
//      crashes and simply has no usage signal that tick.
//
// This file is PURE (parsing + aggregation + summarization). All I/O — opening
// knowledgeC.db — lives in services/imessage-bridge/src/mac-usage-reader.ts and
// is injected, so this logic is unit-testable with mock rows and no real DB.

// ─── Mac-absolute-time ───────────────────────────────────────────────────────
// knowledgeC.db (like all CoreData / CFAbsoluteTime stores) measures time in
// SECONDS since the Mac/Cocoa epoch: 2001-01-01 00:00:00 UTC. Unix time counts
// from 1970-01-01. The offset between the two epochs is exactly 978307200s.
export const MAC_EPOCH_OFFSET_SEC = 978_307_200;

/** Convert a Mac-absolute-time (seconds since 2001-01-01) to Unix epoch ms. */
export function macAbsoluteToUnixMs(macSeconds: number): number {
  return Math.round((macSeconds + MAC_EPOCH_OFFSET_SEC) * 1000);
}

/** Convert a Unix epoch ms back to Mac-absolute-time seconds (for building the
 *  knowledgeC query's ZSTARTDATE >= ? lower bound). */
export function unixMsToMacAbsolute(unixMs: number): number {
  return unixMs / 1000 - MAC_EPOCH_OFFSET_SEC;
}

// ─── Row shape ───────────────────────────────────────────────────────────────
// One ZOBJECT row from knowledgeC.db where ZSTREAMNAME = '/app/usage' (or
// '/app/inFocus'). The reader maps the raw sqlite columns into this shape; the
// times are RAW Mac-absolute-time seconds (ZSTARTDATE / ZENDDATE) so the
// conversion + duration math lives here and is tested.
export interface UsageRow {
  /** ZVALUESTRING — the app's bundle id (e.g. "com.apple.Safari"). */
  bundleId: string;
  /** ZSTARTDATE — Mac-absolute-time seconds. */
  startMac: number;
  /** ZENDDATE — Mac-absolute-time seconds. */
  endMac: number;
}

// ─── Bundle-id → friendly name ───────────────────────────────────────────────
// A reasonable starter map for the apps a developer/owner uses most. Unknown
// bundle ids fall back to the last dotted path segment (see friendlyAppName).
const BUNDLE_FRIENDLY: Record<string, string> = {
  "com.apple.Safari": "Safari",
  "com.apple.SafariTechnologyPreview": "Safari",
  "com.google.Chrome": "Chrome",
  "com.google.Chrome.canary": "Chrome",
  "company.thebrowser.Browser": "Arc",
  "org.mozilla.firefox": "Firefox",
  "com.microsoft.VSCode": "VS Code",
  "com.microsoft.VSCodeInsiders": "VS Code",
  "com.apple.dt.Xcode": "Xcode",
  "com.todesktop.230313mzl4w4u92": "Cursor",
  "dev.zed.Zed": "Zed",
  "com.googlecode.iterm2": "iTerm",
  "com.apple.Terminal": "Terminal",
  "com.tinyspeck.slackmacgap": "Slack",
  "com.hnc.Discord": "Discord",
  "com.microsoft.teams2": "Teams",
  "com.microsoft.teams": "Teams",
  "us.zoom.xos": "Zoom",
  "com.apple.MobileSMS": "Messages",
  "net.whatsapp.WhatsApp": "WhatsApp",
  "org.telegram.desktop": "Telegram",
  "com.apple.mail": "Mail",
  "com.readdle.smartemail-Mac": "Spark",
  "com.apple.iCal": "Calendar",
  "com.apple.Notes": "Notes",
  "notion.id": "Notion",
  "com.electron.realm": "Notion",
  "md.obsidian": "Obsidian",
  "com.linear": "Linear",
  "com.figma.Desktop": "Figma",
  "com.spotify.client": "Spotify",
  "com.apple.Music": "Music",
  "com.apple.Preview": "Preview",
  "com.apple.finder": "Finder",
  "com.apple.systempreferences": "System Settings",
  "com.openai.chat": "ChatGPT",
  "com.anthropic.claudefordesktop": "Claude",
  "com.postmanlabs.mac": "Postman",
  "com.docker.docker": "Docker",
  "com.tdesktop.Telegram": "Telegram",
};

/** Map a bundle id to a friendly app name. Unknown ids fall back to the last
 *  dotted segment, title-cased lightly (e.g. "com.acme.FooBar" -> "FooBar"). */
export function friendlyAppName(bundleId: string): string {
  const known = BUNDLE_FRIENDLY[bundleId];
  if (known) return known;
  const id = (bundleId || "").trim();
  if (!id) return "Unknown";
  const seg = id.includes(".") ? id.slice(id.lastIndexOf(".") + 1) : id;
  return seg || id;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────
export interface AppAggregate {
  bundleId: string;
  app: string; // friendly name
  minutes: number; // total foreground minutes (rounded)
  sessions: number; // distinct usage rows
  lastUsedMs: number; // Unix ms of the most recent ZENDDATE
}

export interface UsageSummary {
  /** Apps sorted by minutes desc, capped to opts.topN. */
  topApps: Array<{ app: string; minutes: number }>;
  /** Distinct local hours (0-23) in which ANY usage occurred. */
  activeHours: number[];
  /** Sum of all per-app minutes (rounded). */
  totalMinutes: number;
  /** One short natural sentence, or "" when there's nothing worth saying. */
  summaryLine: string;
  /** Full per-app rollup (for the rolling cache / diagnostics). */
  apps: AppAggregate[];
}

export interface SummarizeOpts {
  /** How many apps to surface in topApps + the sentence. Default 4. */
  topN?: number;
  /** Drop apps with fewer than this many minutes from the sentence (noise
   *  filter — a 4-second focus blip isn't "what you've been doing"). Default 1. */
  minMinutes?: number;
  /** IANA-ish offset hook: a fn mapping Unix ms -> local hour 0-23. Defaults to
   *  the host's local time via Date#getHours. Injected for deterministic tests. */
  localHourOf?: (unixMs: number) => number;
  /** "now" for last-used phrasing, Unix ms. Defaults to Date.now(). */
  nowMs?: number;
}

/** Aggregate raw usage rows into per-app totals. Ignores malformed rows
 *  (missing bundle id, end <= start) rather than throwing. */
export function aggregateUsage(rows: UsageRow[]): AppAggregate[] {
  const byBundle = new Map<string, AppAggregate>();
  for (const r of rows || []) {
    if (!r || typeof r.bundleId !== "string" || !r.bundleId.trim()) continue;
    const durSec = r.endMac - r.startMac;
    if (!Number.isFinite(durSec) || durSec <= 0) continue;
    const lastMs = macAbsoluteToUnixMs(r.endMac);
    const existing = byBundle.get(r.bundleId);
    if (existing) {
      existing.minutes += durSec / 60;
      existing.sessions += 1;
      if (lastMs > existing.lastUsedMs) existing.lastUsedMs = lastMs;
    } else {
      byBundle.set(r.bundleId, {
        bundleId: r.bundleId,
        app: friendlyAppName(r.bundleId),
        minutes: durSec / 60,
        sessions: 1,
        lastUsedMs: lastMs,
      });
    }
  }
  const out = Array.from(byBundle.values());
  for (const a of out) a.minutes = Math.round(a.minutes);
  // Sort by raw minutes desc, then by recency as a tiebreak.
  out.sort((a, b) => b.minutes - a.minutes || b.lastUsedMs - a.lastUsedMs);
  return out;
}

/** Distinct local hours (0-23) any usage row touched, sorted ascending. */
export function activeHoursOf(rows: UsageRow[], localHourOf: (unixMs: number) => number): number[] {
  const hours = new Set<number>();
  for (const r of rows || []) {
    if (!r || typeof r.bundleId !== "string" || !r.bundleId.trim()) continue;
    if (!Number.isFinite(r.endMac - r.startMac) || r.endMac <= r.startMac) continue;
    const h = localHourOf(macAbsoluteToUnixMs(r.startMac));
    if (Number.isInteger(h) && h >= 0 && h <= 23) hours.add(h);
  }
  return Array.from(hours).sort((a, b) => a - b);
}

// Coarse part-of-day label from the spread of active hours, used to anchor the
// sentence ("this morning", "this afternoon", "today").
function partOfDay(activeHours: number[]): string {
  if (activeHours.length === 0) return "today";
  const min = activeHours[0];
  const max = activeHours[activeHours.length - 1];
  // Spans more than one part of the day → just "today".
  const morning = min < 12;
  const afternoonOrLater = max >= 12;
  if (morning && afternoonOrLater) return "today";
  if (morning) return "this morning";
  if (max < 18) return "this afternoon";
  return "this evening";
}

/** Build one short natural sentence from the per-app aggregate. Empty input (or
 *  all-noise) yields "". The phrasing leads with the dominant app(s) and notes a
 *  lighter secondary app ("...; some Slack."). */
export function buildSummaryLine(apps: AppAggregate[], activeHours: number[], minMinutes: number): string {
  const meaningful = apps.filter((a) => a.minutes >= Math.max(1, minMinutes));
  if (meaningful.length === 0) return "";

  const when = partOfDay(activeHours);
  const names = meaningful.map((a) => a.app);

  // Lead set = the heaviest one or two apps; tail = a notable lighter one.
  if (names.length === 1) {
    return `Heads-down in ${names[0]} ${when}.`;
  }

  const lead = names.slice(0, 2);
  const leadPhrase = lead.length === 2 ? `${lead[0]} + ${lead[1]}` : lead[0];
  // A third app, if meaningfully present, becomes the "some X" tail.
  const tail = names[2];
  const base = `Heads-down in ${leadPhrase} ${when}`;
  return tail ? `${base}; some ${tail}.` : `${base}.`;
}

/** Top-level summarizer: rows -> { topApps, activeHours, totalMinutes,
 *  summaryLine, apps }. Pure; deterministic given localHourOf/nowMs. */
export function summarizeUsage(rows: UsageRow[], opts: SummarizeOpts = {}): UsageSummary {
  const topN = opts.topN ?? 4;
  const minMinutes = opts.minMinutes ?? 1;
  const localHourOf = opts.localHourOf ?? ((ms: number) => new Date(ms).getHours());

  const apps = aggregateUsage(rows);
  const activeHours = activeHoursOf(rows, localHourOf);
  const totalMinutes = apps.reduce((sum, a) => sum + a.minutes, 0);
  const topApps = apps.slice(0, topN).map((a) => ({ app: a.app, minutes: a.minutes }));
  const summaryLine = buildSummaryLine(apps, activeHours, minMinutes);

  return { topApps, activeHours, totalMinutes, summaryLine, apps };
}

// ─── Owner-context block ─────────────────────────────────────────────────────
// The bridge injects this (and ONLY this) into the OWNER's self-chat assistant
// prompt — never a contact reply. Mirrors ScreenContext.recentContext()'s
// "background context, don't volunteer it" framing. Returns "" when there's no
// signal so it adds zero prompt overhead.
export function usageContextBlock(summary: UsageSummary | string | null | undefined): string {
  const line = (typeof summary === "string" ? summary : summary?.summaryLine)?.trim();
  if (!line) return "";
  return [
    "## Owner activity (local Mac app-usage — owner-only, never share with a contact)",
    "Background signal about what the owner has been doing on his Mac today. Use it only to ground a reply the owner could plausibly be asking about (\"what was I working on\", \"have I been heads-down\"). Do NOT volunteer it and NEVER reveal it to anyone but the owner.",
    line,
  ].join("\n");
}
