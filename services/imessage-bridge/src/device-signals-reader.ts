// Read-only reader for the iPhone app-context signal stream — the I/O side of
// the device-signals feature (the pure parsing/summarization lives in
// @lantern/bridge-core/device-signals).
//
// The owner's iOS Shortcuts automations POST events to the dashboard's
// /api/signals route, which appends them as JSON lines to
//   ~/.lantern/device-signals.jsonl  (mode 0600)
// This reader tails the recent lines and hands them to the pure summarizer.
//
// PRIVACY / SAFETY (HARD RULES — see device-signals.ts header):
//   * LOCAL + OWNER-ONLY. The file lives on the owner's Mac (0600). The summary
//     is injected ONLY into the owner's self-chat assistant context.
//   * FAILS CLOSED. Any failure — missing file, unreadable, garbage — is caught
//     and turned into an EMPTY summary + a single debug log. NEVER throws.
//   * SUMMARIES ONLY. Returns the distilled DeviceSummary, not raw lines.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Logger } from "pino";
import {
  parseSignals,
  summarizeDeviceSignals,
  type DeviceSummary,
} from "@lantern/bridge-core/device-signals";

/** Default device-signals JSONL location for the current user. */
export function defaultDeviceSignalsPath(): string {
  return join(homedir(), ".lantern", "device-signals.jsonl");
}

export interface ReadDeviceSignalsOpts {
  /** Override the file path (tests / non-standard installs). */
  filePath?: string;
  /** "now" anchor in Unix ms. Defaults to Date.now(). */
  nowMs?: number;
  /** Lookback window in ms. Defaults to ~2h (the summarizer default). */
  windowMs?: number;
  /** How many trailing lines to scan. Defaults to 500 (more than a busy 2h). */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 500;

/**
 * Read recent iPhone signals and return the distilled summary. NEVER throws:
 * on any failure (missing file, unreadable) returns an empty summary
 * (summaryLine === "") and logs once at debug. The bridge treats an empty
 * summary as "no signal this tick".
 */
export function readDeviceSignalsSummary(
  logger: Logger,
  opts: ReadDeviceSignalsOpts = {},
): DeviceSummary {
  const log = logger.child({ component: "device-signals-reader" });
  const empty = summarizeDeviceSignals([], {}); // canonical empty summary

  const filePath = opts.filePath ?? defaultDeviceSignalsPath();
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;

  if (!existsSync(filePath)) {
    log.debug({ filePath }, "device-signals.jsonl not found — no iPhone signal (no-op)");
    return empty;
  }

  try {
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const tail = lines.slice(-maxLines);
    const signals = parseSignals(tail);
    const summary = summarizeDeviceSignals(signals, {
      nowMs: opts.nowMs,
      windowMs: opts.windowMs,
    });
    log.debug(
      { lines: tail.length, signals: signals.length, topApps: summary.topApps.length },
      "read iPhone device signals",
    );
    return summary;
  } catch (err) {
    log.debug({ err: (err as Error).message }, "device-signals read failed (no-op, fails closed)");
    return empty;
  }
}
