"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  Search,
  Filter,
  Play,
  Loader2,
  ChevronDown,
  ChevronRight,
  Activity,
} from "lucide-react";
import { useRuns, useAgents } from "@/lib/hooks";
import { formatCost, formatDuration } from "@/lib/mock-data";
import type { Run, RunStatus } from "@/lib/mock-data";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { PageSkeleton } from "@/components/skeleton";

const statusOptions: Array<{ value: RunStatus | "all"; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

export default function RunsPage() {
  const router = useRouter();
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const { agents } = useAgents();
  const {
    runs,
    loading: runsLoading,
    error,
    isDemo,
  } = useRuns({
    agentName: agentFilter !== "all" ? agentFilter : undefined,
    status: statusFilter !== "all" ? (statusFilter as RunStatus) : undefined,
    search: searchQuery || undefined,
  });

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      if (agentFilter !== "all" && run.agentName !== agentFilter) return false;
      if (statusFilter !== "all" && run.status !== statusFilter) return false;
      if (
        searchQuery &&
        !run.id.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !run.agentName.toLowerCase().includes(searchQuery.toLowerCase())
      )
        return false;
      return true;
    });
  }, [runs, agentFilter, statusFilter, searchQuery]);

  if (runsLoading && runs.length === 0) return <PageSkeleton />;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <div className="flex items-center gap-3">
          <Activity className="h-5 w-5 text-zinc-400" />
          <h1 className="text-xl font-semibold text-zinc-100">Runs</h1>
          <span className="inline-flex items-center justify-center rounded-full bg-surface-3 px-2.5 py-0.5 text-xs font-medium text-zinc-400">
            {filteredRuns.length}
          </span>
          {isDemo && (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
              Demo data
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-zinc-500">Monitor all agent runs across your workspace.</p>
      </div>

      {/* Filter bar */}
      <div className="border-b border-zinc-800 bg-surface-1/50 px-8 py-3">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              placeholder="Search runs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-64 rounded-lg border border-zinc-800 bg-surface-0 pl-9 pr-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-lantern-500/50 focus:outline-none focus:ring-1 focus:ring-lantern-500/20"
            />
          </div>

          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-zinc-500" />
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="h-9 rounded-lg border border-zinc-800 bg-surface-0 px-3 text-sm text-zinc-300 focus:border-lantern-500/50 focus:outline-none focus:ring-1 focus:ring-lantern-500/20"
            >
              <option value="all">All agents</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.name}>
                  {agent.name}
                </option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 rounded-lg border border-zinc-800 bg-surface-0 px-3 text-sm text-zinc-300 focus:border-lantern-500/50 focus:outline-none focus:ring-1 focus:ring-lantern-500/20"
            >
              {statusOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <span className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
            {runsLoading && <Loader2 className="h-3 w-3 animate-spin" />}
          </span>
        </div>
      </div>

      <div className="flex-1 p-8">
        {error ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <p className="text-sm text-red-400">Failed to load runs: {error.message}</p>
              <p className="mt-2 text-xs text-zinc-500">Check that the API is running, or refresh to use demo data.</p>
            </div>
          </div>
        ) : filteredRuns.length === 0 && !runsLoading ? (
          <EmptyState
            icon={Play}
            title="No runs yet"
            description="Run an agent from its detail page to see results here."
          />
        ) : (
          <div className="space-y-1">
            {/* Table header */}
            <div className="grid grid-cols-[auto_1fr_1fr_100px_80px_140px] gap-4 px-4 py-2 text-xs font-medium text-zinc-500">
              <span className="w-4" />
              <span>Status</span>
              <span>Agent</span>
              <span>Duration</span>
              <span>Cost</span>
              <span>Started</span>
            </div>

            {filteredRuns.map((run) => {
              const isExpanded = expandedRunId === run.id;
              const duration = run.startedAt
                ? formatDuration(new Date(run.finishedAt ?? new Date()).getTime() - new Date(run.startedAt).getTime())
                : "--";

              return (
                <div key={run.id} className="rounded-lg border border-zinc-800 bg-surface-1">
                  <button
                    onClick={() => setExpandedRunId(isExpanded ? null : run.id)}
                    className="grid w-full grid-cols-[auto_1fr_1fr_100px_80px_140px] items-center gap-4 px-4 py-3 text-left text-sm transition-colors hover:bg-surface-2"
                  >
                    {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-zinc-500" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />}
                    <div className="flex items-center gap-3">
                      <StatusBadge status={run.status} />
                      <span className="font-mono text-xs text-zinc-500">{run.id.slice(0, 16)}</span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); router.push(`/agents/${run.agentName}`); }}
                      className="text-left font-medium text-zinc-300 hover:text-zinc-100"
                    >
                      {run.agentName}
                    </button>
                    <span className="text-zinc-400">{duration}</span>
                    <span className="font-mono text-xs text-zinc-400">{formatCost(run.costUsd)}</span>
                    <span className="text-zinc-500">
                      {run.startedAt ? format(new Date(run.startedAt), "MMM d, HH:mm:ss") : "--"}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-zinc-800 p-4">
                      {run.output ? (
                        <div className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-surface-0 p-3 font-mono text-sm leading-relaxed text-zinc-200">
                          {typeof run.output === "string"
                            ? run.output
                            : typeof run.output === "object" && run.output !== null && "result" in (run.output as Record<string, unknown>)
                              ? String((run.output as Record<string, unknown>).result)
                              : JSON.stringify(run.output, null, 2)}
                        </div>
                      ) : run.error ? (
                        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                          <p className="text-xs font-medium text-red-400">{run.error.code}</p>
                          <p className="mt-1 text-xs text-red-300/70">{run.error.message}</p>
                        </div>
                      ) : (
                        <p className="text-xs text-zinc-600">No output available.</p>
                      )}
                      <div className="mt-2 flex justify-end">
                        <button
                          onClick={() => router.push(`/runs/${run.id}`)}
                          className="text-xs font-medium text-indigo-400 transition-colors hover:text-indigo-300"
                        >
                          View full details
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
