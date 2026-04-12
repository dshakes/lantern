"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Play,
  CheckCircle2,
  XCircle,
  Wrench,
  ArrowRight,
  MessageSquare,
  Cpu,
  Terminal,
  AlertTriangle,
  HelpCircle,
  ChevronDown,
  Loader2,
  ArrowDown,
} from "lucide-react";
import clsx from "clsx";
import type { StreamEvent } from "@/lib/mock-data";
import { formatDuration, formatCost, formatTokens } from "@/lib/mock-data";
import { JsonViewer } from "@/components/json-viewer";

// --- Stream simulation hook ---

interface UseStreamSimulationOptions {
  enabled?: boolean;
  onComplete?: () => void;
}

export function useStreamSimulation(
  events: StreamEvent[],
  options: UseStreamSimulationOptions = {}
) {
  const { enabled = true, onComplete } = options;
  const [visibleEvents, setVisibleEvents] = useState<StreamEvent[]>([]);
  const [streamingText, setStreamingText] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const cancelRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const reset = useCallback(() => {
    cancelRef.current = true;
    setVisibleEvents([]);
    setStreamingText("");
    setIsStreaming(false);
    setIsComplete(false);
  }, []);

  useEffect(() => {
    if (!enabled || events.length === 0) return;

    cancelRef.current = false;
    setVisibleEvents([]);
    setStreamingText("");
    setIsStreaming(true);
    setIsComplete(false);

    let cancelled = false;
    cancelRef.current = false;

    async function stream() {
      for (let i = 0; i < events.length; i++) {
        if (cancelled || cancelRef.current) return;

        const event = events[i];

        // Delay based on event type
        switch (event.kind) {
          case "step_started":
            await delay(80);
            break;
          case "step_completed":
          case "step_failed":
            await delay(120);
            break;
          case "log":
            await delay(100);
            break;
          case "tool_call":
            await delay(250);
            break;
          case "tool_result":
            await delay(400);
            break;
          case "llm_complete":
            await delay(150);
            break;
          case "approval":
          case "question":
            await delay(200);
            break;
          case "end":
            await delay(300);
            break;
          case "llm_delta": {
            // Stream text character by character
            const text = String(event.data.text || "");
            const chunkSize = 3;
            for (let c = 0; c < text.length; c += chunkSize) {
              if (cancelled || cancelRef.current) return;
              const partial = text.slice(0, c + chunkSize);
              setStreamingText(partial);
              await delay(12 + Math.random() * 18);
            }
            setStreamingText("");
            // Add the full event
            setVisibleEvents((prev) => [...prev, event]);
            continue; // skip the default add below
          }
          default:
            await delay(100);
        }

        if (cancelled || cancelRef.current) return;
        setVisibleEvents((prev) => [...prev, event]);
      }

      setIsStreaming(false);
      setIsComplete(true);
      onCompleteRef.current?.();
    }

    stream();

    return () => {
      cancelled = true;
    };
  }, [events, enabled]);

  return { visibleEvents, streamingText, isStreaming, isComplete, reset };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Event rendering components ---

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
    case "approval":
      return <AlertTriangle className="h-3.5 w-3.5 text-yellow-400" />;
    case "question":
      return <HelpCircle className="h-3.5 w-3.5 text-blue-300" />;
    case "end":
      return <CheckCircle2 className="h-3.5 w-3.5 text-lantern-500" />;
    default:
      return <Play className="h-3.5 w-3.5 text-zinc-500" />;
  }
}

function StepStartedEvent({ data }: { data: Record<string, unknown> }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-400">
      <Loader2 className="h-3 w-3 animate-spin" />
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
  const [showStack, setShowStack] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
          <XCircle className="h-3.5 w-3.5" />
          {String(data.name)} failed
        </span>
        {data.durationMs != null && (
          <span className="text-xs text-zinc-500">{formatDuration(data.durationMs as number)}</span>
        )}
      </div>
      {data.error != null && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
          <p className="text-xs font-medium text-red-400">{String(data.error)}</p>
          {data.stackTrace != null && (
            <>
              <button
                onClick={() => setShowStack(!showStack)}
                className="mt-2 flex items-center gap-1 text-[11px] text-red-300/60 transition-colors hover:text-red-300"
              >
                <ChevronDown
                  className={clsx(
                    "h-3 w-3 transition-transform",
                    showStack && "rotate-180"
                  )}
                />
                {showStack ? "Hide" : "Show"} stack trace
              </button>
              {showStack && (
                <pre className="mt-2 overflow-x-auto rounded bg-red-950/30 p-2 font-mono text-[11px] leading-relaxed text-red-300/70">
                  {String(data.stackTrace)}
                </pre>
              )}
            </>
          )}
        </div>
      )}
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

function StreamingTextBlock({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-purple-500/20 bg-surface-2 p-3">
      <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-300">
        {text}
        <span className="inline-block h-4 w-0.5 animate-pulse bg-purple-400 align-middle" />
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
  const level = String(data.level);
  return (
    <div className="flex items-start gap-2">
      <span
        className={clsx(
          "mt-px rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
          level === "info" && "bg-zinc-700/50 text-zinc-400",
          level === "warn" && "bg-yellow-500/10 text-yellow-400",
          level === "error" && "bg-red-500/10 text-red-400"
        )}
      >
        {level}
      </span>
      <span className="font-mono text-xs text-zinc-500">{String(data.message)}</span>
    </div>
  );
}

function ApprovalEvent({
  data,
  onApprove,
  onDeny,
}: {
  data: Record<string, unknown>;
  onApprove?: () => void;
  onDeny?: () => void;
}) {
  const [responded, setResponded] = useState<string | null>(null);
  const options = (data.options as string[]) || ["Approve", "Deny"];

  return (
    <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-yellow-400" />
        <div className="flex-1">
          <p className="text-sm text-yellow-200">{String(data.message)}</p>
          {responded ? (
            <div className="mt-3">
              <span
                className={clsx(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium",
                  responded.toLowerCase().includes("deny")
                    ? "bg-red-500/10 text-red-400"
                    : "bg-emerald-500/10 text-emerald-400"
                )}
              >
                {responded.toLowerCase().includes("deny") ? (
                  <XCircle className="h-3 w-3" />
                ) : (
                  <CheckCircle2 className="h-3 w-3" />
                )}
                {responded}
              </span>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              {options.map((opt) => {
                const isDeny = opt.toLowerCase().includes("deny");
                return (
                  <button
                    key={opt}
                    onClick={() => {
                      setResponded(opt);
                      if (isDeny) onDeny?.();
                      else onApprove?.();
                    }}
                    className={clsx(
                      "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                      isDeny
                        ? "border border-red-500/30 text-red-400 hover:bg-red-500/10"
                        : "bg-lantern-600 text-white hover:bg-lantern-500"
                    )}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function QuestionEvent({ data }: { data: Record<string, unknown> }) {
  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);

  return (
    <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4">
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-400" />
        <div className="flex-1">
          <p className="text-sm text-blue-200">{String(data.question)}</p>
          {submitted ? (
            <div className="mt-2 rounded bg-surface-2 px-3 py-2">
              <p className="font-mono text-xs text-zinc-300">{answer}</p>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Type your answer..."
                className="h-8 flex-1 rounded-lg border border-zinc-700 bg-surface-2 px-3 text-xs text-zinc-300 placeholder:text-zinc-600 focus:border-lantern-500/50 focus:outline-none"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && answer.trim()) setSubmitted(true);
                }}
              />
              <button
                onClick={() => answer.trim() && setSubmitted(true)}
                className="rounded-lg bg-lantern-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-lantern-500"
              >
                Submit
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EndEvent({ data }: { data: Record<string, unknown> }) {
  const status = String(data.status);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span
        className={clsx(
          "inline-flex items-center gap-1.5 text-xs font-medium",
          status === "succeeded" && "text-lantern-500",
          status === "failed" && "text-red-400"
        )}
      >
        {status === "failed" ? (
          <XCircle className="h-3.5 w-3.5" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5" />
        )}
        Run {status}
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
    case "approval":
      return <ApprovalEvent data={event.data} />;
    case "question":
      return <QuestionEvent data={event.data} />;
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

function getBorderColor(kind: StreamEvent["kind"]): string {
  switch (kind) {
    case "step_started":
      return "border-l-blue-500/40";
    case "step_completed":
      return "border-l-emerald-500/40";
    case "step_failed":
      return "border-l-red-500/40";
    case "llm_delta":
    case "llm_complete":
      return "border-l-purple-500/30";
    case "tool_call":
    case "tool_result":
      return "border-l-amber-500/30";
    case "log":
      return "border-l-zinc-700/30";
    case "approval":
      return "border-l-yellow-500/40";
    case "question":
      return "border-l-blue-400/40";
    case "end":
      return "border-l-lantern-500/40";
    default:
      return "border-l-zinc-700/30";
  }
}

// --- Main component ---

interface EventStreamProps {
  events: StreamEvent[];
  streaming?: boolean;
  streamingText?: string;
}

export function EventStream({
  events,
  streaming = false,
  streamingText = "",
}: EventStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Auto-scroll when new events arrive
  useEffect(() => {
    if (isAutoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [events, streamingText, isAutoScroll]);

  // Detect when user scrolls away from bottom
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setIsAutoScroll(atBottom);
    setShowScrollButton(!atBottom && streaming);
  }, [streaming]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setIsAutoScroll(true);
    setShowScrollButton(false);
  }, []);

  return (
    <div className="relative h-full">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-auto"
      >
        <div className="space-y-0">
          {events.map((event, idx) => (
            <div
              key={`${event.seq}-${idx}`}
              className={clsx(
                "group relative flex gap-3 py-3 pl-4 pr-3",
                "border-l-2 transition-opacity duration-200",
                getBorderColor(event.kind)
              )}
            >
              <div className="mt-0.5 flex flex-shrink-0 items-start">
                <EventIcon kind={event.kind} />
              </div>
              <div className="min-w-0 flex-1">{renderEventContent(event)}</div>
              <div className="flex-shrink-0">
                <span className="font-mono text-[10px] text-zinc-600">
                  {formatTime(event.ts)}
                </span>
              </div>
            </div>
          ))}

          {/* Currently streaming text */}
          {streaming && streamingText && (
            <div
              className={clsx(
                "group relative flex gap-3 py-3 pl-4 pr-3",
                "border-l-2 border-l-purple-500/30"
              )}
            >
              <div className="mt-0.5 flex flex-shrink-0 items-start">
                <MessageSquare className="h-3.5 w-3.5 text-purple-400" />
              </div>
              <div className="min-w-0 flex-1">
                <StreamingTextBlock text={streamingText} />
              </div>
              <div className="flex-shrink-0">
                <span className="font-mono text-[10px] text-zinc-600">now</span>
              </div>
            </div>
          )}

          {/* Streaming indicator */}
          {streaming && !streamingText && (
            <div className="flex items-center gap-2 px-4 py-3">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-lantern-400" />
              <span className="text-xs text-zinc-500">Processing...</span>
            </div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* Scroll to bottom FAB */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 flex h-8 w-8 items-center justify-center rounded-full bg-surface-3 shadow-lg transition-colors hover:bg-surface-4"
        >
          <ArrowDown className="h-4 w-4 text-zinc-300" />
        </button>
      )}
    </div>
  );
}

// --- Event count badge ---

export function EventCountBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
      {count} events
    </span>
  );
}
