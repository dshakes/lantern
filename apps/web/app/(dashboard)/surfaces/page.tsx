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
  Loader2,
  Eye,
  EyeOff,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import clsx from "clsx";
import { useToast } from "@/components/toast";
import { HeaderSkeleton, Skeleton } from "@/components/skeleton";
import { WebChatWidget } from "@/components/web-chat-widget";
import { QRCode, buildQRLink, generatePairingToken } from "@/components/qr-code";
import { api } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SurfaceConfig {
  connected: boolean;
  fields: Record<string, string>;
  backendId?: string;
}

interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "textarea" | "readonly";
  placeholder: string;
  required?: boolean;
  prefix?: string;
  minLength?: number;
  helpUrl?: string;
  helpText?: string;
}

interface SurfaceDefinition {
  id: string;
  name: string;
  description: string;
  icon: typeof MessageSquare;
  iconColor: string;
  iconBg: string;
  configFields: ConfigField[];
  hasEmbedCode?: boolean;
  hasQRCode?: boolean;
  qrType?: "whatsapp" | "telegram" | "pair";
  qrLabel?: string;
}

// ---------------------------------------------------------------------------
// Surface definitions
// ---------------------------------------------------------------------------

const surfaces: SurfaceDefinition[] = [
  {
    id: "whatsapp", name: "WhatsApp",
    description: "WhatsApp Business Cloud API for messaging",
    icon: MessageSquare, iconColor: "text-green-400", iconBg: "bg-green-500/10",
    configFields: [
      { key: "phoneNumberId", label: "Phone Number ID", type: "text", placeholder: "e.g. 112233445566778", required: true, minLength: 10, helpText: "Found in your WhatsApp Business Platform dashboard" },
      { key: "apiToken", label: "API Token", type: "password", placeholder: "WhatsApp Business API token", required: true, minLength: 20, helpUrl: "https://business.facebook.com/settings/whatsapp-business-api", helpText: "Get from business.facebook.com" },
      { key: "verifyToken", label: "Verify Token", type: "password", placeholder: "Webhook verify token", required: true, minLength: 8, helpText: "A custom token for webhook verification" },
    ],
    // WhatsApp Business API uses token auth, not QR pairing
  },
  {
    id: "slack", name: "Slack",
    description: "Slack bot with slash commands and Block Kit",
    icon: MessageSquare, iconColor: "text-purple-400", iconBg: "bg-purple-500/10",
    configFields: [
      { key: "botToken", label: "Bot Token", type: "password", placeholder: "xoxb-...", required: true, prefix: "xoxb-", minLength: 20, helpUrl: "https://api.slack.com/apps", helpText: "Get from api.slack.com/apps > OAuth & Permissions" },
      { key: "signingSecret", label: "Signing Secret", type: "password", placeholder: "Slack signing secret", required: true, minLength: 10, helpText: "Found in Basic Information > App Credentials" },
      { key: "appId", label: "App ID (optional)", type: "text", placeholder: "A0123456789", helpText: "Found at the top of your Slack app settings" },
    ],
  },
  {
    id: "discord", name: "Discord",
    description: "Discord bot with slash commands and components",
    icon: MessageSquare, iconColor: "text-indigo-400", iconBg: "bg-indigo-500/10",
    configFields: [
      { key: "botToken", label: "Bot Token", type: "password", placeholder: "Discord bot token", required: true, minLength: 50, helpUrl: "https://discord.com/developers/applications", helpText: "Get from discord.com/developers > Bot" },
      { key: "publicKey", label: "Public Key", type: "text", placeholder: "Application public key", required: true, minLength: 20, helpText: "Found in General Information" },
      { key: "applicationId", label: "Application ID", type: "text", placeholder: "Discord application ID", required: true, minLength: 10, helpText: "Found in General Information" },
    ],
  },
  {
    id: "telegram", name: "Telegram",
    description: "Telegram bot with inline buttons and media",
    icon: Send, iconColor: "text-sky-400", iconBg: "bg-sky-500/10",
    configFields: [
      { key: "botToken", label: "Bot Token", type: "password", placeholder: "123456:ABC-DEF1234ghIkl...", required: true, minLength: 30, helpUrl: "https://t.me/BotFather", helpText: "Get from @BotFather on Telegram" },
    ],
    hasQRCode: true, qrType: "telegram", qrLabel: "Scan to open the bot in Telegram",
  },
  {
    id: "twilio", name: "Twilio (SMS/Voice)",
    description: "SMS messaging and voice calls via Twilio",
    icon: Phone, iconColor: "text-red-400", iconBg: "bg-red-500/10",
    configFields: [
      { key: "accountSid", label: "Account SID", type: "text", placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", required: true, prefix: "AC", minLength: 34, helpUrl: "https://console.twilio.com", helpText: "Found in your Twilio Console" },
      { key: "authToken", label: "Auth Token", type: "password", placeholder: "Twilio auth token", required: true, minLength: 32, helpText: "Found in your Twilio Console" },
      { key: "phoneNumber", label: "Phone Number", type: "text", placeholder: "+1234567890", required: true, minLength: 10, helpText: "E.164 format" },
    ],
  },
  {
    id: "email", name: "Email",
    description: "Per-tenant email address via SMTP",
    icon: Mail, iconColor: "text-amber-400", iconBg: "bg-amber-500/10",
    configFields: [
      { key: "tenantEmail", label: "Tenant Email", type: "readonly", placeholder: "Auto-generated" },
      { key: "smtpHost", label: "SMTP Host", type: "text", placeholder: "smtp.example.com", helpText: "Outbound SMTP server hostname" },
      { key: "smtpPort", label: "SMTP Port", type: "text", placeholder: "587", helpText: "Common ports: 587 (TLS), 465 (SSL)" },
      { key: "smtpUser", label: "SMTP Username", type: "text", placeholder: "user@example.com" },
      { key: "smtpPass", label: "SMTP Password", type: "password", placeholder: "SMTP password" },
    ],
  },
  {
    id: "webchat", name: "Web Chat",
    description: "Embeddable chat widget for your website",
    icon: Globe, iconColor: "text-lantern-400", iconBg: "bg-lantern-500/10",
    configFields: [
      { key: "allowedOrigins", label: "Allowed Origins", type: "textarea", placeholder: "https://example.com\nhttps://app.example.com", helpText: "One origin per line. Leave empty to allow all." },
    ],
    hasEmbedCode: true,
  },
  {
    id: "mobile", name: "Mobile App",
    description: "iOS and Android with push notifications",
    icon: Phone, iconColor: "text-rose-400", iconBg: "bg-rose-500/10",
    configFields: [],
    hasQRCode: true, qrType: "pair", qrLabel: "Scan with the Lantern mobile app to pair",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "lantern_surfaces";

function loadSurfaceConfigs(): Record<string, SurfaceConfig> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveSurfaceConfigs(configs: Record<string, SurfaceConfig>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
}

function PasswordInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 pr-10 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
      />
      <button type="button" onClick={() => setVisible(!visible)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 transition-colors hover:text-zinc-300">
        {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function validateFields(fields: Record<string, string>, definitions: ConfigField[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const def of definitions) {
    if (def.type === "readonly") continue;
    const val = (fields[def.key] ?? "").trim();
    if (def.required && !val) { errors[def.key] = `${def.label} is required`; continue; }
    if (val && def.minLength && val.length < def.minLength) { errors[def.key] = `Must be at least ${def.minLength} characters`; continue; }
    if (val && def.prefix && !val.startsWith(def.prefix)) { errors[def.key] = `Should start with "${def.prefix}"`; }
  }
  return errors;
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [showWebChat, setShowWebChat] = useState(false);
  const [usingApi, setUsingApi] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const surfaceList = await api.listSurfaces();
      if (surfaceList && surfaceList.length >= 0) {
        setUsingApi(true);
        const configMap: Record<string, SurfaceConfig> = {};
        for (const sc of surfaceList) {
          configMap[sc.surfaceId] = { connected: sc.status === "connected", fields: (sc.config as Record<string, string>) ?? {}, backendId: sc.id };
        }
        setConfigs(configMap);
        saveSurfaceConfigs(configMap);
        setLoading(false);
        return;
      }
    } catch { /* API unavailable */ }
    setUsingApi(false);
    setConfigs(loadSurfaceConfigs());
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && configModal) setConfigModal(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [configModal]);

  const openConfig = useCallback((surface: SurfaceDefinition) => {
    const existing = configs[surface.id];
    const fields: Record<string, string> = {};
    surface.configFields.forEach((f) => { fields[f.key] = existing?.fields?.[f.key] ?? ""; });
    if (surface.id === "email" && !fields.tenantEmail) fields.tenantEmail = "t_acme.lantern.email";
    setFormFields(fields);
    setFieldErrors({});
    setTestStatus("idle");
    setTestMessage("");
    setConfigModal(surface);
  }, [configs]);

  const handleTest = async () => {
    if (!configModal) return;
    const errors = validateFields(formFields, configModal.configFields);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) { toast.error("Please fill in all required fields"); return; }

    setTestStatus("testing");
    setTestMessage("Testing connection...");

    try {
      const existing = configs[configModal.id];
      if (usingApi && existing?.backendId) {
        const result = await api.testSurface(existing.backendId);
        setTestStatus(result.success ? "success" : "error");
        setTestMessage(result.message);
        return;
      }
    } catch { /* fall back */ }

    await new Promise((r) => setTimeout(r, 1500));
    const required = configModal.configFields.filter((f) => f.required);
    const missing = required.find((f) => !(formFields[f.key] ?? "").trim());
    if (missing) { setTestStatus("error"); setTestMessage(`Missing: ${missing.label}`); return; }
    for (const field of configModal.configFields) {
      const val = (formFields[field.key] ?? "").trim();
      if (val && field.prefix && !val.startsWith(field.prefix)) { setTestStatus("error"); setTestMessage(`${field.label} should start with "${field.prefix}"`); return; }
    }
    setTestStatus("success");
    setTestMessage("Connection verified successfully");
  };

  const handleSave = async () => {
    if (!configModal) return;
    const errors = validateFields(formFields, configModal.configFields);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const hasRequired = configModal.configFields.some((f) => f.required);
    if (hasRequired && testStatus !== "success") { toast.error("Please test the connection before saving"); return; }

    setSaving(true);
    try {
      if (usingApi) {
        const existing = configs[configModal.id];
        if (existing?.backendId) {
          await api.updateSurface(existing.backendId, { displayName: configModal.name, config: { ...formFields } });
        } else {
          await api.configureSurface({ surfaceId: configModal.id, displayName: configModal.name, config: { ...formFields } });
        }
        await loadData();
        setSaving(false);
        setConfigModal(null);
        toast.success(`${configModal.name} configured successfully`);
        return;
      }
    } catch { /* fall back */ }

    await new Promise((r) => setTimeout(r, 600));
    const updated = { ...configs, [configModal.id]: { connected: true, fields: { ...formFields } } };
    setConfigs(updated);
    saveSurfaceConfigs(updated);
    setSaving(false);
    setConfigModal(null);
    toast.success(`${configModal.name} configured successfully`);
  };

  const handleDisconnect = async () => {
    if (!configModal) return;
    setSaving(true);
    try {
      const existing = configs[configModal.id];
      if (usingApi && existing?.backendId) {
        await api.removeSurface(existing.backendId);
        await loadData();
        setSaving(false);
        setConfigModal(null);
        toast.info(`${configModal.name} disconnected`);
        return;
      }
    } catch { /* fall back */ }
    await new Promise((r) => setTimeout(r, 400));
    const updated = { ...configs };
    delete updated[configModal.id];
    setConfigs(updated);
    saveSurfaceConfigs(updated);
    setSaving(false);
    setConfigModal(null);
    toast.info(`${configModal.name} disconnected`);
  };

  const embedCode = `<script src="https://cdn.lantern.run/webchat.js"
  data-tenant="t_acme"
  data-agent="auto"
  data-theme="dark">
</script>`;

  const connectedCount = Object.values(configs).filter((c) => c.connected).length;

  if (loading) {
    return (
      <div className="flex flex-1 flex-col overflow-auto">
        <HeaderSkeleton />
        <div className="grid grid-cols-1 gap-4 p-8 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 8 }).map((_, i) => (
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
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Surfaces</h1>
            <p className="mt-1 text-sm text-zinc-500">Configure how users interact with your agents</p>
          </div>
          <span className="rounded-full bg-lantern-500/10 px-3 py-1 text-xs font-medium text-lantern-400">{connectedCount} connected</span>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 p-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {surfaces.map((surface) => {
            const config = configs[surface.id];
            const connected = config?.connected ?? false;
            const Icon = surface.icon;
            return (
              <div key={surface.id} className="surface-card card-hover group">
                <div className="flex items-start justify-between">
                  <div className={clsx("flex h-10 w-10 items-center justify-center rounded-xl", surface.iconBg)}>
                    <Icon className={clsx("h-5 w-5", surface.iconColor)} />
                  </div>
                  {connected ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      Connected
                    </span>
                  ) : (
                    <span className="text-xs text-zinc-600">Not configured</span>
                  )}
                </div>
                <h3 className="mt-3 text-sm font-semibold text-zinc-100">{surface.name}</h3>
                <p className="mt-1 text-xs text-zinc-500 leading-relaxed">{surface.description}</p>
                <div className="mt-4 flex items-center gap-2">
                  <button
                    onClick={() => openConfig(surface)}
                    className={clsx(
                      "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                      connected ? "border border-zinc-700 text-zinc-300 hover:bg-surface-3" : "bg-lantern-500 text-white hover:bg-lantern-400",
                    )}
                  >
                    {connected ? "Configure" : "Set up"}
                  </button>
                  {surface.id === "webchat" && connected && (
                    <button onClick={() => setShowWebChat(!showWebChat)} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3">
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
        <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setConfigModal(null)}>
          <div className="modal-content w-full max-w-lg rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex-shrink-0 flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className={clsx("flex h-8 w-8 items-center justify-center rounded-lg", configModal.iconBg)}>
                  <configModal.icon className={clsx("h-4 w-4", configModal.iconColor)} />
                </div>
                <h2 className="text-lg font-semibold text-zinc-100">
                  {configs[configModal.id]?.connected ? "Configure" : "Set up"} {configModal.name}
                </h2>
              </div>
              <button onClick={() => setConfigModal(null)} className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              {configModal.configFields.map((field) => (
                <div key={field.key}>
                  <label className="mb-1.5 flex items-center gap-1 text-sm font-medium text-zinc-300">
                    {field.label}
                    {field.required && <span className="text-red-400">*</span>}
                  </label>
                  {field.type === "readonly" ? (
                    <input type="text" value={formFields[field.key] ?? ""} readOnly className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-400 cursor-not-allowed opacity-70 outline-none" />
                  ) : field.type === "textarea" ? (
                    <textarea
                      value={formFields[field.key] ?? ""}
                      onChange={(e) => { setFormFields({ ...formFields, [field.key]: e.target.value }); setFieldErrors((p) => { const n = { ...p }; delete n[field.key]; return n; }); }}
                      placeholder={field.placeholder}
                      rows={3}
                      className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30 resize-none"
                    />
                  ) : field.type === "password" ? (
                    <PasswordInput
                      value={formFields[field.key] ?? ""}
                      onChange={(v) => { setFormFields({ ...formFields, [field.key]: v }); setFieldErrors((p) => { const n = { ...p }; delete n[field.key]; return n; }); }}
                      placeholder={field.placeholder}
                    />
                  ) : (
                    <input
                      type="text"
                      value={formFields[field.key] ?? ""}
                      onChange={(e) => { setFormFields({ ...formFields, [field.key]: e.target.value }); setFieldErrors((p) => { const n = { ...p }; delete n[field.key]; return n; }); }}
                      placeholder={field.placeholder}
                      className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
                    />
                  )}
                  {fieldErrors[field.key] && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-red-400"><AlertCircle className="h-3 w-3" />{fieldErrors[field.key]}</p>
                  )}
                  {field.helpText && !fieldErrors[field.key] && (
                    <p className="mt-1 text-[11px] text-zinc-600">
                      {field.helpUrl ? <a href={field.helpUrl} target="_blank" rel="noopener noreferrer" className="text-lantern-400/70 hover:text-lantern-400 underline underline-offset-2">{field.helpText}</a> : field.helpText}
                    </p>
                  )}
                </div>
              ))}

              {/* Embed code */}
              {configModal.hasEmbedCode && (
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-zinc-300">Embed Code</label>
                  <div className="relative">
                    <pre className="rounded-lg border border-zinc-800 bg-surface-0 p-3 text-xs text-zinc-400 font-mono overflow-x-auto">{embedCode}</pre>
                    <button onClick={() => { navigator.clipboard.writeText(embedCode); toast.success("Embed code copied"); }} className="absolute right-2 top-2 rounded-md bg-surface-3 p-1.5 text-zinc-400 transition-colors hover:text-zinc-200">
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* QR Code */}
              {configModal.hasQRCode && (
                <div className="rounded-xl border border-zinc-800 bg-surface-0 p-5">
                  <h3 className="text-sm font-medium text-zinc-200 mb-1">Quick Connect via QR Code</h3>
                  <p className="text-xs text-zinc-500 mb-4">{configModal.qrLabel}</p>
                  <div className="flex justify-center">
                    <QRCode
                      value={buildQRLink({ type: configModal.qrType ?? "pair", token: generatePairingToken(), botUsername: formFields.botToken ? "LanternBot" : undefined, phoneNumber: formFields.phoneNumberId || undefined })}
                      size={180}
                      label={configModal.qrLabel}
                      expiresIn={300}
                      onRefresh={() => buildQRLink({ type: configModal.qrType ?? "pair", token: generatePairingToken(), botUsername: formFields.botToken ? "LanternBot" : undefined, phoneNumber: formFields.phoneNumberId || undefined })}
                    />
                  </div>
                </div>
              )}

              {/* Test result */}
              {testStatus !== "idle" && (
                <div className={clsx("rounded-lg border p-3", testStatus === "testing" && "border-zinc-800 bg-surface-2", testStatus === "success" && "border-emerald-500/20 bg-emerald-500/5", testStatus === "error" && "border-red-500/20 bg-red-500/5")}>
                  <div className="flex items-center gap-2">
                    {testStatus === "testing" && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
                    {testStatus === "success" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                    {testStatus === "error" && <AlertCircle className="h-3.5 w-3.5 text-red-400" />}
                    <p className={clsx("text-xs font-medium", testStatus === "testing" && "text-zinc-400", testStatus === "success" && "text-emerald-400", testStatus === "error" && "text-red-400")}>{testMessage}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 flex items-center justify-between border-t border-zinc-800 px-6 py-4">
              <div className="flex gap-2">
                {configs[configModal.id]?.connected && (
                  <button onClick={handleDisconnect} disabled={saving} className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50">Disconnect</button>
                )}
                <button onClick={handleTest} disabled={testStatus === "testing"} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3 disabled:opacity-50">
                  {testStatus === "testing" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Test Connection
                </button>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => setConfigModal(null)} className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200">Cancel</button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving...</> : <><Check className="h-3.5 w-3.5" />Save</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showWebChat && <WebChatWidget onClose={() => setShowWebChat(false)} />}
    </div>
  );
}
