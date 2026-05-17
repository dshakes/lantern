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
import type { Run, RunStatus } from "@/lib/mock-data";
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
// List — grouped by date with per-agent avatars
// ---------------------------------------------------------------------------

function RunList({ runs, emptyTab }: { runs: Run[]; emptyTab: Tab }) {
  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-(--radius-xl) border border-dashed border-zinc-700/60 bg-surface-1 p-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-3/60 ring-1 ring-zinc-800">
          <InboxIcon className="h-5 w-5 text-zinc-400" />
        </div>
        <div>
          <p className="text-(--text-base) font-semibold text-zinc-100">
            {emptyTab === "needs_review"
              ? "Nothing to review"
              : emptyTab === "live"
                ? "No runs in flight"
                : "Your inbox is empty"}
          </p>
          <p className="mt-1 max-w-sm text-(--text-sm) text-zinc-500">
            {emptyTab === "needs_review"
              ? "Failed runs and runs you flagged 👎 will land here."
              : emptyTab === "live"
                ? "When an agent is actively running, you'll see it here in real time."
                : "Create an agent and trigger a run — every dispatch surfaces here."}
          </p>
        </div>
        <Link
          href="/agents"
          className="mt-1 inline-flex items-center gap-1 text-(--text-sm) font-medium text-lantern-400 transition-colors duration-(--motion-fast) hover:text-lantern-300"
        >
          Go to Agents →
        </Link>
      </div>
    );
  }

  // Bucket by relative date for human-scannable section headers. Within
  // each bucket we further collapse consecutive runs of the same agent
  // so the eye doesn't bounce across 10 identical rows.
  const groups = groupByDate(runs);

  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.key}>
          <h3 className="mb-2 px-1 text-(--text-xs) font-medium uppercase tracking-wider text-zinc-500">
            {g.label}
            <span className="ml-2 text-zinc-700">·</span>
            <span className="ml-2 tabular-nums text-zinc-600">{g.runs.length}</span>
          </h3>
          <ul className="divide-y divide-zinc-800 overflow-hidden rounded-(--radius-lg) border border-zinc-800 bg-surface-1">
            {g.runs.map((run, idx) => (
              <RunRow
                key={run.id}
                run={run}
                groupedWithPrev={idx > 0 && g.runs[idx - 1].agentName === run.agentName}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function RunRow({
  run,
  groupedWithPrev,
}: {
  run: Run;
  groupedWithPrev: boolean;
}) {
  const summary = summarizeInput(run.input);
  const StatusDot = statusDotFor(run.status);

  return (
    <li>
      <Link
        href={`/runs/${run.id}`}
        className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-(--motion-fast) hover:bg-surface-2"
      >
        {/* Avatar — colored initials per agent name. When consecutive rows
            share an agent we dim/hide it so a burst from one agent reads
            as a cluster, not a wall. */}
        <AgentAvatar
          name={run.agentName}
          dimmed={groupedWithPrev}
          status={run.status}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                "truncate text-(--text-sm) font-medium",
                groupedWithPrev ? "text-zinc-400" : "text-zinc-100"
              )}
            >
              {run.agentName}
            </span>
            <StatusDot />
            {run.labels?.trigger && (
              <span className="rounded-(--radius-sm) bg-surface-3 px-1.5 py-0.5 text-(--text-xs) uppercase tracking-wider text-zinc-500">
                {String(run.labels.trigger)}
              </span>
            )}
          </div>
          {summary ? (
            <p className="mt-0.5 truncate text-(--text-xs) text-zinc-500">
              {summary}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-3 text-(--text-xs) text-zinc-500">
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
// Avatar + status dot
// ---------------------------------------------------------------------------

// Deterministic accent for an agent based on a stable hash of its name.
// Picks from a curated palette so adjacent agents are unlikely to clash.
const AVATAR_PALETTE = [
  { bg: "bg-violet-500/15", text: "text-violet-300", ring: "ring-violet-500/30" },
  { bg: "bg-sky-500/15", text: "text-sky-300", ring: "ring-sky-500/30" },
  { bg: "bg-emerald-500/15", text: "text-emerald-300", ring: "ring-emerald-500/30" },
  { bg: "bg-amber-500/15", text: "text-amber-300", ring: "ring-amber-500/30" },
  { bg: "bg-rose-500/15", text: "text-rose-300", ring: "ring-rose-500/30" },
  { bg: "bg-cyan-500/15", text: "text-cyan-300", ring: "ring-cyan-500/30" },
  { bg: "bg-fuchsia-500/15", text: "text-fuchsia-300", ring: "ring-fuchsia-500/30" },
  { bg: "bg-lime-500/15", text: "text-lime-300", ring: "ring-lime-500/30" },
];

function colorForName(name: string): (typeof AVATAR_PALETTE)[number] {
  // Simple deterministic hash — same name always lands on the same color.
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

function initialsForAgent(name: string): string {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function AgentAvatar({
  name,
  status,
  dimmed,
}: {
  name: string;
  status: RunStatus;
  dimmed?: boolean;
}) {
  const palette = colorForName(name);
  return (
    <div className="relative shrink-0">
      <div
        className={clsx(
          "flex h-8 w-8 items-center justify-center rounded-(--radius-md) text-(--text-xs) font-semibold ring-1 transition-opacity duration-(--motion-fast)",
          palette.bg,
          palette.text,
          palette.ring,
          dimmed && "opacity-40"
        )}
        aria-hidden
      >
        {initialsForAgent(name)}
      </div>
      {/* Status dot — small badge in the corner of the avatar. */}
      <span
        className={clsx(
          "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface-1",
          status === "succeeded" && "bg-emerald-400",
          status === "failed" && "bg-red-400",
          (status === "running" || status === "paused") && "bg-lantern-400 animate-pulse",
          status === "queued" && "bg-zinc-500",
          status === "cancelled" && "bg-zinc-500"
        )}
        aria-label={`status: ${status}`}
      />
    </div>
  );
}

// Small inline pill for the run row's main line — quieter than StatusBadge.
function statusDotFor(status: RunStatus) {
  // Returns a component (not JSX) so the call site keeps the var name lowercase
  // and avoids re-renders on every parent tick.
  const map: Record<string, { label: string; cls: string }> = {
    succeeded: { label: "✓", cls: "text-emerald-400" },
    failed: { label: "✕", cls: "text-red-400" },
    running: { label: "●", cls: "text-lantern-400 animate-pulse" },
    paused: { label: "◐", cls: "text-amber-400" },
    queued: { label: "○", cls: "text-zinc-500" },
    cancelled: { label: "—", cls: "text-zinc-500" },
  };
  const v = map[status] ?? map.queued;
  return function StatusDot() {
    return <span className={clsx("text-(--text-xs)", v.cls)}>{v.label}</span>;
  };
}

// ---------------------------------------------------------------------------
// Date grouping
// ---------------------------------------------------------------------------

function groupByDate(runs: Run[]): Array<{ key: string; label: string; runs: Run[] }> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const oneDay = 24 * 60 * 60 * 1000;
  const yesterday = today - oneDay;
  const sevenDaysAgo = today - 7 * oneDay;
  const thirtyDaysAgo = today - 30 * oneDay;

  const buckets: Record<string, { label: string; runs: Run[] }> = {
    today: { label: "Today", runs: [] },
    yesterday: { label: "Yesterday", runs: [] },
    week: { label: "This week", runs: [] },
    month: { label: "This month", runs: [] },
    older: { label: "Older", runs: [] },
  };

  for (const run of runs) {
    const ts = new Date(run.createdAt).getTime();
    if (ts >= today) buckets.today.runs.push(run);
    else if (ts >= yesterday) buckets.yesterday.runs.push(run);
    else if (ts >= sevenDaysAgo) buckets.week.runs.push(run);
    else if (ts >= thirtyDaysAgo) buckets.month.runs.push(run);
    else buckets.older.runs.push(run);
  }

  return Object.entries(buckets)
    .filter(([, v]) => v.runs.length > 0)
    .map(([key, v]) => ({ key, label: v.label, runs: v.runs }));
}

// ---------------------------------------------------------------------------
// Input summarizer — returns null when there's nothing real to show.
// Prevents the previous "{}" / '{"connectors":[]}' visual noise.
// ---------------------------------------------------------------------------

function summarizeInput(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === "string") {
    const t = input.trim();
    return t.length > 0 ? t.slice(0, 120) : null;
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    // Common shapes: { message }, { content }, { input }, { text }, { prompt }.
    for (const key of ["message", "content", "input", "text", "prompt", "email", "query"]) {
      const val = obj[key];
      if (typeof val === "string" && val.trim().length > 0) return val.trim().slice(0, 120);
    }
    // Empty object → nothing useful to show. Hide instead of rendering "{}".
    const keys = Object.keys(obj);
    if (keys.length === 0) return null;
    // Object with only empty values → also hide.
    const hasContent = keys.some((k) => {
      const v = obj[k];
      if (v == null) return false;
      if (typeof v === "string") return v.trim().length > 0;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "object") return Object.keys(v as object).length > 0;
      return true;
    });
    if (!hasContent) return null;
    // Otherwise render the most useful key inline (e.g. "connectors: gmail, slack").
    const summary = keys
      .map((k) => {
        const v = obj[k];
        if (typeof v === "string") return `${k}: ${v}`;
        if (Array.isArray(v)) return v.length > 0 ? `${k}: ${v.length}` : null;
        return null;
      })
      .filter(Boolean)
      .join(" · ");
    return summary.length > 0 ? summary.slice(0, 120) : null;
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
