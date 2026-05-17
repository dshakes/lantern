"use client";

// TakeoverPanel — shows pending / granted human-takeover requests for a run.
// Mounts on the run detail page. When the run's workflow hits an approval
// node, a pending row appears here; the operator clicks Grant to let the
// agent continue, optionally posting notes that become the approval
// reason in the run's journal.

import { useEffect, useState } from "react";
import {
  Hand,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Play,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";

interface Takeover {
  id: string;
  stepId: string;
  status: string;
  reason: string;
  notes: string;
  hasOffer: boolean;
  hasAnswer: boolean;
  createdAt: string;
  grantedAt: string | null;
  releasedAt: string | null;
  expiresAt: string | null;
}

export function TakeoverPanel({ runId }: { runId: string }) {
  const toast = useToast();
  const [takeovers, setTakeovers] = useState<Takeover[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await api.listTakeovers(runId);
      setTakeovers(data as Takeover[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Poll while there's anything still actionable. Stop polling
    // entirely if everything is in a terminal state to be polite.
    const id = setInterval(load, 3_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const open = takeovers.filter((t) => t.status === "pending" || t.status === "granted");
  const closed = takeovers.filter((t) => t.status !== "pending" && t.status !== "granted");

  if (!loading && takeovers.length === 0) return null;

  return (
    <section className="space-y-3 rounded-xl border border-zinc-800 bg-surface-1 p-4">
      <header className="flex items-center gap-2">
        <Hand className="h-3.5 w-3.5 text-amber-300" />
        <h3 className="text-[12px] font-semibold text-zinc-200">Human takeover</h3>
        {open.length > 0 && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-200">
            {open.length} needs action
          </span>
        )}
      </header>

      <ul className="space-y-2">
        {[...open, ...closed].map((t) => (
          <TakeoverRow
            key={t.id}
            t={t}
            acting={acting}
            onGrant={async () => {
              const notes = prompt("Notes for the agent (optional):") ?? "";
              setActing(t.id);
              try {
                await api.grantTakeover(runId, t.id, notes);
                toast.success("Granted — workflow resumes");
                load();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not grant");
              } finally {
                setActing(null);
              }
            }}
            onRelease={async () => {
              setActing(t.id);
              try {
                await api.releaseTakeover(runId, t.id);
                toast.success("Released");
                load();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not release");
              } finally {
                setActing(null);
              }
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function TakeoverRow({
  t,
  acting,
  onGrant,
  onRelease,
}: {
  t: Takeover;
  acting: string | null;
  onGrant: () => void;
  onRelease: () => void;
}) {
  const isActing = acting === t.id;
  return (
    <li className="rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          {t.status === "pending" && <Clock className="h-3.5 w-3.5 text-amber-300" />}
          {t.status === "granted" && <Loader2 className="h-3.5 w-3.5 animate-spin text-lantern-400" />}
          {t.status === "released" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
          {(t.status === "expired" || t.status === "denied") && <XCircle className="h-3.5 w-3.5 text-red-400" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-zinc-200">
            <span className="font-medium">Step {t.stepId || "—"}</span>
            <span
              className={clsx(
                "ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                t.status === "pending" && "bg-amber-500/10 text-amber-300",
                t.status === "granted" && "bg-lantern-500/10 text-lantern-300",
                t.status === "released" && "bg-emerald-500/10 text-emerald-300",
                (t.status === "expired" || t.status === "denied") && "bg-red-500/10 text-red-300"
              )}
            >
              {t.status}
            </span>
          </p>
          {t.reason && (
            <p className="mt-0.5 text-[11px] text-zinc-500">{t.reason}</p>
          )}
          {t.notes && (
            <p className="mt-0.5 text-[11px] text-zinc-400">
              note: <span className="text-zinc-300">{t.notes}</span>
            </p>
          )}
          {t.hasOffer && !t.hasAnswer && (
            <p className="mt-0.5 text-[11px] text-amber-300">
              WebRTC offer pending answer
            </p>
          )}
        </div>
        {t.status === "pending" && (
          <button
            onClick={onGrant}
            disabled={isActing}
            className="shrink-0 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/15 disabled:opacity-50"
          >
            {isActing ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Play className="mr-1 inline h-3 w-3" />Grant</>}
          </button>
        )}
        {t.status === "granted" && (
          <button
            onClick={onRelease}
            disabled={isActing}
            className="shrink-0 rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-surface-3 disabled:opacity-50"
          >
            {isActing ? <Loader2 className="h-3 w-3 animate-spin" /> : "Release"}
          </button>
        )}
      </div>
    </li>
  );
}
