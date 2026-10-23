// Decision rule for scripts/introspect/run.sh's staleness alarm. The shell
// script mirrors this arithmetic (bash can't import TS); this is the tested
// spec. The loop sat dead ~4 weeks once because nothing measured "last success".

export const INTROSPECT_STALE_HOURS = 36;

/** `lastSuccessMs` = mtime of the last-success marker (or newest report); null = never. */
export function introspectStaleness(
  lastSuccessMs: number | null,
  nowMs: number,
  thresholdHours = INTROSPECT_STALE_HOURS,
): { stale: boolean; ageHours: number | null } {
  if (lastSuccessMs === null) return { stale: true, ageHours: null };
  const ageHours = Math.floor((nowMs - lastSuccessMs) / 3_600_000);
  return { stale: ageHours >= thresholdHours, ageHours };
}
