"use client";

// Runtime — live view of headless microVMs scheduled by the control-plane.
//
// Backed by /v1/runtime/vms (list) and /v1/runtime/cluster (capacity).
// Polls every 5s — cheap because the list page reads a single Postgres
// table indexed on (tenant_id, created_at desc).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  Box,
  AlertTriangle,
  Loader2,
  Shield,
  TerminalSquare,
  RefreshCw,
  Plus,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { PageHeader, CountBadge } from "@/components/page-header";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { PageSkeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";
import { runtimeApi, UnauthorizedError } from "@/lib/runtime-api";
import { ScheduleModal } from "./schedule-modal";

// camelCase to match the control-plane vmRow JSON tags. (cluster summary
// below stays snake_case — that endpoint returns snake_case keys.)
interface VmRow {
  vmId: string;
  state: "pending" | "spawning" | "running" | "draining" | "terminated" | "failed";
  node: string | null;
  region?: string | null;
  az?: string | null;
  isolationClass: string;
  createdAt: string;
  terminatedAt?: string | null;
  lastHeartbeatAt?: string | null;
  spec: Record<string, unknown> | null;
}

interface ClusterSummary {
  total_vms_running: number;
  total_vms_pending: number;
  nodes: Array<{
    name: string;
    region: string;
    availability_zone: string;
    running_vms: number;
    free_vcpu_millis: number;
    free_memory_bytes: number;
    draining: boolean;
  }>;
}

const STATE_STYLES: Record<VmRow["state"], { dot: string; pill: string; label: string }> = {
  pending:    { dot: "bg-zinc-400 animate-pulse",    pill: "bg-zinc-500/10 text-zinc-300",       label: "Pending" },
  spawning:   { dot: "bg-lantern-400 animate-pulse", pill: "bg-lantern-500/10 text-lantern-300", label: "Spawning" },
  running:    { dot: "bg-emerald-400",                pill: "bg-emerald-500/10 text-emerald-300", label: "Running" },
  draining:   { dot: "bg-amber-400 animate-pulse",   pill: "bg-amber-500/10 text-amber-300",     label: "Draining" },
  terminated: { dot: "bg-zinc-500",                   pill: "bg-zinc-500/10 text-zinc-400",       label: "Terminated" },
  failed:     { dot: "bg-red-400",                    pill: "bg-red-500/10 text-red-300",         label: "Failed" },
};

const ISOLATION_STYLES: Record<string, { label: string; cls: string }> = {
  trusted:      { label: "Trusted",      cls: "bg-emerald-500/10 text-emerald-300" },
  standard:     { label: "Standard",     cls: "bg-blue-500/10 text-blue-300" },
  untrusted:    { label: "Untrusted",    cls: "bg-amber-500/10 text-amber-300" },
  hostile:      { label: "Hostile",      cls: "bg-red-500/10 text-red-300" },
  wasm:         { label: "Wasm",         cls: "bg-purple-500/10 text-purple-300" },
  devcontainer: { label: "Devcontainer", cls: "bg-cyan-500/10 text-cyan-300" },
};

export default function RuntimePage() {
  const router = useRouter();
  const toast = useToast();
  const [vms, setVms] = useState<VmRow[] | null>(null);
  const [cluster, setCluster] = useState<ClusterSummary | null>(null);
  const [stateFilter, setStateFilter] = useState<"all" | VmRow["state"]>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  // Dedup repeated error toasts on the polling loop — without this, a
  // single bad-state error (e.g. API down) fires once every 5s forever.
  const lastErrorRef = useRef<string>("");

  const load = useCallback(async () => {
    try {
      const [vmRes, clRes] = await Promise.all([
        // The list endpoint returns a BARE array ([{...}]); older drafts
        // expected {items:[...]}. Accept both so a response-shape change
        // never silently empties the table again.
        runtimeApi.get<VmRow[] | { items: VmRow[] }>("/v1/runtime/vms"),
        runtimeApi.get<ClusterSummary>("/v1/runtime/cluster").catch(() => null),
      ]);
      const items = Array.isArray(vmRes) ? vmRes : (vmRes.items ?? []);
      setVms(items);
      setCluster(clRes ?? null);
      lastErrorRef.current = "";
    } catch (err) {
      // 401 already triggered a redirect-to-login inside runtimeApi —
      // swallow so we don't toast on the way out.
      if (err instanceof UnauthorizedError) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === lastErrorRef.current) return; // same error as last tick
      lastErrorRef.current = msg;
      toast.error("Failed to load runtime view: " + msg);
    }
  }, [toast]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const visible = useMemo(() => {
    if (!vms) return [];
    if (stateFilter === "all") return vms;
    return vms.filter((v) => v.state === stateFilter);
  }, [vms, stateFilter]);

  const counts = useMemo(() => {
    if (!vms) return { running: 0, pending: 0, failed: 0, total: 0 };
    return vms.reduce(
      (acc, v) => {
        acc.total += 1;
        if (v.state === "running") acc.running += 1;
        if (v.state === "pending" || v.state === "spawning") acc.pending += 1;
        if (v.state === "failed") acc.failed += 1;
        return acc;
      },
      { running: 0, pending: 0, failed: 0, total: 0 },
    );
  }, [vms]);

  if (vms === null) return <PageSkeleton />;

  return (
    <div className="space-y-6 p-8">
      <PageHeader
        title="Runtime"
        description="Live view of headless agents executing in microVMs across the cluster."
        badge={<CountBadge count={counts.running} />}
        secondaryAction={
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className={clsx("h-3.5 w-3.5", refreshing && "animate-spin")} />}
            onClick={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          >
            Refresh
          </Button>
        }
        action={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => setScheduleOpen(true)}
          >
            Schedule VM
          </Button>
        }
      />

      <ScheduleModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        onScheduled={load}
      />

      {/* Cluster summary cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <StatCard icon={<Activity className="h-4 w-4" />}        label="Running"      value={counts.running} accent="emerald" />
        <StatCard icon={<Loader2 className="h-4 w-4" />}         label="Spawning"     value={counts.pending} accent="lantern" />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />}   label="Failed (24h)" value={counts.failed}  accent="red" />
        <StatCard icon={<Box className="h-4 w-4" />}             label="Nodes"        value={cluster?.nodes.length ?? 0} accent="zinc" />
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        {(["all", "running", "spawning", "pending", "draining", "failed", "terminated"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStateFilter(s)}
            className={clsx(
              "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors",
              stateFilter === s
                ? "border-zinc-600 bg-surface-2 text-zinc-100"
                : "border-zinc-800 bg-surface-1 text-zinc-400 hover:bg-surface-2 hover:text-zinc-200",
            )}
          >
            {s === "all" ? "All" : STATE_STYLES[s as VmRow["state"]].label}
          </button>
        ))}
      </div>

      {/* VM table */}
      {visible.length === 0 ? (
        <EmptyState
          icon={Box}
          title={stateFilter === "all" ? "No agents have run yet" : `No ${STATE_STYLES[stateFilter as VmRow["state"]].label} VMs`}
          description={
            stateFilter === "all"
              ? "Spawn one from this page, or use `lantern run <agent.yaml>` / POST /v1/runtime/schedule."
              : "Try a different filter."
          }
          actionLabel={stateFilter === "all" ? "Schedule a VM" : undefined}
          onAction={stateFilter === "all" ? () => setScheduleOpen(true) : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-800 bg-surface-0 text-[11px] uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-2.5 text-left">VM</th>
                <th className="px-4 py-2.5 text-left">State</th>
                <th className="px-4 py-2.5 text-left">Isolation</th>
                <th className="px-4 py-2.5 text-left">Node</th>
                <th className="px-4 py-2.5 text-left">Age</th>
                <th className="px-4 py-2.5 text-left">Last heartbeat</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((v) => {
                const ss = STATE_STYLES[v.state] ?? STATE_STYLES.pending;
                const is = ISOLATION_STYLES[v.isolationClass] || { label: v.isolationClass, cls: "bg-zinc-500/10 text-zinc-300" };
                return (
                  <tr
                    key={v.vmId}
                    className="border-b border-zinc-800 last:border-0 hover:bg-surface-2 cursor-pointer"
                    onClick={() => router.push(`/runtime/${v.vmId}`)}
                  >
                    <td className="px-4 py-3 font-mono text-[12px] text-zinc-200">{(v.vmId ?? "").slice(0, 12)}…</td>
                    <td className="px-4 py-3">
                      <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", ss.pill)}>
                        <span className={clsx("h-1.5 w-1.5 rounded-full", ss.dot)} />
                        {ss.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={clsx("inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium", is.cls)}>
                        <Shield className="h-3 w-3" />
                        {is.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-400">{v.node || "—"}</td>
                    <td className="px-4 py-3 text-zinc-400">{v.createdAt ? formatDistanceToNow(new Date(v.createdAt), { addSuffix: true }) : "—"}</td>
                    <td className="px-4 py-3 text-zinc-400">
                      {v.lastHeartbeatAt ? formatDistanceToNow(new Date(v.lastHeartbeatAt), { addSuffix: true }) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/runtime/${v.vmId}`}
                        className="inline-flex items-center gap-1.5 rounded border border-zinc-700 bg-surface-2 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-surface-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <TerminalSquare className="h-3 w-3" />
                        Debug
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon, label, value, accent,
}: { icon: React.ReactNode; label: string; value: number; accent: "emerald" | "lantern" | "red" | "zinc" }) {
  const accentMap: Record<string, string> = {
    emerald: "bg-emerald-500/10 text-emerald-400",
    lantern: "bg-lantern-500/10 text-lantern-400",
    red: "bg-red-500/10 text-red-400",
    zinc: "bg-zinc-500/10 text-zinc-400",
  };
  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
      <div className="flex items-center gap-2.5">
        <div className={clsx("flex h-8 w-8 items-center justify-center rounded-lg", accentMap[accent])}>{icon}</div>
        <div className="text-[11px] uppercase text-zinc-500">{label}</div>
      </div>
      <div className="mt-2 text-2xl font-semibold text-zinc-100">{value}</div>
    </div>
  );
}
