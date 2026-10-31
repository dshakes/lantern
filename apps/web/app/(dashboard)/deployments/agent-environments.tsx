"use client";

// Agent environments — lifecycle promotion (ADR 0054): sandbox -> staging -> prod.
// All data comes from /v1/agents, /v1/agents/{name}/environments, /v1/promotions*.

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, GitBranch, Rocket, RotateCcw, Activity } from "lucide-react";
import { api } from "@/lib/api";
import { runtimeApi } from "@/lib/runtime-api";
import { useToast } from "@/components/toast";
import { Button } from "@/components/button";
import { Modal, ModalField } from "@/components/modal";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import {
  PROMO_ENVS,
  canRollback,
  envBadgeLabel,
  errorRate,
  fmtCost,
  fmtPct,
  gateTone,
  parseApiError,
  proposedBy,
  validatePromote,
  type AgentEnvironments,
  type AuditEntry,
  type CanaryEvaluation,
  type EnvState,
  type Gate,
  type Promotion,
  type PromoEnv,
  summarizeDetail,
} from "@/lib/promotion";

const INPUT =
  "w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-pal-500 focus:ring-1 focus:ring-pal-500/30";

const TONE = {
  ok: "bg-emerald-500/10 text-emerald-400",
  warn: "bg-amber-500/10 text-amber-400",
  danger: "bg-red-500/10 text-red-400",
  neutral: "bg-surface-3 text-zinc-300",
} as const;

function Pill({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", TONE[tone])}>
      {children}
    </span>
  );
}

const KindPill = ({ kind }: { kind: string }) => (
  <Pill tone={kind === "agent" ? "warn" : "neutral"}>{kind}</Pill>
);

const ago = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

function GateList({ gates }: { gates?: Gate[] | null }) {
  if (!gates || gates.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {gates.map((g) => (
        <li key={g.name} className="flex flex-wrap items-start gap-2 text-[12px]">
          <Pill tone={gateTone(g.status)}>{g.status}</Pill>
          <span className="font-medium text-zinc-200">{g.name}</span>
          {g.detail && <span className="min-w-0 break-words text-zinc-500">{g.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h3 className="mb-3 flex items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-zinc-400">
      {icon} {children}
    </h3>
  );
}

export function AgentEnvironments() {
  const toast = useToast();
  const [agents, setAgents] = useState<string[] | null>(null);
  const [agent, setAgent] = useState("");
  const [envs, setEnvs] = useState<AgentEnvironments | null>(null);
  const [pending, setPending] = useState<Promotion[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [evalRes, setEvalRes] = useState<CanaryEvaluation | null>(null);
  const [evaluating, setEvaluating] = useState(false);

  const [rollback, setRollback] = useState<EnvState | null>(null);
  const [decision, setDecision] = useState<{ p: Promotion; kind: "approve" | "reject" } | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ env: "staging" as PromoEnv, version: "", canaryPct: "", reason: "" });
  const [gateFail, setGateFail] = useState<Gate[] | null>(null);

  const load = useCallback(async (name: string) => {
    setLoading(true);
    setError(null);
    try {
      const enc = encodeURIComponent(name);
      const [e, p, a] = await Promise.all([
        runtimeApi.get<AgentEnvironments>(`/v1/agents/${enc}/environments`),
        runtimeApi.get<Promotion[]>("/v1/promotions?status=pending_approval"),
        runtimeApi.get<AuditEntry[]>(`/v1/promotions/audit?agentName=${enc}&limit=20`),
      ]);
      setEnvs(e);
      setPending(p ?? []);
      setAudit(a ?? []);
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api
      .listAgents()
      .then((list) => {
        const names = list.map((x) => x.name);
        setAgents(names);
        if (names.length > 0) setAgent(names[0]);
        else setLoading(false);
      })
      .catch((err) => {
        setAgents([]);
        setError(parseApiError(err).message);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (agent) {
      setEvalRes(null);
      void load(agent);
    }
  }, [agent, load]);

  const run = async (fn: () => Promise<void>, ok: string, close: () => void) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      close();
      await load(agent);
    } catch (err) {
      const f = parseApiError(err);
      if (f.code === "gate_failed" && f.gates) setGateFail(f.gates);
      else if (f.code === "human_approval_required" || f.status === 403) toast.error(f.message);
      else toast.error(f.message || "Request failed");
      if (f.code === "gate_failed" && f.gates) toast.error("Promotion gates failed");
    } finally {
      setBusy(false);
    }
  };

  const doEvaluate = async () => {
    setEvaluating(true);
    try {
      const r = await runtimeApi.post<CanaryEvaluation>(
        `/v1/agents/${encodeURIComponent(agent)}/environments/prod/canary/evaluate`,
      );
      setEvalRes(r);
      if (r.action !== "none") await load(agent);
    } catch (err) {
      toast.error(parseApiError(err).message);
    } finally {
      setEvaluating(false);
    }
  };

  const closeDecision = () => { setDecision(null); setNote(""); setGateFail(null); };
  const prodCanary = envs?.environments.find((e) => e.env === "prod" && e.status === "canary");
  const pctErr = validatePromote(form);

  if (agents === null) return <Skeleton className="h-40 w-full" />;

  return (
    <section className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-zinc-400">
          <GitBranch className="h-3.5 w-3.5 text-zinc-500" /> Agent environments
        </h2>
        {agents.length > 0 && (
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <select
              aria-label="Agent"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className={clsx(INPUT, "min-w-0 sm:w-56")}
            >
              {agents.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <Button
              variant="primary"
              size="md"
              icon={<Rocket className="h-3.5 w-3.5" />}
              onClick={() => { setGateFail(null); setPromoteOpen(true); }}
            >
              Promote
            </Button>
          </div>
        )}
      </div>

      {agents.length === 0 && !error ? (
        <EmptyState
          icon={GitBranch}
          size="compact"
          title="No agents yet"
          description="Create an agent to promote it through sandbox, staging and prod."
          actionLabel="Create agent"
          actionHref="/agents"
        />
      ) : error ? (
        <EmptyState
          icon={AlertTriangle}
          size="compact"
          title="Couldn't load agent environments"
          description={error}
          actionLabel="Retry"
          onAction={() => (agent ? void load(agent) : window.location.reload())}
        />
      ) : loading || !envs ? (
        <div className="grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {PROMO_ENVS.map((name) => {
              const e = envs.environments.find((x) => x.env === name);
              return (
                <div key={name} className="min-w-0 rounded-xl bg-surface-1 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold capitalize text-zinc-50">{name}</span>
                    {e && <Pill tone={e.status === "canary" ? "warn" : "ok"}>{envBadgeLabel(e)}</Pill>}
                  </div>
                  {e ? (
                    <>
                      <p className="mt-2 break-all font-mono text-sm text-zinc-100">{e.version}</p>
                      <p className="mt-1 break-words text-[12px] text-zinc-500">
                        {e.updatedBy ?? "—"} · {ago(e.updatedAt)}
                      </p>
                      {e.previousVersion && (
                        <p className="mt-1 break-all text-[12px] text-zinc-500">previous: {e.previousVersion}</p>
                      )}
                      <Button
                        className="mt-3"
                        variant="danger"
                        size="sm"
                        icon={<RotateCcw className="h-3 w-3" />}
                        disabled={!canRollback(e)}
                        onClick={() => { setNote(""); setRollback(e); }}
                      >
                        Rollback
                      </Button>
                    </>
                  ) : (
                    <p className="mt-2 text-[12px] text-zinc-500">Nothing deployed.</p>
                  )}
                </div>
              );
            })}
          </div>

          {prodCanary && (
            <div className="rounded-xl bg-surface-1 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SectionTitle icon={<Activity className="h-3.5 w-3.5 text-zinc-500" />}>
                  Prod canary — {envs?.promotions.find((p: Promotion) => p.id === prodCanary.promotionId)?.version ?? "candidate"} at {prodCanary.canaryPct ?? 0}% (stable {prodCanary.version})
                </SectionTitle>
                <Button variant="secondary" size="sm" loading={evaluating} onClick={doEvaluate}>
                  Evaluate now
                </Button>
              </div>
              {evalRes ? (
                <div className="space-y-3 text-[12px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={evalRes.verdict.verdict === "pass" ? "ok" : evalRes.verdict.verdict === "trip" ? "danger" : "warn"}>
                      {evalRes.verdict.verdict}
                    </Pill>
                    {evalRes.action !== "none" && <span className="text-zinc-300">action: {evalRes.action}</span>}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {([["Candidate", evalRes.candidate], ["Stable", evalRes.stable]] as const).map(([label, s]) => (
                      <div key={label} className="rounded-lg bg-surface-2 p-3">
                        <p className="mb-1 font-medium text-zinc-200">{label}</p>
                        <p className="text-zinc-400">runs: {s.Terminal}</p>
                        <p className="text-zinc-400">error rate: {fmtPct(errorRate(s))}</p>
                        <p className="text-zinc-400">avg cost: {fmtCost(s.AvgCost)}</p>
                      </div>
                    ))}
                  </div>
                  {(evalRes.verdict.reasons ?? []).length > 0 && (
                    <ul className="list-disc space-y-0.5 pl-4 text-zinc-400">
                      {(evalRes.verdict.reasons ?? []).map((r) => <li key={r} className="break-words">{r}</li>)}
                    </ul>
                  )}
                  <p className="text-zinc-500">
                    Guards: max error {fmtPct(evalRes.guards.maxErrorRate)} · max cost ratio {evalRes.guards.maxCostRatio}x · min runs {evalRes.guards.minRuns}
                  </p>
                </div>
              ) : (
                <p className="text-[12px] text-zinc-500">Run an evaluation to compare the candidate against stable.</p>
              )}
            </div>
          )}

          <div>
            <SectionTitle icon={<AlertTriangle className="h-3.5 w-3.5 text-zinc-500" />}>
              Pending approvals ({pending.length})
            </SectionTitle>
            {pending.length === 0 ? (
              <EmptyState size="compact" title="Nothing awaiting approval" description="Promotions that need a human sign-off appear here." />
            ) : (
              <div className="space-y-2.5">
                {pending.map((p) => (
                  <div key={p.id} className="min-w-0 rounded-xl bg-surface-1 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all text-sm font-semibold text-zinc-50">{p.agentName}</span>
                      <span className="text-[12px] text-zinc-400">
                        {p.fromVersion ? `${p.fromVersion} → ` : ""}{p.version} → {p.env}
                        {p.canaryPct ? ` (${p.canaryPct}% canary)` : ""}
                      </span>
                      <KindPill kind={p.requestedByKind} />
                    </div>
                    <p className="mt-1 text-[12px] text-zinc-500">{proposedBy(p)} · {ago(p.createdAt)}</p>
                    {p.note && <p className="mt-1 break-words text-[12px] text-zinc-400">{p.note}</p>}
                    <GateList gates={p.gates} />
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => { setGateFail(null); setNote(""); setDecision({ p, kind: "approve" }); }}>Approve</Button>
                      <Button size="sm" variant="secondary" onClick={() => { setGateFail(null); setNote(""); setDecision({ p, kind: "reject" }); }}>Reject</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <SectionTitle icon={<Activity className="h-3.5 w-3.5 text-zinc-500" />}>Audit trail</SectionTitle>
            {audit.length === 0 ? (
              <EmptyState size="compact" title="No promotion activity" description="Promotions, approvals and rollbacks for this agent are logged here." />
            ) : (
              <ul className="divide-y divide-zinc-800 rounded-xl bg-surface-1">
                {audit.map((a) => (
                  <li key={a.id} className="min-w-0 px-4 py-3 text-[12px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-zinc-100">{a.action}</span>
                      {a.env && <Pill tone="neutral">{a.env}</Pill>}
                      <span className="break-all text-zinc-400">{a.actor}</span>
                      <KindPill kind={a.actorKind} />
                      <span className="text-zinc-500 sm:ml-auto">{ago(a.createdAt)}</span>
                    </div>
                    {summarizeDetail(a.detail) && <p className="mt-1 break-words text-zinc-500">{summarizeDetail(a.detail)}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Rollback confirm */}
      <Modal
        open={!!rollback}
        onClose={() => setRollback(null)}
        title={`Roll back ${rollback?.env ?? ""}`}
        description={rollback ? `${agent}: ${rollback.version} → ${rollback.previousVersion ?? "stable"}` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRollback(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => rollback && run(
                () => runtimeApi.post(`/v1/agents/${encodeURIComponent(agent)}/environments/${rollback.env}/rollback`, { note }).then(() => undefined),
                "Rolled back",
                () => setRollback(null),
              )}
            >
              Roll back
            </Button>
          </>
        }
      >
        <ModalField label="Note (optional)">
          <input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why?" />
        </ModalField>
      </Modal>

      {/* Approve / reject */}
      <Modal
        open={!!decision}
        onClose={closeDecision}
        title={decision?.kind === "approve" ? "Approve promotion" : "Reject promotion"}
        description={decision ? `${decision.p.agentName} ${decision.p.version} → ${decision.p.env}` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={closeDecision}>Cancel</Button>
            <Button
              variant={decision?.kind === "approve" ? "primary" : "danger"}
              loading={busy}
              onClick={() => decision && run(
                () => runtimeApi.post(`/v1/promotions/${encodeURIComponent(decision.p.id)}/${decision.kind}`, { note }).then(() => undefined),
                decision.kind === "approve" ? "Promotion approved" : "Promotion rejected",
                closeDecision,
              )}
            >
              {decision?.kind === "approve" ? "Approve" : "Reject"}
            </Button>
          </>
        }
      >
        {decision?.kind === "approve" && (decision.p.canaryPct ?? 0) > 0 && (
          <p className="mb-3 break-words text-xs text-zinc-400">
            Canary {decision.p.canaryPct}% with guards: {summarizeDetail(decision.p.guards)}
          </p>
        )}
        <ModalField label="Note (optional)">
          <input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} />
        </ModalField>
        {gateFail && <GateList gates={gateFail} />}
      </Modal>

      {/* Promote */}
      <Modal
        open={promoteOpen}
        onClose={() => setPromoteOpen(false)}
        title="Promote"
        description={agent}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPromoteOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!!pctErr}
              onClick={() => run(
                async () => {
                  const body: Record<string, unknown> = { env: form.env };
                  if (form.version.trim()) body.version = form.version.trim();
                  if (form.env === "prod" && form.canaryPct.trim()) body.canaryPct = Number(form.canaryPct);
                  if (form.reason.trim()) body.reason = form.reason.trim();
                  await runtimeApi.post(`/v1/agents/${encodeURIComponent(agent)}/promote`, body);
                },
                "Promotion requested",
                () => setPromoteOpen(false),
              )}
            >
              Promote
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <ModalField label="Environment">
            <select className={INPUT} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value as PromoEnv })}>
              {PROMO_ENVS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </ModalField>
          <ModalField label="Version" hint="Leave blank to promote the version from the previous environment.">
            <input className={INPUT} value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
          </ModalField>
          {form.env === "prod" && (
            <ModalField label="Canary %" hint={pctErr ?? "Optional, 1–99. Blank = full rollout."}>
              <input className={INPUT} inputMode="numeric" value={form.canaryPct} onChange={(e) => setForm({ ...form, canaryPct: e.target.value })} />
            </ModalField>
          )}
          <ModalField label="Reason (optional)">
            <input className={INPUT} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </ModalField>
          {gateFail && (
            <div>
              <p className="text-[12px] font-medium text-red-400">Gates failed</p>
              <GateList gates={gateFail} />
            </div>
          )}
        </div>
      </Modal>
    </section>
  );
}
