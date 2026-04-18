"use client";

import { useState, useEffect, useCallback } from "react";
import {
  BookCheck,
  Plus,
  Save,
  Check,
  AlertTriangle,
  Pin,
  Trash2,
  GitBranch,
  Pencil,
  Terminal,
} from "lucide-react";
import clsx from "clsx";
import {
  api,
  type EvalCase,
  type EvalRun,
  type EvalSuite,
  type EvalSuiteInput,
} from "@/lib/api";
import { useToast } from "@/components/toast";
import { Skeleton } from "@/components/skeleton";
import { PageHeader, CountBadge } from "@/components/page-header";
import { Button } from "@/components/button";
import { Modal, ModalField } from "@/components/modal";
import { EmptyState } from "@/components/empty-state";
import type { Agent } from "@/lib/mock-data";

function emptyDraft(agentName: string): EvalSuiteInput {
  return {
    agentName,
    name: "",
    description: "",
    cases: [{ name: "case-1", input: "", expected: "" }],
  };
}

export default function EvalSuitesPage() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editing, setEditing] = useState<EvalSuiteInput | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pinning, setPinning] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r, as] = await Promise.all([
        api.listEvalSuites().catch(() => [] as EvalSuite[]),
        api.listEvalRuns().catch(() => [] as EvalRun[]),
        api.listAgents().catch(() => [] as Agent[]),
      ]);
      setSuites(s);
      setRuns(r);
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
    if (!editing || !editing.agentName || !editing.name || editing.cases.length === 0) return;
    setSaving(true);
    try {
      await api.upsertEvalSuite(editing);
      toast.success(`Suite "${editing.name}" saved`);
      setEditing(null);
      setEditingId(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
    setSaving(false);
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete suite "${name}"?`)) return;
    try {
      await api.deleteEvalSuite(id);
      toast.success("Suite deleted");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const pinBaseline = async (run: EvalRun) => {
    const branch = prompt(
      `Pin this run as the baseline for which branch?`,
      run.branch || "main",
    );
    if (!branch) return;
    setPinning(run.id);
    try {
      await api.setEvalBaseline({
        agentName: run.agentName,
        branch,
        evalRunId: run.id,
      });
      toast.success(`Baseline set for ${run.agentName}@${branch}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Pin failed");
    }
    setPinning(null);
  };

  const updateCase = (idx: number, patch: Partial<EvalCase>) => {
    if (!editing) return;
    const next = [...editing.cases];
    next[idx] = { ...next[idx], ...patch };
    setEditing({ ...editing, cases: next });
  };

  const canCreate = agents.length > 0;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Eval Suites"
        description="Declarative test cases with per-branch baselines. CI fails on regression — HTTP 422 from POST /v1/eval-runs."
        badge={suites.length > 0 ? <CountBadge count={suites.length} /> : null}
        action={
          <Button
            variant="primary"
            size="md"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => {
              setEditing(emptyDraft(agents[0]?.name ?? ""));
              setEditingId(null);
            }}
            disabled={!canCreate}
            title={canCreate ? "" : "Create an agent first"}
          >
            New suite
          </Button>
        }
      />

      <div className="flex-1 space-y-10 p-8">
        <Section title="Suites" count={suites.length}>
          {loading ? (
            <Skeleton className="h-20 w-full" />
          ) : suites.length === 0 ? (
            <EmptyState
              icon={BookCheck}
              title={canCreate ? "No eval suites yet" : "No agents yet"}
              description={
                canCreate
                  ? "A suite is a list of inputs + expected output substrings. Pin one run as the baseline per branch, and every future run fails CI if it scores lower."
                  : "Create an agent first. Eval suites are defined per-agent."
              }
              actionLabel={canCreate ? "New suite" : "Create agent"}
              onAction={
                canCreate
                  ? () => {
                      setEditing(emptyDraft(agents[0]?.name ?? ""));
                      setEditingId(null);
                    }
                  : undefined
              }
              actionHref={canCreate ? undefined : "/agents/create"}
            />
          ) : (
            <div className="space-y-2">
              {suites.map((s) => (
                <div
                  key={s.id}
                  className="group flex items-center justify-between rounded-xl border border-zinc-800 bg-surface-1 p-4 transition-colors hover:border-zinc-700"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-lantern-500/10 text-lantern-400">
                      <BookCheck className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold text-zinc-100">
                          {s.name}
                        </p>
                        <span className="font-mono text-[10px] text-zinc-500">
                          {s.agentName}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500">
                        {s.cases.length} case{s.cases.length === 1 ? "" : "s"}
                        {s.description && ` · ${s.description}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Pencil className="h-3 w-3" />}
                      onClick={() => {
                        setEditing({
                          agentName: s.agentName,
                          name: s.name,
                          description: s.description,
                          cases: s.cases,
                        });
                        setEditingId(s.id);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(s.id, s.name)}
                      className="text-zinc-500 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Recent eval runs" count={runs.length} subtitle="Pin any run as the per-branch baseline. Future runs are compared against it.">
          {loading ? (
            <Skeleton className="h-16 w-full" />
          ) : runs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-surface-1 p-8 text-center">
              <Terminal className="mx-auto mb-2 h-6 w-6 text-zinc-600" />
              <p className="text-sm text-zinc-400">No runs yet.</p>
              <p className="mt-2 text-xs text-zinc-500">
                Execute{" "}
                <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">
                  lantern test --suite=name
                </code>{" "}
                in CI to record one.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
              <table className="w-full text-sm">
                <thead className="border-b border-zinc-800 bg-surface-0/50">
                  <tr className="text-[10px] uppercase tracking-[0.15em] text-zinc-500">
                    <th className="px-4 py-2.5 text-left font-medium">Agent</th>
                    <th className="px-4 py-2.5 text-left font-medium">Branch</th>
                    <th className="px-4 py-2.5 text-right font-medium">Score</th>
                    <th className="px-4 py-2.5 text-right font-medium">Cases</th>
                    <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                    <th className="px-4 py-2.5 text-left font-medium">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.slice(0, 30).map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-zinc-900 text-[13px] last:border-0 hover:bg-surface-0/50"
                    >
                      <td className="px-4 py-2.5 font-medium text-zinc-200">
                        {r.agentName}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-400">
                          <GitBranch className="h-3 w-3 text-zinc-600" />
                          {r.branch || "—"}
                          {r.commitSha && (
                            <span className="text-zinc-600">
                              @{r.commitSha.slice(0, 7)}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold tabular-nums text-zinc-100">
                        {r.score.toFixed(3)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[12px] text-zinc-400">
                        <span
                          className={clsx(
                            r.casesPassed === r.casesTotal
                              ? "text-emerald-400"
                              : "text-amber-400",
                          )}
                        >
                          {r.casesPassed}
                        </span>
                        <span className="text-zinc-600">/{r.casesTotal}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[12px] text-zinc-400">
                        ${r.totalCostUsd.toFixed(4)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={clsx(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                            r.passed
                              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                              : "border-red-500/20 bg-red-500/10 text-red-400",
                          )}
                        >
                          {r.passed ? (
                            <Check className="h-3 w-3" />
                          ) : (
                            <AlertTriangle className="h-3 w-3" />
                          )}
                          {r.passed ? "Pass" : "Fail"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Pin className="h-3 w-3" />}
                          onClick={() => pinBaseline(r)}
                          loading={pinning === r.id}
                        >
                          Pin baseline
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      <Modal
        open={editing !== null}
        onClose={() => {
          setEditing(null);
          setEditingId(null);
        }}
        title={editingId ? "Edit suite" : "New eval suite"}
        description="Each case runs the agent against its input and scores a pass if the output contains the expected substring."
        size="lg"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(null);
                setEditingId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<Save className="h-3.5 w-3.5" />}
              onClick={save}
              loading={saving}
              disabled={
                !editing?.agentName ||
                !editing?.name ||
                (editing?.cases.length ?? 0) === 0
              }
            >
              Save suite
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <ModalField label="Agent">
                <select
                  value={editing.agentName}
                  onChange={(e) =>
                    setEditing({ ...editing, agentName: e.target.value })
                  }
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500"
                >
                  <option value="">Select...</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </ModalField>
              <ModalField label="Suite name">
                <input
                  type="text"
                  value={editing.name}
                  onChange={(e) =>
                    setEditing({ ...editing, name: e.target.value })
                  }
                  placeholder="e.g. golden-set"
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500"
                />
              </ModalField>
            </div>
            <ModalField label="Description" hint="Optional — what this suite covers">
              <input
                type="text"
                value={editing.description ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, description: e.target.value })
                }
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500"
              />
            </ModalField>

            <div className="border-t border-zinc-800 pt-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-[11px] font-medium uppercase tracking-[0.15em] text-zinc-500">
                  Cases ({editing.cases.length})
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Plus className="h-3 w-3" />}
                  onClick={() =>
                    setEditing({
                      ...editing,
                      cases: [
                        ...editing.cases,
                        {
                          name: `case-${editing.cases.length + 1}`,
                          input: "",
                          expected: "",
                        },
                      ],
                    })
                  }
                  className="text-lantern-400 hover:text-lantern-300"
                >
                  Add case
                </Button>
              </div>
              <div className="space-y-2">
                {editing.cases.map((c, idx) => (
                  <div
                    key={idx}
                    className="space-y-2 rounded-lg border border-zinc-800 bg-surface-0 p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-surface-3 font-mono text-[10px] text-zinc-500">
                        {idx + 1}
                      </span>
                      <input
                        type="text"
                        value={c.name}
                        onChange={(e) =>
                          updateCase(idx, { name: e.target.value })
                        }
                        placeholder="case name"
                        className="flex-1 rounded-md border border-zinc-700 bg-surface-2 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus:border-lantern-500"
                      />
                      <button
                        onClick={() =>
                          setEditing({
                            ...editing,
                            cases: editing.cases.filter(
                              (_, i) => i !== idx,
                            ),
                          })
                        }
                        disabled={editing.cases.length === 1}
                        className="rounded p-1 text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-30"
                        title="Remove case"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <textarea
                      value={c.input}
                      onChange={(e) =>
                        updateCase(idx, { input: e.target.value })
                      }
                      placeholder="Input sent to the agent"
                      rows={2}
                      className="w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-lantern-500"
                    />
                    <input
                      type="text"
                      value={c.expected ?? ""}
                      onChange={(e) =>
                        updateCase(idx, { expected: e.target.value })
                      }
                      placeholder="Expected substring (output must contain)"
                      className="w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-lantern-500"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Section({
  title,
  count,
  subtitle,
  children,
}: {
  title: string;
  count?: number;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-medium text-zinc-200">{title}</h2>
          {count != null && count > 0 && (
            <span className="text-[11px] font-mono text-zinc-600">{count}</span>
          )}
        </div>
        {subtitle && <p className="text-[11px] text-zinc-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}
