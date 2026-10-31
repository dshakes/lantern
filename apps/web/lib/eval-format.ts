// Pure helpers for the Eval Suites page (kept out of the component so they
// are unit-testable).

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** request() throws `API <status>: <body>`; recover a JSON object body for the given status. */
export function parseApiErrorBody(
  message: string,
  status: number,
): Record<string, unknown> | null {
  const prefix = `API ${status}: `;
  if (!message.startsWith(prefix)) return null;
  try {
    return obj(JSON.parse(message.slice(prefix.length))) ?? null;
  } catch {
    return null;
  }
}

type Assert = Record<string, unknown> | undefined;

export function getRubric(a: Assert): string {
  const r = obj(a?.judge)?.rubric;
  return typeof r === "string" ? r : "";
}

/** Immutable: sets judge.rubric; drops the judge block when emptied and it has nothing else. */
export function setRubric(a: Assert, rubric: string): Record<string, unknown> {
  const next = { ...(a ?? {}) };
  const judge = { ...(obj(a?.judge) ?? {}), rubric };
  if (rubric === "" && Object.keys(judge).length === 1) delete next.judge;
  else next.judge = judge;
  return next;
}

/** One short label per configured assertion, e.g. ['contains "30"', "judge"]. */
export function assertionSummary(a: Assert, expected?: string): string[] {
  const out: string[] = [];
  if (expected) out.push(`expected "${expected}"`);
  if (!a) return out;
  for (const k of ["contains", "notContains", "regex"] as const) {
    if (typeof a[k] === "string" && a[k]) out.push(`${k} "${a[k]}"`);
  }
  if (typeof a.minLen === "number") out.push(`minLen ${a.minLen}`);
  if (typeof a.maxLen === "number") out.push(`maxLen ${a.maxLen}`);
  if (a.grounded) out.push("grounded");
  for (const k of ["judge", "faithfulness", "pairwise", "trajectory"] as const) {
    if (a[k]) out.push(k);
  }
  if (typeof a.maxLatencyMs === "number") out.push(`≤${a.maxLatencyMs}ms`);
  if (typeof a.maxCostUsd === "number") out.push(`≤$${a.maxCostUsd}`);
  return out;
}

/** "+0.12" / "-0.30" / "0.00". */
export function fmtDelta(d: number): string {
  const s = d.toFixed(2);
  if (s === "0.00" || s === "-0.00") return "0.00";
  return d > 0 ? `+${s}` : s;
}

export function fmtUsd(n: number | undefined): string {
  return `$${(n ?? 0).toFixed(4)}`;
}

/** reference:* is grounded in a real run/feedback; anything else is rubric-only. */
export function isGrounded(grounding: string): boolean {
  return grounding.startsWith("reference:");
}
