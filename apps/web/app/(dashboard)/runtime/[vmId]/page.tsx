"use client";

// Per-VM debug view — log tail, spec, audit events, terminate.

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Shield,
  Cpu,
  Activity,
  StopCircle,
  Pause,
  Play,
  GitFork,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { Button } from "@/components/button";
import Link from "next/link";
import { ConfirmModal, Modal, ModalField } from "@/components/modal";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";
import { HttpError, runtimeApi, UnauthorizedError } from "@/lib/runtime-api";

// Response shapes mirror POST /v1/runtime/vms/{id}/{pause,resume,fork}.
interface ForkResult {
  sourceVmId: string;
  snapshotId: string;
  forks: Array<{ vmId: string; state: string; error?: string }>;
}

/** Friendly copy for the contract's 402 (quota) / 409 (wrong state). */
function lifecycleError(verb: string, err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 402) return `${verb} blocked: runtime quota exceeded`;
    if (err.status === 409) return `${verb} not possible in the VM's current state`;
  }
  return `${verb} failed: ` + (err instanceof Error ? err.message : String(err));
}

// Shapes mirror the control-plane JSON (camelCase tags on vmRow + the
// events array — NOT snake_case, and the key is `events` not `audit`).
interface VmDetail {
  vm: {
    vmId: string;
    state: string;
    node: string | null;
    az: string | null;
    region?: string | null;
    isolationClass: string;
    spec: Record<string, unknown> | null;
    createdAt: string;
    terminatedAt?: string | null;
    lastHeartbeatAt?: string | null;
    snapshotId?: string | null;
    parentVmId?: string | null;
  };
  events: Array<{ id: number; action: string; attrs: Record<string, unknown>; at: string }>;
}

export default function RuntimeVmPage() {
  const params = useParams<{ vmId: string }>();
  const router = useRouter();
  const toast = useToast();
  const vmId = params?.vmId;
  const [detail, setDetail] = useState<VmDetail | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [terminating, setTerminating] = useState(false);
  const [confirmTerminate, setConfirmTerminate] = useState(false);
  const [busy, setBusy] = useState<"pause" | "resume" | "fork" | null>(null);
  const [forkOpen, setForkOpen] = useState(false);
  const [forkCount, setForkCount] = useState("1");
  const logBoxRef = useRef<HTMLDivElement>(null);

  // Initial + polling load of details + audit. Dedup errors so a 401 / 500
  // doesn't toast-spam every 5 seconds.
  useEffect(() => {
    if (!vmId) return;
    // Navigating from one VM's page to another's re-runs this effect with a
    // new vmId — drop the previous VM's detail/logs so stale data doesn't
    // bleed into the new page while the first load is in flight.
    setDetail(null);
    setLogs([]);
    let cancelled = false;
    let lastError = "";
    const load = async () => {
      try {
        const d = await runtimeApi.get<VmDetail>(`/v1/runtime/vms/${vmId}`);
        if (!cancelled) {
          setDetail(d);
          lastError = "";
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === lastError) return;
        lastError = msg;
        toast.error("Failed to load VM: " + msg);
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [vmId, toast]);

  // SSE log stream — EventSource auto-reconnects on transient errors.
  useEffect(() => {
    if (!vmId) return;
    const es = new EventSource(runtimeApi.logsUrl(vmId), { withCredentials: true });
    es.onmessage = (e) => {
      try {
        const line = JSON.parse(e.data) as { stream?: string; text?: string; at?: string };
        const stream = line.stream || "stdout";
        const text = line.text || "";
        const at = line.at || new Date().toISOString();
        setLogs((prev) => {
          const next = [...prev, `[${at.slice(11, 19)}] [${stream}] ${text}`];
          return next.length > 500 ? next.slice(-500) : next;
        });
      } catch {
        setLogs((prev) => [...prev, e.data].slice(-500));
      }
    };
    return () => es.close();
  }, [vmId]);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [logs]);

  const terminate = useCallback(async () => {
    if (!vmId) return;
    setTerminating(true);
    try {
      await runtimeApi.del(`/v1/runtime/vms/${vmId}`);
      toast.success("Termination requested");
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        toast.error("Termination failed: " + (err instanceof Error ? err.message : String(err)));
      }
    } finally {
      setTerminating(false);
      setConfirmTerminate(false);
    }
  }, [vmId, toast]);

  const reload = useCallback(async () => {
    if (!vmId) return;
    try {
      setDetail(await runtimeApi.get<VmDetail>(`/v1/runtime/vms/${vmId}`));
    } catch {
      /* the 5s poll will retry */
    }
  }, [vmId]);

  const pause = useCallback(async () => {
    if (!vmId) return;
    setBusy("pause");
    try {
      await runtimeApi.post(`/v1/runtime/vms/${vmId}/pause`);
      toast.success("VM paused");
      await reload();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) toast.error(lifecycleError("Pause", err));
    } finally {
      setBusy(null);
    }
  }, [vmId, toast, reload]);

  const resume = useCallback(async () => {
    if (!vmId) return;
    setBusy("resume");
    try {
      await runtimeApi.post(`/v1/runtime/vms/${vmId}/resume`);
      toast.success("VM resumed");
      await reload();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) toast.error(lifecycleError("Resume", err));
    } finally {
      setBusy(null);
    }
  }, [vmId, toast, reload]);

  const forkCountNum = Number(forkCount);
  const forkCountValid = Number.isInteger(forkCountNum) && forkCountNum >= 1 && forkCountNum <= 10;

  const fork = useCallback(async () => {
    if (!vmId || !forkCountValid) return;
    setBusy("fork");
    try {
      const r = await runtimeApi.post<ForkResult>(`/v1/runtime/vms/${vmId}/fork`, { count: forkCountNum });
      const failed = r.forks.filter((f) => f.error);
      if (failed.length === 0) {
        toast.success(`Forked ${r.forks.length} VM${r.forks.length === 1 ? "" : "s"}`);
      } else {
        toast.warning(`Forked ${r.forks.length - failed.length} of ${r.forks.length}; first error: ${failed[0].error}`);
      }
      setForkOpen(false);
      await reload();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) toast.error(lifecycleError("Fork", err));
    } finally {
      setBusy(null);
    }
  }, [vmId, forkCountValid, forkCountNum, toast, reload]);

  if (!detail) return <PageSkeleton />;

  const v = detail.vm;
  const active = v.state !== "terminated" && v.state !== "failed";

  return (
    <div className="space-y-6 p-8">
      <PageHeader
        title={v.vmId}
        description={`${v.state}${v.node ? " on " + v.node : ""} · ${v.isolationClass} · created ${formatDistanceToNow(new Date(v.createdAt), { addSuffix: true })}`}
        secondaryAction={
          <button
            onClick={() => router.push("/runtime")}
            className="inline-flex items-center gap-1.5 rounded border border-zinc-700 bg-surface-2 px-2.5 py-1 text-[12px] text-zinc-300 hover:bg-surface-3"
          >
            <ArrowLeft className="h-3 w-3" />
            Back
          </button>
        }
        action={
          active ? (
            <div className="flex items-center gap-2">
              {v.state === "running" && (
                <Button variant="secondary" size="sm" loading={busy === "pause"} onClick={pause} icon={<Pause className="h-3.5 w-3.5" />}>
                  Pause
                </Button>
              )}
              {v.state === "paused" && (
                <Button variant="secondary" size="sm" loading={busy === "resume"} onClick={resume} icon={<Play className="h-3.5 w-3.5" />}>
                  Resume
                </Button>
              )}
              {(v.state === "running" || v.state === "paused") && (
                <Button variant="secondary" size="sm" onClick={() => setForkOpen(true)} icon={<GitFork className="h-3.5 w-3.5" />}>
                  Fork
                </Button>
              )}
              <Button variant="danger" size="sm" loading={terminating} onClick={() => setConfirmTerminate(true)} icon={<StopCircle className="h-3.5 w-3.5" />}>
                Terminate
              </Button>
            </div>
          ) : null
        }
      />

      <ConfirmModal
        open={confirmTerminate}
        title={`Terminate ${vmId}?`}
        description="This drains the VM and releases its slot."
        confirmLabel="Terminate"
        tone="danger"
        confirming={terminating}
        onCancel={() => setConfirmTerminate(false)}
        onConfirm={terminate}
      />

      <Modal
        open={forkOpen}
        onClose={() => setForkOpen(false)}
        title={`Fork ${vmId}`}
        description="Snapshot this VM and start copies from the snapshot."
        size="sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setForkOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" loading={busy === "fork"} disabled={!forkCountValid} onClick={fork}>
              Fork
            </Button>
          </>
        }
      >
        <ModalField label="Number of forks" hint="1 to 10.">
          <input
            type="number"
            min={1}
            max={10}
            step={1}
            value={forkCount}
            onChange={(e) => setForkCount(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-surface-0 px-3 py-2 text-sm text-zinc-100 focus:border-pal-500 focus:outline-none"
          />
        </ModalField>
      </Modal>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Logs — wide column */}
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-300">Live logs</h3>
            <div className="flex items-center gap-2 text-[12px] text-zinc-500">
              <span className={clsx("h-1.5 w-1.5 rounded-full", active ? "bg-emerald-400 animate-pulse" : "bg-zinc-600")} />
              {active ? "streaming" : "stream closed"}
              <span className="text-zinc-700">·</span>
              {logs.length} lines
            </div>
          </div>
          <div
            ref={logBoxRef}
            className="h-[500px] overflow-y-auto rounded-xl border border-zinc-800 bg-black p-3 font-mono text-[12px] leading-relaxed text-zinc-300"
          >
            {logs.length === 0 ? (
              <div className="text-zinc-600">Waiting for log lines…</div>
            ) : (
              logs.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap break-words">
                  {l}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right rail: spec + audit */}
        <div className="space-y-4">
          <Section title="Spec" icon={<Cpu className="h-3.5 w-3.5" />}>
            <pre className="overflow-x-auto rounded bg-surface-0 p-3 font-mono text-[12px] text-zinc-300">
              {JSON.stringify(v.spec ?? {}, null, 2)}
            </pre>
          </Section>

          <Section title="Audit trail" icon={<Activity className="h-3.5 w-3.5" />}>
            {detail.events.length === 0 ? (
              <div className="px-3 py-4 text-[12px] text-zinc-500">No events yet.</div>
            ) : (
              <ul className="space-y-1.5">
                {detail.events.map((e) => (
                  <li key={e.id} className="rounded bg-surface-0 px-2 py-1.5 text-[12px]">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-zinc-200">{e.action}</span>
                      <span className="text-zinc-500">{formatDistanceToNow(new Date(e.at), { addSuffix: true })}</span>
                    </div>
                    {Object.keys(e.attrs || {}).length > 0 && (
                      <pre className="mt-1 whitespace-pre-wrap break-words text-zinc-500">
                        {JSON.stringify(e.attrs, null, 0)}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {(v.snapshotId || v.parentVmId) && (
            <Section title="Lineage" icon={<GitFork className="h-3.5 w-3.5" />}>
              <dl className="space-y-1 px-1 py-1 text-[12px] text-zinc-400">
                {v.snapshotId && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-zinc-500">Snapshot</dt>
                    <dd className="break-all font-mono text-zinc-300">{v.snapshotId}</dd>
                  </div>
                )}
                {v.parentVmId && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-zinc-500">Parent VM</dt>
                    <dd className="break-all font-mono">
                      <Link href={`/runtime/${encodeURIComponent(v.parentVmId)}`} className="text-pal-500 hover:underline">
                        {v.parentVmId}
                      </Link>
                    </dd>
                  </div>
                )}
              </dl>
            </Section>
          )}

          <Section title="Isolation" icon={<Shield className="h-3.5 w-3.5" />}>
            <div className="px-1 py-1 text-[12px] text-zinc-400">{v.isolationClass}</div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
      <div className="mb-2 flex items-center gap-1.5 text-[12px] uppercase text-zinc-500">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}
