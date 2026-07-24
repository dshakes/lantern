"use client";

// Flight Recorder — an opt-in time-travel cockpit wrapping the run waterfall.
//
// When recorderMode=false (default): renders the plain RunWaterfall.
// When recorderMode=true: adds a full cockpit UI:
//
//   1. Stats chips — total events · steps · retries · duration · status
//   2. Scrubber + transport — drag to set T, play/pause at 1×/4×/16×
//   3. As-of readout — cumulative cost/tokens/steps at cursor T
//   4. Signals line — costliest/slowest span + retry loops (click to jump)
//   5. Reasoning replay — step through <thinking> blocks
//   6. Event inspector — kind/step_id/payload of the event at T (collapsed JSON)
//   7. Keyboard: ←/→ step one event, Space play/pause
//   8. Click any span in the waterfall to jump T to its step_started
//
// No new backend endpoints — all derived from the existing /v1/runs/{id}/events
// SSE stream that the calling page already subscribes to.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Brain,
  Coins,
  Timer,
  AlertTriangle,
  X,
  Zap,
  ListChecks,
  RefreshCw,
  Clock,
} from "lucide-react";
import clsx from "clsx";
import type { StreamEvent } from "@/lib/mock-data";
import { formatCost, formatTokens } from "@/lib/mock-data";
import {
  buildTimeline,
  eventAtCursor,
  cursorIndex,
  computeStats,
  type TimelineEvent,
} from "@/lib/flight-recorder";
import { RunWaterfall, extractSpans } from "./run-waterfall";
import {
  type Span,
  groupRetries,
  laneFor,
  reasoningText,
} from "./run-waterfall-lanes";

// ---------------------------------------------------------------------------
// As-of cursor state (cumulative metrics up to T)
// ---------------------------------------------------------------------------

interface CursorState {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  active: number;
  done: number;
}

function stateAsOf(spans: Span[], cursorMs: number, scaleEnd: number): CursorState {
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let active = 0;
  let done = 0;
  for (const s of spans) {
    const end = s.endMs ?? scaleEnd;
    if (s.startMs > cursorMs) continue;
    if (end <= cursorMs) {
      done += 1;
      costUsd += s.costUsd;
      tokensIn += s.tokensIn;
      tokensOut += s.tokensOut;
    } else {
      active += 1;
    }
  }
  return { costUsd, tokensIn, tokensOut, active, done };
}

// ---------------------------------------------------------------------------
// Signals — most-expensive, slowest, retry loops
// ---------------------------------------------------------------------------

interface Signals {
  costliest?: { span: Span; costUsd: number };
  slowest?: { span: Span; durationMs: number };
  loops: { span: Span; count: number }[];
}

function computeSignals(spans: Span[], scaleEnd: number): Signals {
  let costliest: Signals["costliest"];
  let slowest: Signals["slowest"];
  const loops: Signals["loops"] = [];
  for (const s of spans) {
    if (s.costUsd > 0 && (!costliest || s.costUsd > costliest.costUsd)) {
      costliest = { span: s, costUsd: s.costUsd };
    }
    const dur = (s.endMs ?? scaleEnd) - s.startMs;
    if (!slowest || dur > slowest.durationMs) {
      slowest = { span: s, durationMs: dur };
    }
    const retries = s.retries?.length ?? 0;
    if (retries > 0) loops.push({ span: s, count: retries + 1 });
  }
  return { costliest, slowest, loops };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${m}m ${sec}s`;
}

// ---------------------------------------------------------------------------
// Playback speed options — wall-clock compressed sweep duration
// ---------------------------------------------------------------------------

const SPEED_OPTIONS = [1, 4, 16] as const;
type Speed = (typeof SPEED_OPTIONS)[number];
// At 1×: a full sweep takes BASE_PLAY_MS; 4× = 4× faster, etc.
const BASE_PLAY_MS = 8000;

// ---------------------------------------------------------------------------
// Status chip color map
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  succeeded: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-red-500/15 text-red-400",
  cancelled: "bg-zinc-700/60 text-zinc-400",
  running: "bg-lantern-500/15 text-lantern-300",
  paused: "bg-amber-500/15 text-amber-300",
  queued: "bg-zinc-700/60 text-zinc-400",
  waiting: "bg-amber-500/15 text-amber-300",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FlightRecorder({
  events,
  running,
  totals,
  recorderMode = false,
  status,
}: {
  events: StreamEvent[];
  running?: boolean;
  totals?: { costUsd?: number; tokensIn?: number; tokensOut?: number };
  /** Gates the full cockpit chrome. false = plain waterfall. */
  recorderMode?: boolean;
  /** Run terminal status for the stats chip. */
  status?: string;
}) {
  // ---- Derived models ----
  const timeline = useMemo(() => buildTimeline(events), [events]);
  const stats = useMemo(() => computeStats(timeline), [timeline]);

  const { spans: rawSpans, endMs } = useMemo(
    () => extractSpans(events),
    [events],
  );
  const scaleEnd = Math.max(endMs, 1);
  const spans = useMemo(() => groupRetries(rawSpans), [rawSpans]);
  const signals = useMemo(
    () => computeSignals(spans, scaleEnd),
    [spans, scaleEnd],
  );

  // Reasoning spans with replayable text, time-ordered.
  const reasoningSpans = useMemo(
    () =>
      [...spans]
        .filter((s) => laneFor(s) === "reasoning" && reasoningText(s))
        .sort((a, b) => a.startMs - b.startMs),
    [spans],
  );

  // ---- Transport state ----
  const [speed, setSpeed] = useState<Speed>(1);
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [highlightSpanId, setHighlightSpanId] = useState<string | null>(null);

  // Reasoning replay
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayIdx, setReplayIdx] = useState(0);

  const rafRef = useRef<number | null>(null);

  // ---- Derived cursor values ----
  const engaged = cursorMs != null;
  const asOf = engaged ? stateAsOf(spans, cursorMs!, scaleEnd) : null;

  const inspectedEvent: TimelineEvent | null = useMemo(
    () =>
      recorderMode && engaged ? eventAtCursor(timeline, cursorMs!) : null,
    [recorderMode, engaged, cursorMs, timeline],
  );

  // ---- Helpers ----
  const engage = (ms: number, spotlight?: string | null) => {
    setPlaying(false);
    setCursorMs(Math.max(0, Math.min(ms, scaleEnd)));
    if (spotlight !== undefined) setHighlightSpanId(spotlight ?? null);
  };

  const reset = () => {
    setPlaying(false);
    setCursorMs(null);
    setHighlightSpanId(null);
  };

  const togglePlay = () => {
    if (!playing && (cursorMs == null || cursorMs >= scaleEnd)) {
      setCursorMs(0);
    }
    setPlaying((p) => !p);
  };

  const gotoReplay = (idx: number) => {
    const clamped = Math.max(0, Math.min(idx, reasoningSpans.length - 1));
    setReplayIdx(clamped);
    const span = reasoningSpans[clamped];
    if (span) engage(span.startMs + 1, span.id);
  };

  // ---- Playback loop (speed-aware) ----
  useEffect(() => {
    if (!playing) return;
    const from = cursorMs ?? 0;
    const startWall = performance.now();
    const remaining = Math.max(scaleEnd - from, 1);
    const dur = (remaining / scaleEnd) * (BASE_PLAY_MS / speed);

    const tick = (now: number) => {
      const t = Math.min((now - startWall) / dur, 1);
      const next = from + t * (scaleEnd - from);
      setCursorMs(next);
      if (t >= 1) {
        setPlaying(false);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, scaleEnd, speed]);

  // ---- Keyboard navigation (only in recorder mode) ----
  // Use refs so the handler always reads the latest values without re-binding.
  const cursorMsRef = useRef(cursorMs);
  cursorMsRef.current = cursorMs;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const scaleEndRef = useRef(scaleEnd);
  scaleEndRef.current = scaleEnd;

  useEffect(() => {
    if (!recorderMode) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return;

      if (e.code === "Space") {
        e.preventDefault();
        const cur = cursorMsRef.current;
        const scale = scaleEndRef.current;
        setPlaying((p) => {
          if (!p && (cur == null || cur >= scale)) setCursorMs(0);
          return !p;
        });
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        const tl = timelineRef.current;
        const cur = cursorMsRef.current;
        if (tl.length === 0) return;
        if (cur == null) {
          // Not engaged → jump to last event
          setCursorMs(tl[tl.length - 1].relativeMs);
          return;
        }
        const idx = cursorIndex(tl, cur);
        setCursorMs(tl[Math.max(0, idx - 1)].relativeMs);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        const tl = timelineRef.current;
        const cur = cursorMsRef.current;
        if (tl.length === 0) return;
        if (cur == null) {
          // Not engaged → start from first event
          setCursorMs(tl[0].relativeMs);
          return;
        }
        const idx = cursorIndex(tl, cur);
        setCursorMs(tl[Math.min(tl.length - 1, idx + 1)].relativeMs);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [recorderMode]);

  // ---- Graceful fallback: not in recorder mode, or no spans → waterfall only ----
  if (!recorderMode || spans.length === 0) {
    return (
      <RunWaterfall events={events} running={running} totals={totals} />
    );
  }

  return (
    <div className="space-y-2.5">
      {/* ---- Stats chips ---- */}
      <div className="flex flex-wrap items-center gap-1.5">
        <StatChip
          icon={<Zap className="h-3 w-3" />}
          label={`${stats.totalEvents} events`}
        />
        <StatChip
          icon={<ListChecks className="h-3 w-3" />}
          label={`${stats.steps} step${stats.steps !== 1 ? "s" : ""}`}
        />
        {stats.retries > 0 && (
          <StatChip
            icon={<RefreshCw className="h-3 w-3 text-amber-400/70" />}
            label={`${stats.retries} retr${stats.retries !== 1 ? "ies" : "y"}`}
            className="text-amber-300/80"
          />
        )}
        <StatChip
          icon={<Clock className="h-3 w-3" />}
          label={fmtMs(stats.durationMs)}
        />
        {status && (
          <span
            className={clsx(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
              STATUS_COLORS[status] ?? "bg-zinc-700/60 text-zinc-400",
            )}
          >
            {status}
          </span>
        )}
        <span className="ml-auto text-[10px] text-zinc-600">
          ←/→ step · Space play
        </span>
      </div>

      {/* ---- Control strip: scrubber + transport + speed + as-of readout ---- */}
      <div className="rounded-xl bg-surface-1">
        <div className="flex items-center gap-2 px-4 py-3">
          {/* Play/Pause */}
          <button
            type="button"
            onClick={togglePlay}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-zinc-300 transition-colors hover:bg-surface-3 hover:text-zinc-100"
            aria-label={playing ? "Pause replay" : "Play replay"}
          >
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>

          {/* Speed selector */}
          <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
            {SPEED_OPTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                className={clsx(
                  "rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums transition-colors",
                  speed === s
                    ? "bg-lantern-600/70 text-lantern-100"
                    : "text-zinc-500 hover:text-zinc-300",
                )}
                aria-label={`${s}× speed`}
              >
                {s}×
              </button>
            ))}
          </div>

          {/* Scrubber */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <input
              type="range"
              min={0}
              max={scaleEnd}
              step={Math.max(scaleEnd / 1000, 1)}
              value={cursorMs ?? scaleEnd}
              onChange={(e) => engage(Number(e.target.value))}
              aria-label="Time cursor"
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-3 accent-lantern-500"
            />
          </div>

          {/* As-of readout or idle hint */}
          {engaged && asOf ? (
            <div className="flex shrink-0 items-center gap-3 text-[12px] tabular-nums text-zinc-400">
              <span className="font-mono text-[11px] font-medium text-lantern-300">
                T+{fmtMs(cursorMs!)}
              </span>
              <span title="Cumulative cost as of T" className="text-zinc-300">
                {formatCost(asOf.costUsd)}
              </span>
              <span title="Cumulative tokens in→out as of T">
                {formatTokens(asOf.tokensIn)}→{formatTokens(asOf.tokensOut)}
              </span>
              <span
                title="Steps in-flight at T / steps completed by T"
                className={clsx(
                  "inline-flex items-center gap-1.5",
                  asOf.active > 0 ? "text-zinc-300" : "text-zinc-500",
                )}
              >
                {asOf.active > 0 && (
                  <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500/80" />
                )}
                {asOf.active} active · {asOf.done} done
              </span>
              <button
                type="button"
                onClick={reset}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-surface-2 hover:text-zinc-300"
              >
                <RotateCcw className="h-3 w-3" /> live
              </button>
            </div>
          ) : (
            <span className="shrink-0 text-[11px] text-zinc-600">
              drag to time-travel · ▶ to replay
            </span>
          )}
        </div>

        {/* ---- Signals line ---- */}
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800/40 px-4 py-2.5 text-[11px]">
          <span className="text-[9px] font-medium uppercase tracking-wide text-zinc-500">
            Signals
          </span>
          {signals.costliest && (
            <SignalChip
              icon={<Coins className="h-3 w-3" />}
              tone="amber"
              label={`Costliest: ${signals.costliest.span.name}`}
              value={formatCost(signals.costliest.costUsd)}
              onClick={() =>
                engage(signals.costliest!.span.startMs + 1, signals.costliest!.span.id)
              }
            />
          )}
          {signals.slowest && (
            <SignalChip
              icon={<Timer className="h-3 w-3" />}
              tone="sky"
              label={`Slowest: ${signals.slowest.span.name}`}
              value={fmtMs(signals.slowest.durationMs)}
              onClick={() =>
                engage(signals.slowest!.span.startMs + 1, signals.slowest!.span.id)
              }
            />
          )}
          {signals.loops.map((loop) => (
            <SignalChip
              key={loop.span.id}
              icon={<AlertTriangle className="h-3 w-3" />}
              tone="rose"
              label={`Retry loop: ${loop.span.name}`}
              value={`×${loop.count}`}
              onClick={() => engage(loop.span.startMs + 1, loop.span.id)}
            />
          ))}
          {!signals.costliest && !signals.slowest && signals.loops.length === 0 && (
            <span className="text-zinc-600">no notable signals</span>
          )}

          {/* Reasoning replay toggle */}
          {reasoningSpans.length > 0 && (
            <button
              type="button"
              onClick={() => {
                const next = !replayOpen;
                setReplayOpen(next);
                if (next) gotoReplay(replayIdx);
                else reset();
              }}
              className={clsx(
                "ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                replayOpen
                  ? "bg-surface-3 text-zinc-200"
                  : "bg-surface-2 text-zinc-400 hover:bg-surface-3 hover:text-zinc-200",
              )}
            >
              <Brain
                className={clsx(
                  "h-3 w-3",
                  replayOpen ? "text-lantern-300" : "text-zinc-500",
                )}
              />
              Replay reasoning
              <span className="tabular-nums text-zinc-500">
                ({reasoningSpans.length})
              </span>
            </button>
          )}
        </div>

        {/* ---- Reasoning replay panel ---- */}
        {replayOpen && reasoningSpans.length > 0 && (
          <ReasoningReplay
            spans={reasoningSpans}
            idx={replayIdx}
            onPrev={() => gotoReplay(replayIdx - 1)}
            onNext={() => gotoReplay(replayIdx + 1)}
            onClose={() => {
              setReplayOpen(false);
              reset();
            }}
          />
        )}

        {/* ---- Event inspector (shown when cursor is engaged) ---- */}
        {engaged && inspectedEvent && (
          <EventInspector event={inspectedEvent} cursorMs={cursorMs!} />
        )}
      </div>

      {/* ---- The trace waterfall ---- */}
      <RunWaterfall
        events={events}
        running={running}
        totals={totals}
        timeCursorMs={cursorMs}
        highlightSpanId={highlightSpanId}
        onSpanClick={(spanId, startMs) => engage(startMs, spanId)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatChip — a compact info pill used in the stats chips row
// ---------------------------------------------------------------------------

function StatChip({
  icon,
  label,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-zinc-400",
        className,
      )}
    >
      <span className="text-zinc-500">{icon}</span>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SignalChip
// ---------------------------------------------------------------------------

const TONES = {
  amber: "text-amber-400/70",
  sky: "text-sky-400/70",
  rose: "text-rose-400/70",
} as const;

function SignalChip({
  icon,
  tone,
  label,
  value,
  onClick,
}: {
  icon: React.ReactNode;
  tone: keyof typeof TONES;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label} — click to jump the cursor here`}
      className="flex max-w-[14rem] items-center gap-1.5 rounded-md bg-surface-2 px-2 py-0.5 text-zinc-400 transition-colors hover:bg-surface-3 hover:text-zinc-200"
    >
      <span className={clsx("shrink-0", TONES[tone])}>{icon}</span>
      <span className="truncate">{label}</span>
      <span className="shrink-0 font-mono tabular-nums text-zinc-500">{value}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// EventInspector — shows the event at the cursor T
// ---------------------------------------------------------------------------

// Kind → badge color
const KIND_COLORS: Record<string, string> = {
  step_started: "bg-lantern-500/15 text-lantern-300",
  step_completed: "bg-emerald-500/15 text-emerald-300",
  step_failed: "bg-red-500/15 text-red-400",
  step_retrying: "bg-amber-500/15 text-amber-300",
  step_waiting: "bg-amber-500/15 text-amber-300",
  llm_delta: "bg-violet-500/15 text-violet-300",
  llm_complete: "bg-violet-500/15 text-violet-300",
  tool_call: "bg-sky-500/15 text-sky-300",
  tool_result: "bg-sky-500/15 text-sky-300",
  confidence_evaluated: "bg-pink-500/15 text-pink-300",
  log: "bg-zinc-700/60 text-zinc-400",
  end: "bg-zinc-700/60 text-zinc-400",
};

function EventInspector({
  event,
  cursorMs,
}: {
  event: TimelineEvent;
  cursorMs: number;
}) {
  const [payloadOpen, setPayloadOpen] = useState(false);
  const kindColor =
    KIND_COLORS[event.kind] ?? "bg-zinc-700/60 text-zinc-400";

  return (
    <div className="border-t border-zinc-800/40 bg-surface-0/40 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[9px] font-medium uppercase tracking-wide text-zinc-500">
          Event at T+{fmtMs(cursorMs)}
        </span>
        <span
          className={clsx(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold",
            kindColor,
          )}
        >
          {event.kind}
        </span>
        <span className="text-[10px] tabular-nums text-zinc-600">
          seq {event.seq}
        </span>
        {event.stepId && (
          <span className="font-mono text-[10px] text-zinc-500">
            {event.stepId}
          </span>
        )}
      </div>

      {/* Payload (pretty JSON, collapsed by default) */}
      <div className="rounded-lg border border-zinc-800 bg-surface-2">
        <button
          type="button"
          onClick={() => setPayloadOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
        >
          {payloadOpen ? (
            <ChevronLeft className="h-3 w-3 rotate-90" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          payload
          {!payloadOpen && (
            <span className="ml-1 truncate font-mono text-[10px] text-zinc-600">
              {Object.keys(event.data).slice(0, 4).join(", ")}
              {Object.keys(event.data).length > 4 ? " …" : ""}
            </span>
          )}
        </button>
        {payloadOpen && (
          <div className="border-t border-zinc-800 px-3 py-2">
            <pre className="max-h-48 overflow-auto font-mono text-[11px] leading-relaxed text-zinc-300">
              {JSON.stringify(event.data, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReasoningReplay panel
// ---------------------------------------------------------------------------

function ReasoningReplay({
  spans,
  idx,
  onPrev,
  onNext,
  onClose,
}: {
  spans: Span[];
  idx: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const span = spans[idx];
  const text = span ? reasoningText(span) : null;
  return (
    <div className="border-t border-zinc-800/40 bg-surface-0/40 px-4 py-3.5">
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="h-3.5 w-3.5 text-lantern-300" />
          <span className="text-[12px] font-medium text-zinc-200">
            Reasoning replay
          </span>
          <span className="text-[11px] tabular-nums text-zinc-500">
            {idx + 1} / {spans.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPrev}
            disabled={idx === 0}
            className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-2 text-zinc-300 transition-colors hover:bg-surface-3 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Previous reasoning block"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={idx >= spans.length - 1}
            className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-2 text-zinc-300 transition-colors hover:bg-surface-3 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Next reasoning block"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-1 flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-surface-2 hover:text-zinc-300"
            aria-label="Close reasoning replay"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <p className="mb-1.5 truncate text-[11px] font-medium text-zinc-500">
        {span?.name}
      </p>
      <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-zinc-300">
        {text ?? "No reasoning text recorded for this block."}
      </p>
    </div>
  );
}
