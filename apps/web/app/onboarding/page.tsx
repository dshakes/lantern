"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Check,
  Code,
  Wand2,
  Workflow,
  MessageSquare,
  Calendar,
  ShieldCheck,
  Eye,
  EyeOff,
  Loader2,
  Play,
  Sparkles,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";
import {
  decideProviderSave,
  decideAgentCreate,
  decideRunDisplay,
  isTerminalRunStatus,
  type RunDisplay,
} from "./onboarding-logic";

// ---------------------------------------------------------------------------
// Templates (same 6 as the create modal)
// ---------------------------------------------------------------------------

const templates = [
  {
    id: "blank",
    name: "Blank agent",
    desc: "Start from scratch",
    icon: Code,
    defaultInput: '{\n  "task": "Hello world"\n}',
  },
  {
    id: "research",
    name: "Research agent",
    desc: "Web search and synthesis",
    icon: Wand2,
    defaultInput: '{\n  "query": "Latest advances in quantum computing 2026",\n  "depth": "comprehensive"\n}',
  },
  {
    id: "connector",
    name: "Connector agent",
    desc: "Integrates with external services",
    icon: Workflow,
    defaultInput: '{\n  "source": "slack",\n  "action": "send_message",\n  "channel": "#general"\n}',
  },
  {
    id: "chatbot",
    name: "Conversational agent",
    desc: "WhatsApp, Slack, or web chat",
    icon: MessageSquare,
    defaultInput: '{\n  "message": "What can you help me with?",\n  "channel": "web"\n}',
  },
  {
    id: "scheduled",
    name: "Scheduled pipeline",
    desc: "Runs on a cron schedule",
    icon: Calendar,
    defaultInput: '{\n  "source": "s3://data/input.csv",\n  "destination": "warehouse.daily"\n}',
  },
  {
    id: "approval",
    name: "Human-in-the-loop",
    desc: "Approval gates and review flows",
    icon: ShieldCheck,
    defaultInput: '{\n  "document": "proposal-v3.pdf",\n  "approvers": ["alice@acme.dev", "bob@acme.dev"]\n}',
  },
];

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={clsx(
            "h-2 rounded-full transition-all duration-300",
            i === current ? "w-8 bg-lantern-500" : i < current ? "w-2 bg-lantern-500/50" : "w-2 bg-zinc-700"
          )}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline error banner — surfaces a REAL backend failure near the step that
// produced it. Never auto-dismisses; the user must fix the underlying cause.
// ---------------------------------------------------------------------------

function InlineError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5"
    >
      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
      <p className="text-xs text-red-300">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Onboarding page
// ---------------------------------------------------------------------------

export default function OnboardingPage() {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState(0);

  // Step 2: LLM provider
  const [openaiKey, setOpenaiKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [showOpenai, setShowOpenai] = useState(false);
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState<Record<string, "untested" | "ok" | "error">>({
    openai: "untested",
    anthropic: "untested",
  });
  // Real, surfaced provider errors (the message the backend / test returned).
  const [providerError, setProviderError] = useState<Record<string, string | null>>({
    openai: null,
    anthropic: null,
  });
  const [savingProviders, setSavingProviders] = useState(false);
  // Honest "skip" acknowledgement — the bot will NOT run without a key.
  const [skipAck, setSkipAck] = useState(false);

  // Step 3: Create agent
  const [selectedTemplate, setSelectedTemplate] = useState("research");
  const [agentName, setAgentName] = useState("my-first-agent");
  const [creatingAgent, setCreatingAgent] = useState(false);
  // Set ONLY on a real 2xx from createAgent — gates the success banner.
  const [agentCreated, setAgentCreated] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Step 4: Run it
  const [inputJson, setInputJson] = useState("");
  const [running, setRunning] = useState(false);
  // The real run outcome (terminal status / output) or the real error.
  const [runDisplay, setRunDisplay] = useState<RunDisplay | null>(null);

  // Update input JSON when template changes
  useEffect(() => {
    const tmpl = templates.find((t) => t.id === selectedTemplate);
    if (tmpl) setInputJson(tmpl.defaultInput);
  }, [selectedTemplate]);

  // Provider test — saves the key, then asks the backend to round-trip a
  // noop completion. Marks "ok" only on a real success; on any failure it
  // surfaces the REAL error (thrown request, or the /test failure reason)
  // both inline and as a toast. Returns true only on a genuine success so
  // callers can gate on it.
  const handleTestProvider = useCallback(
    async (provider: "openai" | "anthropic"): Promise<boolean> => {
      const key = provider === "openai" ? openaiKey : anthropicKey;
      if (!key.trim()) return false;
      setTestingProvider(provider);
      setProviderError((prev) => ({ ...prev, [provider]: null }));

      let saveError: unknown | null = null;
      let testResult: Awaited<ReturnType<typeof api.testLlmProvider>> | null = null;
      try {
        await api.saveLlmProvider(provider, key);
        testResult = await api.testLlmProvider(provider);
      } catch (err) {
        saveError = err;
      } finally {
        setTestingProvider(null);
      }

      const outcome = decideProviderSave(saveError, testResult);
      if (outcome.ok) {
        setProviderStatus((prev) => ({ ...prev, [provider]: "ok" }));
        setProviderError((prev) => ({ ...prev, [provider]: null }));
        return true;
      }
      setProviderStatus((prev) => ({ ...prev, [provider]: "error" }));
      setProviderError((prev) => ({ ...prev, [provider]: outcome.error }));
      toast.error(`${provider}: ${outcome.error}`);
      return false;
    },
    [openaiKey, anthropicKey, toast]
  );

  // Create the user's first agent against the real backend. Returns true ONLY
  // on a real 2xx. On failure it surfaces the real error inline + via toast and
  // does NOT mark the agent created — the caller must not advance.
  const handleCreateAgent = async (): Promise<boolean> => {
    if (!agentName.trim()) return false;
    setCreatingAgent(true);
    setCreateError(null);
    const tmpl = templates.find((t) => t.id === selectedTemplate);

    let createError: unknown | null = null;
    try {
      await api.createAgent({
        name: agentName.trim().toLowerCase().replace(/\s+/g, "-"),
        description: tmpl?.desc ?? "Created from onboarding",
        template: selectedTemplate,
      });
    } catch (err) {
      createError = err;
    } finally {
      setCreatingAgent(false);
    }

    const outcome = decideAgentCreate(createError);
    if (outcome.ok) {
      setAgentCreated(true);
      return true;
    }
    setAgentCreated(false);
    setCreateError(outcome.error);
    toast.error(outcome.error);
    return false;
  };

  // Kick off a REAL run, poll it to a terminal status, and render the actual
  // result (output) or the real error. We never claim success blindly, and we
  // only mark onboarding complete + navigate once the user has seen a real
  // terminal outcome.
  const handleRun = async () => {
    setRunning(true);
    setRunDisplay(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputJson);
    } catch {
      parsed = { input: inputJson };
    }

    let display: RunDisplay;
    try {
      const created = await api.createRun({
        agentName: agentName.trim().toLowerCase().replace(/\s+/g, "-"),
        input: parsed,
      });
      // Poll the run to terminal (bounded). Render whatever it actually does.
      let run = created;
      const deadline = Date.now() + 60_000;
      while (!isTerminalRunStatus(run.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        run = await api.getRun(run.id);
      }
      display = decideRunDisplay(run, null);
    } catch (err) {
      display = decideRunDisplay(null, err);
    }

    setRunDisplay(display);
    setRunning(false);

    if (display.kind === "succeeded") {
      // Cosmetic-only flag: whether the welcome wizard reappears. Does NOT
      // affect whether anything actually runs.
      if (typeof window !== "undefined") {
        localStorage.setItem("lantern_onboarding_complete", "true");
      }
      toast.success("Run succeeded — taking you to your agents");
      router.push("/agents");
    } else if (display.kind === "failed") {
      toast.error(display.error);
    } else {
      toast.info("Run is still in progress — check the Runs page for the result.");
    }
  };

  // Persist provider keys on continue. Saving here as well as in Test catches
  // the "user typed a key but didn't click Test" case. On any failure we
  // surface the REAL error and stay on this step — we never silently advance
  // with a key that never persisted.
  const handleProviderContinue = async () => {
    // Nothing entered → this is the explicit "skip" path; handled by its own
    // button. If we got here with no key, just advance (nothing to save).
    if (!openaiKey.trim() && !anthropicKey.trim()) {
      setStep(2);
      return;
    }

    setSavingProviders(true);
    let ok = true;
    if (openaiKey.trim()) ok = (await handleTestProvider("openai")) && ok;
    if (anthropicKey.trim()) ok = (await handleTestProvider("anthropic")) && ok;
    setSavingProviders(false);

    // handleTestProvider already surfaced inline errors + a toast for any
    // failure. Only advance when every entered key actually saved + tested ok.
    if (ok) setStep(2);
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-0">
      {/* Background grid */}
      <div className="fixed inset-0 grid-bg opacity-50" />

      {/* Glow behind card */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[500px] w-[500px] rounded-full bg-lantern-500/5 blur-[120px]" />

      <div className="relative z-10 w-full max-w-xl px-4">
        {/* Progress */}
        <div className="mb-8 flex justify-center">
          <StepIndicator current={step} total={4} />
        </div>

        {/* ----------------------------------------------------------------
            Step 0: Welcome
        ---------------------------------------------------------------- */}
        {step === 0 && (
          <div className="text-center">
            {/* Logo */}
            <div className="mb-6 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-lantern-400 to-lantern-600 shadow-xl shadow-lantern-500/30">
                <span className="text-2xl font-bold text-white leading-none">L</span>
              </div>
            </div>

            <h1 className="mb-3 text-3xl font-bold tracking-tight text-zinc-100">
              Welcome to Lantern
            </h1>
            <p className="mx-auto mb-8 max-w-md text-base text-zinc-400">
              The serverless platform for production AI agents. Durable execution, microVM isolation, multi-LLM routing — all in one place.
            </p>

            <button
              onClick={() => setStep(1)}
              className="inline-flex items-center gap-2 rounded-xl bg-lantern-500 px-6 py-3 text-base font-medium text-white transition-all hover:bg-lantern-400 hover:shadow-lg hover:shadow-lantern-500/20"
            >
              Get Started
              <ArrowRight className="h-4 w-4" />
            </button>

            <p className="mt-4 text-xs text-zinc-600">
              Takes about 2 minutes to set up
            </p>
          </div>
        )}

        {/* ----------------------------------------------------------------
            Step 1: Configure LLM Provider
        ---------------------------------------------------------------- */}
        {step === 1 && (
          <div className="rounded-2xl border border-zinc-800 bg-surface-1 p-8 shadow-2xl">
            <div className="mb-6 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-lantern-500/10">
                <Sparkles className="h-5 w-5 text-lantern-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">
                  Configure LLM Provider
                </h2>
                <p className="text-sm text-zinc-500">
                  Add at least one LLM provider to get started.
                </p>
              </div>
            </div>

            <div className="space-y-4">
              {/* OpenAI */}
              <div className="rounded-xl border border-zinc-800 bg-surface-2 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-3">
                      <span className="text-xs font-bold text-emerald-400">AI</span>
                    </div>
                    <span className="text-sm font-medium text-zinc-200">OpenAI</span>
                  </div>
                  {providerStatus.openai === "ok" && (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                      <Check className="h-3 w-3" /> Connected
                    </span>
                  )}
                  {providerStatus.openai === "error" && (
                    <span className="text-xs text-red-400">Failed</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showOpenai ? "text" : "password"}
                      value={openaiKey}
                      onChange={(e) => {
                        setOpenaiKey(e.target.value);
                        setProviderStatus((p) => ({ ...p, openai: "untested" }));
                        setProviderError((p) => ({ ...p, openai: null }));
                      }}
                      placeholder="sk-..."
                      className="w-full rounded-lg border border-zinc-700 bg-surface-3 px-3 py-2 pr-10 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30 font-mono"
                    />
                    <button
                      onClick={() => setShowOpenai(!showOpenai)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors hover:text-zinc-300"
                    >
                      {showOpenai ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <button
                    onClick={() => void handleTestProvider("openai")}
                    disabled={!openaiKey.trim() || testingProvider === "openai"}
                    className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {testingProvider === "openai" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "Test"
                    )}
                  </button>
                </div>
                {providerError.openai && <InlineError message={providerError.openai} />}
              </div>

              {/* Anthropic */}
              <div className="rounded-xl border border-zinc-800 bg-surface-2 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-3">
                      <span className="text-xs font-bold text-orange-400">A</span>
                    </div>
                    <span className="text-sm font-medium text-zinc-200">Anthropic</span>
                  </div>
                  {providerStatus.anthropic === "ok" && (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                      <Check className="h-3 w-3" /> Connected
                    </span>
                  )}
                  {providerStatus.anthropic === "error" && (
                    <span className="text-xs text-red-400">Failed</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showAnthropic ? "text" : "password"}
                      value={anthropicKey}
                      onChange={(e) => {
                        setAnthropicKey(e.target.value);
                        setProviderStatus((p) => ({ ...p, anthropic: "untested" }));
                        setProviderError((p) => ({ ...p, anthropic: null }));
                      }}
                      placeholder="sk-ant-..."
                      className="w-full rounded-lg border border-zinc-700 bg-surface-3 px-3 py-2 pr-10 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30 font-mono"
                    />
                    <button
                      onClick={() => setShowAnthropic(!showAnthropic)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 transition-colors hover:text-zinc-300"
                    >
                      {showAnthropic ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <button
                    onClick={() => void handleTestProvider("anthropic")}
                    disabled={!anthropicKey.trim() || testingProvider === "anthropic"}
                    className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {testingProvider === "anthropic" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "Test"
                    )}
                  </button>
                </div>
                {providerError.anthropic && <InlineError message={providerError.anthropic} />}
              </div>
            </div>

            {/* Honest skip: the bot will NOT run without a provider key. We
                make the user acknowledge that, and we never later claim
                success on their behalf. */}
            {skipAck && (
              <div className="mt-5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <p className="text-xs text-amber-300">
                  Heads up: without an LLM provider key, your agent can be
                  created but <span className="font-medium">runs will fail</span> —
                  there is no model to call. Add a key here or later in Settings,
                  then come back to run it. Click skip again to continue anyway.
                </p>
              </div>
            )}

            <div className="mt-6 flex items-center justify-between">
              <button
                onClick={() => {
                  // Honest skip — no demo-mode flag, no fabricated success.
                  // First click warns; second click proceeds.
                  if (!skipAck) {
                    setSkipAck(true);
                    return;
                  }
                  setStep(2);
                }}
                className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
              >
                {skipAck ? "Skip anyway — I'll add a key later" : "Skip for now"}
              </button>
              <button
                onClick={handleProviderContinue}
                disabled={savingProviders || testingProvider !== null}
                className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingProviders ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Testing...
                  </>
                ) : (
                  <>
                    {openaiKey || anthropicKey ? "Test & Continue" : "Continue"}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ----------------------------------------------------------------
            Step 2: Create your first agent
        ---------------------------------------------------------------- */}
        {step === 2 && (
          <div className="rounded-2xl border border-zinc-800 bg-surface-1 p-8 shadow-2xl">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-zinc-100">
                Create your first agent
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                Pick a template to start with. You can customize everything later.
              </p>
            </div>

            {/* Template grid */}
            <div className="mb-5 grid grid-cols-2 gap-2">
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelectedTemplate(t.id)}
                  className={clsx(
                    "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all",
                    selectedTemplate === t.id
                      ? "border-lantern-500 bg-lantern-500/10 text-zinc-100"
                      : "border-zinc-800 bg-surface-2 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                  )}
                >
                  <t.icon className="h-4 w-4 shrink-0" />
                  <div>
                    <div className="text-xs font-medium">{t.name}</div>
                    <div className="text-[11px] text-zinc-500">{t.desc}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* Agent name */}
            <div className="mb-6">
              <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                Agent name
              </label>
              <input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="my-agent"
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
              />
              <p className="mt-1 text-xs text-zinc-600">
                Lowercase, hyphens only. e.g. research-agent
              </p>
            </div>

            {createError && <InlineError message={createError} />}

            <div className="mt-6 flex items-center justify-between">
              <button
                onClick={() => setStep(1)}
                className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
              >
                Back
              </button>
              <button
                onClick={async () => {
                  // Advance ONLY on a real 2xx. On failure handleCreateAgent
                  // surfaces the real error inline + toast and we stay here.
                  const ok = await handleCreateAgent();
                  if (ok) setStep(3);
                }}
                disabled={!agentName.trim() || creatingAgent}
                className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creatingAgent ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    Create Agent
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ----------------------------------------------------------------
            Step 3: Run it
        ---------------------------------------------------------------- */}
        {step === 3 && (
          <div className="rounded-2xl border border-zinc-800 bg-surface-1 p-8 shadow-2xl">
            <div className="mb-6">
              {/* Success banner — gated on a REAL 2xx create. We never claim
                  the agent was created unless the backend confirmed it. */}
              {agentCreated && (
                <div className="mb-4 flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
                  <Check className="h-5 w-5 text-emerald-400" />
                  <div>
                    <p className="text-sm font-medium text-emerald-400">
                      Agent created
                    </p>
                    <p className="text-xs text-emerald-400/70">
                      <span className="font-mono">{agentName}</span> was created using the{" "}
                      {templates.find((t) => t.id === selectedTemplate)?.name} template.
                    </p>
                  </div>
                </div>
              )}

              <h2 className="text-lg font-semibold text-zinc-100">
                Run your agent
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                Try it out with some sample input. You can edit the JSON below.
              </p>
            </div>

            {/* Input JSON editor */}
            <div className="mb-6">
              <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                Input JSON
              </label>
              <textarea
                value={inputJson}
                onChange={(e) => setInputJson(e.target.value)}
                rows={6}
                spellCheck={false}
                className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30 resize-none"
              />
            </div>

            {/* Real run outcome — the ACTUAL terminal result of the run, or
                the real error. Never an unconditional "success". */}
            {runDisplay?.kind === "succeeded" && (
              <div className="mb-6">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-emerald-400">
                  <Check className="h-4 w-4" /> Run succeeded
                </div>
                <pre className="max-h-48 overflow-auto rounded-lg border border-zinc-800 bg-surface-2 px-3 py-2 font-mono text-xs text-zinc-300">
                  {typeof runDisplay.output === "string"
                    ? runDisplay.output
                    : JSON.stringify(runDisplay.output, null, 2)}
                </pre>
              </div>
            )}
            {runDisplay?.kind === "failed" && (
              <InlineError message={`Run failed: ${runDisplay.error}`} />
            )}
            {runDisplay?.kind === "pending" && (
              <div className="mb-6 flex items-center gap-2 text-xs text-zinc-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Run is still in progress — check the Runs page for the final result.
              </div>
            )}

            <div className="mt-6 flex items-center justify-between">
              <button
                onClick={() => setStep(2)}
                className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
              >
                Back
              </button>
              <button
                onClick={handleRun}
                disabled={running}
                className="inline-flex items-center gap-2 rounded-xl bg-lantern-500 px-6 py-3 text-sm font-medium text-white transition-all hover:bg-lantern-400 hover:shadow-lg hover:shadow-lantern-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {running ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Starting run...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    Run your agent
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
