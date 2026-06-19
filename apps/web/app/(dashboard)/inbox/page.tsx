"use client";

// Mission Control — the cross-agent operations command center.
//
// One question, answered above the fold: "is my fleet healthy?" Everything is
// derived from the REAL run list (`api.listRuns()`) — per-agent success rate,
// $/day, cost/latency/error sparklines, live work, and a quiet alerts panel.
// No metric is fabricated: anything that can't be computed renders "—" (see
// lib/fleet-health.ts honesty guard).
//
// Layout follows the owner's bar — strong hierarchy + whitespace, progressive
// disclosure, ONE primary focus:
//   1. Command strip            — fleet-wide instrument panel (live, $/day, alerts)
//   2. Fleet health (centerpiece) — one row per agent, expand for recent runs
//   3. Alerts + budget rollup   — compact, secondary, only when something fires
//   4. Live + needs-review queue — compact, actionable
//   5. Activity feed (tab)      — the session-grouped feed, preserved behind a tab
//
// Reuses the Runtime Command Center aesthetic (Sparkline, dots, tokens). No
// new color system.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Gauge,
  Inbox as InboxIcon,
  Layers,
  Play,
  TrendingUp,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import type { Run, RunStatus } from "@/lib/mock-data";
import {
  groupRunsBySession,
  aggregateSession,
  type SessionGroup,
} from "@/lib/session-grouping";
import {
  computeFleetHealth,
  computeAlerts,
  summarizeFleet,
  sortFleet,
  normalizeSeries,
  DEFAULT_DAILY_BUDGET_USD,
  type AgentHealth,
  type Alert,
  type FleetSort,
} from "@/lib/fleet-health";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { AgentAvatar } from "@/components/agent-avatar";
import { Sparkline } from "../runtime/cockpit-ui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(d: Date | string | number | null): string {
  if (d == null) return "—";
  const date = typeof d === "number" ? new Date(d) : typeof d === "string" ? new Date(d) : d;
  const diff = Math.max(0, Date.now() - date.getTime());
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function usd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

type Section = "fleet" | "activity";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MissionControlPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("fleet");
  const [sort, setSort] = useState<FleetSort>("health");
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.listRuns();
        if (!cancelled) {
          setRuns(data);
          setLastUpdated(Date.now());
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load runs");
          setRuns((prev) => prev ?? []);
        }
      }
    }
    load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const fleet = useMemo(() => computeFleetHealth(runs ?? []), [runs]);
  const alerts = useMemo(() => computeAlerts(fleet), [fleet]);
  const summary = useMemo(() => summarizeFleet(fleet, alerts), [fleet, alerts]);
  const sortedFleet = useMemo(() => sortFleet(fleet, sort), [fleet, sort]);

  const queue = useMemo(() => {
    const list = runs ?? [];
    const live = list.filter((r) => r.status === "running" || r.status === "paused");
    const needsReview = list.filter((r) => r.status === "failed");
    return { live, needsReview };
  }, [runs]);

  const loading = runs === null;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Mission Control"
        description="Fleet-wide operations across every agent — health, spend, live work, and what needs you. All metrics derived from real runs."
      />

      <CommandStrip summary={summary} lastUpdated={lastUpdated} loading={loading} />

      <div className="flex-1 px-6 pb-10 pt-6 md:px-8">
        {/* Section switch — fleet is primary, activity feed preserved behind a tab. */}
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg bg-surface-2 p-0.5 text-xs" role="group" aria-label="View">
            <SectionTab active={section === "fleet"} onClick={() => setSection("fleet")} label="Fleet health" />
            <SectionTab active={section === "activity"} onClick={() => setSection("activity")} label="Activity feed" />
          </div>
        </div>

        {error && (
          <div className="mb-5 rounded-lg bg-red-500/[0.06] px-3 py-2.5 text-[12px] text-red-300/90">
            Could not refresh activity: {error}
          </div>
        )}

        {section === "fleet" ? (
          loading ? (
            <FleetSkeleton />
          ) : (
            <div className="grid grid-cols-1 gap-8 xl:grid-cols-[1fr_360px]">
              {/* Primary column — fleet health (the centerpiece). */}
              <div className="min-w-0">
                <FleetHealth fleet={sortedFleet} runs={runs ?? []} sort={sort} setSort={setSort} />
              </div>
              {/* Secondary column — alerts + compact queues. */}
              <aside className="flex flex-col gap-6">
                <AlertsPanel alerts={alerts} fleet={fleet} totalCostToday={summary.costTodayUsd} />
                <ActionQueue title="Live now" tone="info" runs={queue.live} emptyHint="No runs in flight." icon={<Play className="h-3.5 w-3.5" />} />
                <ActionQueue title="Needs review" tone="warn" runs={queue.needsReview} emptyHint="Nothing to review." icon={<AlertTriangle className="h-3.5 w-3.5" />} />
              </aside>
            </div>
          )
        ) : loading ? (
          <ActivitySkeleton />
        ) : (
          <ActivityFeed runs={(runs ?? []).slice(0, 50)} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command strip — fleet-wide instrument panel
// ---------------------------------------------------------------------------

function CommandStrip({
  summary,
  lastUpdated,
  loading,
}: {
  summary: ReturnType<typeof summarizeFleet>;
  lastUpdated: number;
  loading: boolean;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const agoS = Math.max(0, Math.round((Date.now() - lastUpdated) / 1000));

  const live = summary.liveRuns > 0;

  return (
    <div className="flex flex-wrap items-center gap-x-12 gap-y-3 border-b border-zinc-800/40 px-6 py-4 md:px-8">
      <div className="flex items-center gap-2">
        <span className="relative inline-flex h-1.5 w-1.5">
          {live && <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-emerald-500/70" />}
          <span className={clsx("relative inline-flex h-1.5 w-1.5 rounded-full", live ? "bg-emerald-500/80" : "bg-zinc-600")} />
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">{live ? "Live" : "Idle"}</span>
      </div>

      <Metric label="Agents" value={String(summary.agentCount)} />
      <Metric label="In flight" value={String(summary.liveRuns)} />
      <Metric label="Alerts" value={String(summary.alertCount)} tone={summary.alertCount > 0 ? "warn" : "neutral"} />

      <div className="flex items-baseline gap-2.5">
        <span className="text-[11px] uppercase tracking-wide text-zinc-500">Spend today</span>
        <span className="font-mono text-[15px] font-medium tabular-nums text-zinc-200">
          {usd(summary.costTodayUsd)}
          <span className="ml-0.5 text-[10px] font-normal text-zinc-500">/day</span>
        </span>
      </div>

      <div className="ml-auto flex items-center gap-3 text-[11px] text-zinc-500">
        <span className="tabular-nums">{loading ? "loading…" : `updated ${agoS}s ago`}</span>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</span>
      <span className={clsx("font-mono text-[15px] font-medium tabular-nums", tone === "warn" ? "text-amber-400/90" : "text-zinc-200")}>
        {value}
      </span>
    </div>
  );
}

function SectionTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "rounded-md px-3 py-1 font-medium transition-colors",
        active ? "bg-surface-0 text-zinc-100 shadow-sm" : "text-zinc-500 hover:text-zinc-300",
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Fleet health — the centerpiece. One expandable row per agent.
// ---------------------------------------------------------------------------

function FleetHealth({
  fleet,
  runs,
  sort,
  setSort,
}: {
  fleet: AgentHealth[];
  runs: Run[];
  sort: FleetSort;
  setSort: (s: FleetSort) => void;
}) {
  if (fleet.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl bg-surface-1 p-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2">
          <Gauge className="h-5 w-5 text-zinc-500" />
        </div>
        <div>
          <p className="text-sm font-medium text-zinc-200">No fleet activity yet</p>
          <p className="mt-1 max-w-sm text-xs text-zinc-500">
            Trigger a run and your agents&apos; health, spend, and trends populate here automatically.
          </p>
        </div>
        <Link href="/agents" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-lantern-400 transition-colors duration-150 hover:text-lantern-300">
          Go to Agents →
        </Link>
      </div>
    );
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Agent fleet
          <span className="ml-2 tabular-nums text-zinc-600">{fleet.length}</span>
        </h2>
        <div className="flex items-center rounded-lg bg-surface-2 p-0.5 text-xs">
          <SortToggle active={sort === "health"} onClick={() => setSort("health")} label="Health" />
          <SortToggle active={sort === "cost"} onClick={() => setSort("cost")} label="Cost" />
        </div>
      </div>
      <ul className="space-y-2">
        {fleet.map((a) => (
          <AgentHealthRow key={a.agentName} health={a} runs={runs} />
        ))}
      </ul>
    </section>
  );
}

function SortToggle({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "rounded-md px-2.5 py-1 font-medium transition-colors",
        active ? "bg-surface-0 text-zinc-100 shadow-sm" : "text-zinc-500 hover:text-zinc-300",
      )}
    >
      {label}
    </button>
  );
}

// Health tone by success rate. Calm signal: a small muted dot + neutral text,
// no saturated pill fill or ring (matches the cockpit's StatePill). Only a
// real problem (below 0.8) earns a muted red dot; healthy reads calm green;
// unjudgeable reads neutral grey, never green.
function healthTone(rate: number | null): { text: string; dot: string } {
  if (rate === null) return { text: "text-zinc-500", dot: "bg-zinc-500" };
  if (rate >= 0.95) return { text: "text-zinc-300", dot: "bg-emerald-500/80" };
  if (rate >= 0.8) return { text: "text-zinc-300", dot: "bg-amber-500/70" };
  return { text: "text-zinc-300", dot: "bg-red-500/70" };
}

function AgentHealthRow({ health, runs }: { health: AgentHealth; runs: Run[] }) {
  const [expanded, setExpanded] = useState(false);
  const tone = healthTone(health.successRate);

  // Latency line preferred when we have ≥2 real durations; else fall back to
  // the cost trend. Honesty guard: if neither has signal, Sparkline renders "—".
  const hasLatency = health.latencySeries.length >= 2;
  const sparkData = normalizeSeries(hasLatency ? health.latencySeries : health.costSeries);
  const sparkLabel = hasLatency ? "Latency trend" : "Cost trend";
  // Monochrome sparks: primary trend in the accent, error trend a muted red —
  // no amber instrument-panel hue.
  const sparkColor = hasLatency ? "var(--color-accent)" : "rgba(161,161,170,0.7)";
  const errorData = normalizeSeries(health.errorSeries);
  const hasErrorSignal = health.errorSeries.some((v) => v > 0);

  // Recent runs for this agent (newest-first) for the expand panel.
  const agentRuns = useMemo(
    () =>
      runs
        .filter((r) => r.agentName === health.agentName)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 8),
    [runs, health.agentName],
  );

  return (
    <li className="overflow-hidden rounded-xl bg-surface-1 transition-colors duration-150 hover:bg-surface-2/50">
      <button
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-4 px-4 py-4 text-left"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-zinc-600" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600" />
        )}

        <AgentAvatar name={health.agentName} status={health.hasLive ? "running" : "succeeded"} />

        {/* Identity + last activity */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-100">{health.agentName}</span>
            {health.hasLive && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
                <span className="relative inline-flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-emerald-500/70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500/80" />
                </span>
                {health.liveRuns} live
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-zinc-500">
            {health.totalRuns} run{health.totalRuns === 1 ? "" : "s"}
            {health.lastActivityMs !== null ? ` · last ${formatRelative(health.lastActivityMs)}` : " · no activity yet"}
          </p>
        </div>

        {/* Health — muted dot + neutral text, no saturated pill */}
        <div className="hidden shrink-0 sm:flex">
          <span
            title={health.successRate === null ? "No completed runs to judge yet" : `${health.failedRuns} of ${health.terminalRuns} terminal runs failed`}
            className={clsx("inline-flex items-center gap-1.5 text-[12px] font-medium", tone.text)}
          >
            <span className={clsx("h-1.5 w-1.5 rounded-full", tone.dot)} />
            {pct(health.successRate)} ok
          </span>
        </div>

        {/* Trend sparkline */}
        <div className="hidden shrink-0 flex-col items-center gap-0.5 md:flex" title={sparkLabel}>
          <Sparkline data={sparkData} color={sparkColor} width={68} height={22} />
          <span className="text-[9px] uppercase tracking-wide text-zinc-600">{hasLatency ? "latency" : "cost"}</span>
        </div>

        {/* Error sparkline — only meaningful when there were failures. */}
        <div className="hidden shrink-0 flex-col items-center gap-0.5 lg:flex" title="Error rate (recent runs)">
          {hasErrorSignal ? (
            <Sparkline data={errorData} color="rgba(248,113,113,0.7)" width={48} height={22} />
          ) : (
            <span className="flex h-[22px] items-center font-mono text-[11px] text-zinc-600">—</span>
          )}
          <span className="text-[9px] uppercase tracking-wide text-zinc-600">errors</span>
        </div>

        {/* $/day */}
        <div className="shrink-0 text-right">
          <div className="font-mono text-[13px] font-medium tabular-nums text-zinc-200">{usd(health.costTodayUsd)}</div>
          <div className="text-[9px] uppercase tracking-wide text-zinc-600">today</div>
        </div>
      </button>

      {expanded && (
        <div className="bg-surface-0/40">
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Recent runs</span>
            <Link
              href={`/agents/${encodeURIComponent(health.agentName)}`}
              className="text-[11px] font-medium text-lantern-400 transition-colors duration-150 hover:text-lantern-300"
            >
              Open agent →
            </Link>
          </div>
          {agentRuns.length === 0 ? (
            <p className="px-4 pb-3 text-[11px] text-zinc-600">No runs.</p>
          ) : (
            <ul className="divide-y divide-zinc-800/40">
              {agentRuns.map((run) => (
                <CompactRunRow key={run.id} run={run} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Alerts panel + budget rollup (compact, secondary)
// ---------------------------------------------------------------------------

function AlertsPanel({ alerts, fleet, totalCostToday }: { alerts: Alert[]; fleet: AgentHealth[]; totalCostToday: number }) {
  // Soft fleet budget = default per-agent budget × agent count. A display
  // heuristic only — labelled "soft" so it's never mistaken for a real budget.
  const softBudget = Math.max(DEFAULT_DAILY_BUDGET_USD, fleet.length * DEFAULT_DAILY_BUDGET_USD);
  const budgetPct = Math.min(100, (totalCostToday / softBudget) * 100);
  // Calm fill: the accent for normal spend, a muted red only at true saturation.
  const budgetTone = budgetPct >= 90 ? "bg-red-500/70" : budgetPct >= 70 ? "bg-zinc-400" : "bg-lantern-400/80";

  return (
    <div className="rounded-xl bg-surface-1">
      <div className="flex items-center gap-2 px-4 pb-2 pt-3.5">
        <AlertTriangle className={clsx("h-3.5 w-3.5", alerts.length > 0 ? "text-amber-400/90" : "text-zinc-500")} />
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Alerts</span>
        <span className="ml-auto text-[11px] font-medium tabular-nums text-zinc-500">{alerts.length}</span>
      </div>

      <div className="px-4 pb-4">
        {alerts.length === 0 ? (
          <p className="text-[11px] text-zinc-500">All clear — no agents breaching error-rate or cost thresholds.</p>
        ) : (
          <ul className="space-y-1.5">
            {alerts.map((a, i) => (
              <li key={`${a.agentName}-${a.kind}-${i}`}>
                <Link
                  href={`/agents/${encodeURIComponent(a.agentName)}`}
                  className="flex items-start gap-2 rounded-lg bg-surface-2/60 px-2.5 py-2 transition-colors duration-150 hover:bg-surface-2"
                >
                  {a.kind === "cost-spike" ? (
                    <TrendingUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400/90" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400/90" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-medium text-zinc-200">{a.agentName}</div>
                    <div className="text-[11px] text-zinc-500">{a.detail}</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* Budget rollup */}
        <div className="mt-4 pt-3">
          <div className="mb-1.5 flex items-center justify-between text-[11px]">
            <span className="text-zinc-500">Spend vs soft budget</span>
            <span className="font-mono tabular-nums text-zinc-400">
              {usd(totalCostToday)} <span className="text-zinc-600">/ {usd(softBudget)}</span>
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
            <div className={clsx("h-full rounded-full transition-all duration-500", budgetTone)} style={{ width: `${budgetPct}%` }} />
          </div>
          <p className="mt-1.5 text-[10px] text-zinc-600">
            Soft default ({usd(DEFAULT_DAILY_BUDGET_USD)}/agent) — set real budgets per agent in Budgets.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action queues — live + needs-review (compact, actionable)
// ---------------------------------------------------------------------------

function ActionQueue({
  title,
  tone,
  runs,
  emptyHint,
  icon,
}: {
  title: string;
  tone: "info" | "warn";
  runs: Run[];
  emptyHint: string;
  icon: React.ReactNode;
}) {
  const accent = tone === "warn" ? "text-amber-400/90" : "text-zinc-500";
  return (
    <div className="rounded-xl bg-surface-1">
      <div className="flex items-center gap-2 px-4 pb-2 pt-3.5">
        <span className={accent}>{icon}</span>
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{title}</span>
        <span className="ml-auto text-[11px] font-medium tabular-nums text-zinc-500">{runs.length}</span>
      </div>
      {runs.length === 0 ? (
        <p className="px-4 pb-3.5 text-[11px] text-zinc-500">{emptyHint}</p>
      ) : (
        <ul className="divide-y divide-zinc-800/40 pb-1">
          {runs.slice(0, 6).map((run) => (
            <CompactRunRow key={run.id} run={run} showAgent />
          ))}
        </ul>
      )}
    </div>
  );
}

function CompactRunRow({ run, showAgent }: { run: Run; showAgent?: boolean }) {
  const StatusDot = statusDotFor(run.status);
  const summary = summarizeInput(run.input);
  return (
    <li>
      <Link href={`/runs/${run.id}`} className="flex items-center gap-2.5 px-4 py-2.5 transition-colors duration-150 hover:bg-surface-2/60">
        <StatusDot />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {showAgent && <span className="truncate text-[12px] font-medium text-zinc-200">{run.agentName}</span>}
            {summary ? (
              <span className={clsx("truncate text-[11px]", showAgent ? "text-zinc-500" : "text-zinc-300")}>{summary}</span>
            ) : (
              !showAgent && <span className="text-[11px] text-zinc-600">run {run.id.slice(0, 8)}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-zinc-500">
          {run.costUsd > 0 && <span className="tabular-nums">{usd(run.costUsd)}</span>}
          <span className="tabular-nums">{formatRelative(run.createdAt)}</span>
        </div>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Activity feed — preserved session-grouped feed (secondary tab)
// ---------------------------------------------------------------------------

function ActivityFeed({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl bg-surface-1 p-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2">
          <InboxIcon className="h-5 w-5 text-zinc-500" />
        </div>
        <p className="text-sm font-medium text-zinc-200">No activity yet</p>
        <p className="max-w-sm text-xs text-zinc-500">Every run across your agents surfaces here, grouped into sessions.</p>
      </div>
    );
  }

  const dateGroups = groupByDate(runs);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {dateGroups.map((g) => {
        const sessions = groupRunsBySession(g.runs);
        return (
          <section key={g.key}>
            <h3 className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              {g.label}
              <span className="ml-2 text-zinc-700">·</span>
              <span className="ml-2 tabular-nums text-zinc-600">{g.runs.length}</span>
            </h3>
            <ul className="divide-y divide-zinc-800/40 overflow-hidden rounded-xl bg-surface-1">
              {sessions.map((s, idx) => (
                <SessionEntry
                  key={s.key}
                  group={s}
                  groupedWithPrev={
                    idx > 0 &&
                    !s.isMulti &&
                    !sessions[idx - 1].isMulti &&
                    sessions[idx - 1].runs[0].agentName === s.runs[0].agentName
                  }
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function SessionEntry({ group, groupedWithPrev }: { group: SessionGroup; groupedWithPrev: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (!group.isMulti) {
    return <RunRow run={group.runs[0]} groupedWithPrev={groupedWithPrev} />;
  }

  const agg = aggregateSession(group.runs);
  const StatusDot = statusDotFor(agg.status);

  return (
    <li>
      <button
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-surface-2/60"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-600" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2">
          <Layers className="h-3.5 w-3.5 text-lantern-400/90" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-medium text-zinc-100">{agg.agentLabel}</span>
            <StatusDot />
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-400">{agg.count} runs</span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-zinc-500">Session · {agg.count} steps</p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-zinc-500">
          {agg.totalCost > 0 && <span className="tabular-nums">${agg.totalCost.toFixed(4)}</span>}
          <span className="tabular-nums">{formatRelative(agg.latestAt)}</span>
        </div>
      </button>
      {expanded && (
        <ul className="divide-y divide-zinc-800/40 bg-surface-0/40">
          {group.runs.map((run) => (
            <RunRow key={run.id} run={run} groupedWithPrev={false} nested />
          ))}
        </ul>
      )}
    </li>
  );
}

function RunRow({ run, groupedWithPrev, nested = false }: { run: Run; groupedWithPrev: boolean; nested?: boolean }) {
  const summary = summarizeInput(run.input);
  const StatusDot = statusDotFor(run.status);

  return (
    <li>
      <Link
        href={`/runs/${run.id}`}
        className={clsx("flex items-center gap-3 py-2.5 transition-colors duration-150 hover:bg-surface-2/60", nested ? "pl-12 pr-4" : "px-4")}
      >
        <AgentAvatar name={run.agentName} dimmed={groupedWithPrev} status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={clsx("truncate text-xs font-medium", groupedWithPrev ? "text-zinc-400" : "text-zinc-100")}>{run.agentName}</span>
            <StatusDot />
            {run.labels?.trigger && (
              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-zinc-500">{String(run.labels.trigger)}</span>
            )}
          </div>
          {summary ? <p className="mt-0.5 truncate text-[11px] text-zinc-500">{summary}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-zinc-500">
          {run.costUsd > 0 && <span className="tabular-nums">${run.costUsd.toFixed(4)}</span>}
          <span className="tabular-nums">{formatRelative(run.createdAt)}</span>
        </div>
      </Link>
    </li>
  );
}

// Small inline status glyph — quieter than a full badge.
function statusDotFor(status: RunStatus) {
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
    return <span className={clsx("shrink-0 text-[11px]", v.cls)}>{v.label}</span>;
  };
}

// ---------------------------------------------------------------------------
// Date grouping (activity feed)
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
    const t = new Date(run.createdAt).getTime();
    if (t >= today) buckets.today.runs.push(run);
    else if (t >= yesterday) buckets.yesterday.runs.push(run);
    else if (t >= sevenDaysAgo) buckets.week.runs.push(run);
    else if (t >= thirtyDaysAgo) buckets.month.runs.push(run);
    else buckets.older.runs.push(run);
  }

  return Object.entries(buckets)
    .filter(([, v]) => v.runs.length > 0)
    .map(([key, v]) => ({ key, label: v.label, runs: v.runs }));
}

// ---------------------------------------------------------------------------
// Input summarizer — returns null when there's nothing real to show.
// ---------------------------------------------------------------------------

function summarizeInput(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === "string") {
    const t = input.trim();
    return t.length > 0 ? t.slice(0, 120) : null;
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of ["message", "content", "input", "text", "prompt", "email", "query"]) {
      const val = obj[key];
      if (typeof val === "string" && val.trim().length > 0) return val.trim().slice(0, 120);
    }
    const keys = Object.keys(obj);
    if (keys.length === 0) return null;
    const hasContent = keys.some((k) => {
      const v = obj[k];
      if (v == null) return false;
      if (typeof v === "string") return v.trim().length > 0;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "object") return Object.keys(v as object).length > 0;
      return true;
    });
    if (!hasContent) return null;
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

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function FleetSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-[1fr_360px]">
      <ul className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <li key={i} className="flex items-center gap-4 rounded-xl bg-surface-1 px-4 py-4">
            <Skeleton className="h-7 w-7 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="h-6 w-16" />
          </li>
        ))}
      </ul>
      <div className="space-y-3">
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <ul className="mx-auto max-w-3xl divide-y divide-zinc-800/40 overflow-hidden rounded-xl bg-surface-1">
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
