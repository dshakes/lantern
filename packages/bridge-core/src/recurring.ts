// Recurring reminders — "every evening remind him to take his meds", "water the
// plants daily at 9am". The spouse-agent (and owner) create these; ONE bridge
// (the primary self-chat channel) runs a per-minute tick that fires the due
// ones to the owner's self-chat. State is `<stateDir>/recurring-reminders.jsonl`
// (0600). Pure store + due logic here; the timer + send live in the bridge.
//
// Dedupe model (no precise next-fire math, robust across restarts): a reminder
// fires when the owner-local clock is within a couple minutes of its time AND it
// hasn't already fired for that local date — tracked by lastFiredDate.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Cadence = "daily" | "weekly";

export interface RecurringReminder {
  id: string;
  title: string;
  cadence: Cadence;
  /** Owner-local 24h time, "HH:MM". */
  timeHHMM: string;
  /** For weekly: 0=Sun … 6=Sat. Empty/undefined for daily. */
  days?: number[];
  createdBy: string; // "Manasa" | "owner" | a name
  createdMs: number;
  /** Owner-local YYYY-MM-DD it last fired — the dedupe key. */
  lastFiredDate?: string;
}

const FILE = "recurring-reminders.jsonl";

/** Owner-local clock parts for a given instant + IANA timezone. */
export interface LocalClock {
  hh: number;
  mm: number;
  dayOfWeek: number; // 0=Sun
  dateStr: string; // YYYY-MM-DD
}

export function ownerLocalClock(nowMs: number, timeZone?: string): LocalClock {
  const d = new Date(nowMs);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hh = parseInt(parts.hour ?? "0", 10);
  if (hh === 24) hh = 0; // some locales render midnight as 24
  return {
    hh,
    mm: parseInt(parts.minute ?? "0", 10),
    dayOfWeek: WD[parts.weekday ?? "Sun"] ?? 0,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Whether a reminder should fire right now (within ±windowMin of its time,
 *  not already fired today, and — for weekly — on one of its days). */
export function isDue(r: RecurringReminder, now: LocalClock, windowMin = 2): boolean {
  if (r.lastFiredDate === now.dateStr) return false;
  const [h, m] = r.timeHHMM.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return false;
  if (now.hh !== h) return false;
  if (Math.abs(now.mm - m) > windowMin) return false;
  if (r.cadence === "weekly" && r.days && r.days.length > 0 && !r.days.includes(now.dayOfWeek)) return false;
  return true;
}

export function loadReminders(stateDir: string): RecurringReminder[] {
  try {
    const p = join(stateDir, FILE);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as RecurringReminder;
        } catch {
          return null;
        }
      })
      .filter((r): r is RecurringReminder => !!r && !!r.id && !!r.title && !!r.timeHHMM);
  } catch {
    return [];
  }
}

export function addReminder(stateDir: string, r: RecurringReminder): void {
  try {
    appendFileSync(join(stateDir, FILE), JSON.stringify(r) + "\n", { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/** Rewrite the store (used to stamp lastFiredDate after firing, or to remove). */
export function persistReminders(stateDir: string, all: RecurringReminder[]): void {
  try {
    writeFileSync(join(stateDir, FILE), all.map((r) => JSON.stringify(r)).join("\n") + (all.length ? "\n" : ""), {
      mode: 0o600,
    });
  } catch {
    /* best-effort */
  }
}

export function removeReminder(stateDir: string, id: string): RecurringReminder[] {
  const kept = loadReminders(stateDir).filter((r) => r.id !== id);
  persistReminders(stateDir, kept);
  return kept;
}

/** Human summary of a reminder's schedule ("daily at 6:00pm", "Mon/Wed at 9:00am"). */
export function describeCadence(r: RecurringReminder): string {
  const [h, m] = r.timeHHMM.split(":").map((x) => parseInt(x, 10));
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = ((h + 11) % 12) + 1;
  const time = `${h12}:${String(m).padStart(2, "0")}${ampm}`;
  if (r.cadence === "daily" || !r.days || r.days.length === 0) return `daily at ${time}`;
  const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${r.days.map((d) => NAMES[d]).join("/")} at ${time}`;
}
