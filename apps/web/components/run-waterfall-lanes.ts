// Pure layout helpers for the trace-waterfall swimlanes view.
//
// These functions take the flat list of extracted spans and turn it into
// concurrency-revealing swimlanes:
//
//   - laneFor()        — categorize a span into a lane from its kind / name /
//                        sub-events (no parentSpanId/depth exists on the wire,
//                        so the lane is derived heuristically).
//   - partitionRows()  — greedy interval partitioning so overlapping spans in
//                        the SAME lane stack into separate sub-rows instead of
//                        drawing on top of each other.
//   - groupRetries()   — collapse multiple attempts of the same logical step
//                        (duplicate stepId, or an explicit `attempt` in the
//                        event data) into one bar with a "retried ×N" badge and
//                        the prior attempts nested underneath.
//
// Kept side-effect-free and component-agnostic so the render layer stays thin
// (and so this is unit-testable without React).

import type { StreamEvent } from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// Span shape (mirrors the one in run-waterfall.tsx; re-declared here to keep
// this module importable on its own without a circular import).
// ---------------------------------------------------------------------------

export interface Span {
  id: string;
  name: string;
  startMs: number;
  endMs: number | null; // null = still open
  status: "running" | "succeeded" | "failed";
  events: StreamEvent[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  errorMessage?: string;
  // Set by groupRetries(): the earlier attempts of this logical step, oldest
  // first. The span itself is the latest attempt.
  retries?: Span[];
}

// ---------------------------------------------------------------------------
// Lane taxonomy
// ---------------------------------------------------------------------------

export type LaneId = "reasoning" | "llm" | "tool" | "connector" | "other";

export interface LaneMeta {
  id: LaneId;
  label: string;
}

// Fixed display order (top → bottom). Empty lanes are omitted at render time.
export const LANE_ORDER: LaneMeta[] = [
  { id: "reasoning", label: "Reasoning" },
  { id: "llm", label: "LLM" },
  { id: "tool", label: "Tool" },
  { id: "connector", label: "Connector" },
  { id: "other", label: "Other" },
];

const REASONING_NAME = /(reason|think|analy|plan|reflect|synth|ai-step)/i;
const LLM_NAME = /(llm|model|complet|prompt|generat|chat|gpt|claude|review|summar)/i;
const TOOL_NAME = /(tool|search|fetch|scrape|http|query|exec|run-)/i;
const CONNECTOR_NAME = /(connector|slack|gmail|github|notion|calendar|jira|stripe|webhook)/i;

// Categorize a span into a lane. Precedence:
//   1. explicit category in the start event's data (type/kind/category/lane/node)
//   2. sub-event signal (thinking → reasoning, llm_* → llm, tool_* → tool)
//   3. name regex
//   4. fallback → other
export function laneFor(span: Span): LaneId {
  const start = span.events.find((e) => e.kind === "step_started");
  const explicit = String(
    (start?.data?.type ??
      start?.data?.kind ??
      start?.data?.category ??
      start?.data?.lane ??
      start?.data?.node ??
      "") as string,
  ).toLowerCase();

  if (explicit) {
    if (/(reason|think|ai-?step)/.test(explicit)) return "reasoning";
    if (/connector/.test(explicit)) return "connector";
    if (/(tool)/.test(explicit)) return "tool";
    if (/(llm|model|ai)/.test(explicit)) return "llm";
    if (/(trigger|condition|approval|end)/.test(explicit)) return "other";
  }

  // Sub-event signals. A `thinking`/reasoning sub-event is the strongest hint
  // for the reasoning lane (e.g. extended-thinking blocks).
  const kinds = new Set(span.events.map((e) => e.kind));
  const hasThinking = span.events.some((e) => {
    const k = String(e.kind).toLowerCase();
    if (k.includes("think") || k.includes("reason")) return true;
    const t = String(e.data?.type ?? "").toLowerCase();
    return t.includes("think") || t.includes("reason");
  });
  if (hasThinking) return "reasoning";

  const hasLlm = kinds.has("llm_complete") || kinds.has("llm_delta");
  const hasTool = kinds.has("tool_call") || kinds.has("tool_result");

  // Name takes priority over generic sub-event presence for reasoning, since a
  // reasoning/synthesis step also emits llm_* events but reads as reasoning.
  if (REASONING_NAME.test(span.name)) return "reasoning";
  if (CONNECTOR_NAME.test(span.name)) return "connector";

  if (hasTool && !hasLlm) return "tool";
  if (hasLlm) return "llm";

  if (TOOL_NAME.test(span.name)) return "tool";
  if (LLM_NAME.test(span.name)) return "llm";

  return "other";
}

// True when this span should render with the distinct reasoning treatment.
export function isReasoning(span: Span): boolean {
  return laneFor(span) === "reasoning";
}

// Pull any reasoning / thinking text out of a span's sub-events so it can be
// surfaced on expand. Falls back to llm_delta text (the streamed model output)
// since that is the closest thing to "what the model was thinking" we have.
export function reasoningText(span: Span): string | null {
  for (const e of span.events) {
    const t = String(e.data?.type ?? "").toLowerCase();
    if (t.includes("think") || t.includes("reason")) {
      const txt = e.data?.text ?? e.data?.thinking ?? e.data?.content;
      if (typeof txt === "string" && txt.trim()) return txt;
    }
  }
  for (const e of span.events) {
    if (e.kind === "llm_delta") {
      const txt = e.data?.text;
      if (typeof txt === "string" && txt.trim()) return txt;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Retry grouping
// ---------------------------------------------------------------------------

// Detect the explicit attempt number on a span, if any event carries one.
function attemptOf(span: Span): number | null {
  for (const e of span.events) {
    const a = e.data?.attempt ?? e.data?.attemptNumber ?? e.data?.retry;
    if (a != null && Number.isFinite(Number(a))) return Number(a);
  }
  return null;
}

// Collapse multiple attempts of the same logical step into one bar.
//
// Two spans are the same logical step when they share a stepId, OR share a name
// AND at least one of them carries an explicit `attempt`. The latest attempt
// (by startMs) becomes the visible bar; earlier attempts hang off `.retries`.
export function groupRetries(spans: Span[]): Span[] {
  // Bucket by a logical key. Prefer stepId; if a name has explicit attempts,
  // also fold by name so retries that minted fresh stepIds still group.
  const byKey = new Map<string, Span[]>();
  const order: string[] = [];

  const keyFor = (s: Span): string => {
    const hasAttempt = attemptOf(s) != null;
    return hasAttempt ? `name:${s.name}` : `id:${s.id}`;
  };

  for (const s of spans) {
    const k = keyFor(s);
    if (!byKey.has(k)) {
      byKey.set(k, []);
      order.push(k);
    }
    byKey.get(k)!.push(s);
  }

  const grouped: Span[] = [];
  for (const k of order) {
    const bucket = byKey.get(k)!;
    if (bucket.length === 1) {
      grouped.push(bucket[0]);
      continue;
    }
    // Oldest → newest by start time (attempt number as tiebreak).
    const sorted = [...bucket].sort((a, b) => {
      if (a.startMs !== b.startMs) return a.startMs - b.startMs;
      return (attemptOf(a) ?? 0) - (attemptOf(b) ?? 0);
    });
    const latest = sorted[sorted.length - 1];
    const priors = sorted.slice(0, -1);
    grouped.push({ ...latest, retries: priors });
  }

  grouped.sort((a, b) => a.startMs - b.startMs);
  return grouped;
}

// ---------------------------------------------------------------------------
// Greedy interval partitioning (sub-rows within a lane)
// ---------------------------------------------------------------------------

// Lay spans into the fewest sub-rows such that no two spans in a sub-row
// overlap in time. Classic greedy: sort by start, place each span in the first
// row whose last span ended at/before this span's start; else open a new row.
//
// An open span (endMs == null) is treated as extending to `openEndMs` so it
// still claims its row for overlap purposes during a live run.
export function partitionRows(spans: Span[], openEndMs: number): Span[][] {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const rows: Span[][] = [];
  const rowEnds: number[] = [];

  for (const s of sorted) {
    const end = s.endMs ?? openEndMs;
    let placed = false;
    for (let i = 0; i < rows.length; i++) {
      if (rowEnds[i] <= s.startMs) {
        rows[i].push(s);
        rowEnds[i] = end;
        placed = true;
        break;
      }
    }
    if (!placed) {
      rows.push([s]);
      rowEnds.push(end);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Lane assembly
// ---------------------------------------------------------------------------

export interface Lane {
  meta: LaneMeta;
  rows: Span[][]; // sub-rows from greedy partitioning
}

// Build the ordered, non-empty lanes from the (already retry-grouped) spans.
export function buildLanes(spans: Span[], openEndMs: number): Lane[] {
  const byLane = new Map<LaneId, Span[]>();
  for (const s of spans) {
    const id = laneFor(s);
    if (!byLane.has(id)) byLane.set(id, []);
    byLane.get(id)!.push(s);
  }
  const lanes: Lane[] = [];
  for (const meta of LANE_ORDER) {
    const laneSpans = byLane.get(meta.id);
    if (!laneSpans || laneSpans.length === 0) continue;
    lanes.push({ meta, rows: partitionRows(laneSpans, openEndMs) });
  }
  return lanes;
}
