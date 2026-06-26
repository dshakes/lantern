// GLOBAL owner-voice corpus.
//
// The per-contact style fingerprint (per-contact-style.ts) is potent but
// has a cold-start hole: a NEW or sparse contact has no history, so
// `styleBlockFor` returns "" and the bot falls back to generic rules.
// Evidence: a thin contact got "Not sure yet, vazthani Meeru chustha?" —
// broken Telangana (formal "Meeru" + a nonsense verb) and concierge
// boilerplate — because there were no real owner exemplars to mimic.
//
// The owner asked for the bot to "learn from history of ALL chat
// messages". This module aggregates the owner's OWN sent messages across
// EVERY contact into one global pool and surfaces a deduped, recent,
// representative set of verbatim exemplars — plus a Telugu-specific
// subset so Telugu replies mimic the owner's REAL phrasing rather than a
// textbook form. The persona injects these on every reply (in addition
// to the per-contact block), so even a first-message contact hears the
// owner's actual voice.
//
// Pure functions, no I/O. Each bridge gathers its raw samples its own way
// (WhatsApp: union of the ownerSentHistory map values; iMessage: the
// owner's is_from_me rows from chat.db) and passes them in.

import { isBotSelfMessage } from "./bot-self.js";

// Romanized-Telugu giveaway tokens — the same lexicon the per-contact
// fingerprint uses, kept local so this module stays dependency-light and
// consistent with how Telugu is tagged elsewhere. A message carrying any
// of these (or native Telugu script) is classed as the owner's Telugu
// voice.
const TELUGU_TOKENS = new Set([
  "vasta","vastha","vacchaka","vacchina","vacchi","cheptha","cheptanu","chepta","matladta","matladtham","matladkundam","ela","undi","unna","unnav","unnaru","chustha","chusta","chustanu","ostha","osta","ostunnav","ostunnaru","thelvadu","telidu","teliyadu","leda","ledu","ledhu","kavali","emi","enti","emaindi","amma","nanna","anna","akka","bava","vadina","ammayi","abbayi","cheppu","cheppara","sare","tappakunda","mari","koncham","baagunnav","bagunnava","ekkada","epudu","chesthunnav","chestunna","nuvvu","meeru","nenu","repu","ela","kada","ra"," ro",
]);

// Telugu native-script range (U+0C00–U+0C7F).
const TELUGU_SCRIPT_RE = /[ఀ-౿]/;

/** True when a message reads as the owner's Telugu voice (romanized
 *  tokens OR native Telugu script). Romanized detection requires a real
 *  token hit so a stray "ra" inside an English word can't false-positive
 *  — we tokenize on non-letter boundaries first. */
export function isTeluguSample(msg: string): boolean {
  if (TELUGU_SCRIPT_RE.test(msg)) return true;
  const tokens = msg
    .toLowerCase()
    .split(/[^a-zఀ-౿]+/)
    .filter(Boolean);
  for (const t of tokens) {
    if (TELUGU_TOKENS.has(t)) return true;
  }
  return false;
}

function wordCount(msg: string): number {
  return msg.trim().split(/\s+/).filter(Boolean).length;
}

// Comparison key for near-duplicate collapse: lowercased, emoji +
// punctuation + whitespace stripped. "ok!", "Ok", "ok 👍" → "ok".
// Exported so the corpus miners (chat.db / wa-history) collapse
// near-duplicates with the SAME rule the exemplar selector uses — a
// single source of truth for "these two messages are the same voice".
export function dedupeKey(msg: string): string {
  return msg
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/** One raw owner-sent sample. The optional timestamp lets callers feed a
 *  recency signal so the corpus prefers how the owner writes NOW. */
export interface OwnerVoiceSample {
  text: string;
  /** Epoch-ms when the owner sent it. Omit when unknown — undated samples
   *  are treated as oldest (sorted after dated ones) so a known-recent
   *  sample always wins a tie. */
  ts?: number;
}

export interface OwnerVoiceOptions {
  /** Cap on returned exemplars (default 12). */
  max?: number;
  /** Restrict to a single language bucket. "telugu" → only the owner's
   *  Telugu samples (for Telugu inbound); omit for the general pool. */
  lang?: "telugu";
  /** Min words to qualify as a real conversational unit (default 2). Drops
   *  bare "ok"/"k" acks that carry no voice signal. */
  minWords?: number;
  /** Max words so a pasted paragraph doesn't dominate (default 20). */
  maxWords?: number;
  /** OPTIONAL: the current inbound text. When supplied, qualifying samples
   *  are ranked by simple keyword/token overlap with this text so the
   *  few-shot prefers exemplars SHAPED like the message being answered —
   *  recency breaks ties and is the fallback when nothing overlaps. Cheap
   *  (token-set intersection, no embeddings). Omit for pure-recency. */
  relevantTo?: string;
}

// Tokenize for overlap scoring: lowercased word tokens ≥3 chars (drops
// "i"/"to"/"a" noise) across Latin + Telugu letters. Pure + cheap.
const RELEVANCE_STOPWORDS = new Set([
  "the", "and", "you", "your", "for", "are", "was", "but", "not", "with",
  "this", "that", "have", "has", "can", "will", "would", "what", "when",
  "how", "why", "yeah", "ok", "okay", "lol", "got", "get", "out", "all",
]);
function relevanceTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-zఀ-౿]+/)) {
    if (t.length >= 3 && !RELEVANCE_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}
function overlapScore(queryTokens: Set<string>, sample: string): number {
  if (queryTokens.size === 0) return 0;
  let hits = 0;
  for (const t of relevanceTokens(sample)) if (queryTokens.has(t)) hits++;
  return hits;
}

/**
 * Select a deduped, recent, representative set of verbatim owner
 * exemplars from the global pool of the owner's own sent messages.
 *
 * - Drops bot-self output (acks/status lines the bridge emitted).
 * - Drops too-short acks + too-long paragraphs.
 * - Near-duplicate collapse (a ring of "ok"/"sure" counts once).
 * - Most-recent-first (by ts when present; undated sink to the bottom).
 * - `lang: "telugu"` filters to the owner's Telugu voice only.
 *
 * Pure + cheap — callers may recompute per reply, or cache on a timer.
 */
export function ownerVoiceExemplars(
  samples: OwnerVoiceSample[],
  options: OwnerVoiceOptions = {},
): string[] {
  const max = options.max ?? 12;
  const minWords = options.minWords ?? 2;
  const maxWords = options.maxWords ?? 20;

  // Most-recent first. Undated samples sort last (treated as oldest) so a
  // dated recent message is always preferred over an undated one.
  const sorted = [...samples].sort((a, b) => (b.ts ?? -1) - (a.ts ?? -1));

  // Filter + dedup once, preserving recency order. We collect the full
  // qualifying set first so an optional relevance re-rank below can pick
  // the BEST matches across all of them rather than just the recent head.
  const seen = new Set<string>();
  const qualifying: string[] = [];
  for (const s of sorted) {
    const text = (s?.text ?? "").trim();
    if (!text || isBotSelfMessage(text)) continue;
    if (options.lang === "telugu" && !isTeluguSample(text)) continue;
    const wc = wordCount(text);
    if (wc < minWords || wc > maxWords) continue;
    const key = dedupeKey(text);
    // Keep empty-key messages (pure emoji/punctuation) — rare, and
    // collapsing them all to one bucket would over-prune.
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    qualifying.push(text);
  }

  // Relevance re-rank (optional): prefer samples that share keywords with
  // the current inbound, so the few-shot is shaped like the message being
  // answered. Stable sort keeps recency order among equal-overlap samples
  // (and overlap 0 everywhere ⇒ pure recency, the original behavior).
  if (options.relevantTo && qualifying.length > 1) {
    const q = relevanceTokens(options.relevantTo);
    if (q.size > 0) {
      const scored = qualifying.map((text, idx) => ({
        text,
        idx,
        score: overlapScore(q, text),
      }));
      scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
      return scored.slice(0, max).map((x) => x.text);
    }
  }

  return qualifying.slice(0, max);
}

/**
 * Format the global owner-voice exemplars as a persona-prompt block.
 * Returns "" when there are no exemplars. When `teluguExemplars` is
 * supplied (and non-empty), they get their own prominent sub-block so a
 * Telugu inbound mimics the owner's REAL Telugu phrasing — far stronger
 * than the BAD→GOOD dialect rules.
 */
export function formatOwnerVoiceBlock(
  ownerName: string,
  generalExemplars: string[],
  teluguExemplars: string[] = [],
): string {
  const general = generalExemplars.filter((s) => s.trim().length > 0);
  const telugu = teluguExemplars.filter((s) => s.trim().length > 0);
  if (general.length === 0 && telugu.length === 0) return "";

  const lines: string[] = [
    `## HOW ${ownerName.toUpperCase()} ACTUALLY WRITES — mimic this exact voice (verbatim examples from real messages)`,
    `These are ${ownerName}'s OWN messages across all his chats. Match this voice — length, casing, vocabulary, rhythm, punctuation. These real examples OVERRIDE any generic style rule.`,
  ];
  for (const s of general) lines.push(`> ${s}`);

  if (telugu.length > 0) {
    lines.push("");
    lines.push(
      `When replying in Telugu, write EXACTLY like these real Telugu messages from ${ownerName} (his natural Telangana register — short verbs, casual, NOT textbook/coastal). Mimic the SHAPE, never invent forms he doesn't use:`,
    );
    for (const s of telugu) lines.push(`> ${s}`);
  }

  return lines.join("\n");
}
