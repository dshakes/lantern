// Episodic memory per contact.
//
// Today's contact memory is a flat list of `facts` ("his daughter is
// Sam", "works at Stripe"). Useful but ahistorical: the bot can't
// answer "did you ever connect with Sarah?" or "what did we discuss
// last week?" because there's no notion of EPISODES — discrete
// events the owner shared or experienced with this person.
//
// This module records structured episodes: (date, topic, outcome).
// Example:
//   { date: "2026-05-12", topic: "house refi", outcome: "I said I'd intro to my agent" }
//   { date: "2026-05-15", topic: "house refi", outcome: "gave Sarah's number" }
//
// On every reply to that contact, the most-recent 3-5 episodes are
// injected as a system-prompt block:
//   "Recent episodes with this person:
//    - 2026-05-15: gave Sarah's number for house refi
//    - 2026-05-12: said I'd intro them to my agent"
//
// Storage: ~/.lantern/episodes.jsonl (append-only, cap 1MB, per-jid
// retrieval via in-memory cache). No DB migration needed; matches
// the storage pattern of dislike-memory.ts.
//
// Extraction: lightweight rule + LLM. The rule catches obvious
// "I told them X" / "they asked about Y" patterns. The LLM is the
// fallback for richer extractions — called only when the rule
// misses and the exchange is substantive (> 20 words combined).

import { appendFile, chmod, readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";
import { canonicalHandle } from "./canonical-handle.js";

// 0600 — episodes embed inbound/outbound message text (PII). Match the
// OCR-cache standard so a JSONL store of private messages isn't
// world-readable.
const FILE_MODE = 0o600;

export interface Episode {
  jid: string;
  // ISO date "YYYY-MM-DD" — day of the exchange.
  date: string;
  // Short topic phrase. 1-4 words. Examples:
  //   "house refi", "japan trip", "kids school", "investment loop"
  topic: string;
  // What happened in 1 short sentence. Past-tense, factual.
  //   "gave them Sarah's contact", "agreed to lunch Tuesday"
  outcome: string;
  // Optional rich context — the inbound + outbound that produced
  // this episode. Used for debugging + re-extraction. Kept short.
  context?: { inbound?: string; outbound?: string };
  // Lowercase first names this episode references besides the jid
  // owner. Lets cross-contact recall work: when the owner says
  // "Sujith was here this weekend" in self-chat, the episode lives
  // in the self-chat bucket BUT mentions ["sujith"], so Sujith's
  // next inbound message surfaces it via forMentions("sujith").
  mentions?: string[];
  ts: number; // epoch ms when recorded
}

const DEFAULT_PATH = join(homedir(), ".lantern", "episodes.jsonl");
const MAX_FILE_BYTES = 1024 * 1024;

export class EpisodicMemory {
  private path: string;
  private logger?: Logger;
  private cache: Map<string, Episode[]> | null = null;
  private cachedAt = 0;
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(opts: { path?: string; logger?: Logger } = {}) {
    this.path = opts.path || process.env.LANTERN_EPISODES_FILE || DEFAULT_PATH;
    this.logger = opts.logger?.child({ component: "episodic-memory" });
    try { mkdirSync(dirname(this.path), { recursive: true }); } catch {}
  }

  /** Append a new episode. */
  async record(ep: Omit<Episode, "ts">): Promise<Episode | null> {
    const row: Episode = { ...ep, ts: Date.now() };
    try {
      const fresh = !existsSync(this.path);
      await appendFile(this.path, JSON.stringify(row) + "\n", { encoding: "utf8", mode: FILE_MODE });
      if (fresh) { try { await chmod(this.path, FILE_MODE); } catch { /* best-effort */ } }
      this.cache = null;
      this.cachedAt = 0;
      this.logger?.info(
        { jid: row.jid, date: row.date, topic: row.topic, outcomeLen: row.outcome.length },
        "episode recorded",
      );
      return row;
    } catch (err) {
      this.logger?.warn({ err }, "episode record failed");
      return null;
    }
  }

  /**
   * Episodes for a jid (default cap 5). Newest-first by default; when
   * `relevantTo` (the inbound text) is supplied, rank by topic-overlap with
   * the inbound over a WIDER candidate window so an on-topic but older
   * episode isn't dropped for newer irrelevant ones (recency tiebreak).
   */
  async forJid(jid: string, limit = 5, relevantTo?: string): Promise<Episode[]> {
    await this.refreshIfStale();
    const bucket = this.cache?.get(canonicalHandle(jid)) ?? [];
    if (!relevantTo?.trim()) return bucket.slice(0, limit);
    // Rank over a wider pool than `limit` so a relevant older episode can
    // surface; bucket is already newest-first, so the head is the recent window.
    const pool = bucket.slice(0, Math.max(limit * 4, 24));
    return rankEpisodesByRelevance(pool, relevantTo, limit);
  }

  /**
   * Newest-first episodes whose `mentions` array contains ANY of the
   * supplied lowercase names. Excludes episodes already in the jid's
   * own bucket so the reply pipeline can stack jid + mention recall
   * without duplicates. Default cap 5, time-windowed to 30 days so an
   * arrival report from 2 years ago doesn't poison a fresh exchange.
   */
  async forMentions(
    names: string[],
    opts: { excludeJid?: string; limit?: number; maxAgeDays?: number } = {},
  ): Promise<Episode[]> {
    if (names.length === 0) return [];
    const lower = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
    if (lower.length === 0) return [];
    await this.refreshIfStale();
    const maxAgeMs = (opts.maxAgeDays ?? 30) * 86_400_000;
    const cutoff = Date.now() - maxAgeMs;
    const excludeKey = opts.excludeJid ? canonicalHandle(opts.excludeJid) : "";
    const out: Episode[] = [];
    for (const bucket of this.cache?.values() ?? []) {
      for (const ep of bucket) {
        if (ep.ts < cutoff) continue;
        if (excludeKey && canonicalHandle(ep.jid) === excludeKey) continue;
        if (!ep.mentions || ep.mentions.length === 0) continue;
        if (ep.mentions.some((m) => lower.includes(m))) out.push(ep);
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, opts.limit ?? 5);
  }

  private async refreshIfStale(): Promise<void> {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < EpisodicMemory.CACHE_TTL_MS) return;
    this.cache = new Map();
    this.cachedAt = now;

    if (!existsSync(this.path)) return;
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (err) { this.logger?.warn({ err }, "episodes read failed"); return; }

    if (raw.length > MAX_FILE_BYTES) {
      raw = raw.slice(-MAX_FILE_BYTES);
      const firstNl = raw.indexOf("\n");
      if (firstNl >= 0) raw = raw.slice(firstNl + 1);
    }

    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const ep = JSON.parse(t) as Episode;
        if (!ep.jid || !ep.date || !ep.outcome) continue;
        // Bucket by the CANONICAL key so old raw-jid rows and new rows for
        // the same person across channels merge into one bucket on read.
        const key = canonicalHandle(ep.jid);
        let bucket = this.cache.get(key);
        if (!bucket) { bucket = []; this.cache.set(key, bucket); }
        bucket.push(ep);
      } catch { /* skip malformed line */ }
    }
    for (const b of this.cache.values()) b.sort((a, b) => b.ts - a.ts);
  }
}

// Token-overlap relevance — mirrors owner-voice.ts:overlapScore. Lets an
// on-topic but older episode beat newer irrelevant ones. Pure + cheap.
const EP_STOPWORDS = new Set([
  "the", "and", "you", "your", "for", "are", "was", "but", "not", "with",
  "this", "that", "have", "has", "can", "will", "would", "what", "when",
  "how", "why", "yeah", "ok", "okay", "lol", "got", "get", "out", "all",
]);
function epTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of (s || "").toLowerCase().split(/[^a-zఀ-౿]+/)) {
    if (t.length >= 3 && !EP_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/**
 * Rank episodes by topic-overlap with the inbound text, newest-first as the
 * tiebreak. When the inbound has no usable tokens, falls back to pure
 * recency (the original behavior). Pure; exported so the bridges can rank the
 * merged (jid + mention) set before slicing for the prompt.
 */
export function rankEpisodesByRelevance<T extends Episode>(
  episodes: T[],
  inboundText: string,
  limit: number,
): T[] {
  if (episodes.length <= 1) return episodes.slice(0, limit);
  const q = epTokens(inboundText);
  if (q.size === 0) {
    return [...episodes].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }
  const scored = episodes.map((ep) => {
    let hits = 0;
    for (const t of epTokens(`${ep.topic ?? ""} ${ep.outcome}`)) if (q.has(t)) hits++;
    return { ep, score: hits };
  });
  // Relevance desc; recency (newest ts) desc as the tiebreak — so off-topic
  // (score 0) episodes still order newest-first among themselves.
  scored.sort((a, b) => b.score - a.score || b.ep.ts - a.ep.ts);
  return scored.slice(0, limit).map((x) => x.ep);
}

/**
 * Format episodes for the persona prompt. Empty string when none.
 * Designed to be tight (~200 chars typical) so it always fits.
 */
export function formatEpisodesBlock(episodes: Episode[]): string {
  if (episodes.length === 0) return "";
  const lines = [
    "## Recent episodes with this contact",
    "Use these to ground the reply (callbacks, follow-ups). Don't recite verbatim:",
  ];
  for (const ep of episodes) {
    const topic = ep.topic ? `${ep.topic}: ` : "";
    lines.push(`- ${ep.date} — ${topic}${ep.outcome}`);
  }
  return lines.join("\n");
}

/**
 * Extract a cross-contact episode from an owner self-chat utterance.
 * Catches statements like:
 *   "Sujith is visiting this weekend"
 *   "Driving Madhu to the airport tomorrow"
 *   "Sarika just flew back to India"
 *   "Mom is in town for two weeks"
 *
 * The episode is stored under the OWNER's self-chat jid but tagged
 * with the mentioned first-name(s) so it surfaces when those people
 * message later. Tries to grab a few known relationship-section
 * names from the profile so the bot doesn't have to LLM-extract
 * every passing reference; falls back to capitalized first-token
 * heuristic for unknowns.
 *
 * Returns null when nothing extractable.
 */
const ACTIVITY_HINTS =
  /\b(visit(?:ing|ed)?|in town|here this (?:weekend|week)|here for|came over|came down|came up|drove (?:back|home|down|up)|flew (?:back|in|out|home)|landed|leaving|left for|driving (?:to|back)|going to|reached|arrived|moved to|moving to|staying|hosting|hosted|picked up|drop(?:ping|ped) off)\b/i;

export function extractMentionEpisodeFromSelfChat(opts: {
  selfJid: string;
  text: string;
  knownNames: string[]; // lowercase first names from the owner's profile
}): Omit<Episode, "ts"> | null {
  const text = opts.text.trim();
  if (text.length < 8 || text.length > 400) return null;
  if (!ACTIVITY_HINTS.test(text)) return null;
  const lowerText = text.toLowerCase();
  const matched: string[] = [];
  for (const name of opts.knownNames) {
    if (!name) continue;
    // Word-boundary match against the lowercased text.
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lowerText)) matched.push(name);
  }
  if (matched.length === 0) return null;
  const activity = (text.match(ACTIVITY_HINTS)?.[0] || "").toLowerCase();
  return {
    jid: opts.selfJid,
    date: new Date().toISOString().slice(0, 10),
    topic: activity || "context",
    outcome: text.replace(/\s+/g, " ").slice(0, 140),
    mentions: matched,
    context: { inbound: text.slice(0, 200) },
  };
}

// Rule-based extractor — runs first, free, catches obvious patterns.
// Returns null when nothing high-confidence is detected.
const TOPIC_HINTS = /\b(trip|travel|wedding|funeral|baby|birth|move|moving|house|refi|loan|mortgage|invest|stock|crypto|interview|job|offer|school|admission|exam|surgery|hospital|sick|illness|covid|launch|deal|contract|gift|party|dinner|lunch|meeting|catch[\s-]up|sync)\b/i;
const OUTCOME_HINTS = /\b(told|gave|sent|forwarded|shared|asked|offered|promised|agreed|declined|scheduled|booked|paid|received|got|met)\b/i;

export function ruleExtract(
  jid: string,
  inbound: string,
  outbound: string,
): Omit<Episode, "ts" | "context"> | null {
  const combined = `${inbound}\n${outbound}`;
  const topicMatch = combined.match(TOPIC_HINTS);
  const outcomeMatch = outbound.match(OUTCOME_HINTS);
  if (!topicMatch || !outcomeMatch) return null;
  const topic = topicMatch[0].toLowerCase();
  // Outcome: the sentence in outbound that contains the outcome verb,
  // truncated to 80 chars.
  const sentences = outbound.split(/(?<=[.!?])\s+/);
  const outcomeSentence = sentences.find((s) => OUTCOME_HINTS.test(s)) || outbound;
  const outcome = outcomeSentence.trim().replace(/\s+/g, " ").slice(0, 100);
  return {
    jid,
    date: new Date().toISOString().slice(0, 10),
    topic,
    outcome,
  };
}

/**
 * High-level entry: given (jid, inbound, outbound, llmCall?), record
 * an episode if extractable. The LLM call is OPTIONAL — when omitted,
 * we only run the rule extractor. When provided, the LLM is the
 * fallback for richer exchanges (> 20 words combined) that miss the
 * rule.
 */
export async function maybeRecordEpisode(opts: {
  memory: EpisodicMemory;
  jid: string;
  inbound: string;
  outbound: string;
  llmCall?: (prompt: string) => Promise<string>;
}): Promise<Episode | null> {
  // 1. Rule first.
  const ruled = ruleExtract(opts.jid, opts.inbound, opts.outbound);
  if (ruled) {
    return opts.memory.record({
      ...ruled,
      context: { inbound: opts.inbound.slice(0, 200), outbound: opts.outbound.slice(0, 200) },
    });
  }

  // 2. LLM fallback — only when exchange is substantive.
  if (!opts.llmCall) return null;
  const combinedLen = (opts.inbound + opts.outbound).split(/\s+/).length;
  if (combinedLen < 20) return null;

  const prompt = [
    "Extract ONE episode from this exchange between the owner and a contact.",
    "Return JSON: {\"topic\": \"1-4 words\", \"outcome\": \"1 short sentence past-tense\"}",
    "If there's NO substantive episode (small talk, greetings, one-word replies), return {}.",
    "",
    `Them: ${opts.inbound}`,
    `You: ${opts.outbound}`,
    "",
    "JSON:",
  ].join("\n");

  try {
    const raw = await opts.llmCall(prompt);
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as { topic?: string; outcome?: string };
    if (!parsed.topic || !parsed.outcome) return null;
    return opts.memory.record({
      jid: opts.jid,
      date: new Date().toISOString().slice(0, 10),
      topic: parsed.topic.trim().slice(0, 60),
      outcome: parsed.outcome.trim().slice(0, 120),
      context: { inbound: opts.inbound.slice(0, 200), outbound: opts.outbound.slice(0, 200) },
    });
  } catch {
    return null;
  }
}
