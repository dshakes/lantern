// ---------------------------------------------------------------------------
// Pure decision logic for the onboarding wizard.
//
// Extracted so the "a failed call must NOT show success" rules are unit-
// testable without standing up Playwright / a full React renderer. The page
// component (page.tsx) imports these and renders the result; it owns no
// branching of its own beyond calling these and reacting to the outcome.
//
// The golden rule encoded here: success is NEVER the default. Every helper
// returns an explicit ok/error outcome derived from a REAL backend signal
// (a thrown request, a `success:false` test result, a terminal run status),
// and the UI is gated on `ok === true`.
// ---------------------------------------------------------------------------

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Terminal statuses — once a run reaches one of these, stop polling. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status as RunStatus);
}

/** Normalize any thrown value into a human-readable, non-empty message. */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}

// ---- Provider save / test -------------------------------------------------

export interface ProviderTestResult {
  success: boolean;
  message?: string;
  error?: string;
}

export type ProviderOutcome =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Decide the outcome of a "save then test" provider flow.
 *
 * - `saveError` is whatever `saveLlmProvider` threw (or null on success).
 * - `testResult` is the `/test` payload (or null if the save threw / test
 *   never ran).
 *
 * Returns ok ONLY when the save succeeded AND the test reported success.
 * A failed save, a thrown test, or `success:false` all surface a real error.
 */
export function decideProviderSave(
  saveError: unknown | null,
  testResult: ProviderTestResult | null,
): ProviderOutcome {
  if (saveError) {
    return { ok: false, error: errorMessage(saveError, "Failed to save provider key.") };
  }
  if (!testResult) {
    return { ok: false, error: "Provider key saved but the connection test did not run." };
  }
  if (!testResult.success) {
    return {
      ok: false,
      error:
        testResult.error?.trim() ||
        testResult.message?.trim() ||
        "Provider key was rejected — check the key and try again.",
    };
  }
  return { ok: true };
}

// ---- Agent create ---------------------------------------------------------

/**
 * Decide whether the create-agent step may advance. The ONLY way to get
 * `ok: true` is a create call that did not throw (a real 2xx). A thrown
 * call surfaces the real error and the wizard stays put.
 */
export function decideAgentCreate(createError: unknown | null): ProviderOutcome {
  if (createError) {
    return { ok: false, error: errorMessage(createError, "Failed to create the agent.") };
  }
  return { ok: true };
}

// ---- Run result -----------------------------------------------------------

export interface RunLike {
  id: string;
  status: string;
  output?: unknown;
  error?: { code?: string; message?: string; stepId?: string };
}

export type RunDisplay =
  | { kind: "succeeded"; output: unknown }
  | { kind: "failed"; error: string }
  | { kind: "pending" };

/**
 * Map a polled run (or a thrown create/poll error) to what the run step
 * should render. Never reports success unless the run actually reached
 * `succeeded`.
 */
export function decideRunDisplay(
  run: RunLike | null,
  pollError: unknown | null,
): RunDisplay {
  if (pollError) {
    return { kind: "failed", error: errorMessage(pollError, "The run could not be started.") };
  }
  if (!run) {
    return { kind: "failed", error: "The run could not be started." };
  }
  if (run.status === "succeeded") {
    return { kind: "succeeded", output: run.output ?? null };
  }
  if (run.status === "failed" || run.status === "cancelled") {
    return {
      kind: "failed",
      error: run.error?.message?.trim() || `Run ${run.status}.`,
    };
  }
  // queued / running / paused — not terminal yet.
  return { kind: "pending" };
}
