"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  Play,
  Square,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Settings2,
  Clock,
  Coins,
  Braces,
  History,
  Loader2,
  AlertCircle,
  ExternalLink,
  Info,
} from "lucide-react";
import { format } from "date-fns";
import clsx from "clsx";
import {
  agents as mockAgents,
  sampleRunEvents,
  failedRunEvents,
  runningRunEvents,
  formatCost,
  formatTokens,
  formatDuration,
} from "@/lib/mock-data";
import type { StreamEvent } from "@/lib/mock-data";
import {
  EventStream,
  EventCountBadge,
  useStreamSimulation,
} from "@/components/event-stream";
import { JsonViewer } from "@/components/json-viewer";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useModels } from "@/lib/model-context";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlaygroundRun {
  id: string;
  agentName: string;
  model: string;
  input: string;
  startedAt: Date;
  finishedAt?: Date;
  status: "running" | "succeeded" | "failed";
  output: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  provider: string;
  resolvedModel: string;
  demoMode?: boolean;
}

// ---------------------------------------------------------------------------
// Agent input examples (richer descriptions)
// ---------------------------------------------------------------------------

const agentExamples: Record<
  string,
  { input: Record<string, unknown>; description: string; systemPrompt?: string }
> = {
  "research-agent": {
    input: {
      topic: "Impact of AI agents on enterprise software",
    },
    description:
      "Researches a topic using multiple sources and produces a structured report with citations.",
    systemPrompt:
      "You are a research analyst. Given a topic, write a comprehensive research briefing with key findings, trends, and implications. Use clear headers and bullet points.",
  },
  "code-reviewer": {
    input: {
      repo: "dshakes/lantern",
      prNumber: 1,
    },
    description:
      "Reviews a pull request for correctness, security, style, and performance issues.",
    systemPrompt:
      "You are a senior code reviewer. Given a PR description, provide a thorough code review covering correctness, security, style, and performance. Be specific and actionable.",
  },
  "customer-support": {
    input: {
      ticketId: "T-1234",
      customerMessage: "My billing shows wrong charges",
    },
    description:
      "Handles a customer support ticket by drafting an empathetic, helpful response.",
    systemPrompt:
      "You are a customer support agent. Draft a professional, empathetic response to the customer's issue. Include specific next steps and offer to escalate if needed.",
  },
  "data-pipeline": {
    input: {},
    description:
      "Scheduled pipeline agent -- no interactive input needed. Runs on a cron schedule.",
  },
  "talent-scout": {
    input: {
      role: "Senior ML Engineer",
      skills: ["PyTorch", "transformers"],
      experience: "5+ years",
    },
    description:
      "Generates a talent search strategy and outreach templates for recruiting.",
    systemPrompt:
      "You are a technical recruiter AI. Given a role, skills, and experience requirements, create a talent search strategy with sourcing channels, screening criteria, and a personalized outreach template.",
  },
};

// Demo event sets for fallback mode.
const demoEventSets: Record<string, StreamEvent[]> = {
  "research-agent": sampleRunEvents,
  "code-reviewer": runningRunEvents,
  "data-pipeline": sampleRunEvents.map((e) => ({
    ...e,
    runId: "playground",
  })),
  "customer-support": sampleRunEvents.slice(0, 8).map((e) => ({
    ...e,
    runId: "playground",
  })),
};

function isValidJson(str: string): boolean {
  if (!str.trim()) return true;
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

function prettyPrintJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function PlaygroundPage() {
  // Auth context -- check if in demo mode
  const { isDemoMode } = useAuth();
  // Model context -- configured providers and available models
  const { availableModels, isConfigured, loading: modelsLoading } = useModels();

  // Input config state
  const [selectedAgent, setSelectedAgent] = useState("research-agent");
  const [selectedModel, setSelectedModel] = useState("auto");
  const [inputJson, setInputJson] = useState(
    JSON.stringify(agentExamples["research-agent"]?.input ?? {}, null, 2)
  );
  const [jsonValid, setJsonValid] = useState(true);

  // Advanced settings
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [temperature, setTemperature] = useState(1.0);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [costLimit, setCostLimit] = useState("1.00");
  const [streamEnabled, setStreamEnabled] = useState(true);

  // LLM provider state (kept for backwards compat with existing checks)
  const [providersChecked, setProvidersChecked] = useState(false);
  const [hasProviders, setHasProviders] = useState(false);
  const [providerCheckError, setProviderCheckError] = useState(false);

  // Run state
  const [isRunning, setIsRunning] = useState(false);
  const [runHistory, setRunHistory] = useState<PlaygroundRun[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Streaming output state
  const [streamedOutput, setStreamedOutput] = useState("");
  const [streamDone, setStreamDone] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [runMeta, setRunMeta] = useState<{
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    model: string;
    provider: string;
    durationMs: number;
  } | null>(null);

  // Demo mode fallback state (for when API is unavailable)
  const [demoEvents, setDemoEvents] = useState<StreamEvent[]>([]);
  const { visibleEvents, streamingText, isStreaming, isComplete, reset: resetDemo } =
    useStreamSimulation(demoEvents, {
      enabled: isRunning && demoMode,
      onComplete: () => {
        setIsRunning(false);
      },
    });

  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<number>(0);

  // Check for configured LLM providers on mount.
  useEffect(() => {
    (async () => {
      try {
        const providers = await api.listLlmProviders();
        setHasProviders(providers.length > 0);
        setProvidersChecked(true);
      } catch {
        setProviderCheckError(true);
        setProvidersChecked(true);
      }
    })();
  }, []);

  // Load agents from API (with mock fallback).
  const [agents, setAgents] = useState(mockAgents);
  useEffect(() => {
    (async () => {
      try {
        const realAgents = await api.listAgents();
        if (realAgents.length > 0) {
          setAgents(realAgents);
        }
      } catch {
        // Keep mock agents.
      }
    })();
  }, []);

  // Validate JSON as user types.
  useEffect(() => {
    setJsonValid(isValidJson(inputJson));
  }, [inputJson]);

  // Auto-scroll output.
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [streamedOutput]);

  // Update input example when agent changes.
  const handleAgentChange = useCallback((agentName: string) => {
    setSelectedAgent(agentName);
    const example = agentExamples[agentName];
    if (example) {
      setInputJson(JSON.stringify(example.input, null, 2));
    } else {
      setInputJson("{}");
    }
  }, []);

  const handlePrettyPrint = useCallback(() => {
    if (isValidJson(inputJson)) {
      setInputJson(prettyPrintJson(inputJson));
    }
  }, [inputJson]);

  const handleFillExample = useCallback(() => {
    const example = agentExamples[selectedAgent];
    if (example) {
      setInputJson(JSON.stringify(example.input, null, 2));
    }
  }, [selectedAgent]);

  // ----------- Real LLM run -----------

  const handleRun = useCallback(async () => {
    if (!jsonValid || !inputJson.trim()) return;

    // Reset state.
    setStreamedOutput("");
    setStreamDone(false);
    setStreamError(null);
    setRunMeta(null);
    setDemoMode(false);
    setDemoEvents([]);
    resetDemo();
    setIsRunning(true);
    startTimeRef.current = Date.now();

    // Build messages from the agent's system prompt + user input.
    const agentConfig = agentExamples[selectedAgent];
    const messages: Array<{ role: string; content: string }> = [];

    if (agentConfig?.systemPrompt) {
      messages.push({ role: "system", content: agentConfig.systemPrompt });
    }

    // Parse the input JSON and include it as user content.
    let parsedInput: Record<string, unknown> = {};
    try {
      parsedInput = JSON.parse(inputJson);
    } catch {
      // Already validated.
    }

    const userContent =
      Object.keys(parsedInput).length > 0
        ? `Here is my request:\n\n${JSON.stringify(parsedInput, null, 2)}`
        : "Hello, please help me.";

    messages.push({ role: "user", content: userContent });

    // In demo mode, always use simulation (no real API token)
    if (isDemoMode) {
      setDemoMode(true);
      resetDemo();
      // Set events after reset so the useEffect sees the new events array
      // on the next render after cancelRef is cleared
      setTimeout(() => {
        setDemoEvents([...sampleRunEvents]);
      }, 0);
      return;
    }

    try {
      let response: Response;
      try {
        response = await api.complete({
          messages,
          model: selectedModel,
          stream: streamEnabled,
          temperature,
          maxTokens,
        });
      } catch (fetchErr) {
        // Network error — API not running. Fall back to demo.
        console.warn("API unavailable, falling back to demo mode", fetchErr);
        setDemoMode(true);
        resetDemo();
        setTimeout(() => {
          setDemoEvents([...sampleRunEvents]);
        }, 0);
        return;
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        let errMsg: string;
        if (response.status === 404) {
          errMsg = "API server is not running. Start it with: make run-api";
        } else if (response.status === 401) {
          errMsg = "Not authenticated. Please sign in again.";
        } else {
          try {
            const parsed = JSON.parse(errBody);
            errMsg = parsed.error || `API error ${response.status}`;
          } catch {
            errMsg = errBody || `API error ${response.status}`;
          }
          // Check if error is about missing LLM key
          if (errMsg.toLowerCase().includes("no llm provider") || errMsg.toLowerCase().includes("no api key")) {
            errMsg = "No LLM provider configured. Go to Settings → LLM Providers to add your API key.";
          }
        }
        throw new Error(errMsg);
      }

      if (streamEnabled && response.headers.get("content-type")?.includes("text/event-stream")) {
        // Handle SSE stream.
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let fullOutput = "";
        let totalTokensIn = 0;
        let totalTokensOut = 0;
        let totalCost = 0;
        let resolvedModel = selectedModel;
        let resolvedProvider = "";

        const processLine = (line: string) => {
          if (!line.startsWith("data: ")) return;
          const data = line.slice(6).trim();
          if (!data) return;

          try {
            const event = JSON.parse(data);
            if (event.type === "delta" && event.content) {
              fullOutput += event.content;
              setStreamedOutput(fullOutput);
            } else if (event.type === "done") {
              totalTokensIn = event.tokensIn ?? 0;
              totalTokensOut = event.tokensOut ?? 0;
              totalCost = event.costUsd ?? 0;
              resolvedModel = event.model ?? selectedModel;
              resolvedProvider = event.provider ?? "";
            }
          } catch {
            // Ignore malformed events.
          }
        };

        let buffer = "";
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            processLine(line);
          }
        }

        // Process any remaining buffer.
        if (buffer.trim()) {
          processLine(buffer);
        }

        const durationMs = Date.now() - startTimeRef.current;

        setRunMeta({
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          costUsd: totalCost,
          model: resolvedModel,
          provider: resolvedProvider,
          durationMs,
        });
        setStreamDone(true);
        setIsRunning(false);

        // Add to history.
        setRunHistory((prev) => [
          {
            id: `run_${Date.now()}`,
            agentName: selectedAgent,
            model: selectedModel,
            input: inputJson,
            startedAt: new Date(startTimeRef.current),
            finishedAt: new Date(),
            status: "succeeded",
            output: fullOutput,
            tokensIn: totalTokensIn,
            tokensOut: totalTokensOut,
            costUsd: totalCost,
            provider: resolvedProvider,
            resolvedModel,
          },
          ...prev.slice(0, 19),
        ]);
      } else {
        // Non-streaming JSON response.
        const result = await response.json();
        const durationMs = Date.now() - startTimeRef.current;

        setStreamedOutput(result.content || "");
        setRunMeta({
          tokensIn: result.tokensIn ?? 0,
          tokensOut: result.tokensOut ?? 0,
          costUsd: result.costUsd ?? 0,
          model: result.model ?? selectedModel,
          provider: result.provider ?? "",
          durationMs,
        });
        setStreamDone(true);
        setIsRunning(false);

        setRunHistory((prev) => [
          {
            id: `run_${Date.now()}`,
            agentName: selectedAgent,
            model: selectedModel,
            input: inputJson,
            startedAt: new Date(startTimeRef.current),
            finishedAt: new Date(),
            status: "succeeded",
            output: result.content || "",
            tokensIn: result.tokensIn ?? 0,
            tokensOut: result.tokensOut ?? 0,
            costUsd: result.costUsd ?? 0,
            provider: result.provider ?? "",
            resolvedModel: result.model ?? selectedModel,
          },
          ...prev.slice(0, 19),
        ]);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      // Check if this is a network error (API down) -- fall back to demo mode.
      if (
        errorMessage.includes("fetch") ||
        errorMessage.includes("network") ||
        errorMessage.includes("Failed") ||
        errorMessage.includes("ECONNREFUSED") ||
        (err instanceof TypeError)
      ) {
        // Fall back to demo simulation.
        setDemoMode(true);
        resetDemo();
        const events = demoEventSets[selectedAgent] || sampleRunEvents;
        const taggedEvents = events.map((e) => ({
          ...e,
          runId: `playground_${Date.now()}`,
        }));
        setTimeout(() => {
          setDemoEvents([...taggedEvents]);
        }, 0);
        return;
      }

      setStreamError(errorMessage);
      setIsRunning(false);
      setStreamDone(true);

      setRunHistory((prev) => [
        {
          id: `run_${Date.now()}`,
          agentName: selectedAgent,
          model: selectedModel,
          input: inputJson,
          startedAt: new Date(startTimeRef.current),
          finishedAt: new Date(),
          status: "failed",
          output: "",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          provider: "",
          resolvedModel: selectedModel,
        },
        ...prev.slice(0, 19),
      ]);
    }
  }, [
    selectedAgent,
    selectedModel,
    jsonValid,
    inputJson,
    streamEnabled,
    temperature,
    maxTokens,
    resetDemo,
    isDemoMode,
  ]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setIsRunning(false);
    resetDemo();
  }, [resetDemo]);

  const handleRunAgain = useCallback(() => {
    handleRun();
  }, [handleRun]);

  // Agent description.
  const agentDescription = useMemo(() => {
    const config = agentExamples[selectedAgent];
    return config?.description ?? agents.find((a) => a.name === selectedAgent)?.description ?? "";
  }, [selectedAgent, agents]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-zinc-800 bg-surface-1 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-lantern-600/20">
            <Sparkles className="h-4 w-4 text-lantern-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Playground</h1>
            <p className="text-xs text-zinc-500">
              Test agents interactively with real-time streaming
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {demoMode && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-400">
              <Info className="h-3 w-3" />
              Demo Mode
            </span>
          )}
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={clsx(
              "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
              showHistory
                ? "border-lantern-500/30 bg-lantern-500/10 text-lantern-400"
                : "border-zinc-700 text-zinc-400 hover:bg-surface-3"
            )}
          >
            <History className="h-3.5 w-3.5" />
            History ({runHistory.length})
          </button>
        </div>
      </div>

      {/* Provider warning banner */}
      {providersChecked && !hasProviders && !providerCheckError && (
        <div className="flex items-center gap-3 border-b border-amber-500/20 bg-amber-500/5 px-6 py-3">
          <AlertCircle className="h-4 w-4 flex-shrink-0 text-amber-400" />
          <p className="text-sm text-amber-300">
            No LLM provider configured.{" "}
            <Link
              href="/settings"
              className="inline-flex items-center gap-1 font-medium text-amber-200 underline underline-offset-2 hover:text-amber-100"
            >
              Add an API key in Settings
              <ExternalLink className="h-3 w-3" />
            </Link>{" "}
            to use the playground with real LLM output.
          </p>
        </div>
      )}

      {/* Main content: two panels */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Input + Configuration */}
        <div className="flex w-1/2 flex-col overflow-auto border-r border-zinc-800">
          <div className="flex-1 space-y-5 p-6">
            {/* Agent selector */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                Agent
              </label>
              <select
                value={selectedAgent}
                onChange={(e) => handleAgentChange(e.target.value)}
                className="h-10 w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 text-sm text-zinc-300 focus:border-lantern-500/50 focus:outline-none focus:ring-1 focus:ring-lantern-500/20"
              >
                {agents
                  .filter((a) => a.status === "active")
                  .map((agent) => (
                    <option key={agent.id ?? agent.name} value={agent.name}>
                      {agent.name}
                    </option>
                  ))}
                {/* Always show example agents even if not in DB */}
                {!agents.find((a) => a.name === "talent-scout") && (
                  <option value="talent-scout">talent-scout</option>
                )}
              </select>
              <p className="mt-1 text-xs text-zinc-600">{agentDescription}</p>
            </div>

            {/* Model override */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                Model Override
              </label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="h-10 w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 text-sm text-zinc-300 focus:border-lantern-500/50 focus:outline-none focus:ring-1 focus:ring-lantern-500/20"
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
              {!modelsLoading && !isConfigured && (
                <p className="mt-1 text-[11px] text-amber-400/80">
                  ⚠ No LLM provider key configured.{" "}
                  <a href="/settings" className="underline hover:text-amber-300">Add one in Settings</a>
                </p>
              )}
            </div>

            {/* Input JSON editor */}
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs font-medium text-zinc-400">
                  Input JSON
                </label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleFillExample}
                    className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
                  >
                    Example
                  </button>
                  <span className="text-zinc-700">|</span>
                  <button
                    onClick={handlePrettyPrint}
                    className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
                  >
                    Pretty-print
                  </button>
                </div>
              </div>
              <div className="relative">
                <textarea
                  value={inputJson}
                  onChange={(e) => setInputJson(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  className={clsx(
                    "w-full resize-none rounded-lg border bg-surface-2 p-3 font-mono text-xs leading-relaxed text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1",
                    jsonValid
                      ? "border-zinc-700 focus:border-lantern-500/50 focus:ring-lantern-500/20"
                      : "border-red-500/50 focus:border-red-500 focus:ring-red-500/20"
                  )}
                  placeholder='{ "query": "..." }'
                />
                {!jsonValid && (
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-red-400">
                    <AlertCircle className="h-3 w-3" />
                    Invalid JSON
                  </div>
                )}
              </div>
            </div>

            {/* Advanced settings */}
            <div>
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-300"
              >
                <Settings2 className="h-3.5 w-3.5" />
                Advanced Settings
                {showAdvanced ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>

              {showAdvanced && (
                <div className="mt-3 space-y-4 rounded-lg border border-zinc-800 bg-surface-2 p-4">
                  {/* Temperature */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-zinc-400">Temperature</label>
                      <span className="font-mono text-xs text-zinc-300">
                        {temperature.toFixed(1)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                      value={temperature}
                      onChange={(e) =>
                        setTemperature(parseFloat(e.target.value))
                      }
                      className="mt-1.5 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-lantern-500 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-lantern-500"
                    />
                    <div className="mt-0.5 flex justify-between text-[10px] text-zinc-600">
                      <span>Deterministic</span>
                      <span>Creative</span>
                    </div>
                  </div>

                  {/* Max tokens */}
                  <div>
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-zinc-400">Max Tokens</label>
                      <span className="font-mono text-xs text-zinc-300">
                        {(maxTokens / 1000).toFixed(0)}k
                      </span>
                    </div>
                    <input
                      type="range"
                      min="256"
                      max="16384"
                      step="256"
                      value={maxTokens}
                      onChange={(e) =>
                        setMaxTokens(parseInt(e.target.value))
                      }
                      className="mt-1.5 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-lantern-500 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-lantern-500"
                    />
                    <div className="mt-0.5 flex justify-between text-[10px] text-zinc-600">
                      <span>256</span>
                      <span>16k</span>
                    </div>
                  </div>

                  {/* Cost limit */}
                  <div>
                    <label className="mb-1.5 block text-xs text-zinc-400">
                      Cost Limit (USD)
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500">
                        $
                      </span>
                      <input
                        type="text"
                        value={costLimit}
                        onChange={(e) => setCostLimit(e.target.value)}
                        className="h-9 w-full rounded-lg border border-zinc-700 bg-surface-1 pl-6 pr-3 font-mono text-xs text-zinc-300 focus:border-lantern-500/50 focus:outline-none focus:ring-1 focus:ring-lantern-500/20"
                      />
                    </div>
                  </div>

                  {/* Stream toggle */}
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-zinc-400">
                      Stream output
                    </label>
                    <button
                      onClick={() => setStreamEnabled(!streamEnabled)}
                      className={clsx(
                        "relative h-5 w-9 rounded-full transition-colors",
                        streamEnabled ? "bg-lantern-600" : "bg-zinc-700"
                      )}
                    >
                      <span
                        className={clsx(
                          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform",
                          streamEnabled ? "left-[18px]" : "left-0.5"
                        )}
                      />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Run button */}
            {isRunning ? (
              <button
                onClick={handleStop}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-red-600 font-medium text-white transition-colors hover:bg-red-500"
              >
                <Square className="h-4 w-4" />
                Stop
              </button>
            ) : (
              <button
                onClick={handleRun}
                disabled={!jsonValid || !inputJson.trim()}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-lantern-600 font-medium text-white transition-colors hover:bg-lantern-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                Run
              </button>
            )}

            {/* Run history */}
            {showHistory && runHistory.length > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
                    Recent Runs
                  </h3>
                  <button
                    onClick={() => setRunHistory([])}
                    className="text-[11px] text-zinc-600 transition-colors hover:text-zinc-400"
                  >
                    Clear
                  </button>
                </div>
                <div className="space-y-1">
                  {runHistory.slice(0, 10).map((run) => (
                    <button
                      key={run.id}
                      onClick={() => {
                        setSelectedAgent(run.agentName);
                        setInputJson(run.input);
                        setSelectedModel(run.model);
                        // Show the previous run output.
                        setStreamedOutput(run.output);
                        setStreamDone(true);
                        setStreamError(null);
                        setDemoMode(run.demoMode ?? false);
                        setRunMeta({
                          tokensIn: run.tokensIn,
                          tokensOut: run.tokensOut,
                          costUsd: run.costUsd,
                          model: run.resolvedModel,
                          provider: run.provider,
                          durationMs: run.finishedAt
                            ? run.finishedAt.getTime() - run.startedAt.getTime()
                            : 0,
                        });
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-2"
                    >
                      <div>
                        <span className="text-xs font-medium text-zinc-300">
                          {run.agentName}
                        </span>
                        <span
                          className={clsx(
                            "ml-2 text-[11px]",
                            run.status === "succeeded"
                              ? "text-emerald-400"
                              : run.status === "failed"
                                ? "text-red-400"
                                : "text-blue-400"
                          )}
                        >
                          {run.status}
                        </span>
                        {run.provider && (
                          <span className="ml-2 text-[11px] text-zinc-600">
                            via {run.provider}
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-zinc-600">
                        {format(run.startedAt, "HH:mm:ss")}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right panel: Live output stream */}
        <div className="flex w-1/2 flex-col overflow-hidden">
          {/* Panel header */}
          <div className="flex flex-shrink-0 items-center justify-between border-b border-zinc-800/50 bg-surface-1/50 px-6 py-3">
            <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
              Output
            </h2>
            <div className="flex items-center gap-2">
              {isRunning && !demoMode && (
                <span className="flex items-center gap-1.5 text-xs text-blue-400">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Streaming...
                </span>
              )}
              {demoMode && visibleEvents.length > 0 && (
                <EventCountBadge count={visibleEvents.length} />
              )}
            </div>
          </div>

          {/* Output area */}
          <div className="flex-1 overflow-hidden">
            {/* Demo mode: use EventStream component */}
            {demoMode && (visibleEvents.length > 0 || isStreaming) ? (
              <div className="flex h-full flex-col">
                <div className="flex-1 overflow-hidden">
                  <EventStream
                    events={visibleEvents}
                    streaming={isStreaming}
                    streamingText={streamingText}
                  />
                </div>
              </div>
            ) : !streamedOutput && !isRunning && !streamError ? (
              /* Idle state */
              <div className="flex h-full items-center justify-center">
                <div className="text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2">
                    <Sparkles className="h-8 w-8 text-zinc-600" />
                  </div>
                  <p className="text-sm text-zinc-500">
                    Run an agent to see output here
                  </p>
                  <p className="mt-1 text-xs text-zinc-600">
                    Configure the agent on the left and click Run
                  </p>
                </div>
              </div>
            ) : (
              /* Real LLM output */
              <div className="flex h-full flex-col">
                {/* Streaming / completed output */}
                <div
                  ref={outputRef}
                  className="flex-1 overflow-auto p-6"
                >
                  {streamError ? (
                    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-red-400">
                        <AlertCircle className="h-4 w-4" />
                        Error
                      </div>
                      <p className="mt-2 text-sm text-red-300/80">{streamError}</p>
                    </div>
                  ) : (
                    <div className="prose prose-invert max-w-none">
                      <div className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-zinc-200">
                        {streamedOutput}
                        {isRunning && (
                          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-lantern-400" />
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Completion summary */}
                {streamDone && runMeta && !streamError && (
                  <div className="flex-shrink-0 border-t border-zinc-800 bg-surface-1/50 px-6 py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                          Completed
                        </span>
                        {runMeta.provider && (
                          <span className="text-[11px] text-zinc-500">
                            {runMeta.provider}/{runMeta.model}
                          </span>
                        )}
                        <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                          <Clock className="h-3 w-3" />
                          {formatDuration(runMeta.durationMs)}
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                          <Braces className="h-3 w-3" />
                          {formatTokens(runMeta.tokensIn + runMeta.tokensOut)}{" "}
                          tokens
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                          <Coins className="h-3 w-3" />
                          {formatCost(runMeta.costUsd)}
                        </div>
                      </div>
                      <button
                        onClick={handleRunAgain}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Run Again
                      </button>
                    </div>
                  </div>
                )}

                {/* Error summary */}
                {streamDone && streamError && (
                  <div className="flex-shrink-0 border-t border-zinc-800 bg-surface-1/50 px-6 py-4">
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
                        Failed
                      </span>
                      <button
                        onClick={handleRunAgain}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Retry
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
