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
import { Modal } from "@/components/modal";
import { AgentAvatar } from "@/components/agent-avatar";
import { AgentsIllustration } from "@/components/illustrations";
import { getLastAgent, clearLastAgent } from "@/lib/last-agent";
import { AGENT_CATALOG } from "@/lib/agent-catalog";
import type { Agent, Run } from "@/lib/mock-data";

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

// Catalog tone → left-border accent color. Hex matched to agent-loop.tsx COLORS.
const toneHex: Record<string, string> = {
  sky:     "#38bdf8",
  emerald: "#34d399",
  amber:   "#f59e0b",
  violet:  "#a78bfa",
  rose:    "#fb7185",
};

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

  // Aggregate stats — real numbers from /v1/usage (fleet rollup), fallback to run list.
  const aggregate = useMemo(() => {
    const live = runs.filter((r) => r.status === "running" || r.status === "paused").length;

    const p = fleetUsage?.periods.today;
    if (p) {
      const terminal = p.succeeded + p.failed;
      return {
        total: agents.length, live,
        runsToday: p.runs, failedToday: p.failed,
        totalCostToday: p.costUsd,
        successRateToday: terminal > 0 ? Math.round((p.succeeded / terminal) * 100) : null,
      };
    }

    const today = Date.now() - 24 * 3600_000;
    const runsToday = runs.filter((r) => new Date(r.createdAt).getTime() >= today);
    const succeededToday = runsToday.filter((r) => r.status === "succeeded").length;
    const failedToday    = runsToday.filter((r) => r.status === "failed").length;
    const totalCostToday = runsToday.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    return {
      total: agents.length, live,
      runsToday: runsToday.length, failedToday, totalCostToday,
      successRateToday: runsToday.length > 0 ? Math.round((succeededToday / runsToday.length) * 100) : null,
    };
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
      {/* Page header — title + badges only. Create button lives in the toolbar below. */}
      <PageHeader
        title="Agents"
        description="Every agent you've deployed — click into one for sessions, runs, budgets, and channels."
        badge={
          <>
            {agents.length > 0 && <CountBadge count={agents.length} />}
            {isDemo && <DemoBadge />}
          </>
        }
      />

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
            {/* Stats strip — 4 tiles with icons, big numbers, subtle gradient sheen */}
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
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
              />
              <Stat
                icon={<DollarSign className="h-3.5 w-3.5 text-emerald-400" />}
                iconBg="bg-emerald-500/10"
                label="Cost today"
                value={`$${aggregate.totalCostToday.toFixed(2)}`}
                hint={aggregate.runsToday > 0 ? `~$${(aggregate.totalCostToday / aggregate.runsToday).toFixed(4)}/run` : "no runs yet"}
              />
              <Stat
                icon={<AlertCircle className="h-3.5 w-3.5 text-red-400" />}
                label="Failed today"
                value={String(aggregate.failedToday)}
                hint={aggregate.failedToday > 0 ? "click to filter" : aggregate.runsToday > 0 ? "all clean" : "no runs yet"}
                tone={aggregate.failedToday > 0 ? "danger" : undefined}
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

            {/* Personal suite section */}
            {personalSuite.length > 0 && (
              <section className="mb-8">
                <SectionLabel>Personal suite</SectionLabel>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
  const accentColor = catalogEntry ? (toneHex[catalogEntry.tone] ?? "#38bdf8") : undefined;

  return (
    <div
      className="group relative cursor-pointer rounded-xl border border-zinc-800 bg-surface-1 p-4 transition-all duration-200 hover:-translate-y-px hover:border-zinc-700 hover:bg-surface-2/60 hover:shadow-lg"
      style={accentColor ? { borderLeftWidth: "3px", borderLeftColor: accentColor } : undefined}
      onClick={() => onNavigate(agent.name)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onNavigate(agent.name); }}
    >
      {/* Top row: avatar + name + status pill */}
      <div className="flex items-center gap-2.5">
        <AgentAvatar name={agent.name} status={stats.lastRun?.status} size="md" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-zinc-100 group-hover:text-white">
            {agent.name}
          </h3>
          <span className={clsx("mt-0.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium", sc.bg, sc.text)}>
            <span className={clsx("h-1.5 w-1.5 rounded-full", sc.dot)} />
            {sc.label}
          </span>
        </div>
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
    <div className={clsx(
      "group relative overflow-hidden rounded-xl border bg-surface-1 p-4 transition-all duration-150",
      isDanger ? "border-red-500/30 hover:border-red-500/50" : "border-zinc-800 hover:border-zinc-700",
    )}>
      {/* Gradient sheen on hover */}
      <div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{
          background: isDanger
            ? "linear-gradient(135deg, rgba(248,113,113,0.08), transparent 60%)"
            : "linear-gradient(135deg, rgba(124,109,248,0.06), transparent 60%)",
        }}
      />
      <div className="relative">
        {/* Icon square + live pill row */}
        <div className="mb-3 flex items-center justify-between">
          {icon && (
            <div className={clsx(
              "flex h-7 w-7 items-center justify-center rounded-lg",
              isDanger ? "bg-red-500/10" : (iconBg ?? "bg-surface-2"),
            )}>
              {icon}
            </div>
          )}
          {live && (
            <span className="inline-flex items-center gap-1 rounded-full bg-lantern-500/15 px-1.5 text-[11px] font-medium text-lantern-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lantern-400" />
              live
            </span>
          )}
        </div>
        {/* Big number */}
        <p className={clsx("text-2xl font-semibold leading-none tabular-nums", isDanger ? "text-red-300" : "text-zinc-100")}>
          {value}
        </p>
        {/* Label */}
        <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</p>
        {/* Hint */}
        {hint && <p className="mt-0.5 text-[11px] text-zinc-600">{hint}</p>}
      </div>
    </div>
  );
}
