"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Search, Filter, Play, Loader2 } from "lucide-react";
import { useRuns, useAgents } from "@/lib/hooks";
import { RunDialog } from "@/components/run-dialog";
import { formatCost, formatDuration } from "@/lib/mock-data";
import type { Run, RunStatus } from "@/lib/mock-data";
import { StatusBadge } from "@/components/status-badge";
import { DataTable, type Column } from "@/components/data-table";
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

const columns: Column<Run>[] = [
  {
    key: "status",
    header: "Status",
    render: (run) => <StatusBadge status={run.status} />,
  },
  {
    key: "agent",
    header: "Agent",
    render: (run) => (
      <span className="font-medium text-zinc-300">{run.agentName}</span>
    ),
  },
  {
    key: "duration",
    header: "Duration",
    render: (run) => {
      if (!run.startedAt) return <span className="text-zinc-600">--</span>;
      const end = run.finishedAt ?? new Date();
      const ms = new Date(end).getTime() - new Date(run.startedAt).getTime();
      return <span className="text-zinc-400">{formatDuration(ms)}</span>;
    },
  },
  {
    key: "cost",
    header: "Cost",
    render: (run) => (
      <span className="font-mono text-xs text-zinc-400">
        {formatCost(run.costUsd)}
      </span>
    ),
  },
  {
    key: "started",
    header: "Started",
    render: (run) => (
      <span className="text-zinc-500">
        {run.startedAt
          ? format(new Date(run.startedAt), "MMM d, HH:mm:ss")
          : "--"}
      </span>
    ),
  },
];

export default function RunsPage() {
  const router = useRouter();
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showRunDialog, setShowRunDialog] = useState(false);

  const { agents, loading: agentsLoading } = useAgents();
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

  // Client-side filtering as fallback (mock data doesn't filter server-side)
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

  const agentNames = useMemo(() => agents.map((a) => a.name), [agents]);

  if (runsLoading && runs.length === 0) return <PageSkeleton />;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
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
          <button
            onClick={() => setShowRunDialog(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400"
          >
            <Play className="h-4 w-4" />
            Run Agent
          </button>
        </div>
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
              <p className="text-sm text-red-400">
                Failed to load runs: {error.message}
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                Check that the API is running, or refresh to use demo data.
              </p>
            </div>
          </div>
        ) : filteredRuns.length === 0 && !runsLoading ? (
          <EmptyState
            icon={Play}
            title="No runs yet"
            description="Run an agent to see results here."
            actionLabel="Run Agent"
            onAction={() => setShowRunDialog(true)}
          />
        ) : (
          <DataTable
            columns={columns}
            rows={filteredRuns}
            rowKey={(r) => r.id}
            onRowClick={(run) => router.push(`/runs/${run.id}`)}
            emptyIcon={Play}
            emptyTitle="No runs match your filters"
            emptyDescription="Try adjusting your search or filters."
          />
        )}
      </div>

      {/* Run Dialog */}
      <RunDialog
        open={showRunDialog}
        onClose={() => setShowRunDialog(false)}
        agentNames={agentNames}
      />
    </div>
  );
}
