"use client";

// /overview — PAL Runtime home: health, runs and cost at a glance, an
// "ask PAL" command bar, recent failures with one-click explanations, and
// AI-suggested next steps. Every number is a real API read; a source that
// fails shows "—", never a fabricated value.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { formatDistanceToNow } from "date-fns";
import { Activity, AlertTriangle, ArrowRight, Bot, DollarSign, Plus, RefreshCw, Server } from "lucide-react";
import { api, type FleetUsage } from "@/lib/api";
import type { Agent, Run } from "@/lib/mock-data";
import { runtimeApi } from "@/lib/runtime-api";
import type { VmRow } from "@/lib/runtime-types";
import { useModels } from "@/lib/model-context";
import { PageHeader } from "@/components/page-header";
import { Button, LinkButton } from "@/components/button";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { AskBar } from "@/components/ask-bar";
import { ExplainInline } from "@/components/explain-inline";
import { SuggestedSteps } from "@/components/suggested-steps";
import { openAsk } from "@/lib/ask-events";

const HOUR = 3_600_000;

function ts(d: Date | string | undefined): number {
  if (!d) return NaN;
  return d instanceof Date ? d.getTime() : Date.parse(d);
}

export default function OverviewPage() {
  const { isConfigured } = useModels();
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [usage, setUsage] = useState<FleetUsage | null>(null);
  const [vms, setVms] = useState<VmRow[] | null>(null);

  const load = useCallback(async () => {
    const [a, r, u, v] = await Promise.all([
      api.listAgents().catch(() => null),
      api.listRuns().catch(() => null),
      api.getFleetUsage(),
      runtimeApi.get<VmRow[] | { items: VmRow[] }>("/v1/runtime/vms?limit=100").then((x) => (Array.isArray(x) ? x : x.items ?? [])).catch(() => null),
    ]);
    setAgents(a);
    setRuns(r);
    setUsage(u);
    setVms(v);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  const stats = useMemo(() => {
    const now = Date.now();
    const day = (runs ?? []).filter((r) => now - ts(r.createdAt) < 24 * HOUR);
    const finished = day.filter((r) => r.status === "succeeded" || r.status === "failed");
    const ok = finished.filter((r) => r.status === "succeeded").length;
    const live = (runs ?? []).filter((r) => r.status === "running" || r.status === "queued").length;
    // 24 hourly buckets, oldest → newest.
    const buckets = Array.from({ length: 24 }, () => ({ ok: 0, fail: 0 }));
    for (const r of day) {
      const idx = 23 - Math.floor((now - ts(r.createdAt)) / HOUR);
      if (idx < 0 || idx > 23) continue;
      if (r.status === "failed") buckets[idx].fail += 1;
      else buckets[idx].ok += 1;
    }
    const failures = (runs ?? [])
      .filter((r) => r.status === "failed")
      .sort((a, b) => ts(b.createdAt) - ts(a.createdAt))
      .slice(0, 5);
    return {
      runs24: day.length,
      successRate: finished.length ? Math.round((ok / finished.length) * 100) : null,
      live,
      buckets,
      failures,
    };
  }, [runs]);

  const runningVms = vms?.filter((v) => v.state === "running").length ?? null;
  const pausedVms = vms?.filter((v) => v.state === "paused").length ?? 0;
  const costToday = usage?.periods.today.costUsd;
  const costWeek = usage?.periods.week.costUsd;
  const noAgents = agents !== null && agents.length === 0;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Overview"
        description="Health, runs, sandboxes and spend across your PAL Runtime workspace."
        secondaryAction={
          <Button variant="ghost" size="md" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void load()}>
            Refresh
          </Button>
        }
        action={
          <LinkButton href="/agents/create" variant="primary" icon={<Plus className="h-3.5 w-3.5" />}>
            New agent
          </LinkButton>
        }
      />
      <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 md:px-8">
        <AskBar
          placeholder="Ask PAL — “create an agent that triages GitHub issues”"
          examples={["Why did my last run fail?", "Pause idle VMs", "Create an agent that triages GitHub issues"]}
        />

        {/* KPI row */}
        <section aria-label="At a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            label="Runs · 24h"
            icon={Activity}
            value={loading ? null : runs === null ? "—" : String(stats.runs24)}
            sub={stats.live ? `${stats.live} live now` : "none live"}
            href="/runs"
          />
          <Kpi
            label="Success rate · 24h"
            icon={Activity}
            value={loading ? null : stats.successRate === null ? "—" : `${stats.successRate}%`}
            sub={stats.failures.length ? `${stats.failures.length} recent failure${stats.failures.length === 1 ? "" : "s"}` : "no recent failures"}
            tone={stats.successRate !== null && stats.successRate < 90 ? "warn" : undefined}
            href="/runs"
          />
          <Kpi
            label="Spend today"
            icon={DollarSign}
            value={loading ? null : costToday === undefined ? "—" : `$${costToday.toFixed(2)}`}
            sub={costWeek === undefined ? "usage unavailable" : `$${costWeek.toFixed(2)} this week`}
            href="/budgets"
          />
          <Kpi
            label="Sandboxes running"
            icon={Server}
            value={loading ? null : runningVms === null ? "—" : String(runningVms)}
            sub={pausedVms ? `${pausedVms} paused` : "microVM runtime"}
            href="/runtime"
          />
        </section>

        {noAgents ? (
          <EmptyState
            icon={Bot}
            title="Build your first agent"
            description="Describe the job in plain words — PAL designs the agent, tests your model key, and runs it once so you can see it work."
            actionLabel="Start guided setup"
            actionHref="/onboarding"
            secondaryActionLabel="Browse templates"
            secondaryActionHref="/marketplace"
            suggestions={[
              { label: "Triage GitHub issues", onClick: () => openAsk({ query: "Create an agent that triages GitHub issues", submit: true }) },
              { label: "Summarize my inbox daily", onClick: () => openAsk({ query: "Create an agent that summarizes my inbox every morning", submit: true }) },
              { label: "Answer support questions", onClick: () => openAsk({ query: "Create an agent that answers support questions from our docs", submit: true }) },
            ]}
          />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0 space-y-6">
              {/* Runs by hour */}
              <section aria-label="Runs in the last 24 hours" className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-xs font-semibold text-zinc-200">Runs, last 24 hours</h2>
                  <span className="flex items-center gap-3 text-[11px] text-zinc-500">
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-pal-400" /> ok</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-red-400" /> failed</span>
                  </span>
                </div>
                {loading ? (
                  <Skeleton className="mt-3 h-24 w-full" />
                ) : (
                  <RunBars buckets={stats.buckets} />
                )}
              </section>

              {/* Recent failures */}
              <section aria-labelledby="failures-h" className="rounded-xl border border-zinc-800 bg-surface-1">
                <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                  <h2 id="failures-h" className="text-xs font-semibold text-zinc-200">Recent failures</h2>
                  <Link href="/runs" className="flex items-center gap-1 text-[12px] font-medium text-pal-400 hover:text-pal-300">
                    All runs <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
                {loading ? (
                  <div className="space-y-2 p-4">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : stats.failures.length === 0 ? (
                  <p className="px-4 py-8 text-center text-xs text-zinc-500">No failed runs. Nice.</p>
                ) : (
                  <ul className="divide-y divide-zinc-800">
                    {stats.failures.map((r) => (
                      <li key={r.id} className="space-y-2 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />
                          <Link href={`/runs/${encodeURIComponent(r.id)}`} className="font-mono text-xs text-zinc-200 hover:text-pal-400">
                            {r.id.slice(0, 8)}
                          </Link>
                          <span className="text-xs text-zinc-400">{r.agentName}</span>
                          <span className="text-[11px] text-zinc-600">
                            {Number.isFinite(ts(r.createdAt)) ? formatDistanceToNow(ts(r.createdAt), { addSuffix: true }) : ""}
                          </span>
                          <span className="ml-auto" />
                          <ExplainInline request={{ kind: "run", runId: r.id }} label="Why?" size="xs" />
                        </div>
                        {r.error?.message && <p className="truncate pl-6 text-[12px] text-zinc-500">{r.error.message}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <aside className="space-y-4">
              <SuggestedSteps
                page="Runtime overview"
                facts={[
                  `${agents?.length ?? "unknown"} agents`,
                  `${stats.runs24} runs in 24h`,
                  `success rate ${stats.successRate ?? "unknown"}%`,
                  `${stats.failures.length} recent failures`,
                  `${runningVms ?? "unknown"} running sandboxes`,
                  isConfigured ? "model provider configured" : "no model provider key",
                ]}
                fallback={[
                  ...(isConfigured ? [] : [{ label: "Add a model provider key", href: "/settings?tab=providers" }]),
                  ...(stats.failures.length ? [{ label: "Review failed runs", href: "/runs" }] : []),
                  { label: "Add an eval suite", href: "/eval-suites" },
                  { label: "Set a budget", href: "/budgets" },
                ].slice(0, 3)}
              />
              <section aria-label="Agents" className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-semibold text-zinc-200">Agents</h2>
                  <Link href="/agents" className="text-[12px] font-medium text-pal-400 hover:text-pal-300">All</Link>
                </div>
                <ul className="mt-2 space-y-1">
                  {(agents ?? []).slice(0, 6).map((a) => (
                    <li key={a.id}>
                      <Link href={`/agents/${encodeURIComponent(a.name)}`} className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs text-zinc-300 hover:bg-surface-3">
                        <span className="truncate">{a.name}</span>
                        <span className={clsx("h-1.5 w-1.5 rounded-full", a.status === "active" ? "bg-emerald-400" : "bg-zinc-600")} />
                      </Link>
                    </li>
                  ))}
                  {loading && <Skeleton className="h-6 w-full" />}
                </ul>
              </section>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({
  label, value, sub, icon: Icon, href, tone,
}: {
  label: string;
  value: string | null;
  sub: string;
  icon: typeof Activity;
  href: string;
  tone?: "warn";
}) {
  return (
    <Link href={href} className="group rounded-xl border border-zinc-800 bg-surface-1 p-4 transition-colors hover:border-zinc-700">
      <div className="flex items-center justify-between text-[12px] text-zinc-500">
        {label}
        <Icon className="h-3.5 w-3.5" />
      </div>
      {value === null ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <p className={clsx("mt-1.5 text-2xl font-semibold tabular-nums", tone === "warn" ? "text-amber-400" : "text-zinc-50")}>{value}</p>
      )}
      <p className="mt-0.5 truncate text-[11px] text-zinc-500">{sub}</p>
    </Link>
  );
}

function RunBars({ buckets }: { buckets: Array<{ ok: number; fail: number }> }) {
  const max = Math.max(1, ...buckets.map((b) => b.ok + b.fail));
  const total = buckets.reduce((n, b) => n + b.ok + b.fail, 0);
  if (total === 0) return <p className="mt-3 py-8 text-center text-xs text-zinc-500">No runs in the last 24 hours.</p>;
  return (
    <div className="mt-3">
      <div className="flex h-24 items-end gap-[3px]" role="img" aria-label={`${total} runs in the last 24 hours`}>
        {buckets.map((b, i) => {
          const h = ((b.ok + b.fail) / max) * 100;
          const failPct = b.ok + b.fail ? (b.fail / (b.ok + b.fail)) * 100 : 0;
          return (
            <div key={i} className="flex h-full flex-1 items-end" title={`${b.ok} ok, ${b.fail} failed`}>
              <div className="flex w-full flex-col-reverse overflow-hidden rounded-[3px]" style={{ height: `${Math.max(h, b.ok + b.fail ? 4 : 0)}%` }}>
                <div className="bg-pal-400" style={{ height: `${100 - failPct}%` }} />
                <div className="bg-red-400" style={{ height: `${failPct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-zinc-600">
        <span>24h ago</span>
        <span>now</span>
      </div>
    </div>
  );
}
