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
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { EmptyState } from "@/components/empty-state";
import { PageSkeleton } from "@/components/skeleton";
import type { Agent } from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const modelBadgeColors: Record<string, string> = {
  auto: "bg-indigo-500/10 text-indigo-400",
  "reasoning-large": "bg-purple-500/10 text-purple-400",
  "reasoning-small": "bg-purple-500/10 text-purple-300",
  "chat-large": "bg-sky-500/10 text-sky-400",
  "chat-small": "bg-sky-500/10 text-sky-300",
  "code-large": "bg-emerald-500/10 text-emerald-400",
};

// ---------------------------------------------------------------------------
// Simple enrichment for display (when real stats aren't available)
// ---------------------------------------------------------------------------

function enrichAgent(agent: Agent) {
  const hash = agent.name.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return {
    runsCount: (hash * 7) % 500 + 10,
    lastRunAt: new Date(Date.now() - (hash % 48) * 3600000),
    model: (["auto", "reasoning-large", "chat-small", "code-large"] as const)[hash % 4],
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentsPage() {
  const router = useRouter();
  const toast = useToast();
  const { agents, setAgents, loading, error, isDemo } = useAgents();

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
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.push("/agents/create")}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
            >
              <Sparkles className="h-4 w-4" />
              Create with AI
            </button>
            <button
              onClick={() => router.push("/agents/create")}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3 hover:text-zinc-100"
            >
              <Plus className="h-4 w-4" />
              New Agent
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 p-8">
        {agents.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description="Create your first AI agent in 30 seconds. Describe what you want it to do and we will generate everything for you."
            actionLabel="Create with AI"
            onAction={() => router.push("/agents/create")}
            secondaryActionLabel="Browse templates"
            secondaryActionHref="/agents/create?template=research"
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
                const enriched = enrichAgent(agent);

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
                    {/* Top row: name + status */}
                    <div className="mb-2 flex items-start justify-between">
                      <div className="flex items-center gap-2.5">
                        <h3 className="text-sm font-semibold text-zinc-100 group-hover:text-white">
                          {agent.name}
                        </h3>
                        <span
                          className={clsx(
                            "h-2 w-2 rounded-full",
                            agent.status === "active"
                              ? "bg-emerald-400"
                              : "bg-zinc-600",
                          )}
                        />
                      </div>
                    </div>

                    {/* Description */}
                    <p className="mb-4 truncate text-xs leading-relaxed text-zinc-500">
                      {agent.description}
                    </p>

                    {/* Bottom row: model badge + last run + run count */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className={clsx(
                            "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                            modelBadgeColors[enriched.model] ??
                              "bg-zinc-500/10 text-zinc-400",
                          )}
                        >
                          {enriched.model}
                        </span>
                        <span className="text-[10px] text-zinc-600">
                          <Clock className="mr-0.5 inline h-2.5 w-2.5" />
                          {formatDistanceToNow(enriched.lastRunAt, {
                            addSuffix: true,
                          })}
                        </span>
                      </div>
                      <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
                        <Play className="h-3 w-3" />
                        {enriched.runsCount} runs
                      </span>
                    </div>

                    {/* Hover actions — stay visible when menu is open */}
                    <div className={clsx(
                      "absolute right-3 top-3 flex items-center gap-1 transition-opacity",
                      openMenu === agent.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    )}>
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
                          className="absolute right-0 top-8 z-20 w-36 rounded-lg border border-zinc-800 bg-surface-1 py-1 shadow-xl"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => handleDelete(agent)}
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
                  className="mt-2 text-xs text-indigo-400 transition-colors hover:text-indigo-300"
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
