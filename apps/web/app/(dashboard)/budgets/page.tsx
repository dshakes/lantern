"use client";

import { useState, useEffect, useCallback } from "react";
import {
  DollarSign,
  Plus,
  Shield,
  ShieldAlert,
  Trash2,
  Save,
  Pencil,
  Info,
} from "lucide-react";
import clsx from "clsx";
import { api, type Budget, type BudgetInput } from "@/lib/api";
import { useToast } from "@/components/toast";
import { Skeleton } from "@/components/skeleton";
import { PageHeader, CountBadge } from "@/components/page-header";
import { Button } from "@/components/button";
import { Modal, ModalField } from "@/components/modal";
import { EmptyState } from "@/components/empty-state";
import { BudgetsIllustration } from "@/components/illustrations";
import { AgentAvatar } from "@/components/agent-avatar";
import type { Agent } from "@/lib/mock-data";

interface DraftBudget extends BudgetInput {
  toolLimitsText: string;
}

function emptyDraft(agentName: string): DraftBudget {
  return {
    agentName,
    maxCostUsdPerDay: undefined,
    maxCostUsdPerRun: undefined,
    maxTokensPerDay: undefined,
    maxRunsPerDay: undefined,
    toolLimits: {},
    toolLimitsText: "",
    hardFail: true,
    notifyAtPct: 80,
  };
}

function toDraft(b: Budget): DraftBudget {
  const entries = Object.entries(b.toolLimits ?? {});
  return {
    agentName: b.agentName,
    maxCostUsdPerDay: b.maxCostUsdPerDay,
    maxCostUsdPerRun: b.maxCostUsdPerRun,
    maxTokensPerDay: b.maxTokensPerDay,
    maxRunsPerDay: b.maxRunsPerDay,
    toolLimits: b.toolLimits ?? {},
    toolLimitsText: entries.map(([k, v]) => `${k}=${v}`).join("\n"),
    hardFail: b.hardFail,
    notifyAtPct: b.notifyAtPct,
  };
}

function parseToolLimits(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const [k, v] = t.split("=").map((s) => s.trim());
    const n = parseInt(v, 10);
    if (k && !Number.isNaN(n) && n >= 0) out[k] = n;
  }
  return out;
}

export default function BudgetsPage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editing, setEditing] = useState<DraftBudget | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [bs, as] = await Promise.all([
        api.listBudgets().catch(() => [] as Budget[]),
        api.listAgents().catch(() => [] as Agent[]),
      ]);
      setBudgets(bs);
      setAgents(as);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load");
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!editing || !editing.agentName) return;
    setSaving(true);
    try {
      const body: BudgetInput = {
        agentName: editing.agentName,
        maxCostUsdPerDay: editing.maxCostUsdPerDay,
        maxCostUsdPerRun: editing.maxCostUsdPerRun,
        maxTokensPerDay: editing.maxTokensPerDay,
        maxRunsPerDay: editing.maxRunsPerDay,
        toolLimits: parseToolLimits(editing.toolLimitsText),
        hardFail: editing.hardFail,
        notifyAtPct: editing.notifyAtPct,
      };
      await api.upsertBudget(editing.agentName, body);
      toast.success(`Budget saved for ${editing.agentName}`);
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
    setSaving(false);
  };

  const remove = async (agentName: string) => {
    if (!confirm(`Remove budget for "${agentName}"?`)) return;
    try {
      await api.deleteBudget(agentName);
      toast.success("Budget removed");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const canCreate = agents.length > 0;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Budgets"
        description="Policy-as-code spend limits. Runs that would exceed a hard limit return HTTP 402."
        badge={budgets.length > 0 ? <CountBadge count={budgets.length} /> : null}
        action={
          <Button
            variant="primary"
            size="md"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() =>
              setEditing(emptyDraft(agents[0]?.name ?? ""))
            }
            disabled={!canCreate}
            title={canCreate ? "" : "Create an agent first"}
          >
            New budget
          </Button>
        }
      />

      <div className="flex-1 p-8">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : budgets.length === 0 ? (
          <EmptyState
            illustration={<BudgetsIllustration size={120} />}
            title={canCreate ? "No budgets configured" : "No agents yet"}
            description={
              canCreate
                ? "Cap an agent's daily spend and per-run cost before it surprises you. Hard limits return HTTP 402; soft limits alert at the threshold you set."
                : "Create an agent first, then set a hard-cap on its spend. Budgets apply per-agent."
            }
            actionLabel={canCreate ? "New budget" : "Create agent"}
            onAction={
              canCreate
                ? () => setEditing(emptyDraft(agents[0]?.name ?? ""))
                : undefined
            }
            actionHref={canCreate ? undefined : "/agents/create"}
          />
        ) : (
          <div className="space-y-3">
            {budgets.map((b) => (
              <BudgetRow
                key={b.agentName}
                budget={b}
                onEdit={() => setEditing(toDraft(b))}
                onDelete={() => remove(b.agentName)}
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={
          editing && budgets.some((b) => b.agentName === editing.agentName)
            ? "Edit budget"
            : "New budget"
        }
        description="Limits apply per calendar day (UTC). Leave a field blank to not cap it."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<Save className="h-3.5 w-3.5" />}
              onClick={save}
              loading={saving}
              disabled={!editing?.agentName}
            >
              Save budget
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            <ModalField label="Agent">
              <select
                value={editing.agentName}
                onChange={(e) =>
                  setEditing({ ...editing, agentName: e.target.value })
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
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label="Max $ / day"
                value={editing.maxCostUsdPerDay}
                onChange={(v) =>
                  setEditing({ ...editing, maxCostUsdPerDay: v })
                }
                step="0.01"
              />
              <NumberField
                label="Max $ / run"
                value={editing.maxCostUsdPerRun}
                onChange={(v) =>
                  setEditing({ ...editing, maxCostUsdPerRun: v })
                }
                step="0.0001"
              />
              <NumberField
                label="Max runs / day"
                value={editing.maxRunsPerDay}
                onChange={(v) =>
                  setEditing({ ...editing, maxRunsPerDay: v })
                }
              />
              <NumberField
                label="Max tokens / day"
                value={editing.maxTokensPerDay}
                onChange={(v) =>
                  setEditing({ ...editing, maxTokensPerDay: v })
                }
              />
            </div>
            <ModalField
              label="Tool rate limits"
              hint="One per line: tool.name=max_calls_per_day"
            >
              <textarea
                value={editing.toolLimitsText}
                onChange={(e) =>
                  setEditing({ ...editing, toolLimitsText: e.target.value })
                }
                rows={3}
                placeholder={"slack.post=100\ngithub.create_issue=25"}
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-lantern-500"
              />
            </ModalField>
            <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-surface-2/50 px-3 py-2.5">
              <label className="flex items-center gap-2.5 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={editing.hardFail}
                  onChange={(e) =>
                    setEditing({ ...editing, hardFail: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-zinc-600 bg-surface-3 text-lantern-500"
                />
                <span className="flex items-center gap-1.5">
                  Hard-fail
                  <span className="text-[10px] text-zinc-500">
                    (HTTP 402, block the run)
                  </span>
                </span>
              </label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">Alert at</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={editing.notifyAtPct}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      notifyAtPct: parseInt(e.target.value, 10) || 80,
                    })
                  }
                  className="w-16 rounded-md border border-zinc-700 bg-surface-2 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-lantern-500"
                />
                <span className="text-xs text-zinc-500">%</span>
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-surface-2/30 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
              <Info className="mt-0.5 h-3 w-3 shrink-0 text-zinc-600" />
              <span>
                Forecast the cost of a run with{" "}
                <code className="rounded bg-surface-3 px-1 py-0.5 text-[10px] text-zinc-300">
                  POST /v1/runs/forecast
                </code>{" "}
                — it returns{" "}
                <code className="rounded bg-surface-3 px-1 py-0.5 text-[10px] text-zinc-300">
                  wouldExceedBudget
                </code>{" "}
                so you can reject before dispatch.
              </span>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function BudgetRow({
  budget,
  onEdit,
  onDelete,
}: {
  budget: Budget;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group rounded-xl border border-zinc-800 bg-surface-1 p-5 transition-all duration-150 hover:border-zinc-700 hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <AgentAvatar name={budget.agentName} size="md" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-xs font-semibold text-zinc-100">
                {budget.agentName}
              </p>
              <span
                className={clsx(
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium",
                  budget.hardFail
                    ? "bg-red-500/10 text-red-300"
                    : "bg-amber-500/10 text-amber-300",
                )}
              >
                {budget.hardFail ? (
                  <ShieldAlert className="h-3 w-3" />
                ) : (
                  <Shield className="h-3 w-3" />
                )}
                {budget.hardFail ? "hard" : "soft"}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-zinc-400">
              {budget.maxCostUsdPerDay != null && (
                <span className="inline-flex items-center gap-1">
                  <DollarSign className="h-3 w-3 text-zinc-600" />
                  {budget.maxCostUsdPerDay.toFixed(2)}
                  <span className="text-zinc-600">/day</span>
                </span>
              )}
              {budget.maxCostUsdPerRun != null && (
                <span className="inline-flex items-center gap-1">
                  <DollarSign className="h-3 w-3 text-zinc-600" />
                  {budget.maxCostUsdPerRun.toFixed(4)}
                  <span className="text-zinc-600">/run</span>
                </span>
              )}
              {budget.maxRunsPerDay != null && (
                <span>
                  {budget.maxRunsPerDay}
                  <span className="text-zinc-600"> runs/day</span>
                </span>
              )}
              {budget.maxTokensPerDay != null && (
                <span>
                  {budget.maxTokensPerDay.toLocaleString()}
                  <span className="text-zinc-600"> tok/day</span>
                </span>
              )}
              <span className="text-zinc-600">alert @ {budget.notifyAtPct}%</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            icon={<Pencil className="h-3 w-3" />}
            onClick={onEdit}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            title="Delete"
            className="text-zinc-500 hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step = "1",
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: string;
}) {
  return (
    <ModalField label={label}>
      <input
        type="number"
        step={step}
        value={value ?? ""}
        onChange={(e) => {
          const s = e.target.value;
          onChange(s === "" ? undefined : parseFloat(s));
        }}
        placeholder="unset"
        className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500"
      />
    </ModalField>
  );
}
