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
  Trash2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import clsx from "clsx";
import { useRuns, useAgents } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { api } from "@/lib/api";
import { formatCost, formatDuration } from "@/lib/mock-data";
import type { RunStatus } from "@/lib/mock-data";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { PageSkeleton } from "@/components/skeleton";

const RUNS_PER_PAGE = 15;
const statusOptions: Array<{ value: RunStatus | "all"; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

function stepIcon(stepName: string) {
  if (stepName.includes("gmail") || stepName.includes("email") || stepName.includes("fetch_gmail")) return { icon: "📧", color: "bg-red-500/10 text-red-400" };
  if (stepName.includes("llm") || stepName.includes("call_llm")) return { icon: "🧠", color: "bg-purple-500/10 text-purple-400" };
  if (stepName.includes("prompt") || stepName.includes("build")) return { icon: "📝", color: "bg-blue-500/10 text-blue-400" };
  if (stepName.includes("save") || stepName.includes("output")) return { icon: "💾", color: "bg-emerald-500/10 text-emerald-400" };
  if (stepName.includes("complete") || stepName.includes("finish")) return { icon: "✅", color: "bg-emerald-500/10 text-emerald-400" };
  if (stepName.includes("data") || stepName.includes("fetch")) return { icon: "🔍", color: "bg-amber-500/10 text-amber-400" };
  return { icon: "⚡", color: "bg-zinc-500/10 text-zinc-400" };
}

function cleanOutput(raw: string): string {
  return raw.replace(/\*\*(.*?)\*\*/g, "$1").replace(/^#{1,3}\s+/gm, "").replace(/^- /gm, "  • ");
}

export default function RunsPage() {
  const router = useRouter();
  const toast = useToast();
  const [agentFilter, setAgentFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
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

  const totalPages = Math.max(1, Math.ceil(filtered.length / RUNS_PER_PAGE));
  const pageRuns = filtered.slice(page * RUNS_PER_PAGE, (page + 1) * RUNS_PER_PAGE);

  if (loading && runs.length === 0) return <PageSkeleton />;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <div className="flex items-center gap-3">
          <Activity className="h-5 w-5 text-zinc-400" />
          <h1 className="text-xl font-semibold text-zinc-100">Runs</h1>
          <span className="rounded-full bg-surface-3 px-2.5 py-0.5 text-xs font-medium text-zinc-400">{filtered.length}</span>
          {isDemo && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">Demo data</span>}
        </div>
        <p className="mt-1 text-sm text-zinc-500">Monitor all agent runs across your workspace.</p>
      </div>

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
          <div className="text-center py-12"><p className="text-sm text-red-400">Failed to load runs: {error.message}</p></div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={Play} title="No runs yet" description="Run an agent from its detail page to see results here." />
        ) : (
          <div className="space-y-1">
            {/* Pagination header */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-zinc-500">{filtered.length} run{filtered.length !== 1 ? "s" : ""}</span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-600">Page {page + 1} of {totalPages}</span>
                <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-surface-3 disabled:opacity-30">Prev</button>
                <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-surface-3 disabled:opacity-30">Next</button>
              </div>
            </div>

            {pageRuns.map((run) => {
              const expanded = expandedRunId === run.id;
              const dur = run.startedAt ? formatDuration(new Date(run.finishedAt ?? new Date()).getTime() - new Date(run.startedAt).getTime()) : "--";
              const confirming = deletingRunId === `confirm_${run.id}`;

              return (
                <div key={run.id} className="group rounded-lg border border-zinc-800 bg-surface-1">
                  <div className="flex items-center">
                    <button onClick={() => setExpandedRunId(expanded ? null : run.id)} className="flex flex-1 items-center gap-3 px-4 py-3 text-left text-sm hover:bg-surface-2 rounded-l-lg">
                      {expanded ? <ChevronDown className="h-3.5 w-3.5 text-zinc-500 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-500 shrink-0" />}
                      <StatusBadge status={run.status} />
                      <button onClick={(e) => { e.stopPropagation(); router.push(`/agents/${run.agentName}`); }} className="text-xs font-medium text-zinc-300 hover:text-white">{run.agentName}</button>
                      <span className="font-mono text-[10px] text-zinc-600 hidden sm:inline">{run.id.slice(0, 12)}</span>
                      <span className="ml-auto text-xs text-zinc-400">{dur}</span>
                      <span className="font-mono text-[11px] text-zinc-500">{formatCost(run.costUsd)}</span>
                      <span className="text-[11px] text-zinc-600 hidden md:inline">{run.startedAt ? format(new Date(run.startedAt), "MMM d, HH:mm") : "--"}</span>
                    </button>
                    {/* Delete */}
                    <div className={clsx("flex items-center pr-2", confirming ? "opacity-100" : "opacity-0 group-hover:opacity-100 transition-opacity")}>
                      {confirming ? (
                        <div className="flex items-center gap-1">
                          <button onClick={async () => { setDeletingRunId(run.id); try { await api.deleteRun(run.id); toast.success("Deleted"); refresh(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); } finally { setDeletingRunId(null); } }} disabled={deletingRunId === run.id} className="rounded px-2 py-1 text-[10px] font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20">{deletingRunId === run.id ? "..." : "Yes"}</button>
                          <button onClick={() => setDeletingRunId(null)} className="rounded px-2 py-1 text-[10px] text-zinc-500 hover:text-zinc-300">No</button>
                        </div>
                      ) : (
                        <button onClick={() => setDeletingRunId(`confirm_${run.id}`)} className="rounded p-1 text-zinc-600 hover:text-red-400 hover:bg-red-500/10" title="Delete"><Trash2 className="h-3 w-3" /></button>
                      )}
                    </div>
                  </div>

                  {expanded && (
                    <div className="border-t border-zinc-800 p-4 space-y-4">
                      {/* Execution Steps */}
                      {(() => {
                        const raw = Array.isArray(run.triggerMeta) ? run.triggerMeta as Array<Record<string, string>> : [];
                        const stepMap = new Map<string, Record<string, string>>();
                        for (const s of raw) stepMap.set(s.step, s);
                        const steps = Array.from(stepMap.values());
                        const isRunDone = run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
                        if (steps.length === 0) return null;
                        return (
                          <div>
                            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Execution Log</p>
                            <div className="space-y-1">
                              {steps.map((s, i) => {
                                const done = s.status === "completed" || (isRunDone && s.status === "running");
                                const si = stepIcon(s.step);
                                return (
                                  <div key={i} className="flex items-center gap-3 rounded-lg px-3 py-2 bg-surface-0">
                                    <div className={clsx("flex h-7 w-7 items-center justify-center rounded-lg text-sm shrink-0", si.color)}>
                                      {!done && s.status === "running" && !isRunDone ? <div className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" /> : si.icon}
                                    </div>
                                    <span className={clsx("flex-1 text-xs", done ? "text-zinc-200" : "text-zinc-500")}>{s.detail}</span>
                                    {done && <CheckCircle2 className="h-3 w-3 text-emerald-500/60 shrink-0" />}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
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
            })}
          </div>
        )}
      </div>
    </div>
  );
}
