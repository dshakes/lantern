// proactive-loops.ts — OWNER-ONLY proactive intelligence loops.
//
// Two pure decision functions consumed by the WA + iMessage bridge ticks:
//   • computeCommuteSurface — surfaces due commitments hands-free once per drive
//   • computeEnergyNudge   — nudges on short sleep, once per calendar day
//
// Ships dark: LANTERN_COMMUTE=on / LANTERN_ENERGY=on gate the timers in session.ts.
// OWNER-ONLY: callers route output to self-chat only, never to a contact.
//
// ─── Privacy posture ───────────────────────────────────────────────────────────
//   1. Output goes only to the owner's self-chat (caller responsibility).
//   2. Sleep value and commitment titles are never logged.
//   3. Fails closed: callers wrap ticks in try/catch and log at debug.

import {
  presenceFromSignals,
  type DeviceSignal,
  type SignalPresence,
  type SignalPresenceState,
} from "./device-signals.js";
import type { Commitment } from "./commitments-edge.js";

// ── computeCommuteSurface ─────────────────────────────────────────────────────

export interface CommuteSurfaceOpts {
  /** True when we already sent the driving nudge for this drive session. */
  alreadyFiredThisDrive: boolean;
  /** True when the previous tick's presence was "driving" (park-recap trigger). */
  lastWasDriving: boolean;
}

export interface CommuteSurface {
  text: string;
  /**
   * "drive" = initial driving nudge (fire-once per drive).
   * "park"  = parked recap emitted once on the driving→parked transition.
   */
  kind: "drive" | "park";
}

/**
 * Surface due commitments hands-free when the owner is driving.
 *
 * Fires the "drive" variant ONCE per drive session (alreadyFiredThisDrive guard).
 * Fires the "park" recap ONCE on the transition from driving → not-driving.
 * Returns null when there's nothing to surface.
 *
 * Pure: accepts already-derived presence (caller calls presenceFromSignals or
 * readDevicePresence) to avoid double-scanning the signals file.
 */
export function computeCommuteSurface(
  presence: SignalPresence | null,
  dueCommitments: Commitment[],
  opts: CommuteSurfaceOpts,
): CommuteSurface | null {
  const isDriving = presence?.state === "driving";

  if (isDriving) {
    // Fire once per drive, and only when there are commitments to surface.
    if (opts.alreadyFiredThisDrive || dueCommitments.length === 0) return null;
    const count = dueCommitments.length;
    const items = dueCommitments.slice(0, 3).map((c) => c.title).join(" · ");
    const tail = count > 3 ? ` (+${count - 3} more)` : "";
    const text =
      count === 1
        ? `🚗 driving — when you stop: ${items}`
        : `🚗 driving — ${count} things when you stop: ${items}${tail}`;
    return { text, kind: "drive" };
  }

  // Park recap: fires exactly once on the driving→not-driving transition.
  if (opts.lastWasDriving) {
    if (dueCommitments.length === 0) {
      return { text: "🅿️ parked — all clear.", kind: "park" };
    }
    const count = dueCommitments.length;
    const items = dueCommitments.slice(0, 3).map((c) => c.title).join(" · ");
    const tail = count > 3 ? ` (+${count - 3} more)` : "";
    const text =
      count === 1
        ? `🅿️ parked — still on your list: ${items}`
        : `🅿️ parked — ${count} things on your list: ${items}${tail}`;
    return { text, kind: "park" };
  }

  return null;
}

// ── computeEnergyNudge ────────────────────────────────────────────────────────

export const ENERGY_SLEEP_FLOOR_DEFAULT = 6; // hours
const ENERGY_SIGNAL_WINDOW_MS = 8 * 60 * 60_000; // 8h — sleep arrives overnight

export interface EnergyNudgeOpts {
  /** True when we already sent the nudge today — skip. Caller persists this. */
  alreadyNudgedToday: boolean;
  /** Sleep hours below this → nudge. Default 6. */
  sleepFloorHours?: number;
  /** "now" anchor in ms. Defaults to Date.now(). */
  nowMs?: number;
  /** Signal lookback window in ms. Defaults to 8h. */
  windowMs?: number;
}

/**
 * Nudge the owner once per day when last-night's sleep was below the floor.
 *
 * Pure: alreadyNudgedToday is caller-tracked (persisted across restarts).
 * Scans raw signals for the most-recent health/sleep metric in the window.
 */
export function computeEnergyNudge(
  signals: DeviceSignal[],
  opts: EnergyNudgeOpts,
): { text: string } | null {
  if (opts.alreadyNudgedToday) return null;

  const floor = opts.sleepFloorHours ?? ENERGY_SLEEP_FLOOR_DEFAULT;
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? ENERGY_SIGNAL_WINDOW_MS;
  const cutoff = nowMs - windowMs;

  // Most-recent sleep health signal in the window.
  const sleepSig = [...signals]
    .filter(
      (s) =>
        s.kind === "health" &&
        s.metric === "sleep" &&
        Number.isFinite(s.ts) &&
        s.ts >= cutoff &&
        s.ts <= nowMs,
    )
    .sort((a, b) => b.ts - a.ts)[0];

  if (!sleepSig || typeof sleepSig.value !== "number") return null;
  if (sleepSig.value >= floor) return null;

  // Round to 1 decimal; drop trailing zero (6.0 → "6h", 5.2 → "5.2h").
  const raw = Math.round(sleepSig.value * 10) / 10;
  const label = raw % 1 === 0 ? `${raw}h` : `${raw}h`;
  return {
    text: `😴 ~${label} last night — want me to lighten your afternoon or protect a focus block? reply yes`,
  };
}

// ── computeHealthCoachNudge ───────────────────────────────────────────────────

const HEALTH_SIGNAL_WINDOW_MS = 24 * 60 * 60_000; // 24h — "today"

export interface HealthCoachOpts {
  /** True when we already sent the health nudge today — skip. Caller persists. */
  alreadyNudgedToday: boolean;
  /** Current local hour 0–23. Nudge only fires 12–20h (midday→evening). */
  hour: number;
  /** Daily step goal. Default 8000. */
  stepGoal?: number;
  /** "now" anchor in ms. Defaults to Date.now(). */
  nowMs?: number;
  /** Lookback window for "today" in ms. Defaults to 24h. */
  windowMs?: number;
}

/**
 * Nudge the owner once per day when today's steps are below their goal.
 * On a workout signal, emits a brief ack instead (takes priority).
 * Returns null outside the midday→evening window or when already nudged.
 *
 * Pure: alreadyNudgedToday is caller-tracked (persisted across restarts).
 */
export function computeHealthCoachNudge(
  signals: DeviceSignal[],
  opts: HealthCoachOpts,
): { text: string } | null {
  if (opts.alreadyNudgedToday) return null;
  if (opts.hour < 12 || opts.hour >= 20) return null;

  const stepGoal = opts.stepGoal ?? 8000;
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? HEALTH_SIGNAL_WINDOW_MS;
  const cutoff = nowMs - windowMs;

  const inWindow = (signals || []).filter(
    (s) => s && Number.isFinite(s.ts) && s.ts >= cutoff && s.ts <= nowMs,
  );

  // Workout today → brief ack (takes priority over step nudge).
  const workout = [...inWindow]
    .filter(
      (s) =>
        s.kind === "health" &&
        (s.metric === "workout" || (!s.metric && !!s.detail)),
    )
    .sort((a, b) => b.ts - a.ts)[0];
  if (workout) {
    const detail = workout.detail ? ` (${workout.detail})` : "";
    return { text: `💪 nice${detail} — workout logged` };
  }

  // Most-recent step count today.
  const stepSig = [...inWindow]
    .filter(
      (s) =>
        s.kind === "health" &&
        s.metric === "steps" &&
        typeof s.value === "number",
    )
    .sort((a, b) => b.ts - a.ts)[0];
  if (!stepSig || typeof stepSig.value !== "number") return null;
  if (stepSig.value >= stepGoal) return null;

  const steps = stepSig.value;
  const remaining = stepGoal - steps;
  const fmtK = (n: number): string =>
    n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : `${n}`;
  const goalStr =
    stepGoal >= 1000 ? `${Math.floor(stepGoal / 1000)}k` : `${stepGoal}`;
  return {
    text: `🏃 ${fmtK(steps)} steps — ${fmtK(remaining)} to your ${goalStr} goal, quick walk before dinner?`,
  };
}

// ── computeWeeklyHealthSummary ────────────────────────────────────────────────

const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface WeeklyHealthOpts {
  /** "now" anchor in ms. Defaults to Date.now(). */
  nowMs?: number;
  /**
   * Minimum number of days with any step/sleep signal to produce a summary.
   * Default 3 — avoids a summary built from one or two lonely data points.
   */
  minDataDays?: number;
}

/**
 * A once-weekly trend line: avg steps, sleep, and workout count for the last
 * 7 days. Returns null when there's not enough data.
 *
 * Pure: caller decides WHEN to call this (e.g. on Mondays + weekly dedup key).
 */
export function computeWeeklyHealthSummary(
  signals: DeviceSignal[],
  opts: WeeklyHealthOpts = {},
): { text: string } | null {
  const nowMs = opts.nowMs ?? Date.now();
  const minDataDays = opts.minDataDays ?? 3;
  const cutoff = nowMs - WEEKLY_WINDOW_MS;

  const inWindow = (signals || []).filter(
    (s) => s && Number.isFinite(s.ts) && s.ts >= cutoff && s.ts <= nowMs,
  );

  const dayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

  // Latest step value per calendar day.
  const stepsByDayTs = new Map<string, number>(); // dayKey → ts
  const stepsByDay = new Map<string, number>(); // dayKey → value
  for (const s of inWindow) {
    if (s.kind !== "health" || s.metric !== "steps" || typeof s.value !== "number") continue;
    const k = dayKey(s.ts);
    if (s.ts >= (stepsByDayTs.get(k) ?? 0)) {
      stepsByDayTs.set(k, s.ts);
      stepsByDay.set(k, s.value);
    }
  }

  // Latest sleep value per calendar day.
  const sleepByDayTs = new Map<string, number>();
  const sleepByDay = new Map<string, number>();
  for (const s of inWindow) {
    if (s.kind !== "health" || s.metric !== "sleep" || typeof s.value !== "number") continue;
    const k = dayKey(s.ts);
    if (s.ts >= (sleepByDayTs.get(k) ?? 0)) {
      sleepByDayTs.set(k, s.ts);
      sleepByDay.set(k, s.value);
    }
  }

  // Workout signals this week.
  const workoutCount = inWindow.filter(
    (s) => s.kind === "health" && (s.metric === "workout" || (!s.metric && !!s.detail)),
  ).length;

  const uniqueDays = new Set([...stepsByDay.keys(), ...sleepByDay.keys()]).size;
  if (uniqueDays < minDataDays && workoutCount === 0) return null;

  const parts: string[] = [];

  if (stepsByDay.size >= 2) {
    const avg = Math.round(
      [...stepsByDay.values()].reduce((a, b) => a + b, 0) / stepsByDay.size,
    );
    const fmtK = (n: number): string =>
      n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : `${n}`;
    parts.push(`avg ${fmtK(avg)} steps/day`);
  }
  if (sleepByDay.size >= 2) {
    const avg =
      Math.round(
        ([...sleepByDay.values()].reduce((a, b) => a + b, 0) / sleepByDay.size) * 10,
      ) / 10;
    const label = avg % 1 === 0 ? `${avg}h` : `${avg}h`;
    parts.push(`${label} sleep avg`);
  }
  if (workoutCount > 0) {
    parts.push(`${workoutCount} workout${workoutCount > 1 ? "s" : ""}`);
  }

  if (parts.length === 0) return null;
  return { text: `🧘 this week: ${parts.join(", ")}` };
}

// ── computeFocusGuardian ──────────────────────────────────────────────────────

// Focus states: owner is heads-down — hold non-urgent nudges.
const FOCUS_STATES: ReadonlySet<string> = new Set<SignalPresenceState>(["dnd", "busy"]);

export interface FocusGuardianOpts {
  /** True when the PREVIOUS tick's presence was a focus state. */
  wasFocused: boolean;
  /** How long focus has been active, in ms (for the release summary line). */
  durationMs?: number;
}

/**
 * Focus guardian for the owner's deep-work blocks.
 *
 * Returns:
 *   - {action:"hold"}                    when owner is heads-down (caller buffers the nudge)
 *   - {action:"release", text: "..."}    when focus just cleared AND there are held items
 *   - null                               no focus transition — send normally
 *
 * Pure: wasFocused + heldItems are caller-managed (persisted across restarts).
 * URGENT nudges (caller-defined, e.g. pre-meeting priority≥80) skip this entirely.
 */
export function computeFocusGuardian(
  presenceState: SignalPresenceState | null,
  heldItems: string[],
  opts: FocusGuardianOpts,
): { action: "hold" } | { action: "release"; text: string } | null {
  const isFocused = !!presenceState && FOCUS_STATES.has(presenceState);

  if (isFocused) {
    return { action: "hold" };
  }

  // Focus just cleared + something was held → recap.
  if (opts.wasFocused && heldItems.length > 0) {
    const durationStr =
      opts.durationMs && opts.durationMs >= 30 * 60_000
        ? ` (${Math.round(opts.durationMs / (60 * 60_000))}h)`
        : "";
    const preview = heldItems.slice(0, 3).join("; ");
    const tail = heldItems.length > 3 ? ` (+${heldItems.length - 3} more)` : "";
    return {
      action: "release",
      text: `📥 while you were heads-down${durationStr}: ${preview}${tail}`,
    };
  }

  return null;
}

// ── Self-chat prefixes ────────────────────────────────────────────────────────
// Register with bot-self.ts so the bot never replies to its own self-chat echoes.
// ponytail: exported so bot-self.ts registers them without reaching into this file.
export const PROACTIVE_LOOP_SELF_PREFIXES: readonly string[] = [
  "🚗 driving",
  "🅿️ parked",
  "😴 ~",
  "🏃 ",   // health-coach step nudge
  "💪 nice", // health-coach workout ack
  "🧘 this week:", // health-coach weekly summary
  "📥 while you were heads-down", // focus-guardian release recap
] as const;

// Re-export SignalPresence so callers don't need a separate device-signals import.
export type { SignalPresence };
