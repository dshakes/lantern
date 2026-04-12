"use client";

import { useRouter } from "next/navigation";
import { Plus, Bot, Archive } from "lucide-react";
import { format } from "date-fns";
import { agents } from "@/lib/mock-data";
import { DataTable, type Column } from "@/components/data-table";
import type { Agent } from "@/lib/mock-data";

const columns: Column<Agent>[] = [
  {
    key: "name",
    header: "Name",
    render: (agent) => (
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-3">
          <Bot className="h-3.5 w-3.5 text-lantern-500" />
        </div>
        <span className="font-medium text-zinc-100">{agent.name}</span>
      </div>
    ),
  },
  {
    key: "description",
    header: "Description",
    render: (agent) => (
      <span className="max-w-xs truncate text-zinc-400">
        {agent.description}
      </span>
    ),
  },
  {
    key: "version",
    header: "Version",
    render: (agent) => (
      <span className="font-mono text-xs text-zinc-500">
        {agent.currentVersionId.slice(0, 12)}
      </span>
    ),
  },
  {
    key: "created",
    header: "Created",
    render: (agent) => (
      <span className="text-zinc-500">
        {format(agent.createdAt, "MMM d, yyyy")}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (agent) =>
      agent.status === "active" ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          active
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-500/10 px-2.5 py-0.5 text-xs font-medium text-zinc-400">
          <Archive className="h-3 w-3" />
          archived
        </span>
      ),
  },
];

export default function AgentsPage() {
  const router = useRouter();

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Agents</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Manage your deployed AI agents.
            </p>
          </div>
          <button className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-lantern-400">
            <Plus className="h-4 w-4" />
            New Agent
          </button>
        </div>
      </div>

      <div className="flex-1 p-8">
        <DataTable
          columns={columns}
          rows={agents}
          rowKey={(a) => a.id}
          onRowClick={(agent) => router.push(`/agents/${agent.name}`)}
        />
      </div>
    </div>
  );
}
