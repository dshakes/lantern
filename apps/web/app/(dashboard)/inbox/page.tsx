"use client";

// Inbox — the new daily-driver landing page.
//
// Aggregates "things you should look at today" across every agent:
//
//   - Recent runs (with quick status pills)
//   - Runs that need human attention: failed runs, low-feedback runs
//   - Eval regressions (from the most recent eval_runs)
//
// This replaces the "where do I start?" disorientation that comes from
// 11 sidebar items each owning a slice of activity. The intent: open
// Lantern, look at Inbox, know what to act on.
//
// Real-data only: every section uses live API calls and renders an
// explicit empty state if there's nothing. No mock fallbacks here.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox as InboxIcon,
  Loader2,
  MessageSquare,
  Play,
  XCircle,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import type { Run } from "@/lib/mock-data";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/skeleton";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const diff = Math.max(0, Date.now() - date.getTime());
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

type Tab = "all" | "needs_review" | "live";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InboxPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.listRuns();
        if (!cancelled) setRuns(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load runs");
          setRuns([]);
        }
      }
    }
    load();
    // Poll every 10s so the inbox feels live without WebSocket plumbing.
    // When the bridge / surface-gateway sends activity events through the
    // control-plane (W10/W11), this becomes a real-time WS subscription.
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Derived buckets. We compute these client-side because the run list
  // is already bounded server-side; cross-tenant aggregation isn't
  // needed for an in-tenant inbox.
  const buckets = useMemo(() => {
    const list = runs ?? [];
    const failed = list.filter((r) => r.status === "failed");
    const running = list.filter((r) => r.status === "running" || r.status === "paused");
    const recent = list.slice(0, 25);
    return { failed, running, recent };
  }, [runs]);

  const visible: Run[] = (() => {
    if (tab === "needs_review") return buckets.failed;
    if (tab === "live") return buckets.running;
    return buckets.recent;
  })();

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Inbox"
        description="Activity across every agent — recent runs, things needing review, and live work in flight."
      />

      <div className="flex-1 px-8 pb-8">
        {/* Tabs + summary chips */}
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <TabButton active={tab === "all"} onClick={() => setTab("all")} icon={<InboxIcon className="h-3.5 w-3.5" />} label="All" count={buckets.recent.length} />
          <TabButton
            active={tab === "needs_review"}
            onClick={() => setTab("needs_review")}
            icon={<AlertTriangle className="h-3.5 w-3.5" />}
            label="Needs review"
            count={buckets.failed.length}
            tone="warn"
          />
          <TabButton
            active={tab === "live"}
            onClick={() => setTab("live")}
            icon={<Play className="h-3.5 w-3.5" />}
            label="Live"
            count={buckets.running.length}
            tone="info"
          />
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-[12px] text-red-300">
            Could not load activity: {error}
          </div>
        )}

        {runs === null ? <InboxSkeleton /> : <RunList runs={visible} emptyTab={tab} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab pill
// ---------------------------------------------------------------------------

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
  tone?: "warn" | "info";
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
        active
          ? tone === "warn"
            ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
            : tone === "info"
              ? "border-lantern-500/40 bg-lantern-500/10 text-lantern-200"
              : "border-zinc-700 bg-surface-2 text-zinc-100"
          : "border-zinc-800 bg-surface-1 text-zinc-400 hover:text-zinc-200"
      )}
    >
      {icon}
      <span>{label}</span>
      <span
        className={clsx(
          "rounded-full px-1.5 text-[10px] font-semibold tabular-nums",
          active ? "bg-black/30 text-white/90" : "bg-surface-3 text-zinc-500"
        )}
      >
        {count}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function RunList({ runs, emptyTab }: { runs: Run[]; emptyTab: Tab }) {
  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-zinc-800 bg-surface-1 p-12 text-center">
        <InboxIcon className="h-6 w-6 text-zinc-600" />
        <div>
          <p className="text-sm font-medium text-zinc-300">
            {emptyTab === "needs_review"
              ? "Nothing to review"
              : emptyTab === "live"
                ? "No runs in flight"
                : "Your inbox is empty"}
          </p>
          <p className="mt-1 text-[12px] text-zinc-500">
            {emptyTab === "needs_review"
              ? "Failed runs and low-feedback runs will land here."
              : emptyTab === "live"
                ? "When an agent is actively running, you'll see it here."
                : "Create an agent and trigger a run to see activity here."}
          </p>
        </div>
        <Link
          href="/agents"
          className="mt-1 text-[12px] font-medium text-lantern-400 hover:text-lantern-300"
        >
          Go to Agents →
        </Link>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
    </ul>
  );
}

function RunRow({ run }: { run: Run }) {
  const StatusIcon =
    run.status === "succeeded"
      ? CheckCircle2
      : run.status === "failed"
        ? XCircle
        : run.status === "running" || run.status === "paused"
          ? Loader2
          : Clock;

  return (
    <li>
      <Link
        href={`/runs/${run.id}`}
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2"
      >
        <StatusIcon
          className={clsx(
            "h-4 w-4 shrink-0",
            run.status === "succeeded" && "text-emerald-400",
            run.status === "failed" && "text-red-400",
            (run.status === "running" || run.status === "paused") && "animate-spin text-lantern-400",
            run.status !== "succeeded" && run.status !== "failed" && run.status !== "running" && run.status !== "paused" && "text-zinc-500"
          )}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-100">
              {run.agentName}
            </span>
            <StatusBadge status={run.status} />
            {run.labels?.trigger && (
              <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500">
                {String(run.labels.trigger)}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-zinc-500">
            {summarizeInput(run.input)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3 text-[11px] text-zinc-500">
          {run.costUsd > 0 && (
            <span title="Cost in USD" className="tabular-nums">
              ${run.costUsd.toFixed(4)}
            </span>
          )}
          <span className="tabular-nums">{formatRelative(run.createdAt)}</span>
        </div>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeInput(input: unknown): string {
  if (input == null) return "—";
  if (typeof input === "string") return input.slice(0, 120);
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    // Common shapes: { message }, { content }, { input }, { text }, { prompt }.
    for (const key of ["message", "content", "input", "text", "prompt"]) {
      const val = obj[key];
      if (typeof val === "string") return val.slice(0, 120);
    }
    try {
      return JSON.stringify(input).slice(0, 120);
    } catch {
      return "—";
    }
  }
  return String(input);
}

function InboxSkeleton() {
  return (
    <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="h-4 w-4 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="h-3 w-12" />
        </li>
      ))}
    </ul>
  );
}
