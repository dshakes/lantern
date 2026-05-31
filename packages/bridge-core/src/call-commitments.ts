// Outbound-call commitment tracking.
//
// When the bot makes a call on the owner's behalf, anything it
// commits to during that call (a time, a price, a promise to follow
// up) is recorded here. Storage is append-only JSONL with a 1-hour
// 👎-retract window — owner can react to the commitment notification
// in self-chat to retract before the recipient acts on it.
//
// File: ~/.lantern/call-commitments.jsonl  (chmod 600)
// Cap: 1 MB tail-trim on read so it can't OOM.

import { appendFile, readFile, chmod } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";

export interface CallCommitment {
  // Unique id for retract-by-id; format: "cm_<unix>_<rand>".
  id: string;
  // Twilio call SID this came from, for cross-reference.
  callSid?: string;
  // Who we called.
  to: string;
  contactName?: string;
  // The verbatim line the bot said that's the commitment.
  // ("told them yes for Friday 2pm")
  line: string;
  // Coarse category for owner-side filtering.
  category: "schedule" | "promise-callback" | "info-given" | "agreement" | "other";
  // Has the owner retracted it within the window?
  retracted?: boolean;
  ts: number;
}

const DEFAULT_PATH = join(homedir(), ".lantern", "call-commitments.jsonl");
const MAX_FILE_BYTES = 1024 * 1024;
const RETRACT_WINDOW_MS = 60 * 60_000; // 1 hour

export class CallCommitments {
  private path: string;
  private logger?: Logger;
  private cache: CallCommitment[] | null = null;
  private cachedAt = 0;
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(opts: { path?: string; logger?: Logger } = {}) {
    this.path = opts.path || process.env.LANTERN_CALL_COMMITMENTS_FILE || DEFAULT_PATH;
    this.logger = opts.logger?.child({ component: "call-commitments" });
    try { mkdirSync(dirname(this.path), { recursive: true }); } catch {}
  }

  async record(c: Omit<CallCommitment, "id" | "ts">): Promise<CallCommitment | null> {
    const row: CallCommitment = {
      ...c,
      id: `cm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
    };
    try {
      await appendFile(this.path, JSON.stringify(row) + "\n", "utf8");
      // Tighten file permissions — commitment lines may contain PII.
      try { await chmod(this.path, 0o600); } catch {}
      this.cache = null;
      this.cachedAt = 0;
      this.logger?.info(
        { id: row.id, callSid: row.callSid, to: row.to, line: row.line.slice(0, 80) },
        "call commitment recorded",
      );
      return row;
    } catch (err) {
      this.logger?.warn({ err }, "commitment record failed");
      return null;
    }
  }

  /**
   * Mark a commitment as retracted. Append-only: writes a new line
   * with the same id + retracted=true; the read path merges.
   */
  async retract(id: string): Promise<boolean> {
    try {
      const all = await this.list();
      const target = all.find((c) => c.id === id && !c.retracted);
      if (!target) return false;
      await appendFile(
        this.path,
        JSON.stringify({ ...target, retracted: true, ts: Date.now() }) + "\n",
        "utf8",
      );
      this.cache = null;
      this.cachedAt = 0;
      this.logger?.info({ id }, "call commitment retracted");
      return true;
    } catch (err) {
      this.logger?.warn({ err, id }, "commitment retract failed");
      return false;
    }
  }

  /**
   * All non-retracted commitments newest-first. Commitments older
   * than the retract window are considered "locked in" and reported
   * separately by status() — they're history, not pending action.
   */
  async list(): Promise<CallCommitment[]> {
    await this.refreshIfStale();
    return this.cache ?? [];
  }

  /** Commitments still inside the 👎-retract window. */
  async pending(): Promise<CallCommitment[]> {
    const all = await this.list();
    const cutoff = Date.now() - RETRACT_WINDOW_MS;
    return all.filter((c) => !c.retracted && c.ts > cutoff);
  }

  private async refreshIfStale(): Promise<void> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < CallCommitments.CACHE_TTL_MS) return;
    this.cache = [];
    this.cachedAt = now;
    if (!existsSync(this.path)) return;
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (err) { this.logger?.warn({ err }, "commitments read failed"); return; }
    if (raw.length > MAX_FILE_BYTES) {
      raw = raw.slice(-MAX_FILE_BYTES);
      const firstNl = raw.indexOf("\n");
      if (firstNl >= 0) raw = raw.slice(firstNl + 1);
    }
    const byId = new Map<string, CallCommitment>();
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const c = JSON.parse(t) as CallCommitment;
        if (!c.id) continue;
        // Later-line wins for same id (merges retract flag).
        byId.set(c.id, { ...byId.get(c.id), ...c });
      } catch { /* skip */ }
    }
    this.cache = [...byId.values()].sort((a, b) => b.ts - a.ts);
  }
}

/** Format pending commitments as a self-chat block. */
export function formatCommitmentsBlock(pending: CallCommitment[]): string {
  if (pending.length === 0) return "";
  const lines = [`📞 Pending call commitments (👎 within 1hr to retract):`];
  for (const c of pending) {
    const who = c.contactName || c.to;
    const mins = Math.round((Date.now() - c.ts) / 60_000);
    lines.push(`  [${c.id}] ${who}: ${c.line} (${mins}m ago)`);
  }
  return lines.join("\n");
}
