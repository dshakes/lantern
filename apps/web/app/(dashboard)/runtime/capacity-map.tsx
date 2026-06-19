"use client";

// Node / region capacity map — a fleet-health-at-a-glance panel. Groups
// nodes by region, shows per-node vCPU + memory utilisation bars (used vs
// free from ClusterSummary), and surfaces warm-pool capacity.

import clsx from "clsx";
import { Boxes, Server, Snowflake } from "lucide-react";
import type { ClusterSummary, ClusterNode } from "@/lib/runtime-types";
import { UtilBar } from "./cockpit-ui";

const GiB = 1024 ** 3;

function nodeUtil(n: ClusterNode): { cpu: number; mem: number; totalCpu: number; totalMem: number } {
  const totalCpu = n.total_vcpu_millis ?? n.free_vcpu_millis; // fallback: treat free as total
  const totalMem = n.total_memory_bytes ?? n.free_memory_bytes;
  const cpu = totalCpu > 0 ? 1 - n.free_vcpu_millis / totalCpu : 0;
  const mem = totalMem > 0 ? 1 - n.free_memory_bytes / totalMem : 0;
  return { cpu: Math.max(0, Math.min(1, cpu)), mem: Math.max(0, Math.min(1, mem)), totalCpu, totalMem };
}

function tone(u: number): "ok" | "accent" | "warn" | "danger" {
  if (u >= 0.85) return "danger";
  if (u >= 0.65) return "warn";
  if (u >= 0.3) return "accent";
  return "ok";
}

export function CapacityMap({
  cluster,
  nodes,
  warmPool,
}: {
  cluster: ClusterSummary | null;
  nodes?: number;
  warmPool?: number;
}) {
  if (!cluster || cluster.nodes.length === 0) {
    return (
      <div className="rounded-xl bg-surface-1 p-8 text-center text-[12px] text-zinc-600">
        No cluster capacity reported.
      </div>
    );
  }

  // Group nodes by region.
  const byRegion = new Map<string, ClusterNode[]>();
  for (const n of cluster.nodes) {
    const arr = byRegion.get(n.region) ?? [];
    arr.push(n);
    byRegion.set(n.region, arr);
  }
  const warm = cluster.warm_pool;
  const nodeCount = nodes ?? cluster.nodes.length;
  const warmAvail = warmPool ?? warm?.available;

  return (
    <div className="rounded-xl bg-surface-1">
      <div className="flex items-center justify-between border-b border-zinc-800/40 px-5 py-3.5">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
          <Boxes className="h-3.5 w-3.5 text-zinc-500" />
          Capacity map
        </div>
        <div className="flex items-center gap-4 text-[11px]">
          <span className="flex items-center gap-1.5">
            <Server className="h-3 w-3 text-zinc-500" />
            <span className="text-zinc-500">nodes</span>
            <span className="font-mono tabular-nums text-zinc-300">{nodeCount}</span>
          </span>
          {warmAvail != null && (
            <span className="flex items-center gap-1.5">
              <Snowflake className="h-3 w-3 text-zinc-500" />
              <span className="text-zinc-500">warm</span>
              <span className="font-mono tabular-nums text-zinc-300">
                {warm?.target != null ? `${warmAvail}/${warm.target}` : warmAvail}
              </span>
            </span>
          )}
        </div>
      </div>

      <div className="space-y-5 p-5">
        {[...byRegion.entries()].map(([region, nodes]) => (
          <div key={region}>
            <div className="mb-2.5 flex items-center gap-2">
              <span className="font-mono text-[11px] text-zinc-300">{region}</span>
              <span className="text-[10px] text-zinc-600">
                {nodes.length} node{nodes.length === 1 ? "" : "s"}
              </span>
              {warm?.regions?.[region] != null && (
                <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-zinc-400">
                  +{warm.regions[region]} warm
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
              {nodes.map((n) => {
                const u = nodeUtil(n);
                const hot = u.cpu >= 0.8 || u.mem >= 0.8;
                return (
                  <div
                    key={n.name}
                    className={clsx(
                      "rounded-lg bg-surface-0 px-3.5 py-3",
                      n.draining && "ring-1 ring-inset ring-zinc-700/60",
                      hot && !n.draining && "ring-1 ring-inset ring-red-500/15",
                    )}
                  >
                    <div className="mb-2.5 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] text-zinc-200">{n.name}</span>
                        {hot && <span className="h-1.5 w-1.5 rounded-full bg-red-500/60" title="high utilisation" />}
                        {n.draining && (
                          <span className="rounded bg-surface-2 px-1 py-0.5 text-[9px] uppercase tracking-wide text-zinc-400">
                            draining
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[10px] tabular-nums text-zinc-500">
                        {n.running_vms} vm{n.running_vms === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      <UtilRow
                        label="vCPU"
                        util={u.cpu}
                        detail={`${(((u.totalCpu - n.free_vcpu_millis) / 1000)).toFixed(0)}/${(u.totalCpu / 1000).toFixed(0)}`}
                      />
                      <UtilRow
                        label="MEM"
                        util={u.mem}
                        detail={`${(((u.totalMem - n.free_memory_bytes) / GiB)).toFixed(0)}/${(u.totalMem / GiB).toFixed(0)}Gi`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UtilRow({ label, util, detail }: { label: string; util: number; detail: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-9 font-mono text-[10px] text-zinc-600">{label}</span>
      <div className="flex-1">
        <UtilBar value={util} tone={tone(util)} />
      </div>
      <span className="w-16 text-right font-mono text-[10px] tabular-nums text-zinc-500">{detail}</span>
    </div>
  );
}
