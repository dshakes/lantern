"use client";

// Run waterfall — renders a run's journal_events as a concurrency-revealing
// swimlane timeline. Spans (steps) are grouped into labeled horizontal lanes
// (Reasoning / LLM / Tool / Connector / Other) over a shared time scale, the
// AgentCore / Anthropic-console model. For each step we surface: name,
// duration, tokens (if it was an LLM call), cost (if computed), status.
//
// Design choices:
//
//   - Spans are grouped by stepId, then bucketed into lanes via laneFor()
//     (run-waterfall-lanes.ts) from the step's kind / name / sub-events —
//     there is no parentSpanId/depth on the wire, so lanes are derived.
//
//   - Within a lane, overlapping spans are split into sub-rows by greedy
//     interval partitioning so concurrent work reads side-by-side rather
//     than stacked on top of each other. Spans in different lanes at the
//     same time naturally read as parallel.
//
//   - The x-axis is normalized to [first event ts ... last event ts] so
//     short runs are still legible. For runs longer than 60s the unit
//     in the header switches from "ms" to "s" automatically.
//
//   - Retried steps (duplicate stepId, or an explicit `attempt`) collapse
//     into one bar with a "retried ×N" badge; prior attempts nest under it.
//
//   - Clicking a span expands a nested event list (LLM deltas, tool
//     calls, logs, reasoning text) for that step. Waterfall by default,
//     drill-down on demand.
//
//   - When the run is still streaming, the open span is rendered with
//     a moving shimmer so the user knows the bar will keep growing.

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  Wrench,
  Brain,
  FileText,
  AlertTriangle,
  ListTree,
  RotateCcw,
} from "lucide-react";
import clsx from "clsx";
import type { StreamEvent } from "@/lib/mock-data";
import {
  type Span,
  type Lane,
  type LaneId,
  buildLanes,
  groupRetries,
  isReasoning,
  reasoningText,
} from "./run-waterfall-lanes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunWaterfallProps {
  events: StreamEvent[];
  // Optional: when the run is still in-flight, "now" extends the open
  // span up to the current wall-clock so the bar visibly grows.
  running?: boolean;
  // If you have the agent's total cost / tokens, pass them so we can
  // render a totals row at the bottom — saves the user the math.
  totals?: {
    costUsd?: number;
    tokensIn?: number;
    tokensOut?: number;
  };
}

// Span is defined in run-waterfall-lanes.ts and imported above.

// ---------------------------------------------------------------------------
// Span extraction
// ---------------------------------------------------------------------------

// Walk the events in order, opening a span on step_started and closing
// on the next step_completed / step_failed with the same stepId. LLM /
// tool events that fall *inside* an open span attach to it and bump the
// token/cost aggregates.
function extractSpans(events: StreamEvent[]): {
  spans: Span[];
  startMs: number;
  endMs: number;
} {
  if (events.length === 0) {
    const now = Date.now();
    return { spans: [], startMs: now, endMs: now };
  }
  // Anchor times to the first event so the chart x-axis starts at 0.
  const sortedTs = [...events]
    .map((e) => new Date(e.ts).getTime())
    .sort((a, b) => a - b);
  const t0 = sortedTs[0];
  const tEnd = sortedTs[sortedTs.length - 1];

  const open = new Map<string, Span>();
  const closed: Span[] = [];

  for (const e of events) {
    const stepId = e.stepId;
    const tsMs = new Date(e.ts).getTime() - t0;

    if (e.kind === "step_started" && stepId) {
      open.set(stepId, {
        id: stepId,
        name: (e.data?.name as string) || stepId,
        startMs: tsMs,
        endMs: null,
        status: "running",
        events: [e],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      });
      continue;
    }

    if (e.kind === "step_completed" && stepId) {
      const span = open.get(stepId);
      if (span) {
        span.endMs = tsMs;
        span.status = "succeeded";
        span.events.push(e);
        closed.push(span);
        open.delete(stepId);
      }
      continue;
    }

    if (e.kind === "step_failed" && stepId) {
      const span = open.get(stepId);
      if (span) {
        span.endMs = tsMs;
        span.status = "failed";
        span.errorMessage =
          (e.data?.error as string) ||
          (e.data?.message as string) ||
          "step failed";
        span.events.push(e);
        closed.push(span);
        open.delete(stepId);
      }
      continue;
    }

    // For sub-events (llm_*, tool_*, log), attach to the open span if
    // we can find one. We don't reach back across closed spans.
    const target = stepId && open.get(stepId);
    if (target) {
      target.events.push(e);
      if (e.kind === "llm_complete") {
        target.tokensIn += Number(e.data?.tokensIn ?? e.data?.tokens_in ?? 0);
        target.tokensOut += Number(e.data?.tokensOut ?? e.data?.tokens_out ?? 0);
        target.costUsd += Number(e.data?.costUsd ?? e.data?.cost_usd ?? 0);
      }
    }
  }

  // Anything still open at the end of the event list is in-flight.
  for (const span of open.values()) {
    closed.push(span);
  }
  closed.sort((a, b) => a.startMs - b.startMs);
  return { spans: closed, startMs: 0, endMs: tEnd - t0 };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatCostUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function iconFor(kind: StreamEvent["kind"]) {
  switch (kind) {
    case "llm_complete":
    case "llm_delta":
      return <Brain className="h-3 w-3 text-violet-400" />;
    case "tool_call":
    case "tool_result":
      return <Wrench className="h-3 w-3 text-amber-400" />;
    case "log":
      return <FileText className="h-3 w-3 text-zinc-500" />;
    case "step_failed":
      return <AlertTriangle className="h-3 w-3 text-red-400" />;
    default:
      return <ListTree className="h-3 w-3 text-zinc-500" />;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// Per-lane bar styling. Lanes keep their bars' status semantics (success /
// fail / running) but the lane label + reasoning treatment are tinted by lane.
const LANE_ACCENT: Record<LaneId, string> = {
  reasoning: "text-violet-400",
  llm: "text-sky-400",
  tool: "text-amber-400",
  connector: "text-emerald-400",
  other: "text-zinc-400",
};

export function RunWaterfall({ events, running, totals }: RunWaterfallProps) {
  const { spans, endMs } = useMemo(() => extractSpans(events), [events]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Use a stable scale that includes the currently-open spans extending
  // up to now if the run is still streaming. Without this the rightmost
  // bar would visually jump every time a new event arrives.
  const scaleEnd = useMemo(() => {
    if (!running) return Math.max(endMs, 1);
    const openMax = spans
      .filter((s) => s.endMs == null)
      .reduce((acc, s) => Math.max(acc, s.startMs), endMs);
    return Math.max(openMax + 500, endMs);
  }, [endMs, spans, running]);

  // Collapse retries, then bucket into labeled, non-empty lanes; within each
  // lane split overlapping spans into sub-rows via greedy partitioning.
  const lanes = useMemo(
    () => buildLanes(groupRetries(spans), scaleEnd),
    [spans, scaleEnd],
  );

  if (spans.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-surface-1 p-6 text-center text-[12px] text-zinc-500">
        No structured spans yet — events will appear here as the run executes.
      </div>
    );
  }

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Lane labels stay pinned (sticky left) while the timeline scrolls
  // horizontally on narrow widths.
  const LABEL_W = "w-28";

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ListTree className="h-3.5 w-3.5 text-zinc-500" />
          <h3 className="text-[12px] font-semibold text-zinc-200">Trace</h3>
          <span className="text-[10px] text-zinc-500">
            {spans.length} span{spans.length === 1 ? "" : "s"} · {lanes.length} lane
            {lanes.length === 1 ? "" : "s"} · total {formatMs(scaleEnd)}
          </span>
        </div>
        {totals && (
          <div className="flex items-center gap-3 text-[11px] text-zinc-400">
            {(totals.tokensIn != null || totals.tokensOut != null) && (
              <span title="Tokens in / out">
                {formatTokens(totals.tokensIn ?? 0)} → {formatTokens(totals.tokensOut ?? 0)} tok
              </span>
            )}
            {totals.costUsd != null && (
              <span title="Total run cost in USD">
                {formatCostUsd(totals.costUsd)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Horizontal scroll on the timeline; lane labels stay pinned left. */}
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <TimeAxis scaleEnd={scaleEnd} labelW={LABEL_W} />
          <div className="divide-y divide-zinc-800/60">
            {lanes.map((lane) => (
              <LaneRow
                key={lane.meta.id}
                lane={lane}
                scaleEnd={scaleEnd}
                running={running}
                labelW={LABEL_W}
                accent={LANE_ACCENT[lane.meta.id]}
                expanded={expanded}
                onToggle={toggle}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time axis header — shared scale across all lanes.
// ---------------------------------------------------------------------------

function TimeAxis({ scaleEnd, labelW }: { scaleEnd: number; labelW: string }) {
  // 5 evenly-spaced ticks across the scale.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * scaleEnd);
  return (
    <div className="flex items-stretch border-b border-zinc-800 bg-surface-0/40 text-[9px] text-zinc-500">
      <div
        className={clsx(
          "sticky left-0 z-10 shrink-0 border-r border-zinc-800 bg-surface-1 px-3 py-1.5",
          labelW,
        )}
      >
        timeline
      </div>
      <div className="relative flex-1 py-1.5">
        {ticks.map((t, i) => (
          <span
            key={i}
            className={clsx(
              "absolute top-1.5 tabular-nums",
              i === ticks.length - 1 ? "-translate-x-full" : "",
            )}
            style={{ left: `${(t / scaleEnd) * 100}%` }}
          >
            {formatMs(t)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lane row — label + its sub-rows of bars.
// ---------------------------------------------------------------------------

function LaneRow({
  lane,
  scaleEnd,
  running,
  labelW,
  accent,
  expanded,
  onToggle,
}: {
  lane: Lane;
  scaleEnd: number;
  running?: boolean;
  labelW: string;
  accent: string;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  const count = lane.rows.reduce((n, r) => n + r.length, 0);
  return (
    <div className="flex items-stretch">
      <div
        className={clsx(
          "sticky left-0 z-10 flex shrink-0 flex-col justify-center gap-0.5 border-r border-zinc-800 bg-surface-1 px-3 py-2",
          labelW,
        )}
      >
        <span className={clsx("text-[10px] font-semibold uppercase tracking-wide", accent)}>
          {lane.meta.label}
        </span>
        <span className="text-[9px] tabular-nums text-zinc-600">
          {count} span{count === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex-1 divide-y divide-zinc-800/40">
        {lane.rows.map((row, i) => (
          <div key={i} className="py-0.5">
            {row.map((span) => (
              <LaneSpan
                key={span.id}
                span={span}
                scaleEnd={scaleEnd}
                running={running}
                laneId={lane.meta.id}
                expanded={expanded.has(span.id)}
                onToggle={() => onToggle(span.id)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// A single span positioned absolutely on the shared lane time scale. The whole
// row is one accessible toggle button; the bar floats inside the timeline track
// at [startMs..endMs]. Reasoning spans get the brain icon + violet treatment.
function LaneSpan({
  span,
  scaleEnd,
  running,
  laneId,
  expanded,
  onToggle,
}: {
  span: Span;
  scaleEnd: number;
  running?: boolean;
  laneId: LaneId;
  expanded: boolean;
  onToggle: () => void;
}) {
  const duration = (span.endMs ?? scaleEnd) - span.startMs;
  const open = span.endMs == null && running;
  const reasoning = laneId === "reasoning" || isReasoning(span);
  const retryCount = span.retries?.length ?? 0;

  const widthPct = (((span.endMs ?? scaleEnd) - span.startMs) / scaleEnd) * 100;
  const leftPct = (span.startMs / scaleEnd) * 100;

  const barColor = reasoning
    ? "bg-violet-500/25 border-violet-500/50"
    : span.status === "failed"
      ? "bg-red-500/40 border-red-500/60"
      : span.status === "succeeded"
        ? "bg-emerald-500/30 border-emerald-500/50"
        : "bg-lantern-500/30 border-lantern-500/50";

  const reasonText = expanded && reasoning ? reasoningText(span) : null;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group flex w-full items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-surface-2"
      >
        <span className="shrink-0 text-zinc-500">
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>

        <span className="shrink-0">
          {reasoning ? (
            <Brain className="h-3 w-3 text-violet-400" />
          ) : span.status === "running" ? (
            <Loader2 className="h-3 w-3 animate-spin text-lantern-400" />
          ) : span.status === "failed" ? (
            <XCircle className="h-3 w-3 text-red-400" />
          ) : (
            <CheckCircle2 className="h-3 w-3 text-emerald-400" />
          )}
        </span>

        {/* Absolutely-positioned timeline track on the shared scale. */}
        <div className="relative h-4 min-w-0 flex-1 rounded bg-surface-0">
          <div
            className={clsx(
              "absolute top-0 flex h-full items-center gap-1 overflow-hidden rounded border px-1.5",
              barColor,
              open && "animate-pulse",
            )}
            style={{
              left: `${leftPct}%`,
              width: `max(${Math.max(widthPct, 0)}%, 0.5rem)`,
            }}
          >
            <span
              className={clsx(
                "truncate text-[10px] font-medium",
                reasoning ? "text-violet-100" : "text-zinc-100",
              )}
            >
              {span.name}
            </span>
            {retryCount > 0 && (
              <span className="flex shrink-0 items-center gap-0.5 rounded bg-amber-500/20 px-1 text-[9px] font-semibold text-amber-300">
                <RotateCcw className="h-2.5 w-2.5" />×{retryCount + 1}
              </span>
            )}
          </div>
        </div>

        {/* Numeric badges — only render when non-zero so simple steps stay clean. */}
        <div className="flex shrink-0 items-center gap-2 text-[10px] tabular-nums text-zinc-500">
          {(span.tokensIn > 0 || span.tokensOut > 0) && (
            <span title="Tokens in / out">
              {formatTokens(span.tokensIn)}→{formatTokens(span.tokensOut)}
            </span>
          )}
          {span.costUsd > 0 && (
            <span title="Cost USD">{formatCostUsd(span.costUsd)}</span>
          )}
          <span className="w-12 text-right text-zinc-400">{formatMs(duration)}</span>
        </div>
      </button>

      {expanded && (
        <div className="space-y-1.5 border-y border-zinc-800 bg-surface-0 px-6 py-3">
          {span.errorMessage && (
            <div className="rounded border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-300">
              {span.errorMessage}
            </div>
          )}

          {reasonText && (
            <div className="flex items-start gap-2 rounded border border-violet-500/20 bg-violet-500/5 px-2 py-1.5">
              <Brain className="mt-0.5 h-3 w-3 shrink-0 text-violet-400" />
              <p className="min-w-0 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-violet-100/90">
                {reasonText.length > 600 ? `${reasonText.slice(0, 600)}…` : reasonText}
              </p>
            </div>
          )}

          {/* Prior retry attempts, nested + collapsible. */}
          {retryCount > 0 && <RetryAttempts attempts={span.retries ?? []} />}

          {span.events
            .filter(
              (e) =>
                e.kind !== "step_started" &&
                e.kind !== "step_completed" &&
                e.kind !== "step_failed",
            )
            .map((e, idx) => (
              <EventLine key={`${span.id}-${idx}`} event={e} />
            ))}
          {span.events.length <= 2 && !span.errorMessage && !reasonText && (
            <p className="text-[11px] text-zinc-500">
              No sub-events recorded for this span.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Collapsible list of the prior attempts of a retried step.
function RetryAttempts({ attempts }: { attempts: Span[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-amber-500/20 bg-amber-500/[0.04]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[10px] font-medium text-amber-300"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <RotateCcw className="h-2.5 w-2.5" />
        {attempts.length} earlier attempt{attempts.length === 1 ? "" : "s"}
      </button>
      {open && (
        <ul className="space-y-1 px-3 pb-2 pt-1">
          {attempts.map((a, i) => (
            <li
              key={`${a.id}-retry-${i}`}
              className="flex items-center gap-2 text-[10px] text-zinc-400"
            >
              {a.status === "failed" ? (
                <XCircle className="h-3 w-3 shrink-0 text-red-400" />
              ) : (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />
              )}
              <span className="tabular-nums text-zinc-500">#{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">
                {a.errorMessage || a.name}
              </span>
              <span className="shrink-0 tabular-nums text-zinc-500">
                {formatMs((a.endMs ?? a.startMs) - a.startMs)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EventLine({ event }: { event: StreamEvent }) {
  // We surface a one-line summary per event; full payload is available on
  // expand-click but typically the user only needs the kind + the most
  // meaningful field (model name, tool name, log message).
  const summary = useMemo(() => {
    const d = event.data ?? {};
    if (event.kind === "llm_complete") {
      const model = String(d.model ?? "");
      const tokens = (Number(d.tokensIn ?? d.tokens_in ?? 0) + Number(d.tokensOut ?? d.tokens_out ?? 0));
      return `${model || "model"} · ${tokens} tok`;
    }
    if (event.kind === "tool_call") {
      return `${d.tool ?? d.name ?? "tool"} called`;
    }
    if (event.kind === "tool_result") {
      const tool = d.tool ?? d.name ?? "tool";
      return `${tool} → ${typeof d.result === "string" ? (d.result as string).slice(0, 80) : "result"}`;
    }
    if (event.kind === "log") {
      return String(d.message ?? d.msg ?? "log");
    }
    return event.kind;
  }, [event]);

  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="mt-0.5 shrink-0">{iconFor(event.kind)}</span>
      <span className="min-w-0 flex-1 truncate text-zinc-300">{summary}</span>
    </div>
  );
}
