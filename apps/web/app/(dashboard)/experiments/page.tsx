"use client";

import { useState, useEffect, useCallback } from "react";
import {
  FlaskConical,
  Plus,
  Save,
  Trophy,
  TrendingUp,
  TrendingDown,
  Sparkles,
  Minus,
} from "lucide-react";
import clsx from "clsx";
import {
  api,
  type Experiment,
  type ExperimentInput,
} from "@/lib/api";
import { useToast } from "@/components/toast";
import { Skeleton } from "@/components/skeleton";
import { PageHeader, CountBadge } from "@/components/page-header";
import { Button } from "@/components/button";
import { Modal, ModalField } from "@/components/modal";
import { EmptyState } from "@/components/empty-state";
import type { Agent } from "@/lib/mock-data";

function emptyDraft(agentName: string): ExperimentInput {
  return {
    agentName,
    name: "",
    variantAVersion: "current",
    variantBVersion: "",
    trafficSplitB: 10,
    evalSuiteId: "",
    autoPromote: true,
    minRunsToPromote: 50,
  };
}

export default function ExperimentsPage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [creating, setCreating] = useState<ExperimentInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [concluding, setConcluding] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [es, as] = await Promise.all([
        api.listExperiments().catch(() => [] as Experiment[]),
        api.listAgents().catch(() => [] as Agent[]),
      ]);
      setExperiments(es);
      setAgents(as);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load");
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (!creating || !creating.agentName || !creating.name) return;
    setSaving(true);
    try {
      await api.createExperiment(creating);
      toast.success(`Experiment "${creating.name}" started`);
      setCreating(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    }
    setSaving(false);
  };

  const conclude = async (
    exp: Experiment,
    winner: "a" | "b",
    promote: boolean,
  ) => {
    setConcluding(exp.id);
    try {
      await api.concludeExperiment(exp.id, { winner, promote });
      toast.success(promote ? `Winner promoted to current` : `Experiment concluded`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Conclude failed");
    }
    setConcluding(null);
  };

  const canCreate = agents.length > 0;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Experiments"
        description="Deterministic A/B traffic splits with auto-promotion on >2% score lift. Splits are hashed from run_id so the same caller hits the same arm."
        badge={
          experiments.length > 0 ? <CountBadge count={experiments.length} /> : null
        }
        action={
          <Button
            variant="primary"
            size="md"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => setCreating(emptyDraft(agents[0]?.name ?? ""))}
            disabled={!canCreate}
            title={canCreate ? "" : "Create an agent first"}
          >
            New experiment
          </Button>
        }
      />

      <div className="flex-1 p-8">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
        ) : experiments.length === 0 ? (
          <EmptyState
            icon={FlaskConical}
            title={canCreate ? "No experiments yet" : "No agents yet"}
            description={
              canCreate
                ? "Ship a new version safely behind a traffic split. Lantern hashes run_id deterministically, so your retry logic, webhooks, and sessions stay on the same arm."
                : "Create an agent first. Experiments compare two versions of a deployed agent."
            }
            actionLabel={canCreate ? "New experiment" : "Create agent"}
            onAction={
              canCreate
                ? () => setCreating(emptyDraft(agents[0]?.name ?? ""))
                : undefined
            }
            actionHref={canCreate ? undefined : "/agents/create"}
          />
        ) : (
          <div className="space-y-3">
            {experiments.map((exp) => (
              <ExperimentCard
                key={exp.id}
                exp={exp}
                onConclude={conclude}
                concluding={concluding === exp.id}
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={creating !== null}
        onClose={() => setCreating(null)}
        title="New experiment"
        description="A/B experiments need a challenger version. Traffic split is capped at 50% for safety."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<Save className="h-3.5 w-3.5" />}
              onClick={create}
              loading={saving}
              disabled={!creating?.agentName || !creating?.name}
            >
              Start experiment
            </Button>
          </>
        }
      >
        {creating && (
          <div className="space-y-4">
            <ModalField label="Agent">
              <select
                value={creating.agentName}
                onChange={(e) =>
                  setCreating({ ...creating, agentName: e.target.value })
                }
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500"
              >
                <option value="">Select an agent...</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            </ModalField>
            <ModalField label="Experiment name">
              <input
                type="text"
                value={creating.name}
                onChange={(e) =>
                  setCreating({ ...creating, name: e.target.value })
                }
                placeholder="e.g. v2-prompt-tweak"
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500"
              />
            </ModalField>
            <div className="grid grid-cols-2 gap-3">
              <ModalField label="Variant A (control)">
                <input
                  type="text"
                  value={creating.variantAVersion}
                  onChange={(e) =>
                    setCreating({
                      ...creating,
                      variantAVersion: e.target.value,
                    })
                  }
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-lantern-500"
                />
              </ModalField>
              <ModalField label="Variant B (challenger)">
                <input
                  type="text"
                  value={creating.variantBVersion}
                  onChange={(e) =>
                    setCreating({
                      ...creating,
                      variantBVersion: e.target.value,
                    })
                  }
                  placeholder="v0.3.0"
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-lantern-500"
                />
              </ModalField>
            </div>
            <ModalField
              label={`Traffic to B: ${creating.trafficSplitB}%`}
              hint="Conservative starts keep blast radius small. You can bump this up any time."
            >
              <input
                type="range"
                min={1}
                max={50}
                value={creating.trafficSplitB}
                onChange={(e) =>
                  setCreating({
                    ...creating,
                    trafficSplitB: parseInt(e.target.value, 10),
                  })
                }
                className="w-full accent-lantern-500"
              />
              <div className="mt-1 flex justify-between font-mono text-[10px] text-zinc-600">
                <span>1%</span>
                <span>25%</span>
                <span>50%</span>
              </div>
            </ModalField>
            <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-surface-2/50 px-3 py-2.5">
              <label className="flex items-center gap-2.5 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={creating.autoPromote}
                  onChange={(e) =>
                    setCreating({
                      ...creating,
                      autoPromote: e.target.checked,
                    })
                  }
                  className="h-4 w-4 rounded border-zinc-600 bg-surface-3 text-lantern-500"
                />
                <span className="flex items-center gap-1.5">
                  Auto-promote
                  <span className="text-[10px] text-zinc-500">(&gt;2% lift)</span>
                </span>
              </label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">Min runs/arm</span>
                <input
                  type="number"
                  min={5}
                  value={creating.minRunsToPromote}
                  onChange={(e) =>
                    setCreating({
                      ...creating,
                      minRunsToPromote: parseInt(e.target.value, 10) || 50,
                    })
                  }
                  className="w-16 rounded-md border border-zinc-700 bg-surface-2 px-2 py-1 text-xs text-zinc-100 outline-none"
                />
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function ExperimentCard({
  exp,
  onConclude,
  concluding,
}: {
  exp: Experiment;
  onConclude: (exp: Experiment, winner: "a" | "b", promote: boolean) => void;
  concluding: boolean;
}) {
  const aScore = exp.aScore ?? null;
  const bScore = exp.bScore ?? null;
  const lift =
    aScore != null && bScore != null && aScore > 0
      ? ((bScore - aScore) / aScore) * 100
      : null;
  const liftIcon =
    lift == null
      ? Minus
      : lift > 0
        ? TrendingUp
        : lift < 0
          ? TrendingDown
          : Minus;
  const LiftIcon = liftIcon;

  const statusChip = (() => {
    switch (exp.status) {
      case "running":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
      case "promoted":
        return "bg-lantern-500/10 text-lantern-300 border-lantern-500/20";
      case "concluded":
        return "bg-zinc-800 text-zinc-400 border-zinc-700";
      default:
        return "bg-zinc-800 text-zinc-400 border-zinc-700";
    }
  })();

  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 transition-colors hover:border-zinc-700">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-zinc-500" />
            <p className="text-sm font-semibold tracking-tight text-zinc-100">
              {exp.name}
            </p>
          </div>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            <span className="font-mono text-zinc-400">{exp.agentName}</span> ·{" "}
            traffic split{" "}
            <span className="font-mono">
              {100 - exp.trafficSplitB}/{exp.trafficSplitB}
            </span>
          </p>
        </div>
        <span
          className={clsx(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize",
            statusChip,
          )}
        >
          {exp.status === "promoted" && <Sparkles className="h-2.5 w-2.5" />}
          {exp.status}
          {exp.winner && ` · ${exp.winner.toUpperCase()}`}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <VariantCard
          label="Control"
          arm="A"
          version={exp.variantAVersion}
          runs={exp.aRuns}
          score={aScore}
          leading={lift != null && lift < 0}
        />
        <VariantCard
          label="Challenger"
          arm="B"
          version={exp.variantBVersion}
          runs={exp.bRuns}
          score={bScore}
          leading={lift != null && lift > 0}
        />
      </div>
      {lift != null && (
        <div className="mt-3 flex items-center gap-2 text-xs">
          <LiftIcon
            className={clsx(
              "h-3.5 w-3.5",
              lift > 0
                ? "text-emerald-400"
                : lift < 0
                  ? "text-red-400"
                  : "text-zinc-500",
            )}
          />
          <span
            className={clsx(
              "font-mono font-medium",
              lift > 0
                ? "text-emerald-400"
                : lift < 0
                  ? "text-red-400"
                  : "text-zinc-500",
            )}
          >
            {lift > 0 ? "+" : ""}
            {lift.toFixed(1)}% lift
          </span>
          <span className="text-zinc-500">
            · {exp.aRuns + exp.bRuns} runs total
          </span>
          {exp.autoPromote && (
            <span className="ml-auto rounded-full border border-zinc-800 bg-surface-2 px-2 py-0.5 text-[10px] text-zinc-500">
              auto-promote @ {exp.minRunsToPromote} per arm
            </span>
          )}
        </div>
      )}
      {exp.status === "running" && (
        <div className="mt-4 flex items-center justify-end gap-2 border-t border-zinc-800 pt-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onConclude(exp, "a", false)}
            disabled={concluding}
          >
            Keep A
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Trophy className="h-3 w-3" />}
            onClick={() => onConclude(exp, "b", true)}
            loading={concluding}
          >
            Promote B
          </Button>
        </div>
      )}
    </div>
  );
}

function VariantCard({
  label,
  arm,
  version,
  runs,
  score,
  leading,
}: {
  label: string;
  arm: "A" | "B";
  version: string;
  runs: number;
  score: number | null;
  leading: boolean;
}) {
  return (
    <div
      className={clsx(
        "rounded-lg border p-3 transition-colors",
        leading
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-zinc-800 bg-surface-0",
      )}
    >
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-500">
          {label}
        </p>
        <span
          className={clsx(
            "inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold",
            leading
              ? "bg-emerald-500/20 text-emerald-400"
              : "bg-surface-3 text-zinc-500",
          )}
        >
          {arm}
        </span>
      </div>
      <p className="mt-1 truncate font-mono text-xs text-zinc-300">
        {version || "—"}
      </p>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="text-2xl font-semibold tabular-nums text-zinc-100">
          {score != null ? score.toFixed(3) : "—"}
        </span>
        <span className="font-mono text-[10px] text-zinc-500">
          {runs} run{runs !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}
