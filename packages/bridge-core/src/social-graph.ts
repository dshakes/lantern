// Cross-contact social graph.
//
// Today each contact is treated in isolation: a message from Raju and
// a message from Madhu about the same trip never inform each other.
// The owner's mental model is the opposite — they ARE the connector,
// they know who shares what context with whom.
//
// This module gives the bot a lightweight version of that awareness.
// Every inbound/outbound is tagged with extracted TOPICS (people
// names, events, places, project codenames). On every reply, the bot
// gets a "related context from other threads" block: messages from
// OTHER contacts that mentioned the same topic recently.
//
// Example:
//   Raju → "did you connect with Sarah?"
//   Bot's prompt now includes:
//     ## Related context (other threads, last 7 days):
//     - [Madhu, 2026-05-15]: asked about Sarah for refi intro
//     - [Sarika, 2026-05-12]: mentioned Sarah at the wedding
//
// This is *not* a heavyweight knowledge graph. It's:
//   - One JSONL file of tagged messages: ~/.lantern/topic-index.jsonl
//   - A cheap topic extractor (proper nouns + a small allowlist of
//     event verbs)
//   - A retrieval that buckets by topic + sorts by recency
//
// All cross-contact retrieval is owner-side; no data crosses tenant
// boundaries. The block injected into the prompt explicitly tells
// the LLM "don't volunteer details from other threads unless asked".

import { appendFile, readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";

export interface TaggedMessage {
  jid: string;
  contactName?: string;
  // ISO timestamp of the message.
  ts: number;
  // What was said (truncated to 200 chars for the index).
  text: string;
  // Direction — useful so the prompt can say "Madhu asked X" vs "you told Madhu X".
  fromMe: boolean;
  // Topics extracted from this message. Lowercased, deduped.
  // Examples: ["sarah", "refi", "house"]
  topics: string[];
}

const DEFAULT_PATH = join(homedir(), ".lantern", "topic-index.jsonl");
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const RETRIEVAL_WINDOW_MS = 7 * 24 * 60 * 60_000; // 7 days

export class SocialGraph {
  private path: string;
  private logger?: Logger;
  private cache: TaggedMessage[] | null = null;
  private cachedAt = 0;
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(opts: { path?: string; logger?: Logger } = {}) {
    this.path = opts.path || process.env.LANTERN_TOPIC_INDEX || DEFAULT_PATH;
    this.logger = opts.logger?.child({ component: "social-graph" });
    try { mkdirSync(dirname(this.path), { recursive: true }); } catch {}
  }

  /** Index a single tagged message. Skip when no topics extracted. */
  async record(msg: Omit<TaggedMessage, "ts"> & { ts?: number }): Promise<void> {
    if (msg.topics.length === 0) return;
    const row: TaggedMessage = { ...msg, ts: msg.ts ?? Date.now() };
    try {
      await appendFile(this.path, JSON.stringify(row) + "\n", "utf8");
      this.cache = null;
      this.cachedAt = 0;
    } catch (err) {
      this.logger?.warn({ err }, "topic record failed");
    }
  }

  /**
   * Return up to N tagged messages from OTHER contacts (jid !=
   * excludeJid) within the retrieval window that mention any of the
   * given topics. Newest-first.
   */
  async related(opts: { topics: string[]; excludeJid: string; limit?: number }): Promise<TaggedMessage[]> {
    if (opts.topics.length === 0) return [];
    await this.refreshIfStale();
    const all = this.cache ?? [];
    const cutoff = Date.now() - RETRIEVAL_WINDOW_MS;
    const wanted = new Set(opts.topics.map((t) => t.toLowerCase()));
    const limit = opts.limit ?? 5;
    const matched: TaggedMessage[] = [];
    // all is newest-first after refreshIfStale().
    for (const m of all) {
      if (m.ts < cutoff) break;
      if (m.jid === opts.excludeJid) continue;
      if (m.topics.some((t) => wanted.has(t))) {
        matched.push(m);
        if (matched.length >= limit) break;
      }
    }
    return matched;
  }

  private async refreshIfStale(): Promise<void> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < SocialGraph.CACHE_TTL_MS) return;
    this.cache = [];
    this.cachedAt = now;

    if (!existsSync(this.path)) return;
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (err) { this.logger?.warn({ err }, "topic index read failed"); return; }

    if (raw.length > MAX_FILE_BYTES) {
      raw = raw.slice(-MAX_FILE_BYTES);
      const firstNl = raw.indexOf("\n");
      if (firstNl >= 0) raw = raw.slice(firstNl + 1);
    }

    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as TaggedMessage;
        if (!row.jid || !Array.isArray(row.topics)) continue;
        this.cache.push(row);
      } catch { /* skip */ }
    }
    this.cache.sort((a, b) => b.ts - a.ts);
  }
}

// Topic extractor — cheap heuristics. Targets the high-precision signal:
//   - Capitalized multi-letter words that aren't sentence-starters
//   - A small allowlist of event/topic nouns
//
// We deliberately stay cautious: false-positive topics ("Yes",
// "OK") would pollute the index and produce noise in retrieval.
const EVENT_NOUNS = new Set([
  "trip","wedding","funeral","baby","interview","offer","launch","deal",
  "refi","loan","mortgage","party","catchup","dinner","lunch","meeting",
  "school","exam","surgery","hospital","appointment","reservation",
  "flight","passport","visa","gift","contract","investment",
]);

// Common short uppercase-starts that aren't real entities ("OK",
// "TBD", days/months) — used to prune false positives.
const STOPWORDS = new Set([
  "OK","Yes","No","Hi","Hey","Sure","Fine","TBD","FYI","BTW","LOL","ETA","ASAP",
  "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday",
  "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec",
  "January","February","March","April","June","July","August","September","October","November","December",
]);

export function extractTopics(text: string): string[] {
  if (!text || text.length < 4) return [];
  const out = new Set<string>();

  // 1. Proper-noun candidates (capitalized words, not sentence-starts).
  // Walk word-by-word and only keep ones preceded by a lowercase word
  // (so we skip "Hey Raju" → only "Raju" is kept; "Raju asked..." is
  // kept too because we also catch the standalone variant below).
  const words = text.split(/(\s+|[,.;:!?])/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].trim();
    if (!w || w.length < 3) continue;
    if (!/^[A-Z][a-zA-Z]{2,}$/.test(w)) continue;
    if (STOPWORDS.has(w)) continue;
    out.add(w.toLowerCase());
  }

  // 2. Event nouns (allowlist, case-insensitive, must appear as
  // standalone word).
  const lower = text.toLowerCase();
  for (const noun of EVENT_NOUNS) {
    const re = new RegExp(`\\b${noun}\\b`, "i");
    if (re.test(lower)) out.add(noun);
  }

  return [...out];
}

/** Format related messages for the persona prompt. Empty when none. */
export function formatRelatedBlock(related: TaggedMessage[]): string {
  if (related.length === 0) return "";
  const lines = [
    "## Related context from OTHER threads (last 7 days)",
    "These are OTHER conversations where similar topics came up. Use them only if directly relevant. NEVER volunteer details from another thread unless the contact explicitly asks.",
  ];
  for (const m of related) {
    const who = m.contactName || m.jid.split("@")[0];
    const dir = m.fromMe ? "you told" : "they asked";
    const date = new Date(m.ts).toISOString().slice(0, 10);
    const preview = m.text.replace(/\s+/g, " ").slice(0, 100);
    lines.push(`- [${date}] ${dir} ${who}: ${preview}`);
  }
  return lines.join("\n");
}
