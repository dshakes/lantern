"use client";

// Agentic onboarding: the user describes a goal in plain language and the
// onboarding agent takes them to a created agent with a real first run (and
// an optional sandbox run), explaining as it goes.
//
// - Intelligence: the agent design (POST /v1/agents/generate-spec) and the
//   run explanation (POST /v1/onboarding/explain) are LLM reasoning through
//   the control-plane's capability-addressed path. The deterministic floor
//   is onboarding-logic.ts: gating, error → fix mapping, and a labelled
//   basic design when the LLM design fails.
// - Honesty: every step advances only on a real 2xx / terminal status.
// - Resume: facts are persisted server-side (GET/PUT /v1/onboarding) and the
//   resume point is derived from them (resumeStep), never from localStorage.

import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bot, Box, Eye, EyeOff, FlaskConical, Gauge, MessageSquare, Play, RotateCcw } from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { runtimeApi } from "@/lib/runtime-api";
import { useToast } from "@/components/toast";
import { PageHeader } from "@/components/page-header";
import { Button, LinkButton } from "@/components/button";
import { Skeleton } from "@/components/skeleton";
import { Modal } from "@/components/modal";
import {
  STEPS,
  canEnter,
  decideAgentCreate,
  decideProviderSave,
  decideRunDisplay,
  afterRun,
  decideSandbox,
  describeEvent,
  firstRunInput,
  isTerminalRunStatus,
  normalizeAgentName,
  parseApiError,
  parseSSE,
  resumeStep,
  runOutputText,
  starterSpec,
  suggestFix,
  validateSpec,
  type AgentSpecDraft,
  type FixSuggestion,
  type JournalEvent,
  type OnboardingState,
  type RunDisplay,
  type SandboxDisplay,
  type Step,
} from "./onboarding-logic";
import { AgentMessage, FixCard, Notice, ProgressRail, StepCard, UserMessage, ui } from "./parts";

type Provider = "openai" | "anthropic";

const GOAL_EXAMPLES = [
  "Turn my rough meeting notes into a short summary with action items",
  "Answer customer questions about our pricing page",
  "Draft a friendly reply to an email I paste in",
];

// The smallest runnable demo workload (examples/headless-agents/01-hello).
const SANDBOX_SPEC = {
  imageDigest: "lantern/demos/hello:latest",
  isolation: "untrusted",
  limits: { vcpu: "100m", memory: "64Mi", timeout_secs: 30 },
  env: { LANTERN_ONBOARDING: "1" },
};

interface Failure {
  step: Step;
  fix: FixSuggestion;
}

const stepPos = (s: Step) => STEPS.findIndex((x) => x.id === s);

export default function OnboardingPage() {
  const router = useRouter();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [doc, setDoc] = useState<OnboardingState>({});
  const [step, setStep] = useState<Step>("goal");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Provider gate — re-verified with a real call every session, never persisted.
  const [providerVerified, setProviderVerified] = useState<string | null>(null);
  const [keyFormOpen, setKeyFormOpen] = useState(false);
  const [retrySpecAfterKey, setRetrySpecAfterKey] = useState(false);

  // Run + sandbox.
  const [runLines, setRunLines] = useState<string[]>([]);
  const [runDisplay, setRunDisplay] = useState<RunDisplay | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [sandbox, setSandbox] = useState<SandboxDisplay | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ---- persistence ---------------------------------------------------------

  const persist = useCallback(
    async (next: OnboardingState) => {
      setDoc(next);
      try {
        const body: OnboardingState = { ...next };
        delete body.updatedAt;
        await api.saveOnboarding(body);
      } catch (err) {
        // The flow still works this session; say plainly that resume won't.
        toast.warning(`Progress not saved, so a reload starts over: ${parseApiError(err).message}`);
      }
    },
    [toast],
  );

  const goTo = useCallback((s: Step) => {
    setFailure(null);
    setStep(s);
  }, []);

  // Move focus to the new step's card so keyboard / screen-reader users follow.
  useEffect(() => {
    if (!loading) headingRef.current?.focus();
  }, [step, loading, keyFormOpen]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // ---- load + resume -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = (await api.getOnboarding()) ?? {};
        if (cancelled) return;
        setDoc(saved);
        setStep(resumeStep(saved));
      } catch (err) {
        if (!cancelled) setFailure({ step: "goal", fix: suggestFix(parseApiError(err), "goal") });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- goal → spec (LLM design) -------------------------------------------

  const designAgent = useCallback(
    async (goal: string, base: OnboardingState) => {
      setBusy("design");
      setFailure(null);
      try {
        const spec = await api.generateSpecFromGoal(goal);
        await persist({ ...base, goal, spec, specApproved: false, step: "spec" });
        goTo("spec");
      } catch (err) {
        const fix = suggestFix(parseApiError(err), "goal");
        setFailure({ step: "goal", fix });
        setRetrySpecAfterKey(fix.fix.action === "add_key");
      } finally {
        setBusy(null);
      }
    },
    [persist, goTo],
  );

  const submitGoal = async (goal: string) => {
    const base: OnboardingState = { goal, step: "goal" };
    await persist(base);
    await designAgent(goal, base);
  };

  // ---- spec → provider ------------------------------------------------------

  const approveSpec = async (spec: AgentSpecDraft) => {
    const problem = validateSpec(spec);
    if (problem) {
      toast.error(problem);
      return;
    }
    await persist({ ...doc, spec, specApproved: true, agentName: spec.name, step: "provider" });
    // Close any key form left open from the design step so a saved key gets
    // its real test call first.
    setKeyFormOpen(false);
    goTo("provider");
  };

  // ---- provider gate (real test call) --------------------------------------

  const verifyExistingProviders = useCallback(async () => {
    setBusy("provider");
    setFailure(null);
    try {
      const providers = (await api.listLlmProviders()).filter((p) => !p.status || p.status === "active");
      if (providers.length === 0) {
        setKeyFormOpen(true);
        return;
      }
      let lastError = "";
      for (const p of providers) {
        const result = await api
          .testLlmProvider(p.provider)
          .catch((e: unknown) => ({ success: false, error: parseApiError(e).message }));
        const outcome = decideProviderSave(null, result);
        if (outcome.ok) {
          setProviderVerified(p.provider);
          return;
        }
        lastError = outcome.error;
      }
      setFailure({ step: "provider", fix: suggestFix({ message: lastError }, "provider") });
      setKeyFormOpen(true);
    } catch (err) {
      setFailure({ step: "provider", fix: suggestFix(parseApiError(err), "provider") });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (step === "provider" && !providerVerified && !keyFormOpen && !failure) void verifyExistingProviders();
  }, [step, providerVerified, keyFormOpen, failure, verifyExistingProviders]);

  const saveAndTestKey = async (provider: Provider, key: string): Promise<boolean> => {
    setBusy("key");
    let saveError: unknown = null;
    let testResult: Awaited<ReturnType<typeof api.testLlmProvider>> | null = null;
    try {
      await api.saveLlmProvider(provider, key);
      testResult = await api.testLlmProvider(provider);
    } catch (err) {
      saveError = err;
    } finally {
      setBusy(null);
    }
    const outcome = decideProviderSave(saveError, testResult);
    if (!outcome.ok) {
      const f = saveError ? parseApiError(saveError) : { message: outcome.error };
      setFailure({ step, fix: suggestFix(f, "provider") });
      return false;
    }
    setFailure(null);
    setProviderVerified(provider);
    setKeyFormOpen(false);
    toast.success(`${provider === "openai" ? "OpenAI" : "Anthropic"} key works`);
    if (retrySpecAfterKey && doc.goal) {
      setRetrySpecAfterKey(false);
      void designAgent(doc.goal, doc);
    }
    return true;
  };

  // ---- create ---------------------------------------------------------------

  const createAgent = async () => {
    const spec = doc.spec;
    if (!spec || !canEnter("create", doc, !!providerVerified)) return;
    setBusy("create");
    setFailure(null);
    let createError: unknown = null;
    try {
      await api.createAgent({
        name: spec.name,
        description: spec.description,
        systemPrompt: spec.systemPrompt,
        model: spec.model || "auto",
      });
    } catch (err) {
      createError = err;
    } finally {
      setBusy(null);
    }
    const outcome = decideAgentCreate(createError);
    if (!outcome.ok) {
      setFailure({ step: "create", fix: suggestFix(parseApiError(createError), "create") });
      return;
    }
    await persist({ ...doc, agentCreated: true, agentName: spec.name, step: "run" });
    toast.success(`Created ${spec.name}`);
    goTo("run");
  };

  // ---- first run (live SSE) -------------------------------------------------

  const explain = useCallback(
    async (output: string, error: string) => {
      try {
        const r = await api.explainOnboardingRun({ goal: doc.goal, agentName: doc.agentName, output, error });
        setExplanation(r.explanation);
      } catch {
        setExplanation(null); // the deterministic copy stands in
      }
    },
    [doc.goal, doc.agentName],
  );

  const streamRun = async (runId: string) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const deadline = setTimeout(() => ac.abort(), 120_000);
    try {
      const res = await api.openRunEventStream(runId, ac.signal);
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      const seen = new Set<number>();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const { frames, rest } = parseSSE(buf + value);
        buf = rest;
        for (const fr of frames) {
          try {
            const ev = JSON.parse(fr.data) as JournalEvent;
            if (seen.has(ev.seq)) continue;
            seen.add(ev.seq);
            const line = describeEvent(ev);
            if (line) setRunLines((l) => [...l, line]);
          } catch {
            /* malformed frame — skip */
          }
        }
      }
    } catch {
      // Stream unavailable or timed out — the poll below still finds the truth.
    } finally {
      clearTimeout(deadline);
    }
    let run = await api.getRun(runId);
    const until = Date.now() + 60_000;
    while (!isTerminalRunStatus(run.status) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1500));
      run = await api.getRun(runId);
    }
    return run;
  };

  const startRun = async (input: unknown) => {
    if (!doc.agentName) return;
    setBusy("run");
    setFailure(null);
    setRunLines([]);
    setRunDisplay(null);
    setExplanation(null);
    let display: RunDisplay;
    let runId = "";
    let base = doc;
    try {
      const created = await api.createRun({ agentName: doc.agentName, input });
      runId = created.id;
      base = { ...doc, runId, runStatus: created.status, step: "run" };
      await persist(base);
      display = decideRunDisplay(await streamRun(created.id), null);
    } catch (err) {
      display = decideRunDisplay(null, err);
    }
    setRunDisplay(display);
    setBusy(null);
    const next = afterRun(base, display, !!runId);
    if (next.state !== base) await persist(next.state);
    // Persisting a step is not moving to it — advance the UI too (the flow
    // used to deadlock here after a successful first run).
    goTo(next.step);
    if (display.kind === "succeeded") {
      void explain(runOutputText(display.output), "");
    } else if (display.kind === "failed") {
      setFailure({ step: "run", fix: suggestFix(parseApiError(new Error(display.error)), "run") });
      void explain("", display.error);
    }
  };

  // ---- sandbox (optional) ---------------------------------------------------

  const runSandbox = async () => {
    setBusy("sandbox");
    let result: SandboxDisplay;
    let vmId = "";
    try {
      const sched = await runtimeApi.post<{ vmId: string; stub?: boolean; warning?: string }>(
        "/v1/runtime/schedule",
        SANDBOX_SPEC,
      );
      vmId = sched.vmId;
      let exec: { stdout?: string; stderr?: string; exitCode?: number } | null = null;
      if (!sched.stub) {
        exec = await runtimeApi.post(`/v1/runtime/vms/${encodeURIComponent(vmId)}/exec`, {
          command: "/bin/sh",
          argv: ["-c", "echo 'hello from your Lantern sandbox' && uname -sr"],
        });
      }
      result = decideSandbox(sched, exec, null);
    } catch (err) {
      result = decideSandbox(null, null, err);
    }
    // Never leave a VM (or a synthesized stub row) holding quota.
    if (vmId) await runtimeApi.del(`/v1/runtime/vms/${encodeURIComponent(vmId)}`).catch(() => {});
    setSandbox(result);
    setBusy(null);
    await persist({ ...doc, sandbox: result.kind, vmId: vmId || undefined, step: "sandbox" });
  };

  const skipSandbox = async () => {
    await persist({ ...doc, sandbox: "skipped", step: "done" });
    goTo("done");
  };

  // ---- finish / reset -------------------------------------------------------

  const finish = async () => {
    await persist({ ...doc, step: "done", completedAt: new Date().toISOString() });
    try {
      localStorage.setItem("lantern_onboarding_complete", "true");
    } catch {
      /* cosmetic flag only */
    }
    router.push(doc.agentName ? `/agents/${encodeURIComponent(doc.agentName)}` : "/agents");
  };

  const startOver = async () => {
    setConfirmReset(false);
    abortRef.current?.abort();
    try {
      await api.resetOnboarding();
    } catch (err) {
      toast.error(parseApiError(err).message);
      return;
    }
    setDoc({});
    setProviderVerified(null);
    setKeyFormOpen(false);
    setRetrySpecAfterKey(false);
    setRunLines([]);
    setRunDisplay(null);
    setExplanation(null);
    setSandbox(null);
    goTo("goal");
  };

  // ---- one-click fixes ------------------------------------------------------

  const applyFix = (f: Failure) => {
    switch (f.fix.fix.action) {
      case "add_key":
        setFailure(null);
        setKeyFormOpen(true);
        return;
      case "rephrase":
        setFailure(null);
        setDoc((d) => ({ ...d, goal: undefined }));
        return;
      case "rename_agent":
        void persist({ ...doc, specApproved: false, step: "spec" });
        goTo("spec");
        return;
      case "open_budgets":
        router.push("/budgets");
        return;
      case "login":
        router.push("/login?next=/onboarding");
        return;
      case "check_api":
      case "retry":
        setFailure(null);
        if (f.step === "goal" && doc.goal) void designAgent(doc.goal, doc);
        if (f.step === "create") void createAgent();
        if (f.step === "run") void startRun(firstRunInput(doc.spec));
        // provider: clearing the failure re-triggers verification.
        return;
    }
  };

  // ---- render ---------------------------------------------------------------

  if (loading) {
    return (
      <Shell step="goal" blocked={false} onReset={() => {}}>
        <div className="space-y-4" aria-busy="true" aria-label="Loading your progress">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-28 w-full" />
        </div>
      </Shell>
    );
  }

  const reached = (s: Step) => stepPos(s) <= stepPos(step);

  const fixFor = (s: Step) =>
    failure?.step === s ? (
      <FixCard
        failure={failure.fix}
        onFix={() => applyFix(failure)}
        busy={busy !== null}
        secondary={
          s === "goal" && doc.goal && failure.fix.fix.action !== "check_api" ? (
            <Button
              variant="ghost"
              onClick={async () => {
                const spec = starterSpec(doc.goal!);
                await persist({ ...doc, spec, specApproved: false, step: "spec" });
                goTo("spec");
              }}
            >
              Use a basic design instead
            </Button>
          ) : undefined
        }
      />
    ) : null;

  const keyCard = keyFormOpen ? (
    <StepCard ref={headingRef} title="Add a model key">
      <KeyForm busy={busy === "key"} onSubmit={saveAndTestKey} />
    </StepCard>
  ) : null;

  const runOutcome = runDisplay && runDisplay.kind !== "pending";

  return (
    <Shell step={step} blocked={!!failure} onReset={() => setConfirmReset(true)}>
      <div className="space-y-5">
        <AgentMessage>
          <p>
            I&apos;ll set up your first agent with you. Tell me what you want it to do, in your own words. I&apos;ll design
            it, check your model key, create it, and run it so you see real output.
          </p>
        </AgentMessage>

        {/* goal */}
        {doc.goal ? (
          <UserMessage>{doc.goal}</UserMessage>
        ) : (
          step === "goal" && <GoalCard ref={keyFormOpen ? undefined : headingRef} busy={busy === "design"} onSubmit={submitGoal} />
        )}
        {step === "goal" && doc.goal && (
          <>
            {busy === "design" && <AgentMessage busy>Designing an agent for that.</AgentMessage>}
            {fixFor("goal")}
            {keyCard}
          </>
        )}

        {/* spec */}
        {reached("spec") && doc.spec && (
          <>
            <AgentMessage>
              <p>
                {doc.spec.rationale ||
                  `Here's a design for “${doc.spec.name}”. Check the instructions and the first task, edit anything, then approve.`}
              </p>
            </AgentMessage>
            {step === "spec" ? (
              <SpecCard ref={headingRef} spec={doc.spec} onApprove={approveSpec} />
            ) : (
              <UserMessage>Approved {doc.spec.name}</UserMessage>
            )}
          </>
        )}

        {/* provider */}
        {reached("provider") && doc.specApproved && (
          <>
            <AgentMessage busy={busy === "provider"}>
              <p>
                Before creating it, I&apos;ll make a real test call to your model provider so the first run doesn&apos;t
                fail on a bad key.
              </p>
            </AgentMessage>
            {step === "provider" && (
              <>
                {fixFor("provider")}
                {keyCard}
                {providerVerified && (
                  <StepCard ref={headingRef} title="Model key verified">
                    <Notice tone="ok">Your {providerVerified === "openai" ? "OpenAI" : "Anthropic"} key answered a test call.</Notice>
                    <div className="mt-4 flex justify-end">
                      <Button variant="primary" size="lg" onClick={() => goTo("create")}>
                        Continue
                      </Button>
                    </div>
                  </StepCard>
                )}
              </>
            )}
            {stepPos(step) > stepPos("provider") && providerVerified && <UserMessage>Key verified ({providerVerified})</UserMessage>}
          </>
        )}

        {/* create */}
        {step === "create" && doc.spec && (
          <>
            <StepCard ref={headingRef} title={`Create ${doc.spec.name}`}>
              <p className={ui.muted}>
                This saves the agent to your workspace with the instructions you approved. Its model is addressed by
                capability (<span className={ui.mono}>{doc.spec.model || "auto"}</span>), so Lantern routes it to a
                provider you have.
              </p>
              <div className="mt-4 flex justify-end">
                <Button variant="primary" size="lg" icon={<Bot className="h-4 w-4" />} loading={busy === "create"} onClick={createAgent}>
                  Create agent
                </Button>
              </div>
            </StepCard>
            {fixFor("create")}
          </>
        )}
        {doc.agentCreated && <UserMessage>Created {doc.agentName}</UserMessage>}

        {/* run */}
        {reached("run") && doc.agentCreated && (
          <>
            <AgentMessage>
              <p>Now the first run. I&apos;ll stream each step as it happens.</p>
            </AgentMessage>
            <RunCard
              ref={step === "run" ? headingRef : undefined}
              spec={doc.spec}
              active={step === "run"}
              busy={busy === "run"}
              lines={runLines}
              display={runDisplay}
              runId={doc.runId}
              priorStatus={doc.runStatus}
              onRun={startRun}
            />
            {step === "run" && fixFor("run")}
            {runOutcome && (
              <div aria-live="polite">
                <AgentMessage>
                  <p>
                    {explanation ??
                      (runDisplay.kind === "succeeded"
                        ? "Your agent ran and returned the output above. Next, you can check it runs inside an isolated sandbox."
                        : "The run failed. The reason is above; fix it and run again.")}
                  </p>
                </AgentMessage>
              </div>
            )}
          </>
        )}

        {/* sandbox */}
        {reached("sandbox") && doc.runStatus === "succeeded" && (
          <>
            <AgentMessage>
              <p>
                Optional: start a microVM, run one command inside it, and shut it down. This is how Lantern isolates
                agents that run code or browse.
              </p>
            </AgentMessage>
            {step === "sandbox" && !sandbox ? (
              <StepCard ref={headingRef} title="Sandbox run">
                <p className={ui.muted}>Uses the small demo image and a 30-second limit.</p>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <Button variant="ghost" onClick={skipSandbox} disabled={busy === "sandbox"}>
                    Skip
                  </Button>
                  <Button variant="primary" size="lg" icon={<Box className="h-4 w-4" />} loading={busy === "sandbox"} onClick={runSandbox}>
                    Run in a sandbox
                  </Button>
                </div>
              </StepCard>
            ) : (
              <SandboxResult display={sandbox} saved={doc.sandbox} active={step === "sandbox"} onContinue={() => goTo("done")} />
            )}
          </>
        )}

        {/* done */}
        {step === "done" && <NextSteps ref={headingRef} agentName={doc.agentName} onFinish={finish} />}
      </div>

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Start over?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={startOver}>
              Start over
            </Button>
          </>
        }
      >
        <p className={ui.muted}>This clears your onboarding progress. Agents you already created stay in your workspace.</p>
      </Modal>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Layout shell
// ---------------------------------------------------------------------------

function Shell({ step, blocked, onReset, children }: { step: Step; blocked: boolean; onReset: () => void; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-0">
      <PageHeader
        title="Set up your first agent"
        description="Describe what you want. Lantern designs, creates and runs it with you."
        secondaryAction={
          <Button variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onReset}>
            Start over
          </Button>
        }
        action={
          <LinkButton href="/agents" variant="secondary">
            Skip to dashboard
          </LinkButton>
        }
      />
      <div className="mx-auto grid max-w-5xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-12 lg:py-10">
        <aside className="sticky top-0 z-10 -mx-4 border-b border-zinc-800 bg-surface-0 px-4 py-3 sm:-mx-6 sm:px-6 lg:top-10 lg:mx-0 lg:self-start lg:border-0 lg:bg-transparent lg:p-0">
          <ProgressRail current={step} blocked={blocked} />
        </aside>
        <main className="min-w-0 max-w-2xl pb-24">{children}</main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step cards
// ---------------------------------------------------------------------------

function GoalCard({
  ref,
  busy,
  onSubmit,
}: {
  ref?: Ref<HTMLHeadingElement>;
  busy: boolean;
  onSubmit: (goal: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const ok = goal.trim().length >= 8;
  const send = () => {
    if (ok && !busy) onSubmit(goal.trim());
  };
  return (
    <StepCard ref={ref} title="What should your agent do?">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label htmlFor="onb-goal" className="sr-only">
          Describe your agent&apos;s job
        </label>
        <textarea
          id="onb-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
          rows={3}
          maxLength={2000}
          placeholder="e.g. Turn my rough meeting notes into a short summary with action items"
          className={clsx(ui.field, "resize-y")}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {GOAL_EXAMPLES.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGoal(g)}
              className="rounded-full border border-zinc-700 px-2.5 py-1 text-left text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lantern-500/40"
            >
              {g}
            </button>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="hidden text-xs text-zinc-500 sm:block">⌘/Ctrl + Enter to send</p>
          <Button type="submit" variant="primary" size="lg" disabled={!ok} loading={busy} className="ml-auto">
            Design my agent
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

function SpecCard({
  ref,
  spec,
  onApprove,
}: {
  ref?: Ref<HTMLHeadingElement>;
  spec: AgentSpecDraft;
  onApprove: (s: AgentSpecDraft) => void;
}) {
  const [name, setName] = useState(spec.name);
  const [description, setDescription] = useState(spec.description);
  const [prompt, setPrompt] = useState(spec.systemPrompt);
  const [task, setTask] = useState(String((spec.firstInput as { prompt?: unknown } | undefined)?.prompt ?? ""));
  const steps = spec.steps ?? [];
  return (
    <StepCard ref={ref} title="Proposed agent">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="onb-name" className={ui.label}>
              Name
            </label>
            <input
              id="onb-name"
              value={name}
              onChange={(e) => setName(normalizeAgentName(e.target.value))}
              className={clsx(ui.field, "font-mono")}
            />
          </div>
          <div>
            <label htmlFor="onb-desc" className={ui.label}>
              Description
            </label>
            <input id="onb-desc" value={description} onChange={(e) => setDescription(e.target.value)} className={ui.field} />
          </div>
        </div>
        <div>
          <label htmlFor="onb-prompt" className={ui.label}>
            Instructions
          </label>
          <textarea
            id="onb-prompt"
            rows={6}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className={clsx(ui.field, "resize-y leading-relaxed")}
          />
        </div>
        <div>
          <label htmlFor="onb-task" className={ui.label}>
            First task to run
          </label>
          <textarea id="onb-task" rows={2} value={task} onChange={(e) => setTask(e.target.value)} className={clsx(ui.field, "resize-y")} />
        </div>
        {steps.length > 0 && (
          <div>
            <p className={ui.label}>Steps</p>
            <ol className="space-y-1.5">
              {steps.map((s, i) => (
                <li key={`${s.name}-${i}`} className="flex gap-2 text-sm">
                  <span className="w-5 shrink-0 text-right text-zinc-500">{i + 1}.</span>
                  <span className="min-w-0">
                    <span className={clsx(ui.mono, "text-zinc-50")}>{s.name}</span>
                    <span className="text-zinc-400">: {s.description}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
        <p className="text-xs text-zinc-500">
          Model <span className={ui.mono}>{spec.model || "auto"}</span>
          {spec.isolation ? (
            <>
              , isolation <span className={ui.mono}>{spec.isolation}</span>
            </>
          ) : null}
        </p>
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="lg"
            onClick={() =>
              onApprove({
                ...spec,
                name,
                description,
                systemPrompt: prompt,
                firstInput: task.trim() ? { ...(spec.firstInput ?? {}), prompt: task.trim() } : spec.firstInput,
              })
            }
          >
            Approve design
          </Button>
        </div>
      </div>
    </StepCard>
  );
}

function KeyForm({ busy, onSubmit }: { busy: boolean; onSubmit: (p: Provider, key: string) => Promise<boolean> }) {
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (key.trim() && (await onSubmit(provider, key.trim()))) setKey("");
      }}
      className="space-y-3"
    >
      <fieldset>
        <legend className={ui.label}>Provider</legend>
        <div className="inline-flex rounded-lg border border-zinc-700 p-0.5">
          {(["anthropic", "openai"] as const).map((p) => (
            <label
              key={p}
              className={clsx(
                "cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium focus-within:ring-2 focus-within:ring-lantern-500/40",
                provider === p ? "bg-surface-3 text-zinc-50" : "text-zinc-400 hover:text-zinc-50",
              )}
            >
              <input type="radio" name="onb-provider" value={p} checked={provider === p} onChange={() => setProvider(p)} className="sr-only" />
              {p === "openai" ? "OpenAI" : "Anthropic"}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor="onb-key" className={ui.label}>
          API key
        </label>
        <div className="relative">
          <input
            id="onb-key"
            type={show ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={provider === "openai" ? "sk-…" : "sk-ant-…"}
            className={clsx(ui.field, "pr-10 font-mono")}
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            aria-label={show ? "Hide key" : "Show key"}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 hover:text-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lantern-500/40"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <p className="mt-1.5 text-xs text-zinc-500">Stored encrypted for your workspace. I&apos;ll send one small test request.</p>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" size="lg" disabled={!key.trim()} loading={busy}>
          Test key
        </Button>
      </div>
    </form>
  );
}

function RunCard({
  ref,
  spec,
  active,
  busy,
  lines,
  display,
  runId,
  priorStatus,
  onRun,
}: {
  ref?: Ref<HTMLHeadingElement>;
  spec?: AgentSpecDraft;
  active: boolean;
  busy: boolean;
  lines: string[];
  display: RunDisplay | null;
  runId?: string;
  priorStatus?: string;
  onRun: (input: unknown) => void;
}) {
  const [input, setInput] = useState(() => JSON.stringify(firstRunInput(spec), null, 2));
  const [inputError, setInputError] = useState<string | null>(null);
  return (
    <StepCard ref={ref} title="First run">
      {active && (
        <>
          <label htmlFor="onb-input" className={ui.label}>
            Input
          </label>
          <textarea
            id="onb-input"
            rows={4}
            spellCheck={false}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setInputError(null);
            }}
            className={clsx(ui.field, "resize-y font-mono text-xs")}
          />
          {inputError && <p className={clsx("mt-1 text-xs", ui.bad)}>{inputError}</p>}
        </>
      )}
      {(lines.length > 0 || busy) && (
        <ol
          aria-label="Run events"
          aria-live="polite"
          className="mt-3 space-y-1 rounded-lg border border-zinc-800 bg-surface-2 p-3 font-mono text-xs text-zinc-300"
        >
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
          {busy && <li className="text-zinc-500 motion-safe:animate-pulse">Waiting for events</li>}
        </ol>
      )}
      {display?.kind === "succeeded" && (
        <div className="mt-3">
          <Notice tone="ok">Run succeeded</Notice>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-surface-2 p-3 text-sm text-zinc-50">
            {runOutputText(display.output) || "(no output)"}
          </pre>
        </div>
      )}
      {display?.kind === "pending" && <p className={clsx("mt-3", ui.muted)}>The run is still going. Its result will be on the Runs page.</p>}
      {!display && !active && priorStatus === "succeeded" && <Notice tone="ok">First run succeeded.</Notice>}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        {runId ? (
          <Link href={`/runs/${encodeURIComponent(runId)}`} className="text-xs text-zinc-400 underline-offset-2 hover:text-zinc-50 hover:underline">
            Open run details
          </Link>
        ) : (
          <span />
        )}
        {active && (
          <Button
            variant="primary"
            size="lg"
            icon={<Play className="h-4 w-4" />}
            loading={busy}
            onClick={() => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(input);
              } catch {
                setInputError("Input must be valid JSON.");
                return;
              }
              onRun(parsed);
            }}
          >
            {display?.kind === "failed" || priorStatus === "failed" ? "Run again" : "Run it"}
          </Button>
        )}
      </div>
    </StepCard>
  );
}

function SandboxResult({
  display,
  saved,
  active,
  onContinue,
}: {
  display: SandboxDisplay | null;
  saved?: string;
  active: boolean;
  onContinue: () => void;
}) {
  if (!display) {
    return <UserMessage>{saved === "skipped" ? "Skipped the sandbox" : `Sandbox: ${saved ?? "skipped"}`}</UserMessage>;
  }
  return (
    <div className="ml-0 space-y-3 sm:ml-10" aria-live="polite">
      {display.kind === "ran" && (
        <>
          <Notice tone="ok">Ran in microVM {display.vmId}, then shut it down.</Notice>
          <pre className="overflow-auto rounded-lg border border-zinc-800 bg-surface-2 p-3 font-mono text-xs text-zinc-50">{display.stdout}</pre>
        </>
      )}
      {display.kind === "unavailable" && (
        <Notice tone="off">
          <p className="font-medium text-zinc-50">Sandbox unavailable on this stack</p>
          <p className="mt-1 text-zinc-400">{display.reason}</p>
          <p className="mt-1 text-zinc-400">
            Nothing ran. Run <span className={ui.mono}>lantern doctor</span> to see what the runtime needs (scheduler,
            runtime manager, KVM).
          </p>
        </Notice>
      )}
      {display.kind === "failed" && <Notice tone="warn">Sandbox run failed: {display.error}</Notice>}
      {active && (
        <div className="flex justify-end">
          <Button variant="primary" onClick={onContinue}>
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}

function NextSteps({ ref, agentName, onFinish }: { ref?: Ref<HTMLHeadingElement>; agentName?: string; onFinish: () => void }) {
  const items = [
    { href: "/surfaces", icon: MessageSquare, title: "Connect a channel", text: "Put the agent on Slack, WhatsApp, or a web chat." },
    { href: "/budgets", icon: Gauge, title: "Set a budget", text: "Cap spend per run and per day before real traffic." },
    { href: "/eval-suites", icon: FlaskConical, title: "Add an eval", text: "Pin expected answers so changes can't regress it." },
  ];
  return (
    <>
      <AgentMessage>
        <p>
          {agentName ? (
            <>
              <span className={ui.mono}>{agentName}</span> is live in your workspace.{" "}
            </>
          ) : null}
          Here&apos;s what most teams do next.
        </p>
      </AgentMessage>
      <StepCard ref={ref} title="Next steps">
        <ul className="grid gap-2 sm:grid-cols-3">
          {items.map((it) => (
            <li key={it.title}>
              <Link
                href={it.href}
                className="flex h-full flex-col gap-1 rounded-lg border border-zinc-800 bg-surface-2 p-3 transition-colors hover:border-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lantern-500/40"
              >
                <it.icon className="h-4 w-4 text-lantern-300" aria-hidden />
                <span className="text-sm font-medium text-zinc-50">{it.title}</span>
                <span className="text-xs text-zinc-400">{it.text}</span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" size="lg" onClick={onFinish}>
            {agentName ? "Open my agent" : "Go to the dashboard"}
          </Button>
        </div>
      </StepCard>
    </>
  );
}
