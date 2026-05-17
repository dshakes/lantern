"use client";

// Rehearsals panel — drop-in section for the agent detail page.
//
// Hits POST /v1/runs/rehearse to pull past failed (or low-feedback)
// runs as candidate replay cases against the agent's current version.
// The CLI / SDK then actually re-executes each input and posts results
// to /v1/eval-runs, which gates the merge via the existing eval-in-CI
// machinery. This UI is the *discovery* surface: see what would be
// replayed before kicking off the rehearsal.

import { useState } from "react";
import Link from "next/link";
import {
  Repeat,
  AlertTriangle,
  ThumbsDown,
  Clock,
  Loader2,
} from "lucide-react";
import clsx from "clsx";
import { api, type RehearseCase, type RehearseResponse } from "@/lib/api";

const ReplayIcon = Repeat;

interface Props {
  agentName: string;
}

const WINDOW_OPTIONS = [
  { value: "1d", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

export function RehearsalsPanel({ agentName }: Props) {
  const [window, setWindow] = useState("7d");
  const [limit, setLimit] = useState(25);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RehearseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.rehearse({
        agentName,
        window,
        limit,
        includeFailures: true,
        includeLowScore: true,
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch rehearsal cases");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="space-y-4 rounded-xl border border-zinc-800 bg-surface-1 p-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Rehearsals</h3>
          <p className="mt-0.5 max-w-prose text-[12px] text-zinc-500 leading-relaxed">
            Pull past failed runs and runs you marked down as a synthetic test
            set. Run them against the current version to catch regressions on
            inputs that actually broke the agent in production.
          </p>
        </div>
        <ReplayIcon className="h-4 w-4 shrink-0 text-zinc-500" />
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-[11px] font-medium text-zinc-400">Window</label>
          <select
            value={window}
            onChange={(e) => setWindow(e.target.value)}
            className="mt-1 rounded-md border border-zinc-800 bg-surface-0 px-2 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
          >
            {WINDOW_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-medium text-zinc-400">Max cases</label>
          <input
            type="number"
            value={limit}
            min={1}
            max={200}
            onChange={(e) => setLimit(Math.max(1, Math.min(200, parseInt(e.target.value || "25", 10))))}
            className="mt-1 w-20 rounded-md border border-zinc-800 bg-surface-0 px-2 py-1.5 text-[12px] text-zinc-200 outline-none focus:border-lantern-500/40"
          />
        </div>
        <button
          onClick={run}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md bg-lantern-500 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ReplayIcon className="h-3.5 w-3.5" />
          )}
          Find cases
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[12px] text-zinc-400">
            <span>
              <span className="font-semibold text-zinc-200">{result.count}</span> case{result.count === 1 ? "" : "s"} found in last {result.window}
            </span>
            {result.reason && (
              <span className="text-zinc-500">— {result.reason}</span>
            )}
          </div>
          {result.cases.length > 0 && (
            <ul className="divide-y divide-zinc-800 overflow-hidden rounded-lg border border-zinc-800">
              {result.cases.map((c) => (
                <RehearseRow key={c.originalRunId} c={c} />
              ))}
            </ul>
          )}
          <p className="text-[11px] text-zinc-500">
            To actually re-execute these cases, run{" "}
            <code className="rounded bg-surface-0 px-1 text-zinc-300">lantern test --rehearse --agent={agentName}</code>
            {" "}from your terminal. Results post back via{" "}
            <code className="rounded bg-surface-0 px-1 text-zinc-300">/v1/eval-runs</code> and gate merges via
            the existing eval baseline.
          </p>
        </div>
      )}
    </section>
  );
}

function RehearseRow({ c }: { c: RehearseCase }) {
  const isLowScore = c.originalScore != null && c.originalScore <= 2;
  return (
    <li className="px-4 py-2.5">
      <Link
        href={`/runs/${c.originalRunId}`}
        className="flex items-center gap-3 transition-colors hover:bg-surface-2"
      >
        {c.originalStatus === "failed" ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />
        ) : isLowScore ? (
          <ThumbsDown className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        ) : (
          <Clock className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[11px] text-zinc-300">
            {c.originalRunId}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-zinc-500">
            {c.originalStatus === "failed"
              ? "Failed in production"
              : isLowScore
                ? `Marked down (score ${c.originalScore}/5)`
                : `Status: ${c.originalStatus}`}
            <span className="mx-1 text-zinc-700">·</span>
            {new Date(c.originalAt).toLocaleString()}
          </p>
        </div>
        <span
          className={clsx(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
            c.originalStatus === "failed"
              ? "bg-red-500/10 text-red-300"
              : isLowScore
                ? "bg-amber-500/10 text-amber-300"
                : "bg-zinc-700/40 text-zinc-400"
          )}
        >
          ${c.originalCostUsd.toFixed(4)}
        </span>
      </Link>
    </li>
  );
}
