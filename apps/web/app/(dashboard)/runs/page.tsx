"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Search, Filter } from "lucide-react";
import clsx from "clsx";
import {
  runs,
  agents,
  formatCost,
  formatTokens,
  formatDuration,
} from "@/lib/mock-data";
import type { Run, RunStatus } from "@/lib/mock-data";
import { StatusBadge } from "@/components/status-badge";
import { DataTable, type Column } from "@/components/data-table";

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
    key: "id",
    header: "ID",
    render: (run) => (
      <span className="font-mono text-xs text-zinc-400">
        {run.id.slice(0, 16)}...
      </span>
    ),
  },
  {
    key: "agent",
    header: "Agent",
    render: (run) => (
      <span className="font-medium text-zinc-300">{run.agentName}</span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (run) => <StatusBadge status={run.status} />,
  },
  {
    key: "duration",
    header: "Duration",
    render: (run) => {
      if (!run.startedAt) return <span className="text-zinc-600">--</span>;
      const end = run.finishedAt ?? new Date();
      const ms = end.getTime() - run.startedAt.getTime();
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
        {run.startedAt ? format(run.startedAt, "MMM d, HH:mm:ss") : "--"}
      </span>
    ),
  },
  {
    key: "tokens",
    header: "Tokens",
    render: (run) => (
      <span className="font-mono text-xs text-zinc-500">
        {run.tokensIn + run.tokensOut > 0
          ? formatTokens(run.tokensIn + run.tokensOut)
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
  }, [agentFilter, statusFilter, searchQuery]);

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <h1 className="text-xl font-semibold text-zinc-100">Runs</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Monitor and inspect agent run executions.
        </p>
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
              className="h-9 w-64 rounded-lg border border-zinc-800 bg-surface-2 pl-9 pr-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-lantern-500/50 focus:outline-none focus:ring-1 focus:ring-lantern-500/20"
            />
          </div>

          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-zinc-500" />
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="h-9 rounded-lg border border-zinc-800 bg-surface-2 px-3 text-sm text-zinc-300 focus:border-lantern-500/50 focus:outline-none"
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
              className="h-9 rounded-lg border border-zinc-800 bg-surface-2 px-3 text-sm text-zinc-300 focus:border-lantern-500/50 focus:outline-none"
            >
              {statusOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <span className="ml-auto text-xs text-zinc-500">
            {filteredRuns.length} run{filteredRuns.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      <div className="flex-1 p-8">
        <DataTable
          columns={columns}
          rows={filteredRuns}
          rowKey={(r) => r.id}
          onRowClick={(run) => router.push(`/runs/${run.id}`)}
        />
      </div>
    </div>
  );
}
