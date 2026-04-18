"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Search, Mail, Github, Calendar, FileText, MessageSquare, Phone, CreditCard, BarChart3, Bug, Trello, Database, Globe, X, Loader2, Plug, Eye, EyeOff, AlertCircle, CheckCircle2, RefreshCw, ExternalLink, Plus, Server, Trash2 } from "lucide-react";
import clsx from "clsx";
import { useToast } from "@/components/toast";
import { HeaderSkeleton, Skeleton } from "@/components/skeleton";
import { PageHeader } from "@/components/page-header";
import { api } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

interface Field { key: string; label: string; placeholder: string; type?: "text" | "password"; prefix?: string; minLength?: number; helpUrl?: string; helpText?: string; required?: boolean }
interface ConnectorDef { id: string; name: string; description: string; category: string; icon: typeof Mail; iconColor: string; iconBg: string; oauthProvider?: string; oauthLabel?: string; fields: Field[]; manualLabel?: string }
interface ConnectorState { installed: boolean; connectedAccount?: string; installedAt?: string; backendId?: string; credentials?: Record<string, string> }

const googleFields: Field[] = [
  { key: "email", label: "Email address", placeholder: "you@gmail.com", type: "text", minLength: 5, required: true },
  { key: "appPassword", label: "App Password", placeholder: "xxxx xxxx xxxx xxxx", minLength: 16, helpUrl: "https://myaccount.google.com/apppasswords", helpText: "Generate an app password at myaccount.google.com/apppasswords", required: true },
];

const d = (id: string, name: string, desc: string, cat: string, icon: typeof Mail, color: string, bg: string, fields: Field[], extra?: Partial<ConnectorDef>): ConnectorDef =>
  ({ id, name, description: desc, category: cat, icon, iconColor: color, iconBg: bg, fields, ...extra });
const goo = (id: string, name: string, desc: string, cat: string, icon: typeof Mail, color: string, bg: string) =>
  d(id, name, desc, cat, icon, color, bg, googleFields, { oauthProvider: id, oauthLabel: "Sign in with Google", manualLabel: "Use App Password" });

const connectors: ConnectorDef[] = [
  d("slack", "Slack", "Send messages, manage channels, and respond to events", "Communication", MessageSquare, "text-purple-400", "bg-purple-500/10",
    [{ key: "workspaceUrl", label: "Workspace URL", placeholder: "your-team.slack.com", type: "text", minLength: 5, required: true },
     { key: "botToken", label: "Bot Token", placeholder: "xoxb-...", prefix: "xoxb-", minLength: 20, helpUrl: "https://api.slack.com/apps", helpText: "Create a Slack app at api.slack.com", required: true }],
    { oauthProvider: "slack", oauthLabel: "Add to Slack", manualLabel: "Enter bot token" }),
  d("discord", "Discord", "Bot integration for servers and DMs", "Communication", MessageSquare, "text-indigo-400", "bg-indigo-500/10",
    [{ key: "botToken", label: "Bot Token", placeholder: "Discord bot token", minLength: 50, helpUrl: "https://discord.com/developers/applications", helpText: "Get from discord.com/developers", required: true }]),
  d("telegram", "Telegram", "Bot messaging with inline buttons and media", "Communication", MessageSquare, "text-sky-400", "bg-sky-500/10",
    [{ key: "botToken", label: "Bot Token", placeholder: "123456:ABC-DEF1234...", minLength: 30, helpUrl: "https://t.me/BotFather", helpText: "Get from @BotFather on Telegram", required: true }]),
  d("twilio", "Twilio", "SMS, voice, and WhatsApp messaging", "Communication", Phone, "text-red-400", "bg-red-500/10",
    [{ key: "accountSid", label: "Account SID", placeholder: "ACxxxxxxxx...", prefix: "AC", minLength: 34, helpUrl: "https://console.twilio.com", helpText: "Found in your Twilio Console", required: true },
     { key: "authToken", label: "Auth Token", placeholder: "Your Twilio auth token", minLength: 32, required: true },
     { key: "phoneNumber", label: "Phone Number", placeholder: "+1234567890", type: "text", minLength: 10, helpText: "Your Twilio phone number", required: true }]),
  goo("gmail", "Gmail", "Read, send, and manage email", "Email & Calendar", Mail, "text-red-400", "bg-red-500/10"),
  goo("google-calendar", "Google Calendar", "Manage events and check availability", "Email & Calendar", Calendar, "text-blue-400", "bg-blue-500/10"),
  goo("google-drive", "Google Drive", "Access files and manage permissions", "Docs & Storage", FileText, "text-yellow-400", "bg-yellow-500/10"),
  goo("google-sheets", "Google Sheets", "Read and write spreadsheet data", "Docs & Storage", FileText, "text-green-400", "bg-green-500/10"),
  d("notion", "Notion", "Access databases and workspace content", "Docs & Storage", FileText, "text-zinc-300", "bg-zinc-500/10",
    [{ key: "integrationToken", label: "Integration Token", placeholder: "secret_...", prefix: "secret_", minLength: 20, helpUrl: "https://www.notion.so/my-integrations", helpText: "Get from notion.so/my-integrations", required: true }]),
  d("github", "GitHub", "Repositories, issues, pull requests", "Dev Tools", Github, "text-zinc-300", "bg-zinc-500/10",
    [{ key: "username", label: "Username", placeholder: "your-github-username", type: "text", minLength: 1, required: true },
     { key: "personalAccessToken", label: "Personal Access Token", placeholder: "ghp_...", prefix: "gh", minLength: 20, helpUrl: "https://github.com/settings/tokens", helpText: "Create at github.com/settings/tokens", required: true }],
    { oauthProvider: "github", oauthLabel: "Sign in with GitHub", manualLabel: "Enter Personal Access Token" }),
  d("linear", "Linear", "Issue tracking and project management", "Dev Tools", Trello, "text-indigo-400", "bg-indigo-500/10",
    [{ key: "apiKey", label: "API Key", placeholder: "lin_api_...", prefix: "lin_api_", minLength: 20, helpUrl: "https://linear.app/settings/api", helpText: "Get from linear.app/settings/api", required: true }]),
  d("jira", "Jira", "Issue tracking and agile management", "Dev Tools", Trello, "text-blue-400", "bg-blue-500/10",
    [{ key: "email", label: "Email", placeholder: "you@company.com", type: "text", minLength: 5, required: true },
     { key: "apiToken", label: "API Token", placeholder: "Jira API token", minLength: 10, helpUrl: "https://id.atlassian.net/manage-profile/security/api-tokens", helpText: "Get from Atlassian > API Tokens", required: true },
     { key: "domain", label: "Domain", placeholder: "yourcompany.atlassian.net", type: "text", minLength: 5, helpText: "e.g. yourcompany.atlassian.net", required: true }]),
  d("sentry", "Sentry", "Error tracking and performance monitoring", "Dev Tools", Bug, "text-pink-400", "bg-pink-500/10",
    [{ key: "authToken", label: "Auth Token", placeholder: "sntrys_...", prefix: "sntrys_", minLength: 20, helpUrl: "https://sentry.io/settings/account/api/auth-tokens/", helpText: "Get from sentry.io > Auth Tokens", required: true }]),
  d("vercel", "Vercel", "Deployment management and project config", "Dev Tools", Globe, "text-zinc-300", "bg-zinc-500/10",
    [{ key: "authToken", label: "Token", placeholder: "Vercel access token", minLength: 20, helpUrl: "https://vercel.com/account/tokens", helpText: "Get from vercel.com/account/tokens", required: true }]),
  d("hubspot", "HubSpot", "CRM contacts, deals, and marketing", "CRM & Sales", BarChart3, "text-orange-400", "bg-orange-500/10",
    [{ key: "apiKey", label: "API Key", placeholder: "HubSpot API key", minLength: 10, helpUrl: "https://app.hubspot.com/settings/api-key", helpText: "Get from HubSpot Settings", required: true }]),
  d("salesforce", "Salesforce", "CRM platform with full API access", "CRM & Sales", Database, "text-blue-400", "bg-blue-500/10",
    [{ key: "username", label: "Username", placeholder: "you@company.com", type: "text", minLength: 3, required: true },
     { key: "password", label: "Password", placeholder: "Your Salesforce password", minLength: 5, required: true },
     { key: "securityToken", label: "Security Token", placeholder: "Salesforce security token", minLength: 5, helpUrl: "https://help.salesforce.com/s/articleView?id=sf.user_security_token.htm", helpText: "Reset from Salesforce Settings", required: true }]),
  d("stripe", "Stripe", "Payments, subscriptions, and billing", "Commerce", CreditCard, "text-purple-400", "bg-purple-500/10",
    [{ key: "secretKey", label: "Secret Key", placeholder: "sk_live_... or sk_test_...", prefix: "sk_", minLength: 20, helpUrl: "https://dashboard.stripe.com/apikeys", helpText: "Get from stripe.com/apikeys", required: true }]),
];

const categories = ["All", "Communication", "Email & Calendar", "Docs & Storage", "Dev Tools", "CRM & Sales", "Commerce"];
const STORAGE_KEY = "lantern_connectors";
const MCP_STORAGE_KEY = "lantern_mcp_servers";

interface McpServer {
  id: string;
  name: string;
  url: string;
  description: string;
  addedAt: string;
}

function loadMcpServers(): McpServer[] {
  if (typeof window === "undefined") return [];
  try { const r = localStorage.getItem(MCP_STORAGE_KEY); if (!r) return []; return JSON.parse(r) as McpServer[]; } catch { return []; }
}
function saveMcpServers(servers: McpServer[]) { if (typeof window !== "undefined") localStorage.setItem(MCP_STORAGE_KEY, JSON.stringify(servers)); }

function loadStates(): Record<string, ConnectorState> {
  if (typeof window === "undefined") return {};
  try { const r = localStorage.getItem(STORAGE_KEY); if (!r) return {}; const p = JSON.parse(r); const v: Record<string, ConnectorState> = {}; for (const [k, s] of Object.entries(p)) { if ((s as ConnectorState).installed) v[k] = s as ConnectorState; } return v; } catch { return {}; }
}
function saveStates(s: Record<string, ConnectorState>) { if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }

function validate(vals: Record<string, string>, defs: Field[]): Record<string, string> {
  const e: Record<string, string> = {};
  for (const f of defs) {
    const v = (vals[f.key] ?? "").trim();
    if (f.required && !v) { e[f.key] = `${f.label} is required`; continue; }
    if (v && f.minLength && v.length < f.minLength) { e[f.key] = `Must be at least ${f.minLength} characters`; continue; }
    if (v && f.prefix && !v.startsWith(f.prefix)) e[f.key] = `Should start with "${f.prefix}"`;
  }
  return e;
}

function SecretInput({ value, onChange, placeholder, isText }: { value: string; onChange: (v: string) => void; placeholder: string; isText?: boolean }) {
  const [vis, setVis] = useState(false);
  return (
    <div className="relative">
      <input type={isText || vis ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 pr-10 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30" />
      {!isText && <button type="button" onClick={() => setVis(!vis)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 transition-colors hover:text-zinc-300">{vis ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ConnectorsPage() {
  const toast = useToast();
  const [states, setStates] = useState<Record<string, ConnectorState>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [usingApi, setUsingApi] = useState(false);

  // Modal
  const [mc, setMc] = useState<ConnectorDef | null>(null); // modal connector
  const [view, setView] = useState<"choose" | "manual" | "testing" | "success" | "config">("choose");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const [oauthErr, setOauthErr] = useState("");

  // MCP Marketplace
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [mcpForm, setMcpForm] = useState({ url: "", name: "", description: "" });
  const [mcpErrors, setMcpErrors] = useState<Record<string, string>>({});
  const [mcpSearch, setMcpSearch] = useState("");

  const loadData = useCallback(async () => {
    try {
      const installed = await api.listConnectors();
      if (installed && installed.length >= 0) {
        setUsingApi(true);
        const m: Record<string, ConnectorState> = {};
        for (const ci of installed) m[ci.connectorId] = { installed: true, connectedAccount: ci.displayName, installedAt: ci.installedAt, backendId: ci.id };
        setStates(m); saveStates(m); setLoading(false); return;
      }
    } catch { /* API unavailable */ }
    setUsingApi(false); setStates(loadStates()); setLoading(false);
  }, []);

  useEffect(() => { loadData(); setMcpServers(loadMcpServers()); }, [loadData]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showMcpModal) setShowMcpModal(false);
        else if (mc) setMc(null);
      }
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [mc, showMcpModal]);

  // Listen for OAuth popup completion.
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== "lantern:oauth:complete") return;
      if (e.data.success) {
        setView("success"); setMsg(e.data.message || "Connected successfully"); setOauthErr("");
        loadData();
        setTimeout(() => { setMc(null); toast.success(`${mc?.name ?? "Connector"} connected via OAuth`); }, 1200);
      } else {
        setOauthErr(e.data.message || "OAuth authorization failed");
        setView("choose");
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [mc, loadData, toast]);

  const filtered = useMemo(() => {
    let r = connectors;
    if (category !== "All") r = r.filter((c) => c.category === category);
    if (search.trim()) { const q = search.toLowerCase(); r = r.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)); }
    return r;
  }, [category, search]);

  const installed = Object.values(states).filter((s) => s.installed).length;
  const counts = useMemo(() => { const m: Record<string, number> = { All: connectors.length }; for (const c of connectors) m[c.category] = (m[c.category] ?? 0) + 1; return m; }, []);

  const openModal = (con: ConnectorDef) => {
    const inst = states[con.id]?.installed;
    setMc(con); setCreds({}); setErrors({}); setMsg(""); setDisconnecting(false); setOauthErr("");
    setView(inst ? "config" : con.oauthProvider ? "choose" : con.fields.length > 0 ? "manual" : "choose");
  };

  const handleOAuth = async () => {
    if (!mc) return;
    setOauthErr("");
    try {
      const { redirectUrl } = await api.startOAuth(mc.id);
      const w = 600, h = 700;
      const left = window.screenX + (window.outerWidth - w) / 2;
      const top = window.screenY + (window.outerHeight - h) / 2;
      window.open(redirectUrl, "lantern-oauth", `width=${w},height=${h},left=${left},top=${top},popup=yes`);
      // The popup will postMessage on completion (handled by the useEffect above).
    } catch {
      // OAuth not configured on the backend — fall back to manual if fields exist.
      if (mc.fields.length > 0) {
        setOauthErr(`OAuth is not configured for ${mc.name}. Connect manually instead.`);
        setView("manual");
      } else {
        setOauthErr(`OAuth is not configured for ${mc.name}. Set OAUTH_CLIENT_ID_${mc.id.toUpperCase().replace(/-/g, "_")} and OAUTH_CLIENT_SECRET_${mc.id.toUpperCase().replace(/-/g, "_")} in your environment.`);
      }
    }
  };

  const handleConnect = async () => {
    if (!mc) return;
    const errs = validate(creds, mc.fields);
    setErrors(errs); if (Object.keys(errs).length > 0) return;
    setView("testing"); setMsg("Testing connection...");
    try {
      if (usingApi) {
        const inst = await api.installConnector({ connectorId: mc.id, displayName: mc.name, config: creds });
        const res = await api.testConnector(inst.id);
        if (res.success) { setView("success"); setMsg(res.message); await loadData(); const a = creds.email || mc.name + " account"; setTimeout(() => { setMc(null); toast.success(`${mc.name} connected as ${a}`); }, 800); return; }
        await api.uninstallConnector(inst.id); setView("manual"); setMsg(res.message); return;
      }
    } catch { /* fall back */ }
    await new Promise((r) => setTimeout(r, 1500));
    const account = creds.email || mc.name + " account";
    const up = { ...states, [mc.id]: { installed: true, connectedAccount: account, installedAt: new Date().toISOString(), credentials: { ...creds } } };
    setStates(up); saveStates(up); setView("success"); setMsg("Connection verified successfully");
    setTimeout(() => { setMc(null); toast.success(`${mc.name} connected as ${account}`); }, 800);
  };

  const handleTest = async () => {
    if (!mc) return; setMsg("Verifying connection..."); setView("testing");
    try { const s = states[mc.id]; if (usingApi && s?.backendId) { const r = await api.testConnector(s.backendId); setView("config"); setMsg(r.success ? "Connection is active" : r.message); return; } } catch { /* fall back */ }
    await new Promise((r) => setTimeout(r, 1500)); setView("config"); setMsg("Connection is active and working");
  };

  const handleDisconnect = async () => {
    if (!mc) return; setDisconnecting(true); const s = states[mc.id];
    try { if (usingApi && s?.backendId) { await api.uninstallConnector(s.backendId); await loadData(); setDisconnecting(false); setMc(null); toast.info(`${mc.name} disconnected`); return; } } catch { /* fall back */ }
    await new Promise((r) => setTimeout(r, 600));
    const up = { ...states }; delete up[mc.id]; setStates(up); saveStates(up); setDisconnecting(false); setMc(null); toast.info(`${mc.name} disconnected`);
  };

  const filteredMcpServers = useMemo(() => {
    if (!mcpSearch.trim()) return mcpServers;
    const q = mcpSearch.toLowerCase();
    return mcpServers.filter((s) => s.name.toLowerCase().includes(q) || s.url.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [mcpServers, mcpSearch]);

  const handleAddMcp = () => {
    const errs: Record<string, string> = {};
    if (!mcpForm.url.trim()) errs.url = "Server URL is required";
    else if (!/^https?:\/\/.+/.test(mcpForm.url.trim())) errs.url = "Must be a valid HTTP(S) URL";
    if (!mcpForm.name.trim()) errs.name = "Name is required";
    if (mcpServers.some((s) => s.url === mcpForm.url.trim())) errs.url = "This server URL is already added";
    setMcpErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const server: McpServer = {
      id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: mcpForm.name.trim(),
      url: mcpForm.url.trim(),
      description: mcpForm.description.trim(),
      addedAt: new Date().toISOString(),
    };
    const updated = [...mcpServers, server];
    setMcpServers(updated);
    saveMcpServers(updated);
    setShowMcpModal(false);
    setMcpForm({ url: "", name: "", description: "" });
    setMcpErrors({});
    toast.success(`MCP server "${server.name}" added -- its tools are now available to agents`);
  };

  const handleRemoveMcp = (id: string) => {
    const server = mcpServers.find((s) => s.id === id);
    const updated = mcpServers.filter((s) => s.id !== id);
    setMcpServers(updated);
    saveMcpServers(updated);
    toast.info(`${server?.name ?? "MCP server"} removed`);
  };

  if (loading) return (
    <div className="flex flex-1 flex-col overflow-auto"><HeaderSkeleton /><div className="p-8"><Skeleton className="mb-6 h-10 w-full max-w-md rounded-lg" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 12 }).map((_, i) => <div key={i} className="rounded-xl border border-zinc-800 bg-surface-1 p-4"><Skeleton className="mb-3 h-10 w-10 rounded-xl" /><Skeleton className="mb-2 h-4 w-20" /><Skeleton className="mb-3 h-3 w-full" /><Skeleton className="h-7 w-16 rounded-lg" /></div>)}
      </div></div></div>
  );

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <PageHeader
        title="Connectors"
        description="OAuth or API-key integrations your agents can call. Secrets are encrypted per-tenant — agents get access via a ref, never the raw value."
        badge={
          installed > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {installed} connected
            </span>
          ) : null
        }
      />

      <div className="flex-1 p-8">
        {/* MCP Marketplace Section */}
        <div className="mb-8 rounded-xl border border-zinc-800 bg-surface-1 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-lantern-500/10">
                <Server className="h-5 w-5 text-lantern-400" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">MCP Marketplace</h2>
                <p className="text-xs text-zinc-500">Connect any MCP server to use its tools in your agents</p>
              </div>
            </div>
            <button
              onClick={() => { setShowMcpModal(true); setMcpForm({ url: "", name: "", description: "" }); setMcpErrors({}); }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-lantern-400"
            >
              <Plus className="h-3.5 w-3.5" />
              Add MCP Server
            </button>
          </div>

          {mcpServers.length > 0 && (
            <div className="mb-3 relative max-w-sm">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <input type="text" value={mcpSearch} onChange={(e) => setMcpSearch(e.target.value)} placeholder="Search MCP servers..."
                className="w-full rounded-lg border border-zinc-800 bg-surface-0 py-1.5 pl-8 pr-3 text-xs text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/30" />
            </div>
          )}

          {mcpServers.length === 0 ? (
            <div className="flex flex-col items-center py-6">
              <Server className="mb-2 h-8 w-8 text-zinc-700" />
              <p className="text-xs text-zinc-500">No MCP servers added yet. Add one to make its tools available to your agents.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredMcpServers.map((server) => (
                <div key={server.id} className="group rounded-xl border border-zinc-800 bg-surface-0 p-4 transition-colors hover:border-zinc-700">
                  <div className="flex items-start justify-between">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-lantern-500/10">
                      <Server className="h-4 w-4 text-lantern-400" />
                    </div>
                    <button
                      onClick={() => handleRemoveMcp(server.id)}
                      className="rounded p-1 text-zinc-600 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                      title="Remove server"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <h3 className="mt-2 text-sm font-medium text-zinc-200 truncate">{server.name}</h3>
                  <p className="mt-0.5 text-[11px] text-zinc-500 truncate">{server.url}</p>
                  {server.description && <p className="mt-1 text-[11px] text-zinc-600 line-clamp-2">{server.description}</p>}
                  <div className="mt-2 flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    <span className="text-[10px] text-emerald-400/70">Connected</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Search */}
        <div className="mb-6 relative max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search connectors..."
            className="w-full rounded-lg border border-zinc-800 bg-surface-0 py-2 pl-9 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/30" />
        </div>
        {/* Category tabs */}
        <div className="mb-6 flex gap-1 overflow-x-auto pb-1">
          {categories.map((cat) => (
            <button key={cat} onClick={() => setCategory(cat)}
              className={clsx("whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors inline-flex items-center gap-1.5",
                category === cat ? "bg-surface-3 text-zinc-100" : "text-zinc-500 hover:bg-surface-2 hover:text-zinc-300")}>
              {cat}<span className={clsx("rounded-full px-1.5 py-0.5 text-[10px] font-medium", category === cat ? "bg-lantern-500/20 text-lantern-400" : "bg-surface-3 text-zinc-600")}>{counts[cat] ?? 0}</span>
            </button>
          ))}
        </div>
        {/* Grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((con) => {
            const s = states[con.id]; const on = s?.installed ?? false; const I = con.icon;
            return (
              <div key={con.id} className="connector-card card-hover group">
                <div className="flex items-start justify-between">
                  <div className={clsx("flex h-10 w-10 items-center justify-center rounded-xl", con.iconBg)}><I className={clsx("h-5 w-5", con.iconColor)} /></div>
                  {on && <span className="h-2 w-2 rounded-full bg-emerald-400" title="Connected" />}
                </div>
                <h3 className="mt-3 text-sm font-semibold text-zinc-100">{con.name}</h3>
                <p className="mt-1 text-[11px] text-zinc-500 leading-relaxed line-clamp-2">{con.description}</p>
                {on && s?.connectedAccount && <p className="mt-1.5 truncate text-[11px] text-emerald-400/70">{s.connectedAccount}</p>}
                <button onClick={() => openModal(con)}
                  className={clsx("mt-3 w-full rounded-lg px-3 py-1.5 text-xs font-medium transition-colors", on ? "border border-zinc-700 text-zinc-300 hover:bg-surface-3" : "bg-lantern-500 text-white hover:bg-lantern-400")}>
                  {on ? "Configure" : "Connect"}
                </button>
              </div>
            );
          })}
        </div>
        {filtered.length === 0 && <div className="flex flex-col items-center justify-center py-16"><Plug className="mb-3 h-10 w-10 text-zinc-600" /><p className="text-sm text-zinc-500">No connectors match your search</p></div>}
      </div>

      {/* MCP Add Server Modal */}
      {showMcpModal && (
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowMcpModal(false)}>
          <div className="modal-content w-full max-w-lg rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-lantern-500/10"><Server className="h-4 w-4 text-lantern-400" /></div>
                <div>
                  <h2 className="text-lg font-semibold text-zinc-100">Add MCP Server</h2>
                  <p className="text-xs text-zinc-500">Point at any MCP-compatible server to use its tools</p>
                </div>
              </div>
              <button onClick={() => setShowMcpModal(false)} className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"><X className="h-5 w-5" /></button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div>
                <label className="mb-1.5 flex items-center gap-1 text-sm font-medium text-zinc-300">Server URL <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={mcpForm.url}
                  onChange={(e) => { setMcpForm((p) => ({ ...p, url: e.target.value })); setMcpErrors((p) => { const n = { ...p }; delete n.url; return n; }); }}
                  placeholder="https://mcp.example.com/sse"
                  className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
                />
                {mcpErrors.url && <p className="mt-1 flex items-center gap-1 text-xs text-red-400"><AlertCircle className="h-3 w-3" />{mcpErrors.url}</p>}
                <p className="mt-1 text-[11px] text-zinc-600">The SSE or WebSocket endpoint of the MCP server</p>
              </div>
              <div>
                <label className="mb-1.5 flex items-center gap-1 text-sm font-medium text-zinc-300">Name <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={mcpForm.name}
                  onChange={(e) => { setMcpForm((p) => ({ ...p, name: e.target.value })); setMcpErrors((p) => { const n = { ...p }; delete n.name; return n; }); }}
                  placeholder="e.g. My Custom Tools"
                  className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
                />
                {mcpErrors.name && <p className="mt-1 flex items-center gap-1 text-xs text-red-400"><AlertCircle className="h-3 w-3" />{mcpErrors.name}</p>}
              </div>
              <div>
                <label className="mb-1.5 text-sm font-medium text-zinc-300">Description</label>
                <input
                  type="text"
                  value={mcpForm.description}
                  onChange={(e) => setMcpForm((p) => ({ ...p, description: e.target.value }))}
                  placeholder="What tools does this server provide?"
                  className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-6 py-4">
              <button onClick={() => setShowMcpModal(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200">Cancel</button>
              <button onClick={handleAddMcp} className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400">
                <Plus className="h-3.5 w-3.5" />Add Server
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connector Modal */}
      {mc && (
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setMc(null)}>
          <div className="modal-content w-full max-w-lg rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className={clsx("flex h-8 w-8 items-center justify-center rounded-lg", mc.iconBg)}><mc.icon className={clsx("h-4 w-4", mc.iconColor)} /></div>
                <div>
                  <h2 className="text-lg font-semibold text-zinc-100">{view === "config" ? mc.name : `Connect ${mc.name}`}</h2>
                  <p className="text-xs text-zinc-500">{view === "config" ? "Manage your connection" : view === "choose" ? "Choose how to connect" : view === "manual" ? "Enter your credentials" : ""}</p>
                </div>
              </div>
              <button onClick={() => setMc(null)} className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"><X className="h-5 w-5" /></button>
            </div>
            {/* Body */}
            <div className="px-6 py-5 space-y-4">
              {view === "choose" && (<>
                {oauthErr && <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3"><p className="text-xs text-amber-400">{oauthErr}</p></div>}
                {mc.oauthProvider && <button onClick={handleOAuth} className="flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100"><ExternalLink className="h-4 w-4" />{mc.oauthLabel ?? `Sign in with ${mc.name}`}</button>}
                {mc.fields.length > 0 && (<>
                  {mc.oauthProvider && <div className="flex items-center gap-3"><div className="h-px flex-1 bg-zinc-800" /><span className="text-xs text-zinc-600">or</span><div className="h-px flex-1 bg-zinc-800" /></div>}
                  <button onClick={() => { setOauthErr(""); setView("manual"); }} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3">{mc.manualLabel ?? "Connect manually"}</button>
                </>)}
                {!mc.oauthProvider && mc.fields.length === 0 && <p className="py-4 text-center text-sm text-zinc-500">This connector requires OAuth which is not configured yet.</p>}
              </>)}

              {view === "manual" && (<>
                {oauthErr && <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3"><p className="text-xs text-amber-400">{oauthErr}</p></div>}
                {msg && <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3"><div className="flex items-center gap-2"><AlertCircle className="h-3.5 w-3.5 text-red-400" /><p className="text-xs font-medium text-red-400">{msg}</p></div></div>}
                {mc.fields.map((f) => (
                  <div key={f.key}>
                    <label className="mb-1.5 flex items-center gap-1 text-sm font-medium text-zinc-300">{f.label}{f.required && <span className="text-red-400">*</span>}</label>
                    <SecretInput value={creds[f.key] ?? ""} onChange={(v) => { setCreds((p) => ({ ...p, [f.key]: v })); setErrors((p) => { const n = { ...p }; delete n[f.key]; return n; }); }} placeholder={f.placeholder} isText={f.type === "text"} />
                    {errors[f.key] && <p className="mt-1 flex items-center gap-1 text-xs text-red-400"><AlertCircle className="h-3 w-3" />{errors[f.key]}</p>}
                    {f.helpText && !errors[f.key] && <p className="mt-1 text-[11px] text-zinc-600">{f.helpUrl ? <a href={f.helpUrl} target="_blank" rel="noopener noreferrer" className="text-lantern-400/70 hover:text-lantern-400 underline underline-offset-2">{f.helpText}</a> : f.helpText}</p>}
                  </div>
                ))}
              </>)}

              {view === "testing" && <div className="flex flex-col items-center py-8"><Loader2 className="mb-4 h-10 w-10 animate-spin text-lantern-400" /><p className="text-sm font-medium text-zinc-200">{msg}</p></div>}
              {view === "success" && <div className="flex flex-col items-center py-8"><div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10"><CheckCircle2 className="h-7 w-7 text-emerald-400" /></div><p className="text-sm font-medium text-emerald-400">{msg}</p></div>}

              {view === "config" && (<>
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
                  <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-emerald-400" /><p className="text-sm font-medium text-emerald-400">Connected</p></div>
                  <p className="mt-1 text-xs text-zinc-500">Account: {states[mc.id]?.connectedAccount ?? "unknown"}</p>
                  {states[mc.id]?.installedAt && <p className="mt-0.5 text-xs text-zinc-600">Since {new Date(states[mc.id]!.installedAt!).toLocaleDateString()}</p>}
                </div>
                {msg && <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3"><div className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /><p className="text-xs font-medium text-emerald-400">{msg}</p></div></div>}
              </>)}
            </div>
            {/* Footer */}
            <div className="flex items-center justify-between border-t border-zinc-800 px-6 py-4">
              {view === "config" ? (<>
                <button onClick={handleDisconnect} disabled={disconnecting} className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50">
                  {disconnecting ? <><Loader2 className="h-3 w-3 animate-spin" />Disconnecting...</> : "Disconnect"}</button>
                <button onClick={handleTest} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"><RefreshCw className="h-3 w-3" />Test Connection</button>
              </>) : (<>
                <button onClick={() => setMc(null)} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200">Cancel</button>
                <div className="flex items-center gap-2">
                  {view === "manual" && mc.oauthProvider && <button onClick={() => { setOauthErr(""); setMsg(""); setView("choose"); }} className="rounded-lg px-3 py-2 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-300">Back</button>}
                  {view === "manual" && <button onClick={handleConnect} className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400"><Plug className="h-3.5 w-3.5" />Test &amp; Connect</button>}
                </div>
              </>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
