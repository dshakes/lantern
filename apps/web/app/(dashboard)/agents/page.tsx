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
  RefreshCw,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useAgents, useRuns } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { EmptyState } from "@/components/empty-state";
import { PageSkeleton } from "@/components/skeleton";
import { PageHeader, CountBadge, DemoBadge } from "@/components/page-header";
import { Button } from "@/components/button";
import { AgentAvatar } from "@/components/agent-avatar";
import { AgentsIllustration } from "@/components/illustrations";
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
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 ring-1 ring-red-500/20">
          <AlertCircle className="h-5 w-5 text-red-300" />
        </div>
        <h3 className="mt-4 text-(--text-base) font-semibold text-zinc-100">
          Couldn&apos;t load agents
        </h3>
        <p className="mt-1 max-w-sm text-center text-(--text-sm) text-zinc-500">
          {error.message}. Make sure the control-plane API is reachable.
        </p>
        <code className="mt-3 rounded-(--radius-md) border border-zinc-800 bg-surface-0 px-3 py-1.5 font-mono text-(--text-xs) text-zinc-300">
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
                    className="card-hover group relative cursor-pointer rounded-(--radius-lg) border border-zinc-800 bg-surface-1 p-5 transition-all duration-(--motion-fast) hover:border-zinc-700 hover:shadow-(--elev-2)"
                    onClick={() => router.push(`/agents/${agent.name}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        router.push(`/agents/${agent.name}`);
                    }}
                  >
                    {/* Identity row: avatar + name + status */}
                    <div className="mb-3 flex items-start gap-3">
                      <AgentAvatar
                        name={agent.name}
                        status={stats.lastRun?.status}
                        size="md"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="truncate text-(--text-sm) font-semibold text-zinc-100 group-hover:text-white">
                            {agent.name}
                          </h3>
                          <span className={clsx("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-(--text-xs) font-medium", sc.bg, sc.text)}>
                            <span className={clsx("h-1.5 w-1.5 rounded-full", sc.dot)} />
                            {sc.label}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-(--text-xs) leading-(--leading-relaxed) text-zinc-500">
                          {agent.description}
                        </p>
                      </div>
                    </div>

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
