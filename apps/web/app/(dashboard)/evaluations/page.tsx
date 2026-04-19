"use client";

import { useState, useEffect, useMemo } from "react";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Clock,
  CheckCircle2,
  XCircle,
  Zap,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
  Loader2,
  Bot,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { HeaderSkeleton, Skeleton } from "@/components/skeleton";
import { PageHeader } from "@/components/page-header";
import { LineChart, type LineSeries } from "@/components/charts/line-chart";
import type { Run, Agent } from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number, decimals = 2): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(decimals);
}

function fmtUsd(n: number): string {
  if (n < 0.01 && n > 0) return `<$0.01`;
  return `$${n.toFixed(2)}`;
}

function fmtDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

interface AgentMetrics {
  name: string;
  totalRuns: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  successRate: number;
  totalCost: number;
  avgCost: number;
  avgLatencyMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  errorRate: number;
}

interface ModelMetrics {
  model: string;
  runs: number;
  totalCost: number;
  avgCost: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

function computeAgentMetrics(runs: Run[], agents: Agent[]): AgentMetrics[] {
  const grouped = new Map<string, Run[]>();
  for (const r of runs) {
    const name = r.agentName ?? r.agentId ?? "unknown";
    const list = grouped.get(name) ?? [];
    list.push(r);
    grouped.set(name, list);
  }

  // Also include agents with zero runs
  for (const a of agents) {
    if (!grouped.has(a.name)) grouped.set(a.name, []);
  }

  const metrics: AgentMetrics[] = [];
  for (const [name, agentRuns] of grouped) {
    const succeeded = agentRuns.filter((r) => r.status === "succeeded").length;
    const failed = agentRuns.filter((r) => r.status === "failed").length;
    const cancelled = agentRuns.filter((r) => r.status === "cancelled").length;
    const total = agentRuns.length;
    const totalCost = agentRuns.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    const totalTokensIn = agentRuns.reduce((s, r) => s + (r.tokensIn ?? 0), 0);
    const totalTokensOut = agentRuns.reduce((s, r) => s + (r.tokensOut ?? 0), 0);

    const latencies = agentRuns
      .filter((r) => r.startedAt && r.finishedAt)
      .map((r) => new Date(r.finishedAt!).getTime() - new Date(r.startedAt!).getTime());
    const avgLatencyMs = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

    metrics.push({
      name,
      totalRuns: total,
      succeeded,
      failed,
      cancelled,
      successRate: total > 0 ? succeeded / total : 0,
      totalCost,
      avgCost: total > 0 ? totalCost / total : 0,
      avgLatencyMs,
      totalTokensIn,
      totalTokensOut,
      errorRate: total > 0 ? failed / total : 0,
    });
  }

  return metrics.sort((a, b) => b.totalRuns - a.totalRuns);
}

function computeModelMetrics(runs: Run[]): ModelMetrics[] {
  // Group by model label. Runs may have a model in labels, otherwise bucket as "auto".
  const grouped = new Map<string, Run[]>();
  for (const r of runs) {
    const model = r.labels?.model ?? "auto";
    const list = grouped.get(model) ?? [];
    list.push(r);
    grouped.set(model, list);
  }

  const metrics: ModelMetrics[] = [];
  for (const [model, modelRuns] of grouped) {
    const totalCost = modelRuns.reduce((s, r) => s + (r.costUsd ?? 0), 0);
    metrics.push({
      model,
      runs: modelRuns.length,
      totalCost,
      avgCost: modelRuns.length > 0 ? totalCost / modelRuns.length : 0,
      totalTokensIn: modelRuns.reduce((s, r) => s + (r.tokensIn ?? 0), 0),
      totalTokensOut: modelRuns.reduce((s, r) => s + (r.tokensOut ?? 0), 0),
    });
  }

  return metrics.sort((a, b) => b.totalCost - a.totalCost);
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  subValue,
  icon: Icon,
  iconColor,
  iconBg,
  trend,
}: {
  label: string;
  value: string;
  subValue?: string;
  icon: typeof BarChart3;
  iconColor: string;
  iconBg: string;
  trend?: "up" | "down" | "neutral";
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
      <div className="flex items-center justify-between">
        <div className={clsx("flex h-9 w-9 items-center justify-center rounded-lg", iconBg)}>
          <Icon className={clsx("h-4.5 w-4.5", iconColor)} />
        </div>
        {trend && trend !== "neutral" && (
          <span
            className={clsx(
              "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium",
              trend === "up" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400",
            )}
          >
            {trend === "up" ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {trend === "up" ? "up" : "down"}
          </span>
        )}
      </div>
      <p className="mt-3 text-2xl font-semibold text-zinc-100">{value}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{label}</p>
      {subValue && <p className="mt-1 text-[11px] text-zinc-600">{subValue}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simple bar for inline charts
// ---------------------------------------------------------------------------

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const w = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="h-2 w-full rounded-full bg-surface-3">
      <div className={clsx("h-2 rounded-full", color)} style={{ width: `${w}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function EvaluationsPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState<"7d" | "30d" | "all">("7d");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [runData, agentData] = await Promise.all([api.listRuns(), api.listAgents()]);
        if (!cancelled) {
          setRuns(runData ?? []);
          setAgents(agentData ?? []);
        }
      } catch {
        // API unavailable -- show empty state
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filteredRuns = useMemo(() => {
    if (timeRange === "all") return runs;
    const now = Date.now();
    const ms = timeRange === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
    return runs.filter((r) => now - new Date(r.createdAt).getTime() < ms);
  }, [runs, timeRange]);

  const agentMetrics = useMemo(() => computeAgentMetrics(filteredRuns, agents), [filteredRuns, agents]);
  const modelMetrics = useMemo(() => computeModelMetrics(filteredRuns), [filteredRuns]);

  // Daily aggregates for the trend chart. Buckets each run by UTC date,
  // then walks forward over the chosen window so empty days render as zero.
  const { dailyLabels, dailySeries } = useMemo<{
    dailyLabels: string[];
    dailySeries: LineSeries[];
  }>(() => {
    const days = timeRange === "7d" ? 7 : timeRange === "30d" ? 30 : 30;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const labels: string[] = [];
    const runsByDay: number[] = [];
    const costByDay: number[] = [];
    const dayKeys: string[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      dayKeys.push(key);
      labels.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
      runsByDay.push(0);
      costByDay.push(0);
    }

    const idxByKey = new Map(dayKeys.map((k, i) => [k, i]));
    for (const r of filteredRuns) {
      const k = new Date(r.createdAt).toISOString().slice(0, 10);
      const i = idxByKey.get(k);
      if (i === undefined) continue;
      runsByDay[i]! += 1;
      costByDay[i]! += r.costUsd ?? 0;
    }

    return {
      dailyLabels: labels,
      dailySeries: [
        { name: "Runs", values: runsByDay, color: "#a78bfa" },
        // Scale cost x100 so $0.42 and 42 runs visually coexist; tooltip
        // formatter undoes the scale below.
        { name: "Cost (¢)", values: costByDay.map((c) => c * 100), color: "#fbbf24" },
      ],
    };
  }, [filteredRuns, timeRange]);

  // Global stats
  const totalRuns = filteredRuns.length;
  const totalSucceeded = filteredRuns.filter((r) => r.status === "succeeded").length;
  const totalFailed = filteredRuns.filter((r) => r.status === "failed").length;
  const totalCost = filteredRuns.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const avgCost = totalRuns > 0 ? totalCost / totalRuns : 0;
  const successRate = totalRuns > 0 ? totalSucceeded / totalRuns : 0;

  const latencies = filteredRuns
    .filter((r) => r.startedAt && r.finishedAt)
    .map((r) => new Date(r.finishedAt!).getTime() - new Date(r.startedAt!).getTime());
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

  const totalTokens = filteredRuns.reduce((s, r) => s + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0);

  const maxCostAgent = agentMetrics.reduce<AgentMetrics | null>((max, a) => (!max || a.totalCost > max.totalCost ? a : max), null);

  if (loading) {
    return (
      <div className="flex flex-1 flex-col overflow-auto">
        <HeaderSkeleton />
        <div className="p-8">
          <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
          <Skeleton className="mb-4 h-8 w-48 rounded-lg" />
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <PageHeader
        title="Analytics"
        description="Performance, cost attribution, and quality signals across every run."
        action={
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-surface-0 p-0.5">
            {(["7d", "30d", "all"] as const).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={clsx(
                  "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                  timeRange === range
                    ? "bg-surface-3 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                {range === "7d" ? "7 days" : range === "30d" ? "30 days" : "All time"}
              </button>
            ))}
          </div>
        }
      />

      <div className="flex-1 space-y-8 p-8">
        {/* Global stats */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Success rate"
            value={pct(successRate)}
            subValue={`${totalSucceeded} succeeded / ${totalRuns} total`}
            icon={CheckCircle2}
            iconColor="text-emerald-400"
            iconBg="bg-emerald-500/10"
            trend={successRate >= 0.9 ? "up" : successRate < 0.7 ? "down" : "neutral"}
          />
          <StatCard
            label="Total cost"
            value={fmtUsd(totalCost)}
            subValue={`${fmtUsd(avgCost)} avg per run`}
            icon={DollarSign}
            iconColor="text-amber-400"
            iconBg="bg-amber-500/10"
          />
          <StatCard
            label="Avg latency"
            value={fmtDuration(avgLatency)}
            subValue={`${fmt(totalTokens, 0)} total tokens`}
            icon={Clock}
            iconColor="text-blue-400"
            iconBg="bg-blue-500/10"
          />
          <StatCard
            label="Failed runs"
            value={String(totalFailed)}
            subValue={totalRuns > 0 ? `${pct(totalFailed / totalRuns)} error rate` : "No runs yet"}
            icon={XCircle}
            iconColor="text-red-400"
            iconBg="bg-red-500/10"
            trend={totalFailed === 0 ? "up" : "down"}
          />
        </div>

        {/* Daily trend chart */}
        <div>
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <TrendingUp className="h-4 w-4 text-zinc-500" />
            Activity over time
          </h2>
          <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
            {totalRuns === 0 ? (
              <div className="flex h-[240px] items-center justify-center text-sm text-zinc-500">
                No runs in this window yet.
              </div>
            ) : (
              <LineChart
                series={dailySeries}
                labels={dailyLabels}
                height={240}
                formatY={(n) => fmt(n, 0)}
              />
            )}
          </div>
        </div>

        {/* Agent performance table */}
        <div>
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Bot className="h-4 w-4 text-zinc-500" />
            Agent Performance
          </h2>
          {agentMetrics.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-surface-1 py-12">
              <BarChart3 className="mb-3 h-8 w-8 text-zinc-600" />
              <p className="text-sm text-zinc-500">No agent data yet. Run some agents to see metrics.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-zinc-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-surface-1">
                    <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500">Agent</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-zinc-500">Runs</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-zinc-500">Success rate</th>
                    <th className="hidden px-4 py-3 text-right text-xs font-medium text-zinc-500 md:table-cell">Avg cost</th>
                    <th className="hidden px-4 py-3 text-right text-xs font-medium text-zinc-500 lg:table-cell">Avg latency</th>
                    <th className="hidden px-4 py-3 text-right text-xs font-medium text-zinc-500 md:table-cell">Total cost</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-zinc-500">Errors</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {agentMetrics.map((a) => (
                    <tr key={a.name} className="bg-surface-0 transition-colors hover:bg-surface-1">
                      <td className="px-4 py-3">
                        <span className="font-medium text-zinc-200">{a.name}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-400">{a.totalRuns}</td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={clsx(
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                            a.successRate >= 0.9
                              ? "bg-emerald-500/10 text-emerald-400"
                              : a.successRate >= 0.7
                              ? "bg-amber-500/10 text-amber-400"
                              : "bg-red-500/10 text-red-400",
                          )}
                        >
                          {pct(a.successRate)}
                        </span>
                      </td>
                      <td className="hidden px-4 py-3 text-right text-zinc-400 md:table-cell">
                        {fmtUsd(a.avgCost)}
                      </td>
                      <td className="hidden px-4 py-3 text-right text-zinc-400 lg:table-cell">
                        {fmtDuration(a.avgLatencyMs)}
                      </td>
                      <td className="hidden px-4 py-3 text-right text-zinc-400 md:table-cell">
                        {fmtUsd(a.totalCost)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {a.failed > 0 ? (
                          <span className="text-red-400">{a.failed}</span>
                        ) : (
                          <span className="text-zinc-600">0</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Cost attribution */}
        <div>
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <DollarSign className="h-4 w-4 text-zinc-500" />
            Cost Attribution
          </h2>
          {agentMetrics.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-surface-1 py-12">
              <DollarSign className="mb-3 h-8 w-8 text-zinc-600" />
              <p className="text-sm text-zinc-500">No cost data available yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* Cost by agent bar chart */}
              <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
                <h3 className="mb-4 text-xs font-medium text-zinc-500 uppercase tracking-wide">Cost by agent</h3>
                <div className="space-y-3">
                  {agentMetrics
                    .filter((a) => a.totalCost > 0)
                    .slice(0, 8)
                    .map((a) => (
                      <div key={a.name}>
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-xs font-medium text-zinc-300 truncate max-w-[60%]">{a.name}</span>
                          <span className="text-xs text-zinc-500">{fmtUsd(a.totalCost)}</span>
                        </div>
                        <MiniBar
                          value={a.totalCost}
                          max={maxCostAgent?.totalCost ?? 1}
                          color="bg-amber-500/60"
                        />
                      </div>
                    ))}
                  {agentMetrics.filter((a) => a.totalCost > 0).length === 0 && (
                    <p className="py-4 text-center text-xs text-zinc-600">No cost data</p>
                  )}
                </div>
              </div>

              {/* Cost top-level stats */}
              <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
                <h3 className="mb-4 text-xs font-medium text-zinc-500 uppercase tracking-wide">Cost breakdown</h3>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-400">Total spend</span>
                    <span className="text-sm font-semibold text-zinc-100">{fmtUsd(totalCost)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-400">Average cost per run</span>
                    <span className="text-sm font-medium text-zinc-200">{fmtUsd(avgCost)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-400">Most expensive agent</span>
                    <span className="text-sm font-medium text-zinc-200">
                      {maxCostAgent ? `${maxCostAgent.name} (${fmtUsd(maxCostAgent.totalCost)})` : "N/A"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-400">Total tokens</span>
                    <span className="text-sm font-medium text-zinc-200">{fmt(totalTokens, 0)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-400">Active agents</span>
                    <span className="text-sm font-medium text-zinc-200">
                      {agentMetrics.filter((a) => a.totalRuns > 0).length}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Model usage */}
        <div>
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Zap className="h-4 w-4 text-zinc-500" />
            Model Usage
          </h2>
          {modelMetrics.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-surface-1 py-12">
              <Zap className="mb-3 h-8 w-8 text-zinc-600" />
              <p className="text-sm text-zinc-500">No model usage data yet.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-zinc-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 bg-surface-1">
                    <th className="px-4 py-3 text-left text-xs font-medium text-zinc-500">Model</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-zinc-500">Runs</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-zinc-500">Total cost</th>
                    <th className="hidden px-4 py-3 text-right text-xs font-medium text-zinc-500 md:table-cell">Avg cost</th>
                    <th className="hidden px-4 py-3 text-right text-xs font-medium text-zinc-500 md:table-cell">Tokens in</th>
                    <th className="hidden px-4 py-3 text-right text-xs font-medium text-zinc-500 md:table-cell">Tokens out</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {modelMetrics.map((m) => (
                    <tr key={m.model} className="bg-surface-0 transition-colors hover:bg-surface-1">
                      <td className="px-4 py-3">
                        <span className="font-medium text-zinc-200">{m.model}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-400">{m.runs}</td>
                      <td className="px-4 py-3 text-right text-zinc-400">{fmtUsd(m.totalCost)}</td>
                      <td className="hidden px-4 py-3 text-right text-zinc-400 md:table-cell">
                        {fmtUsd(m.avgCost)}
                      </td>
                      <td className="hidden px-4 py-3 text-right text-zinc-400 md:table-cell">
                        {fmt(m.totalTokensIn, 0)}
                      </td>
                      <td className="hidden px-4 py-3 text-right text-zinc-400 md:table-cell">
                        {fmt(m.totalTokensOut, 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Quality signals */}
        <div>
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <AlertTriangle className="h-4 w-4 text-zinc-500" />
            Quality Signals
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* Recent failures */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <h3 className="mb-3 text-xs font-medium text-zinc-500 uppercase tracking-wide">Recent failures</h3>
              {filteredRuns.filter((r) => r.status === "failed").length === 0 ? (
                <div className="flex items-center gap-2 py-4">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span className="text-sm text-emerald-400">No failures in this period</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredRuns
                    .filter((r) => r.status === "failed")
                    .slice(0, 5)
                    .map((r) => (
                      <div key={r.id} className="flex items-start gap-2 rounded-lg bg-red-500/5 p-2">
                        <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-zinc-300">
                            {r.agentName ?? r.agentId}
                          </p>
                          <p className="truncate text-[11px] text-zinc-500">
                            {r.error?.message ?? "Unknown error"}
                          </p>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>

            {/* Error rates by agent */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <h3 className="mb-3 text-xs font-medium text-zinc-500 uppercase tracking-wide">Error rates</h3>
              <div className="space-y-2">
                {agentMetrics
                  .filter((a) => a.totalRuns > 0)
                  .sort((a, b) => b.errorRate - a.errorRate)
                  .slice(0, 5)
                  .map((a) => (
                    <div key={a.name} className="flex items-center justify-between">
                      <span className="truncate text-xs text-zinc-300 max-w-[60%]">{a.name}</span>
                      <span
                        className={clsx(
                          "text-xs font-medium",
                          a.errorRate === 0
                            ? "text-emerald-400"
                            : a.errorRate < 0.1
                            ? "text-amber-400"
                            : "text-red-400",
                        )}
                      >
                        {pct(a.errorRate)}
                      </span>
                    </div>
                  ))}
                {agentMetrics.filter((a) => a.totalRuns > 0).length === 0 && (
                  <p className="py-4 text-center text-xs text-zinc-600">No data</p>
                )}
              </div>
            </div>

            {/* Throughput */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <h3 className="mb-3 text-xs font-medium text-zinc-500 uppercase tracking-wide">Throughput</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-400">Total runs</span>
                  <span className="text-sm font-semibold text-zinc-100">{totalRuns}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-400">Succeeded</span>
                  <span className="text-sm font-medium text-emerald-400">{totalSucceeded}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-400">Failed</span>
                  <span className="text-sm font-medium text-red-400">{totalFailed}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-400">Avg output tokens</span>
                  <span className="text-sm font-medium text-zinc-200">
                    {totalRuns > 0
                      ? fmt(
                          filteredRuns.reduce((s, r) => s + (r.tokensOut ?? 0), 0) / totalRuns,
                          0,
                        )
                      : "N/A"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
