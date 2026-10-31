"use client";

import { useState } from "react";
import { Check, X, ChevronDown, ChevronRight, ShieldAlert, Wrench } from "lucide-react";
import clsx from "clsx";
import type {
  EvalAssertion,
  EvalCaseDelta,
  EvalCaseResult,
  EvalSample,
} from "@/lib/api";
import { fmtDelta, fmtUsd } from "@/lib/eval-format";

/** What the result view needs; satisfied by both a fresh run (200/422) and GET /v1/eval-runs/{id}. */
export interface RunView {
  score: number;
  passed: boolean;
  casesTotal: number;
  casesPassed: number;
  caseResults: EvalCaseResult[];
  regressed?: boolean;
  baselineScore?: number | null;
  regressedCases?: string[] | null;
  flakyCases?: string[] | null;
  caseDeltas?: EvalCaseDelta[] | null;
  totalCostUsd: number;
  agentCostUsd?: number;
  judgeCostUsd?: number;
  judgeModel?: string;
  agentModels?: string[] | null;
  pinnedBaseline?: boolean;
  stoppedEarly?: string;
}

export function Pill({
  tone,
  children,
}: {
  tone: "ok" | "bad" | "warn" | "muted";
  children: React.ReactNode;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone === "ok" && "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
        tone === "bad" && "border-red-500/20 bg-red-500/10 text-red-400",
        tone === "warn" && "border-amber-500/20 bg-amber-500/10 text-amber-400",
        tone === "muted" && "border-zinc-700 bg-surface-2 text-zinc-400",
      )}
    >
      {children}
    </span>
  );
}

/** Minimal polyline of scores oldest-first. Theme token stroke. */
export function ScoreTrend({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const W = 100;
  const H = 28;
  const min = Math.min(...values);
  const range = Math.max(...values) - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * W).toFixed(2)},${(H - ((v - min) / range) * H).toFixed(2)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-10 w-full text-violet-400" aria-hidden>
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="truncate font-mono text-sm tabular-nums text-zinc-100">{value}</p>
    </div>
  );
}

function Json({ v }: { v: unknown }) {
  return (
    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-[11px] text-zinc-300">
      {typeof v === "string" ? v : JSON.stringify(v, null, 2)}
    </pre>
  );
}

function AssertionRow({ a }: { a: EvalAssertion }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-surface-0 p-2">
      <div className="flex flex-wrap items-center gap-2">
        {a.skipped ? (
          <Pill tone="muted">skipped</Pill>
        ) : a.passed ? (
          <Pill tone="ok">
            <Check className="h-3 w-3" /> pass
          </Pill>
        ) : (
          <Pill tone="bad">
            <X className="h-3 w-3" /> fail
          </Pill>
        )}
        <span className="font-mono text-xs text-zinc-200">{a.kind}</span>
        <span className="font-mono text-[11px] text-zinc-500">
          score {a.score.toFixed(2)}
          {a.stddev ? ` ±${a.stddev.toFixed(2)}` : ""}
          {a.samples ? ` · ${a.samples} judge samples` : ""}
          {a.model ? ` · ${a.model}` : ""}
        </span>
        {a.injectionSuspected && (
          <Pill tone="warn">
            <ShieldAlert className="h-3 w-3" /> injection suspected
          </Pill>
        )}
      </div>
      {a.detail && <p className="mt-1 break-words text-xs text-zinc-400">{a.detail}</p>}
      {a.rationale && (
        <p className="mt-1 break-words text-xs italic text-zinc-400">Judge: {a.rationale}</p>
      )}
    </div>
  );
}

function SampleView({ s, idx }: { s: EvalSample; idx: number }) {
  return (
    <div className="space-y-2 rounded-md border border-zinc-800 p-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <span className="font-medium text-zinc-300">Sample {idx + 1}</span>
        {s.passed ? <Pill tone="ok">pass</Pill> : <Pill tone="bad">fail</Pill>}
        <span className="font-mono">
          {s.score.toFixed(2)} · {s.latencyMs}ms · {fmtUsd(s.costUsd)}
          {s.model ? ` · ${s.model}` : ""}
        </span>
      </div>
      {s.error && <p className="break-words text-xs text-red-400">{s.error}</p>}
      {s.output && <Json v={s.output} />}
      {s.toolCalls && s.toolCalls.length > 0 && (
        <ol className="space-y-1">
          {s.toolCalls.map((t, i) => (
            <li key={i} className="rounded bg-surface-2 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Wrench className="h-3 w-3 text-zinc-500" />
                <span className="break-all font-mono text-xs text-zinc-200">{t.tool}</span>
                <Pill tone={t.mocked ? "muted" : "warn"}>{t.mocked ? "mocked" : "not mocked"}</Pill>
                {t.error && <Pill tone="bad">error</Pill>}
              </div>
              {t.args && Object.keys(t.args).length > 0 && <Json v={t.args} />}
              {t.error ? (
                <p className="mt-1 break-words text-xs text-red-400">{t.error}</p>
              ) : t.result !== undefined ? (
                <Json v={t.result} />
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {s.assertions && s.assertions.length > 1 && (
        <div className="space-y-1">
          {s.assertions.map((a, i) => (
            <AssertionRow key={i} a={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function CaseRow({ c, delta }: { c: EvalCaseResult; delta?: EvalCaseDelta }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="rounded-lg border border-zinc-800 bg-surface-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        <Chevron className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 break-all font-mono text-xs text-zinc-100">{c.name}</span>
        {c.passed ? <Pill tone="ok">pass</Pill> : <Pill tone="bad">fail</Pill>}
        {c.flaky && <Pill tone="warn">flaky</Pill>}
        {delta?.regressed && <Pill tone="bad">regressed</Pill>}
        <span className="font-mono text-xs tabular-nums text-zinc-300">
          {c.score.toFixed(2)}
          {c.stddev ? <span className="text-zinc-500"> ±{c.stddev.toFixed(2)}</span> : null}
        </span>
        {delta && (
          <span
            className={clsx(
              "font-mono text-xs tabular-nums",
              delta.delta < 0 ? "text-red-400" : delta.delta > 0 ? "text-emerald-400" : "text-zinc-500",
            )}
            title={`baseline ${delta.baselineScore.toFixed(2)}`}
          >
            {fmtDelta(delta.delta)}
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-3 border-t border-zinc-800 p-3">
          <p className="font-mono text-[11px] text-zinc-500">
            {c.passRate != null ? `pass rate ${(c.passRate * 100).toFixed(0)}% · ` : ""}
            {c.samples?.length ? `${c.samples.length} sample${c.samples.length === 1 ? "" : "s"} · ` : ""}
            agent {fmtUsd(c.costUsd)} · judge {fmtUsd(c.judgeCostUsd)}
          </p>
          {c.error && <p className="break-words text-xs text-red-400">{c.error}</p>}
          {c.assertions && c.assertions.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-wide text-zinc-500">Assertions</p>
              {c.assertions.map((a, i) => (
                <AssertionRow key={i} a={a} />
              ))}
            </div>
          )}
          {c.samples && c.samples.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-wide text-zinc-500">Samples & tool trajectory</p>
              {c.samples.map((s, i) => (
                <SampleView key={i} s={s} idx={i} />
              ))}
            </div>
          ) : (
            c.actual && (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-zinc-500">Output</p>
                <Json v={c.actual} />
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

export function RunResultView({ run }: { run: RunView }) {
  const deltas = new Map((run.caseDeltas ?? []).map((d) => [d.name, d]));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {run.passed ? <Pill tone="ok">All cases pass</Pill> : <Pill tone="bad">Failing cases</Pill>}
        {run.regressed && <Pill tone="bad">Regressed vs baseline (422)</Pill>}
        {(run.flakyCases?.length ?? 0) > 0 && <Pill tone="warn">{run.flakyCases!.length} flaky</Pill>}
        {run.pinnedBaseline && <Pill tone="ok">Pinned as baseline</Pill>}
        {run.stoppedEarly && <Pill tone="warn">Stopped early: {run.stoppedEarly}</Pill>}
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-xl border border-zinc-800 bg-surface-1 p-4 sm:grid-cols-4">
        <Stat label="Score" value={run.score.toFixed(3)} />
        <Stat label="Cases" value={`${run.casesPassed}/${run.casesTotal}`} />
        <Stat
          label="Baseline"
          value={run.baselineScore != null ? run.baselineScore.toFixed(3) : "—"}
        />
        <Stat label="Total cost" value={fmtUsd(run.totalCostUsd)} />
        {run.agentCostUsd != null && <Stat label="Agent cost" value={fmtUsd(run.agentCostUsd)} />}
        {run.judgeCostUsd != null && <Stat label="Judge cost" value={fmtUsd(run.judgeCostUsd)} />}
        {run.judgeModel && <Stat label="Judge model" value={run.judgeModel} />}
        {run.agentModels && run.agentModels.length > 0 && (
          <Stat label="Agent model" value={run.agentModels.join(", ")} />
        )}
      </div>

      {(run.regressedCases?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
          <span className="font-medium">Regressed cases: </span>
          <span className="break-all font-mono">{run.regressedCases!.join(", ")}</span>
        </div>
      )}

      <div className="space-y-2">
        {run.caseResults.map((c) => (
          <CaseRow key={c.name} c={c} delta={deltas.get(c.name)} />
        ))}
      </div>
    </div>
  );
}
