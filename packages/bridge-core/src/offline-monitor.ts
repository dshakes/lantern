// Bridge offline monitor.
//
// Fires an email alert when the bridge sits in a non-live state
// (logged_out / error / conflict / idle when previously connected /
// reconnecting that doesn't clear) for longer than a threshold. The
// owner gets a heads-up before they realize friends' messages have
// been falling on the floor.
//
// Why a poll-based monitor rather than reacting to state transitions:
// the transition handler (already in session.ts) catches the
// IMMEDIATE drop. This monitor catches the case where the bridge
// SAYS reconnecting but stays stuck for hours — quietly broken.

import type { Logger } from "pino";
import { EmailMirror } from "./email-mirror.js";

export interface OfflineMonitorConfig {
  // Seconds the bridge must stay in a bad state before alerting.
  thresholdSec: number;
  // Check interval — runs the eval every N seconds.
  checkIntervalSec: number;
  // Cool-down between successive alerts for the same state. Prevents
  // hourly spam if the bridge is stuck for a week.
  alertCooldownSec: number;
  // Where the user fixes things (deep link in the email).
  dashboardUrl: string;
  // Channel label for the email ("WhatsApp" / "iMessage").
  channelLabel: string;
}

export function defaultOfflineMonitorConfig(channelLabel: string): OfflineMonitorConfig {
  return {
    thresholdSec: parseInt(process.env.LANTERN_OFFLINE_ALERT_AFTER_SEC ?? "300", 10),
    checkIntervalSec: 60,
    alertCooldownSec: 4 * 3600, // 4h between repeats
    dashboardUrl: process.env.LANTERN_DASHBOARD_URL || "http://localhost:3001",
    channelLabel,
  };
}

// Which states count as "needs your attention".
const BAD_STATES = new Set([
  "logged_out",
  "conflict",
  "error",
  "auth_required",
  "permission_required",
  "messages_not_running",
]);

// `idle` AFTER previously being connected is also bad — but we don't
// alert on initial-boot idle (the user hasn't paired yet, that's
// expected). The session tracks whether it's ever been connected.

export interface OfflineMonitorStateProvider {
  // Returns the current connection state string + whether the bridge
  // has ever been connected (to distinguish first-boot idle from
  // post-disconnect idle).
  getState: () => { state: string; everConnected: boolean; reason?: string | null };
}

export class OfflineMonitor {
  private logger: Logger;
  private cfg: OfflineMonitorConfig;
  private mirror: EmailMirror;
  private provider: OfflineMonitorStateProvider;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstBadAt: number | null = null;
  private lastAlertAt: number = 0;
  private lastAlertedState: string = "";

  constructor(
    logger: Logger,
    cfg: OfflineMonitorConfig,
    mirror: EmailMirror,
    provider: OfflineMonitorStateProvider,
  ) {
    this.logger = logger.child({ component: "offline-monitor", channel: cfg.channelLabel });
    this.cfg = cfg;
    this.mirror = mirror;
    this.provider = provider;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.evaluate(), this.cfg.checkIntervalSec * 1000);
    this.logger.info({ thresholdSec: this.cfg.thresholdSec }, "offline monitor started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private evaluate(): void {
    const { state, everConnected, reason } = this.provider.getState();
    const isBad =
      BAD_STATES.has(state) ||
      (state === "idle" && everConnected);

    if (!isBad) {
      // State is good — clear any in-progress timer.
      this.firstBadAt = null;
      return;
    }

    const now = Date.now();
    if (this.firstBadAt === null) {
      this.firstBadAt = now;
      this.logger.debug({ state }, "bad state detected — starting timer");
      return;
    }
    const elapsedSec = (now - this.firstBadAt) / 1000;
    if (elapsedSec < this.cfg.thresholdSec) {
      return; // still under threshold
    }
    // Threshold met. Cool-down check so we don't spam.
    const sinceLastAlert = (now - this.lastAlertAt) / 1000;
    if (state === this.lastAlertedState && sinceLastAlert < this.cfg.alertCooldownSec) {
      return; // same bad state, recently alerted
    }

    this.lastAlertAt = now;
    this.lastAlertedState = state;
    void this.sendAlert(state, reason ?? null, elapsedSec);
  }

  private async sendAlert(state: string, reason: string | null, elapsedSec: number): Promise<void> {
    const minutes = Math.round(elapsedSec / 60);
    const fixUrl = `${this.cfg.dashboardUrl.replace(/\/$/, "")}/personal/setup`;
    const body = [
      `🔴 *Lantern ${this.cfg.channelLabel} offline ${minutes}m*`,
      "",
      `State: ${state}`,
      reason ? `Reason: ${reason}` : "",
      "",
      "What this means:",
      this.explainState(state),
      "",
      `Fix: ${fixUrl}`,
    ].filter(Boolean).join("\n");

    this.logger.warn({ state, elapsedSec }, "firing offline alert");
    await this.mirror.send(body);
  }

  private explainState(state: string): string {
    switch (state) {
      case "logged_out":
        return "Your phone unlinked this device. Pair again to resume.";
      case "conflict":
        return "Another WhatsApp Web session is active for your number — log it out on your phone first.";
      case "error":
        return "The bridge hit an error. Check the dashboard /personal/activity tab.";
      case "auth_required":
        return "The bridge needs a shared token configured.";
      case "permission_required":
        return "macOS permission missing (Full Disk Access or Automation). See docs/personal/SETUP.md.";
      case "messages_not_running":
        return "Messages.app isn't running — open it and sign in.";
      case "idle":
        return "Previously connected but now idle. Re-pair to resume.";
      default:
        return `Unknown state. See docs/personal/SETUP.md.`;
    }
  }
}
