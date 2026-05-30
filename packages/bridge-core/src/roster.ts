// Roster-query detection + pre-fetch helpers.
//
// When the owner asks something like "who came on my Japan trip" /
// "Monna japan ki evaru poindru" / "kaun kaun gaye the", the right
// answer requires CROSS-SOURCE synthesis: WhatsApp group rosters,
// iMessage groups, personal-docs (insurance, visa), Gmail. The
// LLM agentic-tool path is too lazy on its own — it tends to call
// search_personal_files, find an insurance policy with 3 names, and
// stop. We fix that by PRE-FETCHING the relevant data before the
// LLM gets the prompt, so it sees the full roster up-front and just
// synthesizes.
//
// Generic by design: works for ANY trip/event/group name, in any
// language we can detect the "who" question-word for.

export interface RosterQuerySignal {
  /** Did the query look like a "who came / who's in" question? */
  isRoster: boolean;
  /** Candidate proper nouns / topic tokens extracted from the query
   *  (lowercase). Use these to match against group names. e.g. for
   *  "Monna japan ki evaru poindru" → ["monna", "japan"]; the bridge
   *  matches groups whose name CONTAINS any of these. */
  tokens: string[];
  /** Human-readable detection reason — logged for debuggability. */
  reason: string;
}

// Question-word patterns per language. Anchored with word boundaries
// so partial matches inside other words don't false-positive.
const WHO_PATTERNS: Array<{ lang: string; re: RegExp }> = [
  // English: who / who all / who came / who's / whom
  { lang: "english", re: /\b(who|whom|who['']?ll|who['']?s|who all|who came|whose|which (?:people|folks|guys))\b/i },
  // Telugu (Romanized + native): evaru / evvaru / enta mandi / ento mandi / ఎవరు / ఎవ్వరు
  { lang: "telugu",  re: /\b(evaru?|evvar[ui]|enta\s+mandi|ento\s+mandi)\b/i },
  { lang: "telugu",  re: /[ఎ][వ][ర-ౠ]+/u },
  // Hindi (Romanized + Devanagari): kaun, kaun kaun, kis-kis, कौन
  { lang: "hindi",   re: /\b(kaun(\s+kaun)?|kis(\s+kis)?)\b/i },
  { lang: "hindi",   re: /कौन/u },
  // Spanish: quien / quienes
  { lang: "spanish", re: /\bquien(es)?\b/i },
  // French: qui
  { lang: "french",  re: /\bqui\b/i },
  // Tamil: yaar / யார்
  { lang: "tamil",   re: /\byaar\b/i },
  { lang: "tamil",   re: /யார்/u },
];

// Words that look like proper nouns / topic tokens but ARE NOT — drop
// these from the candidate list before matching against group names.
const STOPWORDS = new Set<string>([
  // English
  "who", "whom", "whose", "what", "when", "where", "why", "how",
  "the", "and", "but", "for", "with", "to", "from", "in", "on", "of",
  "my", "your", "his", "her", "their", "our", "all", "some", "any",
  "came", "come", "coming", "trip", "visit", "went", "going", "go",
  "did", "do", "does", "is", "are", "was", "were", "be", "been",
  "had", "have", "has", "can", "will", "would", "should", "could",
  // Telugu Romanized (common particles already detected by language.ts)
  "ki", "ku", "lo", "tho", "nu", "vu", "ra", "ro", "ay", "ayya", "ayy",
  "evaru", "evvaru", "evvari", "monna", "nedu", "repu", "appudu",
  "ostunnaru", "ostunnav", "poindru", "vellaru", "vellindu",
  "vacchinaru", "vachhinaru", "vacchav", "untunna",
  "untaru", "undali", "undav", "undadu",
  "mandi", "enta", "ento", "endi", "endhi",
  "meru", "memu", "naa", "nuvvu", "vaaru", "vaadu",
  // Hindi
  "kaun", "kya", "hai", "ho", "tha", "the", "mein", "hum", "tum",
  "aap", "kar", "raha", "rahe", "rahi", "kis",
  // Spanish
  "quien", "quienes", "que", "cuando", "donde", "como",
  // Generic chatter
  "ok", "okay", "yes", "no", "lol", "haha",
]);

/** Detect whether the query is a "roster" question and extract topic
 *  tokens for group-name matching. */
export function looksLikeRosterQuery(text: string): RosterQuerySignal {
  const t = (text || "").trim();
  if (t.length === 0) return { isRoster: false, tokens: [], reason: "empty" };

  // 1. Look for any question-word match across languages.
  let matched: string | null = null;
  for (const { lang, re } of WHO_PATTERNS) {
    if (re.test(t)) { matched = lang; break; }
  }
  if (!matched) {
    return { isRoster: false, tokens: [], reason: "no who-pattern" };
  }

  // 2. Tokenize + filter to candidate topic words.
  //    - 3+ chars (drops "of", "to", etc.)
  //    - not in stopword list
  //    - keep digits + dashes (e.g. years, "I-485")
  const tokens = t
    .toLowerCase()
    .split(/[\s,.!?;:()'"—–\-]+/)
    .map((tok) => tok.trim())
    .filter((tok) => {
      if (tok.length < 3) return false;
      if (STOPWORDS.has(tok)) return false;
      // Drop tokens that are pure punctuation / symbols.
      if (!/[\p{L}\p{N}]/u.test(tok)) return false;
      return true;
    });

  // Dedupe + cap at 5 candidates (more than that and group-matching
  // becomes noisy — the LLM still has tools to refine).
  const uniq = Array.from(new Set(tokens)).slice(0, 5);

  if (uniq.length === 0) {
    // Question-word but no topic — still a roster question (the LLM
    // might use it for "who is my X" type queries that already resolve
    // from the profile). Return isRoster=true but empty tokens so the
    // pre-fetch knows to skip group matching.
    return { isRoster: true, tokens: [], reason: `who-pattern (${matched}) but no topic tokens` };
  }

  return { isRoster: true, tokens: uniq, reason: `who-pattern (${matched}) + ${uniq.length} topic tokens` };
}

// ---- Pre-fetch helpers --------------------------------------------------
//
// These are CALLED BY THE BRIDGES with the bridge's own listGroups /
// getGroupMembers / searchHistory methods passed in — keeping this
// module bridge-agnostic and testable. The bridge formats the final
// block; this module just orchestrates the calls.

export interface RosterPrefetchAdapter {
  /** List all groups across the surface (whatsapp / imessage).
   *  Returns name + identifier + member-count. */
  listGroups: () => Promise<Array<{ id: string; name: string; participantCount: number }>>;
  /** Get full member list for a group (by id OR by name substring). */
  getGroupMembers: (opts: { id?: string; name?: string }) =>
    Promise<{ id: string; name: string; members: Array<{ name: string; isAdmin?: boolean }> } | null>;
  /** Surface label (for the prompt block header). */
  surface: "whatsapp" | "imessage";
}

export interface RosterPrefetchResult {
  surface: "whatsapp" | "imessage";
  matches: Array<{
    groupId: string;
    groupName: string;
    members: Array<{ name: string; isAdmin?: boolean }>;
  }>;
  topGroupCandidates: Array<{ id: string; name: string; participantCount: number }>;
}

/** For each surface adapter, list groups, fuzzy-match against the
 *  query tokens, and pull members for the top N matches. */
export async function prefetchRoster(
  signal: RosterQuerySignal,
  adapters: RosterPrefetchAdapter[],
  opts: { maxGroupsPerSurface?: number } = {},
): Promise<RosterPrefetchResult[]> {
  const maxGroups = Math.max(1, opts.maxGroupsPerSurface ?? 3);
  if (!signal.isRoster) return [];

  const results = await Promise.all(
    adapters.map(async (a): Promise<RosterPrefetchResult> => {
      let groups: Array<{ id: string; name: string; participantCount: number }> = [];
      try { groups = await a.listGroups(); } catch { /* surface down — skip */ }

      // Score each group by how many tokens its name matches.
      const scored: Array<{ g: typeof groups[number]; score: number }> = [];
      for (const g of groups) {
        const nameLower = g.name.toLowerCase();
        let score = 0;
        for (const tok of signal.tokens) {
          if (nameLower.includes(tok)) score += 1;
        }
        if (score > 0) scored.push({ g, score });
      }
      scored.sort((a, b) => b.score - a.score);
      const topMatches = scored.slice(0, maxGroups).map((s) => s.g);

      // Pull members in parallel for the matches.
      const membersByGroup = await Promise.all(
        topMatches.map((g) =>
          a.getGroupMembers({ id: g.id }).catch(() => null),
        ),
      );

      return {
        surface: a.surface,
        matches: membersByGroup
          .map((m, i) => m
            ? { groupId: m.id, groupName: m.name, members: m.members }
            : { groupId: topMatches[i].id, groupName: topMatches[i].name, members: [] }),
        topGroupCandidates: topMatches,
      };
    }),
  );

  return results;
}

/** Format pre-fetched roster results as a markdown block to inject
 *  into the LLM system prompt. Empty string when no matches. */
export function formatRosterBlock(
  signal: RosterQuerySignal,
  results: RosterPrefetchResult[],
): string {
  const lines: string[] = [];
  const total = results.reduce((n, r) => n + r.matches.length, 0);
  if (total === 0 || signal.tokens.length === 0) return "";

  lines.push(`## Pre-fetched group rosters (you asked a "who" question — these are the relevant groups + their members)`);
  lines.push(`Matched on tokens from your query: ${signal.tokens.join(", ")}.`);
  lines.push(``);
  for (const r of results) {
    if (r.matches.length === 0) continue;
    lines.push(`### ${r.surface === "whatsapp" ? "WhatsApp groups" : "iMessage groups"}`);
    for (const m of r.matches) {
      const memberLines = m.members
        .slice(0, 80)
        .map((x) => `  - ${x.name}${x.isAdmin ? " (admin)" : ""}`)
        .join("\n");
      lines.push(`**${m.groupName}** (${m.members.length} members)`);
      lines.push(memberLines || "  - (no members fetched)");
      lines.push(``);
    }
  }
  lines.push(`USE THIS ROSTER as the primary source for "who came / who's in / who all" questions. Personal docs (insurance, visa, etc.) often list only a SUBSET (the people on that policy) — group rosters are the COMPLETE truth. Cross-reference docs to corroborate, but DO NOT answer with just the doc's subset.`);
  return lines.join("\n");
}
