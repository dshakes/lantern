"use client";

import { useEffect, useState } from "react";
import { DollarSign, AlertTriangle, Loader2 } from "lucide-react";
import clsx from "clsx";
import { api, type ForecastResult } from "@/lib/api";

interface Props {
  agentName: string;
  input?: string;
  className?: string;
}

/**
 * CostForecastBadge shows the estimated cost + confidence of a run before
 * dispatching it. If a budget is configured and the forecast would exceed it,
 * the badge turns red and surfaces the block reason.
 */
export function CostForecastBadge({ agentName, input = "", className }: Props) {
  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .forecastRun({ agentName, input })
      .then((f) => {
        if (!cancelled) setForecast(f);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Forecast unavailable");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentName, input]);

  if (loading) {
    return (
      <span
        className={clsx(
          "inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-surface-1 px-2.5 py-1 text-[11px] text-zinc-500",
          className,
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin" /> forecasting…
      </span>
    );
  }
  if (error || !forecast) return null;

  const blocked = forecast.wouldExceedBudget;
  const confPct = Math.round(forecast.confidence * 100);
  const estCost = forecast.estimatedCostUsd;
  const budget = forecast.budget;

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-mono",
        blocked
          ? "border-red-500/40 bg-red-500/10 text-red-300"
          : "border-zinc-800 bg-surface-1 text-zinc-300",
        className,
      )}
      title={
        blocked
          ? (forecast.blockReason ?? "would exceed budget")
          : JSON.stringify(forecast.reasoning, null, 2)
      }
    >
      {blocked ? (
        <AlertTriangle className="h-3 w-3" />
      ) : (
        <DollarSign className="h-3 w-3" />
      )}
      <span>~${estCost.toFixed(estCost < 0.01 ? 5 : 4)}</span>
      <span className="text-zinc-500">· {confPct}% conf</span>
      {budget && budget.maxCostUsdPerDay && budget.maxCostUsdPerDay > 0 && (
        <span
          className={clsx(
            "text-zinc-500",
            blocked && "text-red-300",
          )}
        >
          · ${budget.remainingTodayUsd.toFixed(2)} left today
        </span>
      )}
    </span>
  );
}
