"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Undo2 } from "lucide-react";
import { api, type Incident } from "@/lib/api";
import { incidentActions, incidentTone, kindLabel } from "@/lib/observability";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/button";
import { Skeleton } from "@/components/skeleton";
import { TonePill } from "@/components/tone-pill";
import { useToast } from "@/components/toast";

export default function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const toast = useToast();
  const [inc, setInc] = useState<Incident | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInc(await api.getIncident(id));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load incident");
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const rollback = async () => {
    if (!inc || !window.confirm(`Roll prod back from ${inc.rollback.fromVersion} to ${inc.rollback.toVersion}?`)) return;
    setBusy("rollback");
    try {
      const r = await api.rollbackIncident(id);
      setInc(r.incident);
      toast.success(`Prod now serves ${r.rollback.version}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rollback failed");
      void load();
    } finally {
      setBusy(null);
    }
  };

  const act = async (action: "acknowledge" | "resolve") => {
    setBusy(action);
    try {
      setInc(await api.transitionIncident(id, action, note.trim() || undefined));
      setNote("");
      toast.success(action === "acknowledge" ? "Incident acknowledged" : "Incident resolved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
      void load();
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm font-medium text-zinc-300">Incident not found</p>
        <p className="max-w-sm text-xs text-zinc-500">{error}</p>
        <Link href="/incidents" className="text-sm text-pal-400 hover:text-pal-300">
          Back to incidents
        </Link>
      </div>
    );
  }
  if (!inc) {
    return (
      <div className="space-y-3 p-8">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  const actions = incidentActions(inc.status);
  const findings = Array.isArray((inc.evidence as { findings?: unknown[] }).findings)
    ? ((inc.evidence as { findings: { metric: string; version: string; baseline: number; observed: number; z: number; n: number }[] }).findings)
    : [];

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title={inc.title}
        description={`${kindLabel(inc.kind)} on ${inc.agentName}`}
        badge={<TonePill tone={incidentTone(inc)}>{inc.status === "resolved" ? "resolved" : `${inc.severity} · ${inc.status}`}</TonePill>}
      />
      <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-6 md:px-8">
        <Link href="/incidents" className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300">
          <ArrowLeft className="h-3 w-3" /> All incidents
        </Link>

        {inc.rollback.suggested && inc.status !== "resolved" && (
          <div role="note" className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <Undo2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="text-sm">
              <p className="font-medium text-amber-300">
                Rollback suggested: <span className="font-mono">{inc.rollback.fromVersion}</span> to{" "}
                <span className="font-mono">{inc.rollback.toVersion}</span>
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                The previous version was healthy before this shift. The rollback runs through promotions and is audited in both places.
              </p>
              <Button variant="danger" size="sm" className="mt-3" loading={busy === "rollback"} onClick={rollback}>
                Roll back prod to {inc.rollback.toVersion}
              </Button>
            </div>
          </div>
        )}

        <section aria-label="Summary" className="rounded-xl border border-zinc-800/60 bg-surface-1 p-4">
          <div className="mb-1 flex items-center gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Summary</h2>
            <TonePill tone="muted">{inc.summarySource === "model" ? "model-written, grounded in linked runs" : "deterministic"}</TonePill>
          </div>
          <p className="text-sm text-zinc-200">{inc.summary}</p>
          <dl className="mt-4 grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-zinc-500">First bad version</dt>
              <dd className="font-mono text-zinc-200">{inc.firstBadVersion || "n/a"}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Last good version</dt>
              <dd className="font-mono text-zinc-200">{inc.lastGoodVersion || "n/a"}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Opened</dt>
              <dd className="text-zinc-200">{new Date(inc.openedAt).toLocaleString()}</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-zinc-500">Suspected cause</p>
          <p className="text-sm text-zinc-300">{inc.suspectedCause}</p>
        </section>

        {findings.length > 0 && (
          <section aria-label="Evidence" className="rounded-xl border border-zinc-800/60 bg-surface-1 p-4">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Evidence</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="py-1 pr-4 font-medium">Metric</th>
                    <th className="py-1 pr-4 font-medium">Version</th>
                    <th className="py-1 pr-4 font-medium">Baseline</th>
                    <th className="py-1 pr-4 font-medium">Observed</th>
                    <th className="py-1 pr-4 font-medium">z</th>
                    <th className="py-1 font-medium">Runs</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-zinc-300">
                  {findings.map((f) => (
                    <tr key={f.metric + f.version}>
                      <td className="py-1 pr-4">{f.metric}</td>
                      <td className="py-1 pr-4">{f.version}</td>
                      <td className="py-1 pr-4">{+f.baseline.toPrecision(3)}</td>
                      <td className="py-1 pr-4">{+f.observed.toPrecision(3)}</td>
                      <td className="py-1 pr-4">{f.z.toFixed(1)}</td>
                      <td className="py-1">{f.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section aria-label="Affected runs" className="rounded-xl border border-zinc-800/60 bg-surface-1 p-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Affected runs ({inc.affectedRunIds.length})
          </h2>
          <ul className="flex flex-wrap gap-2">
            {inc.affectedRunIds.slice(0, 40).map((r) => (
              <li key={r}>
                <Link href={`/runs/${r}`} className="rounded bg-surface-2 px-2 py-1 font-mono text-[11px] text-pal-400 hover:bg-surface-3">
                  {r.slice(0, 8)}
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Timeline" className="rounded-xl border border-zinc-800/60 bg-surface-1 p-4">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Timeline (audit trail)</h2>
          <ol className="space-y-3 border-l border-zinc-800 pl-4">
            {(inc.timeline ?? []).map((t, i) => (
              <li key={i} className="text-xs">
                <span className="font-medium capitalize text-zinc-200">{t.action}</span>{" "}
                <span className="text-zinc-500">
                  by {t.actor} · {new Date(t.at).toLocaleString()}
                </span>
                {t.detail && <p className="mt-0.5 text-zinc-400">{t.detail}</p>}
              </li>
            ))}
          </ol>
        </section>

        {actions.length > 0 && (
          <section aria-label="Actions" className="rounded-xl border border-zinc-800/60 bg-surface-1 p-4">
            <label htmlFor="note" className="mb-1 block text-xs text-zinc-500">
              Note (optional, saved to the timeline)
            </label>
            <input
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              className="mb-3 w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500/50"
            />
            <div className="flex flex-wrap gap-2">
              {actions.includes("acknowledge") && (
                <Button variant="secondary" loading={busy === "acknowledge"} onClick={() => act("acknowledge")}>
                  Acknowledge
                </Button>
              )}
              <Button variant="primary" loading={busy === "resolve"} onClick={() => act("resolve")}>
                Resolve
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
