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
  RefreshCw,
  Loader2,
  CheckCircle2,
  Play,
  Wifi,
  WifiOff,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useRun } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import {
  getEventsForRun,
  formatCost,
  formatTokens,
  formatDuration,
} from "@/lib/mock-data";
import type { RunStatus, StreamEvent } from "@/lib/mock-data";
import { StatusBadge } from "@/components/status-badge";
import { JsonViewer } from "@/components/json-viewer";
import {
  EventStream,
  EventCountBadge,
  useStreamSimulation,
} from "@/components/event-stream";
import { RunDetailSkeleton } from "@/components/skeleton";

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3 w-3 animate-spin text-blue-400" />;
    case "completed":
      return <CheckCircle2 className="h-3 w-3 text-emerald-400" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return <Play className="h-3 w-3 text-zinc-500" />;
  }
}

function LiveDuration({ startTime }: { startTime: Date }) {
  const [elapsed, setElapsed] = useState(
    Date.now() - startTime.getTime()
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime.getTime());
    }, 100);
    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <span className="font-mono text-sm tabular-nums text-zinc-300">
      {formatDuration(elapsed)}
    </span>
  );
}

function LiveTokenCounter({
  baseTokensIn,
  baseTokensOut,
  baseCost,
  isRunning,
}: {
  baseTokensIn: number;
  baseTokensOut: number;
  baseCost: number;
  isRunning: boolean;
}) {
  const [extra, setExtra] = useState(0);

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      setExtra((prev) => prev + Math.floor(Math.random() * 8 + 2));
    }, 200);
    return () => clearInterval(interval);
  }, [isRunning]);

  const totalIn = baseTokensIn;
  const totalOut = baseTokensOut + (isRunning ? extra : 0);
  const costEstimate = baseCost + extra * 0.000003;

  return (
    <>
      <InfoRow label="Tokens in">
        <span className="font-mono text-xs tabular-nums text-zinc-400">
          {formatTokens(totalIn)}
        </span>
      </InfoRow>
      <InfoRow label="Tokens out">
        <span className="font-mono text-xs tabular-nums text-zinc-400">
          {formatTokens(totalOut)}
        </span>
      </InfoRow>
      <InfoRow label="Total tokens">
        <span className="font-mono text-xs tabular-nums text-zinc-300">
          {formatTokens(totalIn + totalOut)}
        </span>
      </InfoRow>
      <InfoRow label="Estimated cost">
        <span className="font-mono text-sm tabular-nums font-medium text-lantern-500">
          {formatCost(costEstimate)}
        </span>
      </InfoRow>
    </>
  );
}

// Extract steps from visible events for the step timeline
function extractSteps(events: StreamEvent[]) {
  const steps: Array<{
    name: string;
    status: "running" | "completed" | "failed";
    durationMs?: number;
  }> = [];
  const stepMap = new Map<string, number>();

  for (const event of events) {
    if (event.kind === "step_started") {
      const name = String(event.data.name);
      if (!stepMap.has(name)) {
        stepMap.set(name, steps.length);
        steps.push({ name, status: "running" });
      }
    } else if (event.kind === "step_completed") {
      const name = String(event.data.name);
      const idx = stepMap.get(name);
      if (idx !== undefined) {
        steps[idx].status = "completed";
        steps[idx].durationMs = event.data.durationMs as number;
      }
    } else if (event.kind === "step_failed") {
      const name = String(event.data.name);
      const idx = stepMap.get(name);
      if (idx !== undefined) {
        steps[idx].status = "failed";
        steps[idx].durationMs = event.data.durationMs as number | undefined;
      }
    }
  }
  return steps;
}

// Extract model usage from visible events
function extractModelUsage(events: StreamEvent[]) {
  const models = new Map<string, { calls: number; tokensIn: number; tokensOut: number; cost: number }>();
  for (const event of events) {
    if (event.kind === "llm_complete") {
      const model = String(event.data.model);
      const existing = models.get(model) || { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
      existing.calls++;
      existing.tokensIn += (event.data.tokensIn as number) || 0;
      existing.tokensOut += (event.data.tokensOut as number) || 0;
      existing.cost += (event.data.costUsd as number) || 0;
      models.set(model, existing);
    }
  }
  return models;
}

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const id = params.id as string;

  const { run, loading, error, refresh } = useRun(id);

  // Poll for status changes (queued → running → succeeded) every 2 seconds
  useEffect(() => {
    if (!run || run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") return;
    const interval = setInterval(() => refresh(), 2000);
    return () => clearInterval(interval);
  }, [run?.status, refresh]);

  // Get mock events for fallback/demo mode
  const allEvents = run ? getEventsForRun(run.id) : [];

  const isRunning = run?.status === "running" || run?.status === "paused";

  const { visibleEvents, streamingText, isStreaming, isComplete, reset } =
    useStreamSimulation(allEvents, { enabled: !loading && !!run });

  // Also try real SSE streaming for live runs
  const [sseEvents, setSseEvents] = useState<StreamEvent[]>([]);
  const [sseConnected, setSseConnected] = useState(false);

  useEffect(() => {
    if (!run || !isRunning) return;

    // Try SSE in parallel. If it works, it supplements the mock simulation.
    const stream = api.streamRunEvents(id);
    stream.subscribe((event) => {
      setSseConnected(true);
      setSseEvents((prev) => [...prev, event]);
    });

    return () => {
      stream.close();
    };
  }, [id, run, isRunning]);

  // Use SSE events if we have them, otherwise use mock simulation
  const displayEvents = sseConnected ? sseEvents : visibleEvents;
  const displayStreaming = sseConnected ? false : isStreaming;
  const displayStreamingText = sseConnected ? "" : streamingText;

  const [cancelled, setCancelled] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  if (loading) return <RunDetailSkeleton />;

  if (error || !run) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-zinc-400">Run not found in the database.</p>
        <p className="text-xs text-zinc-600 max-w-sm text-center">
          The agent may not exist in the database yet. Create agents via the API or use the Playground to test interactively.
        </p>
        <a
          href="/playground"
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white hover:bg-lantern-400 transition-colors"
        >
          Open Playground
        </a>
      </div>
    );
  }

  const steps = extractSteps(displayEvents);
  const modelUsage = extractModelUsage(displayEvents);

  const createdAt = new Date(run.createdAt);
  const startedAt = run.startedAt ? new Date(run.startedAt) : null;
  const finishedAt = run.finishedAt ? new Date(run.finishedAt) : null;

  const queuedDuration =
    startedAt && createdAt
      ? startedAt.getTime() - createdAt.getTime()
      : null;
  const runningDuration =
    startedAt
      ? (finishedAt ?? new Date()).getTime() - startedAt.getTime()
      : null;
  const totalDuration =
    finishedAt && createdAt
      ? finishedAt.getTime() - createdAt.getTime()
      : null;

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await api.cancelRun(id, "Cancelled from dashboard");
      toast.success("Run cancelled");
      setCancelled(true);
      refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to cancel run",
      );
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
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
            <h1 className="font-mono text-lg font-semibold text-zinc-100">
              {run.id}
            </h1>
            <StatusBadge status={cancelled ? "cancelled" : run.status} />
            {displayStreaming && (
              <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
                <Loader2 className="h-3 w-3 animate-spin text-lantern-400" />
                Streaming
              </span>
            )}
            {sseConnected && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-400" title="Connected to live event stream">
                <Wifi className="h-3 w-3" />
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isComplete && !sseConnected && (
              <button
                onClick={() => reset()}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3"
              >
                <RefreshCw className="h-4 w-4" />
                Replay
              </button>
            )}
            {isRunning && !cancelled && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {cancelling ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
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

      {/* Two-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Event stream */}
        <div className="flex flex-[2] flex-col overflow-hidden border-r border-zinc-800">
          <div className="flex flex-shrink-0 items-center justify-between border-b border-zinc-800/50 bg-surface-1/50 px-6 py-3">
            <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Event Stream
            </h2>
            <EventCountBadge count={displayEvents.length} />
          </div>
          <div className="flex-1 overflow-hidden">
            {displayEvents.length > 0 || displayStreaming ? (
              <EventStream
                events={displayEvents}
                streaming={displayStreaming}
                streamingText={displayStreamingText}
              />
            ) : run.status === "succeeded" && run.output ? (
              <div className="flex h-full flex-col overflow-auto p-6">
                <div className="mb-4">
                  <h3 className="text-sm font-medium text-zinc-300">Agent Output</h3>
                  <div className="mt-1 h-px bg-zinc-800" />
                </div>
                <div className="flex-1">
                  <div className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-surface-2 p-4 font-mono text-sm leading-relaxed text-zinc-200">
                    {typeof run.output === "string"
                      ? run.output
                      : typeof run.output === "object" && run.output !== null && "result" in (run.output as Record<string, unknown>)
                        ? String((run.output as Record<string, unknown>).result)
                        : JSON.stringify(run.output, null, 2)}
                  </div>
                </div>
              </div>
            ) : run.status === "failed" && run.error ? (
              <div className="flex h-full items-center justify-center p-6">
                <div className="w-full max-w-md rounded-lg border border-red-500/20 bg-red-500/5 p-5">
                  <div className="flex items-center gap-2 text-sm font-medium text-red-400">
                    <XCircle className="h-4 w-4" />
                    Run Failed
                  </div>
                  <p className="mt-2 text-sm font-medium text-red-300">
                    {run.error.code}
                  </p>
                  <p className="mt-1 text-sm text-red-300/70">
                    {run.error.message}
                  </p>
                  {run.error.stepId && (
                    <p className="mt-2 font-mono text-xs text-red-300/50">
                      Failed at step: {run.error.stepId}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  {run.status === "queued" ? (
                    <div className="max-w-xs">
                      <Loader2 className="mx-auto h-6 w-6 animate-spin text-zinc-600" />
                      <p className="mt-3 text-sm text-zinc-500">
                        Run is queued. The workflow engine needs to be running to execute agents.
                      </p>
                      <p className="mt-1 text-xs text-zinc-600">
                        For immediate results, use the Playground which calls the LLM directly.
                      </p>
                      <a
                        href="/playground"
                        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-lantern-400 transition-colors"
                      >
                        Open Playground
                      </a>
                    </div>
                  ) : run.status === "running" ? (
                    <>
                      <Loader2 className="mx-auto h-8 w-8 animate-spin text-lantern-500" />
                      <p className="mt-3 text-sm text-zinc-600">
                        Processing...
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-zinc-600">
                      No events available for this run.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Metadata sidebar */}
        <div className="flex w-96 flex-shrink-0 flex-col overflow-auto bg-surface-1/30">
          <div className="space-y-5 p-5">
            {/* Run status with animated indicator */}
            <section>
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
                Run Info
              </h3>
              <dl className="space-y-2.5 text-sm">
                <InfoRow label="Status">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={cancelled ? "cancelled" : run.status} />
                    {isRunning && !cancelled && (
                      <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
                    )}
                  </div>
                </InfoRow>
                <InfoRow label="Agent">
                  <span className="text-zinc-300">{run.agentName}</span>
                </InfoRow>
                <InfoRow label="Run ID">
                  <span className="font-mono text-xs text-zinc-400">
                    {run.id}
                  </span>
                </InfoRow>
                {run.labels?.trigger && (
                  <InfoRow label="Trigger">
                    <span className="rounded bg-surface-3 px-2 py-0.5 text-xs text-zinc-400">
                      {run.labels.trigger}
                    </span>
                  </InfoRow>
                )}
              </dl>
            </section>

            {/* Timing */}
            <section>
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500">
                <Clock className="h-3.5 w-3.5" />
                Timing
              </h3>
              <dl className="space-y-2.5 text-sm">
                <InfoRow label="Created">
                  <span className="text-zinc-400">
                    {format(createdAt, "MMM d, HH:mm:ss.SSS")}
                  </span>
                </InfoRow>
                {startedAt && (
                  <InfoRow label="Started">
                    <span className="text-zinc-400">
                      {format(startedAt, "MMM d, HH:mm:ss.SSS")}
                    </span>
                  </InfoRow>
                )}
                {finishedAt && (
                  <InfoRow label="Finished">
                    <span className="text-zinc-400">
                      {format(finishedAt, "MMM d, HH:mm:ss.SSS")}
                    </span>
                  </InfoRow>
                )}
                {queuedDuration !== null && (
                  <InfoRow label="Queue wait">
                    <span className="text-zinc-400">
                      {formatDuration(queuedDuration)}
                    </span>
                  </InfoRow>
                )}
                {isRunning && !cancelled && startedAt ? (
                  <InfoRow label="Running">
                    <LiveDuration startTime={startedAt} />
                  </InfoRow>
                ) : runningDuration !== null ? (
                  <InfoRow label="Running">
                    <span className="text-zinc-400">
                      {formatDuration(runningDuration)}
                    </span>
                  </InfoRow>
                ) : null}
                {totalDuration !== null && (
                  <InfoRow label="Total">
                    <span className="font-medium text-zinc-300">
                      {formatDuration(totalDuration)}
                    </span>
                  </InfoRow>
                )}
              </dl>
            </section>

            {/* Cost */}
            <section>
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500">
                <Coins className="h-3.5 w-3.5" />
                Cost
              </h3>
              <dl className="space-y-2.5 text-sm">
                <LiveTokenCounter
                  baseTokensIn={run.tokensIn}
                  baseTokensOut={run.tokensOut}
                  baseCost={run.costUsd}
                  isRunning={isRunning && !cancelled && displayStreaming}
                />
              </dl>
            </section>

            {/* Model usage breakdown */}
            {modelUsage.size > 0 && (
              <section>
                <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Model Usage
                </h3>
                <div className="space-y-2">
                  {Array.from(modelUsage.entries()).map(([model, usage]) => (
                    <div
                      key={model}
                      className="rounded-lg border border-zinc-800 bg-surface-2 p-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="rounded bg-purple-500/10 px-2 py-0.5 text-[11px] font-medium text-purple-400">
                          {model}
                        </span>
                        <span className="text-[11px] text-zinc-500">
                          {usage.calls} call{usage.calls !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-zinc-500">
                        <span>{formatTokens(usage.tokensIn)} in</span>
                        <span>{formatTokens(usage.tokensOut)} out</span>
                        <span className="text-lantern-400">{formatCost(usage.cost)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Output — prominent when run succeeded */}
            {run.status === "succeeded" && run.output !== undefined && run.output !== null && (
              <section>
                <h3 className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-emerald-500">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Output
                </h3>
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-200">
                    {typeof run.output === "string"
                      ? run.output
                      : typeof run.output === "object" && run.output !== null && "result" in (run.output as Record<string, unknown>)
                        ? String((run.output as Record<string, unknown>).result)
                        : JSON.stringify(run.output, null, 2)}
                  </pre>
                </div>
              </section>
            )}

            {/* Error — prominent when run failed */}
            {run.status === "failed" && run.error && (
              <section>
                <h3 className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-red-500">
                  <XCircle className="h-3.5 w-3.5" />
                  Error
                </h3>
                <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                  <p className="text-xs font-medium text-red-400">
                    {run.error.code}
                  </p>
                  <p className="mt-1 text-xs text-red-300/70">
                    {run.error.message}
                  </p>
                  {run.error.stepId && (
                    <p className="mt-1 font-mono text-[11px] text-red-300/50">
                      Step: {run.error.stepId}
                    </p>
                  )}
                </div>
              </section>
            )}

            {/* Input / Output details */}
            <section>
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500">
                <Hash className="h-3.5 w-3.5" />
                Input / Output
              </h3>
              <div className="space-y-2">
                <JsonViewer data={run.input} label="Input" defaultOpen />
                {run.output !== undefined && run.output !== null ? (
                  <JsonViewer data={run.output} label="Output (raw)" />
                ) : null}
                {run.error && run.status !== "failed" && (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                    <p className="text-xs font-medium text-red-400">
                      {run.error.code}
                    </p>
                    <p className="mt-1 text-xs text-red-300/70">
                      {run.error.message}
                    </p>
                    {run.error.stepId && (
                      <p className="mt-1 font-mono text-[11px] text-red-300/50">
                        Step: {run.error.stepId}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* Step timeline */}
            {steps.length > 0 && (
              <section>
                <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Step Timeline
                </h3>
                <div className="space-y-1">
                  {steps.map((step, i) => (
                    <div
                      key={`${step.name}-${i}`}
                      className="flex items-center justify-between rounded-lg px-2.5 py-1.5 transition-colors hover:bg-surface-2"
                    >
                      <div className="flex items-center gap-2">
                        <StepIcon status={step.status} />
                        <span
                          className={clsx(
                            "text-xs font-medium",
                            step.status === "completed" && "text-zinc-300",
                            step.status === "running" && "text-blue-400",
                            step.status === "failed" && "text-red-400"
                          )}
                        >
                          {step.name}
                        </span>
                      </div>
                      <span className="text-[11px] text-zinc-500">
                        {step.durationMs != null
                          ? formatDuration(step.durationMs)
                          : step.status === "running"
                            ? "..."
                            : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-zinc-500">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
