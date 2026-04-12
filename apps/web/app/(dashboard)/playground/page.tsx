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
  Trash2,
  AlertCircle,
} from "lucide-react";
import clsx from "clsx";
import {
  agents,
  modelOptions,
  agentInputExamples,
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

interface PlaygroundRun {
  id: string;
  agentName: string;
  model: string;
  input: string;
  startedAt: Date;
  finishedAt?: Date;
  events: StreamEvent[];
  status: "running" | "succeeded" | "failed";
}

// Demo event sets keyed by agent name for the playground simulation
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

export default function PlaygroundPage() {
  // Input config state
  const [selectedAgent, setSelectedAgent] = useState(agents[0].name);
  const [selectedModel, setSelectedModel] = useState("auto");
  const [inputJson, setInputJson] = useState(
    JSON.stringify(agentInputExamples[agents[0].name], null, 2)
  );
  const [jsonValid, setJsonValid] = useState(true);

  // Advanced settings
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [temperature, setTemperature] = useState(1.0);
  const [maxTokens, setMaxTokens] = useState(100000);
  const [costLimit, setCostLimit] = useState("1.00");
  const [streamEnabled, setStreamEnabled] = useState(true);

  // Run state
  const [currentEvents, setCurrentEvents] = useState<StreamEvent[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [runHistory, setRunHistory] = useState<PlaygroundRun[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Stream simulation
  const { visibleEvents, streamingText, isStreaming, isComplete, reset } =
    useStreamSimulation(currentEvents, {
      enabled: isRunning,
      onComplete: () => {
        setIsRunning(false);
      },
    });

  // Validate JSON as user types
  useEffect(() => {
    setJsonValid(isValidJson(inputJson));
  }, [inputJson]);

  // Update input example when agent changes
  const handleAgentChange = useCallback((agentName: string) => {
    setSelectedAgent(agentName);
    const example = agentInputExamples[agentName];
    if (example) {
      setInputJson(JSON.stringify(example, null, 2));
    }
  }, []);

  const handlePrettyPrint = useCallback(() => {
    if (isValidJson(inputJson)) {
      setInputJson(prettyPrintJson(inputJson));
    }
  }, [inputJson]);

  const handleFillExample = useCallback(() => {
    const example = agentInputExamples[selectedAgent];
    if (example) {
      setInputJson(JSON.stringify(example, null, 2));
    }
  }, [selectedAgent]);

  const handleRun = useCallback(() => {
    if (!jsonValid || !inputJson.trim()) return;

    // Pick demo events for the selected agent
    const events =
      demoEventSets[selectedAgent] || sampleRunEvents;

    // Tag events for this playground run
    const taggedEvents = events.map((e) => ({
      ...e,
      runId: `playground_${Date.now()}`,
    }));

    setCurrentEvents(taggedEvents);
    setIsRunning(true);
    reset();

    // After a small tick, re-trigger simulation by updating events
    setTimeout(() => {
      setCurrentEvents([...taggedEvents]);
    }, 10);
  }, [selectedAgent, jsonValid, inputJson, reset]);

  const handleStop = useCallback(() => {
    setIsRunning(false);
    reset();
  }, [reset]);

  const handleRunAgain = useCallback(() => {
    handleRun();
  }, [handleRun]);

  // Compute run summary from visible events
  const runSummary = useMemo(() => {
    if (visibleEvents.length === 0) return null;

    const endEvent = visibleEvents.find((e) => e.kind === "end");
    if (!endEvent) return null;

    return {
      status: String(endEvent.data.status),
      durationMs: endEvent.data.totalDurationMs as number,
      costUsd: endEvent.data.totalCostUsd as number,
      tokensIn: endEvent.data.totalTokensIn as number,
      tokensOut: endEvent.data.totalTokensOut as number,
    };
  }, [visibleEvents]);

  // Extract final output from the last llm_delta event
  const finalOutput = useMemo(() => {
    const llmDeltas = visibleEvents.filter((e) => e.kind === "llm_delta");
    if (llmDeltas.length === 0) return null;
    const last = llmDeltas[llmDeltas.length - 1];
    return String(last.data.text);
  }, [visibleEvents]);

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
                    <option key={agent.id} value={agent.name}>
                      {agent.name}
                    </option>
                  ))}
              </select>
              <p className="mt-1 text-xs text-zinc-600">
                {agents.find((a) => a.name === selectedAgent)?.description}
              </p>
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
                {modelOptions.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
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
                      min="1000"
                      max="200000"
                      step="1000"
                      value={maxTokens}
                      onChange={(e) =>
                        setMaxTokens(parseInt(e.target.value))
                      }
                      className="mt-1.5 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-700 accent-lantern-500 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-lantern-500"
                    />
                    <div className="mt-0.5 flex justify-between text-[10px] text-zinc-600">
                      <span>1k</span>
                      <span>200k</span>
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
                        setCurrentEvents(run.events);
                        setIsRunning(true);
                        reset();
                        setTimeout(() => {
                          setCurrentEvents([...run.events]);
                        }, 10);
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
                      </div>
                      <span className="text-[11px] text-zinc-600">
                        {run.startedAt.toLocaleTimeString()}
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
            {visibleEvents.length > 0 && (
              <EventCountBadge count={visibleEvents.length} />
            )}
          </div>

          {/* Output area */}
          <div className="flex-1 overflow-hidden">
            {visibleEvents.length === 0 && !isStreaming ? (
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
              /* Active / completed state */
              <div className="flex h-full flex-col">
                <div className="flex-1 overflow-hidden">
                  <EventStream
                    events={visibleEvents}
                    streaming={isStreaming}
                    streamingText={streamingText}
                  />
                </div>

                {/* Completion summary */}
                {isComplete && runSummary && (
                  <div className="flex-shrink-0 border-t border-zinc-800 bg-surface-1/50 px-6 py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <span
                          className={clsx(
                            "inline-flex items-center gap-1.5 text-xs font-medium",
                            runSummary.status === "succeeded"
                              ? "text-emerald-400"
                              : "text-red-400"
                          )}
                        >
                          {runSummary.status === "succeeded" ? "Completed" : "Failed"}
                        </span>
                        <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                          <Clock className="h-3 w-3" />
                          {formatDuration(runSummary.durationMs)}
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                          <Braces className="h-3 w-3" />
                          {formatTokens(runSummary.tokensIn + runSummary.tokensOut)} tokens
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                          <Coins className="h-3 w-3" />
                          {formatCost(runSummary.costUsd)}
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

                    {/* Final output collapsible */}
                    {finalOutput && (
                      <div className="mt-3">
                        <JsonViewer
                          data={{ output: finalOutput.slice(0, 200) + "..." }}
                          label="Final Output"
                        />
                      </div>
                    )}
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
