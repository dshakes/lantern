// Buckets real runs into ~12 time slices over a trailing window (24h by
// default) so the Agents page stat tiles can render an honest sparkline —
// never a fabricated curve. Returns null when there isn't enough data in
// the window to bucket meaningfully; callers must render no sparkline then.

export interface RunForBucketing {
  createdAt: Date | string;
  costUsd?: number;
}

export interface BucketedRunSeries {
  runCounts: number[];
  costs: number[];
}

const BUCKET_COUNT = 12;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_RUNS_IN_WINDOW = 3; // ponytail: honesty floor — fewer points than this isn't a curve, it's noise

export function bucketRunsByTime(
  runs: RunForBucketing[],
  now: number = Date.now(),
): BucketedRunSeries | null {
  const windowStart = now - WINDOW_MS;
  const inWindow = runs.filter((r) => new Date(r.createdAt).getTime() >= windowStart);
  if (inWindow.length < MIN_RUNS_IN_WINDOW) return null;

  const bucketMs = WINDOW_MS / BUCKET_COUNT;
  const runCounts = new Array<number>(BUCKET_COUNT).fill(0);
  const costs = new Array<number>(BUCKET_COUNT).fill(0);

  for (const r of inWindow) {
    const t = new Date(r.createdAt).getTime();
    const idx = Math.min(BUCKET_COUNT - 1, Math.max(0, Math.floor((t - windowStart) / bucketMs)));
    runCounts[idx] += 1;
    costs[idx] += r.costUsd ?? 0;
  }

  return { runCounts, costs };
}
