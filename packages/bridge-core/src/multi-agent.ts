// Multi-agent decomposition orchestrator.
//
// For complex cross-source queries ("who came on my Japan trip and
// what did they say about the next one"), running one LLM with all
// tools is slow + lazy. The single LLM sees the question and picks
// the first plausible tool, gets an answer, stops. Real Jarvis-grade
// quality comes from explicit decomposition:
//
//   1. PLAN     — a small/fast LLM call (or a deterministic ruleset)
//                 produces an array of sub-tasks, each scoped to ONE
//                 data source: docs / gmail / calendar / iMessage /
//                 WhatsApp / etc.
//   2. FAN-OUT  — every sub-task runs in PARALLEL. Each gets only
//                 the tools relevant to its source (smaller prompt,
//                 lower latency, less lazy-pathing).
//   3. SYNTHESIZE — a final LLM call takes the sub-task briefs +
//                 the original query, produces the user-facing reply.
//
// This module is the PLAN + ORCHESTRATION layer. The actual sub-task
// execution is bridge-supplied (each bridge knows its own tools).
//
// V1 ships a DETERMINISTIC planner — no LLM call for the plan, just
// rules derived from existing detectors (looksLikeRosterQuery,
// looksLikeAppointmentQuery, looksLikeDocQuery, etc.). The LLM-based
// planner is a Phase-B-extras follow-up; the deterministic version
// covers ~90% of cross-source queries without burning a planning
// round-trip.

export type SubAgentSource =
  | "personal-docs"
  | "gmail"
  | "google-calendar"
  | "whatsapp-history"
  | "whatsapp-groups"
  | "imessage-history"
  | "imessage-groups"
  | "owner-profile";

export interface SubTask {
  /** Which source / capability the sub-agent should query. */
  source: SubAgentSource;
  /** Sub-task-specific instruction. Short, focused — the sub-agent
   *  only needs to know WHAT to fetch, not WHY. */
  instruction: string;
  /** Optional filters extracted from the original query for hints. */
  hints?: {
    keyword?: string;
    sinceMs?: number;
    untilMs?: number;
    jidOrName?: string;
  };
}

export interface DecomposedPlan {
  /** Was the query complex enough to benefit from decomposition? */
  shouldDecompose: boolean;
  /** Sub-tasks to fan out (empty when shouldDecompose=false). */
  subTasks: SubTask[];
  /** Human-readable explanation of the plan — logged for debugging. */
  reasoning: string;
}

// ---- Deterministic planner ------------------------------------------------

// Heuristic complexity score: more topics + more source-indicating
// keywords = higher score. >= 2 triggers decomposition.
function complexityScore(query: string): { score: number; signals: string[] } {
  const t = query.toLowerCase();
  const signals: string[] = [];

  // Multi-topic indicator: "and", "plus", "also", "or" between phrases.
  if (/\b(and|plus|also|along with|together with)\b/.test(t)) {
    signals.push("multi-clause");
  }

  // Source-indicating keywords.
  const sourceHits: Record<string, RegExp> = {
    files: /\b(file|doc|pdf|passport|license|visa|insurance|i-?485|green\s*card|receipt|invoice|tax|policy|contract)\b/i,
    gmail: /\b(email|gmail|mail|inbox|message from|sent me|forwarded)\b/i,
    calendar: /\b(calendar|meeting|event|schedule|appointment|booking)\b/i,
    history: /\b(when did|last (?:time|week|month|year)|history|conversation|chat history|texted me|messaged me|past)\b/i,
    groups: /\b(group|family|friends|trip|wedding|event|reunion|squad|crew)\b/i,
    people: /\b(who|whom|who came|who's in|kaun|evaru|evvaru|enta\s+mandi)\b/i,
  };
  for (const [name, re] of Object.entries(sourceHits)) {
    if (re.test(t)) signals.push(`signal:${name}`);
  }

  // Length signal: long queries usually want multiple sources.
  if (t.length > 80) signals.push("long-query");
  if (t.split(/\s+/).length > 15) signals.push("many-words");

  // Score: 1 per source-hit + 1 for multi-clause + 0.5 for long-query.
  let score = 0;
  for (const s of signals) {
    if (s.startsWith("signal:")) score += 1;
    else if (s === "multi-clause") score += 1;
    else if (s === "long-query" || s === "many-words") score += 0.5;
  }
  return { score, signals };
}

/** Decide whether to decompose + emit a sub-task plan. Deterministic;
 *  no LLM call. */
export function planSubTasks(query: string): DecomposedPlan {
  const { score, signals } = complexityScore(query);

  if (score < 2) {
    return {
      shouldDecompose: false,
      subTasks: [],
      reasoning: `score=${score.toFixed(1)} below threshold (signals: ${signals.join(", ") || "none"})`,
    };
  }

  // Pick sub-tasks based on which signals fired.
  const subs: SubTask[] = [];
  const hasFiles = signals.includes("signal:files");
  const hasGmail = signals.includes("signal:gmail");
  const hasCal = signals.includes("signal:calendar");
  const hasHist = signals.includes("signal:history");
  const hasGroups = signals.includes("signal:groups");
  const hasPeople = signals.includes("signal:people");

  // ROSTER-style queries fan out to both groups sources + personal-docs.
  if (hasPeople && (hasGroups || hasHist || hasFiles)) {
    subs.push({ source: "whatsapp-groups", instruction: "List groups whose name matches the query topic + their full member rosters." });
    subs.push({ source: "imessage-groups", instruction: "List iMessage group chats whose name matches the topic + members." });
    subs.push({ source: "personal-docs", instruction: "Search for travel/insurance/visa docs that name people on the trip/event." });
    if (hasHist || hasGmail) {
      subs.push({ source: "gmail", instruction: "Find email confirmations (flight, hotel, restaurant booking) that name attendees during the relevant date range." });
    }
  }

  // TEMPORAL/HISTORY queries fan out to all message stores + Gmail/Calendar.
  if (hasHist && !hasPeople) {
    if (hasFiles || hasGmail) {
      subs.push({ source: "personal-docs", instruction: "Search for any document referencing the topic + extract date ranges." });
    }
    subs.push({ source: "imessage-history", instruction: "Search iMessage history for the keyword/topic. Return up to 25 recent matches with dates + senders." });
    subs.push({ source: "whatsapp-history", instruction: "Search WhatsApp history for the same. Cross-reference dates with the iMessage results." });
    if (hasGmail) {
      subs.push({ source: "gmail", instruction: "Search email for the topic + extract context." });
    }
    if (hasCal) {
      subs.push({ source: "google-calendar", instruction: "Look for related events in the calendar around the topic dates." });
    }
  }

  // SIMPLE cross-source — at least 2 sources for any non-trivial multi-clause query.
  if (subs.length === 0) {
    if (hasFiles) subs.push({ source: "personal-docs", instruction: "Search files for the topic." });
    if (hasGmail) subs.push({ source: "gmail", instruction: "Search email for the topic." });
    if (hasCal) subs.push({ source: "google-calendar", instruction: "Search calendar for the topic." });
    if (hasHist) {
      subs.push({ source: "imessage-history", instruction: "Search iMessage history for the topic." });
      subs.push({ source: "whatsapp-history", instruction: "Search WhatsApp history for the topic." });
    }
  }

  // Cap at 5 sub-tasks total (any more and the synthesis prompt gets unwieldy).
  const final = subs.slice(0, 5);

  return {
    shouldDecompose: final.length >= 2,
    subTasks: final,
    reasoning: `score=${score.toFixed(1)}, signals=[${signals.join(",")}], picked=${final.map((s) => s.source).join(",")}`,
  };
}

// ---- Sub-task executor ---------------------------------------------------
//
// Each SubTask gets dispatched to a SOURCE-SPECIFIC adapter the bridge
// supplies. The adapter does the actual data fetch (already-wired
// methods like session.searchHistory, db.searchMessages, etc.) and
// returns a string brief. All sub-tasks run in PARALLEL. The final
// briefs go through formatSubTaskBriefs into the synthesis LLM call.
//
// Why deterministic fan-out instead of LLM-per-source: each sub-task
// would otherwise be a separate Claude/GPT call, multiplying cost by
// N. Direct data fetches are free, fast, and produce identical
// downstream synthesis quality (the lead LLM is the smart one).

export interface SubTaskAdapters {
  /** personal-docs source: search the user's local files. */
  personalDocs?: (instruction: string, hints?: SubTask["hints"]) => Promise<string>;
  /** gmail source: search email. */
  gmail?: (instruction: string, hints?: SubTask["hints"]) => Promise<string>;
  /** google-calendar source: list / search calendar events. */
  googleCalendar?: (instruction: string, hints?: SubTask["hints"]) => Promise<string>;
  /** whatsapp-history source: keyword/date search in JSONL. */
  whatsappHistory?: (instruction: string, hints?: SubTask["hints"]) => Promise<string>;
  /** whatsapp-groups source: list groups + member resolution. */
  whatsappGroups?: (instruction: string, hints?: SubTask["hints"]) => Promise<string>;
  /** imessage-history source: keyword/date search in chat.db. */
  imessageHistory?: (instruction: string, hints?: SubTask["hints"]) => Promise<string>;
  /** imessage-groups source: list groups + members. */
  imessageGroups?: (instruction: string, hints?: SubTask["hints"]) => Promise<string>;
  /** owner-profile source: re-read profile prose + relationships. */
  ownerProfile?: (instruction: string, hints?: SubTask["hints"]) => Promise<string>;
}

export interface SubTaskResult {
  source: SubAgentSource;
  brief: string;
  ok: boolean;
  errorMsg?: string;
  durationMs: number;
}

/** Execute each sub-task in parallel via the supplied adapters.
 *  Adapters are optional — when no adapter exists for a source, the
 *  sub-task is recorded as "skipped: no adapter". A failed adapter
 *  doesn't fail the rest. Per-task timeout = 8s. */
export async function executeSubTasks(
  subTasks: SubTask[],
  adapters: SubTaskAdapters,
  opts: { perTaskTimeoutMs?: number } = {},
): Promise<SubTaskResult[]> {
  const timeoutMs = Math.max(1000, opts.perTaskTimeoutMs ?? 8000);
  const withTimeout = <T,>(p: Promise<T>): Promise<T> => {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("sub-task timeout")), timeoutMs);
      p.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); },
      );
    });
  };

  return Promise.all(subTasks.map(async (st): Promise<SubTaskResult> => {
    const t0 = Date.now();
    const adapter = pickAdapter(st.source, adapters);
    if (!adapter) {
      return { source: st.source, brief: "", ok: false, errorMsg: "no adapter registered", durationMs: Date.now() - t0 };
    }
    try {
      const brief = await withTimeout(adapter(st.instruction, st.hints));
      return { source: st.source, brief, ok: true, durationMs: Date.now() - t0 };
    } catch (err) {
      return { source: st.source, brief: "", ok: false, errorMsg: (err as Error).message || "exec failed", durationMs: Date.now() - t0 };
    }
  }));
}

function pickAdapter(source: SubAgentSource, a: SubTaskAdapters): ((instruction: string, hints?: SubTask["hints"]) => Promise<string>) | undefined {
  switch (source) {
    case "personal-docs": return a.personalDocs;
    case "gmail": return a.gmail;
    case "google-calendar": return a.googleCalendar;
    case "whatsapp-history": return a.whatsappHistory;
    case "whatsapp-groups": return a.whatsappGroups;
    case "imessage-history": return a.imessageHistory;
    case "imessage-groups": return a.imessageGroups;
    case "owner-profile": return a.ownerProfile;
  }
}

// ---- Synthesis prompt builder --------------------------------------------

/** Format sub-agent briefs into a synthesis prompt block. The lead
 *  LLM gets this in its system hint and produces the user-facing reply.
 *  Accepts either the lite shape (just brief/ok) or the full SubTaskResult
 *  (includes durationMs) — the duration is logged but not surfaced to
 *  the LLM. */
export function formatSubTaskBriefs(
  query: string,
  briefs: Array<{ source: SubAgentSource; brief: string; ok: boolean; errorMsg?: string; durationMs?: number }>,
): string {
  // Filter out empty briefs entirely — no point putting "(no data)" in
  // the prompt; the LLM will just hallucinate that the source was
  // checked when it really wasn't useful.
  const useful = briefs.filter((b) => b.ok && b.brief.trim().length > 0);
  if (useful.length === 0) return "";
  const lines: string[] = [];
  lines.push(`## Multi-source intelligence brief`);
  lines.push(`The user asked: ${query}`);
  lines.push(`Below are ${useful.length} parallel sub-agent briefs, one per data source. Synthesize ONE coherent reply that draws on ALL of them — not just one. Don't enumerate "source 1 / source 2"; weave them into a natural answer. If sources disagree, note the discrepancy briefly.`);
  lines.push(``);
  for (const b of useful) {
    lines.push(`### Source: ${b.source}`);
    lines.push(b.brief.trim());
    lines.push(``);
  }
  return lines.join("\n");
}
