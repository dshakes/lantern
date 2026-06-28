// Proactive recall — surface the most relevant memory for the current inbound.
//
// Gated behind LANTERN_PROACTIVE_RECALL=1 (default OFF). When on, the reply
// prompt gets a compact "relevant context" block built from already-loaded
// episodes and cross-thread topic messages. When nothing clears the relevance
// threshold the function returns null — zero change to the reply.
//
// Pure, no I/O. Ranking is the same token-overlap approach used by
// episodic-memory.ts and owner-voice.ts — no embeddings, no new deps.

import type { Episode } from "./episodic-memory.js";

export interface RecallSources {
  /** Already-loaded episodic memories for this contact. */
  episodes?: Episode[];
  /** Messages from OTHER threads (social-graph related) about the same topics. */
  topics?: Array<{ text: string; ts: number; contactName?: string; fromMe?: boolean }>;
  /** Flat string facts (owner-profile fact lines, if available). */
  facts?: string[];
  /** Open commitments whose title may overlap the inbound. */
  commitments?: Array<{ title: string }>;
}

export interface RecallOptions {
  /** Max items across all sources to include. Default 3. */
  maxItems?: number;
  /**
   * Minimum overlap-hit count to include an item. Default 1 — at least one
   * non-stopword token must match. Threshold 0 disables filtering (not
   * recommended; that's what episodesBlock already covers).
   */
  threshold?: number;
}

// ponytail: same stopword set as episodic-memory.ts / owner-voice.ts — one source of truth would be cleaner, but it's 5 lines and the modules need to stay pure/dep-free.
const STOPWORDS = new Set([
  "the", "and", "you", "your", "for", "are", "was", "but", "not", "with",
  "this", "that", "have", "has", "can", "will", "would", "what", "when",
  "how", "why", "yeah", "ok", "okay", "lol", "got", "get", "out", "all",
]);

function tokenise(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of (s || "").toLowerCase().split(/[^a-zఀ-౿]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

function overlapHits(query: Set<string>, text: string): number {
  if (query.size === 0) return 0;
  let hits = 0;
  for (const t of tokenise(text)) if (query.has(t)) hits++;
  return hits;
}

interface Candidate {
  score: number;
  ts: number;
  line: string;
}

/**
 * Select the most relevant memory items for the current inbound message.
 *
 * Returns a compact prompt block when at least one item clears the relevance
 * threshold; null otherwise (the common case — no change to the reply).
 *
 * Pure — call only when LANTERN_PROACTIVE_RECALL is enabled.
 */
export function assembleRelevantRecall(
  inbound: string,
  sources: RecallSources,
  opts: RecallOptions = {},
): string | null {
  const maxItems = opts.maxItems ?? 3;
  const threshold = opts.threshold ?? 1;
  const q = tokenise(inbound);

  const candidates: Candidate[] = [];

  // Episodes: rank by topic + outcome overlap (same scoring as rankEpisodesByRelevance).
  for (const ep of sources.episodes ?? []) {
    const score = overlapHits(q, `${ep.topic ?? ""} ${ep.outcome}`);
    if (score < threshold) continue;
    const topic = ep.topic ? `${ep.topic}: ` : "";
    candidates.push({ score, ts: ep.ts, line: `${topic}${ep.outcome}` });
  }

  // Cross-thread topics: messages from other contacts that shared keywords.
  for (const t of sources.topics ?? []) {
    const score = overlapHits(q, t.text);
    if (score < threshold) continue;
    const who = t.contactName ? `${t.contactName}: ` : "";
    const dir = t.fromMe ? "you told them — " : "";
    candidates.push({ score, ts: t.ts, line: `${who}${dir}${t.text.trim().slice(0, 80)}` });
  }

  // Owner-profile facts: only include if they share tokens with the inbound.
  for (const fact of sources.facts ?? []) {
    const score = overlapHits(q, fact);
    if (score < threshold) continue;
    candidates.push({ score, ts: 0, line: fact.trim().slice(0, 80) });
  }

  // Open commitments: surface if the title overlaps the inbound topic.
  for (const c of sources.commitments ?? []) {
    const score = overlapHits(q, c.title);
    if (score < threshold) continue;
    candidates.push({ score, ts: 0, line: `open: ${c.title.trim().slice(0, 80)}` });
  }

  if (candidates.length === 0) return null;

  // Sort: relevance desc, then recency desc as tiebreak.
  candidates.sort((a, b) => b.score - a.score || b.ts - a.ts);
  const top = candidates.slice(0, maxItems);

  const lines = [
    "## Relevant context to weave in (only if it genuinely fits the reply — never volunteer unprompted; never list these directly; if nothing fits naturally, ignore this block entirely):",
  ];
  for (const item of top) lines.push(`- ${item.line}`);
  return lines.join("\n");
}
