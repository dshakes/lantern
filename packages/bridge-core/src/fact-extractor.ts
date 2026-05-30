// Proactive fact extractor.
//
// On every inbound message from a contact (and every owner-sent
// outbound to that contact), scan for high-confidence facts WORTH
// remembering and emit them. The bridge persists each one via the
// existing whatsapp_contact_facts table (source="auto-extract") so
// the persona prompt's factsBlock surfaces them on future replies.
//
// Pattern-based — zero LLM cost per message. Conservative: only emit
// when the pattern is unambiguous. Better to miss a fact than to
// remember a wrong one (a wrong "she's vegetarian" causes the bot to
// say weird things to her for months).
//
// Per-fact source attribution lets the dashboard distinguish:
//   - "owner-remember" (explicit `remember X`)
//   - "auto-extract"   (this module)
//   - "user-edit"      (dashboard manually added)

export interface ExtractedFact {
  /** The fact text, e.g. "her birthday is june 3", "works at stripe". */
  content: string;
  /** Why this was extracted — for debugging + dashboard transparency. */
  pattern: string;
  /** Speaker perspective: "self" (sender is talking about themselves) or
   *  "other" (sender is talking about a third party). Determines which
   *  contact the fact attaches to. */
  perspective: "self" | "other";
  /** Confidence 0..1. We only persist >=0.7. */
  confidence: number;
}

interface PatternRule {
  /** Description for telemetry. */
  name: string;
  /** Regex with at least one capture group for the fact value. Run
   *  against the LOWERCASED, normalized text. */
  re: RegExp;
  /** Function that takes the regex match and the original (cased) text,
   *  returns the fact + perspective. Allows complex shaping. */
  build: (m: RegExpMatchArray, originalText: string) => Omit<ExtractedFact, "pattern" | "confidence"> | null;
  /** Confidence floor for this pattern (0..1). */
  confidence: number;
}

const RULES: PatternRule[] = [
  // ── BIRTHDAYS ────────────────────────────────────────────────────────
  {
    name: "self_birthday",
    re: /\bmy birthday('s| is)\s+(?:on\s+)?([a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i,
    build: (m) => ({ content: `birthday: ${m[2].trim()}`, perspective: "self" }),
    confidence: 0.9,
  },
  {
    name: "self_dob",
    re: /\b(?:i was )?born (?:on |in )?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|[a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)/i,
    build: (m) => ({ content: `born: ${m[1].trim()}`, perspective: "self" }),
    confidence: 0.85,
  },

  // ── WORKPLACE / ROLE ─────────────────────────────────────────────────
  {
    name: "self_workplace",
    re: /\bi (?:work at|am at|joined|started at)\s+([A-Z][\w&. ]{1,40}?)(?:\s+(?:as|in|on)\b|[.,!?\n]|$)/i,
    build: (m) => ({ content: `works at ${m[1].trim()}`, perspective: "self" }),
    confidence: 0.8,
  },
  {
    name: "self_role",
    re: /\bi(?:'m| am)\s+(?:an?\s+)?(software engineer|engineer|designer|founder|ceo|cto|cfo|coo|pm|product manager|manager|director|vp|head of \w+|lawyer|doctor|dentist|teacher|professor|consultant|investor|writer|artist|architect|nurse|chef|pilot|student|intern)\b/i,
    build: (m) => ({ content: `role: ${m[1].toLowerCase()}`, perspective: "self" }),
    confidence: 0.85,
  },

  // ── FAMILY (third-person + first-person) ─────────────────────────────
  {
    name: "self_spouse",
    re: /\b(?:my (?:wife|husband|spouse|partner|girlfriend|boyfriend|fiance(?:e)?)) (?:is |'s )([A-Z][\w' -]{1,30})/i,
    build: (m) => ({ content: `spouse: ${m[1].trim()}`, perspective: "self" }),
    confidence: 0.9,
  },
  {
    name: "self_kid",
    re: /\bmy (son|daughter|kid|baby|child) (?:is |'s |name is )([A-Z][\w' -]{1,30})/i,
    build: (m) => ({ content: `${m[1]}: ${m[2].trim()}`, perspective: "self" }),
    confidence: 0.9,
  },
  {
    name: "self_kids_count",
    re: /\bi have (\d+|one|two|three|four|five)\s+(kids?|children|sons?|daughters?)\b/i,
    build: (m) => ({ content: `has ${m[1]} ${m[2]}`, perspective: "self" }),
    confidence: 0.85,
  },

  // ── DIET / ALLERGIES / PREFERENCES ───────────────────────────────────
  {
    name: "self_vegetarian",
    re: /\bi(?:'m| am) (?:a )?(vegan|vegetarian|pescatarian|gluten\s*free|lactose intolerant)\b/i,
    build: (m) => ({ content: `dietary: ${m[1].toLowerCase()}`, perspective: "self" }),
    confidence: 0.9,
  },
  {
    name: "self_allergy",
    re: /\bi(?:'m| am) allergic to ([a-z][\w, ]{1,40})/i,
    build: (m) => ({ content: `allergic to: ${m[1].trim()}`, perspective: "self" }),
    confidence: 0.9,
  },

  // ── LOCATION ─────────────────────────────────────────────────────────
  {
    name: "self_location",
    re: /\bi(?:'m| am) (?:in|at|living in|based in|moved to) ([A-Z][\w' -]{2,40}?)(?:[.,!?\n]|$)/i,
    build: (m) => ({ content: `location: ${m[1].trim()}`, perspective: "self" }),
    confidence: 0.7,
  },
  {
    name: "self_just_moved",
    re: /\b(?:i|we) (?:just )?moved (?:to|from) ([A-Z][\w' -]{2,40}?)(?:[.,!?\n]|$)/i,
    build: (m) => ({ content: `recently moved to/from ${m[1].trim()}`, perspective: "self" }),
    confidence: 0.85,
  },

  // ── LIFE EVENTS (high-signal updates worth flagging) ─────────────────
  {
    name: "self_engaged",
    re: /\b(?:i|we) (?:just )?got engaged\b/i,
    build: () => ({ content: "recently got engaged", perspective: "self" }),
    confidence: 0.95,
  },
  {
    name: "self_married",
    re: /\b(?:i|we) (?:just )?got married\b/i,
    build: () => ({ content: "recently got married", perspective: "self" }),
    confidence: 0.95,
  },
  {
    name: "self_new_baby",
    re: /\b(?:i|we) (?:just )?had a (baby|boy|girl|son|daughter)\b/i,
    build: (m) => ({ content: `recently had a ${m[1].toLowerCase()}`, perspective: "self" }),
    confidence: 0.95,
  },
  {
    name: "self_new_job",
    re: /\b(?:i|we) (?:just )?(?:got|started|joined) (?:a new job|a new role at|at) ([A-Z][\w& ]{1,40}?)(?:\s+(?:as|in|on)\b|[.,!?\n]|$)/i,
    build: (m) => ({ content: `recently joined ${m[1].trim()}`, perspective: "self" }),
    confidence: 0.85,
  },

  // ── PETS ─────────────────────────────────────────────────────────────
  {
    name: "self_pet",
    re: /\bmy (dog|cat|puppy|kitten) (?:is |'s |name is |named )([A-Z][\w' -]{1,30})/i,
    build: (m) => ({ content: `${m[1]}: ${m[2].trim()}`, perspective: "self" }),
    confidence: 0.9,
  },
];

/**
 * Run all rules against the text. Returns 0+ extracted facts.
 * Conservative: only returns facts with confidence >= 0.7.
 */
export function extractAutoFacts(text: string, opts: { senderName?: string } = {}): ExtractedFact[] {
  const t = (text || "").trim();
  if (t.length < 5 || t.length > 2000) return [];
  const out: ExtractedFact[] = [];
  const seen = new Set<string>(); // dedupe within this single message

  for (const rule of RULES) {
    const m = t.match(rule.re);
    if (!m) continue;
    const built = rule.build(m, text);
    if (!built) continue;
    const content = built.content.trim();
    if (!content) continue;
    if (content.length > 200) continue;
    // Dedupe by content (case-insensitive).
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      content,
      pattern: rule.name,
      perspective: built.perspective,
      confidence: rule.confidence,
    });
  }

  // Cap output per message — if a single message somehow trips 5+
  // rules, something weird is happening, take only the top 3 by
  // confidence.
  out.sort((a, b) => b.confidence - a.confidence);
  return out.slice(0, 3);
}

/**
 * Check whether two fact contents are similar enough that the new one
 * should be considered a duplicate. Used by the bridge before calling
 * addFact to avoid spamming the fact store with near-identical entries
 * ("works at stripe" vs "works at Stripe Inc").
 */
export function factsAreSimilar(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // One contains the other, length ratio reasonable.
  if (na.length > 10 && nb.length > 10) {
    if (na.includes(nb) || nb.includes(na)) {
      const ratio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
      if (ratio > 0.6) return true;
    }
  }
  return false;
}
