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
  Sparkles,
  Play,
  History,
  Scale,
  Eye,
} from "lucide-react";
import clsx from "clsx";
import {
  api,
  type EvalCase,
  type EvalRun,
  type EvalSuite,
  type EvalSuiteInput,
  type EvalCalibration,
  type GeneratedEvalSuite,
} from "@/lib/api";
import { assertionSummary, getRubric, setRubric, isGrounded } from "@/lib/eval-format";
import { Pill, RunResultView, ScoreTrend, type RunView } from "./eval-views";
import { useToast } from "@/components/toast";
import { Skeleton } from "@/components/skeleton";
import { PageHeader, CountBadge } from "@/components/page-header";
import { Button } from "@/components/button";
import { ConfirmModal, Modal, ModalField } from "@/components/modal";
import { EmptyState } from "@/components/empty-state";
import { EvalIllustration } from "@/components/illustrations";
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
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pinTarget, setPinTarget] = useState<EvalRun | null>(null);
  const [branchInput, setBranchInput] = useState("");

  // Generate-with-agent: `gen` is the server draft (provenance); `draft` is the
  // human-edited copy. Nothing is persisted until "Approve & save".
  const [genOpen, setGenOpen] = useState(false);
  const [genAgent, setGenAgent] = useState("");
  const [genGoal, setGenGoal] = useState("");
  const [generating, setGenerating] = useState(false);
  const [gen, setGen] = useState<GeneratedEvalSuite | null>(null);
  const [draft, setDraft] = useState<EvalSuiteInput | null>(null);
  const [approving, setApproving] = useState(false);

  // Hermetic run
  const [runTarget, setRunTarget] = useState<EvalSuite | null>(null);
  const [runOpts, setRunOpts] = useState({ samples: 0, judgeSamples: 0, branch: "main", setBaseline: false });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ title: string; run: RunView } | null>(null);
  const [loadingRun, setLoadingRun] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  // Judge calibration
  const [calOpen, setCalOpen] = useState(false);
  const [calAgent, setCalAgent] = useState("");
  const [calRubric, setCalRubric] = useState("");
  const [calibrating, setCalibrating] = useState(false);
  const [cal, setCal] = useState<EvalCalibration | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r, as] = await Promise.all([
        api.listEvalSuites(),
        api.listEvalRuns(),
        api.listAgents(),
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
    setDeleting(true);
    try {
      await api.deleteEvalSuite(id);
      toast.success("Suite deleted");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const pinBaseline = (run: EvalRun) => {
    setBranchInput(run.branch || "main");
    setPinTarget(run);
  };

  const confirmPinBaseline = async () => {
    const run = pinTarget;
    const branch = branchInput.trim();
    if (!run || !branch) return;
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
    setPinTarget(null);
  };

  const updateCase = (idx: number, patch: Partial<EvalCase>) => {
    if (!editing) return;
    const next = [...editing.cases];
    next[idx] = { ...next[idx], ...patch };
    setEditing({ ...editing, cases: next });
  };

  const openGenerate = () => {
    setGenAgent(agents[0]?.name ?? "");
    setGenGoal("");
    setGen(null);
    setDraft(null);
    setGenOpen(true);
  };

  const generate = async () => {
    if (!genAgent) return;
    setGenerating(true);
    try {
      const g = await api.generateEvalSuite({ agentName: genAgent, goal: genGoal.trim() || undefined });
      setGen(g);
      setDraft(g.draft);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Generate failed");
    }
    setGenerating(false);
  };

  const approveDraft = async () => {
    if (!draft || !draft.name.trim() || draft.cases.length === 0) return;
    setApproving(true);
    try {
      await api.upsertEvalSuite(draft);
      toast.success(`Suite "${draft.name}" approved and saved`);
      setGenOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
    setApproving(false);
  };

  const patchDraftCase = (idx: number, patch: Partial<EvalCase>) =>
    setDraft((d) => (d ? { ...d, cases: d.cases.map((c, i) => (i === idx ? { ...c, ...patch } : c)) } : d));

  const runSuite = async () => {
    if (!runTarget) return;
    setRunning(true);
    try {
      const r = await api.runEvalSuite(runTarget.id, {
        branch: runOpts.branch.trim() || undefined,
        // 0 = unset: each case's own samples / judge.samples apply.
        samples: runOpts.samples || undefined,
        judgeSamples: runOpts.judgeSamples || undefined,
        setBaseline: runOpts.setBaseline,
      });
      setResult({ title: `${runTarget.name} — hermetic run`, run: r });
      setRunTarget(null);
      if (r.regressed) toast.warning("Regressed vs baseline — CI would fail (422)");
      else toast.success(r.passed ? "All cases passed" : "Run complete — some cases failed");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Run failed");
    }
    setRunning(false);
  };

  const openRun = async (id: string, title: string) => {
    setLoadingRun(id);
    try {
      const d = await api.getEvalRun(id);
      setResult({
        title,
        run: {
          score: d.score,
          passed: d.passed,
          casesTotal: d.casesTotal,
          casesPassed: d.casesPassed,
          caseResults: d.caseResults ?? [],
          regressed: d.regressed,
          baselineScore: d.baselineScore,
          totalCostUsd: d.totalCostUsd,
        },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load run");
    }
    setLoadingRun(null);
  };

  const calibrate = async () => {
    if (!calAgent) return;
    setCalibrating(true);
    setCal(null);
    try {
      setCal(await api.calibrateEvalJudge({ agentName: calAgent, rubric: calRubric.trim() || undefined }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Calibration failed");
    }
    setCalibrating(false);
  };

  const canCreate = agents.length > 0;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Eval Suites"
        description="Declarative test cases with per-branch baselines. CI fails on regression — HTTP 422 from POST /v1/eval-runs."
        badge={suites.length > 0 ? <CountBadge count={suites.length} /> : null}
        secondaryAction={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="md"
              icon={<Scale className="h-3.5 w-3.5" />}
              onClick={() => {
                setCalAgent(agents[0]?.name ?? "");
                setCalRubric("");
                setCal(null);
                setCalOpen(true);
              }}
              disabled={!canCreate}
            >
              Calibrate judge
            </Button>
            <Button
              variant="secondary"
              size="md"
              icon={<Sparkles className="h-3.5 w-3.5" />}
              onClick={openGenerate}
              disabled={!canCreate}
              title={canCreate ? "" : "Create an agent first"}
            >
              Generate with agent
            </Button>
          </div>
        }
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
              illustration={<EvalIllustration size={120} />}
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
                <div key={s.id} className="rounded-xl border border-zinc-800 bg-surface-1 transition-colors hover:border-zinc-700">
                <div className="group flex flex-wrap items-center justify-between gap-2 p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-pal-500/10 text-pal-400">
                      <BookCheck className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold text-zinc-100">
                          {s.name}
                        </p>
                        <span className="font-mono text-[11px] text-zinc-500">
                          {s.agentName}
                        </span>
                      </div>
                      <p className="text-[12px] text-zinc-500">
                        {s.cases.length} case{s.cases.length === 1 ? "" : "s"}
                        {s.description && ` · ${s.description}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Play className="h-3 w-3" />}
                      onClick={() => setRunTarget(s)}
                    >
                      Run (hermetic)
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<History className="h-3 w-3" />}
                      onClick={() => setHistoryFor(historyFor === s.id ? null : s.id)}
                    >
                      History
                    </Button>
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
                      onClick={() => setDeleteTarget({ id: s.id, name: s.name })}
                      className="text-zinc-500 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {historyFor === s.id && (
                  <SuiteHistory
                    runs={runs.filter((r) => r.suiteId === s.id)}
                    loadingId={loadingRun}
                    onOpen={(r) => openRun(r.id, `${s.name} — ${r.branch || "run"}`)}
                  />
                )}
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
                <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-zinc-300">
                  pal test --suite=name
                </code>{" "}
                in CI to record one.
              </p>
            </div>
          ) : (
            <>
              {/* Desktop: table, unchanged */}
              <div className="hidden overflow-hidden rounded-xl border border-zinc-800 bg-surface-1 md:block">
                <table className="w-full text-sm">
                  <thead className="border-b border-zinc-800 bg-surface-0/50">
                    <tr className="text-[11px] uppercase tracking-[0.15em] text-zinc-500">
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
                        className="border-b border-zinc-900 text-[14px] last:border-0 hover:bg-surface-0/50"
                      >
                        <td className="px-4 py-2.5 font-medium text-zinc-200">
                          {r.agentName}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-zinc-400">
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
                              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
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
                        <td className="whitespace-nowrap px-4 py-2.5 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Eye className="h-3 w-3" />}
                            onClick={() => openRun(r.id, `${r.agentName} — ${r.branch || "run"}`)}
                            loading={loadingRun === r.id}
                          >
                            View
                          </Button>
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

              {/* Mobile: stacked cards, same data */}
              <div className="space-y-2 md:hidden">
                {runs.slice(0, 30).map((r) => (
                  <div key={r.id} className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-zinc-200">{r.agentName}</span>
                      <span
                        className={clsx(
                          "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          r.passed
                            ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                            : "border-red-500/20 bg-red-500/10 text-red-400",
                        )}
                      >
                        {r.passed ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                        {r.passed ? "Pass" : "Fail"}
                      </span>
                    </div>
                    <div className="mt-2.5 flex items-center gap-1.5 font-mono text-[12px] text-zinc-400">
                      <GitBranch className="h-3 w-3 text-zinc-600" />
                      {r.branch || "—"}
                      {r.commitSha && <span className="text-zinc-600">@{r.commitSha.slice(0, 7)}</span>}
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2.5">
                      <div>
                        <p className="text-[12px] uppercase tracking-wide text-zinc-500">Score</p>
                        <p className="font-mono text-xs font-semibold tabular-nums text-zinc-100">{r.score.toFixed(3)}</p>
                      </div>
                      <div>
                        <p className="text-[12px] uppercase tracking-wide text-zinc-500">Cases</p>
                        <p className="font-mono text-xs tabular-nums">
                          <span className={r.casesPassed === r.casesTotal ? "text-emerald-400" : "text-amber-400"}>
                            {r.casesPassed}
                          </span>
                          <span className="text-zinc-600">/{r.casesTotal}</span>
                        </p>
                      </div>
                      <div>
                        <p className="text-[12px] uppercase tracking-wide text-zinc-500">Cost</p>
                        <p className="font-mono text-xs tabular-nums text-zinc-200">${r.totalCostUsd.toFixed(4)}</p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Eye className="h-3 w-3" />}
                      onClick={() => openRun(r.id, `${r.agentName} — ${r.branch || "run"}`)}
                      loading={loadingRun === r.id}
                      className="mt-3 w-full justify-center"
                    >
                      View details
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Pin className="h-3 w-3" />}
                      onClick={() => pinBaseline(r)}
                      loading={pinning === r.id}
                      className="mt-1 w-full justify-center"
                    >
                      Pin baseline
                    </Button>
                  </div>
                ))}
              </div>
            </>
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
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
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
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
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
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
              />
            </ModalField>

            <div className="border-t border-zinc-800 pt-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-[12px] font-medium uppercase tracking-[0.15em] text-zinc-500">
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
                  className="text-pal-400 hover:text-pal-300"
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
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-surface-3 font-mono text-[11px] text-zinc-500">
                        {idx + 1}
                      </span>
                      <input
                        type="text"
                        value={c.name}
                        onChange={(e) =>
                          updateCase(idx, { name: e.target.value })
                        }
                        placeholder="case name"
                        className="flex-1 rounded-md border border-zinc-700 bg-surface-2 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus:border-pal-500"
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
                      className="w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-pal-500"
                    />
                    <input
                      type="text"
                      value={c.expected ?? ""}
                      onChange={(e) =>
                        updateCase(idx, { expected: e.target.value })
                      }
                      placeholder="Expected substring (output must contain)"
                      className="w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-pal-500"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Generate with agent — review & approve */}
      <Modal
        open={genOpen}
        onClose={() => setGenOpen(false)}
        title="Generate eval suite with agent"
        description="The agent drafts cases from its own instructions, tools and recent runs. Nothing is saved until you approve."
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setGenOpen(false)}>
              {draft ? "Discard draft" : "Cancel"}
            </Button>
            {draft ? (
              <Button
                variant="primary"
                icon={<Check className="h-3.5 w-3.5" />}
                onClick={approveDraft}
                loading={approving}
                disabled={!draft.name.trim() || draft.cases.length === 0}
              >
                Approve &amp; save
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<Sparkles className="h-3.5 w-3.5" />}
                onClick={generate}
                loading={generating}
                disabled={!genAgent}
              >
                Generate draft
              </Button>
            )}
          </>
        }
      >
        {!draft || !gen ? (
          <div className="space-y-4">
            <ModalField label="Agent">
              <select
                value={genAgent}
                onChange={(e) => setGenAgent(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            </ModalField>
            <ModalField label="Goal" hint="Optional — what should the suite focus on?">
              <input
                type="text"
                value={genGoal}
                onChange={(e) => setGenGoal(e.target.value)}
                placeholder="e.g. refund policy edge cases"
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
              />
            </ModalField>
            <p className="text-xs text-zinc-500">Uses LLM tokens (runs:execute). The draft is returned for review only.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Draft only — nothing is saved until you click Approve &amp; save.</span>
              <span className="font-mono text-zinc-400">
                {gen.model} · ${gen.costUsd.toFixed(4)} · evidence: {gen.evidence.runs} runs, {gen.evidence.feedback} feedback, {gen.evidence.tools} tools
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ModalField label="Suite name">
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
                />
              </ModalField>
              <ModalField label="Description">
                <input
                  type="text"
                  value={draft.description ?? ""}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
                />
              </ModalField>
            </div>
            <h3 className="text-[12px] font-medium uppercase tracking-[0.15em] text-zinc-500">
              Cases ({draft.cases.length})
            </h3>
            <div className="space-y-2">
              {draft.cases.map((c, idx) => {
                const prov = gen.provenance.find((p) => p.case === c.name);
                const chips = assertionSummary(c.assert, c.expected);
                return (
                  <div key={idx} className="space-y-2 rounded-lg border border-zinc-800 bg-surface-0 p-3">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={c.name}
                        onChange={(e) => patchDraftCase(idx, { name: e.target.value })}
                        className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-surface-2 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus:border-pal-500"
                      />
                      <button
                        onClick={() => setDraft({ ...draft, cases: draft.cases.filter((_, i) => i !== idx) })}
                        className="rounded p-1 text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
                        title="Remove case"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {prov && (
                        <Pill tone={isGrounded(prov.grounding) ? "ok" : "muted"}>{prov.grounding}</Pill>
                      )}
                      {(prov?.source || c.source) && (
                        <span className="break-all font-mono text-[11px] text-zinc-500">
                          source: {prov?.source || c.source}
                        </span>
                      )}
                      {chips.map((t, i) => (
                        <Pill key={i} tone="muted">
                          {t}
                        </Pill>
                      ))}
                      {(c.mocks ?? []).map((m, i) => (
                        <Pill key={`m${i}`} tone="warn">
                          mock {m.tool}
                          {m.synthetic ? " (synthetic)" : ""}
                        </Pill>
                      ))}
                    </div>
                    {prov?.notes?.map((n, i) => (
                      <p key={i} className="break-words text-xs text-zinc-500">
                        {n}
                      </p>
                    ))}
                    <textarea
                      value={c.input}
                      onChange={(e) => patchDraftCase(idx, { input: e.target.value })}
                      rows={2}
                      placeholder="Input sent to the agent"
                      className="w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-pal-500"
                    />
                    <textarea
                      value={getRubric(c.assert)}
                      onChange={(e) => patchDraftCase(idx, { assert: setRubric(c.assert, e.target.value) })}
                      rows={2}
                      placeholder="Judge rubric (empty = no LLM judge)"
                      className="w-full rounded-md border border-zinc-700 bg-surface-2 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-pal-500"
                    />
                  </div>
                );
              })}
            </div>
            {gen.dropped.length > 0 && (
              <div className="rounded-lg border border-zinc-800 p-3">
                <p className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">
                  Dropped by grounding ({gen.dropped.length})
                </p>
                <ul className="space-y-1 text-xs text-zinc-400">
                  {gen.dropped.map((d, i) => (
                    <li key={i} className="break-words">
                      <span className="font-mono text-zinc-300">{d.name}</span> — {d.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Hermetic run options */}
      <Modal
        open={runTarget !== null}
        onClose={() => !running && setRunTarget(null)}
        title={`Run "${runTarget?.name ?? ""}" (hermetic)`}
        description="Server-side run with mocked tools — no real connector or tool executes. The result is recorded as an eval run."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRunTarget(null)} disabled={running}>
              Cancel
            </Button>
            <Button variant="primary" icon={<Play className="h-3.5 w-3.5" />} onClick={runSuite} loading={running}>
              Run
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <ModalField label="Agent samples" hint="1–5 per case; blank = suite default">
              <input
                type="number"
                min={1}
                max={5}
                placeholder="suite default"
                value={runOpts.samples || ""}
                onChange={(e) => setRunOpts({ ...runOpts, samples: e.target.value === "" ? 0 : Math.min(5, Math.max(1, Number(e.target.value) || 1)) })}
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
              />
            </ModalField>
            <ModalField label="Judge samples" hint="1–5; blank = suite default">
              <input
                type="number"
                min={1}
                max={5}
                placeholder="suite default"
                value={runOpts.judgeSamples || ""}
                onChange={(e) => setRunOpts({ ...runOpts, judgeSamples: e.target.value === "" ? 0 : Math.min(5, Math.max(1, Number(e.target.value) || 1)) })}
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
              />
            </ModalField>
          </div>
          <ModalField label="Branch" hint="Compared against this branch's baseline">
            <input
              type="text"
              value={runOpts.branch}
              onChange={(e) => setRunOpts({ ...runOpts, branch: e.target.value })}
              placeholder="main"
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
            />
          </ModalField>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={runOpts.setBaseline}
              onChange={(e) => setRunOpts({ ...runOpts, setBaseline: e.target.checked })}
            />
            Set as baseline (only if all cases pass and nothing regressed)
          </label>
          <p className="text-xs text-zinc-500">Spends LLM tokens (agent + judge); capped at a $1 ceiling per run.</p>
        </div>
      </Modal>

      {/* Run result / past run detail */}
      <Modal open={result !== null} onClose={() => setResult(null)} title={result?.title ?? ""} size="xl">
        {result && <RunResultView run={result.run} />}
      </Modal>

      {/* Calibrate judge */}
      <Modal
        open={calOpen}
        onClose={() => setCalOpen(false)}
        title="Calibrate judge"
        description="Re-judges runs that have human feedback and measures how well the judge agrees with your users."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCalOpen(false)}>
              Close
            </Button>
            <Button variant="primary" icon={<Scale className="h-3.5 w-3.5" />} onClick={calibrate} loading={calibrating} disabled={!calAgent}>
              Calibrate
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <ModalField label="Agent">
            <select
              value={calAgent}
              onChange={(e) => setCalAgent(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </ModalField>
          <ModalField label="Rubric" hint="Optional — defaults to a general helpfulness rubric">
            <textarea
              value={calRubric}
              onChange={(e) => setCalRubric(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
            />
          </ModalField>
          {cal && (
            <div className="space-y-3 rounded-xl border border-zinc-800 bg-surface-1 p-4">
              {cal.verdict && <p className="text-sm font-medium text-zinc-100">{cal.verdict}</p>}
              {cal.note && <p className="text-xs text-zinc-500">{cal.note}</p>}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(
                  [
                    ["Agreement", `${(cal.stats.agreement * 100).toFixed(0)}%`],
                    ["Cohen κ", cal.stats.kappa.toFixed(2)],
                    ["MAE", cal.stats.mae.toFixed(2)],
                    ["Labeled / N", `${cal.stats.labeled}/${cal.stats.n}`],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k}>
                    <p className="text-[11px] uppercase tracking-wide text-zinc-500">{k}</p>
                    <p className="font-mono text-sm tabular-nums text-zinc-100">{v}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={deleteTarget !== null}
        title={`Delete suite "${deleteTarget?.name}"?`}
        confirmLabel="Delete"
        tone="danger"
        confirming={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && remove(deleteTarget.id, deleteTarget.name)}
      />

      <Modal
        open={pinTarget !== null}
        onClose={() => setPinTarget(null)}
        title="Pin baseline"
        description="Pin this run as the baseline for which branch?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPinTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={confirmPinBaseline}
              loading={pinTarget != null && pinning === pinTarget.id}
              disabled={!branchInput.trim()}
            >
              Pin
            </Button>
          </>
        }
      >
        <ModalField label="Branch">
          <input
            type="text"
            autoFocus
            value={branchInput}
            onChange={(e) => setBranchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && branchInput.trim()) confirmPinBaseline();
            }}
            placeholder="main"
            className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500"
          />
        </ModalField>
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
            <span className="text-[12px] font-mono text-zinc-600">{count}</span>
          )}
        </div>
        {subtitle && <p className="text-[12px] text-zinc-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function SuiteHistory({
  runs,
  loadingId,
  onOpen,
}: {
  runs: EvalRun[];
  loadingId: string | null;
  onOpen: (r: EvalRun) => void;
}) {
  if (runs.length === 0) {
    return <p className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">No runs for this suite yet.</p>;
  }
  const oldestFirst = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <div className="space-y-2 border-t border-zinc-800 p-4">
      <ScoreTrend values={oldestFirst.map((r) => r.score)} />
      <div className="space-y-1">
        {[...oldestFirst].reverse().slice(0, 10).map((r) => (
          <button
            key={r.id}
            onClick={() => onOpen(r)}
            disabled={loadingId === r.id}
            className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-surface-2"
          >
            <span className="font-mono text-zinc-400">
              {new Date(r.createdAt).toLocaleString()} · {r.branch || "—"}
            </span>
            <span className="flex items-center gap-2 font-mono tabular-nums text-zinc-200">
              {r.score.toFixed(3)}
              <Pill tone={r.passed ? "ok" : "bad"}>{r.passed ? "Pass" : "Fail"}</Pill>
              {r.regressed && <Pill tone="bad">regressed</Pill>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
