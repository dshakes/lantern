"use client";

import { useState, useMemo, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import {
  Search,
  Filter,
  Play,
  Loader2,
  ChevronDown,
  ChevronRight,
  Layers,
  Trash2,
} from "lucide-react";
import clsx from "clsx";
import { useRuns, useAgents } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { formatCost, formatDuration } from "@/lib/mock-data";
import type { Run, RunStatus } from "@/lib/mock-data";
import {
  groupRunsBySession,
  aggregateSession,
  type SessionGroup,
} from "@/lib/session-grouping";
import { StatusBadge } from "@/components/status-badge";
import { ExecutionLog, deduplicateSteps } from "@/components/execution-log";
import { EmptyState } from "@/components/empty-state";
import { PageSkeleton } from "@/components/skeleton";
import { PageHeader, CountBadge, DemoBadge } from "@/components/page-header";
import { AgentAvatar } from "@/components/agent-avatar";
import { RunsIllustration } from "@/components/illustrations";

const RUNS_PER_PAGE = 15;
const statusOptions: Array<{ value: RunStatus | "all"; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

function cleanOutput(raw: string): string {
  return raw.replace(/\*\*(.*?)\*\*/g, "$1").replace(/^#{1,3}\s+/gm, "").replace(/^- /gm, "  • ");
}

export default function RunsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  // Initialize the agent filter from ?agent=... so deep links from the
  // per-agent workspace tabs land pre-scoped to that agent. Falls back
  // to "all" when the URL doesn't carry the param.
  const [agentFilter, setAgentFilter] = useState<string>(
    () => searchParams.get("agent") ?? "all"
  );
  useEffect(() => {
    const next = searchParams.get("agent") ?? "all";
    setAgentFilter((prev) => (prev === next ? prev : next));
  }, [searchParams]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);

  const { agents } = useAgents();
  const { runs, loading, error, isDemo, refresh } = useRuns({
    agentName: agentFilter !== "all" ? agentFilter : undefined,
    status: statusFilter !== "all" ? (statusFilter as RunStatus) : undefined,
  });

  const filtered = useMemo(() => {
    return runs.filter((run) => {
      if (agentFilter !== "all" && run.agentName !== agentFilter) return false;
      if (statusFilter !== "all" && run.status !== statusFilter) return false;
      if (searchQuery && !run.id.includes(searchQuery) && !run.agentName.includes(searchQuery)) return false;
      return true;
    });
  }, [runs, agentFilter, statusFilter, searchQuery]);

  // Group the FILTERED runs into sessions, then paginate over groups so a
  // multi-step session reads as one entry. Solo groups render like a single
  // row (no extra nesting chrome) — see RunGroup below.
  const groups = useMemo(() => groupRunsBySession(filtered), [filtered]);
  const totalPages = Math.max(1, Math.ceil(groups.length / RUNS_PER_PAGE));
  const pageGroups = groups.slice(page * RUNS_PER_PAGE, (page + 1) * RUNS_PER_PAGE);

  if (loading && runs.length === 0) return <PageSkeleton />;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Runs"
        description="Every agent run across your workspace. Expand a row to see steps, output, and cost."
        badge={
          <>
            {filtered.length > 0 && <CountBadge count={filtered.length} />}
            {isDemo && <DemoBadge />}
          </>
        }
      />

      {/* Filters */}
      <div className="border-b border-zinc-800 bg-surface-1/50 px-8 py-3">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input type="text" placeholder="Search runs..." value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
              className="h-9 w-56 rounded-lg border border-zinc-800 bg-surface-0 pl-9 pr-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-lantern-500/50 outline-none" />
          </div>
          <Filter className="h-4 w-4 text-zinc-500" />
          <select value={agentFilter} onChange={(e) => { setAgentFilter(e.target.value); setPage(0); }}
            className="h-9 rounded-lg border border-zinc-800 bg-surface-0 px-3 text-sm text-zinc-300 outline-none">
            <option value="all">All agents</option>
            {agents.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
            className="h-9 rounded-lg border border-zinc-800 bg-surface-0 px-3 text-sm text-zinc-300 outline-none">
            {statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {loading && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-zinc-500" />}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-8">
        {error ? (
          <div className="text-center py-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 ring-1 ring-red-500/20">
              <Trash2 className="h-5 w-5 text-red-300" />
            </div>
            <h3 className="mt-4 text-sm font-semibold text-zinc-100">Couldn&apos;t load runs</h3>
            <p className="mt-1 max-w-sm text-center text-xs text-zinc-500">{error.message}. Check that the control-plane API is reachable.</p>
            <code className="mt-3 rounded-lg border border-zinc-800 bg-surface-0 px-3 py-1.5 font-mono text-[11px] text-zinc-300">lantern dev</code>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            illustration={<RunsIllustration size={120} />}
            title="No runs yet"
            description="Runs appear here when you execute an agent. Open an agent and click Run, or trigger one from the API."
            actionLabel="View Agents"
            onAction={() => router.push("/agents")}
            secondaryActionLabel="See examples"
            secondaryActionHref="/marketplace"
          />
        ) : (
          <div className="space-y-1">
            {/* Pagination header */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-zinc-500">
                {filtered.length} run{filtered.length !== 1 ? "s" : ""}
                {groups.length !== filtered.length && (
                  <span className="text-zinc-600"> · {groups.length} session{groups.length !== 1 ? "s" : ""}</span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-600">Page {page + 1} of {totalPages}</span>
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-surface-3 disabled:opacity-30">Prev</button>
                <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-surface-3 disabled:opacity-30">Next</button>
              </div>
            </div>

            {pageGroups.map((grp) => (
              <RunGroup
                key={grp.key}
                group={grp}
                groupExpanded={expandedGroupKey === grp.key}
                onToggleGroup={() =>
                  setExpandedGroupKey((k) => (k === grp.key ? null : grp.key))
                }
                expandedRunId={expandedRunId}
                onToggleRun={(id) => setExpandedRunId((r) => (r === id ? null : id))}
                deletingRunId={deletingRunId}
                onConfirmDelete={(id) => setDeletingRunId(id)}
                onDelete={async (id) => {
                  setDeletingRunId(id);
                  try {
                    await api.deleteRun(id);
                    toast.success("Deleted");
                    refresh();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Failed");
                  } finally {
                    setDeletingRunId(null);
                  }
                }}
                onOpenAgent={(name) => router.push(`/agents/${name}`)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group — a session of related runs, or a single standalone run.
// A solo group renders exactly like the old single row (no nesting chrome);
// a multi-run group renders a collapsible header that rolls up the members.
// ---------------------------------------------------------------------------

interface RunRowHandlers {
  expandedRunId: string | null;
  onToggleRun: (id: string) => void;
  deletingRunId: string | null;
  onConfirmDelete: (token: string | null) => void;
  onDelete: (id: string) => void | Promise<void>;
  onOpenAgent: (name: string) => void;
}

function RunGroup({
  group,
  groupExpanded,
  onToggleGroup,
  ...rowHandlers
}: {
  group: SessionGroup;
  groupExpanded: boolean;
  onToggleGroup: () => void;
} & RunRowHandlers) {
  if (!group.isMulti) {
    return <RunRow run={group.runs[0]} {...rowHandlers} />;
  }

  const agg = aggregateSession(group.runs);

  return (
    <div className="rounded-lg border border-zinc-800 bg-surface-1 transition-colors duration-150 hover:border-zinc-700">
      <button
        onClick={onToggleGroup}
        aria-expanded={groupExpanded}
        className="flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left text-sm hover:bg-surface-2"
      >
        {groupExpanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
        )}
        <Layers className="h-3.5 w-3.5 text-lantern-400 shrink-0" />
        <span className="text-xs font-medium text-zinc-200">{agg.agentLabel}</span>
        <StatusBadge status={agg.status} />
        <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-zinc-400">
          {agg.count} runs
        </span>
        <span className="ml-auto text-[11px] text-zinc-400 tabular-nums">
          {agg.durationMs !== null ? formatDuration(agg.durationMs) : "--"}
        </span>
        <span className="font-mono text-[11px] text-zinc-500 tabular-nums">{formatCost(agg.totalCost)}</span>
        <span className="hidden text-[11px] tabular-nums text-zinc-600 md:inline">
          {format(agg.latestAt, "MMM d, HH:mm")}
        </span>
      </button>

      {groupExpanded && (
        <div className="border-t border-zinc-800 p-2 space-y-1">
          {group.runs.map((run) => (
            <RunRow key={run.id} run={run} {...rowHandlers} />
          ))}
        </div>
      )}
    </div>
  );
}

// Single run row — the exact pre-grouping rendering, extracted so the group
// expand reuses it and delete/expand/cost stay per row.
function RunRow({
  run,
  expandedRunId,
  onToggleRun,
  deletingRunId,
  onConfirmDelete,
  onDelete,
  onOpenAgent,
}: { run: Run } & RunRowHandlers) {
  const expanded = expandedRunId === run.id;
  const dur = run.startedAt
    ? formatDuration(new Date(run.finishedAt ?? new Date()).getTime() - new Date(run.startedAt).getTime())
    : "--";
  const confirming = deletingRunId === `confirm_${run.id}`;

  return (
    <div className="group rounded-lg border border-zinc-800 bg-surface-1 transition-colors duration-150 hover:border-zinc-700">
      <div className="flex items-center">
        <button onClick={() => onToggleRun(run.id)} aria-expanded={expanded} className="flex flex-1 items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-surface-2 rounded-l-lg">
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-zinc-500 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-500 shrink-0" />}
          <AgentAvatar name={run.agentName} status={run.status} size="sm" />
          <button onClick={(e) => { e.stopPropagation(); onOpenAgent(run.agentName); }} className="text-xs font-medium text-zinc-200 hover:text-white">{run.agentName}</button>
          <StatusBadge status={run.status} />
          <span className="font-mono text-[11px] text-zinc-600 hidden sm:inline">{run.id.slice(0, 12)}</span>
          <span className="ml-auto text-[11px] text-zinc-400 tabular-nums">{dur}</span>
          <span className="font-mono text-[11px] text-zinc-500 tabular-nums">{formatCost(run.costUsd)}</span>
          <span className="text-[11px] text-zinc-600 hidden md:inline tabular-nums">{run.startedAt ? format(new Date(run.startedAt), "MMM d, HH:mm") : "--"}</span>
        </button>
        {/* Delete */}
        <div className={clsx("flex items-center pr-2", confirming ? "opacity-100" : "opacity-0 group-hover:opacity-100 transition-opacity")}>
          {confirming ? (
            <div className="flex items-center gap-1">
              <button onClick={() => onDelete(run.id)} disabled={deletingRunId === run.id} className="rounded px-2 py-1 text-[10px] font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20">{deletingRunId === run.id ? "..." : "Yes"}</button>
              <button onClick={() => onConfirmDelete(null)} className="rounded px-2 py-1 text-[10px] text-zinc-500 hover:text-zinc-300">No</button>
            </div>
          ) : (
            <button onClick={() => onConfirmDelete(`confirm_${run.id}`)} className="rounded p-1 text-zinc-600 hover:text-red-400 hover:bg-red-500/10" title="Delete"><Trash2 className="h-3 w-3" /></button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-800 p-4 space-y-4">
          {/* Execution Steps */}
          <ExecutionLog
            steps={deduplicateSteps(run.triggerMeta)}
            isRunDone={run.status === "succeeded" || run.status === "failed" || run.status === "cancelled"}
            isRunning={run.status === "running"}
          />
          {/* Output */}
          {run.output ? (
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Result</p>
              <div className="max-h-80 overflow-auto rounded-lg border border-emerald-500/10 bg-emerald-500/[0.02] p-4">
                <pre className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200 font-sans">
                  {cleanOutput(typeof run.output === "string" ? run.output : typeof run.output === "object" && run.output !== null && "result" in (run.output as Record<string, unknown>) ? String((run.output as Record<string, unknown>).result) : JSON.stringify(run.output, null, 2))}
                </pre>
              </div>
            </div>
          ) : run.error ? (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
              <p className="text-xs font-medium text-red-400">{run.error.code}</p>
              <p className="mt-1 text-xs text-red-300/70">{run.error.message}</p>
            </div>
          ) : run.status === "running" ? (
            <div className="flex items-center gap-2.5 py-3"><div className="h-4 w-4 rounded-full border-2 border-lantern-400 border-t-transparent animate-spin" /><span className="text-sm text-zinc-400">Processing...</span></div>
          ) : <p className="text-xs text-zinc-600">No output available.</p>}
        </div>
      )}
    </div>
  );
}
