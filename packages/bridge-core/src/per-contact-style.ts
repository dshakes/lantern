// Per-contact style fingerprint.
//
// Each persons sees a slightly different version of the owner. The
// owner writes in lowercase + clipped Telugu to family, formal English
// to a recruiter, emoji-heavy to a close friend. A single global
// "ownerStyle" prompt washes those differences out and produces
// uncanny-valley replies. This module computes a per-jid fingerprint
// from the owner's PRIOR messages to THAT contact, plus 6-10 verbatim
// samples the LLM can mimic by example.
//
// Wired into the persona prompt so every reply to a known contact is
// anchored on (1) statistical features of the owner's tone with them
// and (2) literal phrasings the owner has actually used.
//
// Reads from the persisted `ownerSentHistory: Map<jid, string[]>` that
// both bridges already maintain — no new storage required.
//
// Computation is cheap (~20-50µs) so we recompute on every reply
// rather than caching. Caching adds complexity without measurable
// savings at our message rate.

import { isBotSelfMessage } from "./bot-self.js";

export interface ContactStyle {
  // Sample count behind the fingerprint. Below 3, the fingerprint is
  // too thin — callers should fall back to global style. Above 50,
  // we have high confidence the patterns are stable.
  sampleCount: number;

  // Average word count per message (your messages to this person).
  avgWords: number;

  // Fraction of messages that contain ANY uppercase letter (excluding
  // proper nouns) — 0.0 = pure lowercase, 1.0 = full sentence case.
  uppercaseRate: number;

  // Fraction with at least one emoji.
  emojiRate: number;

  // Fraction ending in terminal punctuation (. ! ?).
  terminalPunctRate: number;

  // Language mix as detected from message bodies. Sum to ~1.0.
  // We keep this coarse: english | telugu (incl Romanized) | hindi |
  // mixed (multiple in one message).
  langMix: { english: number; telugu: number; hindi: number; mixed: number };

  // Common openers (first 1-2 tokens) used > 1 time, top 5.
  // Examples: ["yeah", "lol", "ela undi", "bro"].
  commonOpeners: string[];

  // Common closers (last 1-2 tokens), top 5.
  // Examples: ["for sure", "lol", "vasta"].
  commonClosers: string[];

  // 6-10 verbatim samples — the LLM mimics by example far better than
  // by rule. We pick recent + medium-length samples to avoid the
  // shortest acks ("ok", "k") and longest paragraphs. These go
  // straight into the system prompt.
  verbatimSamples: string[];
}

// Heuristic language tagger. Romanized Telugu is detected by the
// presence of specific tokens that don't exist in English ("vasta",
// "ela", "cheppu", "matladta", etc.). Same idea for Hindi.
const TELUGU_TOKENS = new Set([
  "vasta","vacchaka","vacchina","cheptha","cheptanu","matladta","matladtham","matladkundam","ela","undi","unnav","chustha","chustanu","ostha","ostunnav","ostunnaru","thelvadu","telidu","leda","kavali","ledu","ledhu","emi","enti","amma","anna","akka","bava","vadina","ammayi","abbayi","cheppu","cheppara","sare","tappakunda","mari","koncham","baagunnav","ekkada","epudu","emaindi","chesthunnav",
]);
const HINDI_TOKENS = new Set([
  "hai","hain","kya","kyun","kaisa","kaise","theek","accha","achha","nahin","nahi","haan","mujhe","tujhe","kar","kuch","abhi","baad","mein","tum","aap","yaar","bhai","bhaiya","kar","raha","rahi","rahe","hoga","hogi","mat",
]);

function detectLang(msg: string): "english" | "telugu" | "hindi" | "mixed" {
  const tokens = msg.toLowerCase().split(/[^a-zA-Zऀ-ॿఀ-౿]+/).filter(Boolean);
  if (tokens.length === 0) return "english";
  let te = 0, hi = 0;
  for (const t of tokens) {
    if (TELUGU_TOKENS.has(t)) te++;
    else if (HINDI_TOKENS.has(t)) hi++;
  }
  // Telugu/Hindi native script characters are dead giveaways.
  const hasDevanagari = /[ऀ-ॿ]/.test(msg);
  const hasTeluguScript = /[ఀ-౿]/.test(msg);
  if (hasTeluguScript) return "telugu";
  if (hasDevanagari) return "hindi";
  const teShare = te / tokens.length;
  const hiShare = hi / tokens.length;
  if (teShare > 0.25 && hiShare > 0.1) return "mixed";
  if (teShare > 0.25) return "telugu";
  if (hiShare > 0.25) return "hindi";
  // Below threshold of native-language tokens → treat as English.
  return "english";
}

// Emoji detection — Unicode emoji range (rough but adequate for our
// fingerprint, which is statistical not exact).
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;

function tokenize(msg: string): string[] {
  return msg
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function topN(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()]
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

// Collapse a message to a comparison key for near-duplicate detection:
// lowercased, punctuation/whitespace/emoji stripped. "ok!", "Ok", "ok 👍"
// and "ok" all collapse to "ok" — so a ring full of acks counts once for
// the statistics instead of dragging avgWords toward 1.
function dedupeKey(msg: string): string {
  return msg
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/**
 * Optional inputs for computeContactStyle. All backward-compatible —
 * callers that pass nothing get the legacy behaviour.
 */
export interface ContactStyleOptions {
  // Epoch-ms timestamp PARALLEL to the `messages` array (timestamps[i]
  // is when messages[i] was sent). When supplied, VERBATIM few-shot
  // samples are restricted to the recency window (A5) so a stale
  // old-register message doesn't skew the voice the LLM mimics.
  // Statistical features (avgWords, lang mix, openers/closers) still use
  // the FULL set for stability. Omit, or pass undefined per-message, to
  // gate gracefully — entries without a timestamp are treated as recent
  // (kept), so we never break on partial data.
  timestamps?: (number | undefined)[];

  // Recency window in days for verbatim samples. Default 180. A message
  // older than `now - windowDays` is excluded from the verbatim pool
  // only — never from the statistics.
  verbatimWindowDays?: number;

  // Reference "now" in epoch-ms (default Date.now()). Injectable for tests.
  now?: number;

  // OPTIONAL: the current inbound text. When supplied, the verbatim few-shot
  // samples are ranked by simple keyword/token overlap with this text so the
  // examples are SHAPED like the message being answered — recency breaks ties
  // and is the fallback when nothing overlaps. Cheap (token-set
  // intersection, no embeddings). Omit for pure-recency (original behavior).
  relevantTo?: string;
}

// Tokenize for relevance overlap: lowercased word tokens ≥3 chars across
// Latin + Telugu letters, dropping high-frequency noise words.
const RELEVANCE_STOPWORDS = new Set([
  "the", "and", "you", "your", "for", "are", "was", "but", "not", "with",
  "this", "that", "have", "has", "can", "will", "would", "what", "when",
  "how", "why", "yeah", "got", "get", "out", "all",
]);
function relevanceTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-zఀ-౿]+/)) {
    if (t.length >= 3 && !RELEVANCE_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

const DEFAULT_VERBATIM_WINDOW_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

export function computeContactStyle(
  messages: string[],
  options: ContactStyleOptions = {},
): ContactStyle {
  // Drop bot-self output (acks, progress nudges, status/digest lines the
  // bridge emitted) — those are NOT the owner's voice and pollute the
  // fingerprint, and then collapse near-identical messages so a ring of
  // "ok"/"k"/"yeah" acks doesn't falsely signal a one-liner register.
  //
  // We carry each surviving message's ORIGINAL index forward so the
  // optional parallel `timestamps` array stays aligned through the filter
  // + dedup passes (used for the A5 verbatim recency window only).
  const dedupSeen = new Set<string>();
  const samples: string[] = [];
  const sampleIdx: number[] = []; // original index into `messages`
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (typeof m !== "string" || m.trim().length === 0 || isBotSelfMessage(m))
      continue;
    const key = dedupeKey(m);
    // Keep empty-key messages (pure-emoji / punctuation) — they're rare
    // and de-duping them all to one bucket would over-collapse.
    if (key && dedupSeen.has(key)) continue;
    if (key) dedupSeen.add(key);
    samples.push(m);
    sampleIdx.push(i);
  }

  // A5: recency cutoff for VERBATIM samples. A surviving sample qualifies
  // when it has no timestamp (gate gracefully) or its timestamp is within
  // the window. Statistics ignore this entirely.
  const timestamps = options.timestamps;
  const windowDays = options.verbatimWindowDays ?? DEFAULT_VERBATIM_WINDOW_DAYS;
  const now = options.now ?? Date.now();
  const cutoff = now - windowDays * DAY_MS;
  const isRecentEnough = (sampleArrIdx: number): boolean => {
    if (!timestamps) return true;
    const ts = timestamps[sampleIdx[sampleArrIdx]];
    if (typeof ts !== "number" || !Number.isFinite(ts)) return true;
    return ts >= cutoff;
  };

  const n = samples.length;
  if (n === 0) {
    return {
      sampleCount: 0,
      avgWords: 0,
      uppercaseRate: 0,
      emojiRate: 0,
      terminalPunctRate: 0,
      langMix: { english: 0, telugu: 0, hindi: 0, mixed: 0 },
      commonOpeners: [],
      commonClosers: [],
      verbatimSamples: [],
    };
  }

  let totalWords = 0;
  let upperHits = 0;
  let emojiHits = 0;
  let punctHits = 0;
  const langCount = { english: 0, telugu: 0, hindi: 0, mixed: 0 };
  const openerCounts = new Map<string, number>();
  const closerCounts = new Map<string, number>();

  for (const m of samples) {
    const tokens = tokenize(m);
    totalWords += tokens.length;

    // Uppercase-rate = how often the owner writes in proper sentence case
    // vs. lowercase. The trap: proper nouns are capitalized in otherwise-
    // lowercase texts ("meeting srinivas at New Jersey", "arin's school"),
    // and code-switched / Telugu messages are correctly lowercase but were
    // mis-flagged by the old `^[A-Z][a-z]+\s+[A-Z][a-z]+` proper-name rule
    // (it fired on ANY two-word capitalized phrase) and the
    // `[A-Z] && !^[A-Z][a-z]` rule (it fired on a mid-string proper noun).
    // Fix: a message counts as "uppercase" only when it's genuinely
    // sentence-cased — its FIRST alphabetic character is a capital — or it
    // contains a SHOUT run of 2+ consecutive caps. A lowercase line with a
    // capitalized proper noun in the middle ("at New Jersey") no longer
    // trips it, since sentence case is decided by the opening letter, not by
    // proper nouns anywhere in the line.
    const firstAlpha = m.match(/[A-Za-z]/);
    if (/[A-Z]{2,}/.test(m)) {
      upperHits++; // SHOUT / acronym run
    } else if (firstAlpha && firstAlpha[0] >= "A" && firstAlpha[0] <= "Z") {
      upperHits++; // sentence-case start
    }

    if (EMOJI_RE.test(m)) emojiHits++;
    if (/[.!?]$/.test(m.trim())) punctHits++;

    langCount[detectLang(m)]++;

    if (tokens.length >= 2) {
      const opener = tokens.slice(0, 2).join(" ").toLowerCase().replace(/[^\w\s]/g, "");
      const opener1 = tokens[0].toLowerCase().replace(/[^\w]/g, "");
      if (opener) openerCounts.set(opener, (openerCounts.get(opener) ?? 0) + 1);
      if (opener1 && opener1 !== opener) openerCounts.set(opener1, (openerCounts.get(opener1) ?? 0) + 1);

      const closer = tokens.slice(-2).join(" ").toLowerCase().replace(/[^\w\s]/g, "");
      const closer1 = tokens[tokens.length - 1].toLowerCase().replace(/[^\w]/g, "");
      if (closer) closerCounts.set(closer, (closerCounts.get(closer) ?? 0) + 1);
      if (closer1 && closer1 !== closer) closerCounts.set(closer1, (closerCounts.get(closer1) ?? 0) + 1);
    }
  }

  // Verbatim samples: prefer messages of 3-15 words (real
  // conversational unit), most-recent first, dedup near-duplicates, and
  // (A5) skip anything older than the recency window so stale phrasings
  // don't get few-shot-mimicked. Statistics above already used the full set.
  // When `relevantTo` is set we collect a wider candidate pool first, then
  // re-rank by keyword overlap so the examples mirror the current inbound;
  // otherwise we stop at the 10 most-recent (original behavior).
  const VERBATIM_CAP = 10;
  const rank = options.relevantTo ? relevanceTokens(options.relevantTo) : null;
  const useRelevance = !!rank && rank.size > 0;
  const candidateCap = useRelevance ? 40 : VERBATIM_CAP;
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (let i = samples.length - 1; i >= 0 && candidates.length < candidateCap; i--) {
    if (!isRecentEnough(i)) continue;
    const m = samples[i].trim();
    const wc = tokenize(m).length;
    if (wc < 3 || wc > 15) continue;
    const key = m.toLowerCase().replace(/\s+/g, " ").slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(m);
  }
  let verbatim = candidates;
  if (useRelevance) {
    const q = rank!;
    verbatim = candidates
      .map((m, idx) => {
        let hits = 0;
        for (const t of relevanceTokens(m)) if (q.has(t)) hits++;
        return { m, idx, score: hits };
      })
      // Highest overlap first; recency (lower idx = newer) breaks ties.
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .slice(0, VERBATIM_CAP)
      .map((x) => x.m);
  }

  return {
    sampleCount: n,
    avgWords: totalWords / n,
    uppercaseRate: upperHits / n,
    emojiRate: emojiHits / n,
    terminalPunctRate: punctHits / n,
    langMix: {
      english: langCount.english / n,
      telugu: langCount.telugu / n,
      hindi: langCount.hindi / n,
      mixed: langCount.mixed / n,
    },
    commonOpeners: topN(openerCounts, 5),
    commonClosers: topN(closerCounts, 5),
    verbatimSamples: verbatim,
  };
}

/**
 * Format the fingerprint as a system-prompt block. Returns empty
 * string when there's too little data for the fingerprint to be
 * meaningful (sample count < 3). Callers should append the result to
 * their existing persona prompt.
 */
export function formatStyleBlock(style: ContactStyle): string {
  if (style.sampleCount < 3) return "";

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines: string[] = [
    "## How you text THIS specific contact (mirror these patterns)",
    `Sample size: ${style.sampleCount} of your past messages to them.`,
    `Average message length: ${style.avgWords.toFixed(1)} words.`,
  ];

  // Tone signals — only mention when they have a strong direction.
  if (style.uppercaseRate < 0.2) {
    lines.push("Tone: mostly lowercase. Don't sentence-case unless they do first.");
  } else if (style.uppercaseRate > 0.7) {
    lines.push("Tone: properly capitalized sentences — keep that.");
  }

  if (style.emojiRate < 0.05) {
    lines.push("Emoji: never (you don't use them with this person).");
  } else if (style.emojiRate > 0.3) {
    lines.push(`Emoji: yes (you use them in ${pct(style.emojiRate)} of messages).`);
  }

  if (style.terminalPunctRate < 0.3) {
    lines.push("Punctuation: rarely end with . ! or ? — same here.");
  }

  // Language mix.
  const lang = style.langMix;
  const dominant = Object.entries(lang).sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] > 0.5) {
    lines.push(`Language: mostly ${dominant[0]} (${pct(dominant[1])}). Match that.`);
  } else if (lang.mixed > 0.3) {
    lines.push("Language: code-switched (Telugu + English in same message). Same style here.");
  }

  if (style.commonOpeners.length > 0) {
    lines.push(`Your common openers with them: ${style.commonOpeners.map((o) => `"${o}"`).join(", ")}.`);
  }
  if (style.commonClosers.length > 0) {
    lines.push(`Your common closers with them: ${style.commonClosers.map((o) => `"${o}"`).join(", ")}.`);
  }

  if (style.verbatimSamples.length > 0) {
    lines.push("");
    lines.push(
      "Verbatim examples of how you wrote to this person (mimic the SHAPE, not the content):",
    );
    for (const s of style.verbatimSamples) {
      lines.push(`  → ${s}`);
    }
  }

  return lines.join("\n");
}

/**
 * Convenience: compute + format in one call. Returns "" when there's
 * not enough data.
 */
export function styleBlockFor(
  messages: string[],
  options?: ContactStyleOptions,
): string {
  return formatStyleBlock(computeContactStyle(messages, options));
}
