// Post-deployment observability view-models (ADR 0056). Pure: no React, no
// fetch — unit-tested in observability.test.mts. The server owns every number
// (trace, burn rates, incidents); this file only lays them out.

export interface TraceLLM {
  provider?: string;
  model?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
}
export interface TraceTool {
  name: string;
  args?: unknown;
  result?: string;
}
export interface TraceRetry {
  attempt: number;
  error?: string;
}
export interface TraceNode {
  id: string;
  name: string;
  type: string;
  status: "ok" | "failed" | "running" | "waiting";
  startMs: number;
  durationMs: number;
  retries?: TraceRetry[];
  llm?: TraceLLM;
  tool?: TraceTool;
  policyDenied?: { kind: string; target: string; reason: string };
  output?: string;
  error?: string;
  childRun?: RunTrace;
}
export interface RunTrace {
  runId: string;
  status: string;
  agentName: string;
  agentVersion?: string;
  startedAt: string;
  durationMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  totals: { steps: number; llmCalls: number; toolCalls: number; retries: number };
  steps: TraceNode[];
  childRuns?: RunTrace[];
}

export interface WaterfallRow {
  key: string;
  node: TraceNode;
  depth: number;
  /** 0..100, position on the shared time axis. */
  leftPct: number;
  /** 0..100, never below a visible sliver. */
  widthPct: number;
  /** Row label prefix: "↳ child run …" for nested runs. */
  runId: string;
}

/** Shortest bar that is still visible and clickable. */
export const MIN_BAR_PCT = 0.8;

/**
 * Flatten a trace (and nested child runs) into waterfall rows on ONE time axis.
 * A child run's steps are offset by its parent step's start so a sub-agent's
 * work lines up under the step that spawned it.
 */
export function waterfallRows(trace: RunTrace): WaterfallRow[] {
  const span = Math.max(trace.durationMs, ...trace.steps.map((s) => s.startMs + s.durationMs), 1);
  const rows: WaterfallRow[] = [];
  const walk = (t: RunTrace, depth: number, offset: number) => {
    for (const s of t.steps) {
      const start = offset + Math.max(s.startMs, 0);
      rows.push({
        key: `${t.runId}:${s.id}`,
        node: s,
        depth,
        leftPct: Math.min((start / span) * 100, 100 - MIN_BAR_PCT),
        widthPct: Math.max((s.durationMs / span) * 100, MIN_BAR_PCT),
        runId: t.runId,
      });
      if (s.childRun) walk(s.childRun, depth + 1, start);
    }
    for (const c of t.childRuns ?? []) walk(c, depth + 1, offset);
  };
  walk(trace, 0, 0);
  return rows;
}

export function fmtMs(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtUsd(v: number): string {
  if (v === 0) return "$0";
  return v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

export type Tone = "ok" | "bad" | "warn" | "muted";

export function stepTone(status: TraceNode["status"]): Tone {
  return status === "ok" ? "ok" : status === "failed" ? "bad" : status === "waiting" ? "warn" : "muted";
}

// ---- incidents -----------------------------------------------------------

export interface Incident {
  id: string;
  agentName: string;
  kind: string;
  severity: "page" | "ticket";
  status: "open" | "acknowledged" | "resolved";
  title: string;
  summary: string;
  summarySource: "deterministic" | "model";
  firstBadVersion?: string;
  lastGoodVersion?: string;
  suspectedCause: string;
  affectedRunIds: string[];
  evidence: Record<string, unknown>;
  rollback: { suggested: boolean; agent?: string; fromVersion?: string; toVersion?: string; reason?: string };
  openedAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  timeline?: { at: string; actor: string; action: string; detail?: string }[];
}

/** Which actions the server will accept next (mirrors the 409 rules). */
export function incidentActions(status: Incident["status"]): ("acknowledge" | "resolve")[] {
  return status === "open" ? ["acknowledge", "resolve"] : status === "acknowledged" ? ["resolve"] : [];
}

export function incidentTone(i: Pick<Incident, "severity" | "status">): Tone {
  if (i.status === "resolved") return "muted";
  return i.severity === "page" ? "bad" : "warn";
}

/** "anomaly:cost" → "Cost anomaly", "slo:success" → "Success SLO burn". */
export function kindLabel(kind: string): string {
  const [family, what = ""] = kind.split(":");
  const w = what.replace(/_/g, " ");
  const cap = w.charAt(0).toUpperCase() + w.slice(1);
  return family === "slo" ? `${cap} SLO burn` : `${cap} anomaly`;
}

// ---- SLO / prod evals ----------------------------------------------------

export interface SliStatus {
  name: string;
  target: string;
  good: number;
  total: number;
  attainment: number;
  budgetRemaining: number;
  burnRates: { window: string; burn: number; events: number }[];
  alerts: { severity: "page" | "ticket"; longBurn: number; shortBurn: number; rule: string }[];
  measured?: number;
  measuredLabel?: string;
}

export interface VersionDrift {
  version: string;
  n: number;
  meanScore: number;
  passRate: number;
  deltaVsPrev?: number;
  drifted: boolean;
}

/** Error budget bar: clamp to 0..100 for display; the sign is shown in text. */
export function budgetPct(remaining: number): number {
  return Math.round(Math.min(Math.max(remaining, 0), 1) * 100);
}

export function budgetTone(remaining: number): Tone {
  return remaining < 0 ? "bad" : remaining < 0.25 ? "bad" : remaining < 0.5 ? "warn" : "ok";
}
