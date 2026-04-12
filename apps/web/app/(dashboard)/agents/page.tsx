"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Bot,
  Archive,
  Sparkles,
  Search,
  Play,
  MoreHorizontal,
  Trash2,
  Rocket,
  PenTool,
  MessageSquare,
  Plug,
  Clock,
  CheckCircle2,
  Loader2,
  TrendingUp,
  DollarSign,
  LayoutGrid,
  Code,
  Wand2,
  Workflow,
  Calendar,
  ShieldCheck,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { EmptyState } from "@/components/empty-state";
import { PageSkeleton } from "@/components/skeleton";
import type { Agent } from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type StatusFilter = "all" | "active" | "deploying" | "archived";
type SortOption = "recent" | "most-runs" | "alphabetical";

const templates = [
  { id: "blank", name: "Blank agent", desc: "Start from scratch", icon: Code },
  { id: "research", name: "Research agent", desc: "Web search and synthesis", icon: Wand2 },
  { id: "connector", name: "Connector agent", desc: "Integrates with external services", icon: Workflow },
  { id: "chatbot", name: "Conversational agent", desc: "WhatsApp, Slack, or web chat", icon: MessageSquare },
  { id: "scheduled", name: "Scheduled pipeline", desc: "Runs on a cron schedule", icon: Calendar },
  { id: "approval", name: "Human-in-the-loop", desc: "Approval gates and review flows", icon: ShieldCheck },
];

const modelBadgeColors: Record<string, string> = {
  auto: "bg-indigo-500/10 text-indigo-400",
  "reasoning-large": "bg-purple-500/10 text-purple-400",
  "reasoning-small": "bg-purple-500/10 text-purple-300",
  "chat-large": "bg-sky-500/10 text-sky-400",
  "chat-small": "bg-sky-500/10 text-sky-300",
  "code-large": "bg-emerald-500/10 text-emerald-400",
};

const statusBadge: Record<string, { bg: string; text: string; dot?: string }> = {
  active: { bg: "bg-emerald-500/10", text: "text-emerald-400", dot: "bg-emerald-400" },
  deploying: { bg: "bg-amber-500/10", text: "text-amber-400", dot: "bg-amber-400" },
  archived: { bg: "bg-zinc-500/10", text: "text-zinc-400" },
};

// ---------------------------------------------------------------------------
// Mock enrichment — in production this comes from the API
// ---------------------------------------------------------------------------

function mockEnrich(agent: Agent) {
  // Simulate stats for agents
  const hash = agent.name.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return {
    runsCount: (hash * 7) % 500 + 10,
    successRate: 85 + (hash % 15),
    avgCostUsd: +(((hash * 3) % 100) / 1000).toFixed(4),
    lastRunAt: new Date(Date.now() - ((hash % 48) * 3600000)),
    model: ["auto", "reasoning-large", "chat-small", "code-large"][hash % 4],
    surfaces: ["whatsapp", "slack", "webchat"].slice(0, (hash % 3) + 1),
    connectors: ["gmail", "github", "notion", "slack"].slice(0, (hash % 4) + 1),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgentsPage() {
  const router = useRouter();
  const toast = useToast();
  const { agents, setAgents, loading, error } = useAgents();

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("recent");

  // Template picker state
  const [showTemplates, setShowTemplates] = useState(false);

  // Overflow menu
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  // Deleting
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Filtering + sorting
  const filtered = useMemo(() => {
    let result = [...agents];

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q)
      );
    }

    // Status
    if (statusFilter !== "all") {
      result = result.filter((a) => a.status === statusFilter);
    }

    // Sort
    switch (sortBy) {
      case "recent":
        result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        break;
      case "most-runs":
        result.sort((a, b) => mockEnrich(b).runsCount - mockEnrich(a).runsCount);
        break;
      case "alphabetical":
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
    }

    return result;
  }, [agents, search, statusFilter, sortBy]);

  const handleDelete = async (agent: Agent) => {
    setDeletingId(agent.id);
    try {
      await api.deleteAgent(agent.name);
      setAgents((prev) => prev.filter((a) => a.id !== agent.id));
      toast.success(`Agent "${agent.name}" deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete agent");
    } finally {
      setDeletingId(null);
      setOpenMenu(null);
    }
  };

  if (loading) return <PageSkeleton />;

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-red-400">Failed to load agents: {error.message}</p>
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
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowTemplates(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3 hover:text-zinc-100"
            >
              <LayoutGrid className="h-4 w-4" />
              From template
            </button>
            <button
              onClick={() => router.push("/agents/create")}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
            >
              <Sparkles className="h-4 w-4" />
              Create with AI
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 p-8">
        {agents.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No agents yet"
            description="Create your first agent with AI in 30 seconds. Describe what you want it to do and we will generate everything for you."
            actionLabel="Create with AI"
            onAction={() => router.push("/agents/create")}
          />
        ) : (
          <>
            {/* Filters bar */}
            <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              {/* Search */}
              <div className="relative max-w-sm flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search agents..."
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 py-2 pl-10 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30"
                />
              </div>

              <div className="flex items-center gap-3">
                {/* Status filter chips */}
                <div className="flex items-center gap-1">
                  {(["all", "active", "deploying", "archived"] as StatusFilter[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      className={clsx(
                        "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                        statusFilter === s
                          ? "bg-surface-3 text-zinc-100"
                          : "text-zinc-500 hover:text-zinc-300"
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>

                {/* Sort */}
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                  className="rounded-lg border border-zinc-700 bg-surface-2 px-2.5 py-1 text-xs text-zinc-300 outline-none focus:border-indigo-500"
                >
                  <option value="recent">Recent</option>
                  <option value="most-runs">Most runs</option>
                  <option value="alphabetical">A-Z</option>
                </select>
              </div>
            </div>

            {/* Agent cards grid */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((agent) => {
                const enriched = mockEnrich(agent);
                const badge = statusBadge[agent.status] ?? statusBadge.active;

                return (
                  <div
                    key={agent.id}
                    className="card-hover group relative cursor-pointer rounded-xl border border-zinc-800 bg-surface-1 p-5 transition-all hover:border-zinc-700"
                    onClick={() => router.push(`/agents/${agent.name}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") router.push(`/agents/${agent.name}`);
                    }}
                  >
                    {/* Top row: name + status */}
                    <div className="mb-2 flex items-start justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10">
                          <Bot className="h-4 w-4 text-indigo-400" />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-zinc-100 group-hover:text-white">
                            {agent.name}
                          </h3>
                        </div>
                      </div>
                      <span
                        className={clsx(
                          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
                          badge.bg,
                          badge.text
                        )}
                      >
                        {badge.dot && <span className={clsx("h-1.5 w-1.5 rounded-full", badge.dot)} />}
                        {agent.status === "active" ? (
                          <span>active</span>
                        ) : agent.status === "archived" ? (
                          <><Archive className="h-2.5 w-2.5" /> archived</>
                        ) : (
                          agent.status
                        )}
                      </span>
                    </div>

                    {/* Description */}
                    <p className="mb-3 line-clamp-2 text-xs leading-relaxed text-zinc-500">
                      {agent.description}
                    </p>

                    {/* Stats row */}
                    <div className="mb-3 flex items-center gap-4 text-[11px] text-zinc-500">
                      <span className="inline-flex items-center gap-1">
                        <Play className="h-3 w-3" />
                        {enriched.runsCount} runs
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" />
                        {enriched.successRate}%
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <DollarSign className="h-3 w-3" />
                        ${enriched.avgCostUsd.toFixed(3)}/run
                      </span>
                    </div>

                    {/* Bottom row: model badge + surfaces + last run */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {/* Model capability badge */}
                        <span
                          className={clsx(
                            "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                            modelBadgeColors[enriched.model] ?? "bg-zinc-500/10 text-zinc-400"
                          )}
                        >
                          {enriched.model}
                        </span>

                        {/* Surface dots */}
                        {enriched.surfaces.length > 0 && (
                          <div className="flex items-center gap-0.5">
                            {enriched.surfaces.map((s) => (
                              <span
                                key={s}
                                className="tooltip h-2 w-2 rounded-full bg-zinc-600"
                                data-tooltip={s}
                              />
                            ))}
                          </div>
                        )}

                        {/* Connectors count */}
                        {enriched.connectors.length > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-600">
                            <Plug className="h-2.5 w-2.5" />
                            {enriched.connectors.length}
                          </span>
                        )}
                      </div>

                      {/* Last run + actions */}
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-zinc-600">
                          <Clock className="mr-0.5 inline h-2.5 w-2.5" />
                          {formatDistanceToNow(enriched.lastRunAt, { addSuffix: true })}
                        </span>
                      </div>
                    </div>

                    {/* Hover actions */}
                    <div className="absolute right-3 top-3 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          router.push(`/runs?agent=${agent.name}`);
                        }}
                        className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-200"
                        title="Run agent"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenu(openMenu === agent.id ? null : agent.id);
                        }}
                        className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-200"
                        title="More actions"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>

                      {/* Overflow menu */}
                      {openMenu === agent.id && (
                        <div
                          className="absolute right-0 top-8 z-20 w-40 rounded-lg border border-zinc-800 bg-surface-1 py-1 shadow-xl"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => { router.push(`/agents/${agent.name}/editor`); setOpenMenu(null); }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-surface-2"
                          >
                            <PenTool className="h-3 w-3" /> Visual Editor
                          </button>
                          <button
                            onClick={() => { router.push("/deployments"); setOpenMenu(null); }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-surface-2"
                          >
                            <Rocket className="h-3 w-3" /> Deploy
                          </button>
                          <hr className="my-1 border-zinc-800" />
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
                <p className="text-sm text-zinc-400">No agents match your filters.</p>
                <button
                  onClick={() => { setSearch(""); setStatusFilter("all"); }}
                  className="mt-2 text-xs text-indigo-400 transition-colors hover:text-indigo-300"
                >
                  Clear filters
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Template picker modal */}
      {showTemplates && (
        <div
          className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowTemplates(false)}
          onKeyDown={(e) => { if (e.key === "Escape") setShowTemplates(false); }}
        >
          <div
            className="modal-content w-full max-w-lg rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <h2 className="text-lg font-semibold text-zinc-100">Choose a template</h2>
              <button
                onClick={() => setShowTemplates(false)}
                className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
              >
                <span className="sr-only">Close</span>
                &times;
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 p-6">
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setShowTemplates(false);
                    router.push(`/agents/create?template=${t.id}`);
                  }}
                  className="card-hover flex items-center gap-3 rounded-xl border border-zinc-800 bg-surface-2 px-4 py-3.5 text-left transition-all hover:border-zinc-600"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-3">
                    <t.icon className="h-4 w-4 text-zinc-300" />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-zinc-200">{t.name}</div>
                    <div className="text-[11px] text-zinc-500">{t.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Click-away handler for overflow menus */}
      {openMenu && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => setOpenMenu(null)}
        />
      )}
    </div>
  );
}
