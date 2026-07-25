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
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  DollarSign,
  Gauge,
  Inbox as InboxIcon,
  Layers,
  Play,
  TrendingUp,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import type { FleetUsage } from "@/lib/api";
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
import { PageHeader, CountBadge } from "@/components/page-header";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { useToast } from "@/components/toast";
import { AgentAvatar } from "@/components/agent-avatar";
import { Sparkline } from "../runtime/cockpit-ui";
import { useAuth } from "@/lib/auth";
import {
  fetchAttention,
  fetchEventScout,
  type AttentionSnapshot,
  type AttentionItem,
  type EventScoutSnapshot,
} from "@/lib/bridge-client";
import type { BridgeChannel } from "@/lib/bridge-types";

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

type TopTab = "agents" | "personal";

export default function MissionControlPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("fleet");
  const [sort, setSort] = useState<FleetSort>("health");
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());
  const [fleetUsage, setFleetUsage] = useState<FleetUsage | null>(null);
  const [agentTotal, setAgentTotal] = useState<number | null>(null);

  // Top-level view: the agent fleet vs. the owner's personal attention queue.
  // Deep-linkable via ?tab=personal.
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const tenantId = user?.tenantId ?? "default";
  const [topTab, setTopTab] = useState<TopTab>(() =>
    searchParams.get("tab") === "personal" ? "personal" : "agents",
  );
  function selectTab(t: TopTab) {
    setTopTab(t);
    const url = new URL(window.location.href);
    if (t === "personal") url.searchParams.set("tab", "personal");
    else url.searchParams.delete("tab");
    window.history.replaceState(null, "", url);
  }

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

  // Fetch accurate cost + agent count once. The runs poll handles liveness;
  // this corrects the two summary fields that the capped run list gets wrong.
  useEffect(() => {
    Promise.all([api.getFleetUsage(), api.listAgents()])
      .then(([u, agents]) => {
        setFleetUsage(u);
        setAgentTotal(agents.length);
      })
      .catch(() => {});
  }, []);

  const fleet = useMemo(() => computeFleetHealth(runs ?? []), [runs]);
  const alerts = useMemo(() => computeAlerts(fleet), [fleet]);
  const summary = useMemo(() => summarizeFleet(fleet, alerts), [fleet, alerts]);
  const sortedFleet = useMemo(() => sortFleet(fleet, sort), [fleet, sort]);

  // Override the two fields that the capped run list gets wrong: spend and
  // agent count. Per-agent success rates come from fleet-health (correct).
  const displaySummary = useMemo(() => ({
    ...summary,
    agentCount: agentTotal ?? summary.agentCount,
    costTodayUsd: fleetUsage?.periods.today.costUsd ?? summary.costTodayUsd,
  }), [summary, agentTotal, fleetUsage]);

  const queue = useMemo(() => {
    const list = runs ?? [];
    const live = list.filter((r) => r.status === "running" || r.status === "paused");
    const needsReview = list.filter((r) => r.status === "failed");
    return { live, needsReview };
  }, [runs]);

  const loading = runs === null;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Ambient aurora glow behind the transparent header — same pattern as the Agents page. */}
      <div className="relative overflow-hidden">
        <div aria-hidden className="mc-aurora" />
        <PageHeader
          className="relative z-10 !bg-transparent"
          title="Mission Control"
          description="Fleet-wide operations across every agent — health, spend, live work, and what needs you. All metrics derived from real runs."
        />
      </div>

      {/* Top-level view switch — the agent fleet vs. the owner's personal
          attention queue. Two different audiences; keep them apart. */}
      <div className="px-6 pt-4 md:px-8">
        <div className="flex items-center rounded-lg bg-surface-2 p-0.5 text-xs" role="group" aria-label="Inbox view">
          <SectionTab active={topTab === "agents"} onClick={() => selectTab("agents")} label="Agents" />
          <SectionTab active={topTab === "personal"} onClick={() => selectTab("personal")} label="Personal" />
        </div>
      </div>

      {topTab === "personal" ? (
        <PersonalAttention tenantId={tenantId} />
      ) : (
        <>
          <CommandStrip summary={displaySummary} lastUpdated={lastUpdated} loading={loading} />

          <div className="flex-1 px-6 pb-10 pt-5 md:px-8">
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
                    <AlertsPanel alerts={alerts} fleet={fleet} totalCostToday={displaySummary.costTodayUsd} />
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
        </>
      )}
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
    <div className="px-6 pt-6 md:px-8">
      <div className="mb-2 flex items-center justify-end text-[12px] text-zinc-500">
        <span className="tabular-nums">{loading ? "loading…" : `updated ${agoS}s ago`}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          icon={<Gauge className="h-3.5 w-3.5 text-zinc-400" />}
          label="Agents"
          value={String(summary.agentCount)}
          hint={live ? `${summary.liveRuns} live` : "all idle"}
          live={live}
        />
        <StatTile
          icon={<Play className="h-3.5 w-3.5 text-sky-400" />}
          iconBg="bg-sky-500/10"
          label="In flight"
          value={String(summary.liveRuns)}
          hint={live ? "running now" : "nothing running"}
        />
        <StatTile
          icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
          iconBg="bg-amber-500/10"
          label="Alerts"
          value={String(summary.alertCount)}
          hint={summary.alertCount > 0 ? "needs a look" : "all clear"}
          tone={summary.alertCount > 0 ? "danger" : undefined}
        />
        <StatTile
          icon={<DollarSign className="h-3.5 w-3.5 text-emerald-400" />}
          iconBg="bg-emerald-500/10"
          label="Spend today"
          value={usd(summary.costTodayUsd)}
          hint="across the fleet"
        />
      </div>
    </div>
  );
}

// Dense glass stat tile — same tokens as the Agents page's Stat component.
function StatTile({
  label,
  value,
  hint,
  live,
  tone,
  icon,
  iconBg,
}: {
  label: string;
  value: string;
  hint?: string;
  live?: boolean;
  tone?: "danger";
  icon?: React.ReactNode;
  iconBg?: string;
}) {
  const isDanger = tone === "danger";
  return (
    <div
      className={clsx(
        "group relative mc-glass overflow-hidden rounded-xl border p-4 backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5",
        isDanger ? "border-red-500/25 bg-red-500/[0.03] hover:border-red-500/40" : "border-white/[0.07] bg-white/[0.024] hover:border-white/[0.12]",
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        {icon && (
          <div className={clsx("flex h-7 w-7 items-center justify-center rounded-lg", isDanger ? "bg-red-500/10" : (iconBg ?? "bg-white/[0.05]"))}>
            {icon}
          </div>
        )}
        {live && (
          <span className="inline-flex items-center gap-1 rounded-full bg-teal-500/15 px-1.5 text-[12px] font-medium text-teal-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-400" />
            live
          </span>
        )}
      </div>
      <p className={clsx("text-2xl font-semibold leading-none tabular-nums", isDanger ? "text-red-300" : "text-zinc-100")}>{value}</p>
      <p className="mc-micro-label mt-1.5">{label}</p>
      {hint && <p className="mt-0.5 text-[12px] text-zinc-600">{hint}</p>}
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
        <h2 className="text-[12px] font-medium uppercase tracking-wide text-zinc-500">
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
    <li className="mc-glass overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.024] backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.12] hover:shadow-lg">
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
              <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-zinc-400">
                <span className="relative inline-flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-emerald-500/70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500/80" />
                </span>
                {health.liveRuns} live
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[12px] text-zinc-500">
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
            <span className="flex h-[22px] items-center font-mono text-[12px] text-zinc-600">—</span>
          )}
          <span className="text-[9px] uppercase tracking-wide text-zinc-600">errors</span>
        </div>

        {/* $/day */}
        <div className="shrink-0 text-right">
          <div className="font-mono text-[14px] font-medium tabular-nums text-zinc-200">{usd(health.costTodayUsd)}</div>
          <div className="text-[9px] uppercase tracking-wide text-zinc-600">today</div>
        </div>
      </button>

      {expanded && (
        <div className="bg-surface-0/40">
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Recent runs</span>
            <Link
              href={`/agents/${encodeURIComponent(health.agentName)}`}
              className="text-[12px] font-medium text-lantern-400 transition-colors duration-150 hover:text-lantern-300"
            >
              Open agent →
            </Link>
          </div>
          {agentRuns.length === 0 ? (
            <p className="px-4 pb-3 text-[12px] text-zinc-600">No runs.</p>
          ) : (
            <ul className="space-y-1.5 px-3 pb-3">
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
    <div className="mc-glass rounded-xl border border-white/[0.07] bg-white/[0.024] backdrop-blur-xl">
      <div className="flex items-center gap-2 px-4 pb-2 pt-3.5">
        <AlertTriangle className={clsx("h-3.5 w-3.5", alerts.length > 0 ? "text-amber-400/90" : "text-zinc-500")} />
        <span className="text-[12px] font-medium uppercase tracking-wide text-zinc-500">Alerts</span>
        <span className="ml-auto text-[12px] font-medium tabular-nums text-zinc-500">{alerts.length}</span>
      </div>

      <div className="px-4 pb-4">
        {alerts.length === 0 ? (
          <p className="text-[12px] text-zinc-500">All clear — no agents breaching error-rate or cost thresholds.</p>
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
                    <div className="text-[12px] text-zinc-500">{a.detail}</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* Budget rollup */}
        <div className="mt-4 pt-3">
          <div className="mb-1.5 flex items-center justify-between text-[12px]">
            <span className="text-zinc-500">Spend vs soft budget</span>
            <span className="font-mono tabular-nums text-zinc-400">
              {usd(totalCostToday)} <span className="text-zinc-600">/ {usd(softBudget)}</span>
            </span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
            <div className={clsx("h-full rounded-full transition-all duration-500", budgetTone)} style={{ width: `${budgetPct}%` }} />
          </div>
          <p className="mt-1.5 text-[11px] text-zinc-600">
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
    <div className="mc-glass rounded-xl border border-white/[0.07] bg-white/[0.024] backdrop-blur-xl">
      <div className="flex items-center gap-2 px-4 pb-2 pt-3.5">
        <span className={accent}>{icon}</span>
        <span className="text-[12px] font-medium uppercase tracking-wide text-zinc-500">{title}</span>
        <span className="ml-auto text-[12px] font-medium tabular-nums text-zinc-500">{runs.length}</span>
      </div>
      {runs.length === 0 ? (
        <p className="px-4 pb-3.5 text-[12px] text-zinc-500">{emptyHint}</p>
      ) : (
        <ul className="space-y-1.5 px-3 pb-3">
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
      <Link
        href={`/runs/${run.id}`}
        className="mc-glass flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.12] hover:shadow-lg"
      >
        <StatusDot />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {showAgent && <span className="truncate text-[12px] font-medium text-zinc-200">{run.agentName}</span>}
            {summary ? (
              <span className={clsx("truncate text-[12px]", showAgent ? "text-zinc-500" : "text-zinc-300")}>{summary}</span>
            ) : (
              !showAgent && <span className="text-[12px] text-zinc-600">run {run.id.slice(0, 8)}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[12px] text-zinc-500">
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
            <h3 className="mb-2 px-1 text-[12px] font-medium uppercase tracking-wide text-zinc-500">
              {g.label}
              <span className="ml-2 text-zinc-700">·</span>
              <span className="ml-2 tabular-nums text-zinc-600">{g.runs.length}</span>
            </h3>
            <ul className="space-y-1.5">
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
    <li className="mc-glass overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.024] backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.12] hover:shadow-lg">
      <button
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-600" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2">
          <Layers className="h-3.5 w-3.5 text-lantern-400/90" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-medium text-zinc-100">{agg.agentLabel}</span>
            <StatusDot />
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[12px] tabular-nums text-zinc-400">{agg.count} runs</span>
          </div>
          <p className="mt-0.5 truncate text-[12px] text-zinc-500">Session · {agg.count} steps</p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[12px] text-zinc-500">
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
        className={clsx(
          "flex items-center gap-3 transition-all duration-200",
          nested
            ? "py-2.5 pl-12 pr-4 hover:bg-surface-2/60"
            : "mc-glass rounded-xl border border-white/[0.07] bg-white/[0.024] px-4 py-2.5 backdrop-blur-xl hover:-translate-y-0.5 hover:border-white/[0.12] hover:shadow-lg",
        )}
      >
        <AgentAvatar name={run.agentName} dimmed={groupedWithPrev} status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={clsx("truncate text-xs font-medium", groupedWithPrev ? "text-zinc-400" : "text-zinc-100")}>{run.agentName}</span>
            <StatusDot />
            {run.labels?.trigger && (
              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[12px] uppercase tracking-wide text-zinc-500">{String(run.labels.trigger)}</span>
            )}
          </div>
          {summary ? <p className="mt-0.5 truncate text-[12px] text-zinc-500">{summary}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[12px] text-zinc-500">
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
    return <span className={clsx("shrink-0 text-[12px]", v.cls)}>{v.label}</span>;
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

// ---------------------------------------------------------------------------
// Personal attention — the owner's cross-channel "what needs you" queue.
//
// READ-ONLY by design. The acting surface is chat (the Brief lives in your
// self-chat: text `?` to your assistant); the dashboard is the depth view. The
// only affordance here is "copy command", which copies the self-chat command
// (e.g. `2 draft`) so the owner can act from their phone. No action buttons.
//
// Fed by each bridge's attention snapshot at GET /session/<tenant>/attention.
// Channels fetch independently so one bridge being down never blanks the other.
// ---------------------------------------------------------------------------

const ATTENTION_CHANNELS: { channel: BridgeChannel; label: string }[] = [
  { channel: "imessage", label: "iMessage" },
  { channel: "whatsapp", label: "WhatsApp" },
];

const ATTENTION_STALE_MS = 30 * 60 * 1000;

type ChannelAttention = {
  channel: BridgeChannel;
  label: string;
  snap: AttentionSnapshot | null;
  error: string | null;
  loaded: boolean;
};

/**
 * What the event scout has found, and when it last looked.
 *
 * The scout runs weekly and announced each find exactly once in self-chat, so
 * its output evaporated: 60 events discovered, none visible anywhere after the
 * moment they were sent. This is the durable view — soonest first, past events
 * dropped, and an explicit note when the last scan was partial so an
 * under-filled list is never mistaken for "nothing on".
 */
function UpcomingEvents({ tenantId }: { tenantId: string }) {
  const [snap, setSnap] = useState<EventScoutSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const s = await fetchEventScout(tenantId, "imessage");
        if (!cancelled) { setSnap(s); setFailed(false); }
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    load();
    const id = setInterval(load, 120_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tenantId]);

  // Nothing to show and nothing to explain — stay out of the way.
  if (failed || !snap || snap.upcoming.length === 0) return null;

  return (
    <section className="mb-6 rounded-xl border border-zinc-800 bg-surface-1 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-100">Events coming up</h2>
        <span className="text-[11px] text-zinc-500">
          {snap.lastScanAt ? `scanned ${formatRelative(snap.lastScanAt)}` : "not scanned yet"}
        </span>
      </div>
      {snap.partial && (
        <p className="mt-1 text-[11px] text-amber-400">
          Last scan was incomplete — some categories failed, so this list is short. Retrying soon.
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {snap.upcoming.slice(0, 8).map((e) => (
          <li key={`${e.title}-${e.date}`} className="flex items-baseline gap-3 text-[13px]">
            <span
              className={clsx(
                "w-20 shrink-0 font-medium",
                e.daysUntil <= 1 ? "text-amber-400" : "text-zinc-500",
              )}
            >
              {e.when}
            </span>
            <span className="min-w-0">
              <span className="text-zinc-100">{e.title}</span>
              {(e.venue || e.city) && (
                <span className="text-zinc-500"> — {e.venue || e.city}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-zinc-600">
        Reply <span className="text-zinc-400">book 1</span> in your assistant chat to add one to your calendar.
      </p>
    </section>
  );
}

function PersonalAttention({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const [channels, setChannels] = useState<ChannelAttention[]>(() =>
    ATTENTION_CHANNELS.map((c) => ({ ...c, snap: null, error: null, loaded: false })),
  );

  useEffect(() => {
    let cancelled = false;

    async function loadOne(c: { channel: BridgeChannel }) {
      try {
        const snap = await fetchAttention(tenantId, c.channel);
        if (cancelled) return;
        setChannels((prev) =>
          prev.map((x) => (x.channel === c.channel ? { ...x, snap, error: null, loaded: true } : x)),
        );
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "bridge unreachable";
        setChannels((prev) =>
          prev.map((x) => (x.channel === c.channel ? { ...x, error: msg, loaded: true } : x)),
        );
      }
    }

    function loadAll() {
      // ponytail: skip polling while the browser tab is backgrounded.
      if (typeof document !== "undefined" && document.hidden) return;
      ATTENTION_CHANNELS.forEach(loadOne);
    }

    loadAll();
    const id = setInterval(loadAll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tenantId]);

  const anyLoaded = channels.some((c) => c.loaded);
  const anyError = channels.some((c) => c.error);
  const allErrored = channels.every((c) => c.error);
  const totalItems = channels.reduce((n, c) => n + (c.snap?.items.length ?? 0), 0);
  const counts = channels.reduce(
    (acc, c) => {
      if (c.snap) {
        acc.waiting += c.snap.counts.waiting;
        acc.drafts += c.snap.counts.drafts;
        acc.commitments += c.snap.counts.commitments;
      }
      return acc;
    },
    { waiting: 0, drafts: 0, commitments: 0 },
  );

  function copyCommand(item: AttentionItem) {
    const cmd = `${item.n} ${item.defaultAction}`;
    navigator.clipboard.writeText(cmd).then(
      () => toast.success(`Copied “${cmd}” — paste into your assistant chat`),
      () => toast.error("Couldn't copy to clipboard"),
    );
  }

  return (
    <div className="flex-1 px-6 pb-10 pt-5 md:px-8">
      <UpcomingEvents tenantId={tenantId} />
      {!anyLoaded ? (
        <AttentionSkeleton />
      ) : totalItems === 0 && allErrored ? (
        <div className="mx-auto max-w-3xl rounded-lg bg-red-500/[0.06] px-3 py-2.5 text-[12px] text-red-300/90">
          Couldn&apos;t reach your bridges. Your attention queue is live in your self-chat — text{" "}
          <code className="rounded bg-surface-2 px-1">?</code> to your assistant.
        </div>
      ) : totalItems === 0 && !anyError ? (
        <EmptyState
          icon={InboxIcon}
          title="Your attention queue is clear"
          description="Nothing waiting across your channels. The Brief lives in your self-chat too — text `?` to your assistant."
        />
      ) : (
        <div className="mx-auto max-w-3xl">
          {totalItems > 0 && (
            <div className="mb-6 flex flex-wrap items-center gap-2">
              <AttentionCount label="waiting" n={counts.waiting} />
              <AttentionCount label="drafts" n={counts.drafts} />
              <AttentionCount label="commitments" n={counts.commitments} />
            </div>
          )}

          <div className="flex flex-col gap-6">
            {channels.map((c) => (
              <ChannelBlock key={c.channel} c={c} onCopy={copyCommand} />
            ))}
          </div>

          <p className="mt-6 text-[11px] text-zinc-600">
            Read-only — act from chat. Copy a command and paste it to your assistant.
          </p>
        </div>
      )}
    </div>
  );
}

function AttentionCount({ label, n }: { label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500">
      <CountBadge count={n} />
      {label}
    </span>
  );
}

function ChannelBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-md bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
      {label}
    </span>
  );
}

function ChannelBlock({
  c,
  onCopy,
}: {
  c: ChannelAttention;
  onCopy: (i: AttentionItem) => void;
}) {
  // Soft-fail: a down channel is a quiet inline note, never a toast.
  if (c.error) {
    return (
      <div className="flex items-center gap-1.5 text-[12px] text-zinc-600">
        <ChannelBadge label={c.label} />
        <span>bridge unavailable</span>
      </div>
    );
  }

  const items = c.snap ? [...c.snap.items].sort((a, b) => a.n - b.n) : [];
  if (items.length === 0) return null;

  const stale =
    c.snap?.generatedAt != null && Date.now() - c.snap.generatedAt > ATTENTION_STALE_MS;

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <ChannelBadge label={c.label} />
        {stale && (
          <span
            className="inline-flex items-center gap-1 text-[10px] text-amber-400/80"
            title={`Snapshot from ${formatRelative(c.snap!.generatedAt)}`}
          >
            <Clock className="h-3 w-3" /> stale
          </span>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
        {items.map((item, i) => (
          <AttentionRow key={item.id} item={item} onCopy={onCopy} first={i === 0} />
        ))}
      </div>
    </section>
  );
}

function AttentionRow({
  item,
  onCopy,
  first,
}: {
  item: AttentionItem;
  onCopy: (i: AttentionItem) => void;
  first: boolean;
}) {
  return (
    <div className={clsx("flex items-start gap-3 px-4 py-3", !first && "border-t border-zinc-800/70")}>
      <span className="mt-0.5 shrink-0 text-base leading-none" aria-hidden>
        {item.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] tabular-nums text-zinc-600">{item.n}</span>
          <span className="truncate text-[13px] text-zinc-100">{item.label}</span>
          <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-zinc-500">
            {item.ref}
          </span>
        </div>
        {item.why && <p className="mt-0.5 truncate text-[12px] text-zinc-500">{item.why}</p>}
      </div>
      <button
        onClick={() => onCopy(item)}
        title={`Copy “${item.n} ${item.defaultAction}” for your assistant chat`}
        aria-label={`Copy command ${item.n} ${item.defaultAction}`}
        className="mt-0.5 shrink-0 rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-surface-2 hover:text-zinc-200"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function AttentionSkeleton() {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-7 w-24 rounded-md" />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
