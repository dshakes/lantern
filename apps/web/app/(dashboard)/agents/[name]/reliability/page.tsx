"use client";

// Per-agent reliability (ADR 0056): SLO targets with error-budget burn, and
// opt-in sampled production evals with per-version score drift.

import { use, useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { api, type ProdEvals, type SliStatus, type SloConfig } from "@/lib/api";
import { budgetPct, budgetTone, fmtMs, fmtUsd } from "@/lib/observability";
import { Button } from "@/components/button";
import { Skeleton } from "@/components/skeleton";
import { TonePill } from "@/components/tone-pill";
import { useToast } from "@/components/toast";

const inputCls =
  "w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500/50";
const card = "rounded-xl border border-zinc-800/60 bg-surface-1 p-4";

const BAR = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500", muted: "bg-zinc-500" } as const;

export default function AgentReliabilityPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: raw } = use(params);
  const name = decodeURIComponent(raw);
  const toast = useToast();
  const [slis, setSlis] = useState<SliStatus[] | null>(null);
  const [slo, setSlo] = useState<SloConfig>({ objective: 0.95, windowDays: 28 });
  const [configured, setConfigured] = useState(false);
  const [pe, setPe] = useState<ProdEvals | null>(null);
  const [saving, setSaving] = useState<"slo" | "pe" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.getSloStatus(name), api.getProdEvals(name)]);
      setConfigured(s.configured);
      if (s.slo) setSlo(s.slo);
      setSlis(s.slis ?? []);
      setPe(p);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [name]);
  useEffect(() => {
    void load();
  }, [load]);

  const saveSlo = async () => {
    setSaving("slo");
    try {
      await api.putSlo(name, slo);
      toast.success("SLO saved");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(null);
    }
  };
  const savePe = async () => {
    if (!pe) return;
    setSaving("pe");
    try {
      await api.putProdEvals(name, pe.config);
      toast.success("Production evals saved");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(null);
    }
  };
  const num = (v: string): number | undefined => (v.trim() === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

  if (error) return <p role="alert" className="m-8 rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">{error}</p>;
  if (!slis || !pe) return <div className="space-y-3 p-8"><Skeleton className="h-32 w-full" /><Skeleton className="h-32 w-full" /></div>;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-6 md:px-8">
      <section aria-label="Service level objectives" className={card}>
        <h2 className="text-sm font-semibold text-zinc-100">Service level objectives</h2>
        <p className="mb-4 text-xs text-zinc-500">
          Every target is a share of runs that must be good. The gap is the error budget; burn alerts use the same
          multi-window rules as platform SLOs (14.4x over 1h/5m, 6x over 6h/30m, 3x over 1d/2h, 1x over 3d/6h).
        </p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <label className="text-xs text-zinc-500">
            Objective (0-1)
            <input className={inputCls} inputMode="decimal" value={slo.objective} onChange={(e) => setSlo({ ...slo, objective: Number(e.target.value) })} />
          </label>
          <label className="text-xs text-zinc-500">
            p95 latency ms
            <input className={inputCls} inputMode="numeric" value={slo.latencyMs ?? ""} onChange={(e) => setSlo({ ...slo, latencyMs: num(e.target.value) })} />
          </label>
          <label className="text-xs text-zinc-500">
            Cost per run USD
            <input className={inputCls} inputMode="decimal" value={slo.costUsd ?? ""} onChange={(e) => setSlo({ ...slo, costUsd: num(e.target.value) })} />
          </label>
          <label className="text-xs text-zinc-500">
            Min eval score (0-1)
            <input className={inputCls} inputMode="decimal" value={slo.minScore ?? ""} onChange={(e) => setSlo({ ...slo, minScore: num(e.target.value) })} />
          </label>
          <label className="text-xs text-zinc-500">
            Window (days)
            <input className={inputCls} inputMode="numeric" value={slo.windowDays} onChange={(e) => setSlo({ ...slo, windowDays: Number(e.target.value) })} />
          </label>
        </div>
        <div className="mt-3">
          <Button variant="primary" size="sm" loading={saving === "slo"} onClick={saveSlo}>
            {configured ? "Update SLO" : "Enable SLO"}
          </Button>
        </div>

        {configured && (
          <ul className="mt-5 space-y-4">
            {slis.map((s) => {
              const tone = budgetTone(s.budgetRemaining);
              return (
                <li key={s.name}>
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium capitalize text-zinc-200">{s.name}</span>
                    <span className="text-zinc-500">{s.target}</span>
                    {s.alerts.map((a) => (
                      <TonePill key={a.rule} tone={a.severity === "page" ? "bad" : "warn"}>
                        {a.severity}: burning {a.longBurn.toFixed(1)}x ({a.rule})
                      </TonePill>
                    ))}
                  </div>
                  <div
                    className="h-2 overflow-hidden rounded bg-surface-3"
                    role="progressbar"
                    aria-label={`${s.name} error budget remaining`}
                    aria-valuenow={budgetPct(s.budgetRemaining)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div className={clsx("h-2", BAR[tone])} style={{ width: `${budgetPct(s.budgetRemaining)}%` }} />
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    {s.total === 0
                      ? "No runs in the window yet."
                      : `${(s.attainment * 100).toFixed(2)}% good (${s.good}/${s.total}) · budget ${
                          s.budgetRemaining < 0 ? "exhausted" : `${budgetPct(s.budgetRemaining)}% left`
                        }`}
                    {s.measured !== undefined && s.measuredLabel
                      ? ` · ${s.measuredLabel}: ${s.measuredLabel.includes("latency") ? fmtMs(s.measured) : fmtUsd(s.measured)}`
                      : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Production evals" className={card}>
        <h2 className="text-sm font-semibold text-zinc-100">Production evals</h2>
        <p className="mb-4 text-xs text-zinc-500">
          Off by default. When on, a deterministic sample of real succeeded runs is scored by the LLM judge (a different model
          than the one that produced the run). Spend is capped per day and counted against this agent&apos;s budget.
        </p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={pe.config.enabled}
              onChange={(e) => setPe({ ...pe, config: { ...pe.config, enabled: e.target.checked } })}
            />
            Score sampled runs
          </label>
          <label className="text-xs text-zinc-500">
            Sample rate (0-1)
            <input className={inputCls} inputMode="decimal" value={pe.config.sampleRate} onChange={(e) => setPe({ ...pe, config: { ...pe.config, sampleRate: Number(e.target.value) } })} />
          </label>
          <label className="text-xs text-zinc-500">
            Daily budget USD
            <input className={inputCls} inputMode="decimal" value={pe.config.dailyBudgetUsd} onChange={(e) => setPe({ ...pe, config: { ...pe.config, dailyBudgetUsd: Number(e.target.value) } })} />
          </label>
          <p className="self-end text-xs text-zinc-500">Spent today {fmtUsd(pe.spentTodayUsd)}</p>
        </div>
        <label className="mt-3 block text-xs text-zinc-500">
          Rubric (blank uses the default)
          <textarea className={clsx(inputCls, "h-20")} value={pe.config.rubric} onChange={(e) => setPe({ ...pe, config: { ...pe.config, rubric: e.target.value } })} />
        </label>
        <div className="mt-3">
          <Button variant="primary" size="sm" loading={saving === "pe"} onClick={savePe}>
            Save
          </Button>
        </div>

        <h3 className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-zinc-500">Score by version ({pe.scored} scored, 30 days)</h3>
        {pe.versions.length === 0 ? (
          <p className="text-xs text-zinc-500">No scored runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className="py-1 pr-4 font-medium">Version</th>
                  <th className="py-1 pr-4 font-medium">Runs</th>
                  <th className="py-1 pr-4 font-medium">Mean score</th>
                  <th className="py-1 pr-4 font-medium">Pass rate</th>
                  <th className="py-1 font-medium">Change vs previous</th>
                </tr>
              </thead>
              <tbody className="font-mono text-zinc-300">
                {pe.versions.map((v) => (
                  <tr key={v.version}>
                    <td className="py-1 pr-4">{v.version || "unknown"}</td>
                    <td className="py-1 pr-4">{v.n}</td>
                    <td className="py-1 pr-4">{v.meanScore.toFixed(2)}</td>
                    <td className="py-1 pr-4">{(v.passRate * 100).toFixed(0)}%</td>
                    <td className="py-1">
                      {v.deltaVsPrev === undefined ? (
                        "baseline"
                      ) : (
                        <span className={v.drifted ? "text-red-400" : undefined}>
                          {v.deltaVsPrev >= 0 ? "+" : ""}
                          {v.deltaVsPrev.toFixed(2)}
                          {v.drifted ? " drift" : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
