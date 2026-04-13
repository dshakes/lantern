"use client";

import { useState, useMemo } from "react";
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
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useAgents, useRuns } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { EmptyState } from "@/components/empty-state";
import { PageSkeleton } from "@/components/skeleton";
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
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const handleDelete = async (agent: Agent) => {
    setDeletingId(agent.id);
    try {
      await api.deleteAgent(agent.name);
      setAgents((prev) => prev.filter((a) => a.id !== agent.id));
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
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-red-400">
            Failed to load agents: {error.message}
          </p>
          <p className="mt-2 text-xs text-zinc-500">
            Check that the API is running at localhost:8080, or refresh to use
            demo data.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-zinc-100">Agents</h1>
            {agents.length > 0 && (
              <span className="inline-flex items-center justify-center rounded-full bg-surface-3 px-2.5 py-0.5 text-xs font-medium text-zinc-400">
                {agents.length}
              </span>
            )}
            {isDemo && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                Demo data
              </span>
            )}
          </div>
          <button
            onClick={() => router.push("/agents/create")}
            className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400"
          >
            <Plus className="h-4 w-4" />
            Create Agent
          </button>
        </div>
      </div>

      <div className="flex-1 p-8">
        {agents.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description="Create your first AI agent in 30 seconds. Describe what you want it to do and we will generate everything for you."
            actionLabel="Create Agent"
            onAction={() => router.push("/agents/create")}
          />
        ) : (
          <>
            {/* Search */}
            <div className="mb-6">
              <div className="relative max-w-sm">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search agents..."
                  className="w-full rounded-lg border border-zinc-800 bg-surface-0 py-2 pl-10 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/30"
                />
              </div>
            </div>

            {/* Agent cards grid */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((agent) => {
                const stats = getAgentStats(agent, runs);
                const displayStatus = deriveStatus(agent, runs);
                const sc = statusConfig[displayStatus];

                return (
                  <div
                    key={agent.id}
                    className="card-hover group relative cursor-pointer rounded-xl border border-zinc-800 bg-surface-1 p-5 transition-all hover:border-zinc-700"
                    onClick={() => router.push(`/agents/${agent.name}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        router.push(`/agents/${agent.name}`);
                    }}
                  >
                    {/* Top row: name + status badge */}
                    <div className="mb-2 flex items-start justify-between">
                      <div className="flex items-center gap-2.5">
                        <h3 className="text-sm font-semibold text-zinc-100 group-hover:text-white">
                          {agent.name}
                        </h3>
                        <span className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium", sc.bg, sc.text)}>
                          <span className={clsx("h-1.5 w-1.5 rounded-full", sc.dot)} />
                          {sc.label}
                        </span>
                      </div>
                    </div>

                    {/* Description */}
                    <p className="mb-4 truncate text-xs leading-relaxed text-zinc-500">
                      {agent.description}
                    </p>

                    {/* Stats row */}
                    <div className="flex items-center justify-between text-[10px]">
                      <div className="flex items-center gap-3">
                        <span className="inline-flex items-center gap-1 text-zinc-500">
                          <Play className="h-2.5 w-2.5" />
                          {stats.runsCount} runs
                        </span>
                        {stats.runsCount > 0 && (
                          <span className="inline-flex items-center gap-1 text-zinc-500">
                            <TrendingUp className="h-2.5 w-2.5" />
                            {stats.successRate}%
                          </span>
                        )}
                        {stats.lastRun?.startedAt && (
                          <span className="text-zinc-600">
                            <Clock className="mr-0.5 inline h-2.5 w-2.5" />
                            {formatDistanceToNow(new Date(stats.lastRun.startedAt), { addSuffix: true })}
                          </span>
                        )}
                      </div>
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
                            onClick={(e) => { e.stopPropagation(); handleDelete(agent); }}
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
    </div>
  );
}
