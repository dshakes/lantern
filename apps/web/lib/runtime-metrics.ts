// Simulated live time-series for the demo fleet's inline sparklines.
//
// HONESTY: this is ONLY used for rows flagged `demo`. It produces a
// smooth, bounded random walk seeded from a per-VM baseline so the cockpit
// feels alive without ever fabricating metrics for a REAL workload (the
// page renders "—" for those instead).

const SERIES_LEN = 32;

/** A bounded random walk around a baseline, deterministic-ish per seed. */
function walk(seed: number, base: number, len: number, volatility: number): number[] {
  // Simple LCG so the initial series is stable across renders for a given seed.
  let s = (seed % 2147483647) || 1;
  const rand = () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
  const out: number[] = [];
  let v = base;
  for (let i = 0; i < len; i++) {
    v += (rand() - 0.5) * volatility;
    // mean-revert toward base so it never drifts off-screen
    v += (base - v) * 0.08;
    out.push(Math.min(1, Math.max(0.02, v)));
  }
  return out;
}

function seedFrom(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export interface SimSeries {
  cpu: number[];
  mem: number[];
}

export function initialSeries(vmId: string, cpuBase: number, memBase: number): SimSeries {
  const seed = seedFrom(vmId);
  return {
    cpu: walk(seed, cpuBase, SERIES_LEN, 0.18),
    mem: walk(seed + 7, memBase, SERIES_LEN, 0.08),
  };
}

/** Advance a series by one sample, dropping the oldest. Mean-reverting. */
export function advance(series: number[], base: number, volatility: number): number[] {
  const last = series[series.length - 1] ?? base;
  let next = last + (Math.random() - 0.5) * volatility;
  next += (base - next) * 0.1;
  next = Math.min(1, Math.max(0.02, next));
  return [...series.slice(1), next];
}

export const SERIES_LENGTH = SERIES_LEN;
