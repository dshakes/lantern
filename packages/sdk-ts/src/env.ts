/** Read PAL_<suffix>, falling back to the legacy PAL_<suffix> (ADR 0032). Empty counts as unset. */
export function palEnv(suffix: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[`PAL_${suffix}`] || process.env[`PAL_${suffix}`] || undefined;
}
