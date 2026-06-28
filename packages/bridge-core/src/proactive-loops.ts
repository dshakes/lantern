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

import { presenceFromSignals, type DeviceSignal, type SignalPresence } from "./device-signals.js";
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

// ── Self-chat prefixes ────────────────────────────────────────────────────────
// Register with bot-self.ts so the bot never replies to its own self-chat echoes.
// ponytail: exported so bot-self.ts registers them without reaching into this file.
export const PROACTIVE_LOOP_SELF_PREFIXES: readonly string[] = [
  "🚗 driving",
  "🅿️ parked",
  "😴 ~",
] as const;

// Re-export SignalPresence so callers don't need a separate device-signals import.
export type { SignalPresence };
