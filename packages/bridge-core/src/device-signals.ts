// iPhone APP-CONTEXT signal for the personal harness — "learn what the owner
// uses on his phone".
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
//      a contact must never learn what apps the owner uses on his phone.
//   3. SUMMARIES, NOT RAW LOGS, IN THE PROMPT. This module aggregates raw event
//      lines into per-app counts + one sentence. Only that sentence reaches the
//      LLM context.
//   4. FAILS CLOSED. The reader (device-signals-reader.ts) no-ops on any failure
//      (missing file, garbage lines) — the bridge never crashes and simply has
//      no iPhone signal that tick.
//
// This file is PURE (parse JSONL lines + summarize). All I/O — reading the
// JSONL file — lives in services/imessage-bridge/src/device-signals-reader.ts
// and is injected, so this logic is unit-testable with mock lines and no fs.

// ─── Signal shape ────────────────────────────────────────────────────────────
// One line of ~/.lantern/device-signals.jsonl, written by the dashboard
// /api/signals route from an iPhone Shortcuts automation POST.
export type SignalKind = "app_open" | "location" | "focus" | "now_playing" | "custom";

export interface DeviceSignal {
  /** App / place / focus-mode name (e.g. "Instagram", "Home", "Work"). */
  app: string;
  /** What kind of event this is. Defaults to "app_open". */
  kind: SignalKind;
  /** Optional free-text detail (e.g. focus mode name, track title). */
  detail?: string;
  /** Unix epoch ms when the event happened. */
  ts: number;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────
const VALID_KINDS: ReadonlySet<string> = new Set([
  "app_open",
  "location",
  "focus",
  "now_playing",
  "custom",
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
  const app = typeof o.app === "string" ? o.app.trim() : "";
  if (!app) return null;
  const rawKind = typeof o.kind === "string" ? o.kind : "app_open";
  const kind: SignalKind = (VALID_KINDS.has(rawKind) ? rawKind : "app_open") as SignalKind;
  const ts =
    typeof o.ts === "number" && Number.isFinite(o.ts) && o.ts > 0 ? o.ts : NaN;
  if (!Number.isFinite(ts)) return null;
  const detail = typeof o.detail === "string" && o.detail.trim() ? o.detail.trim() : undefined;
  return { app, kind, detail, ts };
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
 * most-recent, and folds in the latest focus / location / now_playing as a
 * trailing clause. Empty / all-stale input yields summaryLine "".
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
  const focus = latestOf("focus");
  const location = latestOf("location");
  const nowPlaying = latestOf("now_playing");

  const summaryLine = buildDeviceSummaryLine({
    topApps,
    windowMs,
    focus,
    location,
    nowPlaying,
  });

  return { topApps, recent, summaryLine };
}

interface BuildLineInput {
  topApps: AppCount[];
  windowMs: number;
  focus?: DeviceSignal;
  location?: DeviceSignal;
  nowPlaying?: DeviceSignal;
}

/** Build one short natural sentence from the device summary. Returns "" when
 *  there is no app activity AND no ambient signal (focus/location/now_playing). */
export function buildDeviceSummaryLine(input: BuildLineInput): string {
  const { topApps, windowMs, focus, location, nowPlaying } = input;
  const when = windowLabel(windowMs);

  const clauses: string[] = [];

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
    let lead = `On iPhone (${when}): ${appsPhrase}`;
    // Note the dominant app if it clearly leads (more opens than #2).
    const top = topApps[0];
    const second = topApps[1];
    if (top && top.opens >= 2 && (!second || top.opens > second.opens)) {
      lead += `. Mostly ${top.app}`;
    }
    clauses.push(lead);
  }

  // Ambient enrichers.
  if (location) {
    clauses.push(location.detail ? `at ${location.detail}` : `at ${location.app}`);
  }
  if (focus) {
    clauses.push(`${focus.detail || focus.app} focus on`);
  }
  if (nowPlaying) {
    clauses.push(nowPlaying.detail ? `playing ${nowPlaying.detail}` : `playing in ${nowPlaying.app}`);
  }

  if (clauses.length === 0) return "";
  // First clause is the full lead sentence; the rest are short trailing notes.
  const [first, ...rest] = clauses;
  if (rest.length === 0) return /[.!?]$/.test(first) ? first : `${first}.`;
  const head = first.replace(/\.$/, "");
  return `${head} — ${rest.join("; ")}.`;
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
    "Background signal about what the owner has been doing on his iPhone (apps opened, focus mode, location, now-playing). Use it only to ground a reply the owner could plausibly be asking about (\"what have I been on\", \"am I doomscrolling\", \"where am I\"). Do NOT volunteer it and NEVER reveal it to anyone but the owner.",
    line,
  ].join("\n");
}
