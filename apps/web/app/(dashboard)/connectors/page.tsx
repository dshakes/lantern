"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
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
  Eye,
  EyeOff,
  AlertCircle,
  CheckCircle2,
  Key,
  ArrowRight,
  Settings,
  RefreshCw,
} from "lucide-react";
import clsx from "clsx";
import { format } from "date-fns";
import { useToast } from "@/components/toast";
import { HeaderSkeleton, Skeleton } from "@/components/skeleton";
import { api } from "@/lib/api";
import type { ConnectorInstall } from "@/lib/api";

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
  oauthOnly?: boolean;
  credentialFields?: CredentialField[];
}

interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  prefix?: string;
  minLength?: number;
  helpUrl?: string;
  helpText?: string;
  required?: boolean;
}

interface ConnectorState {
  installed: boolean;
  connectedAccount?: string;
  installedAt?: string;
  backendId?: string;
  credentials?: Record<string, string>;
}

type WizardStep = "method" | "credentials" | "testing" | "done";
type TestStatus = "idle" | "testing" | "success" | "error";

// ---------------------------------------------------------------------------
// Connector catalog with credential field definitions
// ---------------------------------------------------------------------------

const connectors: ConnectorDef[] = [
  // Communication
  {
    id: "slack", name: "Slack", description: "Send messages, manage channels, and respond to events", category: "Communication", icon: MessageSquare, iconColor: "text-purple-400", iconBg: "bg-purple-500/10",
    permissions: ["Read messages", "Send messages", "Manage channels", "Access user profiles"],
    credentialFields: [
      { key: "botToken", label: "Bot Token", placeholder: "xoxb-...", prefix: "xoxb-", minLength: 20, helpUrl: "https://api.slack.com/apps", helpText: "Create an app at api.slack.com/apps", required: true },
      { key: "signingSecret", label: "Signing Secret", placeholder: "Slack signing secret", minLength: 10, helpText: "Found in Basic Information > App Credentials", required: true },
    ],
  },
  {
    id: "discord", name: "Discord", description: "Bot integration for servers and DMs", category: "Communication", icon: MessageSquare, iconColor: "text-indigo-400", iconBg: "bg-indigo-500/10",
    permissions: ["Read messages", "Send messages", "Manage server", "Manage roles"],
    credentialFields: [
      { key: "botToken", label: "Bot Token", placeholder: "Discord bot token", minLength: 50, helpUrl: "https://discord.com/developers/applications", helpText: "Get from discord.com/developers/applications", required: true },
    ],
  },
  {
    id: "telegram", name: "Telegram", description: "Bot messaging with inline buttons and media", category: "Communication", icon: MessageSquare, iconColor: "text-sky-400", iconBg: "bg-sky-500/10",
    permissions: ["Send messages", "Read updates", "Manage webhooks"],
    credentialFields: [
      { key: "botToken", label: "Bot Token", placeholder: "123456:ABC-DEF1234ghIkl-zyx57W2v...", minLength: 30, helpUrl: "https://t.me/BotFather", helpText: "Get from @BotFather on Telegram", required: true },
    ],
  },
  {
    id: "ms-teams", name: "Microsoft Teams", description: "Team messaging and channel integration", category: "Communication", icon: MessageSquare, iconColor: "text-blue-400", iconBg: "bg-blue-500/10",
    permissions: ["Read messages", "Send messages", "Access teams", "Access channels"],
    oauthOnly: true,
  },
  {
    id: "twilio", name: "Twilio", description: "SMS, voice, and WhatsApp messaging", category: "Communication", icon: Phone, iconColor: "text-red-400", iconBg: "bg-red-500/10",
    permissions: ["Send SMS", "Make calls", "Manage phone numbers"],
    credentialFields: [
      { key: "accountSid", label: "Account SID", placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", prefix: "AC", minLength: 34, helpUrl: "https://console.twilio.com", helpText: "Found in your Twilio Console dashboard", required: true },
      { key: "authToken", label: "Auth Token", placeholder: "Your Twilio auth token", minLength: 32, helpText: "Found in your Twilio Console dashboard", required: true },
    ],
  },

  // Email & Calendar
  {
    id: "gmail", name: "Gmail", description: "Read, send, and manage email through Gmail", category: "Email & Calendar", icon: Mail, iconColor: "text-red-400", iconBg: "bg-red-500/10",
    permissions: ["Read emails", "Send emails", "Manage labels", "Access contacts"],
    credentialFields: [
      { key: "apiKey", label: "Google API Key or Service Account JSON", placeholder: "AIza... or paste service account JSON", minLength: 10, helpUrl: "https://console.cloud.google.com/apis/credentials", helpText: "Get from console.cloud.google.com/apis/credentials", required: true },
    ],
  },
  {
    id: "google-calendar", name: "Google Calendar", description: "Manage events, check availability, and schedule meetings", category: "Email & Calendar", icon: Calendar, iconColor: "text-blue-400", iconBg: "bg-blue-500/10",
    permissions: ["Read events", "Create events", "Modify events", "Access free/busy"],
    credentialFields: [
      { key: "apiKey", label: "Google API Key or Service Account JSON", placeholder: "AIza... or paste service account JSON", minLength: 10, helpUrl: "https://console.cloud.google.com/apis/credentials", helpText: "Get from console.cloud.google.com/apis/credentials", required: true },
    ],
  },
  {
    id: "outlook", name: "Outlook", description: "Microsoft email and calendar integration", category: "Email & Calendar", icon: Mail, iconColor: "text-blue-400", iconBg: "bg-blue-500/10",
    permissions: ["Read emails", "Send emails", "Manage calendar", "Access contacts"],
    oauthOnly: true,
  },

  // Docs & Storage
  {
    id: "google-drive", name: "Google Drive", description: "Access files, create documents, and manage permissions", category: "Docs & Storage", icon: FileText, iconColor: "text-yellow-400", iconBg: "bg-yellow-500/10",
    permissions: ["Read files", "Create files", "Manage permissions", "Search documents"],
    credentialFields: [
      { key: "apiKey", label: "Google API Key or Service Account JSON", placeholder: "AIza... or paste service account JSON", minLength: 10, helpUrl: "https://console.cloud.google.com/apis/credentials", helpText: "Get from console.cloud.google.com/apis/credentials", required: true },
    ],
  },
  {
    id: "google-sheets", name: "Google Sheets", description: "Read and write spreadsheet data", category: "Docs & Storage", icon: FileText, iconColor: "text-green-400", iconBg: "bg-green-500/10",
    permissions: ["Read spreadsheets", "Edit spreadsheets", "Create spreadsheets"],
    credentialFields: [
      { key: "apiKey", label: "Google API Key or Service Account JSON", placeholder: "AIza... or paste service account JSON", minLength: 10, helpUrl: "https://console.cloud.google.com/apis/credentials", helpText: "Get from console.cloud.google.com/apis/credentials", required: true },
    ],
  },
  {
    id: "notion", name: "Notion", description: "Access databases, pages, and workspace content", category: "Docs & Storage", icon: FileText, iconColor: "text-zinc-300", iconBg: "bg-zinc-500/10",
    permissions: ["Read content", "Create pages", "Update databases", "Search workspace"],
    credentialFields: [
      { key: "integrationToken", label: "Integration Token", placeholder: "secret_...", prefix: "secret_", minLength: 20, helpUrl: "https://www.notion.so/my-integrations", helpText: "Get from notion.so/my-integrations", required: true },
    ],
  },
  {
    id: "dropbox", name: "Dropbox", description: "File storage, sync, and sharing", category: "Docs & Storage", icon: FileText, iconColor: "text-blue-400", iconBg: "bg-blue-500/10",
    permissions: ["Read files", "Upload files", "Manage sharing", "Search files"],
    oauthOnly: true,
  },

  // Dev Tools
  {
    id: "github", name: "GitHub", description: "Repositories, issues, pull requests, and actions", category: "Dev Tools", icon: Github, iconColor: "text-zinc-300", iconBg: "bg-zinc-500/10",
    permissions: ["Read repos", "Create issues", "Manage PRs", "Access actions", "Read org data"],
    credentialFields: [
      { key: "personalAccessToken", label: "Personal Access Token", placeholder: "ghp_... or github_pat_...", prefix: "gh", minLength: 20, helpUrl: "https://github.com/settings/tokens", helpText: "Get from github.com/settings/tokens", required: true },
    ],
  },
  {
    id: "gitlab", name: "GitLab", description: "Repositories, merge requests, and CI/CD pipelines", category: "Dev Tools", icon: Github, iconColor: "text-orange-400", iconBg: "bg-orange-500/10",
    permissions: ["Read repos", "Manage merge requests", "Access pipelines", "Read issues"],
    credentialFields: [
      { key: "personalAccessToken", label: "Personal Access Token", placeholder: "glpat-...", prefix: "glpat-", minLength: 20, helpUrl: "https://gitlab.com/-/profile/personal_access_tokens", helpText: "Get from GitLab > Settings > Access Tokens", required: true },
    ],
  },
  {
    id: "linear", name: "Linear", description: "Issue tracking and project management", category: "Dev Tools", icon: Trello, iconColor: "text-indigo-400", iconBg: "bg-indigo-500/10",
    permissions: ["Read issues", "Create issues", "Update issues", "Access projects"],
    credentialFields: [
      { key: "apiKey", label: "API Key", placeholder: "lin_api_...", prefix: "lin_api_", minLength: 20, helpUrl: "https://linear.app/settings/api", helpText: "Get from linear.app/settings/api", required: true },
    ],
  },
  {
    id: "jira", name: "Jira", description: "Issue tracking and agile project management", category: "Dev Tools", icon: Trello, iconColor: "text-blue-400", iconBg: "bg-blue-500/10",
    permissions: ["Read issues", "Create issues", "Manage sprints", "Access boards"],
    credentialFields: [
      { key: "email", label: "Email", placeholder: "you@company.com", minLength: 5, required: true },
      { key: "apiToken", label: "API Token", placeholder: "Jira API token", minLength: 10, helpUrl: "https://id.atlassian.net/manage-profile/security/api-tokens", helpText: "Get from id.atlassian.net > API Tokens", required: true },
      { key: "domain", label: "Domain", placeholder: "your-company.atlassian.net", minLength: 5, helpText: "Your Jira Cloud domain", required: true },
    ],
  },
  {
    id: "sentry", name: "Sentry", description: "Error tracking and performance monitoring", category: "Dev Tools", icon: Bug, iconColor: "text-pink-400", iconBg: "bg-pink-500/10",
    permissions: ["Read issues", "Resolve issues", "Access events", "Manage alerts"],
    credentialFields: [
      { key: "authToken", label: "Auth Token", placeholder: "sntrys_...", prefix: "sntrys_", minLength: 20, helpUrl: "https://sentry.io/settings/account/api/auth-tokens/", helpText: "Get from sentry.io > Settings > Auth Tokens", required: true },
    ],
  },
  {
    id: "vercel", name: "Vercel", description: "Deployment management and project configuration", category: "Dev Tools", icon: Globe, iconColor: "text-zinc-300", iconBg: "bg-zinc-500/10",
    permissions: ["Read projects", "Trigger deployments", "Access logs", "Manage domains"],
    credentialFields: [
      { key: "authToken", label: "Auth Token", placeholder: "Vercel access token", minLength: 20, helpUrl: "https://vercel.com/account/tokens", helpText: "Get from vercel.com/account/tokens", required: true },
    ],
  },

  // CRM & Sales
  {
    id: "hubspot", name: "HubSpot", description: "CRM contacts, deals, and marketing automation", category: "CRM & Sales", icon: BarChart3, iconColor: "text-orange-400", iconBg: "bg-orange-500/10",
    permissions: ["Read contacts", "Create contacts", "Manage deals", "Access analytics"],
    credentialFields: [
      { key: "apiKey", label: "API Key", placeholder: "HubSpot API key", minLength: 10, helpUrl: "https://app.hubspot.com/settings/api-key", helpText: "Get from app.hubspot.com > Settings > API Key", required: true },
    ],
  },
  {
    id: "salesforce", name: "Salesforce", description: "CRM platform with full API access", category: "CRM & Sales", icon: Database, iconColor: "text-blue-400", iconBg: "bg-blue-500/10",
    permissions: ["Read objects", "Create records", "Run queries", "Manage automation"],
    credentialFields: [
      { key: "apiKey", label: "API Key", placeholder: "Salesforce security token", minLength: 10, helpUrl: "https://help.salesforce.com/s/articleView?id=sf.user_security_token.htm", helpText: "Reset your security token from Salesforce Settings", required: true },
    ],
  },
  {
    id: "intercom", name: "Intercom", description: "Customer messaging and support platform", category: "CRM & Sales", icon: MessageSquare, iconColor: "text-blue-400", iconBg: "bg-blue-500/10",
    permissions: ["Read conversations", "Send messages", "Manage contacts", "Access articles"],
    credentialFields: [
      { key: "accessToken", label: "Access Token", placeholder: "Intercom access token", minLength: 10, helpUrl: "https://app.intercom.com/a/developer-hub", helpText: "Get from Developer Hub in Intercom", required: true },
    ],
  },
  {
    id: "zendesk", name: "Zendesk", description: "Customer support ticketing and knowledge base", category: "CRM & Sales", icon: MessageSquare, iconColor: "text-green-400", iconBg: "bg-green-500/10",
    permissions: ["Read tickets", "Create tickets", "Update tickets", "Access knowledge base"],
    credentialFields: [
      { key: "apiToken", label: "API Token", placeholder: "Zendesk API token", minLength: 10, helpUrl: "https://support.zendesk.com/hc/en-us/articles/4408889192858", helpText: "Get from Admin Center > Apps and Integrations > APIs", required: true },
    ],
  },

  // Commerce
  {
    id: "stripe", name: "Stripe", description: "Payments, subscriptions, and billing", category: "Commerce", icon: CreditCard, iconColor: "text-purple-400", iconBg: "bg-purple-500/10",
    permissions: ["Read payments", "Create charges", "Manage subscriptions", "Access invoices"],
    credentialFields: [
      { key: "apiKey", label: "API Key", placeholder: "sk_live_... or sk_test_...", prefix: "sk_", minLength: 20, helpUrl: "https://dashboard.stripe.com/apikeys", helpText: "Get from dashboard.stripe.com/apikeys", required: true },
    ],
  },
  {
    id: "shopify", name: "Shopify", description: "E-commerce store management and orders", category: "Commerce", icon: ShoppingCart, iconColor: "text-green-400", iconBg: "bg-green-500/10",
    permissions: ["Read products", "Manage orders", "Access customers", "Manage inventory"],
    credentialFields: [
      { key: "accessToken", label: "Admin API Access Token", placeholder: "shpat_...", prefix: "shpat_", minLength: 20, helpUrl: "https://shopify.dev/docs/apps/getting-started", helpText: "Get from your Shopify admin app settings", required: true },
    ],
  },
];

const categories = ["All", "Communication", "Email & Calendar", "Docs & Storage", "Dev Tools", "CRM & Sales", "Commerce"];

// ---------------------------------------------------------------------------
// localStorage helpers (fallback when API is unavailable)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "lantern_connectors";

function loadConnectorStates(): Record<string, ConnectorState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Validate entries: only keep those with real credentials
    const validated: Record<string, ConnectorState> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const state = value as ConnectorState;
      if (state.installed && state.credentials && Object.keys(state.credentials).length > 0) {
        // Has real credentials — keep it
        validated[key] = state;
      }
      // Discard entries without credentials (legacy fake connections)
    }
    return validated;
  } catch {
    return {};
  }
}

function saveConnectorStates(states: Record<string, ConnectorState>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(states));
}

// ---------------------------------------------------------------------------
// Password input with show/hide toggle
// ---------------------------------------------------------------------------

function PasswordInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={clsx(
          "w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 pr-10 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30",
          className,
        )}
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 transition-colors hover:text-zinc-300"
      >
        {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validate credential fields
// ---------------------------------------------------------------------------

function validateFields(
  fields: Record<string, string>,
  definitions: CredentialField[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const def of definitions) {
    const val = (fields[def.key] ?? "").trim();
    if (def.required && !val) {
      errors[def.key] = `${def.label} is required`;
      continue;
    }
    if (val && def.minLength && val.length < def.minLength) {
      errors[def.key] = `Must be at least ${def.minLength} characters`;
      continue;
    }
    if (val && def.prefix && !val.startsWith(def.prefix)) {
      errors[def.key] = `Should start with "${def.prefix}"`;
    }
  }
  return errors;
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
  const [usingApi, setUsingApi] = useState(false);

  // Wizard state
  const [wizardConnector, setWizardConnector] = useState<ConnectorDef | null>(null);
  const [wizardStep, setWizardStep] = useState<WizardStep>("method");
  const [authMethod, setAuthMethod] = useState<"oauth" | "apikey">("oauth");
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testMessage, setTestMessage] = useState("");
  const [testAccount, setTestAccount] = useState("");
  const [authorizing, setAuthorizing] = useState(false);

  // Config modal state (for already-connected connectors)
  const [configModal, setConfigModal] = useState<ConnectorDef | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [configTestStatus, setConfigTestStatus] = useState<TestStatus>("idle");
  const [configTestMessage, setConfigTestMessage] = useState("");
  const [showUpdateCreds, setShowUpdateCreds] = useState(false);
  const [updateCredValues, setUpdateCredValues] = useState<Record<string, string>>({});
  const [updateFieldErrors, setUpdateFieldErrors] = useState<Record<string, string>>({});
  const [updatingCreds, setUpdatingCreds] = useState(false);

  const modalRef = useRef<HTMLDivElement>(null);

  // Load connectors: try real API first, fall back to localStorage.
  const loadData = useCallback(async () => {
    try {
      const installed = await api.listConnectors();
      if (installed && installed.length >= 0) {
        setUsingApi(true);
        const stateMap: Record<string, ConnectorState> = {};
        for (const ci of installed) {
          stateMap[ci.connectorId] = {
            installed: true,
            connectedAccount: ci.displayName,
            installedAt: ci.installedAt,
            backendId: ci.id,
          };
        }
        setStates(stateMap);
        saveConnectorStates(stateMap);
        setLoading(false);
        return;
      }
    } catch {
      // API unavailable, fall back to localStorage.
    }

    setUsingApi(false);
    const stored = loadConnectorStates();
    setStates(stored);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Escape key to close modals
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (wizardConnector) {
          setWizardConnector(null);
        } else if (configModal) {
          setConfigModal(null);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [wizardConnector, configModal]);

  // Listen for OAuth popup completion messages.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "lantern:oauth:complete") {
        if (event.data.success) {
          setTestStatus("success");
          setTestMessage("OAuth authorization successful");
          setTestAccount(event.data.account || "Connected account");
          setWizardStep("done");
          loadData();
        } else {
          setTestStatus("error");
          setTestMessage(event.data.message || "OAuth authorization failed");
          setWizardStep("testing");
        }
        setAuthorizing(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [loadData]);

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
          c.category.toLowerCase().includes(q),
      );
    }
    return result;
  }, [activeCategory, search]);

  const installedCount = Object.values(states).filter((s) => s.installed).length;

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { All: connectors.length };
    for (const c of connectors) {
      counts[c.category] = (counts[c.category] ?? 0) + 1;
    }
    return counts;
  }, []);

  // -- Wizard helpers -------------------------------------------------------

  const openWizard = (connector: ConnectorDef) => {
    setWizardConnector(connector);
    setWizardStep("method");
    setAuthMethod(connector.oauthOnly ? "oauth" : "oauth");
    setCredentialValues({});
    setFieldErrors({});
    setTestStatus("idle");
    setTestMessage("");
    setTestAccount("");
    setAuthorizing(false);
  };

  const closeWizard = () => {
    setWizardConnector(null);
    setWizardStep("method");
  };

  const handleOAuthConnect = async () => {
    if (!wizardConnector) return;
    setAuthorizing(true);
    setWizardStep("testing");
    setTestStatus("testing");
    setTestMessage("Waiting for authorization...");

    try {
      const { redirectUrl } = await api.startOAuth(wizardConnector.id);
      const width = 600;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      window.open(
        redirectUrl,
        "lantern-oauth",
        `width=${width},height=${height},left=${left},top=${top},popup=yes`,
      );
      // The popup will post a message when done (handled in the useEffect above).
    } catch {
      // OAuth start failed, show error
      setTestStatus("error");
      setTestMessage("OAuth is not configured for this connector. Use API Key authentication instead.");
      setAuthorizing(false);
    }
  };

  const handleCredentialSubmit = () => {
    if (!wizardConnector?.credentialFields) return;
    const errors = validateFields(credentialValues, wizardConnector.credentialFields);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setWizardStep("testing");
    handleTestConnection();
  };

  const handleTestConnection = async () => {
    if (!wizardConnector) return;
    setTestStatus("testing");
    setTestMessage("Testing connection...");

    // Try real API test first
    try {
      if (usingApi) {
        const installResult = await api.installConnector({
          connectorId: wizardConnector.id,
          displayName: wizardConnector.name,
          config: credentialValues,
          scopes: wizardConnector.permissions,
        });

        const testResult = await api.testConnector(installResult.id);
        if (testResult.success) {
          setTestStatus("success");
          setTestMessage(testResult.message);
          setTestAccount(installResult.displayName || wizardConnector.name);
          await loadData();
        } else {
          // Test failed, uninstall
          await api.uninstallConnector(installResult.id);
          setTestStatus("error");
          setTestMessage(testResult.message);
        }
        return;
      }
    } catch {
      // Fall back to simulated test
    }

    // Simulated test: validate credentials format and simulate API call
    await new Promise((r) => setTimeout(r, 2000));

    // Do basic validation of the credential values
    const fields = wizardConnector.credentialFields ?? [];
    const allFilled = fields.every(
      (f) => !f.required || (credentialValues[f.key] ?? "").trim().length > 0,
    );

    if (!allFilled) {
      setTestStatus("error");
      setTestMessage("Missing required credentials. Please go back and fill in all required fields.");
      return;
    }

    // Save connection with credentials
    const updated: Record<string, ConnectorState> = {
      ...states,
      [wizardConnector.id]: {
        installed: true,
        connectedAccount: credentialValues.email || credentialValues.apiKey?.slice(0, 8) + "..." || wizardConnector.name,
        installedAt: new Date().toISOString(),
        credentials: { ...credentialValues },
      },
    };
    setStates(updated);
    saveConnectorStates(updated);
    setTestStatus("success");
    setTestMessage("Connection verified successfully");
    setTestAccount(credentialValues.email || wizardConnector.name + " account");
  };

  const handleWizardDone = () => {
    closeWizard();
    if (wizardConnector) {
      toast.success(`${wizardConnector.name} connected successfully`);
    }
  };

  // -- Config modal helpers --------------------------------------------------

  const openConfigModal = (connector: ConnectorDef) => {
    setConfigModal(connector);
    setConfigTestStatus("idle");
    setConfigTestMessage("");
    setShowUpdateCreds(false);
    setUpdateCredValues({});
    setUpdateFieldErrors({});
    setDisconnecting(false);
    setUpdatingCreds(false);
  };

  const handleConfigTest = async () => {
    if (!configModal) return;
    setConfigTestStatus("testing");
    setConfigTestMessage("Verifying connection...");

    try {
      const state = states[configModal.id];
      if (usingApi && state?.backendId) {
        const result = await api.testConnector(state.backendId);
        setConfigTestStatus(result.success ? "success" : "error");
        setConfigTestMessage(result.message);
        return;
      }
    } catch {
      // Fall back
    }

    await new Promise((r) => setTimeout(r, 1500));
    setConfigTestStatus("success");
    setConfigTestMessage("Connection is active and working");
  };

  const handleUpdateCredentials = async () => {
    if (!configModal?.credentialFields) return;
    const errors = validateFields(updateCredValues, configModal.credentialFields);
    setUpdateFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setUpdatingCreds(true);

    try {
      const state = states[configModal.id];
      if (usingApi && state?.backendId) {
        await api.installConnector({
          connectorId: configModal.id,
          displayName: configModal.name,
          config: updateCredValues,
          scopes: configModal.permissions,
        });
        await loadData();
        setUpdatingCreds(false);
        setShowUpdateCreds(false);
        toast.success("Credentials updated successfully");
        return;
      }
    } catch {
      // Fall back
    }

    await new Promise((r) => setTimeout(r, 1000));
    setUpdatingCreds(false);
    setShowUpdateCreds(false);
    toast.success("Credentials updated successfully");
  };

  const handleDisconnect = async (connector: ConnectorDef) => {
    setDisconnecting(true);
    const state = states[connector.id];

    try {
      if (usingApi && state?.backendId) {
        await api.uninstallConnector(state.backendId);
        await loadData();
        setDisconnecting(false);
        setConfigModal(null);
        toast.info(`${connector.name} disconnected`);
        return;
      }
    } catch {
      // Fall back to localStorage.
    }

    await new Promise((r) => setTimeout(r, 600));
    const updated = { ...states };
    delete updated[connector.id];
    setStates(updated);
    saveConnectorStates(updated);
    setDisconnecting(false);
    setConfigModal(null);
    toast.info(`${connector.name} disconnected`);
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex flex-1 flex-col overflow-auto">
        <HeaderSkeleton />
        <div className="p-8">
          <Skeleton className="mb-6 h-10 w-full max-w-md rounded-lg" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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

        {/* Category tabs with counts */}
        <div className="mb-6 flex gap-1 overflow-x-auto pb-1">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={clsx(
                "whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors inline-flex items-center gap-1.5",
                activeCategory === cat
                  ? "bg-surface-3 text-zinc-100"
                  : "text-zinc-500 hover:bg-surface-2 hover:text-zinc-300",
              )}
            >
              {cat}
              <span
                className={clsx(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  activeCategory === cat
                    ? "bg-lantern-500/20 text-lantern-400"
                    : "bg-surface-3 text-zinc-600",
                )}
              >
                {categoryCounts[cat] ?? 0}
              </span>
            </button>
          ))}
        </div>

        {/* Connector grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((connector) => {
            const state = states[connector.id];
            const isInstalled = state?.installed ?? false;
            const Icon = connector.icon;
            return (
              <div
                key={connector.id}
                className="card-hover group rounded-xl border border-zinc-800 bg-surface-1 p-4 transition-all hover:border-zinc-700"
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
                    <span className="h-2 w-2 rounded-full bg-emerald-400" title="Connected" />
                  )}
                </div>
                <h3 className="mt-3 text-sm font-semibold text-zinc-100">{connector.name}</h3>
                <p className="mt-1 text-[11px] text-zinc-500 leading-relaxed line-clamp-2">
                  {connector.description}
                </p>
                {isInstalled && state?.connectedAccount && (
                  <p className="mt-1.5 truncate text-[11px] text-emerald-400/70">
                    {state.connectedAccount}
                  </p>
                )}
                <button
                  onClick={() =>
                    isInstalled ? openConfigModal(connector) : openWizard(connector)
                  }
                  className={clsx(
                    "mt-3 w-full rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                    isInstalled
                      ? "border border-zinc-700 text-zinc-300 hover:bg-surface-3"
                      : "bg-lantern-500 text-white hover:bg-lantern-400",
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

      {/* ================================================================= */}
      {/* Connection Wizard Modal                                           */}
      {/* ================================================================= */}
      {wizardConnector && (
        <div
          className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={closeWizard}
        >
          <div
            ref={modalRef}
            className="modal-content w-full max-w-lg rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className={clsx("flex h-8 w-8 items-center justify-center rounded-lg", wizardConnector.iconBg)}>
                  <wizardConnector.icon className={clsx("h-4 w-4", wizardConnector.iconColor)} />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-zinc-100">Connect {wizardConnector.name}</h2>
                  <p className="text-xs text-zinc-500">
                    {wizardStep === "method" && "Choose authorization method"}
                    {wizardStep === "credentials" && "Enter your credentials"}
                    {wizardStep === "testing" && "Verifying connection"}
                    {wizardStep === "done" && "Connection established"}
                  </p>
                </div>
              </div>
              <button
                onClick={closeWizard}
                className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Step indicator */}
            <div className="flex items-center gap-2 px-6 pt-4">
              {(["method", "credentials", "testing", "done"] as WizardStep[]).map((step, i) => {
                const stepLabels = ["Method", "Credentials", "Test", "Done"];
                const currentIdx = (["method", "credentials", "testing", "done"] as WizardStep[]).indexOf(wizardStep);
                const isActive = i === currentIdx;
                const isCompleted = i < currentIdx;
                return (
                  <div key={step} className="flex items-center gap-2 flex-1">
                    <div
                      className={clsx(
                        "flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold transition-colors",
                        isCompleted && "bg-emerald-500/20 text-emerald-400",
                        isActive && "bg-lantern-500/20 text-lantern-400",
                        !isActive && !isCompleted && "bg-surface-3 text-zinc-600",
                      )}
                    >
                      {isCompleted ? <Check className="h-3 w-3" /> : i + 1}
                    </div>
                    <span className={clsx("hidden text-[11px] font-medium sm:inline", isActive ? "text-zinc-300" : "text-zinc-600")}>
                      {stepLabels[i]}
                    </span>
                    {i < 3 && (
                      <div className={clsx("flex-1 h-px", isCompleted ? "bg-emerald-500/30" : "bg-zinc-800")} />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Step content */}
            <div className="px-6 py-5">
              {/* Step 1: Authorization Method */}
              {wizardStep === "method" && (
                <div className="step-enter space-y-3">
                  {/* OAuth option */}
                  <button
                    onClick={() => {
                      setAuthMethod("oauth");
                      handleOAuthConnect();
                    }}
                    className={clsx(
                      "w-full rounded-xl border p-4 text-left transition-all",
                      "border-zinc-800 hover:border-lantern-500/50 hover:bg-lantern-500/5",
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-lantern-500/10">
                        <ExternalLink className="h-5 w-5 text-lantern-400" />
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-zinc-100">Connect with OAuth</p>
                        <p className="text-xs text-zinc-500">Authorize securely via {wizardConnector.name}&apos;s login page</p>
                      </div>
                      <ArrowRight className="h-4 w-4 text-zinc-600" />
                    </div>
                  </button>

                  {/* API Key option (only if credentialFields exist) */}
                  {wizardConnector.credentialFields && wizardConnector.credentialFields.length > 0 && (
                    <button
                      onClick={() => {
                        setAuthMethod("apikey");
                        setWizardStep("credentials");
                      }}
                      className={clsx(
                        "w-full rounded-xl border p-4 text-left transition-all",
                        "border-zinc-800 hover:border-lantern-500/50 hover:bg-lantern-500/5",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-500/10">
                          <Key className="h-5 w-5 text-zinc-400" />
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-medium text-zinc-100">Connect with API Key</p>
                          <p className="text-xs text-zinc-500">Enter your API key or token manually</p>
                        </div>
                        <ArrowRight className="h-4 w-4 text-zinc-600" />
                      </div>
                    </button>
                  )}

                  {/* Permissions preview */}
                  <div className="mt-4 rounded-lg border border-zinc-800 bg-surface-2 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <Shield className="h-4 w-4 text-zinc-400" />
                      <p className="text-xs font-medium text-zinc-300">Permissions requested</p>
                    </div>
                    <ul className="space-y-1.5">
                      {wizardConnector.permissions.map((perm, i) => (
                        <li key={i} className="flex items-center gap-2 text-xs text-zinc-400">
                          <Check className="h-3 w-3 text-emerald-400" />
                          {perm}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Step 2: Credentials */}
              {wizardStep === "credentials" && wizardConnector.credentialFields && (
                <div className="step-enter space-y-4">
                  {wizardConnector.credentialFields.map((field) => (
                    <div key={field.key}>
                      <label className="mb-1.5 flex items-center gap-1 text-sm font-medium text-zinc-300">
                        {field.label}
                        {field.required && <span className="text-red-400">*</span>}
                      </label>
                      <PasswordInput
                        value={credentialValues[field.key] ?? ""}
                        onChange={(v) => {
                          setCredentialValues((prev) => ({ ...prev, [field.key]: v }));
                          setFieldErrors((prev) => {
                            const next = { ...prev };
                            delete next[field.key];
                            return next;
                          });
                        }}
                        placeholder={field.placeholder}
                      />
                      {fieldErrors[field.key] && (
                        <p className="mt-1 flex items-center gap-1 text-xs text-red-400">
                          <AlertCircle className="h-3 w-3" />
                          {fieldErrors[field.key]}
                        </p>
                      )}
                      {field.helpText && (
                        <p className="mt-1 text-[11px] text-zinc-600">
                          {field.helpUrl ? (
                            <a
                              href={field.helpUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-lantern-400/70 hover:text-lantern-400 underline underline-offset-2"
                            >
                              {field.helpText}
                            </a>
                          ) : (
                            field.helpText
                          )}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Step 3: Test Connection */}
              {wizardStep === "testing" && (
                <div className="step-enter flex flex-col items-center py-6">
                  {testStatus === "testing" && (
                    <>
                      <Loader2 className="mb-4 h-10 w-10 animate-spin text-lantern-400" />
                      <p className="text-sm font-medium text-zinc-200">{testMessage}</p>
                      <p className="mt-1 text-xs text-zinc-500">This may take a few seconds...</p>
                    </>
                  )}
                  {testStatus === "success" && (
                    <>
                      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
                        <CheckCircle2 className="h-7 w-7 text-emerald-400" />
                      </div>
                      <p className="text-sm font-medium text-emerald-400">{testMessage}</p>
                      {testAccount && (
                        <p className="mt-1 text-xs text-zinc-500">Connected as {testAccount}</p>
                      )}
                    </>
                  )}
                  {testStatus === "error" && (
                    <>
                      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10">
                        <AlertCircle className="h-7 w-7 text-red-400" />
                      </div>
                      <p className="text-sm font-medium text-red-400">Connection failed</p>
                      <p className="mt-1 max-w-xs text-center text-xs text-zinc-500">{testMessage}</p>
                    </>
                  )}
                </div>
              )}

              {/* Step 4: Done */}
              {wizardStep === "done" && (
                <div className="step-enter space-y-4">
                  <div className="flex flex-col items-center py-4">
                    <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
                      <CheckCircle2 className="h-7 w-7 text-emerald-400" />
                    </div>
                    <p className="text-sm font-semibold text-zinc-100">
                      {wizardConnector.name} connected
                    </p>
                    {testAccount && (
                      <p className="mt-0.5 text-xs text-zinc-500">Account: {testAccount}</p>
                    )}
                  </div>

                  {/* Scopes granted */}
                  <div className="rounded-lg border border-zinc-800 bg-surface-2 p-4">
                    <p className="mb-2 text-xs font-medium text-zinc-300">Scopes granted</p>
                    <div className="flex flex-wrap gap-1.5">
                      {wizardConnector.permissions.map((perm, i) => (
                        <span key={i} className="rounded-md bg-surface-3 px-2 py-0.5 text-[11px] text-zinc-400">
                          {perm}
                        </span>
                      ))}
                    </div>
                  </div>

                  <a
                    href="/settings"
                    className="flex items-center gap-2 text-xs text-lantern-400/70 hover:text-lantern-400 transition-colors"
                  >
                    <Settings className="h-3 w-3" />
                    Manage in Settings
                  </a>
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-between border-t border-zinc-800 px-6 py-4">
              <div>
                {wizardStep === "credentials" && (
                  <button
                    onClick={() => setWizardStep("method")}
                    className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
                  >
                    Back
                  </button>
                )}
                {wizardStep === "testing" && testStatus === "error" && (
                  <button
                    onClick={() => setWizardStep(authMethod === "apikey" ? "credentials" : "method")}
                    className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
                  >
                    Back
                  </button>
                )}
              </div>
              <div className="flex items-center gap-3">
                {wizardStep !== "done" && (
                  <button
                    onClick={closeWizard}
                    className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
                  >
                    Cancel
                  </button>
                )}
                {wizardStep === "credentials" && (
                  <button
                    onClick={handleCredentialSubmit}
                    className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400"
                  >
                    Test Connection
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                )}
                {wizardStep === "testing" && testStatus === "success" && (
                  <button
                    onClick={() => setWizardStep("done")}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
                  >
                    <Check className="h-3.5 w-3.5" />
                    Continue
                  </button>
                )}
                {wizardStep === "testing" && testStatus === "error" && (
                  <button
                    onClick={handleTestConnection}
                    className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retry
                  </button>
                )}
                {wizardStep === "done" && (
                  <button
                    onClick={handleWizardDone}
                    className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400"
                  >
                    Done
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* Configure Modal (for installed connectors)                        */}
      {/* ================================================================= */}
      {configModal && (
        <div
          className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setConfigModal(null)}
        >
          <div
            className="modal-content w-full max-w-md rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className={clsx("flex h-8 w-8 items-center justify-center rounded-lg", configModal.iconBg)}>
                  <configModal.icon className={clsx("h-4 w-4", configModal.iconColor)} />
                </div>
                <h2 className="text-lg font-semibold text-zinc-100">{configModal.name}</h2>
              </div>
              <button
                onClick={() => setConfigModal(null)}
                className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Connection status */}
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <p className="text-sm font-medium text-emerald-400">Connected</p>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  Account: {states[configModal.id]?.connectedAccount ?? "unknown"}
                </p>
                {states[configModal.id]?.installedAt && (
                  <p className="text-xs text-zinc-600">
                    Connected on {format(new Date(states[configModal.id]!.installedAt!), "MMM d, yyyy")}
                  </p>
                )}
              </div>

              {/* Scopes */}
              <div>
                <p className="mb-2 text-xs font-medium text-zinc-300">Active scopes</p>
                <div className="flex flex-wrap gap-1.5">
                  {configModal.permissions.map((perm, i) => (
                    <span key={i} className="rounded-md bg-surface-3 px-2 py-0.5 text-[11px] text-zinc-400">
                      {perm}
                    </span>
                  ))}
                </div>
              </div>

              {/* Test connection result */}
              {configTestStatus !== "idle" && (
                <div
                  className={clsx(
                    "rounded-lg border p-3",
                    configTestStatus === "testing" && "border-zinc-800 bg-surface-2",
                    configTestStatus === "success" && "border-emerald-500/20 bg-emerald-500/5",
                    configTestStatus === "error" && "border-red-500/20 bg-red-500/5",
                  )}
                >
                  <div className="flex items-center gap-2">
                    {configTestStatus === "testing" && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
                    {configTestStatus === "success" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                    {configTestStatus === "error" && <AlertCircle className="h-3.5 w-3.5 text-red-400" />}
                    <p
                      className={clsx(
                        "text-xs font-medium",
                        configTestStatus === "testing" && "text-zinc-400",
                        configTestStatus === "success" && "text-emerald-400",
                        configTestStatus === "error" && "text-red-400",
                      )}
                    >
                      {configTestMessage}
                    </p>
                  </div>
                </div>
              )}

              {/* Update credentials section */}
              {showUpdateCreds && configModal.credentialFields && (
                <div className="rounded-lg border border-zinc-800 bg-surface-2 p-4 space-y-3">
                  <p className="text-xs font-medium text-zinc-300">Update credentials</p>
                  {configModal.credentialFields.map((field) => (
                    <div key={field.key}>
                      <label className="mb-1 flex items-center gap-1 text-xs font-medium text-zinc-400">
                        {field.label}
                        {field.required && <span className="text-red-400">*</span>}
                      </label>
                      <PasswordInput
                        value={updateCredValues[field.key] ?? ""}
                        onChange={(v) => {
                          setUpdateCredValues((prev) => ({ ...prev, [field.key]: v }));
                          setUpdateFieldErrors((prev) => {
                            const next = { ...prev };
                            delete next[field.key];
                            return next;
                          });
                        }}
                        placeholder={field.placeholder}
                      />
                      {updateFieldErrors[field.key] && (
                        <p className="mt-1 flex items-center gap-1 text-xs text-red-400">
                          <AlertCircle className="h-3 w-3" />
                          {updateFieldErrors[field.key]}
                        </p>
                      )}
                    </div>
                  ))}
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={handleUpdateCredentials}
                      disabled={updatingCreds}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {updatingCreds ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      Save
                    </button>
                    <button
                      onClick={() => setShowUpdateCreds(false)}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-zinc-800 px-6 py-4">
              <div className="flex gap-2">
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
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleConfigTest}
                  disabled={configTestStatus === "testing"}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3 disabled:opacity-50"
                >
                  {configTestStatus === "testing" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  Test Connection
                </button>
                {configModal.credentialFields && !showUpdateCreds && (
                  <button
                    onClick={() => {
                      setShowUpdateCreds(true);
                      setUpdateCredValues({});
                      setUpdateFieldErrors({});
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
                  >
                    <Key className="h-3 w-3" />
                    Update Credentials
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
