"use client";

import { useEffect, useRef } from "react";
import {
  Play,
  CheckCircle2,
  XCircle,
  Wrench,
  ArrowRight,
  MessageSquare,
  Cpu,
  Terminal,
} from "lucide-react";
import clsx from "clsx";
import type { StreamEvent } from "@/lib/mock-data";
import { formatDuration, formatCost, formatTokens } from "@/lib/mock-data";
import { JsonViewer } from "@/components/json-viewer";

function EventIcon({ kind }: { kind: StreamEvent["kind"] }) {
  switch (kind) {
    case "step_started":
      return <Play className="h-3.5 w-3.5 text-blue-400" />;
    case "step_completed":
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
    case "step_failed":
      return <XCircle className="h-3.5 w-3.5 text-red-400" />;
    case "tool_call":
      return <Wrench className="h-3.5 w-3.5 text-amber-400" />;
    case "tool_result":
      return <ArrowRight className="h-3.5 w-3.5 text-amber-300" />;
    case "llm_delta":
      return <MessageSquare className="h-3.5 w-3.5 text-purple-400" />;
    case "llm_complete":
      return <Cpu className="h-3.5 w-3.5 text-purple-300" />;
    case "log":
      return <Terminal className="h-3.5 w-3.5 text-zinc-500" />;
    case "end":
      return <CheckCircle2 className="h-3.5 w-3.5 text-lantern-500" />;
    default:
      return <Play className="h-3.5 w-3.5 text-zinc-500" />;
  }
}

function StepStartedEvent({ data }: { data: Record<string, unknown> }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-400">
      <Play className="h-3 w-3" />
      {String(data.name)}
    </span>
  );
}

function StepCompletedEvent({ data }: { data: Record<string, unknown> }) {
  const durationMs = data.durationMs as number;
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {String(data.name)} completed
      </span>
      <span className="text-xs text-zinc-500">{formatDuration(durationMs)}</span>
    </div>
  );
}

function StepFailedEvent({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
        <XCircle className="h-3.5 w-3.5" />
        {String(data.name)} failed
      </span>
      {data.error != null ? (
        <span className="text-xs text-red-300/70">{String(data.error)}</span>
      ) : null}
    </div>
  );
}

function LlmDeltaEvent({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="rounded-lg border border-zinc-800/50 bg-surface-2 p-3">
      <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-300">
        {String(data.text)}
      </pre>
    </div>
  );
}

function LlmCompleteEvent({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded bg-purple-500/10 px-2 py-0.5 text-[11px] font-medium text-purple-400">
        {String(data.model)}
      </span>
      <span className="text-[11px] text-zinc-500">
        {formatTokens(data.tokensIn as number)} in / {formatTokens(data.tokensOut as number)} out
      </span>
      <span className="text-[11px] text-zinc-500">
        {formatCost(data.costUsd as number)}
      </span>
    </div>
  );
}

function ToolCallEvent({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
        <Wrench className="h-3 w-3" />
        {String(data.name)}
      </span>
      <JsonViewer data={data.arguments} label="Arguments" />
    </div>
  );
}

function ToolResultEvent({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="space-y-1">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300">
        <ArrowRight className="h-3 w-3" />
        {String(data.name)} result
      </span>
      <JsonViewer data={data.result} label="Result" />
    </div>
  );
}

function LogEvent({ data }: { data: Record<string, unknown> }) {
  return (
    <span className="font-mono text-xs text-zinc-500">
      [{String(data.level)}] {String(data.message)}
    </span>
  );
}

function EndEvent({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-lantern-500">
        Run {String(data.status)}
      </span>
      <span className="text-[11px] text-zinc-500">
        {formatDuration(data.totalDurationMs as number)}
      </span>
      <span className="text-[11px] text-zinc-500">
        {formatTokens((data.totalTokensIn as number) + (data.totalTokensOut as number))} tokens
      </span>
      <span className="text-[11px] text-zinc-500">
        {formatCost(data.totalCostUsd as number)}
      </span>
    </div>
  );
}

function renderEventContent(event: StreamEvent) {
  switch (event.kind) {
    case "step_started":
      return <StepStartedEvent data={event.data} />;
    case "step_completed":
      return <StepCompletedEvent data={event.data} />;
    case "step_failed":
      return <StepFailedEvent data={event.data} />;
    case "llm_delta":
      return <LlmDeltaEvent data={event.data} />;
    case "llm_complete":
      return <LlmCompleteEvent data={event.data} />;
    case "tool_call":
      return <ToolCallEvent data={event.data} />;
    case "tool_result":
      return <ToolResultEvent data={event.data} />;
    case "log":
      return <LogEvent data={event.data} />;
    case "end":
      return <EndEvent data={event.data} />;
    default:
      return <span className="text-xs text-zinc-500">Unknown event</span>;
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

interface EventStreamProps {
  events: StreamEvent[];
}

export function EventStream({ events }: EventStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  return (
    <div className="space-y-0">
      {events.map((event) => (
        <div
          key={event.seq}
          className={clsx(
            "group relative flex gap-3 py-3 pl-4 pr-3",
            "border-l-2",
            event.kind === "step_started" && "border-l-blue-500/40",
            event.kind === "step_completed" && "border-l-emerald-500/40",
            event.kind === "step_failed" && "border-l-red-500/40",
            event.kind === "llm_delta" && "border-l-purple-500/30",
            event.kind === "llm_complete" && "border-l-purple-500/30",
            event.kind === "tool_call" && "border-l-amber-500/30",
            event.kind === "tool_result" && "border-l-amber-500/30",
            event.kind === "log" && "border-l-zinc-700/30",
            event.kind === "end" && "border-l-lantern-500/40"
          )}
        >
          <div className="mt-0.5 flex flex-shrink-0 items-start">
            <EventIcon kind={event.kind} />
          </div>
          <div className="min-w-0 flex-1">
            {renderEventContent(event)}
          </div>
          <div className="flex-shrink-0">
            <span className="font-mono text-[10px] text-zinc-600">
              {formatTime(event.ts)}
            </span>
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
