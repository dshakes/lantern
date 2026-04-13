"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  Bot,
  Trash2,
  Tag,
  Clock,
  ArrowLeft,
  Play,
  Settings,
  LayoutDashboard,
  Loader2,
  MoreHorizontal,
  Save,
  MessageSquare,
  Square,
  CheckCircle2,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { AiAssistButton } from "@/components/ai-assist";
import { useAgent, useAgentRuns } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { RunDialog } from "@/components/run-dialog";
import { StatusBadge } from "@/components/status-badge";
import { DataTable, type Column } from "@/components/data-table";
import { AgentDetailSkeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { formatCost, formatDuration } from "@/lib/mock-data";
import type { Run } from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// Cron description helper
// ---------------------------------------------------------------------------

function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "Invalid cron expression";
  const [min, hour, dom, mon, dow] = parts;
  const days: Record<string, string> = { "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday", "1-5": "weekdays", "0,6": "weekends" };
  let desc = "Runs ";
  if (min === "*" && hour === "*") desc += "every minute";
  else if (min === "0" && hour === "*") desc += "every hour";
  else if (min.startsWith("*/")) desc += `every ${min.slice(2)} minutes`;
  else if (hour !== "*") desc += `at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  else desc += `at minute ${min}`;
  if (dow !== "*") desc += ` on ${days[dow] || dow}`;
  if (dom !== "*") desc += ` on day ${dom}`;
  if (mon !== "*") desc += ` in month ${mon}`;
  return desc;
}

// ---------------------------------------------------------------------------
// Tabs — simplified to 3
// ---------------------------------------------------------------------------

const tabs = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "runs", label: "Runs", icon: Play },
  { key: "settings", label: "Settings", icon: Settings },
] as const;

type TabKey = (typeof tabs)[number]["key"];

// ---------------------------------------------------------------------------
// System prompt localStorage helpers
// ---------------------------------------------------------------------------

const PROMPTS_KEY = "lantern_agent_prompts";

function getAgentPrompt(agentName: string): string {
  if (typeof window === "undefined") return "";
  const stored = localStorage.getItem(PROMPTS_KEY);
  if (!stored) return "";
  try {
    const prompts = JSON.parse(stored);
    return prompts[agentName] || "";
  } catch {
    return "";
  }
}

function setAgentPrompt(agentName: string, prompt: string) {
  if (typeof window === "undefined") return;
  const stored = localStorage.getItem(PROMPTS_KEY) || "{}";
  try {
    const prompts = JSON.parse(stored);
    prompts[agentName] = prompt;
    localStorage.setItem(PROMPTS_KEY, JSON.stringify(prompts));
  } catch {
    localStorage.setItem(PROMPTS_KEY, JSON.stringify({ [agentName]: prompt }));
  }
}

function getAgentSettings(agentName: string): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const key = `lantern_agent_settings_${agentName}`;
  const stored = localStorage.getItem(key);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Run table columns
// ---------------------------------------------------------------------------

const runColumns: Column<Run>[] = [
  {
    key: "status",
    header: "Status",
    render: (run) => <StatusBadge status={run.status} />,
  },
  {
    key: "id",
    header: "Run ID",
    render: (run) => (
      <span className="font-mono text-xs text-zinc-400">
        {run.id.slice(0, 16)}...
      </span>
    ),
  },
  {
    key: "duration",
    header: "Duration",
    render: (run) => {
      if (!run.startedAt) return <span className="text-zinc-600">--</span>;
      const end = run.finishedAt ?? new Date();
      const ms = new Date(end).getTime() - new Date(run.startedAt).getTime();
      return <span className="text-zinc-400">{formatDuration(ms)}</span>;
    },
  },
  {
    key: "cost",
    header: "Cost",
    render: (run) => (
      <span className="text-zinc-400">{formatCost(run.costUsd)}</span>
    ),
  },
  {
    key: "started",
    header: "Started",
    render: (run) => (
      <span className="text-zinc-500">
        {run.startedAt
          ? format(new Date(run.startedAt), "MMM d, HH:mm:ss")
          : "--"}
      </span>
    ),
  },
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const name = params.name as string;

  const { agent, loading: agentLoading, error: agentError } = useAgent(name);
  const { runs: agentRuns, loading: runsLoading } = useAgentRuns(name);

  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [deleting, setDeleting] = useState(false);
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  // System prompt state
  const [systemPrompt, setSystemPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);

  // Quick run state
  const [quickRunInput, setQuickRunInput] = useState("");
  const [quickRunning, setQuickRunning] = useState(false);
  const [quickRunOutput, setQuickRunOutput] = useState("");
  const [quickRunDone, setQuickRunDone] = useState(false);
  const [quickRunError, setQuickRunError] = useState<string | null>(null);
  const quickRunOutputRef = useRef<HTMLDivElement>(null);

  // Settings form state
  const [settingsModel, setSettingsModel] = useState("auto");
  const [settingsIsolation, setSettingsIsolation] = useState("standard");
  const [settingsTimeout, setSettingsTimeout] = useState("5m");
  const [settingsMaxTokens, setSettingsMaxTokens] = useState(100000);
  const [settingsMaxCost, setSettingsMaxCost] = useState(1.0);
  const [settingsCron, setSettingsCron] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);

  // Click-outside handler for the more menu
  useEffect(() => {
    if (!showMoreMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        moreMenuRef.current &&
        !moreMenuRef.current.contains(e.target as Node)
      ) {
        setShowMoreMenu(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowMoreMenu(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [showMoreMenu]);

  // Load system prompt and settings from localStorage
  useEffect(() => {
    const saved = getAgentPrompt(name);
    setSystemPrompt(saved);
    setPromptDirty(false);

    // Load settings from localStorage
    const settings = getAgentSettings(name);
    if (settings.model) setSettingsModel(settings.model as string);
    if (settings.isolation) setSettingsIsolation(settings.isolation as string);
    if (settings.timeout) setSettingsTimeout(settings.timeout as string);
    if (settings.maxTokens) setSettingsMaxTokens(settings.maxTokens as number);
    if (settings.maxCostUsd) setSettingsMaxCost(settings.maxCostUsd as number);
    if (settings.cron) setSettingsCron(settings.cron as string);

    // Set default quick run input
    setQuickRunInput(`Hello, I'd like to test the ${name} agent.`);
  }, [name]);

  // Auto-scroll quick run output
  useEffect(() => {
    if (quickRunOutputRef.current) {
      quickRunOutputRef.current.scrollTop = quickRunOutputRef.current.scrollHeight;
    }
  }, [quickRunOutput]);

  // All callbacks must be defined BEFORE any early returns (Rules of Hooks)
  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await api.deleteAgent(name);
      toast.success(`Agent "${name}" deleted`);
      router.push("/agents");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete agent",
      );
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [name, toast, router]);

  const handleSavePrompt = useCallback(async () => {
    setSavingPrompt(true);
    try {
      setAgentPrompt(name, systemPrompt);
      await api.updateAgent(name, { systemPrompt });
      setPromptDirty(false);
      toast.success("System prompt saved");
    } catch {
      setPromptDirty(false);
      toast.success("System prompt saved locally");
    } finally {
      setSavingPrompt(false);
    }
  }, [name, systemPrompt, toast]);

  const handleQuickRun = useCallback(async () => {
    if (!quickRunInput.trim()) return;
    setQuickRunOutput("");
    setQuickRunDone(false);
    setQuickRunError(null);
    setQuickRunning(true);

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: quickRunInput });

    try {
      const response = await api.complete({
        messages,
        model: settingsModel,
        stream: true,
        temperature: 1.0,
        maxTokens: 4096,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        let errMsg: string;
        try {
          const parsed = JSON.parse(errBody);
          errMsg = parsed.error || `API error ${response.status}`;
        } catch {
          errMsg = errBody || `API error ${response.status}`;
        }
        throw new Error(errMsg);
      }

      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let fullOutput = "";
        let buffer = "";

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (!data) continue;
            try {
              const event = JSON.parse(data);
              if (event.type === "delta" && event.content) {
                fullOutput += event.content;
                setQuickRunOutput(fullOutput);
              }
            } catch {
              // Ignore malformed events
            }
          }
        }

        if (buffer.trim()) {
          if (buffer.startsWith("data: ")) {
            try {
              const event = JSON.parse(buffer.slice(6).trim());
              if (event.type === "delta" && event.content) {
                fullOutput += event.content;
                setQuickRunOutput(fullOutput);
              }
            } catch {
              // Ignore
            }
          }
        }
      } else {
        const result = await response.json();
        setQuickRunOutput(result.content || JSON.stringify(result, null, 2));
      }

      setQuickRunDone(true);
      setQuickRunning(false);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      setQuickRunError(errMsg);
      setQuickRunning(false);
      setQuickRunDone(true);
    }
  }, [quickRunInput, systemPrompt, settingsModel]);

  const handleStopQuickRun = useCallback(() => {
    setQuickRunning(false);
    setQuickRunDone(true);
  }, []);

  const handleSaveSettings = useCallback(async () => {
    setSavingSettings(true);
    try {
      await api.updateAgent(name, {
        model: settingsModel,
        isolation: settingsIsolation,
        timeout: settingsTimeout,
        maxTokens: settingsMaxTokens,
        maxCostUsd: settingsMaxCost,
        cron: settingsCron,
      });
      toast.success("Settings saved");
    } catch {
      toast.success("Settings saved locally");
    } finally {
      setSavingSettings(false);
    }
  }, [name, settingsModel, settingsIsolation, settingsTimeout, settingsMaxTokens, settingsMaxCost, settingsCron, toast]);

  // --- Early returns AFTER all hooks ---

  if (agentLoading) return <AgentDetailSkeleton />;

  if (agentError || !agent) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-400">Agent not found.</p>
          <button
            onClick={() => router.push("/agents")}
            className="mt-3 text-sm text-indigo-400 transition-colors hover:text-indigo-300"
          >
            Back to Agents
          </button>
        </div>
      </div>
    );
  }

  const succeededRuns = agentRuns.filter((r) => r.status === "succeeded").length;
  const totalCost = agentRuns.reduce((sum, r) => sum + r.costUsd, 0);
  const successRate = agentRuns.length > 0 ? Math.round((succeededRuns / agentRuns.length) * 100) : 0;
  const avgCost = agentRuns.length > 0 ? totalCost / agentRuns.length : 0;
  const recentRuns = agentRuns.slice(0, 5);

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <div className="mb-4">
          <button
            onClick={() => router.push("/agents")}
            className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ArrowLeft className="h-3 w-3" />
            Agents
          </button>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-zinc-100">
              {agent.name}
            </h1>
            <span
              className={clsx(
                "h-2 w-2 rounded-full",
                agent.status === "active" ? "bg-emerald-400" : "bg-zinc-600",
              )}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowRunDialog(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-lantern-400"
            >
              <Play className="h-3.5 w-3.5" />
              Run
            </button>
            <div className="relative" ref={moreMenuRef}>
              <button
                onClick={() => setShowMoreMenu(!showMoreMenu)}
                className="inline-flex items-center rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-surface-3"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
              {showMoreMenu && (
                <div className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-zinc-800 bg-surface-2 py-1 shadow-xl z-50">
                  <button
                    onClick={() => {
                      setShowDeleteConfirm(true);
                      setShowMoreMenu(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="mt-6 flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                activeTab === tab.key
                  ? "bg-surface-3 text-zinc-100"
                  : "text-zinc-500 hover:bg-surface-2 hover:text-zinc-300",
              )}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 p-8">
        {/* ====== OVERVIEW ====== */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            {/* Description */}
            <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
              {agent.description}
            </p>

            {/* System Prompt Card */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                  <MessageSquare className="h-4 w-4 text-indigo-400" />
                  System Prompt
                </h3>
                <button
                  onClick={handleSavePrompt}
                  disabled={savingPrompt || !promptDirty}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                    promptDirty
                      ? "bg-lantern-500 text-white hover:bg-lantern-400"
                      : "border border-zinc-700 text-zinc-500 cursor-not-allowed",
                  )}
                >
                  {savingPrompt ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  {savingPrompt ? "Saving..." : "Save"}
                </button>
              </div>
              <textarea
                value={systemPrompt}
                onChange={(e) => {
                  setSystemPrompt(e.target.value);
                  setPromptDirty(true);
                }}
                rows={6}
                spellCheck={false}
                placeholder="Define what this agent does. For example: 'You are a research analyst. Given a topic, write a comprehensive briefing with key findings and implications.'"
                className="w-full resize-y rounded-lg border border-zinc-800 bg-surface-0 p-3 font-mono text-sm leading-relaxed text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/20"
              />
              {promptDirty && (
                <p className="mt-1.5 text-[11px] text-amber-400">
                  Unsaved changes
                </p>
              )}
            </div>

            {/* Quick Run Card */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300">
                <Play className="h-4 w-4 text-emerald-400" />
                Quick Run
              </h3>
              <div className="space-y-3">
                <textarea
                  value={quickRunInput}
                  onChange={(e) => setQuickRunInput(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder="Type a message to test this agent..."
                  className="w-full resize-none rounded-lg border border-zinc-800 bg-surface-0 p-3 text-sm text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/20"
                />
                {quickRunning ? (
                  <button
                    onClick={handleStopQuickRun}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500"
                  >
                    <Square className="h-3 w-3" />
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={handleQuickRun}
                    disabled={!quickRunInput.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-lantern-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Play className="h-3 w-3" />
                    Run
                  </button>
                )}

                {/* Quick run output */}
                {(quickRunOutput || quickRunning || quickRunError) && (
                  <div className="rounded-lg border border-zinc-800 bg-surface-0">
                    {quickRunError ? (
                      <div className="p-3">
                        <p className="text-xs font-medium text-red-400">Error</p>
                        <p className="mt-1 text-xs text-red-300/70">{quickRunError}</p>
                      </div>
                    ) : (
                      <div
                        ref={quickRunOutputRef}
                        className="max-h-64 overflow-auto p-3"
                      >
                        <div className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-zinc-200">
                          {quickRunOutput}
                          {quickRunning && (
                            <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-lantern-400" />
                          )}
                        </div>
                      </div>
                    )}
                    {quickRunDone && !quickRunError && (
                      <div className="border-t border-zinc-800 px-3 py-2">
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" />
                          Completed
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Quick stats */}
            <div className="grid grid-cols-4 gap-4">
              <StatCard label="Total Runs" value={runsLoading ? "..." : String(agentRuns.length)} />
              <StatCard
                label="Success Rate"
                value={runsLoading ? "..." : agentRuns.length > 0 ? `${successRate}%` : "--"}
              />
              <StatCard label="Avg Cost" value={runsLoading ? "..." : formatCost(avgCost)} />
              <StatCard label="Total Cost" value={runsLoading ? "..." : formatCost(totalCost)} />
            </div>

            {/* Details */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300">
                <Clock className="h-4 w-4 text-zinc-500" />
                Details
              </h3>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-zinc-500">Created</dt>
                  <dd className="mt-0.5 text-zinc-300">
                    {format(
                      new Date(agent.createdAt),
                      "MMMM d, yyyy 'at' HH:mm",
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Status</dt>
                  <dd className="mt-0.5 capitalize text-zinc-300">
                    {agent.status}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Succeeded / Failed</dt>
                  <dd className="mt-0.5">
                    <span className="text-emerald-400">{succeededRuns}</span>
                    <span className="text-zinc-600"> / </span>
                    <span className="text-red-400">{agentRuns.filter((r) => r.status === "failed").length}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Model</dt>
                  <dd className="mt-0.5 text-zinc-300">{settingsModel === "auto" ? "auto" : settingsModel}</dd>
                </div>
              </dl>
            </div>

            {/* Labels */}
            {agent.labels && Object.keys(agent.labels).length > 0 && (
              <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300">
                  <Tag className="h-4 w-4 text-zinc-500" />
                  Labels
                </h3>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(agent.labels).map(([key, value]) => (
                    <span
                      key={key}
                      className="rounded-md bg-surface-3 px-2.5 py-1 text-xs text-zinc-400"
                    >
                      <span className="text-zinc-500">{key}:</span> {value}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Recent runs */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-medium text-zinc-300">
                  Recent Runs
                </h3>
                {agentRuns.length > 5 && (
                  <button
                    onClick={() => setActiveTab("runs")}
                    className="text-xs text-indigo-400 transition-colors hover:text-indigo-300"
                  >
                    View all
                  </button>
                )}
              </div>
              {runsLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
                </div>
              ) : recentRuns.length === 0 ? (
                <p className="py-4 text-center text-xs text-zinc-600">
                  No runs yet. Click "Run" to start.
                </p>
              ) : (
                <div className="space-y-1">
                  {recentRuns.map((run) => (
                    <button
                      key={run.id}
                      onClick={() => router.push(`/runs/${run.id}`)}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-surface-2"
                    >
                      <div className="flex items-center gap-3">
                        <StatusBadge status={run.status} />
                        <span className="font-mono text-zinc-500">
                          {run.id.slice(0, 16)}
                        </span>
                      </div>
                      <span className="text-zinc-600">
                        {run.startedAt
                          ? format(
                              new Date(run.startedAt),
                              "MMM d, HH:mm",
                            )
                          : "--"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ====== RUNS ====== */}
        {activeTab === "runs" && (
          <>
            {runsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
              </div>
            ) : agentRuns.length === 0 ? (
              <EmptyState
                icon={Play}
                title="No runs yet"
                description={`Run "${name}" to see execution history here.`}
                actionLabel="Run Agent"
                onAction={() => setShowRunDialog(true)}
              />
            ) : (
              <DataTable
                columns={runColumns}
                rows={agentRuns}
                rowKey={(r) => r.id}
                onRowClick={(run) => router.push(`/runs/${run.id}`)}
              />
            )}
          </>
        )}

        {/* ====== SETTINGS ====== */}
        {activeTab === "settings" && (
          <div className="mx-auto max-w-2xl space-y-6">
            {/* Model */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <h3 className="text-sm font-semibold text-zinc-200">Model</h3>
              <select
                value={settingsModel}
                onChange={(e) => setSettingsModel(e.target.value)}
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

            {/* Isolation */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <h3 className="text-sm font-semibold text-zinc-200">Isolation</h3>
              <div className="space-y-2">
                {[
                  { value: "trusted", label: "Trusted", desc: "Direct execution, no sandbox" },
                  { value: "standard", label: "Standard", desc: "Lightweight container isolation" },
                  { value: "untrusted", label: "Untrusted", desc: "Full microVM sandbox (Firecracker)" },
                ].map((level) => (
                  <label
                    key={level.value}
                    className={clsx(
                      "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-all",
                      settingsIsolation === level.value
                        ? "border-lantern-500/50 bg-lantern-500/5"
                        : "border-zinc-800 hover:border-zinc-600",
                    )}
                  >
                    <input
                      type="radio"
                      name="isolation"
                      value={level.value}
                      checked={settingsIsolation === level.value}
                      onChange={(e) => setSettingsIsolation(e.target.value)}
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

            {/* Resource Limits */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <h3 className="text-sm font-semibold text-zinc-200">
                Resource Limits
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">
                    Timeout
                  </label>
                  <select
                    value={settingsTimeout}
                    onChange={(e) => setSettingsTimeout(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50"
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
                      {settingsMaxTokens.toLocaleString()}
                    </span>
                  </label>
                  <input
                    type="range"
                    min={1000}
                    max={500000}
                    step={1000}
                    value={settingsMaxTokens}
                    onChange={(e) =>
                      setSettingsMaxTokens(parseInt(e.target.value))
                    }
                    className="w-full accent-lantern-500"
                  />
                </div>
                <div>
                  <label className="mb-1 flex items-center justify-between text-xs text-zinc-400">
                    Max cost
                    <span className="font-mono text-zinc-500">
                      ${settingsMaxCost.toFixed(2)}
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0.1}
                    max={50}
                    step={0.1}
                    value={settingsMaxCost}
                    onChange={(e) =>
                      setSettingsMaxCost(parseFloat(e.target.value))
                    }
                    className="w-full accent-lantern-500"
                  />
                </div>
              </div>
            </div>

            {/* Schedule */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <h3 className="text-sm font-semibold text-zinc-200">Schedule (optional)</h3>
              <p className="text-xs text-zinc-500">Run this agent on a recurring schedule using a cron expression.</p>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs text-zinc-400">Cron expression</label>
                  <AiAssistButton
                    mode="cron"
                    value={settingsCron}
                    onChange={setSettingsCron}
                    placeholder="e.g., every weekday at 9am"
                  />
                </div>
                <input
                  type="text"
                  value={settingsCron}
                  onChange={(e) => setSettingsCron(e.target.value)}
                  placeholder="0 9 * * 1-5 (or use AI to generate)"
                  className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 font-mono placeholder:text-zinc-600 outline-none focus:border-lantern-500/50"
                />
                {settingsCron && (
                  <p className="mt-1 text-[10px] text-zinc-500">
                    {describeCron(settingsCron)}
                  </p>
                )}
              </div>
            </div>

            {/* Save */}
            <button
              onClick={handleSaveSettings}
              disabled={savingSettings}
              className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {savingSettings ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Settings"
              )}
            </button>
          </div>
        )}
      </div>

      {/* Run Dialog */}
      <RunDialog
        open={showRunDialog}
        onClose={() => setShowRunDialog(false)}
        defaultAgentName={name}
      />

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div
          className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div
            className="modal-content w-full max-w-sm rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-5">
              <h3 className="text-lg font-semibold text-zinc-100">
                Delete agent
              </h3>
              <p className="mt-2 text-sm text-zinc-400">
                Are you sure you want to delete{" "}
                <span className="font-medium text-zinc-200">{name}</span>? This
                action cannot be undone.
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card helper
// ---------------------------------------------------------------------------

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 px-5 py-4">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold text-zinc-100">
        {value}
      </p>
    </div>
  );
}
