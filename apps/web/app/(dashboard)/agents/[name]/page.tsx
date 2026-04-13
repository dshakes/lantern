"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import {
  ArrowLeft,
  Play,
  Settings,
  Hammer,
  Calendar,
  Loader2,
  Save,
  MessageSquare,
  Square,
  CheckCircle2,
  Sparkles,
  Mail,
  ExternalLink,
  Trash2,
  ChevronDown,
  ChevronRight,
  Webhook,
  AlertCircle,
  Clock,
  Shield,
  Lock,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { AiAssistButton } from "@/components/ai-assist";
import { useAgent, useAgentRuns } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { StatusBadge } from "@/components/status-badge";
import { ExecutionLog, deduplicateSteps } from "@/components/execution-log";
import { AgentDetailSkeleton } from "@/components/skeleton";
import { formatCost, formatDuration } from "@/lib/mock-data";
import type { Run } from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "Invalid cron expression";
  const [min, hour, , , dow] = parts;
  const days: Record<string, string> = { "1-5": "weekdays", "0,6": "weekends", "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday" };
  let desc = "Runs ";
  if (min === "*" && hour === "*") desc += "every minute";
  else if (min === "0" && hour === "*") desc += "every hour";
  else if (min.startsWith("*/")) desc += `every ${min.slice(2)} minutes`;
  else if (hour !== "*") desc += `at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  else desc += `at minute ${min}`;
  if (dow !== "*") desc += ` on ${days[dow] || dow}`;
  return desc;
}

const PROMPTS_KEY = "lantern_agent_prompts";
function getAgentPrompt(n: string): string {
  if (typeof window === "undefined") return "";
  try { return JSON.parse(localStorage.getItem(PROMPTS_KEY) || "{}")[n] || ""; } catch { return ""; }
}
function setAgentPrompt(n: string, p: string) {
  if (typeof window === "undefined") return;
  try { const d = JSON.parse(localStorage.getItem(PROMPTS_KEY) || "{}"); d[n] = p; localStorage.setItem(PROMPTS_KEY, JSON.stringify(d)); } catch { localStorage.setItem(PROMPTS_KEY, JSON.stringify({ [n]: p })); }
}
function getAgentSettings(n: string): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(`lantern_agent_settings_${n}`) || "{}"); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Model Select
// ---------------------------------------------------------------------------

function ModelSelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={clsx("rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50", className)}>
      <option value="auto">Auto (recommended)</option>
      <optgroup label="Anthropic">
        <option value="reasoning-frontier">Reasoning Frontier -- Claude Opus 4</option>
        <option value="reasoning-large">Reasoning Large -- Claude Sonnet 4</option>
        <option value="reasoning-small">Reasoning Small -- Claude Haiku 4</option>
        <option value="code-large">Code Large -- Claude Sonnet 4</option>
      </optgroup>
      <optgroup label="OpenAI">
        <option value="chat-large">Chat Large -- GPT-4o</option>
        <option value="chat-small">Chat Small -- GPT-4o Mini</option>
      </optgroup>
      <optgroup label="Google">
        <option value="vision-large">Vision Large -- Gemini 2.5 Pro</option>
      </optgroup>
    </select>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const RUNS_PER_PAGE = 10;

const tabs = [
  { key: "build", label: "Build", icon: Hammer },
  { key: "runs", label: "Runs", icon: Play },
  { key: "schedule", label: "Schedule", icon: Calendar },
  { key: "settings", label: "Settings", icon: Settings },
] as const;
type TabKey = (typeof tabs)[number]["key"];

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const name = params.name as string;

  const { agent, loading: agentLoading, error: agentError } = useAgent(name);
  const { runs: agentRuns, loading: runsLoading, refresh: refreshRuns } = useAgentRuns(name);

  const initialTab = (searchParams.get("tab") as TabKey) || "build";
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // System prompt
  const [systemPrompt, setSystemPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);

  // Test state
  const [testInput, setTestInput] = useState("");
  const [testModel, setTestModel] = useState("auto");
  const [testRunning, setTestRunning] = useState(false);
  const [testOutput, setTestOutput] = useState("");
  const [testDone, setTestDone] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testMeta, setTestMeta] = useState<{ model: string; tokens: number; cost: number; duration: number } | null>(null);
  const testRef = useRef<HTMLDivElement>(null);

  // Gmail
  const [gmailConnected, setGmailConnected] = useState(false);
  const [fetchingEmails, setFetchingEmails] = useState(false);

  // Schedule
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [settingsCron, setSettingsCron] = useState("");
  const [deliveryEmailEnabled, setDeliveryEmailEnabled] = useState(false);
  const [deliveryEmail, setDeliveryEmail] = useState("");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [nextFireAt, setNextFireAt] = useState<string | null>(null);

  // Settings
  const [settingsModel, setSettingsModel] = useState("auto");
  const [settingsIsolation, setSettingsIsolation] = useState("standard");
  const [settingsTimeout, setSettingsTimeout] = useState("5m");
  const [settingsMaxTokens, setSettingsMaxTokens] = useState(100000);
  const [settingsMaxCost, setSettingsMaxCost] = useState(1.0);
  const [settingsRetention, setSettingsRetention] = useState("90d");
  const [settingsEncrypt, setSettingsEncrypt] = useState(false);
  const [settingsAuditLog, setSettingsAuditLog] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // Runs tab
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runsPage, setRunsPage] = useState(0);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);

  // Load saved state
  useEffect(() => {
    setSystemPrompt(getAgentPrompt(name));
    setPromptDirty(false);
    const s = getAgentSettings(name);
    if (s.model) setSettingsModel(s.model as string);
    if (s.isolation) setSettingsIsolation(s.isolation as string);
    if (s.timeout) setSettingsTimeout(s.timeout as string);
    if (s.maxTokens) setSettingsMaxTokens(s.maxTokens as number);
    if (s.maxCostUsd) setSettingsMaxCost(s.maxCostUsd as number);
    if (s.cron) setSettingsCron(s.cron as string);
    try { const c = JSON.parse(localStorage.getItem("lantern_connectors") || "{}"); setGmailConnected(c.gmail?.installed === true); } catch { /* */ }
    const isEmail = name.toLowerCase().includes("gmail") || name.toLowerCase().includes("email");
    setTestInput(isEmail ? "Summarize my recent emails and highlight anything urgent." : `Hello, I'd like to test the ${name} agent.`);
    api.listSchedules().then((sched) => {
      const m = sched.find((sc) => sc.agentName === name);
      if (m) { setSettingsCron(m.cronExpr); setScheduleId(m.id); setScheduleEnabled(m.enabled); if (m.nextFireAt) setNextFireAt(m.nextFireAt); if (m.deliveryEmail) { setDeliveryEmailEnabled(true); setDeliveryEmail(m.deliveryEmail); } }
    }).catch(() => {});
  }, [name]);

  useEffect(() => { if (testRef.current) testRef.current.scrollTop = testRef.current.scrollHeight; }, [testOutput]);

  const isEmailAgent = useMemo(() => name.toLowerCase().includes("gmail") || name.toLowerCase().includes("email"), [name]);

  // --- Callbacks ---

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try { await api.deleteAgent(name); toast.success(`Agent "${name}" deleted`); router.push("/agents"); } catch (err) { toast.error(err instanceof Error ? err.message : "Failed to delete"); } finally { setDeleting(false); setShowDeleteConfirm(false); }
  }, [name, toast, router]);

  const handleSavePrompt = useCallback(async () => {
    setSavingPrompt(true);
    try { setAgentPrompt(name, systemPrompt); await api.updateAgent(name, { systemPrompt }); setPromptDirty(false); toast.success("System prompt saved"); } catch { setPromptDirty(false); toast.success("System prompt saved locally"); } finally { setSavingPrompt(false); }
  }, [name, systemPrompt, toast]);

  const handleGeneratePrompt = useCallback(async () => {
    setSavingPrompt(true);
    try {
      const resp = await api.complete({ messages: [{ role: "user", content: `Generate a system prompt for an AI agent called "${name}". Description: "${agent?.description || name}". Return ONLY the prompt text.` }], model: "auto", stream: false });
      if (resp.ok) { const d = await resp.json(); const g = (d.content || d.message?.content || "").trim(); if (g) { setSystemPrompt(g); setPromptDirty(true); toast.success("System prompt generated -- review and save"); return; } }
      toast.error("Failed to generate prompt");
    } catch { toast.error("LLM unavailable. Configure a provider in Settings."); } finally { setSavingPrompt(false); }
  }, [name, agent?.description, toast]);

  const handleTestRun = useCallback(async () => {
    if (!testInput.trim()) return;
    setTestOutput(""); setTestDone(false); setTestError(null); setTestMeta(null); setTestRunning(true);
    const startTime = Date.now();
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });

    if (isEmailAgent) {
      try {
        const cs = JSON.parse(localStorage.getItem("lantern_connectors") || "{}");
        if (cs.gmail?.installed && cs.gmail?.credentials) await api.installConnector({ connectorId: "gmail", displayName: "Gmail", config: cs.gmail.credentials }).catch(() => {});
        const raw = await api.executeConnector("gmail", "list_messages", { limit: 15 });
        const data = raw as unknown as { messages?: Array<{ from: string; subject: string; snippet: string; date: string }> };
        if (data.messages?.length) {
          const list = data.messages.map((m, i) => `${i + 1}. From: ${m.from}\n   Subject: ${m.subject}\n   Preview: ${m.snippet}\n   Date: ${m.date}`).join("\n\n");
          messages.push({ role: "user", content: `${testInput}\n\nHere are my actual recent emails:\n\n${list}` });
        } else { messages.push({ role: "user", content: testInput + "\n\nNo emails found." }); }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setTestOutput(`Error fetching emails: ${msg}`); setTestDone(true); setTestRunning(false); return;
      }
    } else { messages.push({ role: "user", content: testInput }); }

    try {
      const response = await api.complete({ messages, model: testModel, stream: true, temperature: 1.0, maxTokens: 4096 });
      if (!response.ok) { const b = await response.text().catch(() => ""); let m: string; try { m = JSON.parse(b).error || `API error ${response.status}`; } catch { m = b || `API error ${response.status}`; } throw new Error(m); }
      let resolvedModel = testModel; let totalTokens = 0; let totalCost = 0;
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = response.body?.getReader(); if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder(); let full = ""; let buffer = "";
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
          for (const line of lines) { if (!line.startsWith("data: ")) continue; try { const evt = JSON.parse(line.slice(6).trim()); if (evt.type === "delta" && evt.content) { full += evt.content; setTestOutput(full); } if (evt.type === "done") { totalTokens = (evt.tokensIn || 0) + (evt.tokensOut || 0); totalCost = evt.costUsd || 0; resolvedModel = evt.model || testModel; } } catch { /* */ } }
        }
      } else { const result = await response.json(); setTestOutput(result.content || JSON.stringify(result, null, 2)); totalTokens = (result.tokensIn || 0) + (result.tokensOut || 0); totalCost = result.costUsd || 0; resolvedModel = result.model || testModel; }
      setTestMeta({ model: resolvedModel, tokens: totalTokens, cost: totalCost, duration: Date.now() - startTime });
      setTestDone(true); setTestRunning(false);
    } catch (err) { setTestError(err instanceof Error ? err.message : "Unknown error"); setTestRunning(false); setTestDone(true); }
  }, [testInput, testModel, systemPrompt, isEmailAgent, name]);

  const handleFetchEmails = useCallback(async () => {
    setFetchingEmails(true);
    try {
      const cs = JSON.parse(localStorage.getItem("lantern_connectors") || "{}");
      if (cs.gmail?.installed && cs.gmail?.credentials) await api.installConnector({ connectorId: "gmail", displayName: "Gmail", config: cs.gmail.credentials }).catch(() => {});
      const result = await api.executeConnector("gmail", "list_messages", { limit: 20 });
      const data = result.data as { messages?: Array<{ from: string; subject: string; snippet: string; date: string }>; count?: number } | undefined;
      if (data?.messages?.length) {
        const fmt = data.messages.map((m, i) => `${i + 1}. From: ${m.from}\n   Subject: ${m.subject}\n   Preview: ${m.snippet}\n   Date: ${m.date}`).join("\n\n");
        setTestInput(`Please analyze and summarize these emails:\n\n${fmt}`);
        toast.success(`Fetched ${data.count ?? data.messages.length} emails`);
      } else { toast.info("No recent emails found"); }
    } catch (err) { toast.error(err instanceof Error ? err.message : "Failed to fetch emails"); } finally { setFetchingEmails(false); }
  }, [toast]);

  const handleSaveSchedule = useCallback(async () => {
    if (!settingsCron.trim()) { toast.error("Enter a cron expression"); return; }
    setSavingSchedule(true);
    try {
      const result = await api.createSchedule({ agentName: name, cronExpr: settingsCron, deliveryEmail: deliveryEmailEnabled ? deliveryEmail : undefined, enabled: scheduleEnabled });
      setScheduleId(result.id); if (result.nextFireAt) setNextFireAt(result.nextFireAt);
      toast.success(result.nextFireAt ? `Schedule saved -- next at ${new Date(result.nextFireAt).toLocaleString()}` : "Schedule saved");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Failed to save"); } finally { setSavingSchedule(false); }
  }, [name, settingsCron, deliveryEmailEnabled, deliveryEmail, scheduleEnabled, toast]);

  const handleSaveSettings = useCallback(async () => {
    setSavingSettings(true);
    try { await api.updateAgent(name, { model: settingsModel, isolation: settingsIsolation, timeout: settingsTimeout, maxTokens: settingsMaxTokens, maxCostUsd: settingsMaxCost }); toast.success("Settings saved"); } catch { toast.success("Settings saved locally"); } finally { setSavingSettings(false); }
  }, [name, settingsModel, settingsIsolation, settingsTimeout, settingsMaxTokens, settingsMaxCost, toast]);

  const succeededRuns = agentRuns.filter((r) => r.status === "succeeded").length;
  const totalCost = agentRuns.reduce((sum, r) => sum + r.costUsd, 0);

  if (agentLoading) return <AgentDetailSkeleton />;
  if (agentError || !agent) return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center">
        <p className="text-zinc-400">Agent not found.</p>
        <button onClick={() => router.push("/agents")} className="mt-3 text-sm text-indigo-400 hover:text-indigo-300">Back to Agents</button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <button onClick={() => router.push("/agents")} className="mb-4 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300">
          <ArrowLeft className="h-3 w-3" /> Agents
        </button>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-zinc-100">{agent.name}</h1>
            <span className={clsx("h-2 w-2 rounded-full", agent.status === "active" ? "bg-emerald-400" : "bg-zinc-600")} />
          </div>
          <p className="text-sm text-zinc-500">{agent.description}</p>
        </div>
        <div className="mt-6 flex gap-1">
          {tabs.map((tab) => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={clsx("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors", activeTab === tab.key ? "bg-surface-3 text-zinc-100" : "text-zinc-500 hover:bg-surface-2 hover:text-zinc-300")}>
              <tab.icon className="h-3.5 w-3.5" /> {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 p-8">
        {/* BUILD TAB */}
        {activeTab === "build" && (
          <div className="space-y-6">
            {/* System Prompt */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300"><MessageSquare className="h-4 w-4 text-indigo-400" /> System Prompt</h3>
                <div className="flex items-center gap-2">
                  <button onClick={handleGeneratePrompt} disabled={savingPrompt} className="inline-flex items-center gap-1.5 rounded-lg border border-lantern-500/30 px-3 py-1.5 text-xs font-medium text-lantern-400 hover:bg-lantern-500/10"><Sparkles className="h-3 w-3" /> Generate with AI</button>
                  <button onClick={handleSavePrompt} disabled={savingPrompt || !promptDirty} className={clsx("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium", promptDirty ? "bg-lantern-500 text-white hover:bg-lantern-400" : "border border-zinc-700 text-zinc-500 cursor-not-allowed")}>
                    {savingPrompt ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} {savingPrompt ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
              <textarea value={systemPrompt} onChange={(e) => { setSystemPrompt(e.target.value); setPromptDirty(true); }} rows={6} spellCheck={false} placeholder="Define what this agent does..." className="w-full resize-y rounded-lg border border-zinc-800 bg-surface-0 p-3 font-mono text-sm leading-relaxed text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/20" />
              {promptDirty && <p className="mt-1.5 text-[11px] text-amber-400">Unsaved changes</p>}
            </div>

            {/* Resources & Security */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
                <h4 className="mb-2 text-xs font-medium text-zinc-500">Model</h4>
                <p className="text-sm font-medium text-zinc-200">{settingsModel === "auto" ? "Auto (recommended)" : settingsModel}</p>
                <button onClick={() => setActiveTab("settings")} className="mt-2 text-[11px] text-indigo-400 hover:text-indigo-300">Change</button>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
                <h4 className="mb-2 text-xs font-medium text-zinc-500">Connectors</h4>
                {isEmailAgent && gmailConnected ? (
                  <p className="text-sm font-medium text-teal-400">Gmail connected</p>
                ) : (
                  <p className="text-sm text-zinc-500">None attached</p>
                )}
                <button onClick={() => router.push("/connectors")} className="mt-2 text-[11px] text-indigo-400 hover:text-indigo-300">Manage</button>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
                <h4 className="mb-2 text-xs font-medium text-zinc-500">Privacy</h4>
                <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-200">
                  {settingsEncrypt ? <><Lock className="h-3.5 w-3.5 text-lantern-400" /> Encrypted</> : settingsAuditLog ? <><Shield className="h-3.5 w-3.5 text-blue-400" /> Audit-logged</> : "Standard"}
                </p>
                <p className="mt-0.5 text-[10px] text-zinc-500">Data encrypted at rest</p>
              </div>
            </div>

            {/* Visual Editor link */}
            <p className="text-sm text-zinc-500">
              For multi-step workflows:{" "}
              <button onClick={() => router.push(`/agents/${encodeURIComponent(name)}/editor`)} className="inline-flex items-center gap-1 text-lantern-400 hover:text-lantern-300">
                Open Visual Editor <ExternalLink className="h-3 w-3" />
              </button>
            </p>

            {/* Test Agent */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300"><Play className="h-4 w-4 text-emerald-400" /> Test Agent</h3>
              <div className="mb-3 flex items-center gap-2">
                <label className="text-xs text-zinc-500">Model:</label>
                <ModelSelect value={testModel} onChange={setTestModel} className="h-8 text-xs" />
              </div>
              <textarea value={testInput} onChange={(e) => setTestInput(e.target.value)} rows={3} spellCheck={false} placeholder={isEmailAgent ? "Type a message or click Run to process emails" : "What would you like this agent to do?"} className="w-full resize-none rounded-lg border border-zinc-800 bg-surface-0 p-3 text-sm text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50" />
              <div className="mt-2 flex items-center gap-2">
                {isEmailAgent && gmailConnected && (
                  <button onClick={handleFetchEmails} disabled={fetchingEmails || testRunning} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/30 px-3.5 py-1.5 text-xs font-medium text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-50">
                    {fetchingEmails ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mail className="h-3 w-3" />} {fetchingEmails ? "Fetching..." : "Fetch Emails"}
                  </button>
                )}
                {testRunning ? (
                  <button onClick={() => { setTestRunning(false); setTestDone(true); }} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-red-500"><Square className="h-3 w-3" /> Stop</button>
                ) : (
                  <button onClick={handleTestRun} disabled={!testInput.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-lantern-400 disabled:opacity-50"><Play className="h-3 w-3" /> Run</button>
                )}
              </div>

              {(testOutput || testRunning || testError) && (
                <div className="mt-3 rounded-lg border border-zinc-800 bg-surface-0">
                  {testError ? (
                    <div className="p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-red-400"><AlertCircle className="h-3 w-3" /> Error</div>
                      <p className="mt-1 text-xs text-red-300/70">{testError}</p>
                    </div>
                  ) : (
                    <div ref={testRef} className="max-h-80 overflow-auto p-3">
                      <div className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-zinc-200">
                        {testOutput}
                        {testRunning && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-lantern-400" />}
                      </div>
                    </div>
                  )}
                  {testDone && !testError && (
                    <div className="flex items-center gap-3 border-t border-zinc-800 px-3 py-2">
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400"><CheckCircle2 className="h-3 w-3" /> Completed</span>
                      {testMeta && (
                        <>
                          <span className="text-[11px] text-zinc-500">{testMeta.model}</span>
                          {testMeta.tokens > 0 && <span className="text-[11px] text-zinc-500">{testMeta.tokens.toLocaleString()} tokens</span>}
                          {testMeta.cost > 0 && <span className="text-[11px] text-zinc-500">{formatCost(testMeta.cost)}</span>}
                          <span className="text-[11px] text-zinc-500">{formatDuration(testMeta.duration)}</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* RUNS TAB */}
        {activeTab === "runs" && (
          <div className="space-y-4">
            <button
              onClick={async () => {
                setTestRunning(true);
                try {
                  const run = await api.createRun({ agentName: name, input: {} });
                  toast.success(`Run started: ${run.id.slice(0, 12)}...`);
                  // Refresh runs list after a delay
                  setTimeout(() => refreshRuns(), 3000);
                  setTimeout(() => refreshRuns(), 8000);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "Failed to create run";
                  toast.error(msg);
                } finally {
                  setTestRunning(false);
                }
              }}
              disabled={testRunning}
              className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-xs font-medium text-white hover:bg-lantern-400 disabled:opacity-50"
            >
              {testRunning ? <><Loader2 className="h-3 w-3 animate-spin" /> Running...</> : <><Play className="h-3 w-3" /> Run Now</>}
            </button>
            {runsLoading ? (
              <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-zinc-500" /></div>
            ) : agentRuns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Play className="mb-3 h-8 w-8 text-zinc-600" />
                <p className="text-sm text-zinc-400">No runs yet.</p>
                <p className="mt-1 text-xs text-zinc-600">Use the Build tab to test this agent.</p>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-zinc-500">{agentRuns.length} run{agentRuns.length !== 1 ? "s" : ""}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-zinc-600">Page {runsPage + 1} of {Math.ceil(agentRuns.length / RUNS_PER_PAGE)}</span>
                    <button onClick={() => setRunsPage(p => Math.max(0, p - 1))} disabled={runsPage === 0} className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-surface-3 disabled:opacity-30">Prev</button>
                    <button onClick={() => setRunsPage(p => Math.min(Math.ceil(agentRuns.length / RUNS_PER_PAGE) - 1, p + 1))} disabled={(runsPage + 1) * RUNS_PER_PAGE >= agentRuns.length} className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-surface-3 disabled:opacity-30">Next</button>
                  </div>
                </div>
                <div className="grid grid-cols-[auto_1fr_100px_80px_140px_auto] gap-4 px-4 py-2 text-xs font-medium text-zinc-500">
                  <span className="w-4" /><span>Status</span><span>Duration</span><span>Cost</span><span>Started</span><span className="w-6" />
                </div>
                {agentRuns.slice(runsPage * RUNS_PER_PAGE, (runsPage + 1) * RUNS_PER_PAGE).map((run) => {
                  const expanded = expandedRunId === run.id;
                  const dur = run.startedAt ? formatDuration(new Date(run.finishedAt ?? new Date()).getTime() - new Date(run.startedAt).getTime()) : "--";
                  const confirmingDelete = deletingRunId === `confirm_${run.id}`;
                  return (
                    <div key={run.id} className="group rounded-lg border border-zinc-800 bg-surface-1">
                      {/* Row with inline delete */}
                      <div className="flex items-center">
                        <button onClick={() => setExpandedRunId(expanded ? null : run.id)} className="flex flex-1 items-center gap-4 px-4 py-3 text-left text-sm hover:bg-surface-2 rounded-l-lg">
                          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-zinc-500 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-500 shrink-0" />}
                          <StatusBadge status={run.status} />
                          <span className="font-mono text-xs text-zinc-500 hidden sm:inline">{run.id.slice(0, 12)}</span>
                          <span className="text-xs text-zinc-400 ml-auto">{dur}</span>
                          <span className="font-mono text-[11px] text-zinc-500">{formatCost(run.costUsd)}</span>
                          <span className="text-[11px] text-zinc-600 hidden md:inline">{run.startedAt ? format(new Date(run.startedAt), "MMM d, HH:mm") : "--"}</span>
                        </button>
                        {/* Delete — visible on hover or when confirming */}
                        <div className={clsx("flex items-center pr-2", confirmingDelete ? "opacity-100" : "opacity-0 group-hover:opacity-100 transition-opacity")}>
                          {confirmingDelete ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={async () => {
                                  setDeletingRunId(run.id);
                                  try { await api.deleteRun(run.id); toast.success("Deleted"); refreshRuns(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
                                  finally { setDeletingRunId(null); }
                                }}
                                disabled={deletingRunId === run.id}
                                className="rounded px-2 py-1 text-[10px] font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20"
                              >
                                {deletingRunId === run.id ? "..." : "Yes"}
                              </button>
                              <button onClick={() => setDeletingRunId(null)} className="rounded px-2 py-1 text-[10px] text-zinc-500 hover:text-zinc-300">No</button>
                            </div>
                          ) : (
                            <button onClick={() => setDeletingRunId(`confirm_${run.id}`)} className="rounded p-1 text-zinc-600 hover:text-red-400 hover:bg-red-500/10" title="Delete">
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      {/* Expanded details */}
                      {expanded && (
                        <div className="border-t border-zinc-800 p-4 space-y-4">
                          {/* Execution Steps */}
                          <ExecutionLog
                            steps={deduplicateSteps(run.triggerMeta)}
                            isRunDone={run.status === "succeeded" || run.status === "failed" || run.status === "cancelled"}
                            isRunning={run.status === "running"}
                          />
                          {/* Output */}
                          {run.output ? (
                            <div>
                              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Result</p>
                              <div className="max-h-80 overflow-auto rounded-lg border border-emerald-500/10 bg-emerald-500/[0.02] p-4">
                                {(() => {
                                  const raw = typeof run.output === "string" ? run.output : typeof run.output === "object" && run.output !== null && "result" in (run.output as Record<string, unknown>) ? String((run.output as Record<string, unknown>).result) : JSON.stringify(run.output, null, 2);
                                  const cleaned = raw.replace(/\*\*(.*?)\*\*/g, "$1").replace(/^#{1,3}\s+/gm, "").replace(/^- /gm, "  • ");
                                  return <pre className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200 font-sans">{cleaned}</pre>;
                                })()}
                              </div>
                            </div>
                          ) : run.error ? (
                            <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                              <p className="text-xs font-medium text-red-400">{run.error.code}</p>
                              <p className="mt-1 text-xs text-red-300/70">{run.error.message}</p>
                            </div>
                          ) : run.status === "running" ? (
                            <div className="flex items-center gap-2.5 py-3"><div className="h-4 w-4 rounded-full border-2 border-lantern-400 border-t-transparent animate-spin" /><span className="text-sm text-zinc-400">Processing...</span></div>
                          ) : <p className="text-xs text-zinc-600">No output available.</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* SCHEDULE TAB */}
        {activeTab === "schedule" && (
          <div className="mx-auto max-w-2xl space-y-6">
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-200">Cron Schedule</h3>
                <button type="button" role="switch" aria-checked={scheduleEnabled} onClick={() => setScheduleEnabled(!scheduleEnabled)} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", scheduleEnabled ? "bg-lantern-500" : "bg-zinc-700")}>
                  <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", scheduleEnabled ? "translate-x-4" : "translate-x-0.5")} />
                </button>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs text-zinc-400">Cron expression</label>
                  <AiAssistButton mode="cron" value={settingsCron} onChange={setSettingsCron} placeholder="e.g., every weekday at 9am" />
                </div>
                <input type="text" value={settingsCron} onChange={(e) => setSettingsCron(e.target.value)} placeholder="0 9 * * 1-5" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 font-mono placeholder:text-zinc-600 outline-none focus:border-lantern-500/50" />
                {settingsCron && <p className="mt-1 text-[10px] text-zinc-500">{describeCron(settingsCron)}</p>}
                {nextFireAt && <p className="mt-1 text-[10px] text-zinc-500">Next fire: {new Date(nextFireAt).toLocaleString()}</p>}
              </div>

              <div className="border-t border-zinc-800 pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div><label className="text-xs font-medium text-zinc-300">Email delivery</label><p className="text-[10px] text-zinc-500">Send run output via email</p></div>
                  <button type="button" role="switch" aria-checked={deliveryEmailEnabled} onClick={() => setDeliveryEmailEnabled(!deliveryEmailEnabled)} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", deliveryEmailEnabled ? "bg-lantern-500" : "bg-zinc-700")}>
                    <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", deliveryEmailEnabled ? "translate-x-4" : "translate-x-0.5")} />
                  </button>
                </div>
                {deliveryEmailEnabled && <input type="email" value={deliveryEmail} onChange={(e) => setDeliveryEmail(e.target.value)} placeholder="you@example.com" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50" />}
              </div>

              {/* Webhook */}
              <div className="border-t border-zinc-800 pt-4 space-y-2">
                <h4 className="flex items-center gap-2 text-xs font-medium text-zinc-300"><Webhook className="h-3.5 w-3.5 text-blue-400" /> Webhook</h4>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 font-mono text-xs text-zinc-400 select-all">https://api.lantern.dev/v1/agents/{name}/trigger</code>
                  <button onClick={() => navigator.clipboard.writeText(`https://api.lantern.dev/v1/agents/${name}/trigger`)} className="rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-surface-3">Copy</button>
                </div>
              </div>

              <button onClick={handleSaveSchedule} disabled={savingSchedule || !settingsCron.trim()} className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-xs font-medium text-white hover:bg-lantern-400 disabled:opacity-50">
                {savingSchedule ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving...</> : <><Save className="h-3 w-3" /> Save Schedule</>}
              </button>
            </div>
          </div>
        )}

        {/* SETTINGS TAB */}
        {activeTab === "settings" && (
          <div className="mx-auto max-w-2xl space-y-6">
            {/* Default Model */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <h3 className="text-sm font-semibold text-zinc-200">Default Model</h3>
              <ModelSelect value={settingsModel} onChange={setSettingsModel} className="w-full" />
            </div>

            {/* Isolation */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <h3 className="text-sm font-semibold text-zinc-200">Isolation</h3>
              <div className="space-y-2">
                {[
                  { value: "trusted", label: "Trusted", desc: "Direct execution, no sandbox" },
                  { value: "standard", label: "Standard", desc: "Lightweight container isolation" },
                  { value: "untrusted", label: "Untrusted MicroVM", desc: "Full microVM sandbox (Firecracker)" },
                ].map((level) => (
                  <label key={level.value} className={clsx("flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-all", settingsIsolation === level.value ? "border-lantern-500/50 bg-lantern-500/5" : "border-zinc-800 hover:border-zinc-600")}>
                    <input type="radio" name="isolation" value={level.value} checked={settingsIsolation === level.value} onChange={(e) => setSettingsIsolation(e.target.value)} className="accent-lantern-500" />
                    <div><div className="text-xs font-medium text-zinc-200">{level.label}</div><div className="text-[10px] text-zinc-500">{level.desc}</div></div>
                  </label>
                ))}
              </div>
            </div>

            {/* Resource Limits */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <h3 className="text-sm font-semibold text-zinc-200">Resource Limits</h3>
              <div className="space-y-3">
                <div><label className="mb-1 block text-xs text-zinc-400">Timeout</label>
                  <select value={settingsTimeout} onChange={(e) => setSettingsTimeout(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50">
                    <option value="1m">1 minute</option><option value="5m">5 minutes</option><option value="15m">15 minutes</option><option value="30m">30 minutes</option><option value="1h">1 hour</option>
                  </select>
                </div>
                <div><label className="mb-1 flex items-center justify-between text-xs text-zinc-400">Max tokens <span className="font-mono text-zinc-500">{settingsMaxTokens.toLocaleString()}</span></label>
                  <input type="range" min={1000} max={500000} step={1000} value={settingsMaxTokens} onChange={(e) => setSettingsMaxTokens(parseInt(e.target.value))} className="w-full accent-lantern-500" />
                </div>
                <div><label className="mb-1 flex items-center justify-between text-xs text-zinc-400">Max cost <span className="font-mono text-zinc-500">${settingsMaxCost.toFixed(2)}</span></label>
                  <input type="range" min={0.1} max={50} step={0.1} value={settingsMaxCost} onChange={(e) => setSettingsMaxCost(parseFloat(e.target.value))} className="w-full accent-lantern-500" />
                </div>
              </div>
            </div>

            {/* Privacy & Security */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <h3 className="text-sm font-semibold text-zinc-200">Privacy & Security</h3>
              <div><label className="mb-1 block text-xs text-zinc-400">Data retention period</label>
                <select value={settingsRetention} onChange={(e) => setSettingsRetention(e.target.value)} className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50">
                  <option value="30d">30 days</option><option value="90d">90 days</option><option value="180d">180 days</option><option value="365d">1 year</option><option value="forever">Forever</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <div><span className="text-xs font-medium text-zinc-300">{"\uD83D\uDD12"} Encrypt all run data</span><p className="text-[10px] text-zinc-500">End-to-end encryption for all inputs and outputs</p></div>
                <button type="button" role="switch" aria-checked={settingsEncrypt} onClick={() => setSettingsEncrypt(!settingsEncrypt)} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", settingsEncrypt ? "bg-lantern-500" : "bg-zinc-700")}>
                  <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", settingsEncrypt ? "translate-x-4" : "translate-x-0.5")} />
                </button>
              </div>
              <div className="flex items-center justify-between">
                <div><span className="text-xs font-medium text-zinc-300">{"\uD83D\uDEE1\uFE0F"} Enable audit logging</span><p className="text-[10px] text-zinc-500">Full audit trail for compliance</p></div>
                <button type="button" role="switch" aria-checked={settingsAuditLog} onClick={() => setSettingsAuditLog(!settingsAuditLog)} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", settingsAuditLog ? "bg-lantern-500" : "bg-zinc-700")}>
                  <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", settingsAuditLog ? "translate-x-4" : "translate-x-0.5")} />
                </button>
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
                <span className="text-[10px] font-medium text-zinc-400">Data residency:</span>
                <span className="rounded bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-zinc-300">US-East-1</span>
              </div>
            </div>

            <button onClick={handleSaveSettings} disabled={savingSettings} className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-5 py-2.5 text-sm font-medium text-white hover:bg-lantern-400 disabled:opacity-50">
              {savingSettings ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...</> : "Save Settings"}
            </button>

            {/* Danger Zone */}
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 space-y-3">
              <h3 className="text-sm font-semibold text-red-400">Danger Zone</h3>
              <p className="text-xs text-zinc-500">Deleting this agent will remove it and all associated data. This cannot be undone.</p>
              <div className="text-xs text-zinc-500">{agentRuns.length} runs, {succeededRuns} succeeded, {formatCost(totalCost)} total cost</div>
              <button onClick={() => setShowDeleteConfirm(true)} className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10">
                <Trash2 className="h-3 w-3" /> Delete Agent
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Delete Modal */}
      {showDeleteConfirm && (
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowDeleteConfirm(false)}>
          <div className="modal-content w-full max-w-sm rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5">
              <h3 className="text-lg font-semibold text-zinc-100">Delete agent</h3>
              <p className="mt-2 text-sm text-zinc-400">Are you sure you want to delete <span className="font-medium text-zinc-200">{name}</span>? This cannot be undone.</p>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
              <button onClick={() => setShowDeleteConfirm(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200">Cancel</button>
              <button onClick={handleDelete} disabled={deleting} className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400 disabled:opacity-50">
                {deleting ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Deleting...</> : <><Trash2 className="h-3.5 w-3.5" /> Delete</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
