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

// ===========================================================================
// Agentic onboarding flow (conversation + progress rail)
//
// The flow is a gated state machine. The persisted document (GET/PUT
// /v1/onboarding) records FACTS (spec approved, agent created, run status);
// `resumeStep` derives where to resume from those facts rather than trusting
// a stored step name, so a stale or hand-edited document cannot skip a gate.
// The provider check is never persisted as passed — it is re-verified with a
// real test call every session.
// ===========================================================================

export type Step = "goal" | "spec" | "provider" | "create" | "run" | "sandbox" | "done";

export const STEPS: ReadonlyArray<{ id: Step; label: string; hint: string }> = [
  { id: "goal", label: "Describe the goal", hint: "Say what the agent should do" },
  { id: "spec", label: "Review the design", hint: "Approve or edit the proposed agent" },
  { id: "provider", label: "Check the model key", hint: "A real test call to your provider" },
  { id: "create", label: "Create the agent", hint: "Saved to your workspace" },
  { id: "run", label: "First run", hint: "Live output, streamed" },
  { id: "sandbox", label: "Sandbox run", hint: "Optional microVM check" },
  { id: "done", label: "Next steps", hint: "Channels, budgets, evals" },
];

export interface AgentSpecDraft {
  name: string;
  description: string;
  systemPrompt: string;
  firstInput?: Record<string, unknown>;
  rationale?: string;
  model?: string;
  steps?: Array<{ name: string; type: string; description: string }>;
  tools?: string[];
  isolation?: string;
  [key: string]: unknown;
}

export type SandboxState = "" | "skipped" | "unavailable" | "ran" | "failed";

export interface OnboardingState {
  step?: Step;
  goal?: string;
  spec?: AgentSpecDraft;
  specApproved?: boolean;
  agentName?: string;
  agentCreated?: boolean;
  runId?: string;
  runStatus?: string;
  sandbox?: SandboxState;
  vmId?: string;
  completedAt?: string;
  updatedAt?: string;
}

export function stepIndex(step: Step): number {
  return STEPS.findIndex((s) => s.id === step);
}

/** Where to resume, derived from recorded facts only. */
export function resumeStep(s: OnboardingState | null | undefined): Step {
  if (!s) return "goal";
  if (s.completedAt) return "done";
  if (s.agentCreated && s.runStatus === "succeeded") return s.sandbox ? "done" : "sandbox";
  if (s.agentCreated) return "run";
  // Approved but not created: the provider gate must be re-verified first.
  if (s.specApproved && s.spec) return "provider";
  if (s.spec) return "spec";
  return "goal";
}

/** Gate: may the flow enter `step` given the facts so far? */
export function canEnter(step: Step, s: OnboardingState, providerVerified: boolean): boolean {
  switch (step) {
    case "goal":
      return true;
    case "spec":
      return !!s.spec;
    case "provider":
      return !!s.spec && !!s.specApproved;
    case "create":
      return !!s.spec && !!s.specApproved && providerVerified;
    case "run":
      return !!s.agentCreated;
    case "sandbox":
    case "done":
      return !!s.agentCreated && s.runStatus === "succeeded";
  }
}

export type StepStatus = "done" | "current" | "todo";

export function stepStatus(step: Step, current: Step): StepStatus {
  const a = stepIndex(step);
  const b = stepIndex(current);
  if (a < b) return "done";
  return a === b ? "current" : "todo";
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function normalizeAgentName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** Validate an (edited) spec before it can be approved. */
export function validateSpec(spec: AgentSpecDraft | undefined): string | null {
  if (!spec) return "There is no agent design to approve yet.";
  if (!NAME_RE.test(spec.name)) return "Name must be lowercase letters, digits and hyphens.";
  if (!spec.systemPrompt?.trim()) return "The agent needs instructions.";
  return null;
}

/**
 * Deterministic floor for the design step: a single-LLM-step agent grounded
 * in the user's own words. Offered only after the LLM design failed, and
 * labelled as the basic design — never passed off as the agent's proposal.
 */
export function starterSpec(goal: string): AgentSpecDraft {
  const g = goal.trim();
  return {
    name: normalizeAgentName(g.split(/\s+/).slice(0, 4).join(" ")) || "my-first-agent",
    description: g.slice(0, 160),
    systemPrompt:
      `You are an agent built for this goal: ${g}\n` +
      "Do the task described in your input, keep answers concise, and say plainly when you cannot do something.",
    firstInput: { prompt: "Introduce yourself in two sentences and show one example of what you do." },
    rationale: "This is the basic one-step design, used because the automatic design didn't come back. You can edit it before approving.",
    model: "auto",
    steps: [{ name: "respond", type: "llm", description: "Answer the input using the instructions above" }],
  };
}

/** First-run input: the spec's suggestion, or a safe default. */
export function firstRunInput(spec: AgentSpecDraft | undefined): Record<string, unknown> {
  const fi = spec?.firstInput;
  if (fi && typeof fi === "object" && Object.keys(fi).length > 0) return fi;
  return { prompt: "Introduce yourself in two sentences and show one example of what you do." };
}

/** Best human-readable text from a run's output object. */
export function runOutputText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    const o = output as Record<string, unknown>;
    for (const k of ["text", "result", "output", "content", "message"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v;
    }
  }
  return JSON.stringify(output, null, 2);
}

// ---- Errors → one-click fixes (deterministic floor) -------------------------

export interface ApiFailure {
  status?: number;
  code?: string;
  message: string;
}

/** Parse the dashboard client's `API <status>: <body>` errors. */
export function parseApiError(err: unknown): ApiFailure {
  const raw = errorMessage(err, "Something went wrong.");
  const m = /^API (\d{3}):\s*([\s\S]*)$/.exec(raw);
  if (!m) return { message: raw };
  const status = Number(m[1]);
  const body = m[2].trim();
  try {
    const j = JSON.parse(body) as { error?: string; code?: string; reason?: string };
    return {
      status,
      code: j.code,
      message: [j.error, j.reason].filter(Boolean).join(": ") || body || `HTTP ${status}`,
    };
  } catch {
    return { status, message: body || `HTTP ${status}` };
  }
}

export type FixAction =
  | "add_key"
  | "retry"
  | "rephrase"
  | "rename_agent"
  | "open_budgets"
  | "login"
  | "check_api";

export interface FixSuggestion {
  summary: string;
  /** The real error text, when the summary paraphrases it. */
  detail?: string;
  fix: { label: string; action: FixAction };
}

/**
 * Map a real failure to what went wrong and the one action most likely to
 * fix it. Deterministic on purpose: it must work when the failure IS the
 * model (no key, bad key), so it cannot depend on an LLM.
 */
export function suggestFix(f: ApiFailure, step: Step): FixSuggestion {
  const msg = f.message.toLowerCase();
  if (f.status === undefined && /fetch|network|econnrefused|load failed/.test(msg)) {
    return {
      summary: "The Lantern API isn't reachable. Start it with `make run-api` (or `lantern dev`), then try again.",
      fix: { label: "Try again", action: "check_api" },
    };
  }
  if (f.status === 401) {
    return { summary: "Your session expired. Sign in again to pick up where you left off.", fix: { label: "Sign in", action: "login" } };
  }
  if (f.code === "no_provider" || /no (llm )?provider|no api key|api key configured/.test(msg)) {
    return {
      summary: "I need a model key before I can design or run anything. Add an OpenAI or Anthropic key and I'll test it with a real call.",
      fix: { label: "Add a model key", action: "add_key" },
    };
  }
  if (f.code === "llm_failed" || /invalid.*key|incorrect api key|authentication|unauthorized|rejected|\b401\b/.test(msg)) {
    return {
      summary: "The model provider rejected the call. The key is likely wrong, revoked, or out of credit.",
      detail: f.message,
      fix: { label: "Replace the key", action: "add_key" },
    };
  }
  if (f.code === "bad_spec") {
    return {
      summary: "The design came back unusable. Describe the goal in a sentence or two more and I'll try again.",
      fix: { label: "Rephrase the goal", action: "rephrase" },
    };
  }
  if (f.status === 409 && step === "create") {
    return { summary: "An agent with that name already exists. Pick another name.", fix: { label: "Rename the agent", action: "rename_agent" } };
  }
  if (f.status === 402) {
    return { summary: `A budget or quota blocked this: ${f.message}`, fix: { label: "Open budgets", action: "open_budgets" } };
  }
  return { summary: f.message, fix: { label: "Try again", action: "retry" } };
}

// ---- SSE ---------------------------------------------------------------------

export interface SSEFrame {
  event: string;
  data: string;
}

/** Split an SSE buffer into complete frames + the unconsumed remainder. */
export function parseSSE(buffer: string): { frames: SSEFrame[]; rest: string } {
  const frames: SSEFrame[] = [];
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  for (const block of parts) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // comment / heartbeat
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) frames.push({ event, data: data.join("\n") });
  }
  return { frames, rest };
}

export interface JournalEvent {
  seq: number;
  kind: string;
  stepId?: string;
  payload?: Record<string, unknown>;
}

/** One human line per journal event for the live run log (null = hide). */
export function describeEvent(ev: JournalEvent): string | null {
  const p = ev.payload ?? {};
  const step = (p.step_id as string) || ev.stepId || "step";
  switch (ev.kind) {
    case "step_started":
      return `Started ${step}`;
    case "step_completed": {
      const ms = typeof p.duration_ms === "number" ? ` in ${Math.round(p.duration_ms)} ms` : "";
      return `Finished ${step}${ms}`;
    }
    case "step_failed":
      return `Failed ${step}: ${(p.error_message as string) || (p.error as string) || "unknown error"}`;
    case "heartbeat":
      return null;
    default:
      return ev.kind.replace(/_/g, " ");
  }
}

// ---- Sandbox -----------------------------------------------------------------

export type SandboxDisplay =
  | { kind: "unavailable"; reason: string }
  | { kind: "ran"; vmId: string; stdout: string; exitCode: number }
  | { kind: "failed"; error: string };

/**
 * Decide what the sandbox step shows. A stub scheduler (no runtime wired)
 * is "unavailable" — never a pass — even though schedule returned 201.
 */
export function decideSandbox(
  schedule: { vmId?: string; stub?: boolean; warning?: string } | null,
  exec: { stdout?: string; stderr?: string; exitCode?: number } | null,
  err: unknown | null,
): SandboxDisplay {
  if (err) {
    const f = parseApiError(err);
    if (f.status === undefined || f.status === 500 || f.status === 502 || f.status === 503) {
      return { kind: "unavailable", reason: `The microVM runtime isn't reachable (${f.message}).` };
    }
    return { kind: "failed", error: f.message };
  }
  if (!schedule?.vmId) return { kind: "failed", error: "The scheduler returned no VM." };
  if (schedule.stub) {
    return { kind: "unavailable", reason: schedule.warning || "No microVM runtime is wired to this stack." };
  }
  if (!exec) return { kind: "failed", error: "The VM started but the command did not run." };
  if ((exec.exitCode ?? 1) !== 0) {
    return { kind: "failed", error: exec.stderr?.trim() || `Command exited with ${exec.exitCode}.` };
  }
  return { kind: "ran", vmId: schedule.vmId, stdout: exec.stdout ?? "", exitCode: 0 };
}
