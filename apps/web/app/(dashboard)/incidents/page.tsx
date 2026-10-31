"use client";

// Incidents (ADR 0056): anomaly and SLO-burn incidents opened by the
// observability sweep. Detection is deterministic; a model only writes the
// summary, and only when it cites the linked runs.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Activity, RefreshCw } from "lucide-react";
import { api, type Incident } from "@/lib/api";
import { incidentTone, kindLabel } from "@/lib/observability";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { TonePill } from "@/components/tone-pill";
import { useToast } from "@/components/toast";

const FILTERS = [
  { id: "active", label: "Active" },
  { id: "resolved", label: "Resolved" },
  { id: "", label: "All" },
] as const;

export default function IncidentsPage() {
  const toast = useToast();
  const [filter, setFilter] = useState<string>("active");
  const [items, setItems] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await api.listIncidents({ status: filter || undefined }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load incidents");
    }
  }, [filter]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.scanIncidents();
      toast.success(r.opened ? `${r.opened} new incident${r.opened === 1 ? "" : "s"}` : "No new incidents");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Incidents"
        description="Anomalies and SLO burn detected on your agents in production. Every acknowledge and resolve is recorded."
        action={
          <Button variant="secondary" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={scanning} onClick={scan}>
            Scan now
          </Button>
        }
      />
      <div className="mx-auto w-full max-w-5xl px-6 py-6 md:px-8">
        <div className="mb-4 flex gap-1" role="group" aria-label="Filter incidents">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
                (filter === f.id ? "bg-surface-3 text-zinc-100" : "text-zinc-500 hover:text-zinc-300")
              }
            >
              {f.label}
            </button>
          ))}
        </div>

        {error ? (
          <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">
            {error}
          </p>
        ) : items === null ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Activity}
            size="compact"
            title={filter === "active" ? "No active incidents" : "No incidents"}
            description="When an agent's cost, latency, error rate, tool use or quality shifts well outside its own baseline, or burns its SLO error budget, it shows up here."
          />
        ) : (
          <ul className="divide-y divide-zinc-800/60 rounded-xl border border-zinc-800/60 bg-surface-1">
            {items.map((i) => (
              <li key={i.id}>
                <Link href={`/incidents/${i.id}`} className="flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-surface-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <TonePill tone={incidentTone(i)}>{i.status === "resolved" ? "resolved" : i.severity}</TonePill>
                    {i.status === "acknowledged" && <TonePill tone="muted">acknowledged</TonePill>}
                    <span className="text-sm font-medium text-zinc-100">{i.title}</span>
                  </div>
                  <p className="line-clamp-2 text-xs text-zinc-400">{i.summary}</p>
                  <p className="text-[11px] text-zinc-500">
                    <span className="font-mono">{i.agentName}</span> · {kindLabel(i.kind)} · {i.affectedRunIds.length} run
                    {i.affectedRunIds.length === 1 ? "" : "s"} · {new Date(i.openedAt).toLocaleString()}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
