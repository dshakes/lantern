// Session grouping — folds a flat run list into session groups so a
// multi-step agent (interactive session, subagent tree, or a loop) reads
// as ONE entry instead of N rows. This is the agent-centric model the
// AWS AgentCore / Vertex / Anthropic consoles use.
//
// Pure + framework-free so both /runs and /inbox share one source of truth.
// The runs API already returns `sessionId` and `parentRunId` (camelCase,
// omitted when empty); grouping happens client-side on the loaded set.

import type { Run, RunStatus } from "./mock-data";

export interface SessionGroup {
  /** Stable group identity (session id, parent-chain root id, or solo run id). */
  key: string;
  /** Member runs, preserving the input order (already sorted newest-first by callers). */
  runs: Run[];
  /** True when this is a real multi-run group (vs. a standalone single run). */
  isMulti: boolean;
}

/**
 * Resolve the grouping key for a single run, given a lookup of all loaded
 * runs by id (used to walk the parentRunId chain). Priority:
 *   1. run.sessionId, if present.
 *   2. else the ROOT of the parentRunId chain among the loaded runs.
 *   3. else the run's own id (standalone group of one).
 */
function groupKeyFor(run: Run, byId: Map<string, Run>): string {
  if (run.sessionId) return run.sessionId;

  // Walk parentRunId to the topmost ancestor we can see in the loaded set.
  // Guard against cycles / unbounded chains with a visited set.
  let current = run;
  const seen = new Set<string>([current.id]);
  while (current.parentRunId) {
    const parent = byId.get(current.parentRunId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  // If the root itself carries a sessionId, prefer that so a parent-chain
  // and its session collapse together.
  return current.sessionId ?? current.id;
}

/**
 * Group runs into sessions. Order of the first-seen run in each group is
 * preserved, so a newest-first input yields newest-first groups.
 */
export function groupRunsBySession(runs: Run[]): SessionGroup[] {
  const byId = new Map<string, Run>();
  for (const run of runs) byId.set(run.id, run);

  const groups = new Map<string, Run[]>();
  const order: string[] = [];
  for (const run of runs) {
    const key = groupKeyFor(run, byId);
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
      order.push(key);
    }
    bucket.push(run);
  }

  return order.map((key) => {
    const groupRuns = groups.get(key)!;
    return { key, runs: groupRuns, isMulti: groupRuns.length > 1 };
  });
}

export interface SessionAggregate {
  /** Number of member runs. */
  count: number;
  /** Summed cost across all member runs. */
  totalCost: number;
  /** Distinct agent names involved, first-seen order. */
  agentNames: string[];
  /** Display label: the single agent name, or "N agents" when mixed. */
  agentLabel: string;
  /** Worst-of status: failed > running/paused > queued > succeeded. */
  status: RunStatus;
  /** Total wall-clock span (earliest started → latest finished), in ms. */
  durationMs: number | null;
  /** Most-recent activity timestamp across the group (for sorting / display). */
  latestAt: Date;
}

const STATUS_RANK: Record<RunStatus, number> = {
  failed: 5,
  running: 4,
  paused: 4,
  queued: 2,
  cancelled: 1,
  succeeded: 0,
};

function tsOf(value: Date | string | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Compute the rollup shown on a group header row. */
export function aggregateSession(runs: Run[]): SessionAggregate {
  let totalCost = 0;
  let status: RunStatus = "succeeded";
  let bestRank = -1;
  let earliestStart: number | null = null;
  let latestFinish: number | null = null;
  let latestAt = 0;
  const agentNames: string[] = [];

  for (const run of runs) {
    totalCost += run.costUsd ?? 0;

    const rank = STATUS_RANK[run.status] ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      status = run.status;
    }

    if (!agentNames.includes(run.agentName)) agentNames.push(run.agentName);

    const start = tsOf(run.startedAt);
    if (start !== null && (earliestStart === null || start < earliestStart)) {
      earliestStart = start;
    }
    // A still-running member has no finish; treat "now" as the open end so
    // the span reflects elapsed time rather than collapsing to zero.
    const finish = tsOf(run.finishedAt) ?? (run.status === "running" ? Date.now() : null);
    if (finish !== null && (latestFinish === null || finish > latestFinish)) {
      latestFinish = finish;
    }

    const activity =
      tsOf(run.finishedAt) ?? tsOf(run.startedAt) ?? tsOf(run.createdAt) ?? 0;
    if (activity > latestAt) latestAt = activity;
  }

  const durationMs =
    earliestStart !== null && latestFinish !== null && latestFinish >= earliestStart
      ? latestFinish - earliestStart
      : null;

  return {
    count: runs.length,
    totalCost,
    agentNames,
    agentLabel: agentNames.length === 1 ? agentNames[0] : `${agentNames.length} agents`,
    status,
    durationMs,
    latestAt: new Date(latestAt),
  };
}
