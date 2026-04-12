"use client";

import { useState, useEffect, useCallback } from "react";
import {
  MessageSquare,
  Phone,
  Mail,
  Globe,
  X,
  Check,
  Send,
  Copy,
  ExternalLink,
  Loader2,
  Bot,
} from "lucide-react";
import clsx from "clsx";
import { useToast } from "@/components/toast";
import { HeaderSkeleton, Skeleton } from "@/components/skeleton";
import { WebChatWidget } from "@/components/web-chat-widget";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SurfaceConfig {
  connected: boolean;
  fields: Record<string, string>;
  agentCount: number;
}

interface SurfaceDefinition {
  id: string;
  name: string;
  description: string;
  icon: typeof MessageSquare;
  iconColor: string;
  iconBg: string;
  configFields: { key: string; label: string; type: "text" | "password" | "textarea"; placeholder: string }[];
  hasTestButton?: boolean;
  hasInstallButton?: string;
  hasWebhookButton?: boolean;
  hasEmbedCode?: boolean;
}

// ---------------------------------------------------------------------------
// Surface definitions
// ---------------------------------------------------------------------------

const surfaces: SurfaceDefinition[] = [
  {
    id: "whatsapp",
    name: "WhatsApp",
    description: "WhatsApp Business Cloud API for messaging with agents",
    icon: MessageSquare,
    iconColor: "text-green-400",
    iconBg: "bg-green-500/10",
    configFields: [
      { key: "phoneNumberId", label: "Phone Number ID", type: "text", placeholder: "e.g. 112233445566778" },
      { key: "apiToken", label: "API Token", type: "password", placeholder: "WhatsApp Business API token" },
      { key: "verifyToken", label: "Verify Token", type: "text", placeholder: "Webhook verify token" },
    ],
    hasTestButton: true,
  },
  {
    id: "slack",
    name: "Slack",
    description: "Slack bot with slash commands and Block Kit interactive cards",
    icon: MessageSquare,
    iconColor: "text-purple-400",
    iconBg: "bg-purple-500/10",
    configFields: [
      { key: "botToken", label: "Bot Token", type: "password", placeholder: "xoxb-..." },
      { key: "signingSecret", label: "Signing Secret", type: "password", placeholder: "Slack signing secret" },
      { key: "appId", label: "App ID", type: "text", placeholder: "A0123456789" },
    ],
    hasInstallButton: "Install to Workspace",
  },
  {
    id: "discord",
    name: "Discord",
    description: "Discord bot with slash commands and interactive components",
    icon: MessageSquare,
    iconColor: "text-indigo-400",
    iconBg: "bg-indigo-500/10",
    configFields: [
      { key: "botToken", label: "Bot Token", type: "password", placeholder: "Discord bot token" },
      { key: "publicKey", label: "Public Key", type: "text", placeholder: "Application public key" },
      { key: "applicationId", label: "Application ID", type: "text", placeholder: "Discord application ID" },
    ],
  },
  {
    id: "telegram",
    name: "Telegram",
    description: "Telegram bot with inline buttons and message editing",
    icon: Send,
    iconColor: "text-sky-400",
    iconBg: "bg-sky-500/10",
    configFields: [
      { key: "botToken", label: "Bot Token", type: "password", placeholder: "123456:ABC-DEF1234ghIkl..." },
    ],
    hasWebhookButton: true,
  },
  {
    id: "twilio",
    name: "Twilio (SMS/Voice)",
    description: "Twilio for SMS messaging and voice calls with speech synthesis",
    icon: Phone,
    iconColor: "text-red-400",
    iconBg: "bg-red-500/10",
    configFields: [
      { key: "accountSid", label: "Account SID", type: "text", placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
      { key: "authToken", label: "Auth Token", type: "password", placeholder: "Twilio auth token" },
      { key: "phoneNumber", label: "Phone Number", type: "text", placeholder: "+1234567890" },
    ],
    hasTestButton: true,
  },
  {
    id: "email",
    name: "Email",
    description: "Per-tenant email address for agent communication via SMTP",
    icon: Mail,
    iconColor: "text-amber-400",
    iconBg: "bg-amber-500/10",
    configFields: [
      { key: "tenantEmail", label: "Tenant Email", type: "text", placeholder: "Auto-generated (read-only)" },
      { key: "smtpHost", label: "SMTP Host", type: "text", placeholder: "smtp.example.com" },
      { key: "smtpPort", label: "SMTP Port", type: "text", placeholder: "587" },
      { key: "smtpUser", label: "SMTP Username", type: "text", placeholder: "user@example.com" },
      { key: "smtpPass", label: "SMTP Password", type: "password", placeholder: "SMTP password" },
    ],
  },
  {
    id: "webchat",
    name: "Web Chat",
    description: "Embeddable chat widget for your website with live preview",
    icon: Globe,
    iconColor: "text-lantern-400",
    iconBg: "bg-lantern-500/10",
    configFields: [
      { key: "allowedOrigins", label: "Allowed Origins", type: "textarea", placeholder: "https://example.com\nhttps://app.example.com" },
    ],
    hasEmbedCode: true,
  },
];

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "lantern_surfaces";

function loadSurfaceConfigs(): Record<string, SurfaceConfig> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSurfaceConfigs(configs: Record<string, SurfaceConfig>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function SurfacesPage() {
  const toast = useToast();
  const [configs, setConfigs] = useState<Record<string, SurfaceConfig>>({});
  const [loading, setLoading] = useState(true);
  const [configModal, setConfigModal] = useState<SurfaceDefinition | null>(null);
  const [formFields, setFormFields] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showWebChat, setShowWebChat] = useState(false);

  useEffect(() => {
    const stored = loadSurfaceConfigs();
    setConfigs(stored);
    setLoading(false);
  }, []);

  const openConfig = useCallback((surface: SurfaceDefinition) => {
    const existing = configs[surface.id];
    const fields: Record<string, string> = {};
    surface.configFields.forEach((f) => {
      fields[f.key] = existing?.fields?.[f.key] ?? "";
    });
    // Auto-generate tenant email for email surface
    if (surface.id === "email" && !fields.tenantEmail) {
      fields.tenantEmail = "t_acme.lantern.email";
    }
    setFormFields(fields);
    setConfigModal(surface);
  }, [configs]);

  const handleSave = async () => {
    if (!configModal) return;
    setSaving(true);
    // Simulate API call
    await new Promise((r) => setTimeout(r, 600));
    const updated = {
      ...configs,
      [configModal.id]: {
        connected: true,
        fields: { ...formFields },
        agentCount: configs[configModal.id]?.agentCount ?? Math.floor(Math.random() * 5),
      },
    };
    setConfigs(updated);
    saveSurfaceConfigs(updated);
    setSaving(false);
    setConfigModal(null);
    toast.success(`${configModal.name} configured successfully`);
  };

  const handleDisconnect = async () => {
    if (!configModal) return;
    setSaving(true);
    await new Promise((r) => setTimeout(r, 400));
    const updated = { ...configs };
    delete updated[configModal.id];
    setConfigs(updated);
    saveSurfaceConfigs(updated);
    setSaving(false);
    setConfigModal(null);
    toast.info(`${configModal.name} disconnected`);
  };

  const handleTest = async () => {
    setTesting(true);
    await new Promise((r) => setTimeout(r, 1200));
    setTesting(false);
    toast.success("Test message sent successfully");
  };

  const handleSetWebhook = async () => {
    setTesting(true);
    await new Promise((r) => setTimeout(r, 800));
    setTesting(false);
    toast.success("Webhook URL set successfully");
  };

  const embedCode = `<script src="https://cdn.lantern.run/webchat.js"
  data-tenant="t_acme"
  data-agent="auto"
  data-theme="dark">
</script>`;

  if (loading) {
    return (
      <div className="flex flex-1 flex-col overflow-auto">
        <HeaderSkeleton />
        <div className="grid grid-cols-1 gap-4 p-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
              <Skeleton className="mb-3 h-10 w-10 rounded-xl" />
              <Skeleton className="mb-2 h-5 w-24" />
              <Skeleton className="mb-4 h-4 w-full" />
              <Skeleton className="h-8 w-20 rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <div className="border-b border-zinc-800 bg-surface-1 px-8 py-5">
        <h1 className="text-xl font-semibold text-zinc-100">Surfaces</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Configure how users interact with your agents
        </p>
      </div>

      {/* Surface grid */}
      <div className="flex-1 p-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {surfaces.map((surface) => {
            const config = configs[surface.id];
            const isConnected = config?.connected ?? false;
            const Icon = surface.icon;
            return (
              <div
                key={surface.id}
                className="group rounded-xl border border-zinc-800 bg-surface-1 p-5 transition-all hover:border-zinc-700 hover:bg-surface-1/80"
                style={{
                  backdropFilter: "blur(12px)",
                  background: "linear-gradient(135deg, rgba(15,15,18,0.9), rgba(24,24,27,0.9))",
                }}
              >
                <div className="flex items-start justify-between">
                  <div className={clsx("flex h-10 w-10 items-center justify-center rounded-xl", surface.iconBg)}>
                    <Icon className={clsx("h-5 w-5", surface.iconColor)} />
                  </div>
                  {isConnected ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      Connected
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-500/10 px-2.5 py-0.5 text-xs font-medium text-zinc-500">
                      Not configured
                    </span>
                  )}
                </div>

                <h3 className="mt-3 text-sm font-semibold text-zinc-100">{surface.name}</h3>
                <p className="mt-1 text-xs text-zinc-500 leading-relaxed">{surface.description}</p>

                {isConnected && (
                  <div className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500">
                    <Bot className="h-3 w-3" />
                    {config.agentCount} agent{config.agentCount !== 1 ? "s" : ""} using this surface
                  </div>
                )}

                <div className="mt-4 flex items-center gap-2">
                  <button
                    onClick={() => openConfig(surface)}
                    className={clsx(
                      "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                      isConnected
                        ? "border border-zinc-700 text-zinc-300 hover:bg-surface-3"
                        : "bg-lantern-500 text-white hover:bg-lantern-400"
                    )}
                  >
                    {isConnected ? "Configure" : "Set up"}
                  </button>
                  {surface.id === "webchat" && isConnected && (
                    <button
                      onClick={() => setShowWebChat(!showWebChat)}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
                    >
                      Preview
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Config modal */}
      {configModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className={clsx("flex h-8 w-8 items-center justify-center rounded-lg", configModal.iconBg)}>
                  <configModal.icon className={clsx("h-4 w-4", configModal.iconColor)} />
                </div>
                <h2 className="text-lg font-semibold text-zinc-100">Configure {configModal.name}</h2>
              </div>
              <button
                onClick={() => setConfigModal(null)}
                className="rounded-lg p-1 text-zinc-500 hover:bg-surface-3 hover:text-zinc-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal body */}
            <div className="space-y-4 px-6 py-5">
              {configModal.configFields.map((field) => (
                <div key={field.key}>
                  <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                    {field.label}
                  </label>
                  {field.type === "textarea" ? (
                    <textarea
                      value={formFields[field.key] ?? ""}
                      onChange={(e) => setFormFields({ ...formFields, [field.key]: e.target.value })}
                      placeholder={field.placeholder}
                      rows={3}
                      className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30 resize-none"
                    />
                  ) : (
                    <input
                      type={field.type}
                      value={formFields[field.key] ?? ""}
                      onChange={(e) => setFormFields({ ...formFields, [field.key]: e.target.value })}
                      placeholder={field.placeholder}
                      readOnly={field.key === "tenantEmail"}
                      className={clsx(
                        "w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30",
                        field.key === "tenantEmail" && "cursor-not-allowed opacity-70"
                      )}
                    />
                  )}
                </div>
              ))}

              {/* Embed code for web chat */}
              {configModal.hasEmbedCode && (
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                    Embed Code
                  </label>
                  <div className="relative">
                    <pre className="rounded-lg border border-zinc-700 bg-surface-2 p-3 text-xs text-zinc-400 font-mono overflow-x-auto">
                      {embedCode}
                    </pre>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(embedCode);
                        toast.success("Embed code copied to clipboard");
                      }}
                      className="absolute right-2 top-2 rounded-md bg-surface-3 p-1.5 text-zinc-400 hover:text-zinc-200"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-between border-t border-zinc-800 px-6 py-4">
              <div className="flex gap-2">
                {configs[configModal.id]?.connected && (
                  <button
                    onClick={handleDisconnect}
                    disabled={saving}
                    className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                )}
                {configModal.hasTestButton && configs[configModal.id]?.connected && (
                  <button
                    onClick={handleTest}
                    disabled={testing}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3 disabled:opacity-50"
                  >
                    {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                    Test message
                  </button>
                )}
                {configModal.hasInstallButton && !configs[configModal.id]?.connected && (
                  <button
                    onClick={() => toast.info("OAuth flow would open here")}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {configModal.hasInstallButton}
                  </button>
                )}
                {configModal.hasWebhookButton && (
                  <button
                    onClick={handleSetWebhook}
                    disabled={testing}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3 disabled:opacity-50"
                  >
                    {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Globe className="h-3 w-3" />}
                    Set webhook
                  </button>
                )}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setConfigModal(null)}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      Save
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Web chat preview */}
      {showWebChat && <WebChatWidget onClose={() => setShowWebChat(false)} />}
    </div>
  );
}
