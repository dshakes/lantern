// Live presence — owner's CURRENT state, injected into every reply
// so the bot's tone tracks what's actually happening.
//
// Three signal sources, in priority order:
//   1. macOS Focus mode — Do Not Disturb, Work, Sleep, Driving, etc.
//      Read via `defaults read com.apple.controlcenter Modes` (modern
//      macOS) or `osascript` polling Notification Center. Falls back
//      silently when unavailable.
//   2. Calendar window — next event in the next 30 minutes that
//      contains "meeting" / "call" / "interview" / a video-link.
//      Already wired through CalendarLookup.
//   3. Owner self-chat override — user types "presence: driving"
//      and the bridge holds that override for up to 4 hours. The
//      override beats Focus + calendar.
//
// All sources are best-effort. When NONE produce a signal, the
// presence string is empty and the persona prompt simply omits the
// block (default behavior unchanged).
//
// Refresh cadence: 60s. The presence string is cached so per-reply
// rendering is O(1).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";

const execFileP = promisify(execFile);

export interface PresenceSnapshot {
  // Human-readable one-liner suitable for the system prompt. Empty
  // when no signal is available.
  // Examples:
  //   "in a meeting until 4:30 PM ET"
  //   "Do Not Disturb (Focus)"
  //   "driving — Focus mode"
  //   "free / available"
  line: string;
  // Coarse state used by callers that want to gate behavior on it
  // (e.g. "don't auto-reply during sleep").
  state: "busy" | "meeting" | "driving" | "dnd" | "sleep" | "free" | "unknown";
  // When the snapshot was computed. Callers check this against TTL.
  capturedAt: number;
  // Optional source for debugging.
  source: "override" | "focus" | "calendar" | "default";
  // Free-text place the owner set ("the temple", "the gym"), if any.
  place?: string;
  // Owner wants the bot to offer to take a message while away.
  takeMessage?: boolean;
  // True when the owner is unavailable (busy/meeting/driving/dnd/sleep or an
  // explicit away status) — contacts should be told he'll get back.
  away?: boolean;
}

export interface PresenceLookupOpts {
  // Calendar accessor — returns next event matching meeting/call/etc.
  // The bridge has this via CalendarLookup. Type is loose so this
  // module doesn't import the implementation.
  nextEvent?: () => Promise<{ summary?: string; startMs?: number; endMs?: number } | null>;
  // Manual override path (owner-chat: "presence: driving"). When
  // the bridge sets this, it wins over Focus + calendar until the
  // override expires.
  manualOverride?: ManualOverride | null;
  logger?: Logger;
}

export interface ManualOverride {
  state: PresenceSnapshot["state"];
  label: string;
  expiresAt: number;
  // Free-text place/status the owner set ("at the temple", "at the gym").
  place?: string;
  // When true, the bot should OFFER to take a message from a contact while
  // the owner is away ("…he'll get back to you — want me to pass a message?").
  takeMessage?: boolean;
}

export class PresenceTracker {
  private cache: PresenceSnapshot | null = null;
  private static readonly TTL_MS = 60_000;
  private manualOverride: ManualOverride | null = null;
  private logger?: Logger;

  constructor(opts: { logger?: Logger } = {}) {
    this.logger = opts.logger?.child({ component: "presence" });
  }

  /**
   * Set a manual override. Wins over auto-detection until expiry.
   * Wire to a self-chat command "presence: driving for 2h".
   * Common labels we accept:
   *   driving | meeting | dnd | sleep | free | busy
   */
  setOverride(label: string, durationMs: number = 4 * 60 * 60_000): void {
    const normalized = label.trim().toLowerCase();
    const state: PresenceSnapshot["state"] =
      normalized === "driving" ? "driving" :
      normalized === "meeting" || normalized === "in a meeting" ? "meeting" :
      normalized === "dnd" || normalized === "do not disturb" ? "dnd" :
      normalized === "sleep" || normalized === "sleeping" ? "sleep" :
      normalized === "free" || normalized === "available" ? "free" :
      "busy";
    this.manualOverride = {
      state,
      label: normalized,
      expiresAt: Date.now() + durationMs,
    };
    this.cache = null; // force recompute on next read
  }

  /**
   * Set a free-text status with an optional place + duration, e.g. the owner
   * texts "I'm at the temple for 2h". Distinct from setOverride's fixed
   * enum states — this carries arbitrary place/label text and a take-message
   * flag for the contact-facing "can I pass a message?" offer.
   */
  setStatus(opts: {
    label: string;
    place?: string;
    state?: PresenceSnapshot["state"];
    durationMs?: number;
    takeMessage?: boolean;
  }): void {
    const label = opts.label.trim();
    this.manualOverride = {
      state: opts.state ?? "busy",
      label,
      place: opts.place?.trim() || undefined,
      takeMessage: opts.takeMessage ?? true,
      expiresAt: Date.now() + (opts.durationMs ?? 4 * 60 * 60_000),
    };
    this.cache = null;
  }

  /** True if there's an active manual status. */
  hasActiveStatus(): boolean {
    return !!(this.manualOverride && Date.now() < this.manualOverride.expiresAt);
  }

  /** Clear any active manual override. */
  clearOverride(): void {
    this.manualOverride = null;
    this.cache = null;
  }

  /**
   * Get the current presence. Cheap (cached for 60s).
   */
  async current(opts: PresenceLookupOpts = {}): Promise<PresenceSnapshot> {
    const now = Date.now();
    if (this.cache && now - this.cache.capturedAt < PresenceTracker.TTL_MS) {
      return this.cache;
    }

    // Drop expired override.
    const override = this.manualOverride && now < this.manualOverride.expiresAt ? this.manualOverride : null;
    if (!override && this.manualOverride) {
      this.manualOverride = null;
    }

    // 1. Manual override wins.
    if (override) {
      const snap: PresenceSnapshot = {
        line: override.label,
        state: override.state,
        capturedAt: now,
        source: "override",
        place: override.place,
        takeMessage: override.takeMessage,
        away: override.state !== "free",
      };
      this.cache = snap;
      return snap;
    }

    // 2. macOS Focus mode.
    const focus = await this.detectFocus();
    if (focus) {
      this.cache = focus;
      return focus;
    }

    // 3. Calendar — next meeting window.
    if (opts.nextEvent) {
      try {
        const ev = await opts.nextEvent();
        if (ev?.summary && ev.startMs && ev.endMs) {
          const startsIn = ev.startMs - now;
          const endsIn = ev.endMs - now;
          // We're INSIDE the event.
          if (startsIn <= 0 && endsIn > 0) {
            const endTime = new Date(ev.endMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
            const snap: PresenceSnapshot = {
              line: `in a meeting until ${endTime}`,
              state: "meeting",
              capturedAt: now,
              source: "calendar",
              away: true,
            };
            this.cache = snap;
            return snap;
          }
          // Upcoming meeting in < 5 min.
          if (startsIn > 0 && startsIn < 5 * 60_000) {
            const snap: PresenceSnapshot = {
              line: `meeting starting in ${Math.round(startsIn / 60_000)} min`,
              state: "meeting",
              capturedAt: now,
              source: "calendar",
              away: true,
            };
            this.cache = snap;
            return snap;
          }
        }
      } catch (err) {
        this.logger?.debug({ err }, "calendar presence probe failed");
      }
    }

    // 4. Default: free.
    const snap: PresenceSnapshot = {
      line: "free / available",
      state: "free",
      capturedAt: now,
      source: "default",
      away: false,
    };
    this.cache = snap;
    return snap;
  }

  /**
   * macOS Focus / DND detection. Multiple APIs across macOS versions —
   * we try in order and stop at the first one that works.
   */
  private async detectFocus(): Promise<PresenceSnapshot | null> {
    // 1) Modern macOS (Ventura+): defaults read on the assertions plist.
    try {
      const { stdout } = await execFileP("defaults", [
        "read",
        `${process.env.HOME}/Library/DoNotDisturb/DB/Assertions.json`,
      ], { timeout: 1500 });
      // The plist is JSON-ish; we just look for an active assertion.
      if (stdout.includes("Active") || stdout.includes("active")) {
        // Try to find a mode name. Common values: "com.apple.donotdisturb.mode.default",
        // "com.apple.donotdisturb.mode.driving", "...work", "...sleep".
        const modeMatch = stdout.match(/com\.apple\.donotdisturb\.mode\.(\w+)/);
        const mode = modeMatch?.[1]?.toLowerCase();
        const { line, state } = focusLabelFor(mode);
        return {
          line,
          state,
          capturedAt: Date.now(),
          source: "focus",
          away: state !== "free",
        };
      }
    } catch {
      /* fall through to next probe */
    }

    // 2) AppleScript fallback for older macOS: query System Events.
    // We keep this best-effort; many systems don't expose DND state
    // via AppleScript, in which case we return null and presence
    // falls back to calendar / default.
    return null;
  }
}

function focusLabelFor(mode: string | undefined): { line: string; state: PresenceSnapshot["state"] } {
  switch (mode) {
    case "driving":
      return { line: "driving — Focus mode active", state: "driving" };
    case "sleep":
      return { line: "asleep — Sleep Focus active", state: "sleep" };
    case "work":
      return { line: "in Work Focus — heads-down on engineering", state: "busy" };
    case "personal":
      return { line: "Personal Focus on — limited responsiveness", state: "busy" };
    case "fitness":
      return { line: "working out — Fitness Focus", state: "busy" };
    default:
      return { line: "Do Not Disturb on", state: "dnd" };
  }
}
