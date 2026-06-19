"use client";

// Live drawer — slide-over opened on row click. Tabbed: Live logs (SSE),
// Exec, Metrics, Audit, Lifecycle. Focus-trapped; Esc closes.
//
// Reuses the [vmId] page's EventSource log stream + exec/terminate paths.
// For DEMO rows there is no live backend, so logs/exec/audit show a clearly
// labelled simulated stream and metrics are seeded from the demo series.
// REAL rows hit the live endpoints and render "—" where data is absent.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  X,
  ExternalLink,
  StopCircle,
  TerminalSquare,
  ScrollText,
  Activity,
  Gauge,
  ListTree,
  CornerDownLeft,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { Button } from "@/components/button";
import { useToast } from "@/components/toast";
import { runtimeApi, UnauthorizedError } from "@/lib/runtime-api";
import type { VmRow } from "@/lib/runtime-types";
import { initialSeries, advance } from "@/lib/runtime-metrics";
import { StatePill, IsolationBadge, Sparkline, UtilBar } from "./cockpit-ui";

type Tab = "logs" | "exec" | "metrics" | "audit" | "lifecycle";

const TABS: { id: Tab; label: string; icon: typeof ScrollText }[] = [
  { id: "logs", label: "Live logs", icon: ScrollText },
  { id: "exec", label: "Exec", icon: TerminalSquare },
  { id: "metrics", label: "Metrics", icon: Gauge },
  { id: "audit", label: "Audit", icon: ListTree },
  { id: "lifecycle", label: "Lifecycle", icon: Activity },
];

interface AuditEvent {
  id: number;
  action: string;
  attrs: Record<string, unknown>;
  at: string;
}

const DEMO_LOG_LINES = [
  "harness: booted, egress allowlist applied",
  "harness: resolved 2 short-TTL secrets",
  "agent: loading bundle digest sha256:9f3c…",
  "agent: step_started step=plan",
  "model-router: routed reasoning-large → vendor",
  "agent: step_completed step=plan tokens_in=812 tokens_out=204",
  "agent: step_started step=tool name=web.fetch",
  "tool: web.fetch 200 OK 1.2s",
  "agent: heartbeat ok",
];

export function VmDrawer({
  vm,
  isDemo,
  onClose,
  onTerminated,
}: {
  vm: VmRow;
  isDemo: boolean;
  onClose: () => void;
  onTerminated: () => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("logs");
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc to close + focus trap entry. Lock body scroll.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Workload ${vm.vmId}`}
        className="drawer-panel relative flex h-full w-full max-w-2xl flex-col border-l border-zinc-800 bg-surface-1 shadow-2xl outline-none"
      >
        <DrawerHeader vm={vm} isDemo={isDemo} onClose={onClose} />

        {/* Tabs */}
        <div className="flex items-center gap-0.5 border-b border-zinc-800 px-3">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={clsx(
                  "flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[12px] font-medium transition-colors",
                  tab === t.id
                    ? "border-lantern-400 text-zinc-100"
                    : "border-transparent text-zinc-500 hover:text-zinc-300",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === "logs" && <LogsTab vm={vm} isDemo={isDemo} />}
          {tab === "exec" && <ExecTab vm={vm} isDemo={isDemo} />}
          {tab === "metrics" && <MetricsTab vm={vm} isDemo={isDemo} />}
          {tab === "audit" && <AuditTab vm={vm} isDemo={isDemo} />}
          {tab === "lifecycle" && (
            <LifecycleTab vm={vm} isDemo={isDemo} onTerminated={onTerminated} />
          )}
        </div>
      </div>
    </div>
  );
}

function DrawerHeader({ vm, isDemo, onClose }: { vm: VmRow; isDemo: boolean; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-base font-semibold text-zinc-100">{vm.name || "workload"}</h2>
          <StatePill state={vm.state} />
          <IsolationBadge cls={vm.isolationClass} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-zinc-500">
          <span className="text-zinc-400">{vm.vmId}</span>
          <span>·</span>
          <span>{vm.node || "unscheduled"}</span>
          {vm.region && <><span>·</span><span>{vm.region}</span></>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Link
          href={`/runtime/${vm.vmId}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-surface-2 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-surface-3"
        >
          <ExternalLink className="h-3 w-3" />
          Full page
        </Link>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1.5 text-zinc-500 hover:bg-surface-3 hover:text-zinc-200"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---- Logs tab ------------------------------------------------------------

function LogsTab({ vm, isDemo }: { vm: VmRow; isDemo: boolean }) {
  const [logs, setLogs] = useState<string[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  const active = vm.state !== "terminated" && vm.state !== "failed";

  // Demo: synthesize a streaming log. Real: SSE from the harness.
  useEffect(() => {
    if (isDemo) {
      if (!active) {
        setLogs(["[stream closed] workload is not running"]);
        return;
      }
      let i = 0;
      const id = setInterval(() => {
        const line = DEMO_LOG_LINES[i % DEMO_LOG_LINES.length];
        const ts = new Date().toISOString().slice(11, 19);
        setLogs((prev) => [...prev, `[${ts}] [stdout] ${line}`].slice(-300));
        i++;
      }, 1100);
      return () => clearInterval(id);
    }
    const es = new EventSource(runtimeApi.logsUrl(vm.vmId), { withCredentials: true });
    es.onmessage = (e) => {
      try {
        const line = JSON.parse(e.data) as { stream?: string; text?: string; at?: string };
        const at = line.at || new Date().toISOString();
        setLogs((prev) => [...prev, `[${at.slice(11, 19)}] [${line.stream || "stdout"}] ${line.text || ""}`].slice(-300));
      } catch {
        setLogs((prev) => [...prev, e.data].slice(-300));
      }
    };
    return () => es.close();
  }, [vm.vmId, isDemo, active]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span className="flex items-center gap-1.5">
          <span className={clsx("h-1.5 w-1.5 rounded-full", active ? "bg-emerald-400 animate-pulse" : "bg-zinc-600")} />
          {active ? "streaming" : "stream closed"}
          {isDemo && <span className="ml-1 rounded bg-amber-500/10 px-1 text-amber-400">simulated</span>}
        </span>
        <span className="tabular-nums">{logs.length} lines</span>
      </div>
      <div
        ref={boxRef}
        className="h-[60vh] overflow-y-auto rounded-lg border border-zinc-800 bg-black p-3 font-mono text-[11px] leading-relaxed text-zinc-300"
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
  );
}

// ---- Exec tab ------------------------------------------------------------

function ExecTab({ vm, isDemo }: { vm: VmRow; isDemo: boolean }) {
  const toast = useToast();
  const [cmd, setCmd] = useState("");
  const [history, setHistory] = useState<{ cmd: string; out: string }[]>([]);
  const [running, setRunning] = useState(false);
  const active = vm.state === "running" || vm.state === "draining";

  const run = useCallback(async () => {
    const c = cmd.trim();
    if (!c) return;
    setRunning(true);
    setCmd("");
    if (isDemo) {
      // Simulated exec — never claims to run on a real workload.
      const out =
        c.startsWith("ls")
          ? "bin  dev  etc  proc  sys  tmp  usr  var"
          : c.startsWith("cat /etc/hostname")
            ? vm.node || "demo-host"
            : c.startsWith("ps")
              ? "PID  CMD\n  1  /harness\n 14  agent-runner"
              : `(demo) executed: ${c}`;
      await new Promise((r) => setTimeout(r, 350));
      setHistory((h) => [...h, { cmd: c, out }]);
      setRunning(false);
      return;
    }
    try {
      const res = await runtimeApi.post<{ stdout?: string; stderr?: string; exitCode?: number }>(
        `/v1/runtime/vms/${vm.vmId}/exec`,
        { command: ["sh", "-c", c] },
      );
      const out = [res.stdout, res.stderr].filter(Boolean).join("\n") || `(exit ${res.exitCode ?? 0})`;
      setHistory((h) => [...h, { cmd: c, out }]);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        const msg = err instanceof Error ? err.message : String(err);
        setHistory((h) => [...h, { cmd: c, out: `error: ${msg}` }]);
        toast.error("Exec failed: " + msg);
      }
    } finally {
      setRunning(false);
    }
  }, [cmd, isDemo, vm.vmId, vm.node, toast]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[11px] text-zinc-500">
        <TerminalSquare className="h-3.5 w-3.5" />
        One-shot exec into the workload
        {isDemo && <span className="rounded bg-amber-500/10 px-1 text-amber-400">simulated</span>}
      </div>
      <div className="min-h-[200px] space-y-3 rounded-lg border border-zinc-800 bg-black p-3 font-mono text-[11px] text-zinc-300">
        {history.length === 0 && <div className="text-zinc-600">No commands yet. Try `ls`, `ps`, `cat /etc/hostname`.</div>}
        {history.map((h, i) => (
          <div key={i}>
            <div className="text-lantern-300">$ {h.cmd}</div>
            <pre className="mt-0.5 whitespace-pre-wrap break-words text-zinc-400">{h.out}</pre>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-zinc-600">$</span>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
          disabled={!active && !isDemo}
          placeholder={active || isDemo ? "command…" : "workload not running"}
          className="flex-1 rounded-lg border border-zinc-700 bg-surface-0 px-3 py-2 font-mono text-[12px] text-zinc-100 placeholder-zinc-600 focus:border-lantern-500 focus:outline-none disabled:opacity-50"
        />
        <Button variant="secondary" size="sm" loading={running} onClick={run} icon={<CornerDownLeft className="h-3.5 w-3.5" />}>
          Run
        </Button>
      </div>
    </div>
  );
}

// ---- Metrics tab ---------------------------------------------------------

function MetricsTab({ vm, isDemo }: { vm: VmRow; isDemo: boolean }) {
  const [cpu, setCpu] = useState<number[]>([]);
  const [mem, setMem] = useState<number[]>([]);
  const active = vm.state === "running" || vm.state === "draining";

  useEffect(() => {
    if (!isDemo) return; // real metrics endpoint not available — show "—"
    const s = initialSeries(vm.vmId, vm.cpuBase ?? 0.3, vm.memBase ?? 0.3);
    setCpu(s.cpu);
    setMem(s.mem);
    if (!active) return;
    const id = setInterval(() => {
      setCpu((c) => advance(c, vm.cpuBase ?? 0.3, 0.18));
      setMem((m) => advance(m, vm.memBase ?? 0.3, 0.08));
    }, 1200);
    return () => clearInterval(id);
  }, [isDemo, vm.vmId, vm.cpuBase, vm.memBase, active]);

  if (!isDemo) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-800 bg-surface-0 p-8 text-center">
        <Gauge className="mx-auto mb-2 h-5 w-5 text-zinc-600" />
        <div className="text-[12px] text-zinc-400">No live metrics for this workload</div>
        <div className="mt-1 text-[11px] text-zinc-600">
          Per-VM CPU/memory/network telemetry needs a metrics endpoint on the harness. Until then real workloads
          render <span className="font-mono text-zinc-500">—</span> (never fabricated).
        </div>
      </div>
    );
  }

  const cpuNow = cpu[cpu.length - 1] ?? 0;
  const memNow = mem[mem.length - 1] ?? 0;
  const cost = vm.costHr ?? 0;

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-zinc-500">
        Live utilisation
        <span className="ml-1 rounded bg-amber-500/10 px-1 text-amber-400">simulated</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <MetricCard label="CPU" value={`${(cpuNow * 100).toFixed(0)}%`} series={cpu} color="var(--color-accent)" />
        <MetricCard label="Memory" value={`${(memNow * 100).toFixed(0)}%`} series={mem} color="#34d399" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-zinc-800 bg-surface-0 p-3">
          <div className="text-[10px] uppercase text-zinc-500">Cost rate</div>
          <div className="mt-1 font-mono text-lg tabular-nums text-zinc-100">${cost.toFixed(3)}/hr</div>
          <div className="mt-0.5 text-[10px] text-zinc-600">≈ ${(cost * 24).toFixed(2)}/day</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-surface-0 p-3">
          <div className="text-[10px] uppercase text-zinc-500">Network</div>
          <div className="mt-1 font-mono text-lg tabular-nums text-zinc-100">
            {(cpuNow * 18 + 2).toFixed(1)} MB/s
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-600">egress within allowlist</div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, series, color }: { label: string; value: string; series: number[]; color: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-surface-0 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase text-zinc-500">{label}</span>
        <span className="font-mono text-[13px] tabular-nums text-zinc-100">{value}</span>
      </div>
      <div className="mt-2">
        <Sparkline data={series} color={color} width={220} height={44} />
      </div>
      <div className="mt-2">
        <UtilBar value={series[series.length - 1] ?? 0} tone={(series[series.length - 1] ?? 0) > 0.8 ? "danger" : "accent"} />
      </div>
    </div>
  );
}

// ---- Audit tab -----------------------------------------------------------

function AuditTab({ vm, isDemo }: { vm: VmRow; isDemo: boolean }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);

  useEffect(() => {
    if (isDemo) {
      const base = Date.now();
      setEvents([
        { id: 4, action: "heartbeat", attrs: { ok: true }, at: new Date(base - 4000).toISOString() },
        { id: 3, action: "secret.resolved", attrs: { count: 2, ttl: "5m" }, at: new Date(base - 60000).toISOString() },
        { id: 2, action: "egress.applied", attrs: { policy: "allowlist", hosts: 3 }, at: new Date(base - 120000).toISOString() },
        { id: 1, action: "vm.scheduled", attrs: { node: vm.node, isolation: vm.isolationClass }, at: vm.createdAt },
      ]);
      return;
    }
    runtimeApi
      .get<{ events: AuditEvent[] }>(`/v1/runtime/vms/${vm.vmId}`)
      .then((d) => setEvents(d.events ?? []))
      .catch(() => setEvents([]));
  }, [vm.vmId, isDemo, vm.node, vm.isolationClass, vm.createdAt]);

  if (events === null) return <div className="text-[12px] text-zinc-600">Loading audit trail…</div>;
  if (events.length === 0) return <div className="text-[12px] text-zinc-500">No audit events yet.</div>;

  return (
    <ul className="space-y-1.5">
      {events.map((e) => (
        <li key={e.id} className="rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="font-mono font-medium text-zinc-200">{e.action}</span>
            <span className="text-zinc-500">{formatDistanceToNow(new Date(e.at), { addSuffix: true })}</span>
          </div>
          {Object.keys(e.attrs || {}).length > 0 && (
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-zinc-600">{JSON.stringify(e.attrs)}</pre>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---- Lifecycle tab -------------------------------------------------------

function LifecycleTab({ vm, isDemo, onTerminated }: { vm: VmRow; isDemo: boolean; onTerminated: () => void }) {
  const toast = useToast();
  const [terminating, setTerminating] = useState(false);
  const active = vm.state !== "terminated" && vm.state !== "failed";

  const STEPS: { state: string; label: string }[] = [
    { state: "pending", label: "Queued for placement" },
    { state: "spawning", label: "Spawning sandbox" },
    { state: "running", label: "Running" },
    { state: "draining", label: "Draining" },
    { state: "terminated", label: "Terminated" },
  ];
  const order = ["pending", "spawning", "running", "draining", "terminated"];
  const curIdx = order.indexOf(vm.state);

  const terminate = useCallback(async () => {
    if (!confirm(`Terminate ${vm.name || vm.vmId}? This drains the VM and releases its slot.`)) return;
    setTerminating(true);
    try {
      if (isDemo) {
        await new Promise((r) => setTimeout(r, 400));
        toast.success("Termination requested (demo)");
      } else {
        await runtimeApi.del(`/v1/runtime/vms/${vm.vmId}`);
        toast.success("Termination requested");
      }
      onTerminated();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        toast.error("Termination failed: " + (err instanceof Error ? err.message : String(err)));
      }
    } finally {
      setTerminating(false);
    }
  }, [vm, isDemo, toast, onTerminated]);

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-zinc-800 bg-surface-0 p-4">
        <div className="mb-3 text-[11px] uppercase text-zinc-500">State timeline</div>
        <ol className="space-y-3">
          {STEPS.map((s, i) => {
            const done = vm.state === "failed" ? i <= curIdx : i < curIdx;
            const cur = i === curIdx;
            const failed = vm.state === "failed" && cur;
            return (
              <li key={s.state} className="flex items-center gap-3">
                <span
                  className={clsx(
                    "h-2.5 w-2.5 rounded-full",
                    failed ? "bg-red-400" : cur ? "bg-emerald-400 animate-pulse" : done ? "bg-zinc-500" : "bg-surface-3",
                  )}
                />
                <span className={clsx("text-[12px]", cur ? "font-medium text-zinc-100" : done ? "text-zinc-400" : "text-zinc-600")}>
                  {failed ? "Failed" : s.label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <Field label="Created" value={formatDistanceToNow(new Date(vm.createdAt), { addSuffix: true })} />
        <Field
          label="Last heartbeat"
          value={vm.lastHeartbeatAt ? formatDistanceToNow(new Date(vm.lastHeartbeatAt), { addSuffix: true }) : "—"}
        />
        <Field label="Node" value={vm.node || "—"} mono />
        <Field label="Region / AZ" value={vm.region ? `${vm.region}${vm.az ? " / " + vm.az : ""}` : "—"} mono />
      </div>

      <div className="rounded-lg border border-zinc-800 bg-surface-0 p-3">
        <div className="mb-2 text-[11px] uppercase text-zinc-500">Spec</div>
        <pre className="overflow-x-auto font-mono text-[11px] text-zinc-400">{JSON.stringify(vm.spec ?? {}, null, 2)}</pre>
      </div>

      {active && (
        <Button variant="danger" size="md" loading={terminating} onClick={terminate} icon={<StopCircle className="h-3.5 w-3.5" />}>
          Terminate workload
        </Button>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2">
      <div className="text-[10px] uppercase text-zinc-500">{label}</div>
      <div className={clsx("mt-0.5 text-zinc-200", mono && "font-mono text-[11px]")}>{value}</div>
    </div>
  );
}
