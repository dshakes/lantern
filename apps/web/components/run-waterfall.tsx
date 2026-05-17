"use client";

// Run waterfall — renders a run's journal_events as a Gantt-style timeline
// of nested spans (steps). For each step we surface: name, duration,
// tokens (if it was an LLM call), cost (if computed), status.
//
// Design choices:
//
//   - Spans are grouped by stepId. Events with no stepId (or kind="end")
//     are treated as run-level events and rendered as a thin separator
//     above the span list.
//
//   - The x-axis is normalized to [first event ts ... last event ts] so
//     short runs are still legible. For runs longer than 60s the unit
//     in the header switches from "ms" to "s" automatically.
//
//   - Clicking a span expands a nested event list (LLM deltas, tool
//     calls, logs) for that step. This is the LangSmith/Inngest pattern:
//     waterfall by default, drill-down on demand.
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
} from "lucide-react";
import clsx from "clsx";
import type { StreamEvent } from "@/lib/mock-data";

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

interface Span {
  id: string;
  name: string;
  startMs: number;
  endMs: number | null; // null = still open
  status: "running" | "succeeded" | "failed";
  events: StreamEvent[];
  // Aggregates rolled up from the event payloads.
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  errorMessage?: string;
}

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

  if (spans.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-surface-1 p-6 text-center text-[12px] text-zinc-500">
        No structured spans yet — events will appear here as the run executes.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ListTree className="h-3.5 w-3.5 text-zinc-500" />
          <h3 className="text-[12px] font-semibold text-zinc-200">Trace</h3>
          <span className="text-[10px] text-zinc-500">
            {spans.length} span{spans.length === 1 ? "" : "s"} · total {formatMs(scaleEnd)}
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

      <ul className="divide-y divide-zinc-800">
        {spans.map((span) => (
          <SpanRow
            key={span.id}
            span={span}
            scaleEnd={scaleEnd}
            running={running}
            expanded={expanded.has(span.id)}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(span.id)) next.delete(span.id);
                else next.add(span.id);
                return next;
              })
            }
          />
        ))}
      </ul>
    </div>
  );
}

function SpanRow({
  span,
  scaleEnd,
  running,
  expanded,
  onToggle,
}: {
  span: Span;
  scaleEnd: number;
  running?: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const widthPct =
    ((span.endMs ?? scaleEnd) - span.startMs) / scaleEnd * 100;
  const leftPct = (span.startMs / scaleEnd) * 100;

  const duration = (span.endMs ?? scaleEnd) - span.startMs;
  const open = span.endMs == null && running;

  const barColor =
    span.status === "failed"
      ? "bg-red-500/40 border-red-500/60"
      : span.status === "succeeded"
        ? "bg-emerald-500/30 border-emerald-500/50"
        : "bg-lantern-500/30 border-lantern-500/50";

  return (
    <li>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <span className="shrink-0 text-zinc-500">
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </span>

        <span className="shrink-0">
          {span.status === "running" ? (
            <Loader2 className="h-3 w-3 animate-spin text-lantern-400" />
          ) : span.status === "failed" ? (
            <XCircle className="h-3 w-3 text-red-400" />
          ) : (
            <CheckCircle2 className="h-3 w-3 text-emerald-400" />
          )}
        </span>

        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-200">
          {span.name}
        </span>

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
          <span className="text-zinc-400">{formatMs(duration)}</span>
        </div>

        {/* Timeline bar — flex-basis fixed so the timeline area looks the same on every row. */}
        <div className="ml-2 hidden h-4 w-40 shrink-0 rounded bg-surface-0 sm:block">
          <div
            className={clsx(
              "h-full rounded border",
              barColor,
              open && "animate-pulse"
            )}
            style={{
              marginLeft: `${leftPct}%`,
              width: `${Math.max(widthPct, 1)}%`,
            }}
          />
        </div>
      </button>

      {expanded && (
        <div className="space-y-1.5 border-t border-zinc-800 bg-surface-0 px-6 py-3">
          {span.errorMessage && (
            <div className="rounded border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-300">
              {span.errorMessage}
            </div>
          )}
          {span.events
            .filter((e) => e.kind !== "step_started" && e.kind !== "step_completed" && e.kind !== "step_failed")
            .map((e, idx) => (
              <EventLine key={`${span.id}-${idx}`} event={e} />
            ))}
          {span.events.length <= 2 && !span.errorMessage && (
            <p className="text-[11px] text-zinc-500">
              No sub-events recorded for this span.
            </p>
          )}
        </div>
      )}
    </li>
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
