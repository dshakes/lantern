"use client";

// Runtime Command Center — the flagship cockpit for headless microVM
// workloads scheduled by the control-plane.
//
// Backed by /v1/runtime/vms (list) + /v1/runtime/cluster (capacity), polled
// every 5s. When the list is EMPTY or the API is UNREACHABLE we fall back to
// a clearly-labeled DEMO FLEET (lib/runtime-demo.ts) so the cockpit always
// reads populated — mirroring the dashboard's "API offline → local mocks"
// convention. Real VMs are NEVER decorated with simulated metrics; their
// CPU/mem sparklines render "—" (see fleet-grid.tsx honesty guard).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Plus, RefreshCw, Server } from "lucide-react";
import clsx from "clsx";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { PageSkeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";
import { runtimeApi, UnauthorizedError } from "@/lib/runtime-api";
import type { VmRow, ClusterSummary } from "@/lib/runtime-types";
import { DEMO_VMS, DEMO_CLUSTER } from "@/lib/runtime-demo";
import { ScheduleModal } from "./schedule-modal";
import { FleetGrid } from "./fleet-grid";
import { CapacityMap } from "./capacity-map";
import { VmDrawer } from "./vm-drawer";

export default function RuntimePage() {
  const toast = useToast();
  const searchParams = useSearchParams();
  const [vms, setVms] = useState<VmRow[] | null>(null);
  const [cluster, setCluster] = useState<ClusterSummary | null>(null);
  const [usingDemo, setUsingDemo] = useState(false);
  // Default to the demo fleet so the cockpit shows its full instrumentation
  // (live sparklines, capacity map, cost) out of the box — local control-planes
  // report no per-VM telemetry, so the honest live view is sparse. Flip to Live
  // to see real workloads (metrics render "—" until a harness metrics endpoint
  // lands; never fabricated).
  const [demoMode, setDemoMode] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [drawerVm, setDrawerVm] = useState<VmRow | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());

  const lastErrorRef = useRef<string>("");

  const load = useCallback(async () => {
    if (demoMode) {
      setVms(DEMO_VMS);
      setCluster(DEMO_CLUSTER);
      setUsingDemo(true);
      setLastUpdated(Date.now());
      return;
    }
    try {
      const [vmRes, clRes] = await Promise.all([
        runtimeApi.get<VmRow[] | { items: VmRow[] }>("/v1/runtime/vms"),
        runtimeApi.get<ClusterSummary>("/v1/runtime/cluster").catch(() => null),
      ]);
      const items = Array.isArray(vmRes) ? vmRes : (vmRes.items ?? []);
      if (items.length === 0) {
        // Live API reachable but no workloads — show the demo fleet.
        setVms(DEMO_VMS);
        setCluster(DEMO_CLUSTER);
        setUsingDemo(true);
      } else {
        setVms(items);
        setCluster(clRes ?? null);
        setUsingDemo(false);
      }
      lastErrorRef.current = "";
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      // API unreachable — fall back to the demo fleet (don't blank the cockpit).
      setVms(DEMO_VMS);
      setCluster(DEMO_CLUSTER);
      setUsingDemo(true);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== lastErrorRef.current) {
        lastErrorRef.current = msg;
      }
    } finally {
      setLastUpdated(Date.now());
    }
  }, [demoMode]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // Deep link: the ⌘K palette's "Schedule a workload" action lands here with
  // ?schedule=1 — pop the schedule modal open on arrival.
  useEffect(() => {
    if (searchParams.get("schedule") === "1") setScheduleOpen(true);
  }, [searchParams]);

  // Keep the open drawer's row fresh as the fleet re-polls.
  useEffect(() => {
    if (!drawerVm || !vms) return;
    const fresh = vms.find((v) => v.vmId === drawerVm.vmId);
    if (fresh && fresh !== drawerVm) setDrawerVm(fresh);
  }, [vms, drawerVm]);

  const stats = useMemo(() => {
    const list = vms ?? [];
    const running = list.filter((v) => v.state === "running").length;
    const warm = list.filter((v) => v.state === "spawning" || v.state === "pending").length;
    const failed = list.filter((v) => v.state === "failed").length;
    const draining = list.filter((v) => v.state === "draining").length;
    const costHr = list
      .filter((v) => v.state === "running" || v.state === "draining" || v.state === "spawning")
      .reduce((sum, v) => sum + (v.costHr ?? 0), 0);
    return {
      total: list.length,
      running,
      warm,
      failed,
      draining,
      costHr,
      nodes: cluster?.nodes.length ?? 0,
      warmPool: cluster?.warm_pool?.available ?? 0,
    };
  }, [vms, cluster]);

  const terminateMany = useCallback(
    async (ids: string[]) => {
      if (usingDemo) {
        toast.success(`Termination requested for ${ids.length} workload(s) (demo)`);
        return;
      }
      let ok = 0;
      await Promise.all(
        ids.map(async (id) => {
          try {
            await runtimeApi.del(`/v1/runtime/vms/${id}`);
            ok++;
          } catch (err) {
            if (!(err instanceof UnauthorizedError)) {
              /* swallow; summarised below */
            }
          }
        }),
      );
      toast.success(`Termination requested for ${ok}/${ids.length} workload(s)`);
      load();
    },
    [usingDemo, toast, load],
  );

  if (vms === null) return <PageSkeleton />;

  const hasRealEmpty = !usingDemo && vms.length === 0;

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Runtime Command Center"
        description="Headless agents running in isolated microVMs."
        action={
          <div className="flex items-center gap-2">
            <div
              className="flex items-center rounded-lg bg-surface-2 p-0.5 text-xs"
              role="group"
              aria-label="Data source"
            >
              {(["demo", "live"] as const).map((m) => {
                const active = (demoMode ? "demo" : "live") === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setDemoMode(m === "demo")}
                    aria-pressed={active}
                    className={clsx(
                      "rounded-md px-2.5 py-1 font-medium capitalize transition-colors",
                      active ? "bg-surface-0 text-zinc-100 shadow-sm" : "text-zinc-500 hover:text-zinc-300",
                    )}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
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
            <Button variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setScheduleOpen(true)}>
              Schedule
            </Button>
          </div>
        }
      />

      {/* Command strip — a quiet stat line, not a glowing toolbar */}
      <CommandStrip stats={stats} usingDemo={usingDemo} lastUpdated={lastUpdated} />

      <ScheduleModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} onScheduled={load} />

      <div className="space-y-8 p-8 md:p-10">
        {hasRealEmpty ? (
          <EmptyState
            icon={Server}
            title="No workloads running"
            description="Schedule a headless agent from here, or use `lantern run <agent.yaml>` / POST /v1/runtime/schedule."
            actionLabel="Schedule a workload"
            onAction={() => setScheduleOpen(true)}
          />
        ) : (
          <div className="grid grid-cols-1 gap-8 xl:grid-cols-[1fr_360px]">
            <div className="min-w-0">
              <FleetGrid
                vms={vms}
                isDemo={usingDemo}
                onOpen={(vm) => setDrawerVm(vm)}
                onTerminateSelected={terminateMany}
              />
            </div>
            <div className="space-y-6">
              <CapacityMap cluster={cluster} nodes={stats.nodes} warmPool={stats.warmPool} />
            </div>
          </div>
        )}
      </div>

      {drawerVm && (
        <VmDrawer
          vm={drawerVm}
          isDemo={usingDemo}
          onClose={() => setDrawerVm(null)}
          onTerminated={() => {
            setDrawerVm(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command strip — a quiet stat line. Neutral type, one calm live dot, no
// glow. Separation from the header is a faint divider + whitespace, not a
// heavy rule or a tinted toolbar.
// ---------------------------------------------------------------------------

function CommandStrip({
  stats,
  usingDemo,
  lastUpdated,
}: {
  stats: {
    total: number;
    running: number;
    failed: number;
    costHr: number;
  };
  usingDemo: boolean;
  lastUpdated: number;
}) {
  const [, force] = useState(0);
  // Tick the "updated Ns ago" label.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const agoS = Math.max(0, Math.round((Date.now() - lastUpdated) / 1000));

  return (
    <div className="flex flex-wrap items-center gap-x-12 gap-y-3 border-b border-zinc-800/40 px-8 py-4 md:px-10">
      <div className="flex items-center gap-2">
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-emerald-500/70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500/80" />
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">Live</span>
      </div>

      <Metric label="Workloads" value={stats.total} />
      <Metric label="Running" value={stats.running} />
      <Metric label="Failed" value={stats.failed} tone={stats.failed > 0 ? "danger" : "neutral"} />

      <div className="flex items-baseline gap-2.5">
        <span className="text-[11px] uppercase tracking-wide text-zinc-500">Fleet</span>
        <span className="font-mono text-[15px] font-medium tabular-nums text-zinc-200">
          ${stats.costHr.toFixed(2)}
          <span className="ml-0.5 text-[10px] font-normal text-zinc-500">/hr</span>
        </span>
      </div>

      <div className="ml-auto flex items-center gap-3 text-[11px] text-zinc-500">
        {usingDemo && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 font-medium text-zinc-400">
            <AlertTriangle className="h-3 w-3 text-zinc-500" />
            Demo fleet — no live workloads
          </span>
        )}
        <span className="tabular-nums">updated {agoS}s ago</span>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "danger";
}) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</span>
      <span
        className={clsx(
          "font-mono text-[15px] font-medium tabular-nums",
          tone === "danger" ? "text-red-400/90" : "text-zinc-200",
        )}
      >
        {value}
      </span>
    </div>
  );
}
