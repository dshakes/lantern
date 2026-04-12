"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  Bot,
  Rocket,
  Trash2,
  Tag,
  Clock,
  ArrowLeft,
  GitBranch,
  Play,
  Settings,
  LayoutDashboard,
  CheckCircle2,
  Loader2,
  PenTool,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useAgent, useAgentRuns, useAgentVersions } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { RunDialog } from "@/components/run-dialog";
import { StatusBadge } from "@/components/status-badge";
import { DataTable, type Column } from "@/components/data-table";
import { AgentDetailSkeleton } from "@/components/skeleton";
import { formatCost, formatDuration } from "@/lib/mock-data";
import type { Run, AgentVersion } from "@/lib/mock-data";

const tabs = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "versions", label: "Versions", icon: GitBranch },
  { key: "runs", label: "Runs", icon: Play },
  { key: "settings", label: "Settings", icon: Settings },
] as const;

type TabKey = (typeof tabs)[number]["key"];

const runColumns: Column<Run>[] = [
  {
    key: "id",
    header: "Run ID",
    render: (run) => (
      <span className="font-mono text-xs text-zinc-400">
        {run.id.slice(0, 16)}...
      </span>
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
      const ms = new Date(end).getTime() - new Date(run.startedAt).getTime();
      return <span className="text-zinc-400">{formatDuration(ms)}</span>;
    },
  },
  {
    key: "cost",
    header: "Cost",
    render: (run) => (
      <span className="text-zinc-400">{formatCost(run.costUsd)}</span>
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

const versionColumns: Column<AgentVersion>[] = [
  {
    key: "digest",
    header: "Digest",
    render: (v) => (
      <span className="font-mono text-xs text-zinc-400">{v.digest}</span>
    ),
  },
  {
    key: "created",
    header: "Created",
    render: (v) => (
      <span className="text-zinc-500">
        {format(new Date(v.createdAt), "MMM d, yyyy HH:mm")}
      </span>
    ),
  },
  {
    key: "promoted",
    header: "Status",
    render: (v) =>
      v.promoted ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-lantern-500/10 px-2.5 py-0.5 text-xs font-medium text-lantern-500">
          <CheckCircle2 className="h-3 w-3" />
          promoted
        </span>
      ) : (
        <span className="text-xs text-zinc-600">--</span>
      ),
  },
];

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const name = params.name as string;

  const { agent, loading: agentLoading, error: agentError } = useAgent(name);
  const { runs: agentRuns, loading: runsLoading } = useAgentRuns(name);
  const { versions, loading: versionsLoading } = useAgentVersions(name);

  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [deleting, setDeleting] = useState(false);
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  if (agentLoading) return <AgentDetailSkeleton />;

  if (agentError || !agent) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-zinc-500">Agent not found.</p>
      </div>
    );
  }

  const succeededRuns = agentRuns.filter((r) => r.status === "succeeded").length;
  const failedRuns = agentRuns.filter((r) => r.status === "failed").length;
  const totalCost = agentRuns.reduce((sum, r) => sum + r.costUsd, 0);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteAgent(name);
      toast.success(`Agent "${name}" deleted`);
      router.push("/agents");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete agent");
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <div className="mb-4">
          <button
            onClick={() => router.push("/agents")}
            className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to Agents
          </button>
        </div>
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-lantern-500/10">
              <Bot className="h-5 w-5 text-lantern-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-zinc-100">
                {agent.name}
              </h1>
              <p className="mt-0.5 text-sm text-zinc-500">
                {agent.description}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => router.push(`/agents/${name}/editor`)}
              className="inline-flex items-center gap-2 rounded-lg border border-lantern-500/30 px-4 py-2 text-sm font-medium text-lantern-400 transition-colors hover:bg-lantern-500/10"
            >
              <PenTool className="h-4 w-4" />
              Visual Editor
            </button>
            <button
              onClick={() => setShowRunDialog(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3"
            >
              <Play className="h-4 w-4" />
              Run Agent
            </button>
            <button className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400">
              <Rocket className="h-4 w-4" />
              Deploy
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="mt-6 flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                activeTab === tab.key
                  ? "bg-surface-3 text-zinc-100"
                  : "text-zinc-500 hover:bg-surface-2 hover:text-zinc-300"
              )}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 p-8">
        {activeTab === "overview" && (
          <div className="space-y-6">
            {/* Stats */}
            <div className="grid grid-cols-4 gap-4">
              <StatCard label="Current Version" value={agent.currentVersionId.slice(0, 12)} />
              <StatCard label="Total Runs" value={runsLoading ? "..." : String(agentRuns.length)} />
              <StatCard
                label="Success Rate"
                value={
                  runsLoading
                    ? "..."
                    : agentRuns.length > 0
                      ? `${Math.round((succeededRuns / agentRuns.length) * 100)}%`
                      : "--"
                }
              />
              <StatCard label="Total Cost" value={runsLoading ? "..." : formatCost(totalCost)} />
            </div>

            {/* Labels */}
            {agent.labels && Object.keys(agent.labels).length > 0 && (
              <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300">
                  <Tag className="h-4 w-4 text-zinc-500" />
                  Labels
                </h3>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(agent.labels).map(([key, value]) => (
                    <span
                      key={key}
                      className="rounded-md bg-surface-3 px-2.5 py-1 text-xs text-zinc-400"
                    >
                      <span className="text-zinc-500">{key}:</span> {value}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Info */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300">
                <Clock className="h-4 w-4 text-zinc-500" />
                Details
              </h3>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-zinc-500">Created</dt>
                  <dd className="mt-0.5 text-zinc-300">
                    {format(new Date(agent.createdAt), "MMMM d, yyyy 'at' HH:mm")}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Status</dt>
                  <dd className="mt-0.5 text-zinc-300 capitalize">{agent.status}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Succeeded / Failed</dt>
                  <dd className="mt-0.5">
                    <span className="text-emerald-400">{succeededRuns}</span>
                    <span className="text-zinc-600"> / </span>
                    <span className="text-red-400">{failedRuns}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Versions</dt>
                  <dd className="mt-0.5 text-zinc-300">
                    {versionsLoading ? "..." : versions.length}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        )}

        {activeTab === "versions" && (
          versionsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
            </div>
          ) : (
            <DataTable
              columns={versionColumns}
              rows={versions}
              rowKey={(v) => v.id}
            />
          )
        )}

        {activeTab === "runs" && (
          runsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
            </div>
          ) : (
            <DataTable
              columns={runColumns}
              rows={agentRuns}
              rowKey={(r) => r.id}
              onRowClick={(run) => router.push(`/runs/${run.id}`)}
            />
          )
        )}

        {activeTab === "settings" && (
          <div className="rounded-xl border border-zinc-800 bg-surface-1 p-8 text-center">
            <Settings className="mx-auto mb-3 h-8 w-8 text-zinc-600" />
            <p className="text-sm text-zinc-500">
              Agent settings -- configuration, environment variables, resource limits, and isolation class.
            </p>
          </div>
        )}
      </div>

      {/* Run Dialog */}
      <RunDialog
        open={showRunDialog}
        onClose={() => setShowRunDialog(false)}
        defaultAgentName={name}
      />

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl">
            <div className="px-6 py-5">
              <h3 className="text-lg font-semibold text-zinc-100">
                Delete agent
              </h3>
              <p className="mt-2 text-sm text-zinc-400">
                Are you sure you want to delete{" "}
                <span className="font-medium text-zinc-200">{name}</span>? This
                action cannot be undone.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 px-5 py-4">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold text-zinc-100">
        {value}
      </p>
    </div>
  );
}
