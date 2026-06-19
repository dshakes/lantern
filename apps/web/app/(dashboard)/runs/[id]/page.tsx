"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  ArrowLeft,
  XCircle,
  Clock,
  Coins,
  Hash,
  Loader2,
  CheckCircle2,
  GitCompare,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useRun, useRunEvents } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { formatCost, formatTokens, formatDuration } from "@/lib/mock-data";
import { StatusBadge } from "@/components/status-badge";
import { JsonViewer } from "@/components/json-viewer";
import { RunDetailSkeleton } from "@/components/skeleton";
import { FeedbackWidget } from "@/components/feedback-widget";
import { ReceiptCard } from "@/components/receipt-card";
import { FlightRecorder } from "@/components/flight-recorder";
import { ViewCode, snippetsForGetRun, snippetsForCreateRun } from "@/components/view-code";
import { TakeoverPanel } from "@/components/takeover-panel";

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const id = params.id as string;

  const { run, loading, error, refresh } = useRun(id);
  const { events } = useRunEvents(id);

  // Poll for status changes
  useEffect(() => {
    if (!run || run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") return;
    const interval = setInterval(() => refresh(), 2000);
    return () => clearInterval(interval);
  }, [run?.status, refresh]);

  const isRunning = run?.status === "running" || run?.status === "paused";

  const [cancelled, setCancelled] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Run compare (regression diffing) — entering a second run id stacks its
  // trace below this one. Held behind a control; off by default (clean).
  const [compareInput, setCompareInput] = useState("");
  const [compareId, setCompareId] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);

  const handleCancel = useCallback(async () => {
    setCancelling(true);
    try {
      await api.cancelRun(id, "Cancelled from dashboard");
      toast.success("Run cancelled");
      setCancelled(true);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel run");
    } finally {
      setCancelling(false);
    }
  }, [id, toast, refresh]);

  if (loading) return <RunDetailSkeleton />;

  if (error || !run) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm font-medium text-zinc-300">Run not found</p>
        <p className="max-w-sm text-center text-xs text-zinc-500">
          The run <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-zinc-400">{id}</code> does not exist or may have been deleted.
        </p>
        <button
          onClick={() => router.push("/runs")}
          className="mt-2 text-sm text-lantern-400 transition-colors hover:text-lantern-300"
        >
          Back to Runs
        </button>
      </div>
    );
  }

  const effectiveStatus = cancelled ? "cancelled" : run.status;
  const createdAt = new Date(run.createdAt);
  const startedAt = run.startedAt ? new Date(run.startedAt) : null;
  const finishedAt = run.finishedAt ? new Date(run.finishedAt) : null;
  const totalDuration = startedAt
    ? (finishedAt ?? new Date()).getTime() - startedAt.getTime()
    : null;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <div className="mb-3">
          <button
            onClick={() => router.push("/runs")}
            className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to Runs
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-lg font-semibold text-zinc-100">{run.id}</h1>
            <StatusBadge status={effectiveStatus} />
            {isRunning && !cancelled && (
              <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* View code: equivalent SDK call to fetch this run, plus a
                template for creating new runs of the same agent. */}
            <ViewCode title="Get this run from code" snippets={snippetsForGetRun(run.id)} />
            <ViewCode
              title={`Create a run for ${run.agentName}`}
              snippets={snippetsForCreateRun(run.agentName)}
            />
            {comparing ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const id = compareInput.trim();
                  if (id) setCompareId(id);
                }}
                className="flex items-center gap-1"
              >
                <input
                  autoFocus
                  value={compareInput}
                  onChange={(e) => setCompareInput(e.target.value)}
                  placeholder="run id to compare…"
                  className="w-48 rounded-lg border border-zinc-700 bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-lantern-500 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-lantern-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-lantern-500"
                >
                  Load
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setComparing(false);
                    setCompareId(null);
                    setCompareInput("");
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-700 text-zinc-400 transition-colors hover:bg-surface-2"
                  aria-label="Cancel compare"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </form>
            ) : (
              <button
                onClick={() => setComparing(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-2"
              >
                <GitCompare className="h-4 w-4" /> Compare…
              </button>
            )}
            {isRunning && !cancelled && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                Cancel
              </button>
            )}
          </div>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Agent:{" "}
          <button
            onClick={() => router.push(`/agents/${run.agentName}`)}
            className="text-zinc-400 underline decoration-zinc-700 transition-colors hover:text-zinc-300"
          >
            {run.agentName}
          </button>
        </p>
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Trace waterfall + Output. The waterfall sits above the
            final output so the run reads top→bottom as a story: plan
            (spans + sub-events), then result. */}
        <div className="flex flex-[2] flex-col overflow-hidden border-r border-zinc-800">
          {events.length > 0 && (
            <div className="border-b border-zinc-800 p-4">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="font-mono text-[10px] text-zinc-500">{run.id}</span>
                <StatusBadge status={effectiveStatus} />
              </div>
              <FlightRecorder
                events={events}
                running={isRunning}
                totals={{
                  costUsd: run.costUsd,
                  tokensIn: run.tokensIn,
                  tokensOut: run.tokensOut,
                }}
              />
              {compareId && (
                <CompareTrace
                  runId={compareId}
                  onClose={() => {
                    setCompareId(null);
                    setComparing(false);
                    setCompareInput("");
                  }}
                />
              )}
            </div>
          )}
          <div className="flex-shrink-0 border-b border-zinc-800/50 bg-surface-1/50 px-6 py-3">
            <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Output</h2>
          </div>
          <div className="flex-1 overflow-auto p-6">
            {run.status === "succeeded" && run.output ? (
              <div className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-surface-2 p-4 font-mono text-sm leading-relaxed text-zinc-200">
                {typeof run.output === "string"
                  ? run.output
                  : typeof run.output === "object" && run.output !== null && "result" in (run.output as Record<string, unknown>)
                    ? String((run.output as Record<string, unknown>).result)
                    : JSON.stringify(run.output, null, 2)}
              </div>
            ) : run.status === "failed" && run.error ? (
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-5">
                <div className="flex items-center gap-2 text-sm font-medium text-red-400">
                  <XCircle className="h-4 w-4" /> Run Failed
                </div>
                <p className="mt-2 text-sm font-medium text-red-300">{run.error.code}</p>
                <p className="mt-1 text-sm text-red-300/70">{run.error.message}</p>
                {run.error.stepId && (
                  <p className="mt-2 font-mono text-xs text-red-300/50">Failed at step: {run.error.stepId}</p>
                )}
              </div>
            ) : run.status === "queued" ? (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-zinc-600" />
                  <p className="mt-3 text-sm text-zinc-500">Run is queued and waiting to execute.</p>
                </div>
              </div>
            ) : isRunning ? (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <Loader2 className="mx-auto h-8 w-8 animate-spin text-lantern-500" />
                  <p className="mt-3 text-sm text-zinc-600">Processing...</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-zinc-600">No output available for this run.</p>
            )}
          </div>
        </div>

        {/* Right: Metadata */}
        <div className="flex w-80 flex-shrink-0 flex-col overflow-auto bg-surface-1/30">
          <div className="space-y-5 p-5">
            {/* Run Info */}
            <section>
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">Run Info</h3>
              <dl className="space-y-2.5 text-sm">
                <InfoRow label="Status"><StatusBadge status={effectiveStatus} /></InfoRow>
                <InfoRow label="Agent"><span className="text-zinc-300">{run.agentName}</span></InfoRow>
                <InfoRow label="Run ID"><span className="font-mono text-xs text-zinc-400">{run.id}</span></InfoRow>
                {run.labels?.trigger && (
                  <InfoRow label="Trigger"><span className="rounded bg-surface-3 px-2 py-0.5 text-xs text-zinc-400">{run.labels.trigger}</span></InfoRow>
                )}
              </dl>
            </section>

            {/* Timing */}
            <section>
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500">
                <Clock className="h-3.5 w-3.5" /> Timing
              </h3>
              <dl className="space-y-2.5 text-sm">
                <InfoRow label="Created">
                  <span className="text-zinc-400">{format(createdAt, "MMM d, HH:mm:ss")}</span>
                </InfoRow>
                {startedAt && (
                  <InfoRow label="Started">
                    <span className="text-zinc-400">{format(startedAt, "MMM d, HH:mm:ss")}</span>
                  </InfoRow>
                )}
                {finishedAt && (
                  <InfoRow label="Finished">
                    <span className="text-zinc-400">{format(finishedAt, "MMM d, HH:mm:ss")}</span>
                  </InfoRow>
                )}
                {totalDuration !== null && (
                  <InfoRow label="Duration">
                    <span className="font-medium text-zinc-300">{formatDuration(totalDuration)}</span>
                  </InfoRow>
                )}
              </dl>
            </section>

            {/* Cost */}
            <section>
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500">
                <Coins className="h-3.5 w-3.5" /> Cost
              </h3>
              <dl className="space-y-2.5 text-sm">
                <InfoRow label="Tokens in"><span className="font-mono text-xs text-zinc-400">{formatTokens(run.tokensIn)}</span></InfoRow>
                <InfoRow label="Tokens out"><span className="font-mono text-xs text-zinc-400">{formatTokens(run.tokensOut)}</span></InfoRow>
                <InfoRow label="Total tokens"><span className="font-mono text-xs text-zinc-300">{formatTokens(run.tokensIn + run.tokensOut)}</span></InfoRow>
                <InfoRow label="Cost"><span className="font-mono text-sm font-medium text-lantern-500">{formatCost(run.costUsd)}</span></InfoRow>
              </dl>
            </section>

            {/* Human takeover panel — only renders when there are pending or
                past takeover requests. Otherwise hides itself entirely. */}
            <TakeoverPanel runId={run.id} />

            {/* Feedback (RLHF loop) — only after run reached a terminal state */}
            {(effectiveStatus === "succeeded" || effectiveStatus === "failed") && (
              <section>
                <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Feedback
                </h3>
                <FeedbackWidget runId={run.id} />
              </section>
            )}

            {/* Verifiable receipt — only for completed runs */}
            {(effectiveStatus === "succeeded" || effectiveStatus === "failed") && (
              <section>
                <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Verification
                </h3>
                <ReceiptCard runId={run.id} />
              </section>
            )}

            {/* Input / Output raw data */}
            <section>
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500">
                <Hash className="h-3.5 w-3.5" /> Data
              </h3>
              <div className="space-y-2">
                <JsonViewer data={run.input} label="Input" defaultOpen />
                {run.output !== undefined && run.output !== null && (
                  <JsonViewer data={run.output} label="Output (raw)" />
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

// Compare panel — a second run's flight recorder stacked under the primary
// trace for regression diffing. Mounted only when a compare id is set, so
// its event stream opens lazily and tears down on close (clean — no idle
// second SSE connection when the user isn't comparing).
function CompareTrace({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { run, loading, error } = useRun(runId);
  const { events } = useRunEvents(runId);
  const isRunning = run?.status === "running" || run?.status === "paused";

  return (
    <div className="mt-4 rounded-xl border border-zinc-800 bg-surface-1/40">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <GitCompare className="h-3.5 w-3.5 text-zinc-500" />
          <span className="text-[11px] font-semibold text-zinc-300">Compare</span>
          <span className="font-mono text-[10px] text-zinc-500">{runId}</span>
          {run && <StatusBadge status={run.status} />}
        </div>
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded border border-zinc-700 text-zinc-400 transition-colors hover:bg-surface-2"
          aria-label="Close compare"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="p-4">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-xs text-zinc-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading {runId}…
          </div>
        ) : error || !run ? (
          <p className="py-6 text-center text-xs text-zinc-500">
            Run <span className="font-mono text-zinc-400">{runId}</span> not found.
          </p>
        ) : events.length === 0 ? (
          <p className="py-6 text-center text-xs text-zinc-500">
            No structured spans recorded for this run.
          </p>
        ) : (
          <FlightRecorder
            events={events}
            running={isRunning}
            totals={{
              costUsd: run.costUsd,
              tokensIn: run.tokensIn,
              tokensOut: run.tokensOut,
            }}
          />
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-zinc-500">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
