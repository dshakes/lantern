// Fleet health — pure, framework-free derivation of per-agent operational
// health from the real run list (`api.listRuns()`). Mission Control renders
// these directly; keeping the math here makes it testable and keeps the page
// component about layout, not arithmetic.
//
// Honesty guard: every metric is derived ONLY from fields the runs actually
// carry. When a value can't be computed (no terminal runs → no success rate,
// no durations → no latency line) the field is `null`, and the UI renders "—"
// instead of fabricating a number. We never invent data.

import type { Run, RunStatus } from "./mock-data";

const TERMINAL: RunStatus[] = ["succeeded", "failed", "cancelled"];
const LIVE: RunStatus[] = ["running", "paused", "queued"];

// Sparkline series length — last N runs, oldest→newest so the line reads L→R.
export const SPARK_WINDOW = 12;

// Alert thresholds. Deliberately conservative so the panel stays quiet until
// something genuinely warrants attention (owner's "not a wall" bar).
export const ERROR_RATE_ALERT = 0.2; // ≥20% of terminal runs failed today
export const MIN_RUNS_FOR_ERROR_ALERT = 3; // …over a meaningful sample
// Default per-agent daily budget used only to draw a rollup bar. This is a
// display heuristic, NOT a real budget; labelled as such in the UI.
export const DEFAULT_DAILY_BUDGET_USD = 5;
export const COST_SPIKE_FACTOR = 3; // today's $ ≥ 3× the prior-day average

function ts(d: Date | string | undefined): number | null {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
}

function startOfTodayMs(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function isToday(d: Date | string | undefined, todayMs = startOfTodayMs()): boolean {
  const t = ts(d);
  return t !== null && t >= todayMs;
}

/** Run duration in seconds, or null when it never started / hasn't finished. */
function durationSec(run: Run): number | null {
  const start = ts(run.startedAt);
  if (start === null) return null;
  const end = ts(run.finishedAt) ?? (run.status === "running" ? Date.now() : null);
  if (end === null || end < start) return null;
  return (end - start) / 1000;
}

export interface AgentHealth {
  agentName: string;
  totalRuns: number;
  terminalRuns: number; // runs with a definitive outcome (basis for success rate)
  failedRuns: number;
  liveRuns: number; // running / paused / queued right now
  runsToday: number;
  /** 1 − failed/terminal. null when there are no terminal runs to judge. */
  successRate: number | null;
  /** failed/terminal. null when no terminal runs. */
  errorRate: number | null;
  /** Sum of today's run costs (USD). Always derivable (0 when none). */
  costTodayUsd: number;
  /** Sum of cost over the prior day (yesterday) — basis for spike detection. */
  costPrevDayUsd: number;
  /** Last-N run costs, oldest→newest, for the cost sparkline. */
  costSeries: number[];
  /** Last-N run durations (sec), oldest→newest, for the latency sparkline. */
  latencySeries: number[];
  /** Last-N run outcomes as 0/1 error flags, oldest→newest. */
  errorSeries: number[];
  /** Most-recent activity timestamp across this agent's runs. */
  lastActivityMs: number | null;
  hasLive: boolean;
}

/**
 * Group runs by agentName and compute health for each. Input may be in any
 * order; we sort per-agent by createdAt to build oldest→newest spark series.
 */
export function computeFleetHealth(runs: Run[], now = Date.now()): AgentHealth[] {
  const todayMs = startOfTodayMs(now);
  const oneDay = 86_400_000;
  const prevDayMs = todayMs - oneDay;

  const byAgent = new Map<string, Run[]>();
  for (const run of runs) {
    const bucket = byAgent.get(run.agentName);
    if (bucket) bucket.push(run);
    else byAgent.set(run.agentName, [run]);
  }

  const out: AgentHealth[] = [];
  for (const [agentName, agentRuns] of byAgent) {
    // Oldest → newest for the spark series.
    const sorted = [...agentRuns].sort(
      (a, b) => (ts(a.createdAt) ?? 0) - (ts(b.createdAt) ?? 0),
    );

    const terminal = sorted.filter((r) => TERMINAL.includes(r.status));
    const failed = terminal.filter((r) => r.status === "failed");
    const live = sorted.filter((r) => LIVE.includes(r.status));

    const todays = sorted.filter((r) => isToday(r.createdAt, todayMs));
    const prevDays = sorted.filter((r) => {
      const t = ts(r.createdAt);
      return t !== null && t >= prevDayMs && t < todayMs;
    });

    const costToday = todays.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const costPrev = prevDays.reduce((s, r) => s + (r.costUsd ?? 0), 0);

    const window = sorted.slice(-SPARK_WINDOW);
    const costSeries = window.map((r) => r.costUsd ?? 0);
    const latencySeries = window
      .map(durationSec)
      .filter((v): v is number => v !== null);
    // Error series is terminal-only so the spark agrees with the alert
    // threshold (which is also terminal-only). Including in-flight/queued runs
    // would visually dilute a real failure burst.
    const errorSeries = window
      .filter((r) => TERMINAL.includes(r.status))
      .map((r) => (r.status === "failed" ? 1 : 0));

    let lastActivityMs: number | null = null;
    for (const r of sorted) {
      const t = ts(r.finishedAt) ?? ts(r.startedAt) ?? ts(r.createdAt);
      if (t !== null && (lastActivityMs === null || t > lastActivityMs)) {
        lastActivityMs = t;
      }
    }

    const successRate = terminal.length > 0 ? 1 - failed.length / terminal.length : null;
    const errorRate = terminal.length > 0 ? failed.length / terminal.length : null;

    out.push({
      agentName,
      totalRuns: sorted.length,
      terminalRuns: terminal.length,
      failedRuns: failed.length,
      liveRuns: live.length,
      runsToday: todays.length,
      successRate,
      errorRate,
      costTodayUsd: costToday,
      costPrevDayUsd: costPrev,
      costSeries,
      latencySeries,
      errorSeries,
      lastActivityMs,
      hasLive: live.length > 0,
    });
  }

  return out;
}

export type FleetSort = "health" | "cost";

/** Sort for the fleet grid. "health" = worst (lowest success) first; "cost" =
 *  most expensive today first. Agents with no terminal runs (unjudgeable) sort
 *  after judged ones under "health" so real problems surface at the top. */
export function sortFleet(fleet: AgentHealth[], by: FleetSort): AgentHealth[] {
  const copy = [...fleet];
  if (by === "cost") {
    return copy.sort((a, b) => b.costTodayUsd - a.costTodayUsd);
  }
  return copy.sort((a, b) => {
    const ra = a.successRate ?? 2; // unjudged → push down
    const rb = b.successRate ?? 2;
    if (ra !== rb) return ra - rb;
    return b.costTodayUsd - a.costTodayUsd;
  });
}

export type AlertKind = "error-rate" | "cost-spike";

export interface Alert {
  agentName: string;
  kind: AlertKind;
  detail: string;
}

/** Derive alerts from fleet health. Subtle by design — only fires on a real
 *  error-rate breach (over a min sample) or a today-cost spike vs. yesterday. */
export function computeAlerts(fleet: AgentHealth[]): Alert[] {
  const alerts: Alert[] = [];
  for (const a of fleet) {
    if (
      a.errorRate !== null &&
      a.errorRate >= ERROR_RATE_ALERT &&
      a.terminalRuns >= MIN_RUNS_FOR_ERROR_ALERT
    ) {
      alerts.push({
        agentName: a.agentName,
        kind: "error-rate",
        detail: `${Math.round(a.errorRate * 100)}% error rate · ${a.failedRuns}/${a.terminalRuns} runs failed`,
      });
    }
    if (
      a.costPrevDayUsd > 0 &&
      a.costTodayUsd >= a.costPrevDayUsd * COST_SPIKE_FACTOR &&
      a.costTodayUsd > 0.01
    ) {
      alerts.push({
        agentName: a.agentName,
        kind: "cost-spike",
        detail: `$${a.costTodayUsd.toFixed(2)} today vs $${a.costPrevDayUsd.toFixed(2)} yesterday`,
      });
    }
  }
  return alerts;
}

export interface FleetSummary {
  agentCount: number;
  liveRuns: number;
  costTodayUsd: number;
  alertCount: number;
}

export function summarizeFleet(fleet: AgentHealth[], alerts: Alert[]): FleetSummary {
  return {
    agentCount: fleet.length,
    liveRuns: fleet.reduce((s, a) => s + a.liveRuns, 0),
    costTodayUsd: fleet.reduce((s, a) => s + a.costTodayUsd, 0),
    alertCount: alerts.length,
  };
}

/** Normalize a numeric series into 0..1 for the cockpit Sparkline. Flat or
 *  degenerate series collapse to a mid-line so the spark renders calmly. */
export function normalizeSeries(series: number[]): number[] {
  if (series.length < 2) return series.length === 1 ? [0.5, 0.5] : [];
  const min = Math.min(...series);
  const max = Math.max(...series);
  if (max === min) return series.map(() => 0.5);
  return series.map((v) => (v - min) / (max - min));
}
