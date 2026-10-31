/** Read PAL_<suffix>. Empty counts as unset. */
export function palEnv(suffix: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[`PAL_${suffix}`] || undefined;
}
