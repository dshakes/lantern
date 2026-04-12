"use client";

import { useParams, useRouter } from "next/navigation";
import { format } from "date-fns";
import { ArrowLeft, XCircle, Clock, Zap, Coins, Hash } from "lucide-react";
import {
  getRunById,
  sampleRunEvents,
  formatCost,
  formatTokens,
  formatDuration,
} from "@/lib/mock-data";
import { StatusBadge } from "@/components/status-badge";
import { JsonViewer } from "@/components/json-viewer";
import { EventStream } from "@/components/event-stream";

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const run = getRunById(id);

  if (!run) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-zinc-500">Run not found.</p>
      </div>
    );
  }

  const events = run.id === "run_01hqa1b2c3d4" ? sampleRunEvents : [];

  const queuedDuration =
    run.startedAt && run.createdAt
      ? run.startedAt.getTime() - run.createdAt.getTime()
      : null;
  const runningDuration =
    run.startedAt
      ? (run.finishedAt ?? new Date()).getTime() - run.startedAt.getTime()
      : null;
  const totalDuration =
    run.finishedAt && run.createdAt
      ? run.finishedAt.getTime() - run.createdAt.getTime()
      : null;

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
              {run.id.slice(0, 20)}...
            </h1>
            <StatusBadge status={run.status} />
          </div>
          {run.status === "running" && (
            <button className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10">
              <XCircle className="h-4 w-4" />
              Cancel
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Agent: <span className="text-zinc-400">{run.agentName}</span>
        </p>
      </div>

      {/* Two-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Event stream (2/3) */}
        <div className="flex flex-[2] flex-col overflow-hidden border-r border-zinc-800">
          <div className="flex-shrink-0 border-b border-zinc-800/50 bg-surface-1/50 px-6 py-3">
            <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Event Stream
            </h2>
          </div>
          <div className="flex-1 overflow-auto">
            {events.length > 0 ? (
              <EventStream events={events} />
            ) : (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-zinc-600">
                  {run.status === "queued"
                    ? "Waiting for run to start..."
                    : "No events available for this run."}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right: Metadata sidebar (1/3) */}
        <div className="flex w-96 flex-shrink-0 flex-col overflow-auto bg-surface-1/30">
          <div className="space-y-5 p-5">
            {/* Run info */}
            <section>
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
                Run Info
              </h3>
              <dl className="space-y-2.5 text-sm">
                <InfoRow label="Status">
                  <StatusBadge status={run.status} />
                </InfoRow>
                <InfoRow label="Agent">
                  <span className="text-zinc-300">{run.agentName}</span>
                </InfoRow>
                <InfoRow label="Run ID">
                  <span className="font-mono text-xs text-zinc-400">
                    {run.id}
                  </span>
                </InfoRow>
                {run.labels.trigger && (
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
                    {format(run.createdAt, "MMM d, HH:mm:ss.SSS")}
                  </span>
                </InfoRow>
                {run.startedAt && (
                  <InfoRow label="Started">
                    <span className="text-zinc-400">
                      {format(run.startedAt, "MMM d, HH:mm:ss.SSS")}
                    </span>
                  </InfoRow>
                )}
                {run.finishedAt && (
                  <InfoRow label="Finished">
                    <span className="text-zinc-400">
                      {format(run.finishedAt, "MMM d, HH:mm:ss.SSS")}
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
                {runningDuration !== null && (
                  <InfoRow label="Running">
                    <span className="text-zinc-400">
                      {formatDuration(runningDuration)}
                    </span>
                  </InfoRow>
                )}
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
                <InfoRow label="Tokens in">
                  <span className="font-mono text-xs text-zinc-400">
                    {formatTokens(run.tokensIn)}
                  </span>
                </InfoRow>
                <InfoRow label="Tokens out">
                  <span className="font-mono text-xs text-zinc-400">
                    {formatTokens(run.tokensOut)}
                  </span>
                </InfoRow>
                <InfoRow label="Total tokens">
                  <span className="font-mono text-xs text-zinc-300">
                    {formatTokens(run.tokensIn + run.tokensOut)}
                  </span>
                </InfoRow>
                <InfoRow label="Estimated cost">
                  <span className="font-mono text-sm font-medium text-lantern-500">
                    {formatCost(run.costUsd)}
                  </span>
                </InfoRow>
              </dl>
            </section>

            {/* Input */}
            <section>
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-zinc-500">
                <Hash className="h-3.5 w-3.5" />
                Input / Output
              </h3>
              <div className="space-y-2">
                <JsonViewer data={run.input} label="Input" defaultOpen />
                {run.output !== undefined && run.output !== null ? (
                  <JsonViewer data={run.output} label="Output" />
                ) : null}
                {run.error && (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                    <p className="text-xs font-medium text-red-400">
                      {run.error.code}
                    </p>
                    <p className="mt-1 text-xs text-red-300/70">
                      {run.error.message}
                    </p>
                  </div>
                )}
              </div>
            </section>
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
