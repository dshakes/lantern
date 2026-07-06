// Long-term memory of dislike-retry events.
//
// When the owner taps 👎 on a bot reply (handled per-bridge in
// handleTapbackRetry on iMessage, handleBadFeedbackRetry on WhatsApp),
// the bridge already re-prompts the LLM with a critique. That fixes
// the IMMEDIATE reply but loses the lesson: 10 minutes later the bot
// makes the same mistake with the same contact.
//
// This module turns each 👎 into a permanent calibration. We persist
// (inbound, bad-reply, contact, ts) — and OPTIONALLY a good-reply
// when the retried version was accepted — to a JSONL file. On every
// future reply to that contact, the most-recent 3-5 dislike entries
// are formatted into a system-prompt block: "previously rejected
// reply shapes — DO NOT REPEAT THESE STYLES."
//
// Store choice:
//   ~/.lantern/dislike-patterns.jsonl
// JSONL because it's append-only, survives crashes mid-write, easy to
// inspect with `cat`, and the read path streams the tail.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { canonicalHandle } from "./canonical-handle.js";
import { loadOrCreateStateKey, appendSecureLine, readSecureLines } from "./secure-store.js";

// Entries hold inbound message text + bot replies (PII), so lines are
// AES-256-GCM-encrypted at rest (0600) via secure-store; old plaintext lines
// still read (backward-compat).

export interface DislikeEntry {
  jid: string;          // contact JID / handle the bad reply was sent to
  inbound: string;      // their message we were responding to
  badReply: string;     // the reply they 👎'd
  goodReply?: string;   // the corrected reply (if retry was accepted)
  ts: number;           // epoch ms
  channel: "imessage" | "whatsapp";
}

const DEFAULT_PATH = join(homedir(), ".lantern", "dislike-patterns.jsonl");
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB hard cap; we never need more

export class DislikeMemory {
  private path: string;
  private logger?: Logger;
  // In-memory cache for fast lookup. Refreshed from disk on demand.
  // Keyed by jid; each bucket holds entries sorted newest-first.
  private cache: Map<string, DislikeEntry[]> | null = null;
  private cachedAt = 0;
  private key: Buffer | null = null;
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(opts: { path?: string; logger?: Logger } = {}) {
    this.path = opts.path || process.env.LANTERN_DISLIKE_FILE || DEFAULT_PATH;
    this.logger = opts.logger?.child({ component: "dislike-memory" });
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* dir may already exist; we'll surface real failures on write */
    }
  }

  // State key lives next to the state file (co-located per store dir).
  private getKey(): Buffer {
    if (!this.key) this.key = loadOrCreateStateKey(dirname(this.path));
    return this.key;
  }

  /**
   * Append a new dislike entry. Returns the saved row. Fire-and-forget
   * safe — failures log a warning but don't throw.
   */
  async record(entry: Omit<DislikeEntry, "ts">): Promise<DislikeEntry | null> {
    const row: DislikeEntry = { ...entry, ts: Date.now() };
    try {
      await appendSecureLine(this.path, JSON.stringify(row), this.getKey());
      // Invalidate cache so the next read picks up this entry.
      this.cache = null;
      this.cachedAt = 0;
      this.logger?.info(
        { jid: row.jid, channel: row.channel, badLen: row.badReply.length },
        "dislike recorded",
      );
      return row;
    } catch (err) {
      this.logger?.warn({ err, path: this.path }, "dislike record failed");
      return null;
    }
  }

  /**
   * Update the most-recent entry for a jid with the corrected good
   * reply. Called when the critique-retry produces something
   * acceptable so future prompts can show both the bad and good
   * shape for context.
   *
   * Append-only: instead of mutating the existing row in place
   * (risky for a JSONL append-only log) we write a new "patch" row
   * with the same key fields. The read path merges patches.
   */
  async patchLastWithGood(jid: string, goodReply: string): Promise<void> {
    try {
      const entries = await this.forJid(jid);
      if (entries.length === 0) return;
      const last = entries[0]; // newest-first
      // Skip patch if the good reply is byte-equal to the bad reply
      // (degenerate retry) or already set.
      if (last.goodReply || last.badReply.trim() === goodReply.trim()) return;
      const patch: DislikeEntry = { ...last, goodReply, ts: last.ts };
      await appendSecureLine(this.path, JSON.stringify(patch), this.getKey());
      this.cache = null;
      this.cachedAt = 0;
    } catch (err) {
      this.logger?.warn({ err, jid }, "dislike patch failed");
    }
  }

  /**
   * Return all dislike entries for a contact, newest first. Capped to
   * the last 5 — older calibrations rarely stay relevant.
   */
  async forJid(jid: string, limit = 5): Promise<DislikeEntry[]> {
    await this.refreshIfStale();
    const bucket = this.cache?.get(canonicalHandle(jid)) ?? [];
    return bucket.slice(0, limit);
  }

  /**
   * Return ALL dislike entries across every contact, newest first. Used
   * by the consolidator to mine GENERAL style lessons (patterns that
   * recur across contacts, not just one thread). Capped to `limit`.
   */
  async all(limit = 500): Promise<DislikeEntry[]> {
    await this.refreshIfStale();
    const out: DislikeEntry[] = [];
    for (const bucket of this.cache?.values() ?? []) out.push(...bucket);
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, limit);
  }

  private async refreshIfStale(): Promise<void> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < DislikeMemory.CACHE_TTL_MS) return;
    this.cache = new Map();
    this.cachedAt = now;

    // readSecureLines decrypts each line and tail-caps at MAX_FILE_SIZE_BYTES
    // (dropping a possibly-truncated first line) — the OOM safety net. We
    // don't rotate proactively — admin can `tail -n 1000 dislike-patterns.jsonl
    // > tmp && mv tmp dislike-patterns.jsonl` when needed.
    let lines: string[];
    try {
      lines = await readSecureLines(this.path, this.getKey(), MAX_FILE_SIZE_BYTES);
    } catch (err) {
      this.logger?.warn({ err, path: this.path }, "dislike read failed");
      return;
    }

    // Parse + merge patches. A patch row has the same jid + inbound
    // + badReply + ts as the original — when we see it later in the
    // stream, we overlay goodReply onto the existing entry.
    const byKey = new Map<string, DislikeEntry>();
    for (const trimmed of lines) {
      let entry: DislikeEntry;
      try {
        entry = JSON.parse(trimmed) as DislikeEntry;
      } catch {
        continue;
      }
      if (!entry || typeof entry.jid !== "string" || typeof entry.badReply !== "string") continue;
      const key = `${entry.jid}|${entry.ts}|${entry.badReply.slice(0, 60)}`;
      const existing = byKey.get(key);
      if (existing) {
        // Patch: overlay non-empty fields.
        if (entry.goodReply && !existing.goodReply) existing.goodReply = entry.goodReply;
      } else {
        byKey.set(key, { ...entry });
      }
    }

    // Bucket by the CANONICAL key (newest first) so old raw-jid rows and
    // new rows for the same person across channels share one bucket.
    for (const entry of byKey.values()) {
      const bucketKey = canonicalHandle(entry.jid);
      let bucket = this.cache.get(bucketKey);
      if (!bucket) {
        bucket = [];
        this.cache.set(bucketKey, bucket);
      }
      bucket.push(entry);
    }
    for (const bucket of this.cache.values()) {
      bucket.sort((a, b) => b.ts - a.ts);
    }
  }
}

/**
 * Format up to N dislike entries as a system-prompt block. Returns
 * empty string when there are no usable entries.
 *
 * The block is intentionally short — the goal is to remind the model
 * what shapes the owner rejected, not to drown it in history.
 */
export function formatDislikeBlock(entries: DislikeEntry[], opts: { max?: number } = {}): string {
  const max = Math.min(opts.max ?? 3, entries.length);
  if (max === 0) return "";

  const lines: string[] = [
    "## Previously rejected reply shapes with this contact (👎'd by owner — DO NOT REPEAT)",
    "When you draft this reply, AVOID the patterns shown in 'BAD' — they're confirmed wrong for this person. When 'GOOD' is present, that's the shape the owner accepted as the correction; mirror its style.",
  ];

  for (let i = 0; i < max; i++) {
    const e = entries[i];
    lines.push("");
    lines.push(`Inbound: ${truncate(e.inbound, 120)}`);
    lines.push(`BAD reply (👎): ${truncate(e.badReply, 160)}`);
    if (e.goodReply) {
      lines.push(`GOOD reply (accepted): ${truncate(e.goodReply, 160)}`);
    }
  }

  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  const flat = (s || "").replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}
