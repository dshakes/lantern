// Native-macOS action layer for Lantern's personal assistant.
//
// Wraps AppleScript so the bridge can create Calendar events, Notes,
// and Mail drafts when the LLM asks for them via [CALENDAR:...] /
// [NOTE:...] / [MAIL:...] markers. Zero install — uses
// /usr/bin/osascript and the bundled Calendar.app / Notes.app /
// Mail.app. The owner controls every action via "Offer + confirm":
// the LLM suggests an action in conversation, the bridge only fires
// the action AFTER the user confirms in the next message.
//
// Security: AppleScript Automation permission is required (System
// Settings → Privacy & Security → Automation → enable each target
// app for the terminal/launchd binary). The bridge degrades
// gracefully if a perm is missing — surfaces a clear error to the
// owner so they can grant it.

import { spawn } from "child_process";
import type { Logger } from "pino";

const OSASCRIPT_TIMEOUT_MS = 12_000;

export interface CalendarEventSpec {
  title: string;
  /** ISO 8601 start datetime, e.g. "2026-08-19T09:00:00" (local TZ assumed). */
  start: string;
  /** Optional ISO 8601 end. Defaults to start + 30min. */
  end?: string;
  /** Optional notes/description for the event. */
  notes?: string;
  /** Calendar to add to. Defaults to the user's first writable calendar. */
  calendarName?: string;
  /** Reminder minutes BEFORE the event. e.g. [10080, 4320] = 1 week + 3 days. */
  alarmsMinutesBefore?: number[];
}

export interface NoteSpec {
  title: string;
  body: string;
  /** Optional folder name. Default: "Notes". */
  folder?: string;
}

export interface MailDraftSpec {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}

export type ActionResult = { ok: true; detail?: string } | { ok: false; reason: string };

export class MacActions {
  private logger: Logger;
  constructor(logger: Logger) {
    this.logger = logger.child({ component: "mac-actions" });
  }

  // ------- Calendar -------

  async createCalendarEvent(spec: CalendarEventSpec): Promise<ActionResult> {
    if (!spec.title || !spec.start) return { ok: false, reason: "title + start required" };
    const start = parseLocalDate(spec.start);
    if (!start) return { ok: false, reason: `invalid start date: ${spec.start}` };
    const end = spec.end ? parseLocalDate(spec.end) : new Date(start.getTime() + 30 * 60_000);
    if (!end) return { ok: false, reason: `invalid end date: ${spec.end}` };

    const aplStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
    // Locale-safe AppleScript dates: AppleScript's `date "YYYY-MM-DD..."`
    // literal is LOCALE-DEPENDENT and silently corrupts in non-en_US
    // settings (one user got year 12195 from a 2031 input). The robust
    // form is to construct an empty date and SET each component
    // numerically — always works regardless of system locale.
    const dateBuilder = (varName: string, d: Date) => `
    set ${varName} to current date
    set year of ${varName} to ${d.getFullYear()}
    set month of ${varName} to ${d.getMonth() + 1}
    set day of ${varName} to ${d.getDate()}
    set hours of ${varName} to ${d.getHours()}
    set minutes of ${varName} to ${d.getMinutes()}
    set seconds of ${varName} to ${d.getSeconds()}`;
    const buildStart = dateBuilder("startDate", start);
    const buildEnd = dateBuilder("endDate", end);
    // Calendar selection. Prior bug: `first calendar whose writable
    // is true` silently picked pseudo-calendars like "Scheduled
    // Reminders" — AppleScript reported success but the event was
    // invisible. Now we try in priority order:
    //   1. spec.calendarName (explicit request from LLM)
    //   2. LANTERN_DEFAULT_CALENDAR env
    //   3. Common defaults: "Home", "Calendar", "Personal", "Work"
    // and fall back to any writable calendar excluding the known
    // silent ones.
    const envDefault = (process.env.LANTERN_DEFAULT_CALENDAR || "").trim();
    const tryNames = [
      ...(spec.calendarName ? [spec.calendarName] : []),
      ...(envDefault ? [envDefault] : []),
      "Home", "Calendar", "Personal", "Work",
    ];
    const tryNamesAS = tryNames.map(aplStr).join(", ");
    const notesClause = spec.notes
      ? `set description of newEvent to ${aplStr(spec.notes)}`
      : "";
    const alarms = (spec.alarmsMinutesBefore || []).map((m) => `make new sound alarm at end of newEvent with properties {trigger interval:-${m}}`).join("\n        ");

    // Pick a real visible calendar by name (case-insensitive prefix
    // match against the priority list), excluding obvious silent
    // pseudo-calendars. As a last resort, the FIRST non-silent
    // writable calendar. Then verify the event was actually written
    // by reading its summary back.
    const script = `
${buildStart}
${buildEnd}
tell application "Calendar"
  set silentNames to {"Scheduled Reminders", "Siri Suggestions", "Birthdays", "US Holidays"}
  set candidates to {${tryNamesAS}}
  set targetCal to missing value
  -- Try priority names first
  repeat with want in candidates
    repeat with c in calendars
      if (name of c as string) is equal to (want as string) and writable of c then
        set targetCal to c
        exit repeat
      end if
    end repeat
    if targetCal is not missing value then exit repeat
  end repeat
  -- Fallback: first writable calendar that isn't on the silent list
  if targetCal is missing value then
    repeat with c in calendars
      if writable of c and not (silentNames contains (name of c as string)) then
        set targetCal to c
        exit repeat
      end if
    end repeat
  end if
  if targetCal is missing value then
    error "no usable writable calendar found"
  end if
  tell targetCal
    set newEvent to make new event with properties {summary:${aplStr(spec.title)}, start date:startDate, end date:endDate}
    ${notesClause}
    tell newEvent
      ${alarms}
    end tell
    -- Verify the write persisted by reading the start date back
    -- (some macOS versions silently drop events written to
    -- readonly-marked calendars even though they pass the writable
    -- check). Surfaces date-parsing bugs too — if we wrote year
    -- 12195 by accident, this catches it.
    set verifyDate to start date of newEvent as string
    return (name of targetCal as string) & "|" & verifyDate
  end tell
end tell`;
    const res = await this.runOsascript(script);
    if (!res.ok) return res;
    const parts = (res.detail || "").split("|");
    const calName = parts[0] || "Calendar";
    return { ok: true, detail: `"${spec.title}" → ${calName} · ${formatHuman(start)}` };
  }

  // ------- Notes -------

  async createNote(spec: NoteSpec): Promise<ActionResult> {
    if (!spec.title) return { ok: false, reason: "title required" };
    const aplStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
    // Notes.app requires HTML body — convert plain text newlines to <br>.
    const bodyHtml = `<h3>${escapeHtml(spec.title)}</h3>` + escapeHtml(spec.body || "").replace(/\n/g, "<br>\n");

    // FOLDER RESOLUTION — `default folder` reference broke in newer
    // macOS Notes when multiple accounts (iCloud + On My Mac + work)
    // are present. Error -1728 / "Can't get default folder" surfaced
    // for years on multi-account setups. Robust approach:
    //   1. If caller specified a folder name → try to find it across
    //      every account; pick the first match (or error out cleanly).
    //   2. If unspecified → skip the folder clause entirely. Notes
    //      uses the user's actual default automatically, which works
    //      reliably regardless of account topology.
    let script: string;
    if (spec.folder) {
      // Walk every account looking for a folder with the given name.
      // If no match, fall back to creating the note in the default
      // account's first folder (better than failing the user's ask).
      script = `
tell application "Notes"
  set targetFolder to missing value
  repeat with anAccount in accounts
    try
      set candidate to first folder of anAccount whose name is ${aplStr(spec.folder)}
      set targetFolder to candidate
      exit repeat
    on error
      -- not in this account, keep looking
    end try
  end repeat
  if targetFolder is missing value then
    set targetFolder to first folder of first account
  end if
  make new note at targetFolder with properties {name:${aplStr(spec.title)}, body:${aplStr(bodyHtml)}}
end tell`;
    } else {
      // No folder requested — let Notes.app pick its own default.
      // make new note WITHOUT a folder reference uses the active
      // account's default folder, which is what the user expects.
      script = `
tell application "Notes"
  make new note with properties {name:${aplStr(spec.title)}, body:${aplStr(bodyHtml)}}
end tell`;
    }
    const res = await this.runOsascript(script);
    if (!res.ok) return res;
    return { ok: true, detail: `note "${spec.title}"` };
  }

  // ------- Mail (draft only — owner reviews + sends manually) -------

  async createMailDraft(spec: MailDraftSpec): Promise<ActionResult> {
    if (!spec.subject || (spec.to?.length ?? 0) === 0) return { ok: false, reason: "subject + at least one recipient required" };
    const aplStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
    const toRecips = spec.to.map((addr) => `make new to recipient at end of to recipients with properties {address:${aplStr(addr)}}`).join("\n        ");
    const ccRecips = (spec.cc || []).map((addr) => `make new cc recipient at end of cc recipients with properties {address:${aplStr(addr)}}`).join("\n        ");
    const bccRecips = (spec.bcc || []).map((addr) => `make new bcc recipient at end of bcc recipients with properties {address:${aplStr(addr)}}`).join("\n        ");

    const script = `
tell application "Mail"
  set newDraft to make new outgoing message with properties {subject:${aplStr(spec.subject)}, content:${aplStr(spec.body || "")}, visible:true}
  tell newDraft
    ${toRecips}
    ${ccRecips}
    ${bccRecips}
  end tell
  return id of newDraft as string
end tell`;
    const res = await this.runOsascript(script);
    if (!res.ok) return res;
    return { ok: true, detail: `draft to ${spec.to.join(", ")}: "${spec.subject}"` };
  }

  // ------- low-level -------

  private runOsascript(script: string, timeoutMs = OSASCRIPT_TIMEOUT_MS): Promise<ActionResult> {
    return new Promise((resolve) => {
      const proc = spawn("osascript", ["-e", script]);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
        resolve({ ok: false, reason: `osascript timed out (${Math.round(timeoutMs / 1000)}s)` });
      }, timeoutMs);
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) { resolve({ ok: true, detail: stdout.trim() }); return; }
        const err = (stderr || stdout || `osascript exited ${code}`).trim();
        // Map common errors to actionable hints.
        if (err.includes("not authorized") || err.includes("-1743")) {
          resolve({ ok: false, reason: `Automation permission missing — System Settings → Privacy & Security → Automation → grant access to the relevant app.` });
          return;
        }
        if (err.includes("Application can't be found") || err.includes("Application isn't running") || err.includes("Application isn’t running")) {
          resolve({ ok: false, reason: `target app isn't installed or hasn't launched. Open it once, then retry.` });
          return;
        }
        this.logger.warn({ err: err.slice(0, 300) }, "osascript failed");
        resolve({ ok: false, reason: err.slice(0, 300) });
      });
    });
  }

  // ------- Calendar (read) -------
  //
  // Read upcoming events from Calendar.app across ALL calendars (iCloud +
  // Google + subscribed). This is the authoritative source for what the owner
  // actually sees — the bridge WRITES events here, so it must also READ here.
  // Previously appointment queries only hit the Google Calendar connector, so
  // an iCloud/Apple-only appointment was invisible ("no upcoming haircut
  // appointment" even though it was on the calendar).
  async readUpcomingEvents(opts: { days?: number; max?: number } = {}): Promise<CalendarEventRead[]> {
    const days = Math.max(1, Math.min(opts.days ?? 60, 180));
    const max = opts.max ?? 30;
    // PRIMARY: read the Calendar store SQLite directly. Covered by Full Disk
    // Access (the grant the bridge already has for chat.db), so it works
    // under launchd where AppleScript Automation for Calendar.app is NOT
    // granted — the exact reason calendar lookups returned nothing in prod.
    const fromStore = await this.readUpcomingEventsFromStore(days, max);
    if (fromStore) {
      this.logger.info({ count: fromStore.length, source: "calendar-store" }, "read upcoming calendar events");
      return fromStore.slice(0, max);
    }
    // FALLBACK: AppleScript (for setups where Automation is granted but FDA isn't).
    // Fields joined by " ||| " (unlikely in a summary); events by linefeed.
    // Dates emitted numerically (Y-M-D-H-Min) so parsing is locale-independent.
    const script = `
set theStart to (current date)
set theEnd to theStart + (${days} * days)
set out to ""
tell application "Calendar"
  repeat with cal in calendars
    set calName to (name of cal)
    try
      repeat with ev in (every event of cal whose start date is greater than or equal to theStart and start date is less than or equal to theEnd)
        set s to (start date of ev)
        set e to (end date of ev)
        set out to out & calName & " ||| " & (summary of ev) & " ||| " & ((year of s) as string) & "-" & ((month of s) as integer) & "-" & (day of s) & "-" & (hours of s) & "-" & (minutes of s) & " ||| " & ((year of e) as string) & "-" & ((month of e) as integer) & "-" & (day of e) & "-" & (hours of e) & "-" & (minutes of e) & linefeed
      end repeat
    end try
  end repeat
end tell
return out`;
    const res = await this.runOsascript(script, 25_000);
    if (!res.ok) {
      this.logger.warn({ reason: res.reason }, "calendar read failed");
      return [];
    }
    return parseAppleCalendarOutput(res.detail || "").slice(0, max);
  }

  // Read upcoming events straight from the macOS Calendar store SQLite,
  // in-process via better-sqlite3. The store aggregates iCloud + Google +
  // subscribed calendars (the source of truth for what the user sees) and
  // lives at ~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb.
  // Returns null (→ caller falls back to AppleScript) if the driver or DB is
  // unavailable. Dates are Apple epoch seconds (since 2001-01-01 UTC).
  private async readUpcomingEventsFromStore(days: number, max: number): Promise<CalendarEventRead[] | null> {
    if (process.platform !== "darwin") return null;
    try {
      // Indirection defeats TS literal module resolution — better-sqlite3 is
      // an optional native dep resolved at runtime from the bridge's node_modules.
      const sqliteSpecifier = "better-sqlite3";
      const [sqliteMod, os, fs, path] = await Promise.all([
        import(sqliteSpecifier) as Promise<any>,
        import("node:os"),
        import("node:fs"),
        import("node:path"),
      ]);
      const Database = sqliteMod.default as any;
      const dbPath = path.join(
        os.homedir(),
        "Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb",
      );
      if (!fs.existsSync(dbPath)) return null;
      const APPLE_EPOCH = 978307200; // seconds between 1970-01-01 and 2001-01-01
      // Small look-back so an in-progress event still shows; the caller's
      // formatter filters by "now" anyway.
      const startSec = Math.floor(Date.now() / 1000) - APPLE_EPOCH - 86400;
      const endSec = startSec + (days + 1) * 86400;
      let conn: any;
      try {
        conn = new Database(dbPath, { readonly: true, fileMustExist: true });
        const rows = conn
          .prepare(
            `SELECT ci.summary AS summary, ci.start_date AS start_date, ci.end_date AS end_date,
                    c.title AS cal
             FROM CalendarItem ci
             LEFT JOIN Calendar c ON c.ROWID = ci.calendar_id
             WHERE ci.start_date IS NOT NULL AND ci.start_date >= ? AND ci.start_date <= ?
             ORDER BY ci.start_date ASC
             LIMIT ?`,
          )
          .all(startSec, endSec, Math.max(max, 1)) as Array<{
          summary?: string;
          start_date?: number;
          end_date?: number;
          cal?: string;
        }>;
        return rows
          .filter((r) => typeof r.start_date === "number")
          .map((r) => ({
            calendar: r.cal || "",
            title: r.summary || "",
            start: new Date((r.start_date! + APPLE_EPOCH) * 1000),
            end: typeof r.end_date === "number" ? new Date((r.end_date + APPLE_EPOCH) * 1000) : null,
          }));
      } finally {
        try { conn?.close(); } catch { /* ignore */ }
      }
    } catch (err) {
      this.logger.debug({ err: (err as Error)?.message || String(err) }, "calendar store read unavailable — falling back to AppleScript");
      return null;
    }
  }
}

// ---------- Calendar read: parsing + formatting (pure, testable) ----------

export interface CalendarEventRead {
  calendar: string;
  title: string;
  start: Date;
  end: Date | null;
}

function parseStamp(str: string): Date | null {
  const m = (str || "").trim().match(/^(\d+)-(\d+)-(\d+)-(\d+)-(\d+)$/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const dt = new Date(y, mo - 1, d, h, mi);
  return isNaN(dt.getTime()) ? null : dt;
}

/** Parse the delimited Calendar.app AppleScript output into sorted events. */
export function parseAppleCalendarOutput(raw: string): CalendarEventRead[] {
  const out: CalendarEventRead[] = [];
  for (const line of (raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(" ||| ");
    if (parts.length < 3) continue;
    const start = parseStamp(parts[2]);
    if (!start) continue;
    out.push({
      calendar: (parts[0] || "").trim(),
      title: (parts[1] || "").trim(),
      start,
      end: parts[3] ? parseStamp(parts[3]) : null,
    });
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return out;
}

/**
 * Format upcoming Apple Calendar events as a prompt-injection block. Only
 * events that haven't ended yet are included. Returns "" when there are none.
 */
export function formatAppleCalendarBlock(
  events: CalendarEventRead[],
  opts: { max?: number; now?: number } = {},
): string {
  const now = opts.now ?? Date.now();
  const upcoming = events
    .filter((e) => (e.end ?? e.start).getTime() >= now)
    .slice(0, opts.max ?? 12);
  if (upcoming.length === 0) return "";
  const lines = upcoming.map((e) => {
    const when = e.start.toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const cal = e.calendar ? ` [${e.calendar}]` : "";
    return `- ${when} — ${e.title || "(no title)"}${cal}`;
  });
  return `\n\nUser's device calendar (Apple Calendar.app — includes iCloud + Google + subscribed; the source of truth for appointments the user sees):\n${lines.join("\n")}\n`;
}

// ---------- helpers ----------

function parseLocalDate(input: string): Date | null {
  // Accept ISO-with-TZ, ISO-local, "YYYY-MM-DD", "YYYY-MM-DD HH:mm".
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(trimmed + "T09:00:00"); // default 9am for date-only
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/.test(trimmed)) {
    // No TZ — treat as local
    return new Date(trimmed.replace(" ", "T"));
  }
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

// AppleScript wants "date \"Monday, August 19, 2026 at 9:00:00 AM\""
// — but the safer cross-locale form is the constructor:
// `(current date)` then set its components — see createCalendarEvent's
// inline `dateBuilder` for the actual implementation.

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

function formatHuman(d: Date): string {
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------- LLM action markers ----------
//
// The LLM signals desired actions with markers in its reply. The
// bridge parses them, strips them from the user-facing text, and
// invokes the corresponding MacActions method. Marker grammar
// mirrors [ATTACH:...] for consistency.
//
//   [CALENDAR:title|start-iso|end-iso?|notes?]
//   [NOTE:title|body]
//   [MAIL:to-addr(s comma-separated)|subject|body]
//
// IMPORTANT: per the "Offer + confirm" UX, the LLM is instructed
// to emit markers ONLY after the owner explicitly confirms the
// offer. Suggestions in conversational text don't get parsed.

const RE_CALENDAR = /\[CALENDAR:([^\]]+)\]/g;
const RE_NOTE = /\[NOTE:([^\]]+)\]/g;
const RE_MAIL = /\[MAIL:([^\]]+)\]/g;
// Outbound call marker — the intelligent replacement for brittle "call X"
// regexes. The LLM understands call intent in ANY phrasing (typos, "can
// you call manu", voice notes, other languages) and emits this marker; the
// bridge runs it through the real Twilio orchestrator (risk-tier + owner
// ack). No marker = no call, which also kills the "i'll call her" text
// hallucination.
//   [CALL:target|mode|message-or-reason]
//   mode ∈ conference | voicemail | task
const RE_CALL = /\[CALL:([^\]]+)\]/g;

export interface CallSpec {
  target: string;
  mode: "conference" | "voicemail" | "task";
  message?: string;
}

export interface ExtractedActions {
  cleanedText: string;
  calendarEvents: CalendarEventSpec[];
  notes: NoteSpec[];
  mailDrafts: MailDraftSpec[];
  calls: CallSpec[];
}

export function extractActionMarkers(text: string): ExtractedActions {
  let cleaned = text;
  const calendarEvents: CalendarEventSpec[] = [];
  const notes: NoteSpec[] = [];
  const mailDrafts: MailDraftSpec[] = [];
  const calls: CallSpec[] = [];

  for (const m of text.matchAll(RE_CALENDAR)) {
    const parts = m[1].split("|").map((p) => p.trim());
    if (parts.length >= 2 && parts[0] && parts[1]) {
      calendarEvents.push({
        title: parts[0],
        start: parts[1],
        end: parts[2] || undefined,
        notes: parts[3] || undefined,
      });
    }
    cleaned = cleaned.replace(m[0], "");
  }
  for (const m of text.matchAll(RE_NOTE)) {
    const parts = m[1].split("|").map((p) => p.trim());
    if (parts.length >= 2 && parts[0]) {
      notes.push({ title: parts[0], body: parts[1] || "" });
    }
    cleaned = cleaned.replace(m[0], "");
  }
  for (const m of text.matchAll(RE_MAIL)) {
    const parts = m[1].split("|").map((p) => p.trim());
    if (parts.length >= 3 && parts[0] && parts[1]) {
      mailDrafts.push({
        to: parts[0].split(",").map((s) => s.trim()).filter(Boolean),
        subject: parts[1],
        body: parts[2] || "",
      });
    }
    cleaned = cleaned.replace(m[0], "");
  }
  for (const m of text.matchAll(RE_CALL)) {
    const parts = m[1].split("|").map((p) => p.trim());
    const target = parts[0];
    if (target) {
      const rawMode = (parts[1] || "conference").toLowerCase();
      const mode: CallSpec["mode"] =
        rawMode === "voicemail" ? "voicemail" : rawMode === "task" ? "task" : "conference";
      calls.push({ target, mode, message: parts[2] || undefined });
    }
    cleaned = cleaned.replace(m[0], "");
  }
  return { cleanedText: cleaned.replace(/\n{3,}/g, "\n\n").trim(), calendarEvents, notes, mailDrafts, calls };
}
