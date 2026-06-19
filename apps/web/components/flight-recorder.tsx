"use client";

// Agent Flight Recorder — a time-travel cockpit wrapped around the existing
// run waterfall. It adds three things, all derived from the SAME span model
// the waterfall draws (extractSpans):
//
//   1. A slim time-travel scrubber. Dragging sets a cursor T (ms from the
//      run's first event); the waterfall dims future spans + highlights what
//      was in-flight at T, and a compact readout shows cumulative cost /
//      tokens / active-step count "as of T". Play/pause sweeps the cursor.
//
//   2. An inline signals line — the single most-expensive step (💰), any
//      retry loop (⚠ + count, reusing the lanes' retry folding), and the
//      slowest step (latency). Click a signal to jump T onto that span and
//      spotlight it. One tight line, not a dashboard.
//
//   3. Reasoning replay (progressive disclosure, collapsed by default) —
//      prev/next through the Reasoning-lane blocks in order, showing each
//      block's text, with the matching span spotlighted in the trace.
//
// The whole thing hides gracefully when a run has no structured spans: it
// falls straight through to the plain <RunWaterfall> with no extra chrome.

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
} from "lucide-react";
import clsx from "clsx";
import type { StreamEvent } from "@/lib/mock-data";
import { formatCost, formatTokens } from "@/lib/mock-data";
import { RunWaterfall, extractSpans } from "./run-waterfall";
import {
  type Span,
  groupRetries,
  laneFor,
  reasoningText,
} from "./run-waterfall-lanes";

// ---------------------------------------------------------------------------
// Derived "as of T" state — the heart of the time-travel readout. Walk the
// retry-grouped spans and accumulate only what had happened by T:
//   - cost / tokens: summed from spans that had FINISHED by T (a span's
//     cost/tokens are known only once it completes).
//   - active: spans that had started but not yet finished at T.
//   - done: spans finished by T.
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
    if (s.startMs > cursorMs) continue; // not started yet
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
// Signals — most-expensive, slowest, and retry loops over the grouped spans.
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
// Component
// ---------------------------------------------------------------------------

const PLAY_DURATION_MS = 6000; // a full sweep of the run takes ~6s

export function FlightRecorder({
  events,
  running,
  totals,
}: {
  events: StreamEvent[];
  running?: boolean;
  totals?: { costUsd?: number; tokensIn?: number; tokensOut?: number };
}) {
  // Same span model the waterfall draws, so the cursor + signals line up
  // 1:1 with the bars on screen.
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

  // Reasoning-lane spans that actually carry replayable text, in time order.
  const reasoningSpans = useMemo(
    () =>
      [...spans]
        .filter((s) => laneFor(s) === "reasoning" && reasoningText(s))
        .sort((a, b) => a.startMs - b.startMs),
    [spans],
  );

  // null cursor = full-trace view (no time travel). Setting it engages the
  // flight recorder.
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [highlightSpanId, setHighlightSpanId] = useState<string | null>(null);

  // Reasoning replay (progressive disclosure).
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayIdx, setReplayIdx] = useState(0);

  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);

  // Playback loop — sweep the cursor 0 → scaleEnd over PLAY_DURATION_MS.
  useEffect(() => {
    if (!playing) return;
    const from = cursorMs ?? 0;
    const startWall = performance.now();
    startRef.current = startWall;
    const remaining = Math.max(scaleEnd - from, 1);
    const dur = (remaining / scaleEnd) * PLAY_DURATION_MS;

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
  }, [playing, scaleEnd]);

  // Graceful hide: no structured spans → just the plain waterfall (which
  // renders its own "no spans yet" empty state). No flight-recorder chrome.
  if (spans.length === 0) {
    return <RunWaterfall events={events} running={running} totals={totals} />;
  }

  const engaged = cursorMs != null;
  const asOf = engaged ? stateAsOf(spans, cursorMs!, scaleEnd) : null;

  const engage = (ms: number, spotlight?: string | null) => {
    setPlaying(false);
    setCursorMs(Math.max(0, Math.min(ms, scaleEnd)));
    setHighlightSpanId(spotlight ?? null);
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

  return (
    <div className="space-y-2.5">
      {/* ---- Control strip: scrubber + transport + as-of readout ---- */}
      <div className="rounded-xl bg-surface-1">
        <div className="flex items-center gap-3 px-4 py-3">
          {/* Transport */}
          <button
            type="button"
            onClick={togglePlay}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-zinc-300 transition-colors hover:bg-surface-3 hover:text-zinc-100"
            aria-label={playing ? "Pause replay" : "Play replay"}
          >
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>

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

          {/* As-of readout (or hint when idle) */}
          {engaged && asOf ? (
            <div className="flex shrink-0 items-center gap-3 text-[11px] tabular-nums text-zinc-400">
              <span className="font-mono text-[10px] font-medium text-lantern-300">
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
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-zinc-500 transition-colors hover:bg-surface-2 hover:text-zinc-300"
              >
                <RotateCcw className="h-3 w-3" /> live
              </button>
            </div>
          ) : (
            <span className="shrink-0 text-[10px] text-zinc-600">
              drag to time-travel · ▶ to replay
            </span>
          )}
        </div>

        {/* ---- Signals line — subtle, one row ---- */}
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800/40 px-4 py-2.5 text-[10px]">
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

          {/* Reasoning replay toggle — only when there's thinking to replay. */}
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
                "ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium transition-colors",
                replayOpen
                  ? "bg-surface-3 text-zinc-200"
                  : "bg-surface-2 text-zinc-400 hover:bg-surface-3 hover:text-zinc-200",
              )}
            >
              <Brain className={clsx("h-3 w-3", replayOpen ? "text-lantern-300" : "text-zinc-500")} />
              Replay reasoning
              <span className="tabular-nums text-zinc-500">
                ({reasoningSpans.length})
              </span>
            </button>
          )}
        </div>

        {/* ---- Reasoning replay panel (progressive disclosure) ---- */}
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
      </div>

      {/* ---- The trace itself — the one primary focus ---- */}
      <RunWaterfall
        events={events}
        running={running}
        totals={totals}
        timeCursorMs={cursorMs}
        highlightSpanId={highlightSpanId}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signal chip
// ---------------------------------------------------------------------------

// One muted hue per signal, carried ONLY by the small icon — the chip body
// stays a neutral surface chip (no bright fills or colored rings). Calm.
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
// Reasoning replay panel
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
          <span className="text-[11px] font-medium text-zinc-200">
            Reasoning replay
          </span>
          <span className="text-[10px] tabular-nums text-zinc-500">
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
      <p className="mb-1.5 truncate text-[10px] font-medium text-zinc-500">
        {span?.name}
      </p>
      <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-zinc-300">
        {text ?? "No reasoning text recorded for this block."}
      </p>
    </div>
  );
}
