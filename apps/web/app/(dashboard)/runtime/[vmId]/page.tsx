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
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { Button } from "@/components/button";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";
import { runtimeApi } from "@/lib/runtime-api";

interface VmDetail {
  vm: {
    vm_id: string;
    state: string;
    node: string | null;
    region: string | null;
    isolation_class: string;
    spec: Record<string, unknown> | null;
    created_at: string;
    terminated_at: string | null;
    last_heartbeat_at: string | null;
  };
  audit: Array<{ id: number; action: string; attrs: Record<string, unknown>; at: string }>;
}

export default function RuntimeVmPage() {
  const params = useParams<{ vmId: string }>();
  const router = useRouter();
  const toast = useToast();
  const vmId = params?.vmId;
  const [detail, setDetail] = useState<VmDetail | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [terminating, setTerminating] = useState(false);
  const logBoxRef = useRef<HTMLDivElement>(null);

  // Initial + polling load of details + audit.
  useEffect(() => {
    if (!vmId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const d = await runtimeApi.get<VmDetail>(`/v1/runtime/vms/${vmId}`);
        if (!cancelled) setDetail(d);
      } catch (err) {
        toast.error("Failed to load VM: " + (err instanceof Error ? err.message : String(err)));
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
    if (!confirm(`Terminate ${vmId}? This drains the VM and releases its slot.`)) return;
    setTerminating(true);
    try {
      await runtimeApi.del(`/v1/runtime/vms/${vmId}`);
      toast.success("Termination requested");
    } catch (err) {
      toast.error("Termination failed: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setTerminating(false);
    }
  }, [vmId, toast]);

  if (!detail) return <PageSkeleton />;

  const v = detail.vm;
  const active = v.state !== "terminated" && v.state !== "failed";

  return (
    <div className="space-y-6 p-8">
      <PageHeader
        title={v.vm_id}
        description={`${v.state}${v.node ? " on " + v.node : ""} · ${v.isolation_class} · created ${formatDistanceToNow(new Date(v.created_at), { addSuffix: true })}`}
        secondaryAction={
          <button
            onClick={() => router.push("/runtime")}
            className="inline-flex items-center gap-1.5 rounded border border-zinc-700 bg-surface-2 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-surface-3"
          >
            <ArrowLeft className="h-3 w-3" />
            Back
          </button>
        }
        action={
          active ? (
            <Button variant="danger" size="sm" loading={terminating} onClick={terminate} icon={<StopCircle className="h-3.5 w-3.5" />}>
              Terminate
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Logs — wide column */}
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-300">Live logs</h3>
            <div className="flex items-center gap-2 text-[11px] text-zinc-500">
              <span className={clsx("h-1.5 w-1.5 rounded-full", active ? "bg-emerald-400 animate-pulse" : "bg-zinc-600")} />
              {active ? "streaming" : "stream closed"}
              <span className="text-zinc-700">·</span>
              {logs.length} lines
            </div>
          </div>
          <div
            ref={logBoxRef}
            className="h-[500px] overflow-y-auto rounded-xl border border-zinc-800 bg-black p-3 font-mono text-[11px] leading-relaxed text-zinc-300"
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
            <pre className="overflow-x-auto rounded bg-surface-0 p-3 font-mono text-[11px] text-zinc-300">
              {JSON.stringify(v.spec ?? {}, null, 2)}
            </pre>
          </Section>

          <Section title="Audit trail" icon={<Activity className="h-3.5 w-3.5" />}>
            {detail.audit.length === 0 ? (
              <div className="px-3 py-4 text-[12px] text-zinc-500">No events yet.</div>
            ) : (
              <ul className="space-y-1.5">
                {detail.audit.map((e) => (
                  <li key={e.id} className="rounded bg-surface-0 px-2 py-1.5 text-[11px]">
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

          <Section title="Isolation" icon={<Shield className="h-3.5 w-3.5" />}>
            <div className="px-1 py-1 text-[12px] text-zinc-400">{v.isolation_class}</div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase text-zinc-500">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}
