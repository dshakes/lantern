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
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { SignalPresence } from "./device-signals";

const execFileP = promisify(execFile);

// Shared, cross-channel presence file. The owner sets status on ONE channel
// (WhatsApp self-chat) and it must apply on EVERY channel (an iMessage contact
// should hear "he's at the pool"). Both bridges read/write this file, so the
// manual status is shared across bridges AND survives restarts.
const PRESENCE_FILE = join(homedir(), ".lantern", "presence.json");

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
  source: "override" | "iphone" | "focus" | "calendar" | "default";
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
  // iPhone-signal-derived availability (focus/device/location from the owner's
  // phone, via presenceFromSignals). Availability-only — never a place. Computed
  // fresh per-call by the bridge; wins over macOS Focus + calendar (the phone
  // reflects where the owner actually is), below a manual self-chat override.
  iphone?: SignalPresence | null;
  // When the iphone signal was sampled (ms epoch). Used to compare freshness
  // against a manual override so a stale place-based override yields to a
  // fresher phone signal. Pass the latest DeviceSignal.ts value here.
  iphoneTs?: number;
  logger?: Logger;
}

export interface ManualOverride {
  state: PresenceSnapshot["state"];
  label: string;
  expiresAt: number;
  // When the override was set (ms epoch). Required for staleness/anti-fabrication.
  // Old files without this field are coerced to 0 (unknown age).
  setAt: number;
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

  // Persist the manual override to the shared file (cross-bridge + restart).
  private persist(ov: ManualOverride | null): void {
    try {
      if (!ov) {
        try { unlinkSync(PRESENCE_FILE); } catch { /* already gone */ }
        return;
      }
      mkdirSync(join(homedir(), ".lantern"), { recursive: true });
      writeFileSync(PRESENCE_FILE, JSON.stringify(ov), { mode: 0o600 });
    } catch (err) {
      this.logger?.warn({ err }, "presence persist failed");
    }
  }

  // Read the shared override file (the cross-bridge source of truth). Returns
  // null when absent/expired/unparseable.
  private loadFromFile(): ManualOverride | null {
    try {
      const raw = readFileSync(PRESENCE_FILE, "utf8");
      const ov = JSON.parse(raw) as ManualOverride;
      if (!ov || typeof ov.expiresAt !== "number" || Date.now() >= ov.expiresAt) return null;
      // ponytail: coerce old files without setAt to 0 (unknown age); place will be suppressed.
      if (!ov.setAt) ov.setAt = 0;
      return ov;
    } catch {
      return null;
    }
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
      setAt: Date.now(),
      expiresAt: Date.now() + durationMs,
    };
    this.persist(this.manualOverride);
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
      setAt: Date.now(),
      place: opts.place?.trim() || undefined,
      takeMessage: opts.takeMessage ?? true,
      expiresAt: Date.now() + (opts.durationMs ?? 4 * 60 * 60_000),
    };
    this.persist(this.manualOverride);
    this.cache = null;
  }

  /** True if there's an active manual status. */
  hasActiveStatus(): boolean {
    if (this.manualOverride && Date.now() < this.manualOverride.expiresAt) return true;
    return !!this.loadFromFile();
  }

  /** Clear any active manual override. */
  clearOverride(): void {
    this.manualOverride = null;
    this.persist(null);
    this.cache = null;
  }

  /**
   * Get the current presence. Cheap (cached for 60s).
   */
  async current(opts: PresenceLookupOpts = {}): Promise<PresenceSnapshot> {
    const now = Date.now();
    // Manual status comes from the SHARED file (so a status set on another
    // bridge applies here). Read it fresh every call — tiny JSON — and let it
    // win immediately, bypassing the 60s cache used for focus/calendar.
    const override = this.loadFromFile() || (this.manualOverride && now < this.manualOverride.expiresAt ? this.manualOverride : null);
    if (!override && this.manualOverride) {
      this.manualOverride = null;
    }
    // Serve the cache only for the expensive focus/calendar/default sources.
    // A cached "override" snapshot must NOT survive once the shared file is
    // gone (another bridge cleared the status) — else "I'm back" wouldn't
    // propagate for up to 60s.
    if (!override && !opts.iphone && this.cache && this.cache.source !== "override" && now - this.cache.capturedAt < PresenceTracker.TTL_MS) {
      return this.cache;
    }

    // 1. Manual override wins — UNLESS a fresher iphone signal contradicts a
    // place-based status (e.g., "at the park" set 3h ago vs. a fresh Home signal).
    if (override) {
      const iphoneTs = opts.iphoneTs ?? 0;
      const overrideSetAt = override.setAt ?? 0;
      // Drop place-based overrides when the phone has fresher data (owner moved)
      // OR when the place is simply OLD (>60 min): a stale "at the temple" from
      // hours ago must not be served as current whereabouts just because no
      // iPhone signal arrived to refute it. Non-place overrides (meeting, sleep)
      // are intentional and stick.
      const PLACE_MAX_AGE_MS = 60 * 60_000;
      const stalePlace =
        !!override.place &&
        ((!!opts.iphone && iphoneTs > overrideSetAt) ||
          (overrideSetAt > 0 && now - overrideSetAt > PLACE_MAX_AGE_MS));
      if (!stalePlace) {
        // Staleness: show "as of Nm ago" when the override is ≥5 min old.
        const ageMins = overrideSetAt > 0 ? Math.round((now - overrideSetAt) / 60_000) : -1;
        const asOf = ageMins >= 5 ? ` (as of ${ageMins}m ago)` : "";
        const snap: PresenceSnapshot = {
          line: override.label + asOf,
          state: override.state,
          capturedAt: now,
          source: "override",
          // Anti-fabrication: only surface place when we have a timestamp for it.
          place: overrideSetAt > 0 ? override.place : undefined,
          takeMessage: override.takeMessage,
          away: override.state !== "free",
        };
        this.cache = snap;
        return snap;
      }
      // Stale place-based override: iphone is fresher → discard, fall through.
      this.manualOverride = null;
      this.persist(null);
      this.cache = null;
    }

    // 1.5 iPhone signal (focus/device/location from the phone). Fresher than the
    // Mac's Focus — the owner carries the phone. Like the override it bypasses
    // the 60s cache (passed in fresh each call) and is availability-only, so it's
    // never cached as a stale Mac reading. No `place` — never leaks whereabouts.
    if (opts.iphone) {
      // A "driving" signal (CarPlay/Bluetooth) lingers after the owner parks
      // and walks into a meeting. If the calendar says we're INSIDE a meeting
      // right now, that wins over driving (you can't be driving while sitting
      // in a meeting). Other iphone states (free/dnd/busy) are trusted as-is.
      if (opts.iphone.state === "driving" && opts.nextEvent) {
        try {
          const ev = await opts.nextEvent();
          if (ev?.summary && ev.startMs && ev.endMs && ev.startMs - now <= 0 && ev.endMs - now > 0) {
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
        } catch (err) {
          this.logger?.debug({ err }, "driving-vs-meeting calendar probe failed");
        }
      }
      // Staleness: show "as of Nm ago" when the iphone signal is ≥5 min old.
      const iphoneTs = opts.iphoneTs ?? 0;
      const ageMins = iphoneTs > 0 ? Math.round((now - iphoneTs) / 60_000) : -1;
      const asOf = ageMins >= 5 ? ` (as of ${ageMins}m ago)` : "";
      return {
        line: opts.iphone.line + asOf,
        state: opts.iphone.state,
        capturedAt: now,
        source: "iphone",
        away: opts.iphone.away,
      };
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

    // 4. Default: NO signal → UNKNOWN, not "free". Asserting "he's free"
    //    with zero basis is a fabrication (the contact is told he's available
    //    when we have no idea). Empty line → the persona prompt omits the block
    //    (the documented default), so the reply never claims an availability.
    const snap: PresenceSnapshot = {
      line: "",
      state: "unknown",
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
