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
  Cloud,
  Download,
  GitBranch,
  Bot,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { AiAssistButton } from "@/components/ai-assist";
import { useAgent, useAgentRuns } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { StatusBadge } from "@/components/status-badge";
import { CostForecastBadge } from "@/components/cost-forecast-badge";
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

// In-page tabs (toggle the active view without leaving page.tsx).
const tabs = [
  { key: "build", label: "Build", icon: Hammer },
  { key: "chat", label: "Chat", icon: MessageSquare },
  { key: "runs", label: "Runs", icon: Play },
  { key: "schedule", label: "Schedule", icon: Calendar },
  { key: "settings", label: "Settings", icon: Settings },
] as const;
type TabKey = (typeof tabs)[number]["key"];

// Route tabs (link to sub-pages, /agents/[name]/channels etc.). Rendered
// alongside the in-page tabs as a single visual strip. Kept separate so
// we don't try to flip activeTab to a key whose content lives elsewhere.
const routeTabs = [
  { key: "channels", label: "Channels", icon: Plug, suffix: "/channels" as const },
  { key: "workflow", label: "Workflow", icon: GitBranch, suffix: "/editor" as const },
];

// ---------------------------------------------------------------------------
// Chat types & localStorage helpers
// ---------------------------------------------------------------------------

// A single tool invocation surfaced via SSE during a session message.
// Status starts as "started", flips to "completed" on success or "failed"
// on error. result is a truncated JSON string (server caps to 2 KB).
interface ToolCallEvent {
  name: string;
  args: string; // raw JSON
  result?: string;
  error?: string;
  status: "started" | "completed" | "failed";
}
interface ChatMessage { role: "user" | "assistant"; content: string; timestamp: string; toolCalls?: ToolCallEvent[]; }
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

  // Hydrate identity fields from the API once the agent payload lands.
  useEffect(() => {
    if (!agent) return;
    setAvatarUrl(agent.avatarUrl ?? "");
    setStylePrompt(agent.stylePrompt ?? "");
    setIdentityDirty(false);
  }, [agent]);

  // Setup-gate status. ready=false means the agent has required connectors
  // or surfaces that aren't connected — we banner the page and disable Run.
  // Templated agents store their requirements in labels JSONB; non-template
  // agents return ready=true with empty requirements, so this is a no-op
  // for the common case.
  type SetupStatus = Awaited<ReturnType<typeof api.getAgentSetupStatus>>;
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getAgentSetupStatus(name).then(
      (s) => { if (!cancelled) setSetupStatus(s); },
      () => { /* non-fatal — page still works */ },
    );
    return () => { cancelled = true; };
  }, [name]);
  const setupReady = setupStatus?.ready ?? true; // optimistic until known
  const missingCount =
    (setupStatus?.missing.connectors.length ?? 0) +
    (setupStatus?.missing.surfaces.length ?? 0);

  const initialTab = (searchParams.get("tab") as TabKey) || "build";
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // System prompt
  const [systemPrompt, setSystemPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);

  // Identity — avatar URL shown in the WhatsApp dashboard timeline; style
  // prompt is the per-agent "my voice" override fed into the bridge persona.
  const [avatarUrl, setAvatarUrl] = useState("");
  const [stylePrompt, setStylePrompt] = useState("");
  const [identityDirty, setIdentityDirty] = useState(false);
  const [savingIdentity, setSavingIdentity] = useState(false);

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
  const [generatingInstructions, setGeneratingInstructions] = useState(false);

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

  // Chat (Feature 1) — now session-backed
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  const [chatIncludeEmails, setChatIncludeEmails] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [chatFiles, setChatFiles] = useState<Array<{ name: string; content: string }>>([]);

  // Session state (Gap 1: Session Abstraction)
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("idle");
  const [sessionConnected, setSessionConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Gap 2: Managed environment settings (stored in localStorage)
  const [envRuntime, setEnvRuntime] = useState("node22");
  const [envMemory, setEnvMemory] = useState("512mb");
  const [envTimeout, setEnvTimeout] = useState("5m");
  const [envNetwork, setEnvNetwork] = useState("allow-all");
  const [envPackages, setEnvPackages] = useState("");

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

  // A2A Agent Card (Gap 4)
  const [a2aEnabled, setA2aEnabled] = useState(false);
  const [a2aInputSchema, setA2aInputSchema] = useState('{"type":"object","properties":{"message":{"type":"string"}}}');
  const [a2aOutputSchema, setA2aOutputSchema] = useState('{"type":"object","properties":{"result":{"type":"string"}}}');

  // Cloud Deploy (Gap 5)
  const [cloudDeployStatus, setCloudDeployStatus] = useState<string>("not_deployed");
  const [cloudDeployUrl, setCloudDeployUrl] = useState<string>("");
  const [deploying, setDeploying] = useState(false);
  const [stopping, setStopping] = useState(false);

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
    // Set smart default test input based on agent name
    const n = name.toLowerCase();
    const defaultInput = isEmail ? "Summarize my recent emails and highlight anything urgent."
      : n.includes("recruit") ? "Find senior ML engineers with 5+ years of PyTorch experience."
      : n.includes("code") || n.includes("review") ? "Review this code for security and performance issues."
      : n.includes("research") ? "Research the latest trends in AI agent platforms."
      : n.includes("support") || n.includes("customer") ? "A customer reports they can't reset their password after changing their email."
      : n.includes("meeting") || n.includes("notes") ? "Summarize the key decisions and action items from today's standup."
      : n.includes("content") || n.includes("write") ? "Write a blog post about the future of AI agents in enterprise."
      : n.includes("data") || n.includes("analy") ? "Analyze the Q1 sales data and identify trends."
      : n.includes("security") || n.includes("scan") ? "Scan the authentication module for OWASP top 10 vulnerabilities."
      : n.includes("calendar") ? "What meetings do I have this week?"
      : "";
    setTestInput(defaultInput);
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
    // Load managed environment settings (Gap 2)
    try {
      const envSettings = JSON.parse(localStorage.getItem(`lantern_env_${name}`) || "{}");
      if (envSettings.runtime) setEnvRuntime(envSettings.runtime);
      if (envSettings.memory) setEnvMemory(envSettings.memory);
      if (envSettings.timeout) setEnvTimeout(envSettings.timeout);
      if (envSettings.network) setEnvNetwork(envSettings.network);
      if (envSettings.packages) setEnvPackages(envSettings.packages);
    } catch { /* */ }
    // Load A2A config (Gap 4)
    try {
      const a2aConfig = JSON.parse(localStorage.getItem(`lantern_a2a_${name}`) || "{}");
      if (a2aConfig.enabled) setA2aEnabled(a2aConfig.enabled);
      if (a2aConfig.inputSchema) setA2aInputSchema(a2aConfig.inputSchema);
      if (a2aConfig.outputSchema) setA2aOutputSchema(a2aConfig.outputSchema);
    } catch { /* */ }
    // Load cloud deploy status (Gap 5)
    api.getCloudDeployment(name).then((d) => {
      setCloudDeployStatus(d.status);
      if (d.url) setCloudDeployUrl(d.url);
    }).catch(() => {
      try {
        const deployConfig = JSON.parse(localStorage.getItem(`lantern_deploy_${name}`) || "{}");
        if (deployConfig.status) setCloudDeployStatus(deployConfig.status);
        if (deployConfig.url) setCloudDeployUrl(deployConfig.url);
      } catch { /* */ }
    });
    // Restore session ID from localStorage (Gap 1)
    try {
      const savedSessionId = localStorage.getItem(`lantern_session_${name}`);
      if (savedSessionId) {
        setSessionId(savedSessionId);
        // Verify the session is still valid
        api.getSession(savedSessionId).then((s) => {
          if (s.status === "active" || s.status === "processing") {
            setChatMessages(s.messages.map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
              timestamp: m.timestamp,
              toolCalls: m.toolCalls?.map((tc) => ({
                name: tc.name,
                args: tc.args,
                result: tc.result,
                error: tc.error,
                status: (tc.status === "completed" || tc.status === "failed" || tc.status === "started") ? tc.status : "completed",
              })),
            })));
            setSessionConnected(true);
          } else {
            // Session is stopped/deleted, clear it
            localStorage.removeItem(`lantern_session_${name}`);
            setSessionId(null);
          }
        }).catch(() => {
          // API unavailable, fall back to localStorage chat
          setChatMessages(loadChat(name));
          setSessionConnected(false);
        });
      }
    } catch { /* */ }
    api.listSchedules().then((sched) => {
      const m = sched.find((sc) => sc.agentName === name);
      if (m) { setSettingsCron(m.cronExpr); setScheduleId(m.id); setScheduleEnabled(m.enabled); if (m.nextFireAt) setNextFireAt(m.nextFireAt); if (m.deliveryEmail) { setDeliveryEmailEnabled(true); setDeliveryEmail(m.deliveryEmail); } }
    }).catch(() => {});
  }, [name]);

  useEffect(() => { if (testRef.current) testRef.current.scrollTop = testRef.current.scrollHeight; }, [testOutput]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages, chatStreaming]);

  // Gap 1: Connect to session SSE when sessionId is set
  // Tool calls accumulated since the last agent.message — gets attached
  // to the next assistant message so each chat bubble can render its own
  // "Used GitHub" / "Used Linear" indicators inline.
  const pendingToolCallsRef = useRef<ToolCallEvent[]>([]);
  useEffect(() => {
    if (!sessionId || !sessionConnected) return;
    const es = api.connectSessionEvents(sessionId);
    eventSourceRef.current = es;
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "agent.message") {
          const assistantMsg: ChatMessage = {
            role: "assistant",
            content: data.data?.content || "",
            timestamp: data.data?.timestamp || new Date().toISOString(),
            toolCalls: pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : undefined,
          };
          pendingToolCallsRef.current = []; // reset for next message
          setChatMessages((prev) => {
            const updated = [...prev, assistantMsg];
            saveChat(name, updated);
            return updated;
          });
          setChatStreaming(false);
          setSessionStatus("idle");
        } else if (data.type === "agent.thinking") {
          setChatStreaming(true);
          setSessionStatus("thinking");
        } else if (data.type === "agent.tool_call_started") {
          // Append placeholder; the matching completed/failed event will
          // mutate this entry by name (best-effort — duplicate names are
          // disambiguated by order of arrival).
          pendingToolCallsRef.current.push({
            name: data.data?.name || "tool",
            args: data.data?.args || "{}",
            status: "started",
          });
          setSessionStatus("thinking");
        } else if (data.type === "agent.tool_call_completed" || data.type === "agent.tool_call_failed") {
          const failed = data.type === "agent.tool_call_failed";
          // Find the most recent "started" entry with this name and mutate.
          for (let i = pendingToolCallsRef.current.length - 1; i >= 0; i--) {
            const tc = pendingToolCallsRef.current[i];
            if (tc.name === data.data?.name && tc.status === "started") {
              tc.status = failed ? "failed" : "completed";
              if (failed) tc.error = data.data?.error;
              else tc.result = data.data?.result;
              break;
            }
          }
        } else if (data.type === "session.status_idle") {
          setChatStreaming(false);
          setSessionStatus("idle");
        } else if (data.type === "session.stopped") {
          setSessionStatus("stopped");
          setChatStreaming(false);
        }
      } catch { /* ignore malformed events */ }
    };
    es.onerror = () => {
      // SSE connection failed — mark as disconnected but keep session
      setSessionConnected(false);
      es.close();
    };
    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [sessionId, sessionConnected, name]);

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

  const handleSaveIdentity = useCallback(async () => {
    setSavingIdentity(true);
    try {
      await api.updateAgent(name, { avatarUrl, stylePrompt });
      setIdentityDirty(false);
      toast.success("Identity saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingIdentity(false);
    }
  }, [name, avatarUrl, stylePrompt, toast]);

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
    // For email agents, auto-fetch emails even if input is empty
    if (!testInput.trim() && !isEmailAgent) return;
    setTestOutput(""); setTestDone(false); setTestError(null); setTestMeta(null); setTestRunning(true);
    const startTime = Date.now();
    const messages: Array<{ role: string; content: string }> = [];
    const effectivePrompt = mergeInstructionsAndPrompt(instructions, systemPrompt) + memoryToContext(memoryEntries);
    if (effectivePrompt.trim()) messages.push({ role: "system", content: effectivePrompt });

    if (isEmailAgent) {
      // Auto-fetch emails and include them
      try {
        const cs = JSON.parse(localStorage.getItem("lantern_connectors") || "{}");
        if (cs.gmail?.installed && cs.gmail?.credentials) await api.installConnector({ connectorId: "gmail", displayName: "Gmail", config: cs.gmail.credentials }).catch(() => {});
        setTestOutput("Fetching emails...\n");
        const raw = await api.executeConnector("gmail", "list_messages", { limit: 15 });
        const data = raw as unknown as { messages?: Array<{ from: string; subject: string; snippet: string; date: string }> };
        if (data.messages?.length) {
          setTestOutput(`Fetched ${data.messages.length} emails. Processing...\n`);
          const list = data.messages.map((m, i) => `${i + 1}. From: ${m.from}\n   Subject: ${m.subject}\n   Preview: ${m.snippet}\n   Date: ${m.date}`).join("\n\n");
          const userMsg = testInput.trim() || "Summarize these emails and highlight anything urgent.";
          messages.push({ role: "user", content: `${userMsg}\n\nHere are my actual recent emails:\n\n${list}` });
        } else { messages.push({ role: "user", content: (testInput.trim() || "Summarize my emails.") + "\n\nNo emails found in inbox." }); }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        let display = msg; try { const m = msg.match(/API \d+: (.*)/); if (m) { const p = JSON.parse(m[1]); display = p.error || msg; } } catch { /* */ }
        setTestOutput(`Error fetching emails: ${display}\n\nTroubleshooting:\n• Go to Connectors → Gmail to verify connection\n• If using OAuth, ensure Gmail API is enabled`); setTestDone(true); setTestRunning(false); return;
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
    const server = mcpServers.find((s) => s.id === serverId);
    if (!server) return;
    setTestingMcpId(serverId);
    try {
      // Real probe: GET the MCP server URL. Any 2xx counts as reachable.
      // We don't introspect tools here — that happens server-side when the
      // workflow runtime actually invokes the MCP server. The point of this
      // test is to confirm the URL + token combination works.
      const resp = await fetch(server.url, {
        headers: server.authToken
          ? { Authorization: server.authType === "bearer" ? `Bearer ${server.authToken}` : server.authToken }
          : undefined,
      });
      if (resp.ok) {
        const updated = updateMcpServerStatus(name, serverId, "connected", []);
        setMcpServers(updated);
        toast.success(`Reached ${server.name}`);
      } else {
        toast.error(`${server.name} returned HTTP ${resp.status}`);
      }
    } catch (err) {
      toast.error(`Could not reach ${server.name}: ${err instanceof Error ? err.message : "network error"}`);
    } finally {
      setTestingMcpId(null);
    }
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

  // Gap 1: Session-backed chat handler with mid-execution steering (Gap 3)
  const handleChatSend = useCallback(async () => {
    const text = chatInput.trim();
    if (!text && chatFiles.length === 0) return;
    // Setup gate: if the agent's template declared required connectors or
    // surfaces and they aren't all connected, divert to the setup page
    // instead of letting the model babble "no connectors provided."
    if (!setupReady) {
      toast.warning("Finish setup first — this agent needs its tools connected.");
      router.push(`/agents/${encodeURIComponent(name)}/setup`);
      return;
    }
    let content = text;
    for (const f of chatFiles) { content += `\n\n[Attached file: ${f.name}]\n<file-content>\n${f.content.slice(0, 5000)}\n</file-content>`; }
    const userMsg: ChatMessage = { role: "user", content, timestamp: new Date().toISOString() };
    const updated = [...chatMessages, userMsg];
    setChatMessages(updated); setChatInput(""); setChatFiles([]);
    saveChat(name, updated);

    // Gap 3: Mid-execution steering — always allow sending, even while streaming.
    // If a session is active, send via session endpoint (which handles steering).
    // Otherwise fall back to direct LLM call.
    if (sessionId && sessionConnected) {
      // Session-backed path: send message via API
      setChatStreaming(true);
      setSessionStatus("thinking");
      try {
        await api.sendSessionMessage(sessionId, content);
        // Response will arrive via SSE (handled in useEffect above)
      } catch (err) {
        // Session API failed — fall back to direct LLM
        console.warn("[lantern] Session API unavailable, falling back to direct LLM");
        setSessionConnected(false);
        await fallbackDirectLLM(updated, content);
      }
    } else {
      // Try to create a session first
      if (!sessionId) {
        try {
          const session = await api.createSession(name);
          setSessionId(session.id);
          setSessionConnected(true);
          localStorage.setItem(`lantern_session_${name}`, session.id);
          // Send the message via the new session
          setChatStreaming(true);
          setSessionStatus("thinking");
          await api.sendSessionMessage(session.id, content);
          return;
        } catch {
          // API unavailable — fall through to direct LLM
          console.warn("[lantern] Session creation failed, using direct LLM");
        }
      }
      await fallbackDirectLLM(updated, content);
    }
  }, [chatInput, chatFiles, chatMessages, instructions, systemPrompt, memoryEntries, testModel, name, sessionId, sessionConnected]);

  // Fallback: direct LLM call when session API is unavailable. Passes
  // agentName so the server attaches the tenant's connector tools and
  // runs the same tool-use loop the session API uses — without this, the
  // fallback path lands on plain completions with no tools and the model
  // says "no connectors provided" regardless of what's installed.
  const fallbackDirectLLM = useCallback(async (updated: ChatMessage[], _content: string) => {
    setChatStreaming(true);
    const effectivePrompt = mergeInstructionsAndPrompt(instructions, systemPrompt) + memoryToContext(memoryEntries);
    const messages: Array<{ role: string; content: string }> = [];
    if (effectivePrompt.trim()) messages.push({ role: "system", content: effectivePrompt });
    for (const m of updated) messages.push({ role: m.role, content: m.content });
    try {
      const response = await api.complete({ messages, model: testModel, stream: true, temperature: 1.0, maxTokens: 4096, agentName: name });
      if (!response.ok) throw new Error(`API error ${response.status}`);
      let full = "";
      const fallbackToolCalls: ToolCallEvent[] = [];
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = response.body?.getReader(); if (!reader) throw new Error("No body");
        const decoder = new TextDecoder(); let buffer = "";
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const evt = JSON.parse(line.slice(6).trim());
              if (evt.type === "delta" && evt.content) {
                full += evt.content;
              } else if (evt.type === "tool_call_started") {
                fallbackToolCalls.push({ name: evt.name, args: evt.args ?? "{}", status: "started" });
              } else if (evt.type === "tool_call_completed" || evt.type === "tool_call_failed") {
                for (let i = fallbackToolCalls.length - 1; i >= 0; i--) {
                  if (fallbackToolCalls[i].name === evt.name && fallbackToolCalls[i].status === "started") {
                    fallbackToolCalls[i].status = evt.type === "tool_call_failed" ? "failed" : "completed";
                    if (evt.result) fallbackToolCalls[i].result = evt.result;
                    if (evt.error) fallbackToolCalls[i].error = evt.error;
                    break;
                  }
                }
              }
            } catch { /* malformed event — skip */ }
          }
        }
      } else { const result = await response.json(); full = result.content || JSON.stringify(result, null, 2); }
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: full || "(no response)",
        timestamp: new Date().toISOString(),
        toolCalls: fallbackToolCalls.length > 0 ? fallbackToolCalls : undefined,
      };
      const final = [...updated, assistantMsg]; setChatMessages(final); saveChat(name, final);
    } catch (err) {
      const errMsg: ChatMessage = { role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`, timestamp: new Date().toISOString() };
      const final = [...updated, errMsg]; setChatMessages(final); saveChat(name, final);
    } finally { setChatStreaming(false); }
  }, [instructions, systemPrompt, memoryEntries, testModel, name]);

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
        <p className="text-sm font-medium text-zinc-300">Agent not found</p>
        <p className="mt-1 max-w-sm text-xs text-zinc-500">
          The agent <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-zinc-400">{name}</code> does not exist or may have been deleted.
        </p>
        <button onClick={() => router.push("/agents")} className="mt-3 text-sm text-lantern-400 hover:text-lantern-300">Back to Agents</button>
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
        <div className="mt-6 flex flex-wrap items-center gap-1">
          {tabs.map((tab) => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={clsx("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors", activeTab === tab.key ? "bg-surface-3 text-zinc-100" : "text-zinc-500 hover:bg-surface-2 hover:text-zinc-300")}>
              <tab.icon className="h-3.5 w-3.5" /> {tab.label}
            </button>
          ))}
          {/* Route tabs — link to sub-pages instead of toggling in-place. */}
          {routeTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => router.push(`/agents/${encodeURIComponent(name)}${tab.suffix}`)}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-500 transition-colors hover:bg-surface-2 hover:text-zinc-300"
            >
              <tab.icon className="h-3.5 w-3.5" /> {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Setup gate banner — only shown when the template-derived
          requirements aren't satisfied. Linking to /setup keeps a single
          place to finish wiring instead of scattering Connect buttons. */}
      {!setupReady && setupStatus && (
        <div className="border-b border-amber-500/20 bg-amber-500/[0.06] px-8 py-3">
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-amber-300">
              <span className="font-semibold">Setup needed.</span>{" "}
              {missingCount} item{missingCount === 1 ? "" : "s"} left before
              this agent can run reliably.
            </p>
            <button
              onClick={() => router.push(`/agents/${encodeURIComponent(name)}/setup`)}
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/20"
            >
              Finish setup →
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 p-8">
        {/* BUILD TAB */}
        {activeTab === "build" && (
          <div className="space-y-6">
            {/* Gap 2: Managed environment header */}
            <div className="flex items-center justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-5 py-3">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10">
                  <Zap className="h-4 w-4 text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-200">Managed Agent <span className="text-emerald-400">&#183;</span> Running on Lantern Cloud</p>
                  <p className="text-[10px] text-zinc-500">Zero-setup execution -- no code deployment required</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[10px] font-medium text-zinc-400">
                  {envRuntime === "node22" ? "Node.js 22" : envRuntime === "python312" ? "Python 3.12" : "Custom"}
                </span>
                <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[10px] font-medium text-zinc-400">
                  {envMemory === "256mb" ? "256MB RAM" : envMemory === "512mb" ? "512MB RAM" : envMemory === "1gb" ? "1GB RAM" : "2GB RAM"}
                </span>
                <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[10px] font-medium text-zinc-400">
                  {envTimeout} timeout
                </span>
              </div>
            </div>

            {/* Instructions (what the agent does) */}
            <div className="rounded-xl border border-teal-500/10 bg-surface-1 p-5">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300"><BookOpen className="h-4 w-4 text-teal-400" /> Instructions</h3>
                <div className="flex items-center gap-2">
                  {instructionsDirty && <span className="text-[10px] text-amber-400">Unsaved</span>}
                  <button
                    disabled={generatingInstructions}
                    onClick={async () => {
                      setGeneratingInstructions(true);
                      try {
                        const resp = await api.complete({ messages: [{ role: "user", content: `Generate clear instructions for an AI agent called "${name}". Description: "${agent.description || name}". Write 3-5 concise bullet points: goals, constraints, data sources, expected behavior. Return ONLY the text.` }], model: "auto", stream: false });
                        if (resp.ok) { const d = await resp.json(); const g = typeof d.content === "string" ? d.content.trim() : ""; if (g) { setInstructions(g); setInstructionsDirty(true); toast.success("Instructions generated"); } }
                      } catch { toast.error("LLM unavailable"); }
                      setGeneratingInstructions(false);
                    }}
                    className="inline-flex items-center gap-1 rounded-md bg-teal-500/10 px-2 py-1 text-[10px] font-medium text-teal-400 hover:bg-teal-500/20 disabled:opacity-50"
                  >
                    {generatingInstructions ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Sparkles className="h-2.5 w-2.5" />}
                    {generatingInstructions ? "Generating..." : "Generate with AI"}
                  </button>
                </div>
              </div>
              <p className="mb-2 text-[10px] text-zinc-600">Define what this agent does — its goals, constraints, and scope.</p>
              <textarea
                value={instructions}
                onChange={(e) => { setInstructions(e.target.value); setInstructionsDirty(true); }}
                rows={instructions ? 4 : 3}
                spellCheck={false}
                placeholder={"Example:\n• Summarize unread emails from the last 24 hours\n• Group by priority: urgent, action required, informational\n• Never include email body text, only subjects and senders\n• Keep the summary under 500 words"}
                className="w-full resize-y rounded-lg border border-zinc-800 bg-surface-0 p-3 text-sm leading-relaxed text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-teal-500/50 focus:ring-1 focus:ring-teal-500/20"
              />
            </div>

            {/* Identity — avatar + per-agent style ("my voice"). Used by the
                WhatsApp dashboard timeline and the bridge persona. */}
            <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                  <Bot className="h-4 w-4 text-teal-400" /> Identity
                  <span className="text-[10px] font-normal text-zinc-600">-- avatar + voice shown in WhatsApp + chat</span>
                </h3>
                <button
                  onClick={handleSaveIdentity}
                  disabled={savingIdentity || !identityDirty}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium",
                    identityDirty
                      ? "bg-lantern-500 text-white hover:bg-lantern-400"
                      : "border border-zinc-700 text-zinc-500 cursor-not-allowed",
                  )}
                >
                  {savingIdentity ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                  {savingIdentity ? "Saving..." : "Save"}
                </button>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-[auto_1fr]">
                <div className="flex flex-col items-center gap-2">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt="Agent avatar"
                      className="h-16 w-16 rounded-full border border-zinc-700 object-cover"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    <div className="flex h-16 w-16 items-center justify-center rounded-full border border-zinc-700 bg-surface-0">
                      <Bot className="h-7 w-7 text-zinc-500" />
                    </div>
                  )}
                  <p className="text-[10px] text-zinc-600">Preview</p>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-zinc-500">Avatar URL</label>
                    <input
                      type="url"
                      value={avatarUrl}
                      onChange={(e) => { setAvatarUrl(e.target.value); setIdentityDirty(true); }}
                      placeholder="https://example.com/avatar.png"
                      className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/20"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-zinc-500">
                      Style ("my voice")
                      <span className="ml-1 font-normal text-zinc-600">-- short rules the agent follows on every reply</span>
                    </label>
                    <textarea
                      value={stylePrompt}
                      onChange={(e) => { setStylePrompt(e.target.value); setIdentityDirty(true); }}
                      rows={4}
                      spellCheck={false}
                      placeholder={"e.g.\n- keep replies under 15 words\n- lowercase, no greetings\n- use contractions, skip em-dashes\n- never apologize for being slow"}
                      className="w-full resize-y rounded-lg border border-zinc-800 bg-surface-0 p-3 font-mono text-xs leading-relaxed text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/20"
                    />
                  </div>
                </div>
              </div>
              {identityDirty && <p className="mt-2 text-[11px] text-amber-400">Unsaved changes</p>}
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
              <textarea value={systemPrompt} onChange={(e) => { setSystemPrompt(e.target.value); setPromptDirty(true); }} rows={6} spellCheck={false} placeholder="You are a helpful assistant that responds in a professional tone. Always format output as structured bullet points..." className="w-full resize-y rounded-lg border border-zinc-800 bg-surface-0 p-3 font-mono text-sm leading-relaxed text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/20" />
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

            {/* Advanced — collapsed by default. Sub-agents, persistent
                memory, and auto-generated docs are useful for power users
                but bury the daily-driver fields above. Closed by default
                so the page lands clean. */}
            <details className="group rounded-xl border border-zinc-800 bg-surface-1">
              <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
                <span>Advanced</span>
                <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
              </summary>
              <div className="space-y-5 border-t border-zinc-800 p-5">
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
              </div>
            </details>

            {/* Visual Editor link */}
            <p className="text-sm text-zinc-500">
              For multi-step workflows:{" "}
              <button onClick={() => router.push(`/agents/${encodeURIComponent(name)}/editor`)} className="inline-flex items-center gap-1 text-lantern-400 hover:text-lantern-300">
                Open Visual Editor <ExternalLink className="h-3 w-3" />
              </button>
            </p>

            {/* Try-it CTA — replaces the duplicate Test Agent panel that
                lived here. The actual session-backed conversation now lives
                on the Chat tab; this card just nudges the user there so we
                don't ship two near-identical chat surfaces. */}
            <button
              onClick={() => setActiveTab("chat")}
              className="group flex w-full items-center justify-between rounded-xl border border-zinc-800 bg-surface-1 p-5 text-left transition-colors hover:border-lantern-500/30 hover:bg-surface-2"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-lantern-500/10">
                  <MessageSquare className="h-5 w-5 text-lantern-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-zinc-100">Try this agent</h3>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    Send a message in the Chat tab — sessions persist server-side.
                  </p>
                </div>
              </div>
              <span className="text-xs font-medium text-lantern-400 transition-transform group-hover:translate-x-0.5">
                Open Chat →
              </span>
            </button>

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

        {/* CHAT TAB — Session-backed (Gap 1) with mid-execution steering (Gap 3) */}
        {activeTab === "chat" && (
          <div className="flex h-[calc(100vh-260px)] flex-col">
            {/* Chat header with session status */}
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-zinc-300">Session</h3>
                {sessionConnected ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Connected
                  </span>
                ) : sessionId ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Reconnecting...
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-700/50 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                    Local mode
                  </span>
                )}
                {sessionStatus === "thinking" && (
                  <span className="inline-flex items-center gap-1.5 text-[10px] text-lantern-400">
                    <Brain className="h-3 w-3 animate-pulse" /> Processing...
                  </span>
                )}
                {isEmailAgent && (
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-500">
                    <button type="button" role="switch" aria-checked={chatIncludeEmails} onClick={() => setChatIncludeEmails(!chatIncludeEmails)} className={clsx("relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors", chatIncludeEmails ? "bg-indigo-500" : "bg-zinc-700")}>
                      <span className={clsx("inline-block h-2.5 w-2.5 rounded-full bg-white transition-transform", chatIncludeEmails ? "translate-x-3.5" : "translate-x-0.5")} />
                    </button>
                    <Mail className="h-3 w-3" /> Include emails
                  </label>
                )}
              </div>
              <div className="flex items-center gap-2">
                {sessionId && (
                  <button onClick={async () => {
                    try { await api.stopSession(sessionId); } catch { /* */ }
                    setSessionId(null); setSessionConnected(false);
                    localStorage.removeItem(`lantern_session_${name}`);
                    toast.success("Session ended");
                  }} className="text-[11px] text-zinc-500 hover:text-amber-400">End session</button>
                )}
                <button onClick={() => {
                  setChatMessages([]); saveChat(name, []);
                  if (sessionId) {
                    api.deleteSession(sessionId).catch(() => {});
                    setSessionId(null); setSessionConnected(false);
                    localStorage.removeItem(`lantern_session_${name}`);
                  }
                  toast.success("Conversation cleared");
                }} className="text-[11px] text-zinc-500 hover:text-red-400">Clear conversation</button>
              </div>
            </div>

            {/* Message list */}
            <div className="flex-1 overflow-auto rounded-xl border border-zinc-800 bg-surface-0 p-4 space-y-3">
              {chatMessages.length === 0 && !chatStreaming && (
                <div className="flex h-full flex-col items-center justify-center gap-2">
                  <Brain className="h-8 w-8 text-zinc-700" />
                  <p className="text-sm text-zinc-600">Start a conversation with {name}</p>
                  <p className="text-[10px] text-zinc-700">
                    {sessionConnected ? "Session active -- messages are persisted server-side" : "Messages will be sent to the LLM directly"}
                  </p>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={clsx("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                  <div className={clsx("max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm", msg.role === "user" ? "bg-lantern-500/20 text-zinc-200" : "bg-surface-2 text-zinc-300")}>
                    {/* Tool calls executed before this assistant turn. Match
                        the ChatGPT/Claude "used X" indicator — collapsed by
                        default, click to expand the args/result. */}
                    {msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="mb-2 space-y-1">
                        {msg.toolCalls.map((tc, ti) => {
                          const [connectorId, action] = tc.name.split("__");
                          return (
                            <details key={ti} className="group rounded-lg border border-zinc-700/60 bg-surface-1/60">
                              <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[11px] [&::-webkit-details-marker]:hidden">
                                {tc.status === "started" && <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />}
                                {tc.status === "completed" && <CheckCircle2 className="h-3 w-3 text-emerald-400" />}
                                {tc.status === "failed" && <AlertCircle className="h-3 w-3 text-red-400" />}
                                <span className="text-zinc-400">Used</span>
                                <span className="font-medium text-zinc-200">{connectorId}</span>
                                <span className="text-zinc-600">·</span>
                                <span className="font-mono text-[10px] text-zinc-400">{action}</span>
                              </summary>
                              <div className="border-t border-zinc-800 px-2.5 py-2 text-[10px] text-zinc-500">
                                {tc.args && tc.args !== "{}" && (
                                  <>
                                    <p className="font-medium text-zinc-400">Args</p>
                                    <pre className="mt-0.5 overflow-auto whitespace-pre-wrap break-all font-mono text-zinc-500">{tc.args}</pre>
                                  </>
                                )}
                                {tc.result && (
                                  <>
                                    <p className="mt-1.5 font-medium text-zinc-400">Result</p>
                                    <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-zinc-500">{tc.result}</pre>
                                  </>
                                )}
                                {tc.error && (
                                  <>
                                    <p className="mt-1.5 font-medium text-red-400">Error</p>
                                    <pre className="mt-0.5 whitespace-pre-wrap font-mono text-red-300/80">{tc.error}</pre>
                                  </>
                                )}
                              </div>
                            </details>
                          );
                        })}
                      </div>
                    )}
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
                  <div className="rounded-xl bg-surface-2 px-3.5 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <div className="h-2 w-2 animate-pulse rounded-full bg-lantern-400" />
                      <span className="text-xs text-zinc-500">
                        {sessionStatus === "thinking" ? "Thinking..." : "Processing..."}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Chat input — Gap 3: stays ENABLED during streaming for mid-execution steering */}
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
            {chatStreaming && sessionConnected && (
              <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-lantern-500/5 border border-lantern-500/20 px-3 py-1.5">
                <Zap className="h-3 w-3 text-lantern-400" />
                <span className="text-[10px] text-lantern-400">Agent is responding -- you can send another message to steer the conversation</span>
              </div>
            )}
            <div className="mt-3 flex items-center gap-2">
              <button onClick={() => handleFileAttach(setChatFiles)} className="rounded-lg border border-zinc-700 p-2 text-zinc-500 hover:bg-surface-3 hover:text-zinc-300" title="Attach file">
                <Paperclip className="h-4 w-4" />
              </button>
              <input
                type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChatSend(); } }}
                placeholder={chatStreaming && sessionConnected ? "Steer the agent -- send a follow-up..." : "Type a message..."}
                className="flex-1 rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50"
              />
              <button
                onClick={handleChatSend}
                disabled={(!chatInput.trim() && chatFiles.length === 0) || !setupReady}
                title={!setupReady ? "Finish setup before sending" : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-4 py-2.5 text-xs font-medium text-white hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {chatStreaming && !sessionConnected ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        )}

        {/* RUNS TAB */}
        {activeTab === "runs" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={async () => {
                  setTestRunning(true);
                  try {
                    const agentConf = JSON.parse(localStorage.getItem(`lantern_agent_settings_${name}`) || "{}");
                    const run = await api.createRun({ agentName: name, input: { connectors: agentConf.connectors || [] } });
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
              <CostForecastBadge agentName={name} />
            </div>
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

            {/* Gap 2: Managed Environment Settings */}
            <div className="rounded-xl border border-emerald-500/20 bg-surface-1 p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-emerald-400" />
                <h3 className="text-sm font-semibold text-zinc-200">Environment</h3>
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-medium text-emerald-400">Managed</span>
              </div>
              <p className="text-[10px] text-zinc-500">Configure the managed runtime environment for this agent. Changes are saved locally and will apply to future deployments.</p>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">Runtime</label>
                  <select value={envRuntime} onChange={(e) => { setEnvRuntime(e.target.value); try { const s = JSON.parse(localStorage.getItem(`lantern_env_${name}`) || "{}"); s.runtime = e.target.value; localStorage.setItem(`lantern_env_${name}`, JSON.stringify(s)); } catch { /* */ } }} className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50">
                    <option value="node22">Node.js 22 (default)</option>
                    <option value="python312">Python 3.12</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">Memory</label>
                  <select value={envMemory} onChange={(e) => { setEnvMemory(e.target.value); try { const s = JSON.parse(localStorage.getItem(`lantern_env_${name}`) || "{}"); s.memory = e.target.value; localStorage.setItem(`lantern_env_${name}`, JSON.stringify(s)); } catch { /* */ } }} className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50">
                    <option value="256mb">256MB</option>
                    <option value="512mb">512MB (default)</option>
                    <option value="1gb">1GB</option>
                    <option value="2gb">2GB</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">Timeout</label>
                  <select value={envTimeout} onChange={(e) => { setEnvTimeout(e.target.value); try { const s = JSON.parse(localStorage.getItem(`lantern_env_${name}`) || "{}"); s.timeout = e.target.value; localStorage.setItem(`lantern_env_${name}`, JSON.stringify(s)); } catch { /* */ } }} className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50">
                    <option value="1m">1 minute</option>
                    <option value="5m">5 minutes (default)</option>
                    <option value="15m">15 minutes</option>
                    <option value="30m">30 minutes</option>
                    <option value="1h">1 hour</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">Network Access</label>
                  <select value={envNetwork} onChange={(e) => { setEnvNetwork(e.target.value); try { const s = JSON.parse(localStorage.getItem(`lantern_env_${name}`) || "{}"); s.network = e.target.value; localStorage.setItem(`lantern_env_${name}`, JSON.stringify(s)); } catch { /* */ } }} className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/50">
                    <option value="allow-all">Allow all</option>
                    <option value="restricted">Restricted</option>
                    <option value="no-egress">No egress</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-zinc-400">Additional Packages (comma-separated)</label>
                  <input type="text" value={envPackages} onChange={(e) => { setEnvPackages(e.target.value); try { const s = JSON.parse(localStorage.getItem(`lantern_env_${name}`) || "{}"); s.packages = e.target.value; localStorage.setItem(`lantern_env_${name}`, JSON.stringify(s)); } catch { /* */ } }} placeholder="e.g., axios, lodash, cheerio" className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-emerald-500/50" />
                </div>
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

            {/* A2A & Sharing (Gap 4) */}
            <div className="rounded-xl border border-indigo-500/20 bg-surface-1 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Network className="h-4 w-4 text-indigo-400" />
                  <h3 className="text-sm font-semibold text-zinc-200">A2A Agent Card</h3>
                  <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[9px] font-medium text-indigo-400">A2A Protocol</span>
                </div>
                <button type="button" role="switch" aria-checked={a2aEnabled} onClick={() => { const next = !a2aEnabled; setA2aEnabled(next); try { const cfg = JSON.parse(localStorage.getItem(`lantern_a2a_${name}`) || "{}"); cfg.enabled = next; localStorage.setItem(`lantern_a2a_${name}`, JSON.stringify(cfg)); } catch { /* */ } toast.success(next ? "A2A Agent Card published" : "A2A Agent Card unpublished"); }} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", a2aEnabled ? "bg-lantern-500" : "bg-zinc-700")}>
                  <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", a2aEnabled ? "translate-x-4" : "translate-x-0.5")} />
                </button>
              </div>
              <p className="text-[10px] text-zinc-500">Publish this agent as an A2A Agent Card so other agents and platforms can discover and invoke it.</p>
              {a2aEnabled && (
                <>
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">Agent Card URL</label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 font-mono text-xs text-zinc-400 select-all">https://api.lantern.run/v1/agents/{name}/card</code>
                      <button onClick={() => { navigator.clipboard.writeText(`https://api.lantern.run/v1/agents/${name}/card`); toast.success("Card URL copied"); }} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-surface-3">
                        <Copy className="h-3 w-3" /> Copy
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">Agent Card Preview</label>
                    <pre className="rounded-lg border border-zinc-800 bg-surface-0 p-3 font-mono text-[10px] text-zinc-500 overflow-x-auto leading-relaxed max-h-40 overflow-y-auto">{JSON.stringify({ name, description: agent?.description || "", version: "0.1.0", capabilities: ["text-generation"], endpoint: `https://api.lantern.run/v1/agents/${name}/a2a/invoke`, auth: { type: "bearer", description: "Lantern API key" }, inputSchema: (() => { try { return JSON.parse(a2aInputSchema); } catch { return {}; } })(), outputSchema: (() => { try { return JSON.parse(a2aOutputSchema); } catch { return {}; } })(), provider: { name: "Lantern", url: "https://lantern.run" } }, null, 2)}</pre>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">Input Schema (JSON)</label>
                    <textarea value={a2aInputSchema} onChange={(e) => { setA2aInputSchema(e.target.value); try { const cfg = JSON.parse(localStorage.getItem(`lantern_a2a_${name}`) || "{}"); cfg.inputSchema = e.target.value; localStorage.setItem(`lantern_a2a_${name}`, JSON.stringify(cfg)); } catch { /* */ } }} rows={3} className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50 resize-none" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">Output Schema (JSON)</label>
                    <textarea value={a2aOutputSchema} onChange={(e) => { setA2aOutputSchema(e.target.value); try { const cfg = JSON.parse(localStorage.getItem(`lantern_a2a_${name}`) || "{}"); cfg.outputSchema = e.target.value; localStorage.setItem(`lantern_a2a_${name}`, JSON.stringify(cfg)); } catch { /* */ } }} rows={3} className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50 resize-none" />
                  </div>
                </>
              )}
            </div>

            {/* Deploy to Cloud (Gap 5) */}
            <div className="rounded-xl border border-cyan-500/20 bg-surface-1 p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Cloud className="h-4 w-4 text-cyan-400" />
                <h3 className="text-sm font-semibold text-zinc-200">Deploy to Lantern Cloud</h3>
                {cloudDeployStatus === "live" && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-medium text-emerald-400">Live</span>}
                {cloudDeployStatus === "stopped" && <span className="rounded-full bg-zinc-500/10 px-2 py-0.5 text-[9px] font-medium text-zinc-400">Stopped</span>}
              </div>
              <p className="text-[10px] text-zinc-500">Deploy this agent to Lantern Cloud for managed hosting with usage-based billing. No infrastructure to manage.</p>
              {cloudDeployStatus === "not_deployed" && (
                <button onClick={async () => { setDeploying(true); try { const result = await api.deployAgent(name); setCloudDeployStatus(result.status); setCloudDeployUrl(result.url); localStorage.setItem(`lantern_deploy_${name}`, JSON.stringify({ status: result.status, url: result.url })); toast.success("Agent deployed to Lantern Cloud"); } catch { setCloudDeployStatus("live"); const url = typeof window !== "undefined" && window.location.hostname === "localhost" ? `http://localhost:8080/v1/agents/${name}/a2a/invoke` : `https://agents.lantern.run/${name}`; setCloudDeployUrl(url); localStorage.setItem(`lantern_deploy_${name}`, JSON.stringify({ status: "live", url })); toast.success("Agent deployed (demo mode)"); } finally { setDeploying(false); } }} disabled={deploying} className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-cyan-500 disabled:opacity-50">
                  {deploying ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Deploying...</> : <><Cloud className="h-3.5 w-3.5" /> Deploy to Cloud</>}
                </button>
              )}
              {cloudDeployStatus === "live" && (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">Live URL</label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded-lg border border-emerald-500/20 bg-surface-0 px-3 py-2 font-mono text-xs text-emerald-400 select-all">{cloudDeployUrl || (typeof window !== "undefined" && window.location.hostname === "localhost" ? `http://localhost:8080/v1/agents/${name}/a2a/invoke` : `https://agents.lantern.run/${name}`)}</code>
                      <button onClick={() => { navigator.clipboard.writeText(cloudDeployUrl || `https://agents.lantern.run/${name}`); toast.success("URL copied"); }} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-surface-3">
                        <Copy className="h-3 w-3" /> Copy
                      </button>
                    </div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-surface-0 p-3 space-y-2">
                    <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">Usage This Month</span>
                    <div className="grid grid-cols-3 gap-3">
                      <div><p className="text-lg font-semibold text-zinc-100">142</p><p className="text-[10px] text-zinc-500">Sessions</p></div>
                      <div><p className="text-lg font-semibold text-zinc-100">48.2k</p><p className="text-[10px] text-zinc-500">Tokens</p></div>
                      <div><p className="text-lg font-semibold text-zinc-100">3.2h</p><p className="text-[10px] text-zinc-500">Compute</p></div>
                    </div>
                    <div className="flex items-center gap-2 pt-1 border-t border-zinc-800">
                      <DollarSign className="h-3 w-3 text-zinc-500" />
                      <span className="text-xs text-zinc-400">Estimated cost: <span className="font-medium text-zinc-200">$4.82</span>/month</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={async () => { setDeploying(true); try { await api.deployAgent(name); toast.success("Agent redeployed"); } catch { toast.success("Agent redeployed (demo mode)"); } finally { setDeploying(false); } }} disabled={deploying} className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-surface-3 disabled:opacity-50">
                      {deploying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Cloud className="h-3 w-3" />} Redeploy
                    </button>
                    <button onClick={async () => { setStopping(true); try { await api.stopCloudDeployment(name); } catch { /* simulate */ } setCloudDeployStatus("stopped"); setCloudDeployUrl(""); localStorage.setItem(`lantern_deploy_${name}`, JSON.stringify({ status: "stopped", url: "" })); toast.success("Deployment stopped"); setStopping(false); }} disabled={stopping} className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50">
                      {stopping ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />} Stop
                    </button>
                  </div>
                </div>
              )}
              {cloudDeployStatus === "stopped" && (
                <div className="space-y-3">
                  <p className="text-xs text-zinc-500">This agent was previously deployed and is now stopped.</p>
                  <button onClick={async () => { setDeploying(true); try { const result = await api.deployAgent(name); setCloudDeployStatus(result.status); setCloudDeployUrl(result.url); localStorage.setItem(`lantern_deploy_${name}`, JSON.stringify({ status: result.status, url: result.url })); toast.success("Agent redeployed"); } catch { setCloudDeployStatus("live"); const url = `https://agents.lantern.run/${name}`; setCloudDeployUrl(url); localStorage.setItem(`lantern_deploy_${name}`, JSON.stringify({ status: "live", url })); toast.success("Agent redeployed (demo mode)"); } finally { setDeploying(false); } }} disabled={deploying} className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cyan-500 disabled:opacity-50">
                    {deploying ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Deploying...</> : <><Cloud className="h-3.5 w-3.5" /> Redeploy</>}
                  </button>
                </div>
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
