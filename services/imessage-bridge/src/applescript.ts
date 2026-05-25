// JavaScript-for-Automation (JXA) wrapper for sending iMessage.
//
// Apple deprecated AppleScript's `tell application "Messages"` in
// favor of JXA (osascript -l JavaScript) but both still work. We use
// JXA because the syntax is cleaner and error reporting is better.
//
// Permission requirements:
//   - Messages.app must be logged into the user's Apple ID
//   - Automation permission for the bridge process to control
//     Messages: System Settings → Privacy & Security → Automation →
//     enable Messages for your terminal/launchd binary.
//
// We send via osascript subprocess because there's no good Node-native
// AppleEvent client. Latency is ~150-300ms per send which is fine —
// the bot pacing adds way more delay than the IPC.

import { spawn } from "child_process";
import type { Logger } from "pino";

const OSASCRIPT_TIMEOUT_MS = 15_000;

export class IMessageSender {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: "applescript" });
  }

  // Send `text` to `to` (a handle: "+15551234567" or "user@apple.id"
  // or a group's chat identifier like "chat123456").
  // Returns { ok: true } on success, { ok: false, reason } on any
  // failure including missing Automation permission.
  //
  // Implementation note: we switched from JXA to classic AppleScript
  // because JXA's `Messages.buddies[]` and `Messages.services()`
  // accessors throw "Message not understood (-1708)" on macOS
  // Sonoma+. Classic AppleScript syntax works reliably across all
  // current macOS versions and is what every other iMessage
  // automation tool (BlueBubbles, mautrix-imessage, etc.) uses.
  async send(to: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!to || !text) {
      return { ok: false, reason: "to + text required" };
    }
    // Escape quotes/backslashes for AppleScript string literals.
    const aplStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    // Try strategy A first (most common case — known iMessage contact),
    // then B (any service), then C (chat lookup).
    const strategies = [
      // A: buddy of iMessage service. The classic, most-supported path.
      `tell application "Messages"
        set targetService to 1st service whose service type = iMessage
        set targetBuddy to buddy ${aplStr(to)} of targetService
        send ${aplStr(text)} to targetBuddy
      end tell`,
      // B: buddy on any service (covers users whose default service is
      // SMS, not iMessage — rare, but happens).
      `tell application "Messages"
        send ${aplStr(text)} to buddy ${aplStr(to)}
      end tell`,
      // C: group chat or chat identifier (handles like "chat123456...").
      `tell application "Messages"
        set targetChat to a reference to chat ${aplStr(to)}
        send ${aplStr(text)} to targetChat
      end tell`,
    ];
    let lastErr = "no strategy attempted";
    for (let i = 0; i < strategies.length; i++) {
      const result = await this.runOsascript(strategies[i]);
      if (result.ok) return { ok: true };
      lastErr = result.reason;
      // If the error is permission-related, don't bother with fallback
      // strategies — they'll all hit the same wall.
      if (
        result.reason.includes("not authorized") ||
        result.reason.includes("-1743") ||
        result.reason.includes("Automation permission")
      ) {
        return result;
      }
    }
    // All strategies failed. Map common errors to actionable hints.
    if (lastErr.includes("doesn't understand the message") || lastErr.includes("-1708")) {
      return {
        ok: false,
        reason: `Messages.app didn't recognize the send command — this is usually because the contact (${to}) isn't a known iMessage buddy. Open Messages.app, send them one message manually first, then retry.`,
      };
    }
    if (lastErr.includes("can't find buddy") || lastErr.includes("can't get buddy") || lastErr.includes("-1728")) {
      return {
        ok: false,
        reason: `Contact "${to}" is not in your Messages buddies. Make sure they're a known iMessage contact (send them one message manually from Messages.app first).`,
      };
    }
    if (lastErr.includes("Application can't be found") || lastErr.includes("Application isn’t running") || lastErr.includes("Application isn't running")) {
      return { ok: false, reason: "Messages.app isn't running. Open it once and sign into iMessage." };
    }
    this.logger.warn({ lastErr, to }, "all send strategies failed");
    return { ok: false, reason: lastErr.slice(0, 300) };
  }

  // Send a FILE attachment to `to` via Messages.app. AppleScript's
  // Messages dictionary supports `send <file alias>` for attachments
  // — the file must already exist on disk and be FULLY MATERIALIZED
  // (not an iCloud Drive 0-byte placeholder). We pre-materialize via
  // `brctl download` before sending so iCloud Drive optimized-
  // storage files don't get sent as broken stubs.
  async sendFile(to: string, filePath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!to || !filePath) {
      return { ok: false, reason: "to + filePath required" };
    }
    // If the file is in iCloud Drive and only present as a stub,
    // brctl download materializes it locally. No-op for files that
    // are already fully on disk OR not in iCloud. Best-effort —
    // failures here don't block the send (the file might still work).
    if (filePath.includes("Mobile Documents/com~apple~CloudDocs") || filePath.includes("iCloud")) {
      await this.brctlDownload(filePath);
    }
    const aplStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    // POSIX file → `as alias` is critical: without `as alias`,
    // Messages.app attaches a reference instead of the real file
    // content, and the recipient sees a "PDF Document" placeholder
    // that can't be opened or downloaded. The `as alias` cast
    // resolves the path to a Finder alias the Messages send
    // pipeline uploads in full.
    const strategies = [
      `tell application "Messages"
        set targetService to 1st service whose service type = iMessage
        set targetBuddy to buddy ${aplStr(to)} of targetService
        set theFile to (POSIX file ${aplStr(filePath)}) as alias
        send theFile to targetBuddy
      end tell`,
      `tell application "Messages"
        set theFile to (POSIX file ${aplStr(filePath)}) as alias
        send theFile to buddy ${aplStr(to)}
      end tell`,
    ];
    let lastErr = "";
    for (const script of strategies) {
      const res = await this.runOsascript(script);
      if (res.ok) return { ok: true };
      lastErr = res.reason;
      if (res.reason.includes("not authorized") || res.reason.includes("-1743")) return res;
    }
    return { ok: false, reason: lastErr.slice(0, 300) };
  }

  // Force iCloud Drive to materialize a file from cloud → local disk.
  // No-op for files not in iCloud. Short timeout: large files take
  // longer but we'd rather fail fast than block the iMessage UX.
  private async brctlDownload(filePath: string): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn("brctl", ["download", filePath]);
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {}; resolve(); }, 15_000);
      proc.on("close", () => { clearTimeout(timer); resolve(); });
      proc.on("error", () => { clearTimeout(timer); resolve(); });
    });
  }

  // Run an osascript command. Centralized so the multi-strategy send()
  // doesn't duplicate process management.
  private runOsascript(script: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return new Promise((resolve) => {
      const proc = spawn("osascript", ["-e", script]);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
        resolve({ ok: false, reason: "osascript timed out (15s)" });
      }, OSASCRIPT_TIMEOUT_MS);
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ ok: true });
          return;
        }
        const err = (stderr || stdout || `osascript exited ${code}`).trim();
        resolve({ ok: false, reason: err });
      });
    });
  }

  // Smoke test — verifies Automation permission without actually
  // sending anything. Uses the classic AppleScript dialect because
  // it's more permissive about the Messages.app vocabulary across
  // macOS versions (JXA's bridge can throw -1708 'Message not
  // understood' on perfectly valid calls depending on the OS minor).
  async checkAccess(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const script = `tell application "Messages" to return name`;
    return new Promise((resolve) => {
      const proc = spawn("osascript", ["-e", script]);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
        resolve({ ok: false, reason: "osascript timed out (15s)" });
      }, OSASCRIPT_TIMEOUT_MS);
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim().length > 0) {
          resolve({ ok: true });
          return;
        }
        const err = stderr.trim() || `osascript exited ${code}`;
        if (err.includes("not authorized") || err.includes("-1743") || err.includes("not allowed")) {
          resolve({
            ok: false,
            reason: "Automation permission missing. System Settings → Privacy & Security → Automation → enable Messages for your terminal/launchd.",
          });
          return;
        }
        if (err.includes("Application can't be found") || err.includes("execution error")) {
          resolve({ ok: false, reason: "Messages.app not available or not logged into iMessage." });
          return;
        }
        resolve({ ok: false, reason: err.slice(0, 300) });
      });
    });
  }
}
