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

// ---- Synthesis prompt builder --------------------------------------------

/** Format sub-agent briefs into a synthesis prompt block. The lead
 *  LLM gets this in its system hint and produces the user-facing reply. */
export function formatSubTaskBriefs(
  query: string,
  briefs: Array<{ source: SubAgentSource; brief: string; ok: boolean; errorMsg?: string }>,
): string {
  if (briefs.length === 0) return "";
  const lines: string[] = [];
  lines.push(`## Multi-source intelligence brief`);
  lines.push(`The user asked: ${query}`);
  lines.push(`Below are independent briefs from ${briefs.length} parallel sub-agents, one per data source. Synthesize a single reply that draws on ALL of them — not just one.`);
  lines.push(``);
  for (const b of briefs) {
    lines.push(`### Source: ${b.source}`);
    if (!b.ok) {
      lines.push(`(sub-agent failed: ${b.errorMsg || "unknown"})`);
    } else {
      lines.push(b.brief.trim() || "(no data)");
    }
    lines.push(``);
  }
  lines.push(`Now produce ONE coherent reply (1-4 short lines) that cross-references the sources. Do not list "source 1 said X / source 2 said Y" — weave them into a natural answer. If sources disagree, note the discrepancy briefly.`);
  return lines.join("\n");
}
