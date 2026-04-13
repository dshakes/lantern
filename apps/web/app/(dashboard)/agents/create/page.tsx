"use client";

import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Sparkles,
  Loader2,
  Check,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  Rocket,
  Code2,
  FileText,
  X,
  Brain,
  Wrench,
  Plug,
  GitBranch,
  Repeat,
  ShieldCheck,
  Send,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import type { AgentSpec, AgentSpecStep, AgentSpecTrigger } from "@/lib/api";
import { useToast } from "@/components/toast";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLACEHOLDER_EXAMPLES = [
  "Research a topic and produce a report with citations",
  "Monitor my GitHub PRs and auto-review for security issues",
  "Answer customer support tickets using our knowledge base",
  "Scrape competitor pricing daily and alert on changes",
  "Summarize Slack threads and post daily digests",
  "Classify incoming emails and route to the right team",
];

const STEP_TYPES = [
  { value: "llm", label: "LLM", icon: Brain, color: "text-indigo-400" },
  { value: "tool", label: "Tool", icon: Wrench, color: "text-blue-400" },
  { value: "connector", label: "Connector", icon: Plug, color: "text-teal-400" },
  { value: "condition", label: "Condition", icon: GitBranch, color: "text-yellow-400" },
  { value: "loop", label: "Loop", icon: Repeat, color: "text-purple-400" },
  { value: "approval", label: "Approval", icon: ShieldCheck, color: "text-red-400" },
] as const;

const AVAILABLE_TOOLS = [
  "web-search",
  "python-exec",
  "fs-read",
  "fs-write",
  "browser",
  "code-interpreter",
];

const AVAILABLE_CONNECTORS = [
  "gmail",
  "slack",
  "github",
  "linear",
  "notion",
  "stripe",
  "google-calendar",
  "jira",
  "discord",
];

const AVAILABLE_SURFACES = [
  "whatsapp",
  "slack",
  "discord",
  "telegram",
  "twilio",
  "email",
  "webchat",
];

const ISOLATION_LEVELS = [
  { value: "trusted", label: "Trusted", desc: "Direct execution, no sandbox" },
  {
    value: "standard",
    label: "Standard",
    desc: "Lightweight container isolation",
  },
  {
    value: "untrusted",
    label: "Untrusted",
    desc: "Full microVM sandbox (Firecracker)",
  },
];

// ---------------------------------------------------------------------------
// Wizard steps
// ---------------------------------------------------------------------------

const WIZARD_STEPS = [
  { key: "describe", label: "Describe", icon: Sparkles },
  { key: "review", label: "Review Spec", icon: FileText },
  { key: "code", label: "Generated Code", icon: Code2 },
  { key: "deploy", label: "Create", icon: Rocket },
] as const;

type WizardStep = (typeof WIZARD_STEPS)[number]["key"];

// ---------------------------------------------------------------------------
// Local spec generation (template-based, no LLM needed)
// ---------------------------------------------------------------------------

function generateSpecLocally(description: string): AgentSpec {
  const words = description
    .trim()
    .toLowerCase()
    .split(/\s+/);
  const agentName =
    words
      .slice(0, 3)
      .join("-")
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 30) || "my-agent";

  // Detect intent from keywords
  const desc = description.toLowerCase();
  const hasSearch = desc.includes("search") || desc.includes("research") || desc.includes("find");
  const hasSlack = desc.includes("slack");
  const hasEmail = desc.includes("email") || desc.includes("gmail");
  const hasGithub = desc.includes("github") || desc.includes("pr") || desc.includes("pull request");
  const hasSchedule = desc.includes("daily") || desc.includes("schedule") || desc.includes("cron");
  const hasApproval = desc.includes("approval") || desc.includes("review") || desc.includes("human");

  const steps: AgentSpecStep[] = [
    {
      name: "analyze-input",
      type: "llm",
      description: "Analyze the user input and determine the plan",
      config: {},
    },
  ];

  if (hasSearch) {
    steps.push({
      name: "search-web",
      type: "tool",
      description: "Search the web for relevant information",
      config: {},
    });
  }

  steps.push({
    name: "execute",
    type: "llm",
    description: "Execute the main task based on the plan",
    config: {},
  });

  if (hasApproval) {
    steps.push({
      name: "human-review",
      type: "approval",
      description: "Wait for human approval before proceeding",
      config: {},
    });
  }

  steps.push({
    name: "summarize",
    type: "llm",
    description: "Summarize the results into a final output",
    config: {},
  });

  const tools: string[] = [];
  if (hasSearch) tools.push("web-search");

  const connectors: string[] = [];
  if (hasSlack) connectors.push("slack");
  if (hasEmail) connectors.push("gmail");
  if (hasGithub) connectors.push("github");

  const surfaces: string[] = [];
  if (hasSlack) surfaces.push("slack");

  const triggers: AgentSpecTrigger[] = [{ type: "manual", config: {} }];
  if (hasSchedule) {
    triggers.push({ type: "schedule", config: { cron: "0 9 * * *" } });
  }

  return {
    name: agentName,
    description: description.trim(),
    model: "auto",
    steps,
    tools,
    connectors,
    surfaces,
    triggers,
    isolation: "standard",
    limits: { timeout: "5m", maxTokens: 100000, maxCostUsd: 1.0 },
  };
}

function generateLocalCode(spec: AgentSpec): { code: string; yaml: string } {
  const camel = (s: string) =>
    s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  const stepsCode = spec.steps
    .map((step) => {
      const varName = camel(step.name);
      switch (step.type) {
        case "llm":
          return `    // ${step.description || step.name}
    const ${varName} = await step("${step.name}", async () => {
      return ctx.llm.generate({
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: JSON.stringify(ctx.input) },
        ],
      });
    });`;
        case "tool":
          return `    // ${step.description || step.name}
    const ${varName} = await step("${step.name}", async () => {
      return ctx.mcp("${spec.tools[0] || "web-search"}").call("execute", {
        query: ctx.input.query,
      });
    });`;
        case "connector":
          return `    // ${step.description || step.name}
    const ${varName} = await step("${step.name}", async () => {
      return ctx.connectors.${spec.connectors[0] || "slack"}.send_message({
        channel: "#general",
        text: "Agent completed",
      });
    });`;
        case "approval":
          return `    // ${step.description || step.name}
    const ${varName} = await step("${step.name}", async () => {
      return ctx.requestApproval({
        message: "Please review and approve this action.",
      });
    });`;
        default:
          return `    // ${step.description || step.name}
    const ${varName} = await step("${step.name}", async () => {
      // TODO: implement ${step.name}
      return {};
    });`;
      }
    })
    .join("\n\n");

  const code = `import { Agent, step } from "@lantern/sdk";

export default new Agent({
  name: "${spec.name}",
  model: "${spec.model}",

  async run(ctx) {
${stepsCode}

    return { success: true };
  },
});
`;

  const yaml = `name: ${spec.name}
description: ${spec.description}
model: ${spec.model}
isolation: ${spec.isolation}
limits:
  timeout: ${spec.limits.timeout}
  maxTokens: ${spec.limits.maxTokens}
  maxCostUsd: ${spec.limits.maxCostUsd}
triggers:
${spec.triggers.map((t) => `  - type: ${t.type}`).join("\n")}
tools: [${spec.tools.join(", ")}]
connectors: [${spec.connectors.join(", ")}]
surfaces: [${spec.surfaces.join(", ")}]
`;

  return { code, yaml };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AgentCreatePageWrapper() {
  return (
    <Suspense fallback={<CreatePageSkeleton />}>
      <AgentCreatePage />
    </Suspense>
  );
}

function CreatePageSkeleton() {
  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-4">
        <div className="mb-4 h-3 w-24 animate-pulse rounded bg-surface-3" />
        <div className="h-6 w-48 animate-pulse rounded bg-surface-3" />
        <div className="mt-5 flex gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-8 w-28 animate-pulse rounded-lg bg-surface-3"
            />
          ))}
        </div>
      </div>
      <div className="flex-1 p-8">
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="mx-auto h-14 w-14 animate-pulse rounded-2xl bg-surface-3" />
          <div className="mx-auto h-6 w-64 animate-pulse rounded bg-surface-3" />
          <div className="h-32 w-full animate-pulse rounded-xl bg-surface-3" />
          <div className="h-12 w-full animate-pulse rounded-xl bg-surface-3" />
        </div>
      </div>
    </div>
  );
}

function AgentCreatePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const templateParam = searchParams.get("template");

  const [currentStep, setCurrentStep] = useState<WizardStep>("describe");
  const [description, setDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [spec, setSpec] = useState<AgentSpec | null>(null);
  const [generatedCode, setGeneratedCode] = useState<{
    code: string;
    yaml: string;
  } | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [codeTab, setCodeTab] = useState<"code" | "yaml">("code");
  const [deploying, setDeploying] = useState(false);

  // Placeholder rotation
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setPlaceholderIdx((prev) => (prev + 1) % PLACEHOLDER_EXAMPLES.length);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  // Pre-fill for templates
  useEffect(() => {
    if (templateParam) {
      const prefills: Record<string, string> = {
        research:
          "Research a topic on the web, synthesize findings, and produce a structured report with citations",
        connector:
          "Integrate with external services to sync data between Gmail, Slack, and Notion",
        chatbot:
          "A conversational agent that answers questions on WhatsApp and Slack using a knowledge base",
        scheduled:
          "Run a daily check of competitor pricing and send a summary report",
        approval:
          "Process expense requests with automatic classification and human approval gates for high amounts",
      };
      if (prefills[templateParam]) {
        setDescription(prefills[templateParam]);
      }
    }
  }, [templateParam]);

  // Auto-focus textarea
  useEffect(() => {
    if (currentStep === "describe") {
      textareaRef.current?.focus();
    }
  }, [currentStep]);

  const currentStepIndex = WIZARD_STEPS.findIndex(
    (s) => s.key === currentStep,
  );

  // ---- Step 1: Generate spec ----
  const handleGenerate = useCallback(async () => {
    if (!description.trim()) return;
    setGenerating(true);
    try {
      // Try the real LLM-powered spec generation first
      const result = await api.generateAgentSpec(description.trim());
      setSpec(result);
      setCurrentStep("review");
      toast.success("Agent spec generated");
    } catch {
      // Fallback: generate locally from templates (no LLM needed)
      const localSpec = generateSpecLocally(description);
      setSpec(localSpec);
      setCurrentStep("review");
      toast.info(
        "Generated spec from template (LLM unavailable). You can edit it below.",
      );
    } finally {
      setGenerating(false);
    }
  }, [description, toast]);

  // ---- Step 2 -> Step 3: Generate code ----
  const handleGenerateCode = useCallback(async () => {
    if (!spec) return;
    setGeneratingCode(true);
    try {
      const result = await api.generateAgentCode(spec);
      setGeneratedCode(result);
      setCurrentStep("code");
      toast.success("Code generated");
    } catch {
      // Fallback: generate code locally
      const fallbackCode = generateLocalCode(spec);
      setGeneratedCode(fallbackCode);
      setCurrentStep("code");
      toast.info("Generated code from template (LLM unavailable)");
    } finally {
      setGeneratingCode(false);
    }
  }, [spec, toast]);

  // ---- Step 4: Create agent ----
  const handleDeploy = useCallback(async () => {
    if (!spec) return;
    setDeploying(true);
    try {
      const agent = await api.createAgent({
        name: spec.name,
        description: spec.description,
        model: spec.model,
      });
      toast.success(`Agent "${agent.name}" created`);
      router.push(`/agents/${agent.name}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create agent",
      );
    } finally {
      setDeploying(false);
    }
  }, [spec, router, toast]);

  // ---- Spec editing helpers ----
  const updateSpec = (partial: Partial<AgentSpec>) => {
    if (spec) setSpec({ ...spec, ...partial });
  };

  const updateStep = (index: number, partial: Partial<AgentSpecStep>) => {
    if (!spec) return;
    const steps = [...spec.steps];
    steps[index] = { ...steps[index], ...partial };
    setSpec({ ...spec, steps });
  };

  const addStep = () => {
    if (!spec) return;
    setSpec({
      ...spec,
      steps: [
        ...spec.steps,
        {
          name: `step-${spec.steps.length + 1}`,
          type: "llm",
          description: "",
          config: {},
        },
      ],
    });
  };

  const removeStep = (index: number) => {
    if (!spec) return;
    setSpec({ ...spec, steps: spec.steps.filter((_, i) => i !== index) });
  };

  const toggleArrayItem = (
    field: "tools" | "connectors" | "surfaces",
    item: string,
  ) => {
    if (!spec) return;
    const arr = spec[field];
    if (arr.includes(item)) {
      updateSpec({ [field]: arr.filter((i: string) => i !== item) });
    } else {
      updateSpec({ [field]: [...arr, item] });
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header with step indicator */}
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-4">
        <div className="mb-4">
          <button
            onClick={() => router.push("/agents")}
            className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to Agents
          </button>
        </div>
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-zinc-100">
            Create Agent with AI
          </h1>
        </div>

        {/* Step indicator */}
        <div className="mt-5 flex items-center gap-2">
          {WIZARD_STEPS.map((step, i) => {
            const isActive = step.key === currentStep;
            const isDone = i < currentStepIndex;
            const Icon = step.icon;

            return (
              <div key={step.key} className="flex items-center gap-2">
                {i > 0 && (
                  <div
                    className={clsx(
                      "h-px w-8",
                      isDone ? "bg-indigo-500" : "bg-zinc-700",
                    )}
                  />
                )}
                <button
                  onClick={() => {
                    if (isDone) setCurrentStep(step.key);
                  }}
                  disabled={!isDone && !isActive}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                    isActive
                      ? "bg-indigo-500/10 text-indigo-400"
                      : isDone
                        ? "cursor-pointer text-zinc-300 hover:bg-surface-3"
                        : "cursor-default text-zinc-600",
                  )}
                >
                  {isDone ? (
                    <Check className="h-3.5 w-3.5 text-indigo-400" />
                  ) : (
                    <Icon className="h-3.5 w-3.5" />
                  )}
                  {step.label}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 p-8">
        {/* STEP 1: DESCRIBE */}
        {currentStep === "describe" && (
          <div className="mx-auto max-w-2xl">
            <div className="mb-8 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/10">
                <Sparkles className="h-7 w-7 text-indigo-400" />
              </div>
              <h2 className="text-xl font-semibold text-zinc-100">
                What should your agent do?
              </h2>
              <p className="mt-2 text-sm text-zinc-500">
                Describe your agent in plain language. We will generate the full
                specification.
              </p>
            </div>

            <div className="space-y-4">
              <div className="relative">
                <textarea
                  ref={textareaRef}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={PLACEHOLDER_EXAMPLES[placeholderIdx]}
                  rows={5}
                  className="w-full resize-none rounded-xl border border-zinc-800 bg-surface-0 px-4 py-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none transition-all focus:border-lantern-500/50 focus:ring-2 focus:ring-lantern-500/20"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      handleGenerate();
                    }
                  }}
                />
                <div className="absolute bottom-3 right-3 text-[10px] text-zinc-600">
                  {typeof navigator !== "undefined" &&
                  navigator.platform?.includes("Mac")
                    ? "Cmd"
                    : "Ctrl"}
                  +Enter to generate
                </div>
              </div>

              <button
                onClick={handleGenerate}
                disabled={!description.trim() || generating}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {generating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="animate-pulse">
                      Generating agent spec...
                    </span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    Generate Agent Spec
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: REVIEW SPEC */}
        {currentStep === "review" && spec && (
          <div className="mx-auto max-w-3xl space-y-6">
            {/* Name & Description */}
            <div className="space-y-4 rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <h3 className="text-sm font-semibold text-zinc-200">
                Basic Info
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-400">
                    Name
                  </label>
                  <input
                    type="text"
                    value={spec.name}
                    onChange={(e) =>
                      updateSpec({
                        name: e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9-]/g, "-"),
                      })
                    }
                    className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-400">
                    Model
                  </label>
                  <select
                    value={spec.model}
                    onChange={(e) => updateSpec({ model: e.target.value })}
                    className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50"
                  >
                    <option value="auto">Auto (recommended)</option>
                    <optgroup label="Anthropic">
                      <option value="reasoning-frontier">Reasoning Frontier — Claude Opus 4</option>
                      <option value="reasoning-large">Reasoning Large — Claude Sonnet 4</option>
                      <option value="reasoning-small">Reasoning Small — Claude Haiku 4</option>
                      <option value="code-large">Code Large — Claude Sonnet 4</option>
                    </optgroup>
                    <optgroup label="OpenAI">
                      <option value="chat-large">Chat Large — GPT-4o</option>
                      <option value="chat-small">Chat Small — GPT-4o Mini</option>
                    </optgroup>
                    <optgroup label="Google">
                      <option value="vision-large">Vision Large — Gemini 2.5 Pro</option>
                    </optgroup>
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-400">
                  Description
                </label>
                <textarea
                  value={spec.description}
                  onChange={(e) => updateSpec({ description: e.target.value })}
                  rows={2}
                  className="w-full resize-none rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50"
                />
              </div>
            </div>

            {/* Steps */}
            <div className="space-y-4 rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-200">Steps</h3>
                <button
                  onClick={addStep}
                  className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
                >
                  <Plus className="h-3 w-3" /> Add step
                </button>
              </div>
              <div className="space-y-3">
                {spec.steps.map((step, i) => {
                  const typeConfig = STEP_TYPES.find(
                    (t) => t.value === step.type,
                  );
                  const TypeIcon = typeConfig?.icon ?? Brain;

                  return (
                    <div
                      key={i}
                      className="space-y-3 rounded-lg border border-zinc-800 bg-surface-2 p-4"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-3">
                          <TypeIcon
                            className={clsx(
                              "h-3.5 w-3.5",
                              typeConfig?.color ?? "text-zinc-400",
                            )}
                          />
                        </div>
                        <input
                          type="text"
                          value={step.name}
                          onChange={(e) =>
                            updateStep(i, {
                              name: e.target.value
                                .toLowerCase()
                                .replace(/[^a-z0-9-]/g, "-"),
                            })
                          }
                          className="flex-1 rounded-md border border-zinc-700 bg-surface-1 px-2 py-1 text-xs font-medium text-zinc-200 outline-none focus:border-lantern-500/50"
                        />
                        <select
                          value={step.type}
                          onChange={(e) =>
                            updateStep(i, {
                              type: e.target.value as AgentSpecStep["type"],
                            })
                          }
                          className="rounded-md border border-zinc-700 bg-surface-1 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-lantern-500/50"
                        >
                          {STEP_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => removeStep(i)}
                          className="rounded-md p-1 text-zinc-600 transition-colors hover:bg-surface-3 hover:text-red-400"
                          title="Remove step"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <input
                        type="text"
                        value={step.description}
                        onChange={(e) =>
                          updateStep(i, { description: e.target.value })
                        }
                        placeholder="What does this step do?"
                        className="w-full rounded-md border border-zinc-700/50 bg-surface-1 px-2.5 py-1.5 text-xs text-zinc-400 outline-none placeholder:text-zinc-600 focus:border-lantern-500/50"
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Tools, Connectors, Surfaces */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="space-y-3 rounded-xl border border-zinc-800 bg-surface-1 p-4">
                <h3 className="text-xs font-semibold text-zinc-300">Tools</h3>
                <div className="flex flex-wrap gap-1.5">
                  {AVAILABLE_TOOLS.map((t) => (
                    <button
                      key={t}
                      onClick={() => toggleArrayItem("tools", t)}
                      className={clsx(
                        "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                        spec.tools.includes(t)
                          ? "bg-blue-500/15 text-blue-400"
                          : "bg-surface-3 text-zinc-500 hover:text-zinc-300",
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-zinc-800 bg-surface-1 p-4">
                <h3 className="text-xs font-semibold text-zinc-300">
                  Connectors
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {AVAILABLE_CONNECTORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => toggleArrayItem("connectors", c)}
                      className={clsx(
                        "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                        spec.connectors.includes(c)
                          ? "bg-teal-500/15 text-teal-400"
                          : "bg-surface-3 text-zinc-500 hover:text-zinc-300",
                      )}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-zinc-800 bg-surface-1 p-4">
                <h3 className="text-xs font-semibold text-zinc-300">
                  Surfaces
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {AVAILABLE_SURFACES.map((s) => (
                    <button
                      key={s}
                      onClick={() => toggleArrayItem("surfaces", s)}
                      className={clsx(
                        "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                        spec.surfaces.includes(s)
                          ? "bg-green-500/15 text-green-400"
                          : "bg-surface-3 text-zinc-500 hover:text-zinc-300",
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Isolation + Limits */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-3 rounded-xl border border-zinc-800 bg-surface-1 p-5">
                <h3 className="text-sm font-semibold text-zinc-200">
                  Isolation
                </h3>
                <div className="space-y-2">
                  {ISOLATION_LEVELS.map((level) => (
                    <label
                      key={level.value}
                      className={clsx(
                        "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-all",
                        spec.isolation === level.value
                          ? "border-lantern-500/50 bg-lantern-500/5"
                          : "border-zinc-800 hover:border-zinc-600",
                      )}
                    >
                      <input
                        type="radio"
                        name="isolation"
                        value={level.value}
                        checked={spec.isolation === level.value}
                        onChange={(e) =>
                          updateSpec({
                            isolation:
                              e.target.value as AgentSpec["isolation"],
                          })
                        }
                        className="accent-lantern-500"
                      />
                      <div>
                        <div className="text-xs font-medium text-zinc-200">
                          {level.label}
                        </div>
                        <div className="text-[10px] text-zinc-500">
                          {level.desc}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-4 rounded-xl border border-zinc-800 bg-surface-1 p-5">
                <h3 className="text-sm font-semibold text-zinc-200">
                  Resource Limits
                </h3>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 flex items-center justify-between text-xs text-zinc-400">
                      Timeout
                      <span className="font-mono text-zinc-500">
                        {spec.limits.timeout}
                      </span>
                    </label>
                    <select
                      value={spec.limits.timeout}
                      onChange={(e) =>
                        updateSpec({
                          limits: { ...spec.limits, timeout: e.target.value },
                        })
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-2 py-1.5 text-xs text-zinc-300 outline-none focus:border-lantern-500/50"
                    >
                      <option value="1m">1 minute</option>
                      <option value="5m">5 minutes</option>
                      <option value="15m">15 minutes</option>
                      <option value="30m">30 minutes</option>
                      <option value="1h">1 hour</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 flex items-center justify-between text-xs text-zinc-400">
                      Max tokens
                      <span className="font-mono text-zinc-500">
                        {spec.limits.maxTokens.toLocaleString()}
                      </span>
                    </label>
                    <input
                      type="range"
                      min={1000}
                      max={500000}
                      step={1000}
                      value={spec.limits.maxTokens}
                      onChange={(e) =>
                        updateSpec({
                          limits: {
                            ...spec.limits,
                            maxTokens: parseInt(e.target.value),
                          },
                        })
                      }
                      className="w-full accent-lantern-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 flex items-center justify-between text-xs text-zinc-400">
                      Max cost
                      <span className="font-mono text-zinc-500">
                        ${spec.limits.maxCostUsd.toFixed(2)}
                      </span>
                    </label>
                    <input
                      type="range"
                      min={0.1}
                      max={50}
                      step={0.1}
                      value={spec.limits.maxCostUsd}
                      onChange={(e) =>
                        updateSpec({
                          limits: {
                            ...spec.limits,
                            maxCostUsd: parseFloat(e.target.value),
                          },
                        })
                      }
                      className="w-full accent-lantern-500"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => setCurrentStep("describe")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
              <button
                onClick={handleGenerateCode}
                disabled={generatingCode}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {generatingCode ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Generating code...
                  </>
                ) : (
                  <>
                    Generate Code
                    <ArrowRight className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: CODE */}
        {currentStep === "code" && generatedCode && (
          <div className="mx-auto max-w-3xl space-y-6">
            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
              <div className="flex items-center border-b border-zinc-800">
                <button
                  onClick={() => setCodeTab("code")}
                  className={clsx(
                    "px-4 py-2.5 text-xs font-medium transition-colors",
                    codeTab === "code"
                      ? "border-b-2 border-indigo-500 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300",
                  )}
                >
                  <Code2 className="mr-1.5 inline h-3.5 w-3.5" />
                  src/index.ts
                </button>
                <button
                  onClick={() => setCodeTab("yaml")}
                  className={clsx(
                    "px-4 py-2.5 text-xs font-medium transition-colors",
                    codeTab === "yaml"
                      ? "border-b-2 border-indigo-500 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300",
                  )}
                >
                  <FileText className="mr-1.5 inline h-3.5 w-3.5" />
                  agent.yaml
                </button>
              </div>
              <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-zinc-400">
                <code>
                  {codeTab === "code"
                    ? generatedCode.code
                    : generatedCode.yaml}
                </code>
              </pre>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => setCurrentStep("review")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to Spec
              </button>
              <button
                onClick={() => setCurrentStep("deploy")}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
              >
                Continue
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* STEP 4: CREATE */}
        {currentStep === "deploy" && spec && (
          <div className="mx-auto max-w-xl text-center">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
              <Rocket className="h-8 w-8 text-emerald-400" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-zinc-100">
              Ready to create
            </h2>
            <p className="mb-8 text-sm text-zinc-500">
              Agent <span className="font-medium text-zinc-300">{spec.name}</span>{" "}
              will be created and registered in the platform.
            </p>

            <div className="mb-8 space-y-2 rounded-xl border border-zinc-800 bg-surface-1 p-5 text-left text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-500">Name</span>
                <span className="text-zinc-200">{spec.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Model</span>
                <span className="text-zinc-200">{spec.model}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Steps</span>
                <span className="text-zinc-200">{spec.steps.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Isolation</span>
                <span className="text-zinc-200">{spec.isolation}</span>
              </div>
            </div>

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => setCurrentStep("code")}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
              <button
                onClick={handleDeploy}
                disabled={deploying}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deploying ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Rocket className="h-4 w-4" />
                    Create Agent
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
