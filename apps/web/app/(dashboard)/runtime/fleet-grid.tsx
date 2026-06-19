"use client";

// Fleet grid — the cockpit centerpiece. Dense, sortable, searchable,
// multi-selectable table of workloads with inline live mini-sparklines for
// CPU + memory.
//
// HONESTY: sparklines + cost render from the simulated series ONLY for demo
// rows (`isDemo`). Real rows render "—" for CPU/mem unless the API supplies
// metrics (it currently does not), and cost from `costHr` if present else "—".

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  StopCircle,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import clsx from "clsx";
import type { VmRow, VmState } from "@/lib/runtime-types";
import { initialSeries, advance } from "@/lib/runtime-metrics";
import { StateDot, STATE_STYLES, IsolationBadge, Sparkline } from "./cockpit-ui";

type SortKey = "name" | "state" | "cost" | "cpu" | "age" | "heartbeat";
type SortDir = "asc" | "desc";

const STATE_ORDER: VmState[] = ["running", "spawning", "pending", "draining", "failed", "terminated"];

function heartbeatTone(iso?: string | null): { dot: string; label: string } {
  if (!iso) return { dot: "bg-zinc-600", label: "—" };
  const ageS = (Date.now() - new Date(iso).getTime()) / 1000;
  // Calm signal: healthy heartbeats read neutral; only a stale (>60s) beat
  // earns a muted red dot. No green/amber traffic-light.
  if (ageS < 15) return { dot: "bg-emerald-500/70", label: `${Math.round(ageS)}s` };
  if (ageS < 60) return { dot: "bg-zinc-500", label: `${Math.round(ageS)}s` };
  return { dot: "bg-red-500/60", label: formatDistanceToNowStrict(new Date(iso)) };
}

export function FleetGrid({
  vms,
  isDemo,
  onOpen,
  onTerminateSelected,
}: {
  vms: VmRow[];
  isDemo: boolean;
  onOpen: (vm: VmRow) => void;
  onTerminateSelected: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | VmState>("all");
  const [sortKey, setSortKey] = useState<SortKey>("state");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ---- live simulated series per demo row (CPU/mem), advanced every tick.
  const [series, setSeries] = useState<Record<string, { cpu: number[]; mem: number[] }>>({});
  const seededRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isDemo) return;
    // Seed any new rows once.
    setSeries((prev) => {
      const next = { ...prev };
      for (const v of vms) {
        if (!seededRef.current.has(v.vmId)) {
          next[v.vmId] = initialSeries(v.vmId, v.cpuBase ?? 0.3, v.memBase ?? 0.3);
          seededRef.current.add(v.vmId);
        }
      }
      return next;
    });
  }, [vms, isDemo]);

  useEffect(() => {
    if (!isDemo) return;
    const id = setInterval(() => {
      setSeries((prev) => {
        const next: typeof prev = {};
        for (const v of vms) {
          const cur = prev[v.vmId];
          if (!cur) continue;
          const live = v.state === "running" || v.state === "draining";
          next[v.vmId] = live
            ? { cpu: advance(cur.cpu, v.cpuBase ?? 0.3, 0.18), mem: advance(cur.mem, v.memBase ?? 0.3, 0.08) }
            : cur;
        }
        return next;
      });
    }, 1400);
    return () => clearInterval(id);
  }, [vms, isDemo]);

  const filtered = useMemo(() => {
    let rows = vms;
    if (stateFilter !== "all") rows = rows.filter((v) => v.state === stateFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (v) =>
          (v.name || "").toLowerCase().includes(q) ||
          v.vmId.toLowerCase().includes(q) ||
          (v.node || "").toLowerCase().includes(q) ||
          (v.region || "").toLowerCase().includes(q) ||
          v.isolationClass.toLowerCase().includes(q),
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const cpuOf = (v: VmRow) => series[v.vmId]?.cpu.slice(-1)[0] ?? -1;
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case "name":
          return dir * (a.name || a.vmId).localeCompare(b.name || b.vmId);
        case "state":
          return dir * (STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
        case "cost":
          return dir * ((a.costHr ?? 0) - (b.costHr ?? 0));
        case "cpu":
          return dir * (cpuOf(a) - cpuOf(b));
        case "age":
          return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        case "heartbeat":
          return dir * (new Date(a.lastHeartbeatAt || 0).getTime() - new Date(b.lastHeartbeatAt || 0).getTime());
        default:
          return 0;
      }
    });
  }, [vms, stateFilter, search, sortKey, sortDir, series]);

  // Prune selection of rows no longer visible / present.
  useEffect(() => {
    setSelected((prev) => {
      const present = new Set(vms.map((v) => v.vmId));
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [vms]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "name" || key === "state" ? "asc" : "desc");
    }
  };

  const selectableIds = filtered.filter((v) => v.state !== "terminated" && v.state !== "failed").map((v) => v.vmId);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  };
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: vms.length };
    for (const s of STATE_ORDER) c[s] = vms.filter((v) => v.state === s).length;
    return c;
  }, [vms]);

  return (
    <div className="space-y-4">
      {/* Toolbar: search + filter chips — recedes; lighter than the grid */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, id, node, region, tier…"
            className="h-8 w-72 rounded-lg bg-surface-2 pl-8 pr-3 text-[12px] text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-lantern-500/40"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", ...STATE_ORDER] as const)
            // Hide zero-count states (Spawning 0, Draining 0, …) — only "All"
            // and states that actually have workloads render as chips. A state
            // that drops to 0 while selected still renders so it stays reachable.
            .filter((s) => s === "all" || (counts[s] ?? 0) > 0 || stateFilter === s)
            .map((s) => (
              <button
                key={s}
                onClick={() => setStateFilter(s)}
                className={clsx(
                  "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                  stateFilter === s
                    ? "bg-surface-2 text-zinc-100"
                    : "text-zinc-500 hover:bg-surface-1 hover:text-zinc-300",
                )}
              >
                {s !== "all" && <span className={clsx("h-1.5 w-1.5 rounded-full", STATE_STYLES[s].dot)} />}
                {s === "all" ? "All" : STATE_STYLES[s].label}
                <span className="tabular-nums text-zinc-600">{counts[s] ?? 0}</span>
              </button>
            ))}
        </div>
      </div>

      {/* Bulk action bar — soft accent tint, no hard border */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-lantern-500/[0.07] px-3.5 py-2.5">
          <span className="text-[12px] text-zinc-300">
            <span className="font-medium tabular-nums text-zinc-100">{selected.size}</span> selected
          </span>
          <div className="flex items-center gap-3">
            <button onClick={() => setSelected(new Set())} className="text-[11px] text-zinc-400 hover:text-zinc-200">
              Clear
            </button>
            <button
              onClick={() => {
                if (confirm(`Terminate ${selected.size} workload(s)? This drains them and releases their slots.`)) {
                  onTerminateSelected([...selected]);
                  setSelected(new Set());
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-300/90 transition-colors hover:bg-red-500/15"
            >
              <StopCircle className="h-3.5 w-3.5" />
              Terminate selected
            </button>
          </div>
        </div>
      )}

      {/* Grid — soft surface, no hard outline; separation via tint + spacing */}
      <div className="overflow-hidden rounded-xl bg-surface-1">
        <div className="max-h-[58vh] overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-1 text-[10px] uppercase tracking-wide text-zinc-500">
              <tr className="border-b border-zinc-800/40">
                <th className="w-8 px-4 py-3.5">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Select all"
                    className="h-3.5 w-3.5 accent-lantern-400"
                  />
                </th>
                <SortTh label="Workload" col="name" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortTh label="State" col="state" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <th className="px-4 py-3.5 text-left">Tier</th>
                <SortTh label="Resources" col="cpu" active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortTh label="$/hr" col="cost" active={sortKey} dir={sortDir} onSort={toggleSort} align="right" />
                <th className="px-4 py-3.5 text-left">Node</th>
                <SortTh label="Age · HB" col="age" active={sortKey} dir={sortDir} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => {
                const ss = STATE_STYLES[v.state] ?? STATE_STYLES.pending;
                const s = series[v.vmId];
                const hb = heartbeatTone(v.lastHeartbeatAt);
                const live = v.state === "running" || v.state === "draining";
                const selectable = v.state !== "terminated" && v.state !== "failed";
                const cpuNow = s?.cpu.slice(-1)[0];
                const memNow = s?.mem.slice(-1)[0];
                return (
                  <tr
                    key={v.vmId}
                    onClick={() => onOpen(v)}
                    className={clsx(
                      "cursor-pointer border-b border-zinc-800/30 last:border-0 transition-colors hover:bg-surface-2/60",
                      selected.has(v.vmId) && "bg-lantern-500/[0.05]",
                    )}
                  >
                    <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(v.vmId)}
                        onChange={() => toggleOne(v.vmId)}
                        disabled={!selectable}
                        aria-label={`Select ${v.vmId}`}
                        className="h-3.5 w-3.5 accent-lantern-400 disabled:opacity-30"
                      />
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-medium text-zinc-100">{v.name || "workload"}</div>
                      <div className="font-mono text-[10px] text-zinc-600">{v.vmId}</div>
                    </td>
                    <td className="px-4 py-4">
                      <span className={clsx("inline-flex items-center gap-1.5 text-[12px] font-medium", ss.text)}>
                        <StateDot state={v.state} />
                        {ss.label}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <IsolationBadge cls={v.isolationClass} dense />
                    </td>
                    {/* Resources — CPU + mem stacked compactly in one cell.
                        Monochrome sparks: both lines use the accent (CPU full,
                        MEM dimmed) so the cell reads as one calm signal. */}
                    <td className="px-4 py-4">
                      {isDemo && live && s ? (
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-2">
                            <span className="w-7 font-mono text-[9px] uppercase tracking-wide text-zinc-600">cpu</span>
                            <Sparkline data={s.cpu} color="var(--color-accent)" width={48} height={14} />
                            <span className="w-8 font-mono text-[10px] tabular-nums text-zinc-400">
                              {cpuNow != null ? `${(cpuNow * 100).toFixed(0)}%` : "—"}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="w-7 font-mono text-[9px] uppercase tracking-wide text-zinc-600">mem</span>
                            <Sparkline data={s.mem} color="rgba(161,161,170,0.7)" width={48} height={14} />
                            <span className="w-8 font-mono text-[10px] tabular-nums text-zinc-400">
                              {memNow != null ? `${(memNow * 100).toFixed(0)}%` : "—"}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <span className="font-mono text-[11px] text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right font-mono text-[12px] tabular-nums text-zinc-300">
                      {v.costHr != null ? `$${v.costHr.toFixed(3)}` : "—"}
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-mono text-[11px] text-zinc-300">{v.node || "—"}</div>
                      <div className="text-[10px] text-zinc-600">{v.region || ""}</div>
                    </td>
                    {/* Age · HB merged */}
                    <td className="px-4 py-4">
                      <div className="text-[11px] tabular-nums text-zinc-400">
                        {v.createdAt ? formatDistanceToNowStrict(new Date(v.createdAt)) : "—"}
                      </div>
                      <span className="mt-0.5 inline-flex items-center gap-1.5 text-[10px] tabular-nums text-zinc-600">
                        <span className={clsx("h-1.5 w-1.5 rounded-full", hb.dot)} />
                        {hb.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-[12px] text-zinc-600">
                    No workloads match the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SortTh({
  label,
  col,
  active,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  col: SortKey;
  active: SortKey;
  dir: SortDir;
  onSort: (c: SortKey) => void;
  align?: "left" | "right";
}) {
  const isActive = active === col;
  return (
    <th className={clsx("px-4 py-3.5", align === "right" ? "text-right" : "text-left")}>
      <button
        onClick={() => onSort(col)}
        className={clsx(
          "inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-zinc-300",
          isActive ? "text-zinc-200" : "text-zinc-500",
          align === "right" && "flex-row-reverse",
        )}
      >
        {label}
        {isActive ? (
          dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </th>
  );
}
