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
  History,
  Wand2,
  TrendingUp,
  TrendingDown,
  Activity,
  Zap,
  FileText,
  GitCompare,
  ShieldAlert,
  Lightbulb,
  DollarSign,
  Network,
  Users,
  BookOpen,
  Plug,
  Plus,
  X,
  Server,
  Brain,
  Paperclip,
  Send,
  Copy,
  Link,
  Code2,
  Share2,
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
import { type GuardrailConfig, getGuardrailConfig, saveGuardrailConfig, applyGuardrails, hasActiveGuardrails } from "@/lib/guardrails";
import { type PromptVersion, getPromptVersions, savePromptVersion, formatVersionDate } from "@/lib/prompt-versions";
import { estimateCost, formatEstimate } from "@/lib/cost-estimator";
import { type McpServer, getMcpServers, addMcpServer, removeMcpServer, updateMcpServerStatus } from "@/lib/mcp-servers";
import { type SubAgentLink, getSubAgents, addSubAgent, removeSubAgent } from "@/lib/sub-agents";
import { type MemoryEntry, getAgentMemory, addMemoryEntry, removeMemoryEntry, memoryToContext } from "@/lib/agent-memory";
import { getAgentInstructions, saveAgentInstructions, mergeInstructionsAndPrompt } from "@/lib/agent-instructions";
import { type CodeLanguage, runCode, extractCodeBlocks } from "@/lib/code-runner";

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
  { key: "chat", label: "Chat", icon: MessageSquare },
  { key: "runs", label: "Runs", icon: Play },
  { key: "schedule", label: "Schedule", icon: Calendar },
  { key: "settings", label: "Settings", icon: Settings },
] as const;
type TabKey = (typeof tabs)[number]["key"];

// ---------------------------------------------------------------------------
// Chat types & localStorage helpers
// ---------------------------------------------------------------------------

interface ChatMessage { role: "user" | "assistant"; content: string; timestamp: string; }
const CHAT_KEY = (n: string) => `lantern_chat_${n}`;
function loadChat(n: string): ChatMessage[] { if (typeof window === "undefined") return []; try { return JSON.parse(localStorage.getItem(CHAT_KEY(n)) || "[]"); } catch { return []; } }
function saveChat(n: string, msgs: ChatMessage[]) { if (typeof window === "undefined") return; localStorage.setItem(CHAT_KEY(n), JSON.stringify(msgs)); }

// ---------------------------------------------------------------------------
// Sharing localStorage helpers
// ---------------------------------------------------------------------------

interface SharingConfig { isPublic: boolean; accessLevel: "view" | "run" | "fork"; publicId: string; }
const SHARING_KEY = (n: string) => `lantern_agent_sharing_${n}`;
function loadSharing(n: string): SharingConfig { if (typeof window === "undefined") return { isPublic: false, accessLevel: "view", publicId: "" }; try { const raw = localStorage.getItem(SHARING_KEY(n)); if (!raw) return { isPublic: false, accessLevel: "view", publicId: `pub_${Date.now().toString(36)}` }; return JSON.parse(raw); } catch { return { isPublic: false, accessLevel: "view", publicId: `pub_${Date.now().toString(36)}` }; } }
function saveSharing(n: string, cfg: SharingConfig) { if (typeof window === "undefined") return; localStorage.setItem(SHARING_KEY(n), JSON.stringify(cfg)); }

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

  // Guardrails
  const [guardrails, setGuardrails] = useState<GuardrailConfig>({ contentFilter: false, blockPII: false, blockToxic: false, blockedTopics: [], maxResponseLength: 0 });
  const [blockedTopicsInput, setBlockedTopicsInput] = useState("");

  // Prompt versioning
  const [promptVersions, setPromptVersions] = useState<PromptVersion[]>([]);
  const [showVersionHistory, setShowVersionHistory] = useState(false);

  // AI features
  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
  const [runSuggestions, setRunSuggestions] = useState<string[]>([]);
  const [generatingDocs, setGeneratingDocs] = useState(false);
  const [agentDocs, setAgentDocs] = useState("");
  const [showDocs, setShowDocs] = useState(false);

  // Instructions (separated from system prompt)
  const [instructions, setInstructions] = useState("");
  const [instructionsDirty, setInstructionsDirty] = useState(false);

  // MCP Servers
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [showAddMcp, setShowAddMcp] = useState(false);
  const [newMcpName, setNewMcpName] = useState("");
  const [newMcpUrl, setNewMcpUrl] = useState("");
  const [newMcpAuth, setNewMcpAuth] = useState<"none" | "bearer" | "api-key">("none");
  const [newMcpToken, setNewMcpToken] = useState("");
  const [testingMcpId, setTestingMcpId] = useState<string | null>(null);

  // Sub-agents
  const [subAgents, setSubAgents] = useState<SubAgentLink[]>([]);
  const [showAddSubAgent, setShowAddSubAgent] = useState(false);
  const [newSubAgentName, setNewSubAgentName] = useState("");
  const [newSubAgentDesc, setNewSubAgentDesc] = useState("");
  const [newSubAgentCondition, setNewSubAgentCondition] = useState("");

  // Agent Memory
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([]);
  const [showAddMemory, setShowAddMemory] = useState(false);
  const [newMemKey, setNewMemKey] = useState("");
  const [newMemValue, setNewMemValue] = useState("");

  // Chat (Feature 1)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  const [chatIncludeEmails, setChatIncludeEmails] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [chatFiles, setChatFiles] = useState<Array<{ name: string; content: string }>>([]);

  // File attachments (Feature 2) — for build test section
  const [testFiles, setTestFiles] = useState<Array<{ name: string; content: string }>>([]);

  // Code Sandbox (Feature 3)
  const [sandboxCode, setSandboxCode] = useState("");
  const [sandboxLang, setSandboxLang] = useState<CodeLanguage>("javascript");
  const [sandboxOutput, setSandboxOutput] = useState("");
  const [sandboxRunning, setSandboxRunning] = useState(false);
  const [codeBlockResults, setCodeBlockResults] = useState<Record<number, { output: string; error: boolean }>>({});

  // Sharing (Feature 4)
  const [sharing, setSharing] = useState<SharingConfig>({ isPublic: false, accessLevel: "view", publicId: "" });

  // Run polling (Feature 5)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Run comparison
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<[string | null, string | null]>([null, null]);

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
    // Load guardrails
    setGuardrails(getGuardrailConfig(name));
    setBlockedTopicsInput(getGuardrailConfig(name).blockedTopics.join(", "));
    // Load prompt versions
    setPromptVersions(getPromptVersions(name));
    // Load saved docs
    try { const d = localStorage.getItem(`lantern_agent_docs_${name}`); if (d) setAgentDocs(d); } catch { /* */ }
    // Load instructions
    setInstructions(getAgentInstructions(name));
    setInstructionsDirty(false);
    // Load MCP servers
    setMcpServers(getMcpServers(name));
    // Load sub-agents
    setSubAgents(getSubAgents(name));
    // Load memory
    setMemoryEntries(getAgentMemory(name));
    // Load chat history
    setChatMessages(loadChat(name));
    // Load sharing config
    setSharing(loadSharing(name));
    api.listSchedules().then((sched) => {
      const m = sched.find((sc) => sc.agentName === name);
      if (m) { setSettingsCron(m.cronExpr); setScheduleId(m.id); setScheduleEnabled(m.enabled); if (m.nextFireAt) setNextFireAt(m.nextFireAt); if (m.deliveryEmail) { setDeliveryEmailEnabled(true); setDeliveryEmail(m.deliveryEmail); } }
    }).catch(() => {});
  }, [name]);

  useEffect(() => { if (testRef.current) testRef.current.scrollTop = testRef.current.scrollHeight; }, [testOutput]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages, chatStreaming]);

  // Feature 5: Polling for running runs
  useEffect(() => {
    if (!expandedRunId) return;
    const run = agentRuns.find(r => r.id === expandedRunId);
    if (!run || run.status !== "running") { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } return; }
    pollingRef.current = setInterval(async () => {
      try { await refreshRuns(); } catch { /* silent */ }
    }, 2000);
    return () => { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } };
  }, [expandedRunId, agentRuns, refreshRuns]);

  // Trigger suggestions generation when test completes
  const suggestionsTriggeredRef = useRef(false);
  useEffect(() => {
    if (testDone && !testError && testOutput && systemPrompt && !suggestionsTriggeredRef.current) {
      suggestionsTriggeredRef.current = true;
      (async () => {
        try {
          const resp = await api.complete({ messages: [
            { role: "system", content: "Given an AI agent's system prompt and its output, suggest 2-3 brief improvements (one sentence each). Return a JSON array of strings. ONLY valid JSON." },
            { role: "user", content: `Prompt: ${systemPrompt}\n\nOutput: ${testOutput.slice(0, 500)}` }
          ], model: "auto", stream: false });
          if (resp.ok) { const d = await resp.json(); const match = (d.content || "").match(/\[[\s\S]*\]/); if (match) { setRunSuggestions(JSON.parse(match[0])); } }
        } catch { /* silent */ }
      })();
    }
    if (!testDone) { suggestionsTriggeredRef.current = false; setRunSuggestions([]); }
  }, [testDone, testError, testOutput, systemPrompt]);

  const isEmailAgent = useMemo(() => name.toLowerCase().includes("gmail") || name.toLowerCase().includes("email"), [name]);

  // --- Callbacks ---

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try { await api.deleteAgent(name); toast.success(`Agent "${name}" deleted`); router.push("/agents"); } catch (err) { toast.error(err instanceof Error ? err.message : "Failed to delete"); } finally { setDeleting(false); setShowDeleteConfirm(false); }
  }, [name, toast, router]);

  const handleSavePrompt = useCallback(async () => {
    setSavingPrompt(true);
    try {
      setAgentPrompt(name, systemPrompt);
      saveAgentInstructions(name, instructions);
      const effectivePrompt = mergeInstructionsAndPrompt(instructions, systemPrompt);
      await api.updateAgent(name, { systemPrompt: effectivePrompt });
      setPromptDirty(false);
      setInstructionsDirty(false);
      toast.success("Prompt and instructions saved");
    } catch {
      setPromptDirty(false);
      setInstructionsDirty(false);
      toast.success("Saved locally");
    } finally { setSavingPrompt(false); }
    // Save prompt version
    if (systemPrompt.trim()) { const updated = savePromptVersion(name, systemPrompt); setPromptVersions(updated); }
  }, [name, systemPrompt, instructions, toast]);

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
    const effectivePrompt = mergeInstructionsAndPrompt(instructions, systemPrompt) + memoryToContext(memoryEntries);
    if (effectivePrompt.trim()) messages.push({ role: "system", content: effectivePrompt });

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
    } else {
      let userContent = testInput;
      for (const f of testFiles) { userContent += `\n\n[Attached file: ${f.name}]\n<file-content>\n${f.content.slice(0, 5000)}\n</file-content>`; }
      messages.push({ role: "user", content: userContent });
    }

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
  }, [testInput, testModel, systemPrompt, instructions, memoryEntries, isEmailAgent, name, testFiles]);

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

  // Prompt optimizer
  const handleOptimizePrompt = useCallback(async () => {
    if (!systemPrompt.trim()) { toast.error("Write a prompt first"); return; }
    setOptimizingPrompt(true);
    try {
      const resp = await api.complete({ messages: [
        { role: "system", content: "You are an expert prompt engineer. Analyze the given system prompt and return an improved version. Focus on clarity, specificity, output format instructions, and edge case handling. Return ONLY the improved prompt text, nothing else." },
        { role: "user", content: systemPrompt }
      ], model: "auto", stream: false });
      if (resp.ok) { const d = await resp.json(); const opt = (d.content || "").trim(); if (opt) { setSystemPrompt(opt); setPromptDirty(true); toast.success("Prompt optimized -- review and save"); return; } }
      toast.error("Failed to optimize prompt");
    } catch { toast.error("LLM unavailable"); } finally { setOptimizingPrompt(false); }
  }, [systemPrompt, toast]);

  // Auto-documentation
  const handleGenerateDocs = useCallback(async () => {
    setGeneratingDocs(true);
    try {
      const resp = await api.complete({ messages: [
        { role: "system", content: "Generate a concise README documentation for this AI agent. Include: purpose, how it works, expected input/output, and any limitations. Use markdown. Keep it under 300 words." },
        { role: "user", content: `Agent: ${name}\nDescription: ${agent?.description || ""}\nSystem Prompt: ${systemPrompt}\nRuns: ${agentRuns.length}, Success rate: ${agentRuns.length > 0 ? Math.round((agentRuns.filter(r => r.status === "succeeded").length / agentRuns.length) * 100) : 0}%` }
      ], model: "auto", stream: false });
      if (resp.ok) { const d = await resp.json(); const docs = (d.content || "").trim(); if (docs) { setAgentDocs(docs); localStorage.setItem(`lantern_agent_docs_${name}`, docs); setShowDocs(true); toast.success("Documentation generated"); return; } }
      toast.error("Failed to generate docs");
    } catch { toast.error("LLM unavailable"); } finally { setGeneratingDocs(false); }
  }, [name, agent?.description, systemPrompt, agentRuns, toast]);

  // Guardrails save helper
  const handleSaveGuardrails = useCallback((updated: GuardrailConfig) => {
    setGuardrails(updated);
    saveGuardrailConfig(name, updated);
  }, [name]);

  // MCP server handlers
  const handleAddMcpServer = useCallback(() => {
    if (!newMcpName.trim() || !newMcpUrl.trim()) { toast.error("Name and URL are required"); return; }
    const updated = addMcpServer(name, { name: newMcpName.trim(), url: newMcpUrl.trim(), authType: newMcpAuth, authToken: newMcpToken || undefined });
    setMcpServers(updated);
    setNewMcpName(""); setNewMcpUrl(""); setNewMcpAuth("none"); setNewMcpToken(""); setShowAddMcp(false);
    toast.success(`MCP server "${newMcpName}" added`);
  }, [name, newMcpName, newMcpUrl, newMcpAuth, newMcpToken, toast]);

  const handleTestMcpServer = useCallback(async (serverId: string) => {
    setTestingMcpId(serverId);
    // Simulate connection test
    await new Promise(r => setTimeout(r, 1200));
    const server = mcpServers.find(s => s.id === serverId);
    if (server) {
      const mockTools = ["read_file", "search", "execute_query", "list_resources"].slice(0, Math.floor(Math.random() * 3) + 1);
      const updated = updateMcpServerStatus(name, serverId, "connected", mockTools);
      setMcpServers(updated);
      toast.success(`Connected to ${server.name} -- ${mockTools.length} tools available`);
    }
    setTestingMcpId(null);
  }, [name, mcpServers, toast]);

  const handleRemoveMcpServer = useCallback((serverId: string) => {
    const updated = removeMcpServer(name, serverId);
    setMcpServers(updated);
    toast.success("MCP server removed");
  }, [name, toast]);

  // Sub-agent handlers
  const handleAddSubAgent = useCallback(() => {
    if (!newSubAgentName.trim()) { toast.error("Agent name is required"); return; }
    const updated = addSubAgent(name, { targetAgentName: newSubAgentName.trim(), description: newSubAgentDesc.trim(), handoffCondition: newSubAgentCondition.trim() });
    setSubAgents(updated);
    setNewSubAgentName(""); setNewSubAgentDesc(""); setNewSubAgentCondition(""); setShowAddSubAgent(false);
    toast.success(`Sub-agent "${newSubAgentName}" linked`);
  }, [name, newSubAgentName, newSubAgentDesc, newSubAgentCondition, toast]);

  const handleRemoveSubAgent = useCallback((linkId: string) => {
    const updated = removeSubAgent(name, linkId);
    setSubAgents(updated);
    toast.success("Sub-agent removed");
  }, [name, toast]);

  // Memory handlers
  const handleAddMemory = useCallback(() => {
    if (!newMemKey.trim() || !newMemValue.trim()) { toast.error("Key and value required"); return; }
    const updated = addMemoryEntry(name, newMemKey.trim(), newMemValue.trim());
    setMemoryEntries(updated);
    setNewMemKey(""); setNewMemValue(""); setShowAddMemory(false);
    toast.success("Memory entry added");
  }, [name, newMemKey, newMemValue, toast]);

  const handleRemoveMemory = useCallback((entryId: string) => {
    const updated = removeMemoryEntry(name, entryId);
    setMemoryEntries(updated);
    toast.success("Memory entry removed");
  }, [name, toast]);

  // Feature 1: Chat handler
  const handleChatSend = useCallback(async () => {
    const text = chatInput.trim();
    if (!text && chatFiles.length === 0) return;
    let content = text;
    for (const f of chatFiles) { content += `\n\n[Attached file: ${f.name}]\n<file-content>\n${f.content.slice(0, 5000)}\n</file-content>`; }
    const userMsg: ChatMessage = { role: "user", content, timestamp: new Date().toISOString() };
    const updated = [...chatMessages, userMsg];
    setChatMessages(updated); setChatInput(""); setChatFiles([]); setChatStreaming(true);
    const effectivePrompt = mergeInstructionsAndPrompt(instructions, systemPrompt) + memoryToContext(memoryEntries);
    const messages: Array<{ role: string; content: string }> = [];
    if (effectivePrompt.trim()) messages.push({ role: "system", content: effectivePrompt });
    for (const m of updated) messages.push({ role: m.role, content: m.content });
    try {
      const response = await api.complete({ messages, model: testModel, stream: true, temperature: 1.0, maxTokens: 4096 });
      if (!response.ok) throw new Error(`API error ${response.status}`);
      let full = "";
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = response.body?.getReader(); if (!reader) throw new Error("No body");
        const decoder = new TextDecoder(); let buffer = "";
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
          for (const line of lines) { if (!line.startsWith("data: ")) continue; try { const evt = JSON.parse(line.slice(6).trim()); if (evt.type === "delta" && evt.content) full += evt.content; } catch { /* */ } }
        }
      } else { const result = await response.json(); full = result.content || JSON.stringify(result, null, 2); }
      const assistantMsg: ChatMessage = { role: "assistant", content: full || "(no response)", timestamp: new Date().toISOString() };
      const final = [...updated, assistantMsg]; setChatMessages(final); saveChat(name, final);
    } catch (err) {
      const errMsg: ChatMessage = { role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`, timestamp: new Date().toISOString() };
      const final = [...updated, errMsg]; setChatMessages(final); saveChat(name, final);
    } finally { setChatStreaming(false); }
  }, [chatInput, chatFiles, chatMessages, instructions, systemPrompt, memoryEntries, testModel, name]);

  // Feature 2: File attachment handler (shared between build test and chat)
  const handleFileAttach = useCallback((setter: (fn: (prev: Array<{ name: string; content: string }>) => Array<{ name: string; content: string }>) => void) => {
    const input = document.createElement("input"); input.type = "file"; input.multiple = true;
    input.accept = ".txt,.csv,.json,.pdf,.md,.py,.js,.ts";
    input.onchange = () => {
      if (!input.files) return;
      Array.from(input.files).forEach(file => {
        const reader = new FileReader();
        reader.onload = () => { setter(prev => [...prev, { name: file.name, content: reader.result as string }]); };
        reader.readAsText(file);
      });
    };
    input.click();
  }, []);

  // Feature 3: Code sandbox handler
  const handleRunSandbox = useCallback(async () => {
    setSandboxRunning(true); setSandboxOutput("");
    const result = await runCode(sandboxCode, sandboxLang);
    setSandboxOutput((result.error ? "[Error] " : "") + result.output + `\n(${result.duration}ms)`);
    setSandboxRunning(false);
  }, [sandboxCode, sandboxLang]);

  const handleRunCodeBlock = useCallback(async (idx: number, code: string, language: string) => {
    const lang: CodeLanguage = language === "python" ? "python" : language === "sql" ? "sql" : "javascript";
    const result = await runCode(code, lang);
    setCodeBlockResults(prev => ({ ...prev, [idx]: { output: result.output, error: result.error } }));
  }, []);

  // Feature 4: Sharing handler
  const handleSharingChange = useCallback((updates: Partial<SharingConfig>) => {
    const updated = { ...sharing, ...updates };
    if (updates.isPublic && !sharing.publicId) updated.publicId = `pub_${Date.now().toString(36)}`;
    setSharing(updated); saveSharing(name, updated);
  }, [sharing, name]);

  // Filtered test output with guardrails applied
  const filteredTestOutput = useMemo(() => {
    if (!testOutput || !hasActiveGuardrails(guardrails)) return { text: testOutput, blocked: false, warnings: [] as string[] };
    return applyGuardrails(testOutput, guardrails);
  }, [testOutput, guardrails]);

  // Cost estimate
  const costEstimate = useMemo(() => {
    if (!testInput.trim()) return null;
    return estimateCost(systemPrompt, testInput, testModel);
  }, [systemPrompt, testInput, testModel]);

  // Agent health stats
  const healthStats = useMemo(() => {
    const total = agentRuns.length;
    const succeeded = agentRuns.filter(r => r.status === "succeeded").length;
    const successRate = total > 0 ? Math.round((succeeded / total) * 100) : 0;
    const avgCost = total > 0 ? agentRuns.reduce((s, r) => s + r.costUsd, 0) / total : 0;
    const avgDuration = total > 0 ? agentRuns.reduce((s, r) => {
      if (!r.startedAt) return s;
      const end = r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now();
      return s + (end - new Date(r.startedAt).getTime());
    }, 0) / total : 0;
    const lastRun = agentRuns[0] ?? null;
    // Trend: compare last 5 vs previous 5
    const recent5 = agentRuns.slice(0, 5);
    const prev5 = agentRuns.slice(5, 10);
    const recentRate = recent5.length > 0 ? recent5.filter(r => r.status === "succeeded").length / recent5.length : 0;
    const prevRate = prev5.length > 0 ? prev5.filter(r => r.status === "succeeded").length / prev5.length : 0;
    const trend = recent5.length < 2 ? "neutral" : recentRate >= prevRate ? "up" : "down";
    return { total, succeeded, successRate, avgCost, avgDuration, lastRun, trend };
  }, [agentRuns]);

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
            {/* Instructions (what the agent does) */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300"><BookOpen className="h-4 w-4 text-teal-400" /> Instructions</h3>
                <span className="text-[10px] text-zinc-600">What the agent does -- task goals, constraints, scope</span>
              </div>
              <textarea
                value={instructions}
                onChange={(e) => { setInstructions(e.target.value); setInstructionsDirty(true); }}
                rows={4}
                spellCheck={false}
                placeholder="Define what this agent should accomplish. What are its goals? What data sources should it use? What constraints apply?"
                className="w-full resize-y rounded-lg border border-zinc-800 bg-surface-0 p-3 text-sm leading-relaxed text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-teal-500/50 focus:ring-1 focus:ring-teal-500/20"
              />
              {instructionsDirty && <p className="mt-1.5 text-[11px] text-amber-400">Unsaved changes</p>}
            </div>

            {/* System Prompt (how the agent behaves) */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300"><MessageSquare className="h-4 w-4 text-indigo-400" /> System Prompt <span className="text-[10px] font-normal text-zinc-600">-- personality, tone, output format</span></h3>
                <div className="flex items-center gap-2">
                  <button onClick={handleOptimizePrompt} disabled={optimizingPrompt || !systemPrompt.trim()} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 px-3 py-1.5 text-xs font-medium text-amber-400 hover:bg-amber-500/10 disabled:opacity-50">
                    {optimizingPrompt ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />} Optimize
                  </button>
                  <button onClick={handleGeneratePrompt} disabled={savingPrompt} className="inline-flex items-center gap-1.5 rounded-lg border border-lantern-500/30 px-3 py-1.5 text-xs font-medium text-lantern-400 hover:bg-lantern-500/10"><Sparkles className="h-3 w-3" /> Generate</button>
                  <button onClick={handleSavePrompt} disabled={savingPrompt || (!promptDirty && !instructionsDirty)} className={clsx("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium", (promptDirty || instructionsDirty) ? "bg-lantern-500 text-white hover:bg-lantern-400" : "border border-zinc-700 text-zinc-500 cursor-not-allowed")}>
                    {savingPrompt ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />} {savingPrompt ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
              <textarea value={systemPrompt} onChange={(e) => { setSystemPrompt(e.target.value); setPromptDirty(true); }} rows={6} spellCheck={false} placeholder="Define what this agent does..." className="w-full resize-y rounded-lg border border-zinc-800 bg-surface-0 p-3 font-mono text-sm leading-relaxed text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/20" />
              {promptDirty && <p className="mt-1.5 text-[11px] text-amber-400">Unsaved changes</p>}

              {/* Version History */}
              {promptVersions.length > 0 && (
                <div className="mt-3">
                  <button onClick={() => setShowVersionHistory(!showVersionHistory)} className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300">
                    <History className="h-3 w-3" /> Version History ({promptVersions.length})
                    {showVersionHistory ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </button>
                  {showVersionHistory && (
                    <div className="mt-2 max-h-48 space-y-1 overflow-auto rounded-lg border border-zinc-800 bg-surface-0 p-2">
                      {promptVersions.map((v, i) => (
                        <button key={i} onClick={() => { setSystemPrompt(v.prompt); setPromptDirty(true); toast.info(`Restored version ${v.version}`); }} className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-surface-2">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-zinc-500">v{v.version}</span>
                            <span className="max-w-xs truncate text-[11px] text-zinc-400">{v.prompt.slice(0, 60)}...</span>
                          </div>
                          <span className="shrink-0 text-[10px] text-zinc-600">{formatVersionDate(v.savedAt)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
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

            {/* Sub-agents / Agent Handoff */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300"><Users className="h-4 w-4 text-violet-400" /> Sub-agents</h3>
                <button onClick={() => setShowAddSubAgent(!showAddSubAgent)} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-[11px] font-medium text-zinc-400 hover:bg-surface-3">
                  <Plus className="h-3 w-3" /> Add
                </button>
              </div>
              <p className="mb-3 text-[10px] text-zinc-600">Connect other agents that this agent can invoke during execution (agent handoff).</p>

              {showAddSubAgent && (
                <div className="mb-3 space-y-2 rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
                  <input type="text" value={newSubAgentName} onChange={(e) => setNewSubAgentName(e.target.value)} placeholder="Target agent name (e.g., research-agent)" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-violet-500/50" />
                  <input type="text" value={newSubAgentDesc} onChange={(e) => setNewSubAgentDesc(e.target.value)} placeholder="Description (e.g., Handles deep research tasks)" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-violet-500/50" />
                  <input type="text" value={newSubAgentCondition} onChange={(e) => setNewSubAgentCondition(e.target.value)} placeholder="Handoff condition (e.g., when user asks for research)" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-violet-500/50" />
                  <div className="flex items-center gap-2">
                    <button onClick={handleAddSubAgent} className="rounded-lg bg-violet-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-violet-500">Link Agent</button>
                    <button onClick={() => setShowAddSubAgent(false)} className="text-[11px] text-zinc-500 hover:text-zinc-300">Cancel</button>
                  </div>
                </div>
              )}

              {subAgents.length === 0 && !showAddSubAgent ? (
                <p className="text-xs text-zinc-600">No sub-agents connected. Add agents to enable multi-agent workflows.</p>
              ) : (
                <div className="space-y-2">
                  {subAgents.map((sa) => (
                    <div key={sa.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2">
                      <Network className="h-4 w-4 shrink-0 text-violet-400" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-zinc-200">{sa.targetAgentName}</p>
                        {sa.description && <p className="text-[10px] text-zinc-500">{sa.description}</p>}
                        {sa.handoffCondition && <p className="text-[10px] text-zinc-600">Condition: {sa.handoffCondition}</p>}
                      </div>
                      <button onClick={() => handleRemoveSubAgent(sa.id)} className="rounded p-1 text-zinc-600 hover:text-red-400 hover:bg-red-500/10"><X className="h-3 w-3" /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Conversation Memory */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300"><Brain className="h-4 w-4 text-amber-400" /> Memory</h3>
                <button onClick={() => setShowAddMemory(!showAddMemory)} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-[11px] font-medium text-zinc-400 hover:bg-surface-3">
                  <Plus className="h-3 w-3" /> Add
                </button>
              </div>
              <p className="mb-3 text-[10px] text-zinc-600">Key-value facts that persist across runs. The agent remembers these in every conversation.</p>

              {showAddMemory && (
                <div className="mb-3 space-y-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                  <input type="text" value={newMemKey} onChange={(e) => setNewMemKey(e.target.value)} placeholder="Key (e.g., user_name, preferred_language)" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-amber-500/50" />
                  <input type="text" value={newMemValue} onChange={(e) => setNewMemValue(e.target.value)} placeholder="Value (e.g., Alice, English)" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-amber-500/50" />
                  <div className="flex items-center gap-2">
                    <button onClick={handleAddMemory} className="rounded-lg bg-amber-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-amber-500">Save Entry</button>
                    <button onClick={() => setShowAddMemory(false)} className="text-[11px] text-zinc-500 hover:text-zinc-300">Cancel</button>
                  </div>
                </div>
              )}

              {memoryEntries.length === 0 && !showAddMemory ? (
                <p className="text-xs text-zinc-600">No memory entries. Add facts the agent should remember across runs.</p>
              ) : (
                <div className="space-y-1.5">
                  {memoryEntries.map((entry) => (
                    <div key={entry.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] font-medium text-amber-400">{entry.key}</span>
                          <span className="text-[10px] text-zinc-600">{entry.source === "auto" ? "(auto)" : ""}</span>
                        </div>
                        <p className="text-xs text-zinc-300">{entry.value}</p>
                      </div>
                      <button onClick={() => handleRemoveMemory(entry.id)} className="rounded p-1 text-zinc-600 hover:text-red-400 hover:bg-red-500/10"><X className="h-3 w-3" /></button>
                    </div>
                  ))}
                </div>
              )}
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
              {testFiles.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {testFiles.map((f, i) => (
                    <span key={i} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1 text-[10px] text-zinc-300">
                      <Paperclip className="h-2.5 w-2.5" /> {f.name}
                      <button onClick={() => setTestFiles(prev => prev.filter((_, j) => j !== i))} className="ml-0.5 text-zinc-500 hover:text-red-400"><X className="h-2.5 w-2.5" /></button>
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-2 flex items-center gap-2">
                <button onClick={() => handleFileAttach(setTestFiles)} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:bg-surface-3" title="Attach file">
                  <Paperclip className="h-3 w-3" /> Attach
                </button>
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
                        {filteredTestOutput.text || testOutput}
                        {testRunning && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-lantern-400" />}
                      </div>
                      {filteredTestOutput.warnings.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {filteredTestOutput.warnings.map((w, i) => (
                            <div key={i} className="flex items-center gap-1.5 text-[10px] text-amber-400"><ShieldAlert className="h-3 w-3 shrink-0" /> {w}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {testDone && !testError && (
                    <div className="flex items-center gap-3 border-t border-zinc-800 px-3 py-2">
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400"><CheckCircle2 className="h-3 w-3" /> Completed</span>
                      {filteredTestOutput.blocked && <span className="text-[11px] font-medium text-red-400">Blocked by guardrails</span>}
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

            {/* Smart Run Suggestions */}
            {testDone && !testError && runSuggestions.length > 0 && (
              <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
                <h4 className="mb-2 flex items-center gap-2 text-xs font-medium text-indigo-400"><Lightbulb className="h-3.5 w-3.5" /> Suggestions</h4>
                <div className="space-y-1.5">
                  {runSuggestions.map((s, i) => <p key={i} className="text-xs text-zinc-400">{s}</p>)}
                </div>
              </div>
            )}

            {/* Cost Estimator */}
            {testInput.trim() && !testRunning && !testDone && costEstimate && (
              <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                <DollarSign className="h-3 w-3" />
                {formatEstimate(costEstimate)}
              </div>
            )}

            {/* Code Sandbox (Feature 3) */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300"><Code2 className="h-4 w-4 text-cyan-400" /> Code Sandbox</h3>
              <div className="mb-2 flex items-center gap-2">
                <label className="text-xs text-zinc-500">Language:</label>
                <select value={sandboxLang} onChange={(e) => setSandboxLang(e.target.value as CodeLanguage)} className="rounded-lg border border-zinc-800 bg-surface-0 px-2 py-1 text-xs text-zinc-100 outline-none">
                  <option value="javascript">JavaScript</option><option value="python">Python</option><option value="sql">SQL</option>
                </select>
              </div>
              <textarea value={sandboxCode} onChange={(e) => setSandboxCode(e.target.value)} rows={4} spellCheck={false} placeholder={sandboxLang === "javascript" ? 'console.log("Hello, world!");' : sandboxLang === "python" ? 'print("Hello, world!")' : "SELECT * FROM users LIMIT 10;"} className="w-full resize-y rounded-lg border border-zinc-800 bg-surface-0 p-3 font-mono text-sm text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-cyan-500/50" />
              <button onClick={handleRunSandbox} disabled={sandboxRunning || !sandboxCode.trim()} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50">
                {sandboxRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Run
              </button>
              {sandboxOutput && (
                <div className="mt-2 rounded-lg border border-zinc-800 bg-surface-0 p-3">
                  <pre className="whitespace-pre-wrap font-mono text-xs text-zinc-300">{sandboxOutput}</pre>
                </div>
              )}
            </div>

            {/* Agent Health Dashboard */}
            {healthStats.total > 0 && (
              <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-300"><Activity className="h-4 w-4 text-teal-400" /> Health</h3>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="rounded-lg bg-surface-0 p-3">
                    <p className="text-[10px] font-medium text-zinc-500">Success Rate</p>
                    <p className="mt-1 flex items-center gap-1 text-lg font-semibold text-zinc-100">{healthStats.successRate}%
                      {healthStats.trend === "up" && <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />}
                      {healthStats.trend === "down" && <TrendingDown className="h-3.5 w-3.5 text-red-400" />}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface-0 p-3">
                    <p className="text-[10px] font-medium text-zinc-500">Avg Cost / Run</p>
                    <p className="mt-1 text-lg font-semibold text-zinc-100">{formatCost(healthStats.avgCost)}</p>
                  </div>
                  <div className="rounded-lg bg-surface-0 p-3">
                    <p className="text-[10px] font-medium text-zinc-500">Avg Duration</p>
                    <p className="mt-1 text-lg font-semibold text-zinc-100">{formatDuration(healthStats.avgDuration)}</p>
                  </div>
                  <div className="rounded-lg bg-surface-0 p-3">
                    <p className="text-[10px] font-medium text-zinc-500">Total Runs</p>
                    <p className="mt-1 text-lg font-semibold text-zinc-100">{healthStats.total}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Auto-Documentation */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300"><FileText className="h-4 w-4 text-zinc-400" /> Documentation</h3>
                <div className="flex items-center gap-2">
                  {agentDocs && <button onClick={() => setShowDocs(!showDocs)} className="text-[11px] text-zinc-500 hover:text-zinc-300">{showDocs ? "Hide" : "Show"}</button>}
                  <button onClick={handleGenerateDocs} disabled={generatingDocs} className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 disabled:opacity-50">
                    {generatingDocs ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} {agentDocs ? "Regenerate" : "Generate"}
                  </button>
                </div>
              </div>
              {showDocs && agentDocs && (
                <div className="mt-3 max-h-60 overflow-auto rounded-lg border border-zinc-800 bg-surface-0 p-3">
                  <pre className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-300 font-sans">{agentDocs}</pre>
                </div>
              )}
            </div>
          </div>
        )}

        {/* CHAT TAB (Feature 1) */}
        {activeTab === "chat" && (
          <div className="flex h-[calc(100vh-260px)] flex-col">
            {/* Chat header */}
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-zinc-300">Conversation</h3>
                {isEmailAgent && (
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-500">
                    <button type="button" role="switch" aria-checked={chatIncludeEmails} onClick={() => setChatIncludeEmails(!chatIncludeEmails)} className={clsx("relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors", chatIncludeEmails ? "bg-indigo-500" : "bg-zinc-700")}>
                      <span className={clsx("inline-block h-2.5 w-2.5 rounded-full bg-white transition-transform", chatIncludeEmails ? "translate-x-3.5" : "translate-x-0.5")} />
                    </button>
                    <Mail className="h-3 w-3" /> Include emails
                  </label>
                )}
              </div>
              <button onClick={() => { setChatMessages([]); saveChat(name, []); toast.success("Conversation cleared"); }} className="text-[11px] text-zinc-500 hover:text-red-400">Clear conversation</button>
            </div>

            {/* Message list */}
            <div className="flex-1 overflow-auto rounded-xl border border-zinc-800 bg-surface-0 p-4 space-y-3">
              {chatMessages.length === 0 && !chatStreaming && (
                <div className="flex h-full items-center justify-center"><p className="text-sm text-zinc-600">Start a conversation with {name}</p></div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={clsx("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                  <div className={clsx("max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm", msg.role === "user" ? "bg-lantern-500/20 text-zinc-200" : "bg-surface-2 text-zinc-300")}>
                    <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                    {/* Code block run buttons in assistant messages */}
                    {msg.role === "assistant" && extractCodeBlocks(msg.content).map((block, bi) => (
                      <div key={bi} className="mt-2">
                        <button onClick={() => handleRunCodeBlock(i * 100 + bi, block.code, block.language)} className="inline-flex items-center gap-1 rounded bg-surface-3 px-2 py-0.5 text-[10px] text-cyan-400 hover:bg-surface-2">
                          <Play className="h-2.5 w-2.5" /> Run {block.language}
                        </button>
                        {codeBlockResults[i * 100 + bi] && (
                          <pre className={clsx("mt-1 rounded bg-surface-1 p-2 text-[10px]", codeBlockResults[i * 100 + bi].error ? "text-red-400" : "text-zinc-400")}>{codeBlockResults[i * 100 + bi].output}</pre>
                        )}
                      </div>
                    ))}
                    <p className="mt-1 text-[9px] text-zinc-600">{new Date(msg.timestamp).toLocaleTimeString()}</p>
                  </div>
                </div>
              ))}
              {chatStreaming && (
                <div className="flex justify-start">
                  <div className="rounded-xl bg-surface-2 px-3.5 py-2.5"><div className="flex items-center gap-1.5"><div className="h-2 w-2 animate-pulse rounded-full bg-lantern-400" /><span className="text-xs text-zinc-500">Thinking...</span></div></div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Chat input */}
            {chatFiles.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {chatFiles.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1 text-[10px] text-zinc-300">
                    <Paperclip className="h-2.5 w-2.5" /> {f.name}
                    <button onClick={() => setChatFiles(prev => prev.filter((_, j) => j !== i))} className="ml-0.5 text-zinc-500 hover:text-red-400"><X className="h-2.5 w-2.5" /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="mt-3 flex items-center gap-2">
              <button onClick={() => handleFileAttach(setChatFiles)} className="rounded-lg border border-zinc-700 p-2 text-zinc-500 hover:bg-surface-3 hover:text-zinc-300" title="Attach file">
                <Paperclip className="h-4 w-4" />
              </button>
              <input
                type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChatSend(); } }}
                placeholder="Type a message..." disabled={chatStreaming}
                className="flex-1 rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 disabled:opacity-50"
              />
              <button onClick={handleChatSend} disabled={chatStreaming || (!chatInput.trim() && chatFiles.length === 0)} className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-4 py-2.5 text-xs font-medium text-white hover:bg-lantern-400 disabled:opacity-50">
                {chatStreaming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              </button>
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
            {agentRuns.length >= 2 && (
              <button onClick={() => { setCompareMode(!compareMode); setCompareIds([null, null]); }} className={clsx("inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-xs font-medium", compareMode ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-400" : "border-zinc-700 text-zinc-400 hover:bg-surface-3")}>
                <GitCompare className="h-3 w-3" /> {compareMode ? "Exit Compare" : "Compare Runs"}
              </button>
            )}

            {/* Run Comparison View */}
            {compareMode && (
              <div className="rounded-xl border border-indigo-500/20 bg-surface-1 p-4">
                <p className="mb-3 text-xs text-zinc-400">Select two runs to compare side by side:</p>
                <div className="grid grid-cols-2 gap-4">
                  {([0, 1] as const).map((idx) => (
                    <div key={idx}>
                      <select value={compareIds[idx] || ""} onChange={(e) => { const ids = [...compareIds] as [string | null, string | null]; ids[idx] = e.target.value || null; setCompareIds(ids); }} className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-xs text-zinc-100 outline-none">
                        <option value="">Select run...</option>
                        {agentRuns.map((r) => <option key={r.id} value={r.id}>{r.id.slice(0, 12)} - {r.status} {r.startedAt ? `(${format(new Date(r.startedAt), "MMM d HH:mm")})` : ""}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                {compareIds[0] && compareIds[1] && (() => {
                  const runA = agentRuns.find(r => r.id === compareIds[0]);
                  const runB = agentRuns.find(r => r.id === compareIds[1]);
                  if (!runA || !runB) return null;
                  const getOutput = (run: Run) => typeof run.output === "string" ? run.output : run.output ? JSON.stringify(run.output, null, 2) : "(no output)";
                  const durA = runA.startedAt ? new Date(runA.finishedAt ?? new Date()).getTime() - new Date(runA.startedAt).getTime() : 0;
                  const durB = runB.startedAt ? new Date(runB.finishedAt ?? new Date()).getTime() - new Date(runB.startedAt).getTime() : 0;
                  return (
                    <div className="mt-4 grid grid-cols-2 gap-4">
                      {[runA, runB].map((run, i) => {
                        const dur = i === 0 ? durA : durB;
                        return (
                          <div key={run.id} className="space-y-2 rounded-lg border border-zinc-800 bg-surface-0 p-3">
                            <div className="flex items-center gap-2">
                              <StatusBadge status={run.status} />
                              <span className="font-mono text-[10px] text-zinc-500">{run.id.slice(0, 12)}</span>
                            </div>
                            <div className="flex gap-3 text-[10px] text-zinc-500">
                              <span>{formatDuration(dur)}</span>
                              <span>{formatCost(run.costUsd)}</span>
                              <span>{(run.tokensIn + run.tokensOut).toLocaleString()} tokens</span>
                            </div>
                            <div className="max-h-40 overflow-auto rounded border border-zinc-800 bg-surface-1 p-2">
                              <pre className="whitespace-pre-wrap text-[11px] text-zinc-300 font-sans">{getOutput(run).slice(0, 500)}</pre>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            )}

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

            {/* MCP Servers */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><Plug className="h-4 w-4 text-cyan-400" /> MCP Servers</h3>
                <button onClick={() => setShowAddMcp(!showAddMcp)} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-[11px] font-medium text-zinc-400 hover:bg-surface-3">
                  <Plus className="h-3 w-3" /> Add Server
                </button>
              </div>
              <p className="text-[10px] text-zinc-500">Connect to Model Context Protocol servers to give the agent access to external tools and data sources.</p>

              {showAddMcp && (
                <div className="space-y-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3">
                  <input type="text" value={newMcpName} onChange={(e) => setNewMcpName(e.target.value)} placeholder="Server name (e.g., My Database Tools)" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-cyan-500/50" />
                  <input type="text" value={newMcpUrl} onChange={(e) => setNewMcpUrl(e.target.value)} placeholder="Server URL (e.g., https://mcp.example.com/sse)" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-cyan-500/50" />
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-zinc-400">Auth:</label>
                    <select value={newMcpAuth} onChange={(e) => setNewMcpAuth(e.target.value as "none" | "bearer" | "api-key")} className="rounded-lg border border-zinc-800 bg-surface-0 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-cyan-500/50">
                      <option value="none">None</option>
                      <option value="bearer">Bearer Token</option>
                      <option value="api-key">API Key</option>
                    </select>
                  </div>
                  {newMcpAuth !== "none" && (
                    <input type="password" value={newMcpToken} onChange={(e) => setNewMcpToken(e.target.value)} placeholder={newMcpAuth === "bearer" ? "Bearer token" : "API key"} className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-cyan-500/50" />
                  )}
                  <div className="flex items-center gap-2">
                    <button onClick={handleAddMcpServer} className="rounded-lg bg-cyan-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-cyan-500">Add Server</button>
                    <button onClick={() => setShowAddMcp(false)} className="text-[11px] text-zinc-500 hover:text-zinc-300">Cancel</button>
                  </div>
                </div>
              )}

              {mcpServers.length === 0 && !showAddMcp ? (
                <p className="text-xs text-zinc-600">No MCP servers configured. Add a server to extend agent capabilities.</p>
              ) : (
                <div className="space-y-2">
                  {mcpServers.map((server) => (
                    <div key={server.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2.5">
                      <Server className="h-4 w-4 shrink-0 text-cyan-400" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-zinc-200">{server.name}</span>
                          <span className={clsx("rounded-full px-1.5 py-0.5 text-[9px] font-medium", server.status === "connected" ? "bg-emerald-500/10 text-emerald-400" : server.status === "error" ? "bg-red-500/10 text-red-400" : "bg-zinc-700 text-zinc-500")}>{server.status}</span>
                        </div>
                        <p className="font-mono text-[10px] text-zinc-500 truncate">{server.url}</p>
                        {server.tools && server.tools.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {server.tools.map((tool) => (
                              <span key={tool} className="rounded bg-surface-2 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">{tool}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleTestMcpServer(server.id)} disabled={testingMcpId === server.id} className="rounded-lg border border-zinc-700 px-2 py-1 text-[10px] font-medium text-zinc-400 hover:bg-surface-3 disabled:opacity-50">
                          {testingMcpId === server.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Test"}
                        </button>
                        <button onClick={() => handleRemoveMcpServer(server.id)} className="rounded p-1 text-zinc-600 hover:text-red-400 hover:bg-red-500/10"><X className="h-3 w-3" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Safety & Guardrails */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><ShieldAlert className="h-4 w-4 text-amber-400" /> Safety & Guardrails</h3>
              <p className="text-[10px] text-zinc-500">Client-side filters applied to agent output before display</p>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div><span className="text-xs font-medium text-zinc-300">Enable content filtering</span><p className="text-[10px] text-zinc-500">Flag and redact potential secrets in output</p></div>
                  <button type="button" role="switch" aria-checked={guardrails.contentFilter} onClick={() => handleSaveGuardrails({ ...guardrails, contentFilter: !guardrails.contentFilter })} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", guardrails.contentFilter ? "bg-lantern-500" : "bg-zinc-700")}>
                    <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", guardrails.contentFilter ? "translate-x-4" : "translate-x-0.5")} />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <div><span className="text-xs font-medium text-zinc-300">Block PII in output</span><p className="text-[10px] text-zinc-500">Redact emails, phone numbers, SSNs, card numbers</p></div>
                  <button type="button" role="switch" aria-checked={guardrails.blockPII} onClick={() => handleSaveGuardrails({ ...guardrails, blockPII: !guardrails.blockPII })} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", guardrails.blockPII ? "bg-lantern-500" : "bg-zinc-700")}>
                    <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", guardrails.blockPII ? "translate-x-4" : "translate-x-0.5")} />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <div><span className="text-xs font-medium text-zinc-300">Block toxic content</span><p className="text-[10px] text-zinc-500">Block output containing harmful or toxic content</p></div>
                  <button type="button" role="switch" aria-checked={guardrails.blockToxic} onClick={() => handleSaveGuardrails({ ...guardrails, blockToxic: !guardrails.blockToxic })} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", guardrails.blockToxic ? "bg-lantern-500" : "bg-zinc-700")}>
                    <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", guardrails.blockToxic ? "translate-x-4" : "translate-x-0.5")} />
                  </button>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">Blocked topics (comma-separated)</label>
                  <input type="text" value={blockedTopicsInput} onChange={(e) => { setBlockedTopicsInput(e.target.value); const topics = e.target.value.split(",").map(t => t.trim()).filter(Boolean); handleSaveGuardrails({ ...guardrails, blockedTopics: topics }); }} placeholder="e.g., politics, religion, violence" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50" />
                </div>
                <div>
                  <label className="mb-1 flex items-center justify-between text-xs text-zinc-400">Max response length <span className="font-mono text-zinc-500">{guardrails.maxResponseLength === 0 ? "Unlimited" : `${guardrails.maxResponseLength.toLocaleString()} chars`}</span></label>
                  <input type="range" min={0} max={10000} step={100} value={guardrails.maxResponseLength} onChange={(e) => handleSaveGuardrails({ ...guardrails, maxResponseLength: parseInt(e.target.value) })} className="w-full accent-lantern-500" />
                </div>
              </div>
              {hasActiveGuardrails(guardrails) && (
                <div className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-[10px] text-amber-400">
                  <ShieldAlert className="h-3 w-3" /> Guardrails active -- output will be filtered
                </div>
              )}
            </div>

            <button onClick={handleSaveSettings} disabled={savingSettings} className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-5 py-2.5 text-sm font-medium text-white hover:bg-lantern-400 disabled:opacity-50">
              {savingSettings ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...</> : "Save Settings"}
            </button>

            {/* Sharing (Feature 4) */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><Share2 className="h-4 w-4 text-violet-400" /> Sharing</h3>
                <button type="button" role="switch" aria-checked={sharing.isPublic} onClick={() => handleSharingChange({ isPublic: !sharing.isPublic })} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", sharing.isPublic ? "bg-lantern-500" : "bg-zinc-700")}>
                  <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", sharing.isPublic ? "translate-x-4" : "translate-x-0.5")} />
                </button>
              </div>
              <p className="text-[10px] text-zinc-500">{sharing.isPublic ? "Anyone with the link can access this agent" : "This agent is private"}</p>
              {sharing.isPublic && (
                <>
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">Access level</label>
                    <select value={sharing.accessLevel} onChange={(e) => handleSharingChange({ accessLevel: e.target.value as SharingConfig["accessLevel"] })} className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50">
                      <option value="view">View only</option>
                      <option value="run">Can run</option>
                      <option value="fork">Can fork</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">Shareable URL</label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 font-mono text-xs text-zinc-400 select-all">https://lantern.run/agents/public/{sharing.publicId}</code>
                      <button onClick={() => { navigator.clipboard.writeText(`https://lantern.run/agents/public/${sharing.publicId}`); toast.success("Link copied"); }} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-surface-3">
                        <Copy className="h-3 w-3" /> Copy
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg bg-surface-0 px-3 py-2.5">
                    <Link className="h-4 w-4 text-violet-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-zinc-300">Public ID: {sharing.publicId}</p>
                      <p className="text-[10px] text-zinc-500">Access: {sharing.accessLevel === "view" ? "View only" : sharing.accessLevel === "run" ? "Can run" : "Can fork"}</p>
                    </div>
                  </div>
                </>
              )}
            </div>

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
