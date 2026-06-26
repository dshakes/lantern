// Screen-aware context provider — OPT-IN only.
//
// When LANTERN_SCREEN_OCR=on, the bridge periodically captures the
// foreground app's frontmost window, OCRs it via the existing Vision
// pipeline, and stores a short summary so the bot can answer "what
// was that thing I was just looking at?" style questions.
//
// Privacy posture (these are HARD rules, not defaults):
//   1. OFF by default. Requires explicit LANTERN_SCREEN_OCR=on.
//   2. Per-app blocklist (banks, password managers, secret-bearing
//      apps). When the frontmost app is in the blocklist, capture is
//      SKIPPED and we don't even take the screenshot.
//   3. Snapshots are NEVER persisted to disk. The PNG is captured to
//      a tempfile, OCR'd, and the tempfile is immediately deleted.
//      Only the extracted TEXT is kept in memory.
//   4. Text is kept in a rolling window of N=8 most-recent OCRs
//      (default), purged on bridge restart. Each snippet ages out
//      after MAX_AGE_MS (default 15 min) — older content is no
//      longer relevant.
//   5. The bot's system prompt INCLUDES a note that "the user has
//      screen-context on" so the bot can decline to repeat sensitive
//      content back to non-owner contacts (defense in depth — the
//      bridge already only injects screen-context into owner-self-
//      chat prompts).
//   6. Quiet hours: screen capture is disabled outside of
//      configurable working hours. Default: 8am-10pm local.
//
// This module is the CAPTURE + STORE + RECALL plane. The bridge
// wires it into the owner-self-chat persona prompt.

import { spawn } from "child_process";
import { mkdirSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import type { Logger } from "pino";

export interface ScreenSnapshot {
  /** Foreground app name (e.g., "Safari", "Slack"). */
  app: string;
  /** Window title at capture time. */
  windowTitle: string;
  /** OCR'd visible text (truncated to MAX_TEXT_CHARS). */
  text: string;
  /** Epoch ms when captured. */
  ts: number;
}

export interface ScreenContextConfig {
  enabled: boolean;
  /** How often to capture (ms). Default 60s — frequent enough to
   *  catch context shifts, gentle enough to not destroy battery. */
  intervalMs: number;
  /** Max snapshots retained in memory at once. */
  ringSize: number;
  /** Snapshot TTL — older entries are dropped. */
  maxAgeMs: number;
  /** Apps that NEVER get captured. Case-insensitive prefix match. */
  appBlocklist: string[];
  /** Capture only between these hours (local time). 24h format. */
  startHour: number;
  endHour: number;
  /** Max OCR text length per snapshot (truncated past this). */
  maxTextChars: number;
}

const DEFAULT_BLOCKLIST = [
  "1Password",
  "Bitwarden",
  "Dashlane",
  "Keychain Access",
  "Banking",
  "Wallet",
  "Authy",
  "Google Authenticator",
  "Signal",
  "Telegram",
  "WhatsApp",
  "Messages",
  "Mail",
  "ProtonMail",
  "Tor Browser",
  "VPN",
];

export function defaultScreenContextConfig(): ScreenContextConfig {
  const num = (k: string, fallback: number) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    enabled: (process.env.LANTERN_SCREEN_OCR || "off").toLowerCase() === "on",
    intervalMs: num("LANTERN_SCREEN_OCR_INTERVAL_MS", 60_000),
    ringSize: num("LANTERN_SCREEN_OCR_RING", 8),
    maxAgeMs: num("LANTERN_SCREEN_OCR_TTL_MS", 15 * 60_000),
    appBlocklist: (process.env.LANTERN_SCREEN_OCR_BLOCK || "").split(",").map((s) => s.trim()).filter(Boolean).concat(DEFAULT_BLOCKLIST),
    startHour: num("LANTERN_SCREEN_OCR_START_HOUR", 8),
    endHour: num("LANTERN_SCREEN_OCR_END_HOUR", 22),
    maxTextChars: num("LANTERN_SCREEN_OCR_MAX_CHARS", 2000),
  };
}

export class ScreenContext {
  private cfg: ScreenContextConfig;
  private logger: Logger;
  private ring: ScreenSnapshot[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private inflightCapture = false;
  // Caller supplies an OCR function — keeps this module decoupled from
  // the bridge-specific Vision API plumbing.
  private ocrFn: (pngPath: string) => Promise<string>;

  constructor(cfg: ScreenContextConfig, logger: Logger, ocrFn: (pngPath: string) => Promise<string>) {
    this.cfg = cfg;
    this.logger = logger.child({ component: "screen-context" });
    this.ocrFn = ocrFn;
  }

  start(): void {
    if (!this.cfg.enabled) {
      this.logger.info({}, "screen-context disabled (set LANTERN_SCREEN_OCR=on to enable)");
      return;
    }
    if (this.pollTimer) return;
    this.logger.info({
      intervalMs: this.cfg.intervalMs,
      ringSize: this.cfg.ringSize,
      hours: `${this.cfg.startHour}-${this.cfg.endHour}`,
      blocklistSize: this.cfg.appBlocklist.length,
    }, "screen-context started — periodic foreground-app OCR");
    this.pollTimer = setInterval(() => {
      void this.tick().catch((err) => this.logger.debug({ err }, "tick failed"));
    }, this.cfg.intervalMs);
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.ring = [];
  }

  /** Return recent screen snippets for prompt injection. Filters by
   *  TTL. Returns "" when ring is empty (no overhead on the prompt). */
  recentContext(): string {
    const now = Date.now();
    this.ring = this.ring.filter((s) => now - s.ts < this.cfg.maxAgeMs);
    if (this.ring.length === 0) return "";
    const lines: string[] = [];
    lines.push(`## Screen context (last ${this.ring.length} foreground OCRs in the past ${Math.round(this.cfg.maxAgeMs / 60_000)}m)`);
    lines.push(`The owner is currently looking at things on his Mac. These OCR snippets are background context — only reference them when the user's question is plausibly about what's on screen RIGHT NOW. Do not volunteer this context proactively.`);
    for (const s of this.ring.slice().reverse()) {
      const ago = Math.round((now - s.ts) / 1000);
      lines.push(`\n--- ${s.app}${s.windowTitle ? ` · ${s.windowTitle.slice(0, 80)}` : ""} (${ago}s ago) ---`);
      lines.push(s.text.slice(0, this.cfg.maxTextChars));
    }
    return lines.join("\n");
  }

  private async tick(): Promise<void> {
    if (this.inflightCapture) return;
    // Quiet-hours gate.
    const hour = new Date().getHours();
    if (hour < this.cfg.startHour || hour >= this.cfg.endHour) {
      this.logger.debug({ hour }, "screen-context tick skipped — outside working hours");
      return;
    }
    // Foreground app via AppleScript.
    const fg = await this.frontmostApp();
    if (!fg) return;
    // Blocklist gate — checked BEFORE any screencapture call so we
    // never even take the screenshot for blocked apps.
    if (this.cfg.appBlocklist.some((b) => fg.app.toLowerCase().startsWith(b.toLowerCase()))) {
      this.logger.debug({ app: fg.app }, "screen-context: blocked app — skipping capture");
      return;
    }
    // Capture + OCR.
    this.inflightCapture = true;
    let tmpPath = "";
    try {
      tmpPath = await this.captureScreen();
      if (!tmpPath) return;
      const text = await this.ocrFn(tmpPath);
      const trimmed = (text || "").trim();
      if (!trimmed) return;
      const snap: ScreenSnapshot = {
        app: fg.app,
        windowTitle: fg.window,
        text: trimmed.slice(0, this.cfg.maxTextChars),
        ts: Date.now(),
      };
      this.ring.push(snap);
      if (this.ring.length > this.cfg.ringSize) {
        this.ring.splice(0, this.ring.length - this.cfg.ringSize);
      }
      this.logger.debug({ app: fg.app, textLen: trimmed.length }, "screen-context: captured");
    } catch (err) {
      this.logger.warn({ err }, "screen-context capture failed");
    } finally {
      // ALWAYS delete the tempfile, even on exceptions. The PNG must
      // never persist past one capture cycle.
      if (tmpPath) { try { rmSync(tmpPath, { force: true }); } catch {} }
      this.inflightCapture = false;
    }
  }

  // Frontmost app + window title via JXA. Doesn't trigger TCC
  // permission prompts beyond what AppleScript already requires
  // (System Events).
  private frontmostApp(): Promise<{ app: string; window: string } | null> {
    return new Promise((resolve) => {
      // Use `lsappinfo` (a plain system CLI that needs NO TCC) rather than
      // AppleScript/JXA. The bridge runs under launchd, which has Full Disk
      // Access but NOT Automation — so `osascript`/`System Events` returns
      // nothing and the whole feature silently no-ops. lsappinfo works
      // regardless. Window title isn't available without Automation; that's
      // fine — the blocklist gates on app NAME, which is what we need.
      const proc = spawn("/bin/sh", [
        "-c",
        'front=$(lsappinfo front 2>/dev/null); [ -n "$front" ] && lsappinfo info -only name "$front" 2>/dev/null',
      ]);
      let stdout = "";
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {}; resolve(null); }, 4000);
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.on("close", () => {
        clearTimeout(timer);
        // Output looks like: "LSDisplayName"="iTerm2"
        const m = stdout.match(/"LSDisplayName"\s*=\s*"([^"]+)"/);
        const app = (m?.[1] || "").trim();
        if (!app) {
          this.logger.debug({ raw: stdout.trim().slice(0, 80) }, "screen-context: could not resolve frontmost app");
          return resolve(null);
        }
        resolve({ app, window: "" });
      });
      proc.on("error", () => { clearTimeout(timer); resolve(null); });
    });
  }

  // macOS `screencapture` of the frontmost window. -x silences the
  // shutter sound. -l<id> captures by window id (we'd need the id;
  // simpler: -W = capture window the user picks; not usable in
  // background). Fallback: full-screen capture, less ideal but fine
  // for V1.
  private captureScreen(): Promise<string> {
    return new Promise((resolve) => {
      try { mkdirSync(join(homedir(), ".lantern", "screen-tmp"), { recursive: true, mode: 0o700 }); } catch {}
      const out = join(tmpdir(), `lantern-screen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
      // -x: no shutter sound. -m: main display only. -t png: PNG output.
      const proc = spawn("screencapture", ["-x", "-m", "-t", "png", out]);
      let stderr = "";
      proc.stderr?.on("data", (d) => (stderr += d.toString()));
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {}; this.logger.warn({}, "screen-context: screencapture timed out"); resolve(""); }, 8000);
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && existsSync(out)) {
          resolve(out);
        } else {
          // Loud, actionable: a non-zero exit with "could not create image
          // from display" means the bridge's node binary lacks Screen
          // Recording permission (TCC is per-binary; launchd-spawned nvm
          // node must be granted explicitly, and the grant only attaches
          // to a freshly-started process).
          this.logger.warn(
            { code, stderr: stderr.trim().slice(0, 200) },
            "screen-context: screencapture failed — likely missing Screen Recording permission for the bridge's node binary",
          );
          resolve("");
        }
      });
      proc.on("error", (err) => { clearTimeout(timer); this.logger.warn({ err: String(err) }, "screen-context: screencapture spawn error"); resolve(""); });
    });
  }

  // Diagnostics surface for the dashboard.
  status(): { enabled: boolean; ringSize: number; recentCaptures: number; oldestTs: number | null; newestTs: number | null } {
    const now = Date.now();
    this.ring = this.ring.filter((s) => now - s.ts < this.cfg.maxAgeMs);
    const ts = this.ring.map((s) => s.ts);
    return {
      enabled: this.cfg.enabled,
      ringSize: this.cfg.ringSize,
      recentCaptures: this.ring.length,
      oldestTs: ts.length ? Math.min(...ts) : null,
      newestTs: ts.length ? Math.max(...ts) : null,
    };
  }
}

// Re-export readFileSync so consumers can read PNG bytes for OCR
// without needing their own fs import.
export { readFileSync as _readFileSync };
