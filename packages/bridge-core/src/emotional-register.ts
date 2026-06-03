// Emotional-register detection — read the contact's affect before replying.
//
// A contact who texts "really rough day honestly" at 2am should get a
// warmer, shorter, no-scheduling reply. An irritated contact ("still not
// fixed?!") should get a brief acknowledgment FIRST, not a wall of
// explanation. A contact bursting with "GOT THE JOB!!! 🎉" should be met
// with matching energy, not a flat "ok".
//
// This module is the DETECTOR. It is a PURE function over the inbound
// text — deterministic lexicon + punctuation + pattern signals, NO LLM on
// the hot path. The persona-modulation side (natural.ts) consumes the
// detected register and appends a compact prompt addendum. Detection and
// modulation are split so the detector is trivially unit-testable and the
// bridge can log / gate on the register without rebuilding the prompt.
//
// DESIGN INVARIANTS (read before extending):
//   - PURE + DETERMINISTIC. No I/O, no clock, no LLM. Same text → same
//     verdict. Fully replay-safe + unit-testable.
//   - CONSERVATIVE. When signals are weak or mixed, return "neutral" with
//     low confidence rather than guessing. A wrong "distress" read that
//     suppresses scheduling on a routine message is a worse failure than
//     a missed faint signal.
//   - ADDITIVE. The register is a HINT layered on top of the persona; it
//     never overrides the safety / voice / identity rules in natural.ts.

/** The coarse emotional register of an inbound message. */
export type EmotionalRegister =
  | "distress" // sad / scared / hurting / asking for help
  | "frustration" // annoyed / irritated / something still broken
  | "excitement" // celebrating / great news / high energy
  | "neutral"; // no strong affect signal

export interface EmotionalRegisterVerdict {
  register: EmotionalRegister;
  /** 0..1 — how strong the signal is. neutral is always 0. The bridge can
   *  gate modulation on a floor (e.g. only modulate at >= 0.4). */
  confidence: number;
  /** The concrete signals that fired, for logging + offline tuning. */
  signals: string[];
}

// ── Lexicons ──────────────────────────────────────────────────────────
// Each entry is a whole-word (or phrase) trigger. Phrases are matched as
// substrings of the lowercased text; single words are \b-guarded so
// "sadly" doesn't fire on "sad"-prefix-only and "help" doesn't fire inside
// "helped". Weights let strong cues ("passed away", "hospital") dominate
// over weak ones ("worried").

interface Lexeme {
  /** Lowercased phrase (multi-word) or single word. */
  term: string;
  /** Relative strength of this cue toward its register. */
  weight: number;
}

const DISTRESS_LEXEMES: Lexeme[] = [
  { term: "passed away", weight: 3 },
  { term: "passed", weight: 1.5 },
  { term: "died", weight: 3 },
  { term: "death", weight: 2.5 },
  { term: "funeral", weight: 2.5 },
  { term: "hospital", weight: 2.5 },
  { term: "emergency", weight: 2.5 },
  { term: "icu", weight: 2.5 },
  { term: "diagnosed", weight: 2 },
  { term: "crying", weight: 2.5 },
  { term: "cried", weight: 2 },
  { term: "in tears", weight: 2.5 },
  { term: "breaking down", weight: 2.5 },
  { term: "broke down", weight: 2.5 },
  { term: "scared", weight: 2 },
  { term: "terrified", weight: 2.5 },
  { term: "worried", weight: 1.5 },
  { term: "anxious", weight: 1.5 },
  { term: "depressed", weight: 2.5 },
  { term: "heartbroken", weight: 2.5 },
  { term: "devastated", weight: 2.5 },
  { term: "overwhelmed", weight: 2 },
  { term: "struggling", weight: 2 },
  { term: "rough day", weight: 2 },
  { term: "rough night", weight: 2 },
  { term: "rough week", weight: 2 },
  { term: "rough time", weight: 2 },
  { term: "hard day", weight: 1.5 },
  { term: "really rough", weight: 2 },
  { term: "so hard", weight: 1.5 },
  { term: "miss her", weight: 1.5 },
  { term: "miss him", weight: 1.5 },
  { term: "lost my", weight: 2 },
  { term: "i'm sorry", weight: 1 },
  { term: "im sorry", weight: 1 },
  { term: "so sorry", weight: 1.5 },
  { term: "help me", weight: 2 },
  { term: "need help", weight: 2 },
  { term: "please help", weight: 2.5 },
  { term: "i can't anymore", weight: 3 },
  { term: "cant cope", weight: 2.5 },
  { term: "can't cope", weight: 2.5 },
  { term: "falling apart", weight: 2.5 },
  { term: "not okay", weight: 1.5 },
  { term: "not ok", weight: 1.5 },
  { term: "sad", weight: 1.5 },
  { term: "miserable", weight: 2 },
  { term: "hurting", weight: 2 },
  { term: "alone", weight: 1 },
];

const FRUSTRATION_LEXEMES: Lexeme[] = [
  { term: "annoyed", weight: 2 },
  { term: "annoying", weight: 2 },
  { term: "irritated", weight: 2 },
  { term: "irritating", weight: 2 },
  { term: "frustrated", weight: 2.5 },
  { term: "frustrating", weight: 2.5 },
  { term: "ridiculous", weight: 2.5 },
  { term: "unacceptable", weight: 2.5 },
  { term: "fed up", weight: 2.5 },
  { term: "sick of", weight: 2 },
  { term: "tired of", weight: 2 },
  { term: "still not", weight: 2 },
  { term: "still haven't", weight: 2 },
  { term: "still havent", weight: 2 },
  { term: "still waiting", weight: 2 },
  { term: "yet again", weight: 2 },
  { term: "again?", weight: 1.5 },
  { term: "seriously?", weight: 2 },
  { term: "are you kidding", weight: 2.5 },
  { term: "what the", weight: 1.5 },
  { term: "wtf", weight: 2.5 },
  { term: "come on", weight: 1.5 },
  { term: "useless", weight: 2 },
  { term: "broken", weight: 1 },
  { term: "doesn't work", weight: 1.5 },
  { term: "doesnt work", weight: 1.5 },
  { term: "not working", weight: 1.5 },
  { term: "supposed to", weight: 1 },
  { term: "told you", weight: 1.5 },
  { term: "how many times", weight: 2 },
  { term: "no response", weight: 1.5 },
  { term: "ignoring me", weight: 2 },
  { term: "waste of time", weight: 2.5 },
];

const EXCITEMENT_LEXEMES: Lexeme[] = [
  { term: "great news", weight: 2.5 },
  { term: "amazing news", weight: 2.5 },
  { term: "guess what", weight: 2 },
  { term: "got the job", weight: 3 },
  { term: "got the offer", weight: 3 },
  { term: "got accepted", weight: 2.5 },
  { term: "got in", weight: 1.5 },
  { term: "we won", weight: 2.5 },
  { term: "i won", weight: 2.5 },
  { term: "passed the", weight: 2 },
  { term: "engaged", weight: 2.5 },
  { term: "getting married", weight: 2.5 },
  { term: "we're pregnant", weight: 3 },
  { term: "expecting", weight: 1.5 },
  { term: "promoted", weight: 2.5 },
  { term: "promotion", weight: 2 },
  { term: "so excited", weight: 2.5 },
  { term: "so happy", weight: 2 },
  { term: "can't wait", weight: 1.5 },
  { term: "cant wait", weight: 1.5 },
  { term: "thrilled", weight: 2.5 },
  { term: "stoked", weight: 2 },
  { term: "pumped", weight: 2 },
  { term: "congrats", weight: 1.5 },
  { term: "congratulations", weight: 1.5 },
  { term: "finally happened", weight: 2 },
  { term: "best day", weight: 2 },
  { term: "yay", weight: 1.5 },
  { term: "woohoo", weight: 2 },
  { term: "let's go", weight: 1.5 },
  { term: "lets go", weight: 1.5 },
];

// Celebratory emoji — strong excitement cue when present.
const EXCITEMENT_EMOJI = ["🎉", "🥳", "🎊", "🙌", "🤩", "🥂", "🍾", "💍", "🎂"];
// Distress emoji — sadness / crying.
const DISTRESS_EMOJI = ["😢", "😭", "💔", "😞", "😔", "😟", "😥", "😰", "😩", "🥺"];
// Frustration emoji — anger.
const FRUSTRATION_EMOJI = ["😡", "😠", "🤬", "😤", "🙄"];

// Confidence saturates once accumulated weight reaches this — keeps a
// single very strong cue ("passed away") from pinning 1.0 while still
// letting a couple of strong cues read as high-confidence.
const CONFIDENCE_SATURATION = 5;

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// Whole-word presence for a single alpha token (\b-guarded). Multi-word
// phrases and phrases containing punctuation fall back to substring match.
function matches(lowered: string, term: string): boolean {
  if (/^[a-z]+$/.test(term)) {
    return new RegExp(`\\b${term}\\b`).test(lowered);
  }
  return lowered.includes(term);
}

function scoreLexemes(lowered: string, lexemes: Lexeme[]): { weight: number; hits: string[] } {
  let weight = 0;
  const hits: string[] = [];
  for (const { term, weight: w } of lexemes) {
    if (matches(lowered, term)) {
      weight += w;
      hits.push(term);
    }
  }
  return { weight, hits };
}

function emojiHits(text: string, emojis: string[]): { weight: number; hits: string[] } {
  let weight = 0;
  const hits: string[] = [];
  for (const e of emojis) {
    const n = countOccurrences(text, e);
    if (n > 0) {
      // Repeated emoji ("🎉🎉🎉") reads as stronger; cap the per-emoji
      // contribution so it can't dominate alone.
      weight += Math.min(n, 3) * 1.5;
      hits.push(e);
    }
  }
  return { weight, hits };
}

// ── Punctuation / casing pattern signals ──────────────────────────────

/** Count of runs of "!!" or more (multi-exclamation) — excitement OR, when
 *  paired with "?", frustration. */
function multiBangRuns(text: string): number {
  return (text.match(/!{2,}/g) || []).length;
}

/** "?!" or "!?" interrobang runs — a frustration / disbelief tell. */
function interrobangRuns(text: string): number {
  return (text.match(/[?!]*[?][!]+|[?!]*[!][?]+/g) || []).filter((m) => /[?]/.test(m) && /[!]/.test(m)).length;
}

/** ALLCAPS angry words: a run of 3+ uppercase letters that isn't a known
 *  acronym. Returns the number of such words (signals shouting). */
function allcapsWords(text: string): number {
  const words = text.split(/\s+/);
  let n = 0;
  for (const w of words) {
    const letters = w.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 3 && letters === letters.toUpperCase() && /[A-Z]{3,}/.test(letters)) {
      n++;
    }
  }
  return n;
}

/**
 * Detect the emotional register of an inbound message.
 *
 * PURE + DETERMINISTIC. Combines lexicon hits, emoji, and punctuation /
 * casing patterns into a per-register weight, then returns the dominant
 * register with a normalized confidence. Returns "neutral" (confidence 0)
 * when no register clears a minimum signal floor — the conservative
 * default, since over-reading affect is the worse failure.
 */
export function detectEmotionalRegister(text: string): EmotionalRegisterVerdict {
  const raw = (text || "").trim();
  if (!raw) return { register: "neutral", confidence: 0, signals: [] };

  const lowered = raw.toLowerCase();

  const distress = scoreLexemes(lowered, DISTRESS_LEXEMES);
  const frustration = scoreLexemes(lowered, FRUSTRATION_LEXEMES);
  const excitement = scoreLexemes(lowered, EXCITEMENT_LEXEMES);

  const distressEmoji = emojiHits(raw, DISTRESS_EMOJI);
  const frustrationEmoji = emojiHits(raw, FRUSTRATION_EMOJI);
  const excitementEmoji = emojiHits(raw, EXCITEMENT_EMOJI);

  let distressW = distress.weight + distressEmoji.weight;
  let frustrationW = frustration.weight + frustrationEmoji.weight;
  let excitementW = excitement.weight + excitementEmoji.weight;

  const distressSignals = [...distress.hits, ...distressEmoji.hits];
  const frustrationSignals = [...frustration.hits, ...frustrationEmoji.hits];
  const excitementSignals = [...excitement.hits, ...excitementEmoji.hits];

  // Punctuation / casing patterns.
  const bangs = multiBangRuns(raw);
  const interrobangs = interrobangRuns(raw);
  const caps = allcapsWords(raw);

  if (interrobangs > 0) {
    // "?!" is the classic frustrated-disbelief tell.
    frustrationW += interrobangs * 1.5;
    frustrationSignals.push("interrobang(?!)");
  }
  if (caps > 0) {
    // Shouting attaches to whichever of distress/frustration already has
    // lexical signal; absent that, it leans frustration (anger shout).
    if (distressW > frustrationW && distressW > 0) {
      distressW += Math.min(caps, 3) * 1;
      distressSignals.push(`allcaps(${caps})`);
    } else {
      frustrationW += Math.min(caps, 3) * 1.5;
      frustrationSignals.push(`allcaps(${caps})`);
    }
  }
  if (bangs > 0 && interrobangs === 0) {
    // Pure "!!" with no "?" leans excitement — but only credit it toward
    // excitement when there's no dominant distress/frustration lexical
    // signal (otherwise "still not fixed!!" shouldn't read as excited).
    if (excitementW >= distressW && excitementW >= frustrationW) {
      excitementW += Math.min(bangs, 3) * 1.5;
      excitementSignals.push(`multi-exclaim(${bangs})`);
    }
  }

  // Pick the dominant register.
  const candidates: Array<{ register: EmotionalRegister; weight: number; signals: string[] }> = [
    { register: "distress", weight: distressW, signals: distressSignals },
    { register: "frustration", weight: frustrationW, signals: frustrationSignals },
    { register: "excitement", weight: excitementW, signals: excitementSignals },
  ];
  candidates.sort((a, b) => b.weight - a.weight);
  const top = candidates[0];
  const runnerUp = candidates[1];

  // Minimum signal floor — below this, treat as neutral. A lone weak cue
  // ("worried", weight 1.5) shouldn't flip the whole reply tone.
  const FLOOR = 1.5;
  if (top.weight < FLOOR) {
    return { register: "neutral", confidence: 0, signals: [] };
  }

  // Ambiguity guard: if the top two registers are within a hair of each
  // other AND both meaningful, the message is mixed — don't over-commit.
  // We keep the top register but damp confidence; the modulation addendum
  // is intentionally gentle so a borderline read does little harm.
  const margin = top.weight - runnerUp.weight;
  let confidence = Math.min(1, top.weight / CONFIDENCE_SATURATION);
  if (runnerUp.weight >= FLOOR && margin < 1) {
    confidence *= 0.6;
  }
  confidence = Math.round(confidence * 100) / 100;

  return {
    register: top.register,
    confidence,
    // De-dup + stable order for clean logging.
    signals: Array.from(new Set(top.signals)),
  };
}

// ── Persona modulation addendum ───────────────────────────────────────
// The compact prompt block natural.ts appends when a non-neutral register
// is detected. Exported so the bridge / tests can reason about it directly.
// It is a HINT layered on top of the persona — it never restates or
// overrides the safety / identity / voice rules.

/**
 * Build the emotional-register persona addendum for a given register.
 * Returns "" for "neutral" (no addendum). Pure + deterministic.
 *
 * Each register tunes the SAME underlying voice — it never grants new
 * powers or relaxes a guardrail. Distress in particular SUPPRESSES
 * scheduling/task talk for this turn (lead with care, not logistics).
 */
export function emotionalRegisterAddendum(register: EmotionalRegister): string {
  switch (register) {
    case "distress":
      return [
        `EMOTIONAL READ — this contact sounds like they're having a hard time (distress).`,
        `- Lead with warmth + empathy. A short, human "ugh I'm sorry" / "that sounds really hard" lands better than anything practical.`,
        `- Keep it SHORTER than usual — one line, maybe two. Presence over advice.`,
        `- Do NOT pivot to scheduling, tasks, logistics, or "want me to..." offers this turn. No fixing, no agenda. Just be there.`,
        `- Don't be saccharine or therapized ("I hear you", "holding space"). Talk like a real friend who cares.`,
      ].join("\n");
    case "frustration":
      return [
        `EMOTIONAL READ — this contact sounds irritated / frustrated.`,
        `- ACKNOWLEDGE the frustration FIRST, briefly ("yeah that's annoying", "ugh sorry about that") before anything else.`,
        `- Don't over-explain or get defensive. A long justification reads as dismissive — keep it tight.`,
        `- If something's genuinely your/owner's miss, a short honest "my bad" beats a paragraph.`,
      ].join("\n");
    case "excitement":
      return [
        `EMOTIONAL READ — this contact is excited / sharing good news.`,
        `- MATCH their energy. A flat "ok" or "nice" deflates them — react like you actually care ("yooo that's huge", "no way congrats!!").`,
        `- It's fine to use an exclamation or an emoji here even if you usually keep it dry — this is the moment for it.`,
        `- Keep it short and genuine; don't turn their good news into a logistics conversation.`,
      ].join("\n");
    case "neutral":
    default:
      return "";
  }
}
