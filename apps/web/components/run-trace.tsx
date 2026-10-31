"use client";

// RunTrace — the per-run trace tree (ADR 0056): an interactive waterfall plus a
// nested tree of steps, LLM calls (model / tokens / cost / latency), tool calls
// (args + result, already redacted by the server), retries and child runs.
// Data: GET /v1/runs/{id}/trace. Secrets never reach the browser: redaction is
// server-side (invariant #10).

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ChevronRight, GitBranch, RotateCw, Wrench, Sparkles } from "lucide-react";
import { api, type RunTrace as Trace } from "@/lib/api";
import {
  fmtMs,
  fmtUsd,
  stepTone,
  waterfallRows,
  type Tone,
  type TraceNode,
} from "@/lib/observability";

const BAR: Record<Tone, string> = {
  ok: "bg-emerald-500/70",
  bad: "bg-red-500/80",
  warn: "bg-amber-500/70",
  muted: "bg-zinc-500/60",
};
const DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  bad: "bg-red-500",
  warn: "bg-amber-500",
  muted: "bg-zinc-500",
};

function KindIcon({ node }: { node: TraceNode }) {
  const cls = "h-3.5 w-3.5 shrink-0 text-zinc-500";
  if (node.llm) return <Sparkles className={cls} aria-label="LLM call" />;
  if (node.tool || node.type === "tool" || node.type === "connector") return <Wrench className={cls} aria-label="Tool call" />;
  if (node.childRun) return <GitBranch className={cls} aria-label="Child run" />;
  return <span className="h-3.5 w-3.5 shrink-0" />;
}

function StepDetail({ node }: { node: TraceNode }) {
  const row = "grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 text-xs";
  return (
    <div className="space-y-3 rounded-lg bg-surface-2 p-3 text-xs" data-testid="step-detail">
      <div className={row}>
        <span className="text-zinc-500">Step</span>
        <span className="font-mono text-zinc-300">{node.id}</span>
        <span className="text-zinc-500">Type</span>
        <span className="text-zinc-300">{node.type}</span>
        <span className="text-zinc-500">Duration</span>
        <span className="text-zinc-300">{fmtMs(node.durationMs)}</span>
      </div>
      {node.llm && (
        <div className={row}>
          <span className="text-zinc-500">Model</span>
          <span className="font-mono text-zinc-300">
            {[node.llm.provider, node.llm.model].filter(Boolean).join(" / ") || "unknown"}
          </span>
          <span className="text-zinc-500">Tokens</span>
          <span className="text-zinc-300">
            {node.llm.tokensIn.toLocaleString()} in / {node.llm.tokensOut.toLocaleString()} out
          </span>
          <span className="text-zinc-500">Cost</span>
          <span className="text-zinc-300">{fmtUsd(node.llm.costUsd)}</span>
          <span className="text-zinc-500">Latency</span>
          <span className="text-zinc-300">{fmtMs(node.llm.latencyMs)}</span>
        </div>
      )}
      {node.tool && (
        <div>
          <p className="mb-1 text-zinc-500">
            Tool <span className="font-mono text-zinc-300">{node.tool.name}</span> arguments (secrets redacted)
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-0 p-2 font-mono text-[11px] text-zinc-300">
            {JSON.stringify(node.tool.args ?? {}, null, 2)}
          </pre>
        </div>
      )}
      {node.retries && node.retries.length > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-1 text-amber-400">
            <RotateCw className="h-3 w-3" /> {node.retries.length} retr{node.retries.length === 1 ? "y" : "ies"}
          </p>
          <ul className="space-y-0.5 font-mono text-[11px] text-zinc-400">
            {node.retries.map((r) => (
              <li key={r.attempt}>
                attempt {r.attempt}: {r.error || "retried"}
              </li>
            ))}
          </ul>
        </div>
      )}
      {node.policyDenied && (
        <p role="note" className="rounded bg-amber-500/10 p-2 text-[11px] text-amber-300 break-words">
          Denied by agent policy: {node.policyDenied.kind} <span className="font-mono">{node.policyDenied.target}</span>
          {node.policyDenied.reason ? ` (${node.policyDenied.reason})` : ""}
        </p>
      )}
      {node.error && (
        <p className="rounded bg-red-500/10 p-2 font-mono text-[11px] text-red-300 break-words">{node.error}</p>
      )}
      {node.output && (
        <div>
          <p className="mb-1 text-zinc-500">Result</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-0 p-2 font-mono text-[11px] text-zinc-300">
            {node.output}
          </pre>
        </div>
      )}
      {node.childRun && (
        <Link href={`/runs/${node.childRun.runId}`} className="inline-block text-pal-400 hover:text-pal-300">
          Open child run {node.childRun.runId.slice(0, 8)}…
        </Link>
      )}
    </div>
  );
}

function Waterfall({ trace }: { trace: Trace }) {
  const rows = useMemo(() => waterfallRows(trace), [trace]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div role="list" aria-label="Trace waterfall" className="space-y-1">
      {rows.map((r) => {
        const tone = stepTone(r.node.status);
        const isOpen = open === r.key;
        return (
          <div key={r.key} role="listitem">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : r.key)}
              className="grid w-full grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 rounded px-1 py-1 text-left hover:bg-surface-2 sm:grid-cols-[minmax(0,13rem)_1fr_auto]"
            >
              <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${r.depth * 12}px` }}>
                <KindIcon node={r.node} />
                <span className="truncate text-xs text-zinc-300" title={r.node.name}>
                  {r.node.name}
                </span>
              </span>
              <span className="relative h-3 rounded bg-surface-3">
                <span
                  className={clsx("absolute top-0 h-3 rounded", BAR[tone])}
                  style={{ left: `${r.leftPct}%`, width: `${r.widthPct}%` }}
                />
              </span>
              <span className="w-14 text-right font-mono text-[11px] text-zinc-500">{fmtMs(r.node.durationMs)}</span>
            </button>
            {isOpen && (
              <div className="mb-1 ml-1 mt-1">
                <StepDetail node={r.node} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TreeNode({ node, depth }: { node: TraceNode; depth: number }) {
  const [open, setOpen] = useState(false);
  const tone = stepTone(node.status);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-surface-2"
      >
        <ChevronRight className={clsx("h-3 w-3 shrink-0 text-zinc-500 transition-transform", open && "rotate-90")} />
        <span className={clsx("h-2 w-2 shrink-0 rounded-full", DOT[tone])} aria-label={node.status} />
        <KindIcon node={node} />
        <span className="truncate text-xs text-zinc-200">{node.name}</span>
        {node.llm && <span className="ml-auto shrink-0 font-mono text-[11px] text-zinc-500">{fmtUsd(node.llm.costUsd)}</span>}
        <span className={clsx("shrink-0 font-mono text-[11px] text-zinc-500", !node.llm && "ml-auto")}>{fmtMs(node.durationMs)}</span>
      </button>
      {open && (
        <div className="ml-5 mt-1 mb-1">
          <StepDetail node={node} />
        </div>
      )}
      {node.childRun && (
        <ul className="ml-5 border-l border-zinc-800/60 pl-2">
          <li className="py-0.5 text-[11px] text-zinc-500">child run {node.childRun.runId.slice(0, 8)} · {node.childRun.status}</li>
          {node.childRun.steps.map((s) => (
            <TreeNode key={s.id} node={s} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function RunTrace({ runId, refreshKey }: { runId: string; refreshKey?: string }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"waterfall" | "tree">("waterfall");

  useEffect(() => {
    let live = true;
    api
      .getRunTrace(runId)
      .then((t) => live && (setTrace(t), setErr(null)))
      .catch((e) => live && setErr(e instanceof Error ? e.message : "Failed to load trace"));
    return () => {
      live = false;
    };
  }, [runId, refreshKey]);

  if (err) {
    return (
      <p className="rounded-lg border border-zinc-800 p-3 text-xs text-zinc-500" role="status">
        Trace unavailable: {err}
      </p>
    );
  }
  if (!trace) {
    return <div className="h-24 animate-pulse rounded-lg bg-surface-2" aria-label="Loading trace" />;
  }
  if (trace.steps.length === 0) {
    return (
      <p className="rounded-lg border border-zinc-800 p-3 text-xs text-zinc-500" role="status">
        No steps were recorded for this run, so there is nothing to trace yet.
      </p>
    );
  }
  const stat = (label: string, value: string) => (
    <div className="min-w-[4.5rem]">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-mono text-xs text-zinc-200">{value}</div>
    </div>
  );
  return (
    <section aria-label="Run trace" className="rounded-lg border border-zinc-800/60 bg-surface-1 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4">
          {stat("Steps", String(trace.totals.steps))}
          {stat("LLM calls", String(trace.totals.llmCalls))}
          {stat("Tool calls", String(trace.totals.toolCalls))}
          {stat("Retries", String(trace.totals.retries))}
          {stat("Duration", fmtMs(trace.durationMs))}
          {stat("Cost", fmtUsd(trace.costUsd))}
        </div>
        <div className="flex rounded-md bg-surface-2 p-0.5 text-xs" role="group" aria-label="Trace view">
          {(["waterfall", "tree"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={clsx(
                "rounded px-2.5 py-1 font-medium capitalize transition-colors",
                view === v ? "bg-surface-0 text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      {view === "waterfall" ? (
        <Waterfall trace={trace} />
      ) : (
        <ul className="space-y-0.5" aria-label="Trace tree">
          {trace.steps.map((s) => (
            <TreeNode key={s.id} node={s} depth={0} />
          ))}
        </ul>
      )}
    </section>
  );
}
