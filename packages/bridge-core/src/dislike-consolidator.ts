// Dislike → general style-lesson consolidator (the learning flywheel).
//
// dislike-memory.ts records every 👎'd reply and recalls a CONTACT's own
// rejections back into THAT contact's prompt. Useful, but narrow: a lesson
// learned with one person never transfers. This module closes the loop.
//
// It mines the full dislike log for patterns that RECUR across contacts
// (the owner keeps rejecting exclamation marks; the owner keeps rejecting
// long-winded replies) and distills them into durable GENERAL style
// lessons. Those lessons are:
//   1. written into a managed "## Style lessons" section of the owner
//      profile (idempotent, deduped) so they apply to EVERY future reply,
//   2. injected into the persona prompt for every contact.
//
// Two passes:
//   A) DETERMINISTIC heuristics (always on, cheap, no LLM). Counts how
//      often common bad-shapes appear in 👎'd replies and emits a lesson
//      once a shape clears a frequency + support threshold. Covers the
//      bread-and-butter patterns (punctuation, length, openers, emoji).
//   B) OPTIONAL LLM clustering (flag-guarded by LANTERN_DISLIKE_LLM_CLUSTER
//      + an injected llmCall) for fuzzier patterns the heuristics miss.
//
// PRIVACY: raw dislike entries hold inbound text + bot replies (PII) and
// stay in the 0600 JSONL. ONLY distilled, non-PII style lessons (short
// imperative rules with no names/quotes) leave this module.

import type { Logger } from "pino";
import type { DislikeEntry, DislikeMemory } from "./dislike-memory.js";

/** A distilled, non-PII style rule mined from dislike history. */
export interface StyleLesson {
  /** Stable id so the profile writer can dedup deterministically. */
  id: string;
  /** Imperative rule, e.g. "Avoid exclamation marks — the owner rejects them." */
  text: string;
  /** How many 👎'd replies support this lesson. */
  support: number;
}

export interface ConsolidateOptions {
  /** Minimum distinct 👎'd replies that must exhibit a pattern before it
   *  graduates to a lesson. Keeps one-off noise out of the profile. */
  minSupport?: number;
  /** Minimum fraction (0..1) of 👎'd replies exhibiting the pattern. */
  minFraction?: number;
  /** Optional LLM caller for the fuzzy clustering pass. When absent OR
   *  the env flag is off, only the deterministic pass runs. */
  llmCall?: (prompt: string) => Promise<string>;
  logger?: Logger;
}

const DEFAULT_MIN_SUPPORT = 3;
const DEFAULT_MIN_FRACTION = 0.34;

// Deterministic shape detectors. Each inspects a 👎'd reply and, when the
// shape is present, contributes to that lesson's support count. Lessons
// are non-PII imperative rules — no names, no quotes from the messages.
interface ShapeDetector {
  id: string;
  lesson: string;
  test: (badReply: string) => boolean;
}

const SHAPE_DETECTORS: ShapeDetector[] = [
  {
    id: "no-exclamation",
    lesson: "Avoid exclamation marks — the owner consistently rejects them. Use a plain period.",
    test: (r) => /!/.test(r),
  },
  {
    id: "prefer-shorter",
    lesson: "Keep replies short — the owner rejects long, multi-sentence answers. Default to one line.",
    test: (r) => r.trim().length > 160 || (r.match(/[.!?]\s/g)?.length ?? 0) >= 3,
  },
  {
    id: "no-emoji",
    lesson: "Don't add emoji — the owner rejects them in replies. Plain text only.",
    // Emoji ranges: emoticons, symbols, transport, supplemental, dingbats.
    test: (r) =>
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u.test(r),
  },
  {
    id: "no-filler-opener",
    lesson:
      "Skip filler openers (\"Sure thing\", \"Of course\", \"Absolutely\", \"No problem\") — the owner rejects them. Start with the substance.",
    test: (r) =>
      /^\s*(?:sure\s+thing|of\s+course|absolutely|no\s+problem|happy\s+to|certainly|great\s+question|i'?d\s+be\s+happy)\b/i.test(
        r,
      ),
  },
  {
    id: "no-hedging",
    lesson:
      "Don't hedge (\"I think\", \"maybe\", \"I'm not sure but\") — the owner rejects wishy-washy replies. Be direct.",
    test: (r) => /\b(?:i\s+think|i\s+believe|maybe|perhaps|i'?m\s+not\s+sure|it\s+seems)\b/i.test(r),
  },
  {
    id: "no-overformal",
    lesson:
      "Don't be over-formal (\"Dear\", \"Kind regards\", \"Please be advised\") — the owner rejects stiff phrasing. Keep it casual.",
    test: (r) =>
      /\b(?:dear\b|kind\s+regards|best\s+regards|please\s+be\s+advised|i\s+hope\s+this\s+(?:message|email)\s+finds)\b/i.test(
        r,
      ),
  },
];

/**
 * Mine the dislike log for general style lessons. Deterministic pass
 * always runs; the LLM pass runs only when enabled + wired. Returns the
 * distilled lessons that cleared the support/fraction thresholds, sorted
 * by support desc.
 */
export async function consolidateDislikes(
  memory: Pick<DislikeMemory, "all">,
  opts: ConsolidateOptions = {},
): Promise<StyleLesson[]> {
  const log = opts.logger?.child({ component: "dislike-consolidator" });
  const minSupport = opts.minSupport ?? DEFAULT_MIN_SUPPORT;
  const minFraction = opts.minFraction ?? DEFAULT_MIN_FRACTION;

  const entries = await memory.all();
  if (entries.length === 0) return [];

  // Deterministic pass: count shape support across distinct bad replies.
  const total = entries.length;
  const lessons = new Map<string, StyleLesson>();
  for (const det of SHAPE_DETECTORS) {
    let support = 0;
    for (const e of entries) {
      if (det.test(e.badReply || "")) support++;
    }
    if (support >= minSupport && support / total >= minFraction) {
      lessons.set(det.id, { id: det.id, text: det.lesson, support });
    }
  }

  // Optional LLM clustering pass — only when explicitly enabled AND a
  // caller is wired. Catches fuzzy recurring patterns the regexes miss.
  if (opts.llmCall && process.env.LANTERN_DISLIKE_LLM_CLUSTER === "1") {
    try {
      const llmLessons = await llmClusterPass(entries, opts.llmCall, minSupport);
      for (const l of llmLessons) {
        // Don't let the LLM clobber a higher-support deterministic lesson.
        const existing = lessons.get(l.id);
        if (!existing || l.support > existing.support) lessons.set(l.id, l);
      }
    } catch (err) {
      log?.warn({ err }, "llm clustering pass failed; using deterministic lessons only");
    }
  }

  const out = Array.from(lessons.values()).sort((a, b) => b.support - a.support);
  log?.info({ lessons: out.map((l) => l.id), total }, "dislike consolidation");
  return out;
}

const LLM_CLUSTER_PROMPT = [
  "You analyze a list of reply DRAFTS that an owner REJECTED (thumbs-down)",
  "from their messaging assistant. Find GENERAL writing patterns the owner",
  "dislikes that recur across MULTIPLE rejected drafts.",
  "",
  "Return JSON: {\"lessons\": [{\"id\": \"kebab-id\", \"text\": \"imperative rule\", \"support\": N}]}",
  "",
  "STRICT RULES:",
  "1. Each `text` is ONE imperative style rule, max 120 chars. No names,",
  "   no quotes from the messages, no PII — only a general writing rule.",
  "   GOOD: \"Avoid corporate jargon — the owner prefers plain words.\"",
  "   BAD:  \"Don't tell Raju you'll call at 5pm.\" (specific / PII)",
  "2. `support` = how many of the drafts below exhibit the pattern.",
  "3. ONLY return a lesson if 3+ drafts share the pattern. Else omit.",
  "4. Return {\"lessons\": []} if nothing recurs.",
  "",
  "Rejected drafts:",
].join("\n");

async function llmClusterPass(
  entries: DislikeEntry[],
  llmCall: (prompt: string) => Promise<string>,
  minSupport: number,
): Promise<StyleLesson[]> {
  // Send only the bad replies (the rejected shapes). Cap to keep prompt
  // tight; inbound text is NOT sent (less PII surface, and the shape of
  // the reply is what matters).
  const sample = entries.slice(0, 40).map((e, i) => `${i + 1}. ${flat(e.badReply, 200)}`);
  const raw = await llmCall(`${LLM_CLUSTER_PROMPT}\n${sample.join("\n")}\n\nJSON:`);
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: { lessons?: Array<{ id?: string; text?: string; support?: number }> };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  const out: StyleLesson[] = [];
  for (const l of parsed.lessons ?? []) {
    const text = String(l?.text ?? "").trim();
    const support = Number(l?.support ?? 0);
    if (!text || text.length > 160 || support < minSupport) continue;
    const id = String(l?.id ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    out.push({ id: id || `llm-${out.length}`, text, support });
  }
  return out;
}

function flat(s: string, n: number): string {
  const f = (s || "").replace(/\s+/g, " ").trim();
  return f.length > n ? f.slice(0, n) + "…" : f;
}

/**
 * Format consolidated lessons as a compact persona-prompt block for
 * injection into EVERY reply. Empty string when there are no lessons.
 */
export function formatStyleLessonsBlock(lessons: StyleLesson[], max = 6): string {
  const top = lessons.slice(0, max);
  if (top.length === 0) return "";
  const lines = [
    "## Global style lessons (learned from the owner's 👎 history — apply to EVERY reply)",
    "The owner has repeatedly rejected replies that break these rules. Follow them:",
  ];
  for (const l of top) lines.push(`- ${l.text}`);
  return lines.join("\n");
}
