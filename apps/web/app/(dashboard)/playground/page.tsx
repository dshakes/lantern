"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  Play,
  Square,
  RefreshCw,
  Sparkles,
  Clock,
  Coins,
  Braces,
  Loader2,
  AlertCircle,
  Info,
} from "lucide-react";
import clsx from "clsx";
import {
  agents as mockAgents,
  sampleRunEvents,
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
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Agent input examples
// ---------------------------------------------------------------------------

const agentExamples: Record<
  string,
  {
    input: Record<string, unknown>;
    description: string;
    systemPrompt?: string;
  }
> = {
  "research-agent": {
    input: { topic: "Impact of AI agents on enterprise software" },
    description:
      "Researches a topic using multiple sources and produces a structured report with citations.",
    systemPrompt:
      "You are a research analyst. Given a topic, write a comprehensive research briefing with key findings, trends, and implications. Use clear headers and bullet points.",
  },
  "code-reviewer": {
    input: { repo: "dshakes/lantern", prNumber: 1 },
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
};

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function PlaygroundPage() {
  const { isDemoMode } = useAuth();

  // Input state — default will be updated once agents load
  const [selectedAgent, setSelectedAgent] = useState("");
  const [selectedModel, setSelectedModel] = useState("auto");
  const [inputText, setInputText] = useState("{}");

  // Run state
  const [isRunning, setIsRunning] = useState(false);
  const [streamedOutput, setStreamedOutput] = useState("");
  const [streamDone, setStreamDone] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [savedRunId, setSavedRunId] = useState<string | null>(null);
  const [runMeta, setRunMeta] = useState<{
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    model: string;
    provider: string;
    durationMs: number;
  } | null>(null);

  // Demo mode fallback
  const [demoEvents, setDemoEvents] = useState<StreamEvent[]>([]);
  const {
    visibleEvents,
    streamingText,
    isStreaming,
    isComplete,
    reset: resetDemo,
  } = useStreamSimulation(demoEvents, {
    enabled: isRunning && demoMode,
    onComplete: () => {
      setIsRunning(false);
    },
  });

  const outputRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<number>(0);

  // Load agents from API; fall back to mock agents with "(demo)" suffix
  const [agents, setAgents] = useState<typeof mockAgents>([]);
  useEffect(() => {
    (async () => {
      try {
        const realAgents = await api.listAgents();
        setAgents(realAgents);
      } catch {
        // API unavailable — show mock agents with demo suffix
        setAgents(
          mockAgents.map((a) => ({ ...a, name: `${a.name} (demo)` })),
        );
      }
    })();
  }, []);

  // Select first active agent once agents load
  useEffect(() => {
    if (agents.length > 0 && !selectedAgent) {
      const first = agents.find((a) => a.status === "active") ?? agents[0];
      setSelectedAgent(first.name);
      const example = agentExamples[first.name];
      if (example) {
        setInputText(JSON.stringify(example.input, null, 2));
      }
    }
  }, [agents, selectedAgent]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [streamedOutput]);

  // Update input when agent changes
  const handleAgentChange = useCallback((agentName: string) => {
    setSelectedAgent(agentName);
    const example = agentExamples[agentName];
    if (example) {
      setInputText(JSON.stringify(example.input, null, 2));
    } else {
      setInputText("{}");
    }
  }, []);

  // Agent description
  const agentDescription = useMemo(() => {
    const config = agentExamples[selectedAgent];
    return (
      config?.description ??
      agents.find((a) => a.name === selectedAgent)?.description ??
      ""
    );
  }, [selectedAgent, agents]);

  // ----------- Run handler -----------

  const handleRun = useCallback(async () => {
    if (!inputText.trim()) return;

    // Reset state
    setStreamedOutput("");
    setStreamDone(false);
    setStreamError(null);
    setRunMeta(null);
    setDemoMode(false);
    setDemoEvents([]);
    setSavedRunId(null);
    resetDemo();
    setIsRunning(true);
    startTimeRef.current = Date.now();

    // Build messages
    const agentConfig = agentExamples[selectedAgent];
    const messages: Array<{ role: string; content: string }> = [];

    if (agentConfig?.systemPrompt) {
      messages.push({ role: "system", content: agentConfig.systemPrompt });
    }

    let userContent: string;
    try {
      const parsed = JSON.parse(inputText);
      userContent =
        Object.keys(parsed).length > 0
          ? `Here is my request:\n\n${JSON.stringify(parsed, null, 2)}`
          : inputText;
    } catch {
      userContent = inputText;
    }

    messages.push({ role: "user", content: userContent });

    // In demo mode, always use simulation
    if (isDemoMode) {
      setDemoMode(true);
      resetDemo();
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
          stream: true,
          temperature: 1.0,
          maxTokens: 4096,
        });
      } catch {
        // Network error -- fall back to demo
        console.warn("[lantern] API unavailable, falling back to demo mode");
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
          if (
            errMsg.toLowerCase().includes("no llm provider") ||
            errMsg.toLowerCase().includes("no api key")
          ) {
            errMsg =
              "No LLM provider configured. Go to Settings to add your API key.";
          }
        }
        throw new Error(errMsg);
      }

      if (
        response.headers
          .get("content-type")
          ?.includes("text/event-stream")
      ) {
        // Handle SSE stream
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
            // Ignore malformed events
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

        // Try to save as a run record
        try {
          const savedRun = await api.createRun({
            agentName: selectedAgent,
            input: JSON.parse(inputText),
          });
          setSavedRunId(savedRun.id);
        } catch {
          // Run saving is optional -- don't block the UI
        }
      } else {
        // Non-streaming JSON response
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

        // Try to save as a run record
        try {
          const savedRun = await api.createRun({
            agentName: selectedAgent,
            input: JSON.parse(inputText),
          });
          setSavedRunId(savedRun.id);
        } catch {
          // Run saving is optional -- don't block the UI
        }
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error";

      // Check if network error -- fall back to demo
      if (
        errorMessage.includes("fetch") ||
        errorMessage.includes("network") ||
        errorMessage.includes("Failed") ||
        errorMessage.includes("ECONNREFUSED") ||
        err instanceof TypeError
      ) {
        setDemoMode(true);
        resetDemo();
        setTimeout(() => {
          setDemoEvents([...sampleRunEvents]);
        }, 0);
        return;
      }

      setStreamError(errorMessage);
      setIsRunning(false);
      setStreamDone(true);
    }
  }, [selectedAgent, selectedModel, inputText, resetDemo, isDemoMode]);

  const handleStop = useCallback(() => {
    setIsRunning(false);
    resetDemo();
  }, [resetDemo]);

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
          <h1 className="text-lg font-semibold text-zinc-100">Playground</h1>
        </div>
        {demoMode && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-400">
            <Info className="h-3 w-3" />
            Demo Mode
          </span>
        )}
      </div>

      {/* Two panels */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Configuration */}
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
                className="h-10 w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 text-sm text-zinc-300 focus:border-lantern-500/50 focus:outline-none focus:ring-1 focus:ring-lantern-500/20"
              >
                {agents
                  .filter((a) => a.status === "active")
                  .map((agent) => (
                    <option key={agent.id ?? agent.name} value={agent.name}>
                      {agent.name}
                    </option>
                  ))}
              </select>
            </div>

            {/* Model selector */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                Model
              </label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="h-10 w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 text-sm text-zinc-300 focus:border-lantern-500/50 focus:outline-none focus:ring-1 focus:ring-lantern-500/20"
              >
                <option value="auto">Auto (recommended)</option>
                <optgroup label="Anthropic">
                  <option value="reasoning-frontier">
                    Reasoning Frontier -- Claude Opus 4
                  </option>
                  <option value="reasoning-large">
                    Reasoning Large -- Claude Sonnet 4
                  </option>
                  <option value="reasoning-small">
                    Reasoning Small -- Claude Haiku 4
                  </option>
                  <option value="code-large">
                    Code Large -- Claude Sonnet 4
                  </option>
                </optgroup>
                <optgroup label="OpenAI">
                  <option value="chat-large">Chat Large -- GPT-4o</option>
                  <option value="chat-small">
                    Chat Small -- GPT-4o Mini
                  </option>
                </optgroup>
                <optgroup label="Google">
                  <option value="vision-large">
                    Vision Large -- Gemini 2.5 Pro
                  </option>
                </optgroup>
              </select>
            </div>

            {/* Input area */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                Input
              </label>
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                rows={10}
                spellCheck={false}
                placeholder="Type your input or paste JSON..."
                className="w-full resize-none rounded-lg border border-zinc-800 bg-surface-0 p-3 font-mono text-xs leading-relaxed text-zinc-300 placeholder:text-zinc-600 focus:border-lantern-500/50 focus:outline-none focus:ring-1 focus:ring-lantern-500/20"
              />
              <p className="mt-1 text-xs text-zinc-600">{agentDescription}</p>
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
                disabled={!inputText.trim()}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                Run
              </button>
            )}
          </div>
        </div>

        {/* Right panel: Output */}
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
                    Select an agent and click Run
                  </p>
                  <p className="mt-1 text-xs text-zinc-600">
                    Configure the agent on the left to get started
                  </p>
                </div>
              </div>
            ) : (
              /* Real LLM output */
              <div className="flex h-full flex-col">
                <div ref={outputRef} className="flex-1 overflow-auto p-6">
                  {streamError ? (
                    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium text-red-400">
                        <AlertCircle className="h-4 w-4" />
                        Error
                      </div>
                      <p className="mt-2 text-sm text-red-300/80">
                        {streamError}
                      </p>
                      <p className="mt-2 text-xs text-zinc-500">
                        Check that you have an LLM provider configured in
                        Settings, or try again.
                      </p>
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
                          {formatTokens(
                            runMeta.tokensIn + runMeta.tokensOut,
                          )}{" "}
                          tokens
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                          <Coins className="h-3 w-3" />
                          {formatCost(runMeta.costUsd)}
                        </div>
                        {savedRunId && (
                          <a
                            href={`/runs/${savedRunId}`}
                            className="text-[11px] font-medium text-indigo-400 transition-colors hover:text-indigo-300"
                          >
                            Saved as {savedRunId.slice(0, 12)}...
                          </a>
                        )}
                      </div>
                      <button
                        onClick={handleRun}
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
                        onClick={handleRun}
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
