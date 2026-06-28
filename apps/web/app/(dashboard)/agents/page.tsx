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
import type { Agent, Run } from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

type AgentDisplayStatus = "active" | "scheduled" | "draft" | "error";

const statusConfig: Record<AgentDisplayStatus, { label: string; dot: string; bg: string; text: string }> = {
  active: { label: "Active", dot: "bg-emerald-400", bg: "bg-emerald-500/10", text: "text-emerald-400" },
  scheduled: { label: "Scheduled", dot: "bg-blue-400", bg: "bg-blue-500/10", text: "text-blue-400" },
  draft: { label: "Draft", dot: "bg-zinc-500", bg: "bg-zinc-500/10", text: "text-zinc-400" },
  error: { label: "Error", dot: "bg-red-400", bg: "bg-red-500/10", text: "text-red-400" },
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
// Component
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
  // Holds the agent the user has clicked "Delete" on. We hold the agent
  // in state (not just id) so the modal can render the agent's name in
  // its confirmation copy without re-looking-up.
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null);

  const filtered = useMemo(() => {
    let result = [...agents];
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q),
      );
    }
    result.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return result;
  }, [agents, search]);

  // Aggregate stats strip — totals across every agent. The real numbers come
  // from /v1/usage (agent_usage_daily, includes bridge spend the run list
  // misses). Fall back to summing the capped run list when usage is unavailable.
  const aggregate = useMemo(() => {
    // Live count is always from the real-time run list.
    const live = runs.filter((r) => r.status === "running" || r.status === "paused").length;

    const p = fleetUsage?.periods.today;
    if (p) {
      // Terminal-only success rate excludes in-flight runs.
      const terminal = p.succeeded + p.failed;
      return {
        total: agents.length,
        live,
        runsToday: p.runs,
        failedToday: p.failed,
        totalCostToday: p.costUsd,
        successRateToday: terminal > 0 ? Math.round((p.succeeded / terminal) * 100) : null,
      };
    }

    // Fallback: derive from the capped run list.
    const today = Date.now() - 24 * 3600_000;
    const runsToday = runs.filter((r) => new Date(r.createdAt).getTime() >= today);
    const succeededToday = runsToday.filter((r) => r.status === "succeeded").length;
    const failedToday = runsToday.filter((r) => r.status === "failed").length;
    const totalCostToday = runsToday.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const successRateToday =
      runsToday.length > 0 ? Math.round((succeededToday / runsToday.length) * 100) : null;
    return {
      total: agents.length,
      live,
      runsToday: runsToday.length,
      failedToday,
      totalCostToday,
      successRateToday,
    };
  }, [agents, runs, fleetUsage]);

  // `/` keyboard shortcut focuses the search input — Linear/GitHub-style.
  // The global KeyboardShortcuts handler skips when focus is in an input,
  // so we don't fight with `g`-prefix nav.
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
      // If the user just deleted the agent the home page caches as
      // "last visited", drop that cache so the next "/" hit doesn't
      // 404 trying to reopen it.
      if (getLastAgent() === agent.name) clearLastAgent();
      toast.success(`Agent "${agent.name}" deleted`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete agent",
      );
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
        <h3 className="mt-4 text-sm font-semibold text-zinc-100">
          Couldn&apos;t load agents
        </h3>
        <p className="mt-1 max-w-sm text-center text-xs text-zinc-500">
          {error.message}. Make sure the control-plane API is reachable.
        </p>
        <code className="mt-3 rounded-lg border border-zinc-800 bg-surface-0 px-3 py-1.5 font-mono text-[11px] text-zinc-300">
          lantern dev
        </code>
        <Button
          size="sm"
          variant="secondary"
          className="mt-4"
          icon={<RefreshCw className="h-3 w-3" />}
          onClick={() => window.location.reload()}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Agents"
        description="Every agent you create. Click into one for sessions, runs, budgets, and deployments."
        badge={
          <>
            {agents.length > 0 && <CountBadge count={agents.length} />}
            {isDemo && <DemoBadge />}
          </>
        }
        action={
          <Button
            variant="primary"
            size="md"
            icon={<Plus className="h-4 w-4" />}
            onClick={() => router.push("/agents/create")}
          >
            Create agent
          </Button>
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
              { label: "Triage GitHub issues", onClick: () => router.push("/agents/create?path=ai&seed=github") },
              { label: "Summarize Slack daily", onClick: () => router.push("/agents/create?path=ai&seed=slack") },
            ]}
          />
        ) : (
          <>
            {/* Aggregate stats strip — totals across every agent. The strip
                sits above the grid so the user lands on numbers first, then
                drills into individual cards. Live pill pulses when there's
                a run in flight. */}
            <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Agents"
                value={String(aggregate.total)}
                hint={
                  aggregate.live > 0
                    ? `${aggregate.live} live`
                    : "all idle"
                }
                live={aggregate.live > 0}
              />
              <Stat
                label="Runs today"
                value={aggregate.runsToday.toLocaleString()}
                hint={
                  aggregate.successRateToday != null
                    ? `${aggregate.successRateToday}% succeeded`
                    : "—"
                }
              />
              <Stat
                label="Cost today"
                value={`$${aggregate.totalCostToday.toFixed(2)}`}
                hint={
                  aggregate.runsToday > 0
                    ? `~$${(aggregate.totalCostToday / aggregate.runsToday).toFixed(4)}/run`
                    : "no runs yet"
                }
              />
              <Stat
                label="Failed today"
                value={String(aggregate.failedToday)}
                hint={
                  aggregate.failedToday > 0
                    ? "click to filter"
                    : aggregate.runsToday > 0
                      ? "all clean"
                      : "no runs yet"
                }
                tone={aggregate.failedToday > 0 ? "danger" : undefined}
              />
            </div>

            {/* Search — polished input with `/` shortcut + focus glow. */}
            <div className="mb-5">
              <div className="relative max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <input
                  ref={searchRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search agents by name or description…"
                  className="w-full rounded-lg border border-zinc-800 bg-surface-1 py-2 pl-9 pr-16 text-xs text-zinc-100 placeholder:text-zinc-600 outline-none transition-all duration-150 focus:border-lantern-500/60 focus:bg-surface-2 focus:ring-2 focus:ring-lantern-500/30"
                />
                <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md border border-zinc-700 bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-zinc-500">
                  /
                </kbd>
              </div>
            </div>

            {/* Agent cards grid — compact, inline stats, no dead space. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((agent) => {
                const stats = getAgentStats(agent, runs);
                const displayStatus = deriveStatus(agent, runs);
                const sc = statusConfig[displayStatus];
                const hasRuns = stats.runsCount > 0;

                return (
                  <div
                    key={agent.id}
                    className="group relative cursor-pointer rounded-xl border border-zinc-800 bg-surface-1 p-4 transition-all duration-150 hover:border-zinc-700 hover:bg-surface-2/50 hover:shadow-md"
                    onClick={() => router.push(`/agents/${agent.name}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        router.push(`/agents/${agent.name}`);
                    }}
                  >
                    {/* Top row: avatar + name + status pill */}
                    <div className="flex items-center gap-2.5">
                      <AgentAvatar
                        name={agent.name}
                        status={stats.lastRun?.status}
                        size="md"
                      />
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-xs font-semibold text-zinc-100 group-hover:text-white">
                          {agent.name}
                        </h3>
                        <span className={clsx("mt-0.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium", sc.bg, sc.text)}>
                          <span className={clsx("h-1.5 w-1.5 rounded-full", sc.dot)} />
                          {sc.label}
                        </span>
                      </div>
                    </div>

                    {/* Description — 2 lines max, leading-relaxed. */}
                    <p className="mt-3 line-clamp-2 text-[11px] leading-relaxed text-zinc-400">
                      {agent.description}
                    </p>

                    {/* Stats footer — pinned right after description, not the
                        card bottom. Dimmer separator + inline stats. */}
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

                    {/* Quick actions on hover */}
                    <div className={clsx(
                      "absolute right-3 top-3 flex items-center gap-1 transition-opacity",
                      openMenu === agent.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    )}>
                      <button
                        onClick={(e) => handleQuickRun(agent, e)}
                        className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-lantern-500/10 hover:text-lantern-400"
                        title="Run agent"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenu(
                            openMenu === agent.id ? null : agent.id,
                          );
                        }}
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
                            onClick={(e) => { e.stopPropagation(); router.push(`/agents/${agent.name}`); setOpenMenu(null); }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-surface-3"
                          >
                            <Sparkles className="h-3 w-3" />
                            Edit
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); router.push(`/agents/${agent.name}?tab=schedule`); setOpenMenu(null); }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-surface-3"
                          >
                            <Calendar className="h-3 w-3" />
                            Schedule
                          </button>
                          <div className="my-1 border-t border-zinc-800" />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDelete(agent);
                              setOpenMenu(null);
                            }}
                            disabled={deletingId === agent.id}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                          >
                            {deletingId === agent.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* No results for filter */}
            {filtered.length === 0 && agents.length > 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Search className="mb-3 h-8 w-8 text-zinc-600" />
                <p className="text-sm text-zinc-400">
                  No agents match your search.
                </p>
                <button
                  onClick={() => setSearch("")}
                  className="mt-2 text-xs text-lantern-400 transition-colors hover:text-lantern-300"
                >
                  Clear search
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Click-away handler for overflow menus */}
      {openMenu && (
        <div className="fixed inset-0 z-10" onClick={() => setOpenMenu(null)} />
      )}

      {/* Delete confirmation. Real modal — not a window.confirm() — so the
          copy can carry the agent name + the irreversibility callout. */}
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
// Stats strip tile — used above the agent grid.
// ---------------------------------------------------------------------------

function Stat({
  label,
  value,
  hint,
  live,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  live?: boolean;
  tone?: "danger";
}) {
  const isDanger = tone === "danger";
  return (
    <div
      className={clsx(
        "group relative overflow-hidden rounded-xl border bg-surface-1 p-4 transition-all duration-150",
        isDanger
          ? "border-red-500/30 hover:border-red-500/50"
          : "border-zinc-800 hover:border-zinc-700"
      )}
    >
      {/* Subtle gradient sheen on hover — glassy feel. Red on danger tiles. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{
          background: isDanger
            ? "linear-gradient(135deg, rgba(248,113,113,0.08), transparent 60%)"
            : "linear-gradient(135deg, rgba(124,109,248,0.06), transparent 60%)",
        }}
      />
      <div className="relative">
        <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          {label}
          {live && (
            <span className="inline-flex items-center gap-1 rounded-full bg-lantern-500/15 px-1.5 py-0 text-[11px] font-medium text-lantern-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lantern-400" />
              live
            </span>
          )}
        </p>
        <p
          className={clsx(
            "mt-1.5 text-xl font-semibold tabular-nums",
            isDanger ? "text-red-300" : "text-zinc-100"
          )}
        >
          {value}
        </p>
        {hint && (
          <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>
        )}
      </div>
    </div>
  );
}
