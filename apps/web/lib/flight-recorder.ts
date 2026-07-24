// lib/flight-recorder.ts — pure timeline utilities for the flight-recorder UI.
//
// Component-agnostic and tested without React. Uses a minimal FlightEvent
// shape so callers (StreamEvent from @/lib/mock-data) satisfy it structurally,
// and tests can import without @/ path-alias resolution.

/** Minimum event fields the pure helpers require. */
export interface FlightEvent {
  seq: number;
  ts: string | Date;
  stepId?: string;
  kind: string;
  data: Record<string, unknown>;
}

/** FlightEvent enriched with its position on the shared time axis. */
export interface TimelineEvent extends FlightEvent {
  /** ms from the run's first event (ts of lowest-seq event). Always >= 0. */
  relativeMs: number;
}

// ============================================================
// buildTimeline
// ============================================================

/**
 * Returns events sorted by seq, each enriched with relativeMs (ms from
 * the first event's ts). Clamped at 0 so clock skew never produces negative
 * positions.
 */
export function buildTimeline(events: readonly FlightEvent[]): TimelineEvent[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const t0 = new Date(sorted[0].ts).getTime();
  return sorted.map((e) => ({
    ...e,
    relativeMs: Math.max(0, new Date(e.ts).getTime() - t0),
  }));
}

// ============================================================
// eventAtCursor
// ============================================================

/**
 * Binary-search for the last event whose relativeMs is <= cursorMs.
 * When cursorMs is before all events, returns the first event.
 * Returns null only when timeline is empty.
 */
export function eventAtCursor(
  timeline: readonly TimelineEvent[],
  cursorMs: number,
): TimelineEvent | null {
  if (timeline.length === 0) return null;
  let lo = 0;
  let hi = timeline.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline[mid].relativeMs <= cursorMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return timeline[result];
}

// ============================================================
// cursorIndex
// ============================================================

/**
 * Returns the index of the last event whose relativeMs is <= cursorMs.
 * Returns 0 when timeline is empty or cursorMs precedes all events.
 * Used for ←/→ keyboard stepping.
 */
export function cursorIndex(
  timeline: readonly TimelineEvent[],
  cursorMs: number,
): number {
  if (timeline.length === 0) return 0;
  let lo = 0;
  let hi = timeline.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline[mid].relativeMs <= cursorMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

// ============================================================
// computeStats
// ============================================================

export interface RunStats {
  /** Total raw journal events. */
  totalEvents: number;
  /** Unique logical steps (unique stepIds with at least one step_started). */
  steps: number;
  /**
   * Extra step_started events beyond the first per stepId — i.e. the total
   * retry count across all steps.
   */
  retries: number;
  /** Duration from first to last event, ms. */
  durationMs: number;
}

export function computeStats(timeline: readonly TimelineEvent[]): RunStats {
  const stepStarts = new Map<string, number>();
  for (const e of timeline) {
    if (e.kind === "step_started" && e.stepId) {
      stepStarts.set(e.stepId, (stepStarts.get(e.stepId) ?? 0) + 1);
    }
  }
  let retries = 0;
  for (const count of stepStarts.values()) {
    if (count > 1) retries += count - 1;
  }
  return {
    totalEvents: timeline.length,
    steps: stepStarts.size,
    retries,
    durationMs:
      timeline.length > 0 ? timeline[timeline.length - 1].relativeMs : 0,
  };
}
