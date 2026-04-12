"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  Bot,
  Rocket,
  Trash2,
  Tag,
  Clock,
  ArrowLeft,
  GitBranch,
  Play,
  Settings,
  LayoutDashboard,
  CheckCircle2,
  Loader2,
  PenTool,
  Code2,
  MessageSquare,
  Plug,
  ScrollText,
  BarChart3,
  ExternalLink,
  ToggleLeft,
  ToggleRight,
  Plus,
  Filter,
  RefreshCw,
  Brain,
  Sparkles,
  Send,
  ChevronRight,
  X,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useAgent, useAgentRuns, useAgentVersions } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { RunDialog } from "@/components/run-dialog";
import { StatusBadge } from "@/components/status-badge";
import { DataTable, type Column } from "@/components/data-table";
import { AgentDetailSkeleton } from "@/components/skeleton";
import { formatCost, formatDuration } from "@/lib/mock-data";
import type { Run, AgentVersion } from "@/lib/mock-data";

const tabs = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "code", label: "Code", icon: Code2 },
  { key: "versions", label: "Versions", icon: GitBranch },
  { key: "runs", label: "Runs", icon: Play },
  { key: "surfaces", label: "Surfaces", icon: MessageSquare },
  { key: "connectors", label: "Connectors", icon: Plug },
  { key: "logs", label: "Logs", icon: ScrollText },
  { key: "metrics", label: "Metrics", icon: BarChart3 },
  { key: "settings", label: "Settings", icon: Settings },
] as const;

type TabKey = (typeof tabs)[number]["key"];

const runColumns: Column<Run>[] = [
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
    key: "status",
    header: "Status",
    render: (run) => <StatusBadge status={run.status} />,
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

const versionColumns: Column<AgentVersion>[] = [
  {
    key: "digest",
    header: "Digest",
    render: (v) => (
      <span className="font-mono text-xs text-zinc-400">{v.digest}</span>
    ),
  },
  {
    key: "created",
    header: "Created",
    render: (v) => (
      <span className="text-zinc-500">
        {format(new Date(v.createdAt), "MMM d, yyyy HH:mm")}
      </span>
    ),
  },
  {
    key: "promoted",
    header: "Status",
    render: (v) =>
      v.promoted ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-lantern-500/10 px-2.5 py-0.5 text-xs font-medium text-lantern-500">
          <CheckCircle2 className="h-3 w-3" />
          promoted
        </span>
      ) : (
        <span className="text-xs text-zinc-600">--</span>
      ),
  },
];

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const toast = useToast();
  const name = params.name as string;

  const { agent, loading: agentLoading, error: agentError } = useAgent(name);
  const { runs: agentRuns, loading: runsLoading } = useAgentRuns(name);
  const { versions, loading: versionsLoading } = useAgentVersions(name);

  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [deleting, setDeleting] = useState(false);
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // AI chat sidebar
  const [showAiChat, setShowAiChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  if (agentLoading) return <AgentDetailSkeleton />;

  if (agentError || !agent) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-zinc-500">Agent not found.</p>
      </div>
    );
  }

  const succeededRuns = agentRuns.filter((r) => r.status === "succeeded").length;
  const failedRuns = agentRuns.filter((r) => r.status === "failed").length;
  const totalCost = agentRuns.reduce((sum, r) => sum + r.costUsd, 0);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteAgent(name);
      toast.success(`Agent "${name}" deleted`);
      router.push("/agents");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete agent");
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleChatSend = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const userMessage = chatInput.trim();
    setChatInput("");
    setChatMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setChatLoading(true);

    try {
      const res = await api.complete({
        messages: [
          {
            role: "system",
            content: `You are an AI assistant for the Lantern agent "${name}". This agent: ${agent.description}. You help users manage, configure, and debug this agent. Be concise and actionable. Current status: ${agent.status}. Total runs: ${agentRuns.length}. Success rate: ${agentRuns.length > 0 ? Math.round((succeededRuns / agentRuns.length) * 100) : 0}%.`,
          },
          ...chatMessages.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: userMessage },
        ],
        model: "auto",
        maxTokens: 1024,
      });

      if (res.ok) {
        const data = await res.json();
        setChatMessages((prev) => [...prev, { role: "assistant", content: data.content ?? "I could not generate a response." }]);
      } else {
        setChatMessages((prev) => [...prev, { role: "assistant", content: "Sorry, I could not connect to the LLM. Please check your provider settings." }]);
      }
    } catch {
      setChatMessages((prev) => [...prev, { role: "assistant", content: "Connection error. Please check that your LLM provider is configured." }]);
    } finally {
      setChatLoading(false);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    }
  };

  // Mock connectivity data for the agent
  const connectedModel = "auto";
  const connectedSurfaces = [
    { id: "slack", name: "Slack", color: "text-purple-400" },
    { id: "webchat", name: "Web Chat", color: "text-indigo-400" },
  ];
  const connectedConnectors = [
    { id: "gmail", name: "Gmail", color: "text-red-400" },
    { id: "notion", name: "Notion", color: "text-zinc-300" },
    { id: "github", name: "GitHub", color: "text-zinc-300" },
  ];

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
            Back to Agents
          </button>
        </div>
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-lantern-500/10">
              <Bot className="h-5 w-5 text-lantern-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-zinc-100">
                {agent.name}
              </h1>
              <p className="mt-0.5 text-sm text-zinc-500">
                {agent.description}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAiChat(!showAiChat)}
              className={clsx(
                "inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
                showAiChat
                  ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-400"
                  : "border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/10"
              )}
            >
              <Sparkles className="h-4 w-4" />
              AI Chat
            </button>
            <button
              onClick={() => router.push(`/agents/${name}/editor`)}
              className="inline-flex items-center gap-2 rounded-lg border border-lantern-500/30 px-4 py-2 text-sm font-medium text-lantern-400 transition-colors hover:bg-lantern-500/10"
            >
              <PenTool className="h-4 w-4" />
              Visual Editor
            </button>
            <button
              onClick={() => setShowRunDialog(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3"
            >
              <Play className="h-4 w-4" />
              Run Agent
            </button>
            <button
              onClick={() => router.push("/deployments")}
              className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400"
            >
              <Rocket className="h-4 w-4" />
              Deploy
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
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
                  : "text-zinc-500 hover:bg-surface-2 hover:text-zinc-300"
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
        {activeTab === "overview" && (
          <div className="space-y-6">
            {/* Stats */}
            <div className="grid grid-cols-4 gap-4">
              <StatCard label="Current Version" value={agent.currentVersionId.slice(0, 12)} />
              <StatCard label="Total Runs" value={runsLoading ? "..." : String(agentRuns.length)} />
              <StatCard
                label="Success Rate"
                value={
                  runsLoading
                    ? "..."
                    : agentRuns.length > 0
                      ? `${Math.round((succeededRuns / agentRuns.length) * 100)}%`
                      : "--"
                }
              />
              <StatCard label="Total Cost" value={runsLoading ? "..." : formatCost(totalCost)} />
            </div>

            {/* Agent Connectivity */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <h3 className="mb-4 text-sm font-semibold text-zinc-200">Agent Connectivity</h3>
              <div className="grid grid-cols-3 gap-4">
                {/* Connected LLM */}
                <div className="rounded-lg border border-zinc-800 bg-surface-2 p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Brain className="h-4 w-4 text-indigo-400" />
                    <span className="text-xs font-medium text-zinc-300">LLM Model</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-md bg-indigo-500/10 px-2 py-0.5 text-xs font-medium text-indigo-400">
                      {connectedModel}
                    </span>
                    <span className="text-[10px] text-zinc-600">capability routing</span>
                  </div>
                </div>

                {/* Connected Surfaces */}
                <div className="rounded-lg border border-zinc-800 bg-surface-2 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <MessageSquare className="h-4 w-4 text-green-400" />
                      <span className="text-xs font-medium text-zinc-300">Surfaces</span>
                    </div>
                    <button
                      onClick={() => setActiveTab("surfaces")}
                      className="text-[10px] text-indigo-400 transition-colors hover:text-indigo-300"
                    >
                      Add <ChevronRight className="inline h-2.5 w-2.5" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {connectedSurfaces.map((s) => (
                      <span key={s.id} className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-2 py-0.5 text-[11px] text-zinc-400">
                        <MessageSquare className={clsx("h-2.5 w-2.5", s.color)} />
                        {s.name}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Connected Connectors */}
                <div className="rounded-lg border border-zinc-800 bg-surface-2 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Plug className="h-4 w-4 text-teal-400" />
                      <span className="text-xs font-medium text-zinc-300">Connectors</span>
                    </div>
                    <button
                      onClick={() => setActiveTab("connectors")}
                      className="text-[10px] text-indigo-400 transition-colors hover:text-indigo-300"
                    >
                      Add <ChevronRight className="inline h-2.5 w-2.5" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {connectedConnectors.map((c) => (
                      <span key={c.id} className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-2 py-0.5 text-[11px] text-zinc-400">
                        <Plug className={clsx("h-2.5 w-2.5", c.color)} />
                        {c.name}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
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

            {/* Info */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300">
                <Clock className="h-4 w-4 text-zinc-500" />
                Details
              </h3>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-zinc-500">Created</dt>
                  <dd className="mt-0.5 text-zinc-300">
                    {format(new Date(agent.createdAt), "MMMM d, yyyy 'at' HH:mm")}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Status</dt>
                  <dd className="mt-0.5 text-zinc-300 capitalize">{agent.status}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Succeeded / Failed</dt>
                  <dd className="mt-0.5">
                    <span className="text-emerald-400">{succeededRuns}</span>
                    <span className="text-zinc-600"> / </span>
                    <span className="text-red-400">{failedRuns}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Versions</dt>
                  <dd className="mt-0.5 text-zinc-300">
                    {versionsLoading ? "..." : versions.length}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        )}

        {activeTab === "versions" && (
          versionsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
            </div>
          ) : (
            <DataTable
              columns={versionColumns}
              rows={versions}
              rowKey={(v) => v.id}
            />
          )
        )}

        {activeTab === "runs" && (
          runsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
            </div>
          ) : (
            <DataTable
              columns={runColumns}
              rows={agentRuns}
              rowKey={(r) => r.id}
              onRowClick={(run) => router.push(`/runs/${run.id}`)}
            />
          )
        )}

        {activeTab === "code" && (
          <AgentCodeTab agentName={name} />
        )}

        {activeTab === "surfaces" && (
          <AgentSurfacesTab agentName={name} />
        )}

        {activeTab === "connectors" && (
          <AgentConnectorsTab agentName={name} />
        )}

        {activeTab === "logs" && (
          <AgentLogsTab agentName={name} />
        )}

        {activeTab === "metrics" && (
          <AgentMetricsTab agentName={name} totalRuns={agentRuns.length} succeededRuns={succeededRuns} totalCost={totalCost} />
        )}

        {activeTab === "settings" && (
          <div className="rounded-xl border border-zinc-800 bg-surface-1 p-8 text-center">
            <Settings className="mx-auto mb-3 h-8 w-8 text-zinc-600" />
            <p className="text-sm text-zinc-500">
              Agent settings -- configuration, environment variables, resource limits, and isolation class.
            </p>
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
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowDeleteConfirm(false)}>
          <div className="modal-content w-full max-w-sm rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
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

      {/* AI Chat Sidebar */}
      {showAiChat && (
        <div className="fixed right-0 top-0 z-40 flex h-full w-96 flex-col border-l border-zinc-800 bg-surface-1 shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-400" />
              <span className="text-sm font-semibold text-zinc-200">AI Assistant</span>
            </div>
            <button
              onClick={() => setShowAiChat(false)}
              className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-auto p-4 space-y-3">
            {chatMessages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Sparkles className="mb-3 h-8 w-8 text-zinc-600" />
                <p className="text-xs text-zinc-500 max-w-[220px]">
                  Ask me anything about this agent. I can help you configure, debug, and optimize it.
                </p>
                <div className="mt-4 space-y-1.5">
                  {[
                    "What runs failed today?",
                    "Add Slack integration",
                    "How can I improve success rate?",
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => {
                        setChatInput(suggestion);
                      }}
                      className="block w-full rounded-lg border border-zinc-800 bg-surface-2 px-3 py-2 text-left text-[11px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-300"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {chatMessages.map((msg, i) => (
              <div
                key={i}
                className={clsx(
                  "rounded-lg px-3 py-2 text-xs leading-relaxed",
                  msg.role === "user"
                    ? "ml-6 bg-indigo-500/10 text-indigo-200"
                    : "mr-6 bg-surface-2 text-zinc-300"
                )}
              >
                {msg.content}
              </div>
            ))}

            {chatLoading && (
              <div className="mr-6 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
                <Loader2 className="h-3 w-3 animate-spin text-indigo-400" />
                <span className="text-xs text-zinc-500">Thinking...</span>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-zinc-800 p-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask about this agent..."
                className="flex-1 rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-indigo-500"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleChatSend();
                  }
                }}
              />
              <button
                onClick={handleChatSend}
                disabled={!chatInput.trim() || chatLoading}
                className="rounded-lg bg-indigo-600 p-2 text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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

// ---------------------------------------------------------------------------
// Code tab
// ---------------------------------------------------------------------------

const sampleCode = `import { Agent, step } from "@lantern/sdk";

export default new Agent({
  name: "{{AGENT_NAME}}",
  model: "auto",

  async run(ctx) {
    // Step 1: Gather context
    const context = await step("gather-context", async () => {
      const docs = await ctx.mcp("notion").call("search", {
        query: ctx.input.topic,
      });
      return docs.results.slice(0, 5);
    });

    // Step 2: Analyze with LLM
    const analysis = await step("analyze", async () => {
      return ctx.llm.generate({
        messages: [
          {
            role: "system",
            content: "You are a research analyst. Analyze the following documents.",
          },
          {
            role: "user",
            content: \`Topic: \${ctx.input.topic}\\n\\nDocuments:\\n\${JSON.stringify(context)}\`,
          },
        ],
      });
    });

    // Step 3: Send results
    await step("notify", async () => {
      await ctx.connectors.slack.send_message({
        channel: "#research",
        text: analysis.content,
      });
    });

    return { analysis: analysis.content };
  },
});
`;

function AgentCodeTab({ agentName }: { agentName: string }) {
  const code = sampleCode.replace("{{AGENT_NAME}}", agentName);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Code2 className="h-3.5 w-3.5" />
          src/index.ts
        </div>
        <button
          onClick={() => window.open(`vscode://file/${agentName}`, "_blank")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
        >
          <ExternalLink className="h-3 w-3" />
          Edit in VS Code
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
        <div className="border-b border-zinc-800/50 bg-surface-2 px-4 py-2">
          <span className="text-xs text-zinc-500">src/index.ts</span>
        </div>
        <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-zinc-400">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surfaces tab
// ---------------------------------------------------------------------------

const allSurfaces = [
  { id: "whatsapp", name: "WhatsApp", color: "text-green-400" },
  { id: "slack", name: "Slack", color: "text-purple-400" },
  { id: "discord", name: "Discord", color: "text-indigo-400" },
  { id: "telegram", name: "Telegram", color: "text-sky-400" },
  { id: "twilio", name: "Twilio (SMS/Voice)", color: "text-red-400" },
  { id: "email", name: "Email", color: "text-amber-400" },
  { id: "webchat", name: "Web Chat", color: "text-lantern-400" },
];

function AgentSurfacesTab({ agentName }: { agentName: string }) {
  const toast = useToast();
  const storageKey = `lantern_agent_surfaces_${agentName}`;
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        setEnabled(JSON.parse(raw));
      } else {
        // Default: enable slack and webchat
        const defaults = { slack: true, webchat: true };
        setEnabled(defaults);
        localStorage.setItem(storageKey, JSON.stringify(defaults));
      }
    } catch {
      setEnabled({});
    }
  }, [storageKey]);

  const toggle = (id: string) => {
    const updated = { ...enabled, [id]: !enabled[id] };
    setEnabled(updated);
    localStorage.setItem(storageKey, JSON.stringify(updated));
    toast.success(`${allSurfaces.find((s) => s.id === id)?.name} ${updated[id] ? "enabled" : "disabled"}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-400">
          Toggle which surfaces this agent is available on.
        </p>
        <button
          onClick={() => toast.info("Navigate to Surfaces page to add new surfaces")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
        >
          <Plus className="h-3 w-3" />
          Add Surface
        </button>
      </div>
      <div className="rounded-xl border border-zinc-800 bg-surface-1 divide-y divide-zinc-800">
        {allSurfaces.map((surface) => (
          <div key={surface.id} className="flex items-center justify-between px-5 py-3.5">
            <div className="flex items-center gap-3">
              <MessageSquare className={clsx("h-4 w-4", surface.color)} />
              <span className="text-sm text-zinc-200">{surface.name}</span>
            </div>
            <button onClick={() => toggle(surface.id)}>
              {enabled[surface.id] ? (
                <ToggleRight className="h-6 w-6 text-lantern-400" />
              ) : (
                <ToggleLeft className="h-6 w-6 text-zinc-600" />
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connectors tab
// ---------------------------------------------------------------------------

const agentConnectors = [
  { id: "gmail", name: "Gmail", status: "connected" as const, icon: "text-red-400" },
  { id: "slack", name: "Slack", status: "connected" as const, icon: "text-purple-400" },
  { id: "notion", name: "Notion", status: "connected" as const, icon: "text-zinc-300" },
  { id: "github", name: "GitHub", status: "connected" as const, icon: "text-zinc-300" },
  { id: "google-calendar", name: "Google Calendar", status: "not_connected" as const, icon: "text-blue-400" },
];

function AgentConnectorsTab({ agentName }: { agentName: string }) {
  const toast = useToast();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-400">
          Connectors this agent can access during runs.
        </p>
        <button
          onClick={() => toast.info("Navigate to Connectors page to install new connectors")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
        >
          <Plus className="h-3 w-3" />
          Add Connector
        </button>
      </div>
      <div className="rounded-xl border border-zinc-800 bg-surface-1 divide-y divide-zinc-800">
        {agentConnectors.map((conn) => (
          <div key={conn.id} className="flex items-center justify-between px-5 py-3.5">
            <div className="flex items-center gap-3">
              <Plug className={clsx("h-4 w-4", conn.icon)} />
              <span className="text-sm text-zinc-200">{conn.name}</span>
            </div>
            <div className="flex items-center gap-2">
              {conn.status === "connected" ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  Connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-500/10 px-2.5 py-0.5 text-xs font-medium text-zinc-500">
                  Not connected
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logs tab
// ---------------------------------------------------------------------------

interface LogEntry {
  id: number;
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
  runId?: string;
}

const mockLogs: LogEntry[] = [
  { id: 1, ts: "2026-04-12T10:30:15Z", level: "info", message: "Run started: research-task-1", runId: "run_abc123" },
  { id: 2, ts: "2026-04-12T10:30:16Z", level: "info", message: "Step gather-context executing", runId: "run_abc123" },
  { id: 3, ts: "2026-04-12T10:30:18Z", level: "info", message: "MCP call: notion.search completed (245ms)", runId: "run_abc123" },
  { id: 4, ts: "2026-04-12T10:30:19Z", level: "info", message: "Step analyze executing", runId: "run_abc123" },
  { id: 5, ts: "2026-04-12T10:30:25Z", level: "info", message: "LLM call completed: reasoning-large (1,240 tokens)", runId: "run_abc123" },
  { id: 6, ts: "2026-04-12T10:30:26Z", level: "warn", message: "Rate limit approaching: Slack API (238/250 per minute)", runId: "run_abc123" },
  { id: 7, ts: "2026-04-12T10:30:27Z", level: "info", message: "Step notify executing", runId: "run_abc123" },
  { id: 8, ts: "2026-04-12T10:30:28Z", level: "info", message: "Connector call: slack.send_message completed (112ms)", runId: "run_abc123" },
  { id: 9, ts: "2026-04-12T10:30:28Z", level: "info", message: "Run completed: succeeded (13.2s, $0.0034)", runId: "run_abc123" },
  { id: 10, ts: "2026-04-12T10:25:00Z", level: "error", message: "Run failed: email-draft-2 - Connector error: Gmail token expired", runId: "run_def456" },
  { id: 11, ts: "2026-04-12T10:24:55Z", level: "info", message: "Run started: email-draft-2", runId: "run_def456" },
  { id: 12, ts: "2026-04-12T10:20:00Z", level: "info", message: "Run completed: calendar-sync (4.1s, $0.0012)", runId: "run_ghi789" },
  { id: 13, ts: "2026-04-12T10:15:30Z", level: "warn", message: "High latency detected: model router p99 > 2s", runId: "run_jkl012" },
  { id: 14, ts: "2026-04-12T10:15:00Z", level: "info", message: "Run started: calendar-sync", runId: "run_jkl012" },
  { id: 15, ts: "2026-04-12T10:10:00Z", level: "info", message: "Agent version promoted: v1.4.2" },
];

function AgentLogsTab({ agentName }: { agentName: string }) {
  const [filter, setFilter] = useState<"all" | "info" | "warn" | "error">("all");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const filtered = filter === "all" ? mockLogs : mockLogs.filter((l) => l.level === filter);

  const levelColors: Record<string, string> = {
    info: "text-blue-400",
    warn: "text-amber-400",
    error: "text-red-400",
  };

  const levelBg: Record<string, string> = {
    info: "bg-blue-500/10",
    warn: "bg-amber-500/10",
    error: "bg-red-500/10",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-zinc-500" />
          {(["all", "info", "warn", "error"] as const).map((level) => (
            <button
              key={level}
              onClick={() => setFilter(level)}
              className={clsx(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors capitalize",
                filter === level
                  ? "bg-surface-3 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              {level}
            </button>
          ))}
        </div>
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={clsx(
            "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
            autoRefresh
              ? "border-emerald-500/30 text-emerald-400"
              : "border-zinc-700 text-zinc-400 hover:text-zinc-300"
          )}
        >
          <RefreshCw className={clsx("h-3 w-3", autoRefresh && "animate-spin")} style={autoRefresh ? { animationDuration: "3s" } : undefined} />
          Auto-refresh {autoRefresh ? "on" : "off"}
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
        <div className="divide-y divide-zinc-800/50">
          {filtered.map((log) => (
            <div key={log.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-surface-2 transition-colors">
              <span className="mt-0.5 shrink-0 font-mono text-[10px] text-zinc-600 w-16">
                {format(new Date(log.ts), "HH:mm:ss")}
              </span>
              <span className={clsx("mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase", levelBg[log.level], levelColors[log.level])}>
                {log.level}
              </span>
              <span className="flex-1 text-xs text-zinc-300">{log.message}</span>
              {log.runId && (
                <span className="shrink-0 font-mono text-[10px] text-zinc-600">{log.runId.slice(0, 12)}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metrics tab
// ---------------------------------------------------------------------------

function AgentMetricsTab({
  agentName,
  totalRuns,
  succeededRuns,
  totalCost,
}: {
  agentName: string;
  totalRuns: number;
  succeededRuns: number;
  totalCost: number;
}) {
  // Mock data for charts
  const runsPerDay = [
    { day: "Mon", count: 12 },
    { day: "Tue", count: 18 },
    { day: "Wed", count: 8 },
    { day: "Thu", count: 24 },
    { day: "Fri", count: 15 },
    { day: "Sat", count: 6 },
    { day: "Sun", count: 9 },
  ];

  const avgDurations = [
    { day: "Mon", ms: 4200 },
    { day: "Tue", ms: 3800 },
    { day: "Wed", ms: 5100 },
    { day: "Thu", ms: 3200 },
    { day: "Fri", ms: 4500 },
    { day: "Sat", ms: 6000 },
    { day: "Sun", ms: 3900 },
  ];

  const costPerDay = [
    { day: "Mon", cost: 0.024 },
    { day: "Tue", cost: 0.036 },
    { day: "Wed", cost: 0.018 },
    { day: "Thu", cost: 0.042 },
    { day: "Fri", cost: 0.030 },
    { day: "Sat", cost: 0.012 },
    { day: "Sun", cost: 0.015 },
  ];

  const maxRuns = Math.max(...runsPerDay.map((d) => d.count));
  const maxDuration = Math.max(...avgDurations.map((d) => d.ms));
  const maxCost = Math.max(...costPerDay.map((d) => d.cost));

  const successRate = totalRuns > 0 ? Math.round((succeededRuns / totalRuns) * 100) : 0;
  const avgDuration = totalRuns > 0 ? formatDuration(4200) : "--";

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Total Runs (7d)" value={String(runsPerDay.reduce((s, d) => s + d.count, 0))} />
        <StatCard label="Success Rate" value={`${successRate}%`} />
        <StatCard label="Avg Duration" value={avgDuration} />
        <StatCard label="Total Cost (7d)" value={`$${costPerDay.reduce((s, d) => s + d.cost, 0).toFixed(3)}`} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Runs per day */}
        <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
          <h3 className="mb-4 text-sm font-medium text-zinc-300">Runs per day</h3>
          <div className="flex items-end gap-3 h-32">
            {runsPerDay.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1.5">
                <span className="text-[10px] text-zinc-500">{d.count}</span>
                <div
                  className="w-full rounded-t-md bg-lantern-500/30 transition-all"
                  style={{ height: `${(d.count / maxRuns) * 100}%`, minHeight: 4 }}
                />
                <span className="text-[10px] text-zinc-600">{d.day}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Avg duration */}
        <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
          <h3 className="mb-4 text-sm font-medium text-zinc-300">Average duration</h3>
          <div className="flex items-end gap-3 h-32">
            {avgDurations.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1.5">
                <span className="text-[10px] text-zinc-500">{(d.ms / 1000).toFixed(1)}s</span>
                <div
                  className="w-full rounded-t-md bg-sky-500/30 transition-all"
                  style={{ height: `${(d.ms / maxDuration) * 100}%`, minHeight: 4 }}
                />
                <span className="text-[10px] text-zinc-600">{d.day}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Success rate */}
        <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
          <h3 className="mb-4 text-sm font-medium text-zinc-300">Success rate</h3>
          <div className="flex items-center justify-center h-32">
            <div className="relative flex items-center justify-center">
              <svg className="h-28 w-28 -rotate-90" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="8" className="text-surface-3" />
                <circle
                  cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="8"
                  className="text-emerald-400"
                  strokeDasharray={`${successRate * 2.51} ${251 - successRate * 2.51}`}
                  strokeLinecap="round"
                />
              </svg>
              <span className="absolute text-lg font-bold text-zinc-100">{successRate}%</span>
            </div>
          </div>
        </div>

        {/* Cost per day */}
        <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
          <h3 className="mb-4 text-sm font-medium text-zinc-300">Cost per day</h3>
          <div className="flex items-end gap-3 h-32">
            {costPerDay.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1.5">
                <span className="text-[10px] text-zinc-500">${d.cost.toFixed(3)}</span>
                <div
                  className="w-full rounded-t-md bg-amber-500/30 transition-all"
                  style={{ height: `${(d.cost / maxCost) * 100}%`, minHeight: 4 }}
                />
                <span className="text-[10px] text-zinc-600">{d.day}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
