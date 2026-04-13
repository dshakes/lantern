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
} from "lucide-react";
import clsx from "clsx";

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
// Onboarding page
// ---------------------------------------------------------------------------

export default function OnboardingPage() {
  const router = useRouter();
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

  // Step 3: Create agent
  const [selectedTemplate, setSelectedTemplate] = useState("research");
  const [agentName, setAgentName] = useState("my-first-agent");
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [agentCreated, setAgentCreated] = useState(false);

  // Step 4: Run it
  const [inputJson, setInputJson] = useState("");
  const [running, setRunning] = useState(false);

  // Update input JSON when template changes
  useEffect(() => {
    const tmpl = templates.find((t) => t.id === selectedTemplate);
    if (tmpl) setInputJson(tmpl.defaultInput);
  }, [selectedTemplate]);

  // Provider test
  const handleTestProvider = useCallback(
    async (provider: "openai" | "anthropic") => {
      const key = provider === "openai" ? openaiKey : anthropicKey;
      if (!key.trim()) return;
      setTestingProvider(provider);
      await new Promise((r) => setTimeout(r, 1200));
      const success = key.length >= 10;
      setProviderStatus((prev) => ({
        ...prev,
        [provider]: success ? "ok" : "error",
      }));
      setTestingProvider(null);
    },
    [openaiKey, anthropicKey]
  );

  // Create agent
  const handleCreateAgent = async () => {
    if (!agentName.trim()) return;
    setCreatingAgent(true);
    await new Promise((r) => setTimeout(r, 800));
    setCreatingAgent(false);
    setAgentCreated(true);
  };

  // Run agent
  const handleRun = async () => {
    setRunning(true);
    await new Promise((r) => setTimeout(r, 1200));

    // Save onboarding complete flag
    if (typeof window !== "undefined") {
      localStorage.setItem("lantern_onboarding_complete", "true");
    }

    // Navigate to the agents dashboard
    router.push("/agents");
  };

  // Proceed to next step from step 2 (provider config)
  const handleProviderContinue = () => {
    // Save provider keys if entered
    if (typeof window !== "undefined") {
      const providers = {
        openai: { key: openaiKey, status: openaiKey ? "connected" : "not_configured" },
        anthropic: { key: anthropicKey, status: anthropicKey ? "connected" : "not_configured" },
        google: { key: "", status: "not_configured" },
      };
      localStorage.setItem("lantern_settings_providers", JSON.stringify(providers));
    }
    setStep(2);
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
                    <span className="text-xs text-red-400">Invalid key</span>
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
                    onClick={() => handleTestProvider("openai")}
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
                    <span className="text-xs text-red-400">Invalid key</span>
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
                    onClick={() => handleTestProvider("anthropic")}
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
              </div>
            </div>

            <div className="mt-6 flex items-center justify-between">
              <button
                onClick={() => {
                  // Skip — save demo mode flag
                  if (typeof window !== "undefined") {
                    localStorage.setItem("lantern_settings_demo_mode", "true");
                  }
                  setStep(2);
                }}
                className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
              >
                Skip for now (demo mode)
              </button>
              <button
                onClick={handleProviderContinue}
                className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-lantern-400"
              >
                {openaiKey || anthropicKey ? "Test & Continue" : "Continue"}
                <ArrowRight className="h-4 w-4" />
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

            <div className="flex items-center justify-between">
              <button
                onClick={() => setStep(1)}
                className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
              >
                Back
              </button>
              <button
                onClick={async () => {
                  await handleCreateAgent();
                  setStep(3);
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
              {/* Success banner */}
              <div className="mb-4 flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
                <Check className="h-5 w-5 text-emerald-400" />
                <div>
                  <p className="text-sm font-medium text-emerald-400">
                    Agent created successfully
                  </p>
                  <p className="text-xs text-emerald-400/70">
                    <span className="font-mono">{agentName}</span> is ready to run using the{" "}
                    {templates.find((t) => t.id === selectedTemplate)?.name} template.
                  </p>
                </div>
              </div>

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

            <div className="flex items-center justify-between">
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
