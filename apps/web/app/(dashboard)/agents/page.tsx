"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  Search,
  Sparkles,
  Plus,
  Clock,
  Play,
  MoreHorizontal,
  Trash2,
  Loader2,
  Calendar,
  TrendingUp,
  AlertCircle,
  RefreshCw,
  Activity,
  DollarSign,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { api } from "@/lib/api";
import type { FleetUsage } from "@/lib/api";
import { useAgents, useRuns } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { EmptyState } from "@/components/empty-state";
import { PageSkeleton } from "@/components/skeleton";
import { PageHeader, CountBadge, DemoBadge } from "@/components/page-header";
import { Button } from "@/components/button";
import { HealthRing } from "@/components/health-ring";
import { Modal } from "@/components/modal";
import { AgentAvatar } from "@/components/agent-avatar";
import { AgentsIllustration } from "@/components/illustrations";
import { Sparkline } from "@/components/charts/sparkline";
import { getLastAgent, clearLastAgent } from "@/lib/last-agent";
import { AGENT_CATALOG } from "@/lib/agent-catalog";
import type { Agent, Run } from "@/lib/mock-data";
import { bucketRunsByTime } from "./stat-buckets";

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

type AgentDisplayStatus = "active" | "scheduled" | "draft" | "error";

const statusConfig: Record<AgentDisplayStatus, { label: string; dot: string; bg: string; text: string }> = {
  active:    { label: "Active",     dot: "bg-emerald-400", bg: "bg-emerald-500/10", text: "text-emerald-400" },
  scheduled: { label: "Scheduled",  dot: "bg-blue-400",    bg: "bg-blue-500/10",    text: "text-blue-400"    },
  draft:     { label: "Draft",      dot: "bg-zinc-500",    bg: "bg-zinc-500/10",    text: "text-zinc-400"    },
  error:     { label: "Error",      dot: "bg-red-400",     bg: "bg-red-500/10",     text: "text-red-400"     },
};

// Catalog tone → subtle avatar ring (state now lives on the card's left
// stripe; tone is demoted to a quiet accent on the avatar itself).
const toneRingCls: Record<string, string> = {
  sky:     "ring-sky-400/50",
  emerald: "ring-emerald-400/50",
  amber:   "ring-amber-400/50",
  violet:  "ring-violet-400/50",
  rose:    "ring-rose-400/50",
};

// Derived-status → left-border stripe. An information device: the stripe
// IS the state, not decoration.
const statusStripeCls: Record<AgentDisplayStatus, string> = {
  active:    "border-l-4 border-l-emerald-400/70",
  scheduled: "border-l-4 border-l-blue-400/70",
  draft:     "border-l-4 border-l-zinc-700",
  error:     "border-l-4 border-l-rose-400/70",
};

// Run status → activity-stream tick color + verb (real status only, no
// fabricated confidence/activity).
const activityDotCls: Record<Run["status"], string> = {
  running:   "bg-teal-400",
  succeeded: "bg-emerald-400",
  failed:    "bg-rose-400",
  paused:    "bg-amber-400",
  queued:    "bg-amber-400",
  cancelled: "bg-zinc-500",
};

function activityVerb(run: Run): string {
  switch (run.status) {
    case "running":   return "is running";
    case "succeeded": return "completed a run";
    case "failed":    return run.error?.code ? `failed — ${run.error.code}` : "failed";
    case "paused":    return "paused";
    case "queued":    return "queued";
    case "cancelled": return "cancelled";
  }
}

// Exec-model display helpers (mirrors detail page — ponytail: keep in sync if labels change)
const execLabels: Record<string, string> = {
  scheduled: "Scheduled",
  bridge:    "Bridge",
  reactive:  "Reactive",
};

const execChipCls: Record<string, string> = {
  scheduled: "text-sky-300 bg-sky-500/10 border border-sky-500/20",
  bridge:    "text-violet-300 bg-violet-500/10 border border-violet-500/20",
  reactive:  "text-emerald-300 bg-emerald-500/10 border border-emerald-500/20",
};

// ponytail: static lookup for personal suite agents — shows "how it runs" on the card
const PERSONAL_RUN_META: Record<string, { runs: string; via: string }> = {
  "concierge":           { runs: "~45m cron",  via: "self-chat" },
  "care-coordinator":    { runs: "daily 8am",   via: "/personal Health" },
  "garage":              { runs: "daily",        via: "/personal Vehicle" },
  "upskill":             { runs: "daily",        via: "/personal Career" },
  "travel-concierge":    { runs: "daily",        via: "/personal Travel" },
  "household":           { runs: "daily",        via: "/personal Home" },
  "financial-sentinel":  { runs: "daily",        via: "/personal Finance" },
  "relationship-keeper": { runs: "weekly",       via: "self-chat" },
  "morning-brief":       { runs: "daily 8am",   via: "self-chat" },
  "inbox-concierge":     { runs: "daily AM",    via: "self-chat" },
  "commute-copilot":     { runs: "bridge",       via: "self-chat · LANTERN_COMMUTE" },
  "energy-guardian":     { runs: "bridge",       via: "self-chat · LANTERN_ENERGY" },
  "health-coach":        { runs: "bridge",       via: "self-chat · LANTERN_HEALTH" },
  "focus-guardian":      { runs: "bridge",       via: "self-chat · LANTERN_FOCUS" },
  "whatsapp-assistant":  { runs: "reactive",     via: "your contacts" },
  "imessage-assistant":  { runs: "reactive",     via: "your contacts" },
};

function deriveStatus(agent: Agent, agentRuns: Run[]): AgentDisplayStatus {
  if (agent.status === "archived") return "draft";
  const recent = agentRuns.filter((r) => r.agentName === agent.name);
  const lastRun = recent[0];
  if (lastRun?.status === "failed") return "error";
  if (recent.length === 0) return "draft";
  return "active";
}

function getAgentStats(agent: Agent, allRuns: Run[]) {
  const runs = allRuns.filter((r) => r.agentName === agent.name);
  const succeeded = runs.filter((r) => r.status === "succeeded").length;
  const successRate = runs.length > 0 ? Math.round((succeeded / runs.length) * 100) : 0;
  const lastRun = runs.length > 0 ? runs[0] : null;
  return { runsCount: runs.length, successRate, lastRun };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AgentsPage() {
  const router = useRouter();
  const toast = useToast();
  const { agents, setAgents, loading, error, isDemo } = useAgents();
  const { runs } = useRuns({});

  const [search, setSearch] = useState("");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [fleetUsage, setFleetUsage] = useState<FleetUsage | null>(null);

  useEffect(() => {
    api.getFleetUsage().then(setFleetUsage).catch(() => {});
  }, []);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Holds the agent the user has clicked "Delete" on — modal can show the name.
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null);

  const filtered = useMemo(() => {
    let result = [...agents];
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
      );
    }
    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return result;
  }, [agents, search]);

  // Split for section grouping: personal-suite (in catalog) vs user-created
  const { personalSuite, otherAgents } = useMemo(() => ({
    personalSuite: filtered.filter((a) => a.name in AGENT_CATALOG),
    otherAgents:   filtered.filter((a) => !(a.name in AGENT_CATALOG)),
  }), [filtered]);

  // Real-only sparkline series — buckets the actual runs list into ~12
  // slices over the last 24h. null when there's too little data to bucket
  // meaningfully; the tile renders no sparkline in that case (see stat-buckets.ts).
  const buckets = useMemo(() => bucketRunsByTime(runs), [runs]);

  // Aggregate stats — real numbers from /v1/usage (fleet rollup), fallback to run list.
  const aggregate = useMemo(() => {
    const live = runs.filter((r) => r.status === "running" || r.status === "paused").length;

    const today = fleetUsage?.periods.today;

    const base = today
      ? { runsToday: today.runs, succeededToday: today.succeeded, failedToday: today.failed, totalCostToday: today.costUsd }
      : (() => {
          const since = Date.now() - 24 * 3600_000;
          const runsToday = runs.filter((r) => new Date(r.createdAt).getTime() >= since);
          return {
            runsToday: runsToday.length,
            succeededToday: runsToday.filter((r) => r.status === "succeeded").length,
            failedToday: runsToday.filter((r) => r.status === "failed").length,
            totalCostToday: runsToday.reduce((s, r) => s + (r.costUsd ?? 0), 0),
          };
        })();

    const terminalToday = base.succeededToday + base.failedToday;
    const successRateToday = terminalToday > 0 ? Math.round((base.succeededToday / terminalToday) * 100) : null;

    return { total: agents.length, live, ...base, successRateToday };
  }, [agents, runs, fleetUsage]);

  // `/` keyboard shortcut — focus search (Linear/GitHub-style).
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleDelete = async (agent: Agent) => {
    setDeletingId(agent.id);
    try {
      await api.deleteAgent(agent.name);
      setAgents((prev) => prev.filter((a) => a.id !== agent.id));
      if (getLastAgent() === agent.name) clearLastAgent();
      toast.success(`Agent "${agent.name}" deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete agent");
    } finally {
      setDeletingId(null);
      setOpenMenu(null);
    }
  };

  const handleQuickRun = async (agent: Agent, e: React.MouseEvent) => {
    e.stopPropagation();
    router.push(`/agents/${agent.name}?tab=build&autorun=true`);
  };

  if (loading) return <PageSkeleton />;

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 ring-1 ring-red-500/20">
          <AlertCircle className="h-5 w-5 text-red-300" />
        </div>
        <h3 className="mt-4 text-sm font-semibold text-zinc-100">Couldn&apos;t load agents</h3>
        <p className="mt-1 max-w-sm text-center text-xs text-zinc-500">
          {error.message}. Make sure the control-plane API is reachable.
        </p>
        <code className="mt-3 rounded-lg border border-zinc-800 bg-surface-0 px-3 py-1.5 font-mono text-[11px] text-zinc-300">
          lantern dev
        </code>
        <Button size="sm" variant="secondary" className="mt-4" icon={<RefreshCw className="h-3 w-3" />} onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Page header — title + badges only. Create button lives in the toolbar below.
          Ambient aurora glow sits behind it; header itself goes transparent so it shows through. */}
      <div className="relative overflow-hidden">
        <div aria-hidden className="mc-aurora" />
        <PageHeader
          className="relative z-10 !bg-transparent"
          title="Agents"
          description="Every agent you've deployed — click into one for sessions, runs, budgets, and channels."
          badge={
            <>
              {agents.length > 0 && <CountBadge count={agents.length} />}
              {isDemo && <DemoBadge />}
            </>
          }
        />
      </div>

      <div className="flex-1 p-8">
        {agents.length === 0 ? (
          <EmptyState
            illustration={<AgentsIllustration size={120} />}
            title="No agents yet"
            description="Describe what you want an agent to do — Lantern drafts the configuration, you review and ship. About 30 seconds end-to-end."
            actionLabel="Create Agent"
            onAction={() => router.push("/agents/create")}
            secondaryActionLabel="Browse templates"
            secondaryActionHref="/marketplace"
            suggestions={[
              { label: "Reply to my WhatsApp DMs", onClick: () => router.push("/agents/create?path=ai&seed=whatsapp") },
              { label: "Triage GitHub issues",      onClick: () => router.push("/agents/create?path=ai&seed=github")   },
              { label: "Summarize Slack daily",     onClick: () => router.push("/agents/create?path=ai&seed=slack")    },
            ]}
          />
        ) : (
          <>
            <NowRunningStrip runs={runs} />

            {/* Stats strip — 4 dense glass tiles. Real data only: see stat-buckets.ts
                for the sparkline bucketing. */}
            <div className="mc-stagger mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                icon={<Bot className="h-3.5 w-3.5 text-zinc-400" />}
                label="Agents"
                value={String(aggregate.total)}
                hint={aggregate.live > 0 ? `${aggregate.live} live` : "all idle"}
                live={aggregate.live > 0}
              />
              <Stat
                icon={<Activity className="h-3.5 w-3.5 text-sky-400" />}
                iconBg="bg-sky-500/10"
                label="Runs today"
                value={aggregate.runsToday.toLocaleString()}
                hint={aggregate.successRateToday != null ? `${aggregate.successRateToday}% succeeded` : "—"}
                sparkline={buckets?.runCounts}
                sparklineStroke="rgb(56 189 248)"
                sparklineFill="rgba(56, 189, 248, 0.12)"
              />
              <Stat
                icon={<DollarSign className="h-3.5 w-3.5 text-emerald-400" />}
                iconBg="bg-emerald-500/10"
                label="Cost today"
                value={`$${aggregate.totalCostToday.toFixed(2)}`}
                hint={aggregate.runsToday > 0 ? `~$${(aggregate.totalCostToday / aggregate.runsToday).toFixed(4)}/run` : "no runs yet"}
                sparkline={buckets?.costs}
                sparklineStroke="rgb(52 211 153)"
                sparklineFill="rgba(52, 211, 153, 0.12)"
              />
              <Stat
                icon={<TrendingUp className="h-3.5 w-3.5 text-teal-400" />}
                iconBg="bg-teal-500/10"
                label="Success"
                value={aggregate.successRateToday != null ? `${aggregate.successRateToday}%` : "—"}
                hint={
                  aggregate.successRateToday != null
                    ? `${aggregate.succeededToday}/${aggregate.succeededToday + aggregate.failedToday} runs`
                    : aggregate.runsToday > 0 ? "no terminal runs yet" : "no runs yet"
                }
                tone={aggregate.successRateToday != null && aggregate.successRateToday < 80 ? "danger" : undefined}
              />
            </div>

            {/* Exec model legend */}
            <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-zinc-500">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Runs as</span>
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-sky-400" />Scheduled · Lantern cron</span>
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-violet-400" />Bridge loop · on your Mac</span>
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Reactive · per inbound message</span>
            </div>

            {/* Toolbar: search on left, New agent button on right */}
            <div className="mb-6 flex items-center gap-3">
              <div className="relative max-w-md flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <input
                  ref={searchRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search agents…"
                  className="w-full rounded-lg border border-zinc-800 bg-surface-1 py-2 pl-9 pr-12 text-xs text-zinc-100 placeholder:text-zinc-600 outline-none transition-all duration-150 focus:border-lantern-500/60 focus:bg-surface-2 focus:ring-2 focus:ring-lantern-500/30"
                />
                <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-zinc-700 bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-zinc-500">
                  /
                </kbd>
              </div>
              <Button variant="primary" size="md" icon={<Plus className="h-4 w-4" />} onClick={() => router.push("/agents/create")}>
                New agent
              </Button>
            </div>

            {/* Fleet column | live-activity rail (xl+). Below xl, rail drops to a stacked section. */}
            <div className="xl:flex xl:items-start xl:gap-6">
              <div className="min-w-0 flex-1">
                {/* Personal suite section */}
                {personalSuite.length > 0 && (
                  <section className="mb-8">
                    <SectionLabel>Personal suite</SectionLabel>
                    <div className="mc-stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {personalSuite.map((agent) => (
                        <AgentCard
                          key={agent.id}
                          agent={agent}
                          runs={runs}
                          openMenu={openMenu}
                          setOpenMenu={setOpenMenu}
                          deletingId={deletingId}
                          onRun={handleQuickRun}
                          onConfirmDelete={(a) => { setConfirmDelete(a); setOpenMenu(null); }}
                          onNavigate={(n) => router.push(`/agents/${n}`)}
                          onSchedule={(n) => { router.push(`/agents/${n}?tab=schedule`); setOpenMenu(null); }}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {/* Other agents section */}
                {otherAgents.length > 0 && (
                  <section>
                    {personalSuite.length > 0 && <SectionLabel>Other agents</SectionLabel>}
                    <div className="mc-stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {otherAgents.map((agent) => (
                        <AgentCard
                          key={agent.id}
                          agent={agent}
                          runs={runs}
                          openMenu={openMenu}
                          setOpenMenu={setOpenMenu}
                          deletingId={deletingId}
                          onRun={handleQuickRun}
                          onConfirmDelete={(a) => { setConfirmDelete(a); setOpenMenu(null); }}
                          onNavigate={(n) => router.push(`/agents/${n}`)}
                          onSchedule={(n) => { router.push(`/agents/${n}?tab=schedule`); setOpenMenu(null); }}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {/* No results */}
                {filtered.length === 0 && agents.length > 0 && (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <Search className="mb-3 h-8 w-8 text-zinc-600" />
                    <p className="text-sm text-zinc-400">No agents match your search.</p>
                    <button onClick={() => setSearch("")} className="mt-2 text-xs text-lantern-400 transition-colors hover:text-lantern-300">
                      Clear search
                    </button>
                  </div>
                )}
              </div>

              <aside className="hidden xl:block xl:w-[300px] xl:shrink-0 xl:sticky xl:top-6">
                <ActivityStream runs={runs} />
              </aside>
            </div>

            {/* Below xl: activity stream drops to a stacked section under the grid. */}
            <div className="mt-8 xl:hidden">
              <ActivityStream runs={runs} />
            </div>
          </>
        )}
      </div>

      {/* Click-away to dismiss overflow menus */}
      {openMenu && <div className="fixed inset-0 z-10" onClick={() => setOpenMenu(null)} />}

      {/* Delete confirmation modal */}
      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete this agent?"
        description={
          confirmDelete
            ? `"${confirmDelete.name}" will be removed permanently. Its runs, sessions, budgets, schedules, and channel pairings will be deleted with it. This can't be undone.`
            : ""
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)} disabled={deletingId !== null}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={deletingId === confirmDelete?.id}
              onClick={async () => {
                if (!confirmDelete) return;
                await handleDelete(confirmDelete);
                setConfirmDelete(null);
              }}
            >
              Delete agent
            </Button>
          </>
        }
      >
        {confirmDelete && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-[11px] text-red-300">
            Type <code className="rounded bg-surface-0 px-1 font-mono text-red-200">{confirmDelete.name}</code> in your head one more time before clicking Delete agent.
          </div>
        )}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionLabel — horizontal rule with centered text
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
      <span className="h-px flex-1 bg-zinc-800" />
      {children}
      <span className="h-px flex-1 bg-zinc-800" />
    </h2>
  );
}

// ---------------------------------------------------------------------------
// AgentCard — one card in the grid
// ---------------------------------------------------------------------------

interface AgentCardProps {
  agent: Agent;
  runs: Run[];
  openMenu: string | null;
  setOpenMenu: React.Dispatch<React.SetStateAction<string | null>>;
  deletingId: string | null;
  onRun: (agent: Agent, e: React.MouseEvent) => void;
  onConfirmDelete: (agent: Agent) => void;
  onNavigate: (name: string) => void;
  onSchedule: (name: string) => void;
}

function AgentCard({
  agent,
  runs,
  openMenu,
  setOpenMenu,
  deletingId,
  onRun,
  onConfirmDelete,
  onNavigate,
  onSchedule,
}: AgentCardProps) {
  const stats = getAgentStats(agent, runs);
  const displayStatus = deriveStatus(agent, runs);
  const sc = statusConfig[displayStatus];
  const hasRuns = stats.runsCount > 0;
  const catalogEntry = AGENT_CATALOG[agent.name];

  return (
    <div
      className={clsx(
        "group relative mc-glass cursor-pointer rounded-xl border border-white/[0.07] bg-white/[0.024] p-4 backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.12] hover:shadow-lg",
        statusStripeCls[displayStatus],
      )}
      onClick={() => onNavigate(agent.name)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onNavigate(agent.name); }}
    >
      {/* Top row: avatar + name + status pill, health ring at rest (right) */}
      <div className="flex items-center gap-2.5">
        <AgentAvatar
          name={agent.name}
          status={stats.lastRun?.status}
          size="md"
          className={catalogEntry ? clsx("rounded-lg ring-2 ring-offset-2 ring-offset-surface-1", toneRingCls[catalogEntry.tone]) : undefined}
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-zinc-100 group-hover:text-white">
            {agent.name}
          </h3>
          <span className={clsx("mt-0.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium", sc.bg, sc.text)}>
            <span className={clsx("relative flex h-1.5 w-1.5")}>
              {displayStatus === "active" && (
                <span className={clsx("absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping", sc.dot)} />
              )}
              <span className={clsx("relative inline-flex h-1.5 w-1.5 rounded-full", sc.dot)} />
            </span>
            {sc.label}
          </span>
        </div>
        {hasRuns && (
          <HealthRing
            value={stats.successRate}
            className="transition-opacity duration-150 group-hover:opacity-0"
          />
        )}
      </div>

      {/* One-line description from catalog or agent record */}
      <p className="mt-3 line-clamp-2 text-[11px] leading-relaxed text-zinc-400">
        {catalogEntry?.whatItDoes ?? agent.description}
      </p>

      {/* Exec-model + cadence chips (catalog agents only) */}
      {catalogEntry && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", execChipCls[catalogEntry.execModel ?? "scheduled"])}>
            {execLabels[catalogEntry.execModel ?? "scheduled"]}
          </span>
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-zinc-500">
            {catalogEntry.cadence}
          </span>
          {PERSONAL_RUN_META[agent.name] && (
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-zinc-500">
              {PERSONAL_RUN_META[agent.name].via}
            </span>
          )}
        </div>
      )}

      {/* Footer: runs + success rate + last-run time */}
      <div className="mt-3 flex items-center justify-between border-t border-zinc-800/60 pt-2.5 text-[11px]">
        <div className="flex items-center gap-3 text-zinc-500">
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Play className="h-3 w-3" />
            {stats.runsCount} {stats.runsCount === 1 ? "run" : "runs"}
          </span>
          {hasRuns && (
            <>
              <span className="text-zinc-700">·</span>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <TrendingUp className="h-3 w-3" />
                {stats.successRate}%
              </span>
            </>
          )}
        </div>
        {stats.lastRun?.startedAt ? (
          <span className="inline-flex items-center gap-1 text-zinc-600 tabular-nums">
            <Clock className="h-3 w-3" />
            {formatDistanceToNow(new Date(stats.lastRun.startedAt), { addSuffix: true })}
          </span>
        ) : (
          <span className="text-zinc-600">No runs yet</span>
        )}
      </div>

      {/* Quick actions — appear on hover / when menu open */}
      <div className={clsx(
        "absolute right-3 top-3 flex items-center gap-1 transition-opacity",
        openMenu === agent.id ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      )}>
        <button
          onClick={(e) => onRun(agent, e)}
          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-lantern-500/10 hover:text-lantern-400"
          title="Run agent"
        >
          <Play className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === agent.id ? null : agent.id); }}
          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-200"
          title="More actions"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>

        {openMenu === agent.id && (
          <div
            className="absolute right-0 top-8 z-20 w-40 rounded-lg border border-zinc-800 bg-surface-1 py-1 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={(e) => { e.stopPropagation(); onNavigate(agent.name); setOpenMenu(null); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-surface-3"
            >
              <Sparkles className="h-3 w-3" /> Edit
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onSchedule(agent.name); }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-surface-3"
            >
              <Calendar className="h-3 w-3" /> Schedule
            </button>
            <div className="my-1 border-t border-zinc-800" />
            <button
              onClick={(e) => { e.stopPropagation(); onConfirmDelete(agent); }}
              disabled={deletingId === agent.id}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            >
              {deletingId === agent.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat tile — used in the stats strip above the grid
// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  hint,
  live,
  tone,
  icon,
  iconBg,
  sparkline,
  sparklineStroke,
  sparklineFill,
}: {
  label: string;
  value: string;
  hint?: string;
  live?: boolean;
  tone?: "danger";
  icon?: React.ReactNode;
  iconBg?: string;
  /** Real bucketed series only (see stat-buckets.ts) — omit when there's too little data. */
  sparkline?: number[];
  sparklineStroke?: string;
  sparklineFill?: string;
}) {
  const isDanger = tone === "danger";
  return (
    <div className={clsx(
      "group relative mc-glass overflow-hidden rounded-xl border px-4 py-3 backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5",
      isDanger ? "border-red-500/25 bg-red-500/[0.03] hover:border-red-500/40" : "border-white/[0.07] bg-white/[0.024] hover:border-white/[0.12]",
    )}>
      {/* Icon square + live pill row */}
      <div className="mb-2 flex items-center justify-between">
        {icon && (
          <div className={clsx(
            "flex h-7 w-7 items-center justify-center rounded-lg",
            isDanger ? "bg-red-500/10" : (iconBg ?? "bg-white/[0.05]"),
          )}>
            {icon}
          </div>
        )}
        {live && (
          <span className="inline-flex items-center gap-1 rounded-full bg-teal-500/15 px-1.5 text-[11px] font-medium text-teal-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-400" />
            live
          </span>
        )}
      </div>
      {/* Big number, sparkline inline bottom-right of the same row */}
      <div className="flex items-end justify-between gap-2">
        <p className={clsx("text-2xl font-semibold leading-none tabular-nums", isDanger ? "text-red-300" : "text-zinc-100")}>
          {value}
        </p>
        {/* Real sparkline only — hidden below sm where the tile is too narrow to render one honestly */}
        {sparkline && sparkline.length > 0 && (
          <div className="hidden shrink-0 sm:block">
            <Sparkline
              data={sparkline}
              width={64}
              height={20}
              strokeWidth={1.5}
              stroke={sparklineStroke ?? "rgb(56 189 248)"}
              fill={sparklineFill ?? "rgba(56, 189, 248, 0.12)"}
            />
          </div>
        )}
      </div>
      {/* Mono micro-label */}
      <p className="mc-micro-label mt-1.5">{label}</p>
      {/* Hint */}
      {hint && <p className="mt-0.5 text-[11px] text-zinc-600">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NowRunningStrip — real running/paused runs only. Renders nothing when idle.
// ---------------------------------------------------------------------------

function NowRunningStrip({ runs }: { runs: Run[] }) {
  const liveAgentNames = useMemo(() => {
    const live = runs.filter((r) => r.status === "running" || r.status === "paused");
    return Array.from(new Set(live.map((r) => r.agentName)));
  }, [runs]);

  if (liveAgentNames.length === 0) return null;

  const shown = liveAgentNames.slice(0, 3);
  const extra = liveAgentNames.length - shown.length;

  return (
    <div className="mb-6 rounded-xl border border-teal-500/20 bg-gradient-to-r from-teal-500/10 via-surface-1 to-indigo-500/10 px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs text-zinc-300">
        <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75 motion-safe:animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-teal-400" />
        </span>
        <span className="font-medium text-zinc-100">
          {liveAgentNames.length} agent{liveAgentNames.length === 1 ? "" : "s"} running
        </span>
        <span className="text-zinc-500">— {shown.join(", ")}{extra > 0 ? ` +${extra} more` : ""}</span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActivityStream — the console's heartbeat. Most recent ~8 runs, real data only.
// ---------------------------------------------------------------------------

function ActivityStream({ runs }: { runs: Run[] }) {
  const items = useMemo(() => {
    return [...runs]
      .sort((a, b) => new Date(b.startedAt ?? b.createdAt).getTime() - new Date(a.startedAt ?? a.createdAt).getTime())
      .slice(0, 8);
  }, [runs]);

  const isLive = runs.some((r) => r.status === "running" || r.status === "paused");

  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
          {isLive && <span className="absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75 motion-safe:animate-ping" />}
          <span className={clsx("relative inline-flex h-1.5 w-1.5 rounded-full", isLive ? "bg-teal-400" : "bg-zinc-600")} />
        </span>
        <h3 className="text-xs font-semibold text-zinc-300">Live activity</h3>
      </div>
      {items.length === 0 ? (
        <p className="py-6 text-center text-[11px] text-zinc-600">No activity yet</p>
      ) : (
        <ul className="space-y-3">
          {items.map((run) => (
            <li key={run.id} className="flex items-start gap-2">
              <span className={clsx("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", activityDotCls[run.status])} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] leading-snug text-zinc-300">
                  <span className="font-medium text-zinc-100">{run.agentName}</span> {activityVerb(run)}
                </p>
                <p className="text-[10px] text-zinc-600">
                  {formatDistanceToNow(new Date(run.startedAt ?? run.createdAt), { addSuffix: true })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
