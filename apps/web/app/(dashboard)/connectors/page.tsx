"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Search,
  Mail,
  Github,
  Calendar,
  FileText,
  MessageSquare,
  Phone,
  CreditCard,
  ShoppingCart,
  BarChart3,
  Bug,
  Trello,
  Database,
  Globe,
  X,
  Check,
  Shield,
  Loader2,
  ExternalLink,
  Plug,
} from "lucide-react";
import clsx from "clsx";
import { useToast } from "@/components/toast";
import { HeaderSkeleton, Skeleton } from "@/components/skeleton";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectorDef {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: typeof Mail;
  iconColor: string;
  iconBg: string;
  permissions: string[];
}

interface ConnectorState {
  installed: boolean;
  connectedAccount?: string;
  installedAt?: string;
}

// ---------------------------------------------------------------------------
// Connector catalog
// ---------------------------------------------------------------------------

const connectors: ConnectorDef[] = [
  // Communication
  { id: "slack", name: "Slack", description: "Send messages, manage channels, and respond to events", category: "Communication", icon: MessageSquare, iconColor: "text-purple-400", iconBg: "bg-purple-500/10", permissions: ["Read messages", "Send messages", "Manage channels", "Access user profiles"] },
  { id: "discord", name: "Discord", description: "Bot integration for servers and DMs", category: "Communication", icon: MessageSquare, iconColor: "text-indigo-400", iconBg: "bg-indigo-500/10", permissions: ["Read messages", "Send messages", "Manage server", "Manage roles"] },
  { id: "telegram", name: "Telegram", description: "Bot messaging with inline buttons and media", category: "Communication", icon: MessageSquare, iconColor: "text-sky-400", iconBg: "bg-sky-500/10", permissions: ["Send messages", "Read updates", "Manage webhooks"] },
  { id: "ms-teams", name: "Microsoft Teams", description: "Team messaging and channel integration", category: "Communication", icon: MessageSquare, iconColor: "text-blue-400", iconBg: "bg-blue-500/10", permissions: ["Read messages", "Send messages", "Access teams", "Access channels"] },
  { id: "twilio", name: "Twilio", description: "SMS, voice, and WhatsApp messaging", category: "Communication", icon: Phone, iconColor: "text-red-400", iconBg: "bg-red-500/10", permissions: ["Send SMS", "Make calls", "Manage phone numbers"] },

  // Email & Calendar
  { id: "gmail", name: "Gmail", description: "Read, send, and manage email through Gmail", category: "Email & Calendar", icon: Mail, iconColor: "text-red-400", iconBg: "bg-red-500/10", permissions: ["Read emails", "Send emails", "Manage labels", "Access contacts"] },
  { id: "google-calendar", name: "Google Calendar", description: "Manage events, check availability, and schedule meetings", category: "Email & Calendar", icon: Calendar, iconColor: "text-blue-400", iconBg: "bg-blue-500/10", permissions: ["Read events", "Create events", "Modify events", "Access free/busy"] },
  { id: "outlook", name: "Outlook", description: "Microsoft email and calendar integration", category: "Email & Calendar", icon: Mail, iconColor: "text-blue-400", iconBg: "bg-blue-500/10", permissions: ["Read emails", "Send emails", "Manage calendar", "Access contacts"] },

  // Docs & Storage
  { id: "google-drive", name: "Google Drive", description: "Access files, create documents, and manage permissions", category: "Docs & Storage", icon: FileText, iconColor: "text-yellow-400", iconBg: "bg-yellow-500/10", permissions: ["Read files", "Create files", "Manage permissions", "Search documents"] },
  { id: "google-sheets", name: "Google Sheets", description: "Read and write spreadsheet data", category: "Docs & Storage", icon: FileText, iconColor: "text-green-400", iconBg: "bg-green-500/10", permissions: ["Read spreadsheets", "Edit spreadsheets", "Create spreadsheets"] },
  { id: "notion", name: "Notion", description: "Access databases, pages, and workspace content", category: "Docs & Storage", icon: FileText, iconColor: "text-zinc-300", iconBg: "bg-zinc-500/10", permissions: ["Read content", "Create pages", "Update databases", "Search workspace"] },
  { id: "dropbox", name: "Dropbox", description: "File storage, sync, and sharing", category: "Docs & Storage", icon: FileText, iconColor: "text-blue-400", iconBg: "bg-blue-500/10", permissions: ["Read files", "Upload files", "Manage sharing", "Search files"] },

  // Dev Tools
  { id: "github", name: "GitHub", description: "Repositories, issues, pull requests, and actions", category: "Dev Tools", icon: Github, iconColor: "text-zinc-300", iconBg: "bg-zinc-500/10", permissions: ["Read repos", "Create issues", "Manage PRs", "Access actions", "Read org data"] },
  { id: "gitlab", name: "GitLab", description: "Repositories, merge requests, and CI/CD pipelines", category: "Dev Tools", icon: Github, iconColor: "text-orange-400", iconBg: "bg-orange-500/10", permissions: ["Read repos", "Manage merge requests", "Access pipelines", "Read issues"] },
  { id: "linear", name: "Linear", description: "Issue tracking and project management", category: "Dev Tools", icon: Trello, iconColor: "text-indigo-400", iconBg: "bg-indigo-500/10", permissions: ["Read issues", "Create issues", "Update issues", "Access projects"] },
  { id: "jira", name: "Jira", description: "Issue tracking and agile project management", category: "Dev Tools", icon: Trello, iconColor: "text-blue-400", iconBg: "bg-blue-500/10", permissions: ["Read issues", "Create issues", "Manage sprints", "Access boards"] },
  { id: "sentry", name: "Sentry", description: "Error tracking and performance monitoring", category: "Dev Tools", icon: Bug, iconColor: "text-pink-400", iconBg: "bg-pink-500/10", permissions: ["Read issues", "Resolve issues", "Access events", "Manage alerts"] },
  { id: "vercel", name: "Vercel", description: "Deployment management and project configuration", category: "Dev Tools", icon: Globe, iconColor: "text-zinc-300", iconBg: "bg-zinc-500/10", permissions: ["Read projects", "Trigger deployments", "Access logs", "Manage domains"] },

  // CRM & Sales
  { id: "hubspot", name: "HubSpot", description: "CRM contacts, deals, and marketing automation", category: "CRM & Sales", icon: BarChart3, iconColor: "text-orange-400", iconBg: "bg-orange-500/10", permissions: ["Read contacts", "Create contacts", "Manage deals", "Access analytics"] },
  { id: "salesforce", name: "Salesforce", description: "CRM platform with full API access", category: "CRM & Sales", icon: Database, iconColor: "text-blue-400", iconBg: "bg-blue-500/10", permissions: ["Read objects", "Create records", "Run queries", "Manage automation"] },
  { id: "intercom", name: "Intercom", description: "Customer messaging and support platform", category: "CRM & Sales", icon: MessageSquare, iconColor: "text-blue-400", iconBg: "bg-blue-500/10", permissions: ["Read conversations", "Send messages", "Manage contacts", "Access articles"] },
  { id: "zendesk", name: "Zendesk", description: "Customer support ticketing and knowledge base", category: "CRM & Sales", icon: MessageSquare, iconColor: "text-green-400", iconBg: "bg-green-500/10", permissions: ["Read tickets", "Create tickets", "Update tickets", "Access knowledge base"] },

  // Commerce
  { id: "stripe", name: "Stripe", description: "Payments, subscriptions, and billing", category: "Commerce", icon: CreditCard, iconColor: "text-purple-400", iconBg: "bg-purple-500/10", permissions: ["Read payments", "Create charges", "Manage subscriptions", "Access invoices"] },
  { id: "shopify", name: "Shopify", description: "E-commerce store management and orders", category: "Commerce", icon: ShoppingCart, iconColor: "text-green-400", iconBg: "bg-green-500/10", permissions: ["Read products", "Manage orders", "Access customers", "Manage inventory"] },
];

const categories = ["All", "Communication", "Email & Calendar", "Docs & Storage", "Dev Tools", "CRM & Sales", "Commerce"];

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "lantern_connectors";

function loadConnectorStates(): Record<string, ConnectorState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveConnectorStates(states: Record<string, ConnectorState>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(states));
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function ConnectorsPage() {
  const toast = useToast();
  const [states, setStates] = useState<Record<string, ConnectorState>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const [connectModal, setConnectModal] = useState<ConnectorDef | null>(null);
  const [configModal, setConfigModal] = useState<ConnectorDef | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    const stored = loadConnectorStates();
    // Pre-install a few connectors for demo
    if (Object.keys(stored).length === 0) {
      const defaults: Record<string, ConnectorState> = {
        gmail: { installed: true, connectedAccount: "demo@lantern.dev", installedAt: "2026-03-15T10:00:00Z" },
        github: { installed: true, connectedAccount: "acme-org", installedAt: "2026-03-10T08:30:00Z" },
        slack: { installed: true, connectedAccount: "Acme Workspace", installedAt: "2026-03-12T14:00:00Z" },
      };
      setStates(defaults);
      saveConnectorStates(defaults);
    } else {
      setStates(stored);
    }
    setLoading(false);
  }, []);

  const filtered = useMemo(() => {
    let result = connectors;
    if (activeCategory !== "All") {
      result = result.filter((c) => c.category === activeCategory);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.category.toLowerCase().includes(q)
      );
    }
    return result;
  }, [activeCategory, search]);

  const installedCount = Object.values(states).filter((s) => s.installed).length;

  const handleAuthorize = async (connector: ConnectorDef) => {
    setAuthorizing(true);
    // Simulate OAuth flow
    await new Promise((r) => setTimeout(r, 1500));
    const updated = {
      ...states,
      [connector.id]: {
        installed: true,
        connectedAccount: "demo@lantern.dev",
        installedAt: new Date().toISOString(),
      },
    };
    setStates(updated);
    saveConnectorStates(updated);
    setAuthorizing(false);
    setConnectModal(null);
    toast.success(`${connector.name} connected successfully`);
  };

  const handleDisconnect = async (connector: ConnectorDef) => {
    setDisconnecting(true);
    await new Promise((r) => setTimeout(r, 600));
    const updated = { ...states };
    delete updated[connector.id];
    setStates(updated);
    saveConnectorStates(updated);
    setDisconnecting(false);
    setConfigModal(null);
    toast.info(`${connector.name} disconnected`);
  };

  if (loading) {
    return (
      <div className="flex flex-1 flex-col overflow-auto">
        <HeaderSkeleton />
        <div className="p-8">
          <Skeleton className="mb-6 h-10 w-full max-w-md rounded-lg" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
                <Skeleton className="mb-3 h-10 w-10 rounded-xl" />
                <Skeleton className="mb-2 h-4 w-20" />
                <Skeleton className="mb-3 h-3 w-full" />
                <Skeleton className="h-7 w-16 rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Connectors</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Connect your agents to the tools you already use
            </p>
          </div>
          <span className="rounded-full bg-lantern-500/10 px-3 py-1 text-xs font-medium text-lantern-400">
            {installedCount} installed
          </span>
        </div>
      </div>

      <div className="flex-1 p-8">
        {/* Search */}
        <div className="mb-6 flex items-center gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search connectors..."
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 py-2 pl-9 pr-3 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
            />
          </div>
        </div>

        {/* Category tabs */}
        <div className="mb-6 flex gap-1 overflow-x-auto pb-1">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={clsx(
                "whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                activeCategory === cat
                  ? "bg-surface-3 text-zinc-100"
                  : "text-zinc-500 hover:bg-surface-2 hover:text-zinc-300"
              )}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Connector grid */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {filtered.map((connector) => {
            const state = states[connector.id];
            const isInstalled = state?.installed ?? false;
            const Icon = connector.icon;
            return (
              <div
                key={connector.id}
                className="group rounded-xl border border-zinc-800 bg-surface-1 p-4 transition-all hover:border-zinc-700"
                style={{
                  backdropFilter: "blur(12px)",
                  background: "linear-gradient(135deg, rgba(15,15,18,0.9), rgba(24,24,27,0.9))",
                }}
              >
                <div className="flex items-start justify-between">
                  <div className={clsx("flex h-10 w-10 items-center justify-center rounded-xl", connector.iconBg)}>
                    <Icon className={clsx("h-5 w-5", connector.iconColor)} />
                  </div>
                  {isInstalled && (
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  )}
                </div>
                <h3 className="mt-3 text-sm font-semibold text-zinc-100">{connector.name}</h3>
                <p className="mt-1 text-[11px] text-zinc-500 leading-relaxed line-clamp-2">
                  {connector.description}
                </p>
                <button
                  onClick={() =>
                    isInstalled ? setConfigModal(connector) : setConnectModal(connector)
                  }
                  className={clsx(
                    "mt-3 w-full rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                    isInstalled
                      ? "border border-zinc-700 text-zinc-300 hover:bg-surface-3"
                      : "bg-lantern-500 text-white hover:bg-lantern-400"
                  )}
                >
                  {isInstalled ? "Configure" : "Connect"}
                </button>
              </div>
            );
          })}
        </div>

        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16">
            <Plug className="mb-3 h-10 w-10 text-zinc-600" />
            <p className="text-sm text-zinc-500">No connectors match your search</p>
          </div>
        )}
      </div>

      {/* Connect modal (OAuth simulation) */}
      {connectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <h2 className="text-lg font-semibold text-zinc-100">Connect {connectModal.name}</h2>
              <button
                onClick={() => setConnectModal(null)}
                className="rounded-lg p-1 text-zinc-500 hover:bg-surface-3 hover:text-zinc-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="px-6 py-5">
              {/* OAuth simulation */}
              <div className="mb-5 flex items-center gap-3">
                <div className={clsx("flex h-12 w-12 items-center justify-center rounded-xl", connectModal.iconBg)}>
                  <connectModal.icon className={clsx("h-6 w-6", connectModal.iconColor)} />
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-100">
                    Lantern wants to access your {connectModal.name}
                  </p>
                  <p className="text-xs text-zinc-500">
                    This will connect via OAuth 2.0
                  </p>
                </div>
              </div>

              {/* Permissions */}
              <div className="mb-5 rounded-lg border border-zinc-800 bg-surface-2 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-zinc-400" />
                  <p className="text-xs font-medium text-zinc-300">Permissions requested</p>
                </div>
                <ul className="space-y-1.5">
                  {connectModal.permissions.map((perm, i) => (
                    <li key={i} className="flex items-center gap-2 text-xs text-zinc-400">
                      <Check className="h-3 w-3 text-emerald-400" />
                      {perm}
                    </li>
                  ))}
                </ul>
              </div>

              <p className="text-[11px] text-zinc-600 leading-relaxed">
                By authorizing, you allow Lantern to perform actions on your behalf.
                Your credentials are encrypted and stored securely in your tenant vault.
                You can revoke access at any time.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
              <button
                onClick={() => setConnectModal(null)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={() => handleAuthorize(connectModal)}
                disabled={authorizing}
                className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {authorizing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Authorizing...
                  </>
                ) : (
                  <>
                    <ExternalLink className="h-3.5 w-3.5" />
                    Authorize
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Configure modal (for installed connectors) */}
      {configModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className={clsx("flex h-8 w-8 items-center justify-center rounded-lg", configModal.iconBg)}>
                  <configModal.icon className={clsx("h-4 w-4", configModal.iconColor)} />
                </div>
                <h2 className="text-lg font-semibold text-zinc-100">{configModal.name}</h2>
              </div>
              <button
                onClick={() => setConfigModal(null)}
                className="rounded-lg p-1 text-zinc-500 hover:bg-surface-3 hover:text-zinc-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="px-6 py-5">
              {/* Status */}
              <div className="mb-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <p className="text-sm font-medium text-emerald-400">Connected</p>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  Account: {states[configModal.id]?.connectedAccount ?? "unknown"}
                </p>
                {states[configModal.id]?.installedAt && (
                  <p className="text-xs text-zinc-600">
                    Connected on {new Date(states[configModal.id]!.installedAt!).toLocaleDateString()}
                  </p>
                )}
              </div>

              {/* Scopes */}
              <div className="mb-4">
                <p className="mb-2 text-xs font-medium text-zinc-300">Active scopes</p>
                <div className="flex flex-wrap gap-1.5">
                  {configModal.permissions.map((perm, i) => (
                    <span key={i} className="rounded-md bg-surface-3 px-2 py-0.5 text-[11px] text-zinc-400">
                      {perm}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-zinc-800 px-6 py-4">
              <button
                onClick={() => handleDisconnect(configModal)}
                disabled={disconnecting}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
              >
                {disconnecting ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Disconnecting...
                  </>
                ) : (
                  "Disconnect"
                )}
              </button>
              <button
                onClick={() => setConfigModal(null)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
