import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideProviderSave,
  decideAgentCreate,
  decideRunDisplay,
  isTerminalRunStatus,
  errorMessage,
  resumeStep,
  canEnter,
  stepStatus,
  validateSpec,
  normalizeAgentName,
  firstRunInput,
  runOutputText,
  parseApiError,
  suggestFix,
  parseSSE,
  describeEvent,
  decideSandbox,
  starterSpec,
  afterRun,
  parseStarterGallery,
  specFromTemplate,
  templateNeeds,
  type OnboardingState,
  type AgentSpecDraft,
} from "./onboarding-logic.ts";

// ---------------------------------------------------------------------------
// The whole point of this suite: a FAILED call must never look like success.
// ---------------------------------------------------------------------------

test("decideProviderSave: thrown save is a real error, never ok", () => {
  const out = decideProviderSave(new Error("API 401: unauthorized"), null);
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /401/);
});

test("decideProviderSave: save ok but test returned success:false surfaces the error", () => {
  const out = decideProviderSave(null, { success: false, error: "invalid_api_key" });
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /invalid_api_key/);
});

test("decideProviderSave: save ok but test never ran is NOT success", () => {
  const out = decideProviderSave(null, null);
  assert.equal(out.ok, false);
});

test("decideProviderSave: save ok + test success is the ONLY ok path", () => {
  const out = decideProviderSave(null, { success: true });
  assert.deepEqual(out, { ok: true });
});

test("decideAgentCreate: a thrown create does NOT advance / show success", () => {
  const out = decideAgentCreate(new Error("API 500: boom"));
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /500/);
});

test("decideAgentCreate: only a non-throwing create is ok", () => {
  assert.deepEqual(decideAgentCreate(null), { ok: true });
});

test("decideRunDisplay: a thrown create/poll is rendered as a real failure, not success", () => {
  const out = decideRunDisplay(null, new Error("API 402: budget exceeded"));
  assert.equal(out.kind, "failed");
  assert.match((out as { error: string }).error, /402/);
});

test("decideRunDisplay: a failed run renders the run error, never success", () => {
  const out = decideRunDisplay(
    { id: "r1", status: "failed", error: { message: "tool crashed" } },
    null,
  );
  assert.equal(out.kind, "failed");
  assert.match((out as { error: string }).error, /tool crashed/);
});

test("decideRunDisplay: a non-terminal run is pending, not success", () => {
  assert.equal(decideRunDisplay({ id: "r1", status: "running" }, null).kind, "pending");
});

test("decideRunDisplay: only a succeeded run shows the output", () => {
  const out = decideRunDisplay({ id: "r1", status: "succeeded", output: { ok: 1 } }, null);
  assert.equal(out.kind, "succeeded");
  assert.deepEqual((out as { output: unknown }).output, { ok: 1 });
});

test("isTerminalRunStatus", () => {
  assert.equal(isTerminalRunStatus("succeeded"), true);
  assert.equal(isTerminalRunStatus("failed"), true);
  assert.equal(isTerminalRunStatus("cancelled"), true);
  assert.equal(isTerminalRunStatus("running"), false);
  assert.equal(isTerminalRunStatus("queued"), false);
});

test("errorMessage falls back when there is no usable message", () => {
  assert.equal(errorMessage(new Error(""), "fallback"), "fallback");
  assert.equal(errorMessage(null, "fallback"), "fallback");
  assert.equal(errorMessage("boom", "fallback"), "boom");
});

// ---- Agentic flow: resume, gating, fixes, streaming, sandbox ----------------

const spec: AgentSpecDraft = {
  name: "standup-writer",
  description: "Writes standups",
  systemPrompt: "You write standups.",
  firstInput: { prompt: "Yesterday I fixed login." },
};

test("resumeStep derives the step from facts, never from a stored step name", () => {
  assert.equal(resumeStep(null), "goal");
  assert.equal(resumeStep({}), "goal");
  // A forged step name without the facts behind it does not skip ahead.
  assert.equal(resumeStep({ step: "done" } as OnboardingState), "goal");
  assert.equal(resumeStep({ goal: "x", spec }), "spec");
  // Approved but not created → re-verify the provider (never persisted as passed).
  assert.equal(resumeStep({ spec, specApproved: true }), "provider");
  assert.equal(resumeStep({ spec, specApproved: true, agentCreated: true }), "run");
  assert.equal(resumeStep({ agentCreated: true, runStatus: "failed" }), "run");
  assert.equal(resumeStep({ agentCreated: true, runStatus: "succeeded" }), "sandbox");
  assert.equal(resumeStep({ agentCreated: true, runStatus: "succeeded", sandbox: "unavailable" }), "done");
  assert.equal(resumeStep({ completedAt: "2026-10-26T00:00:00Z" }), "done");
});

test("canEnter gates every step on a real prior outcome", () => {
  const s: OnboardingState = { spec, specApproved: true };
  assert.equal(canEnter("create", s, false), false, "create needs a verified provider");
  assert.equal(canEnter("create", s, true), true);
  assert.equal(canEnter("provider", { spec }, true), false, "provider needs an approved spec");
  assert.equal(canEnter("run", s, true), false, "run needs a created agent");
  assert.equal(canEnter("sandbox", { agentCreated: true, runStatus: "failed" }, true), false);
  assert.equal(canEnter("done", { agentCreated: true, runStatus: "succeeded" }, true), true);
});

test("stepStatus marks earlier steps done and later ones todo", () => {
  assert.equal(stepStatus("goal", "create"), "done");
  assert.equal(stepStatus("create", "create"), "current");
  assert.equal(stepStatus("run", "create"), "todo");
  assert.equal(stepStatus("sandbox", "done"), "done");
});

test("validateSpec + normalizeAgentName guard the edit-and-approve step", () => {
  assert.equal(validateSpec(spec), null);
  assert.match(validateSpec({ ...spec, name: "Bad Name" }) ?? "", /lowercase/);
  assert.match(validateSpec({ ...spec, systemPrompt: "  " }) ?? "", /instructions/);
  assert.match(validateSpec(undefined) ?? "", /no agent design/);
  assert.equal(normalizeAgentName("  My Inbox Bot!! "), "my-inbox-bot");
});

test("starterSpec is a valid, goal-grounded fallback design", () => {
  const s = starterSpec("Summarize my unread email every morning");
  assert.equal(s.name, "summarize-my-unread-email");
  assert.equal(validateSpec(s), null);
  assert.match(s.systemPrompt, /unread email/);
  assert.equal(s.model, "auto");
  assert.equal(starterSpec("!!!").name, "my-first-agent");
});

test("firstRunInput + runOutputText", () => {
  assert.deepEqual(firstRunInput(spec), { prompt: "Yesterday I fixed login." });
  assert.ok(String(firstRunInput({ ...spec, firstInput: {} }).prompt).length > 0);
  assert.equal(runOutputText({ text: "hi" }), "hi");
  assert.equal(runOutputText({ result: "r" }), "r");
  assert.equal(runOutputText(null), "");
  assert.match(runOutputText({ a: 1 }), /"a": 1/);
});

test("parseApiError reads status, code and message from the client's error format", () => {
  const f = parseApiError(new Error('API 400: {"error":"no key","code":"no_provider"}'));
  assert.deepEqual(f, { status: 400, code: "no_provider", message: "no key" });
  assert.deepEqual(parseApiError(new Error("API 500: boom")), { status: 500, message: "boom" });
  assert.deepEqual(parseApiError(new TypeError("Failed to fetch")), { message: "Failed to fetch" });
  assert.equal(parseApiError(new Error('API 402: {"error":"quota exceeded","reason":"max vms"}')).message, "quota exceeded: max vms");
});

test("suggestFix maps each real failure to one actionable fix", () => {
  assert.equal(suggestFix({ status: 400, code: "no_provider", message: "x" }, "spec").fix.action, "add_key");
  assert.equal(suggestFix({ status: 502, code: "llm_failed", message: "x" }, "spec").fix.action, "add_key");
  assert.equal(suggestFix({ message: "Incorrect API key provided" }, "provider").fix.action, "add_key");
  assert.equal(suggestFix({ status: 502, code: "bad_spec", message: "x" }, "spec").fix.action, "rephrase");
  assert.equal(suggestFix({ status: 409, message: "exists" }, "create").fix.action, "rename_agent");
  assert.equal(suggestFix({ status: 402, message: "budget" }, "run").fix.action, "open_budgets");
  assert.equal(suggestFix({ status: 401, message: "unauthorized" }, "run").fix.action, "login");
  assert.equal(suggestFix({ message: "Failed to fetch" }, "goal").fix.action, "check_api");
  const other = suggestFix({ status: 500, message: "internal error" }, "run");
  assert.equal(other.fix.action, "retry");
  assert.equal(other.summary, "internal error", "unknown errors surface the real message");
});

test("parseSSE handles named events, heartbeats and partial frames", () => {
  const buf =
    ': heartbeat\n\nevent: step_started\ndata: {"seq":1,"kind":"step_started"}\n\n' +
    'event: step_completed\ndata: {"seq":2}\n\nevent: step_fa';
  const { frames, rest } = parseSSE(buf);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].event, "step_started");
  assert.equal(JSON.parse(frames[1].data).seq, 2);
  assert.equal(rest, "event: step_fa");
  // Remainder completes on the next chunk.
  const next = parseSSE(rest + 'iled\ndata: {"seq":3}\n\n');
  assert.equal(next.frames[0].event, "step_failed");
});

test("describeEvent renders steps and hides heartbeats", () => {
  assert.equal(describeEvent({ seq: 1, kind: "step_started", payload: { step_id: "llm:main" } }), "Started llm:main");
  assert.equal(describeEvent({ seq: 2, kind: "step_completed", stepId: "s", payload: { duration_ms: 812.4 } }), "Finished s in 812 ms");
  assert.match(describeEvent({ seq: 3, kind: "step_failed", payload: { error_message: "429" } }) ?? "", /429/);
  assert.equal(describeEvent({ seq: 4, kind: "heartbeat" }), null);
});

test("decideSandbox: a stub scheduler is unavailable, never a pass", () => {
  const stub = decideSandbox({ vmId: "vm-1", stub: true, warning: "no scheduler wired" }, null, null);
  assert.deepEqual(stub, { kind: "unavailable", reason: "no scheduler wired" });
  assert.equal(decideSandbox(null, null, new Error("API 500: scheduler unavailable")).kind, "unavailable");
  assert.equal(decideSandbox(null, null, new Error('API 402: {"error":"quota exceeded"}')).kind, "failed");
  assert.equal(decideSandbox({ vmId: "vm-2" }, { exitCode: 1, stderr: "boom" }, null).kind, "failed");
  assert.equal(decideSandbox({ vmId: "vm-2" }, null, null).kind, "failed");
  assert.deepEqual(decideSandbox({ vmId: "vm-3" }, { stdout: "hello", exitCode: 0 }, null), {
    kind: "ran",
    vmId: "vm-3",
    stdout: "hello",
    exitCode: 0,
  });
});

test("afterRun: a succeeded first run persists AND advances to the sandbox step", () => {
  const base: OnboardingState = { spec, specApproved: true, agentCreated: true, agentName: "standup-writer", runId: "r1", step: "run" };
  const ok = afterRun(base, { kind: "succeeded", output: { text: "hi" } }, true);
  assert.equal(ok.step, "sandbox", "UI must move on (it used to stay on run forever)");
  assert.equal(ok.state.runStatus, "succeeded");
  assert.equal(ok.state.step, "sandbox");
  assert.equal(resumeStep(ok.state), ok.step, "persisted state and UI step agree");
  assert.equal(canEnter(ok.step, ok.state, false), true);

  const failed = afterRun(base, { kind: "failed", error: "401" }, true);
  assert.equal(failed.step, "run");
  assert.equal(failed.state.runStatus, "failed");

  // Run never created (POST /v1/runs threw): nothing new to persist.
  const notCreated = afterRun(base, { kind: "failed", error: "boom" }, false);
  assert.equal(notCreated.state, base);
  assert.equal(notCreated.step, "run");

  // Sandbox already decided earlier → straight to done.
  assert.equal(afterRun({ ...base, sandbox: "skipped" }, { kind: "succeeded", output: "x" }, true).step, "done");
});

// ---- W2-S: starter gallery + verify-email step -----------------------------


const tpl = (over: Record<string, unknown> = {}) => ({
  id: "pr-triage", name: "pr-triage", gallery: true, pitch: "Triage PRs.", model: "balanced",
  systemPrompt: "You triage PRs.", firstInput: "Triage PR 1", connectors: ["github", "slack"], surfaces: [], ...over,
});

test("parseStarterGallery keeps complete gallery templates only", () => {
  const out = parseStarterGallery([
    tpl(),
    tpl({ id: "legacy", gallery: false }),
    tpl({ id: "vendor", model: "gpt-5" }),
    tpl({ id: "nopitch", pitch: "" }),
    tpl({ id: "noprompt", systemPrompt: undefined }),
    null,
  ]);
  assert.deepEqual(out.map((t) => t.id), ["pr-triage"]);
  assert.deepEqual(parseStarterGallery("nope"), []);
});

test("templateNeeds lists every connector and channel honestly", () => {
  const [t] = parseStarterGallery([tpl({ connectors: ["github", "slack"], surfaces: ["webchat"] })]);
  assert.equal(templateNeeds(t), "Needs: GitHub connector, Slack connector, Webchat channel");
  const [bare] = parseStarterGallery([tpl({ connectors: [], surfaces: [] })]);
  assert.equal(templateNeeds(bare), "No connectors needed");
});

test("specFromTemplate yields a capability-model spec that passes validateSpec", () => {
  const [t] = parseStarterGallery([tpl()]);
  const spec = specFromTemplate(t);
  assert.equal(validateSpec(spec), null);
  assert.equal(spec.model, "balanced");
  assert.deepEqual(spec.firstInput, { prompt: "Triage PR 1" });
  assert.match(spec.rationale ?? "", /Needs: GitHub connector, Slack connector/);
});

test("unverified-email 403 maps to a verify step, not a silent failure", () => {
  const f = parseApiError(new Error('API 403: {"error":"verify your email to run agents","code":"email_unverified"}'));
  const fix = suggestFix(f, "run");
  assert.equal(fix.fix.action, "verify_email");
  assert.match(fix.summary, /Verify your email/);
});
