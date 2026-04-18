"use client";

import { useState, useEffect, useCallback } from "react";
import { useModels } from "@/lib/model-context";
import { format } from "date-fns";
import {
  Settings2,
  Key,
  Users,
  CreditCard,
  Cpu,
  Copy,
  Trash2,
  Check,
  Loader2,
  Save,
  ArrowUpRight,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import clsx from "clsx";
// Mock data imports removed — settings start with empty state when API is available
import { ProviderCard, type ProviderStatus } from "@/components/settings/provider-card";
import { ApiKeyModal, type CreatedApiKey } from "@/components/settings/api-key-modal";
import { InviteModal, type InvitedMember } from "@/components/settings/invite-modal";
import { ConfirmDialog } from "@/components/settings/confirm-dialog";
import { api } from "@/lib/api";
import { useToast } from "@/components/settings/toast";
import { PageHeader } from "@/components/page-header";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsed: string;
  status: "active" | "revoked";
}

interface StoredMember {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
  joinedAt: string;
}

interface GeneralSettings {
  workspaceName: string;
  workspaceId: string;
  defaultModel: string;
  defaultIsolation: string;
}

interface ProviderSettings {
  openai: { key: string; status: ProviderStatus };
  anthropic: { key: string; status: ProviderStatus };
  google: { key: string; status: ProviderStatus };
}

interface BillingSettings {
  plan: string;
  budgetLimit: string;
  hardLimit: boolean;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABS = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "providers", label: "LLM Providers", icon: Cpu },
  { id: "team", label: "Team", icon: Users },
  { id: "billing", label: "Billing", icon: CreditCard },
] as const;

type TabId = (typeof TABS)[number]["id"];

// ---------------------------------------------------------------------------
// Local storage
// ---------------------------------------------------------------------------

const LS_PREFIX = "lantern_settings_";

function loadLS<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try { const raw = localStorage.getItem(LS_PREFIX + key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}

function saveLS<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const defaultGeneral: GeneralSettings = { workspaceName: "Acme Corp", workspaceId: "t_acme_01hq3x9k7m", defaultModel: "auto", defaultIsolation: "standard" };
const defaultProviders: ProviderSettings = { openai: { key: "", status: "not_configured" }, anthropic: { key: "", status: "not_configured" }, google: { key: "", status: "not_configured" } };
const defaultBilling: BillingSettings = { plan: "Team", budgetLimit: "100", hardLimit: false };

function defaultApiKeysList(): StoredApiKey[] {
  return [];
}

function defaultMembersList(): StoredMember[] {
  return [];
}

const roleBadgeColors: Record<string, string> = { owner: "bg-lantern-500/10 text-lantern-500", admin: "bg-purple-500/10 text-purple-400", member: "bg-blue-500/10 text-blue-400", viewer: "bg-zinc-500/10 text-zinc-400" };

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const { toast } = useToast();
  const { refresh: refreshModels } = useModels();

  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [general, setGeneral] = useState<GeneralSettings>(defaultGeneral);
  const [generalSaving, setGeneralSaving] = useState(false);
  const [keys, setKeys] = useState<StoredApiKey[]>([]);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<StoredApiKey | null>(null);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderSettings>(defaultProviders);
  const [providersSaving, setProvidersSaving] = useState(false);
  const [members, setMembers] = useState<StoredMember[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<StoredMember | null>(null);
  const [billing, setBilling] = useState<BillingSettings>(defaultBilling);

  // Load from real API with localStorage fallback
  useEffect(() => {
    setGeneral(loadLS("general", defaultGeneral));
    setMembers(loadLS("members", defaultMembersList()));
    setBilling(loadLS("billing", defaultBilling));

    (async () => {
      try {
        const realProviders = await api.listLlmProviders();
        const newState = { ...defaultProviders };
        for (const p of realProviders) {
          const key = p.provider as keyof ProviderSettings;
          if (key in newState) {
            newState[key] = { key: p.keyMasked ?? "", status: p.status === "active" ? "connected" as ProviderStatus : "not_configured" as ProviderStatus };
          }
        }
        setProviders(newState);
      } catch { setProviders(loadLS("providers", defaultProviders)); }
    })();

    (async () => {
      try {
        const realKeys = await api.listApiKeysReal();
        if (realKeys && realKeys.length >= 0) {
          const mapped: StoredApiKey[] = realKeys.map((k) => ({
            id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes ?? [], createdAt: k.createdAt,
            lastUsed: k.lastUsedAt ?? "Never", status: (k.status === "revoked" ? "revoked" : "active") as "active" | "revoked",
          }));
          setKeys(mapped);
          saveLS("api_keys", mapped);
          return;
        }
      } catch { /* API unavailable */ }
      setKeys(loadLS("api_keys", defaultApiKeysList()));
    })();
  }, []);

  // General
  const handleSaveGeneral = async () => {
    setGeneralSaving(true);
    await new Promise((r) => setTimeout(r, 500));
    saveLS("general", general);
    setGeneralSaving(false);
    toast("success", "Workspace settings saved");
  };

  // API Keys
  const handleKeyCreated = async (created: CreatedApiKey) => {
    try {
      const result = await api.createApiKeyReal({ name: created.name, scopes: created.scopes });
      const stored: StoredApiKey = { id: result.key.id, name: result.key.name, prefix: result.key.prefix, scopes: result.key.scopes ?? [], createdAt: result.key.createdAt, lastUsed: "Never", status: "active" };
      const next = [stored, ...keys];
      setKeys(next);
      saveLS("api_keys", next);
      toast("success", `API key "${created.name}" created. Key: ${result.rawKey}`);
      return;
    } catch { /* fall back */ }
    const stored: StoredApiKey = { id: created.id, name: created.name, prefix: created.prefix, scopes: created.scopes, createdAt: created.createdAt.toISOString(), lastUsed: "Never", status: "active" };
    const next = [stored, ...keys];
    setKeys(next);
    saveLS("api_keys", next);
    toast("success", `API key "${created.name}" created`);
  };

  const handleRevokeKey = async () => {
    if (!revokeTarget) return;
    try { await api.revokeApiKeyReal(revokeTarget.id); } catch { /* fall back */ }
    await new Promise((r) => setTimeout(r, 400));
    const next = keys.map((k) => k.id === revokeTarget.id ? { ...k, status: "revoked" as const } : k);
    setKeys(next);
    saveLS("api_keys", next);
    toast("success", `API key "${revokeTarget.name}" revoked`);
    setRevokeTarget(null);
  };

  const handleCopyPrefix = async (key: StoredApiKey) => {
    await navigator.clipboard.writeText(key.prefix + "...");
    setCopiedKeyId(key.id);
    setTimeout(() => setCopiedKeyId(null), 2000);
  };

  // Providers
  const updateProvider = useCallback((provider: keyof ProviderSettings, key: string) => {
    setProviders((prev) => ({ ...prev, [provider]: { ...prev[provider], key, status: key ? prev[provider].status : "not_configured" as ProviderStatus } }));
  }, []);

  const testProvider = useCallback(async (provider: keyof ProviderSettings): Promise<boolean> => {
    const key = providers[provider].key;
    if (!key || key.length < 10) {
      setProviders((prev) => ({ ...prev, [provider]: { ...prev[provider], status: "error" as ProviderStatus } }));
      toast("error", `${provider.charAt(0).toUpperCase() + provider.slice(1)} key is too short`);
      return false;
    }
    try { await api.saveLlmProvider(provider, key); } catch { /* env fallback */ }
    try {
      const result = await api.testLlmProvider(provider);
      setProviders((prev) => ({ ...prev, [provider]: { ...prev[provider], status: result.success ? "connected" as ProviderStatus : "error" as ProviderStatus } }));
      if (result.success) toast("success", result.message || `${provider.charAt(0).toUpperCase() + provider.slice(1)} connected`);
      else toast("error", result.error || `${provider.charAt(0).toUpperCase() + provider.slice(1)} key is invalid`);
      return result.success;
    } catch {
      const success = key.length >= 10;
      setProviders((prev) => ({ ...prev, [provider]: { ...prev[provider], status: success ? "connected" as ProviderStatus : "error" as ProviderStatus } }));
      toast(success ? "success" : "error", success ? `${provider.charAt(0).toUpperCase() + provider.slice(1)} key saved (API unavailable for test)` : "Invalid key");
      return success;
    }
  }, [providers, toast]);

  const handleSaveProviders = async () => {
    setProvidersSaving(true);
    const savePromises: Promise<void>[] = [];
    for (const provider of Object.keys(providers) as Array<keyof ProviderSettings>) {
      const config = providers[provider];
      if (config.key && config.key.length >= 10 && !config.key.includes("****")) {
        savePromises.push(
          api.saveLlmProvider(provider, config.key).then(() => {
            setProviders((prev) => ({ ...prev, [provider]: { ...prev[provider], status: "connected" as ProviderStatus } }));
          }).catch(() => { /* localStorage fallback */ })
        );
      }
    }
    try { await Promise.all(savePromises); } catch { /* some may fail */ }
    saveLS("providers", providers);
    setProvidersSaving(false);
    toast("success", "Provider settings saved");
    refreshModels();
  };

  // Team
  const handleInviteMember = (invited: InvitedMember) => {
    const stored: StoredMember = { id: invited.id, name: invited.name, email: invited.email, role: invited.role, joinedAt: invited.joinedAt.toISOString() };
    const next = [...members, stored];
    setMembers(next);
    saveLS("members", next);
    toast("success", `Invitation sent to ${invited.email}`);
  };

  const handleChangeRole = (memberId: string, newRole: string) => {
    const next = members.map((m) => m.id === memberId ? { ...m, role: newRole as StoredMember["role"] } : m);
    setMembers(next);
    saveLS("members", next);
    toast("success", "Role updated");
  };

  const handleRemoveMember = async () => {
    if (!removeTarget) return;
    await new Promise((r) => setTimeout(r, 400));
    const next = members.filter((m) => m.id !== removeTarget.id);
    setMembers(next);
    saveLS("members", next);
    toast("success", `${removeTarget.name} removed from team`);
    setRemoveTarget(null);
  };

  // Billing
  const handleSetBudget = async () => {
    await new Promise((r) => setTimeout(r, 400));
    saveLS("billing", billing);
    toast("success", `Budget limit set to $${billing.budgetLimit}/month`);
  };

  const handleToggleHardLimit = () => {
    const next = { ...billing, hardLimit: !billing.hardLimit };
    setBilling(next);
    saveLS("billing", next);
    toast("success", next.hardLimit ? "Hard limit enabled" : "Hard limit disabled");
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header */}
      <PageHeader
        title="Settings"
        description="Workspace preferences, API keys, LLM providers, team access, and billing."
      />

      {/* Tab bar */}
      <div className="border-b border-zinc-800 bg-surface-1 px-8">
        <nav className="flex gap-1">
          {TABS.map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={clsx("inline-flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors",
                activeTab === tab.id ? "border-lantern-500 text-lantern-400" : "border-transparent text-zinc-500 hover:text-zinc-300")}>
              <tab.icon className="h-4 w-4" />{tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 p-8">
        {activeTab === "general" && <GeneralTab general={general} setGeneral={setGeneral} saving={generalSaving} onSave={handleSaveGeneral} />}
        {activeTab === "api-keys" && <ApiKeysTab keys={keys} copiedKeyId={copiedKeyId} onCreateClick={() => setShowCreateKey(true)} onCopyPrefix={handleCopyPrefix} onRevokeClick={setRevokeTarget} />}
        {activeTab === "providers" && <ProvidersTab providers={providers} saving={providersSaving} onKeyChange={updateProvider} onTest={testProvider} onSave={handleSaveProviders} />}
        {activeTab === "team" && <TeamTab members={members} onInviteClick={() => setShowInvite(true)} onChangeRole={handleChangeRole} onRemoveClick={setRemoveTarget} />}
        {activeTab === "billing" && <BillingTab billing={billing} setBilling={setBilling} onSetBudget={handleSetBudget} onToggleHardLimit={handleToggleHardLimit} />}
      </div>

      {/* Modals */}
      <ApiKeyModal open={showCreateKey} onClose={() => setShowCreateKey(false)} onCreated={handleKeyCreated} />
      <InviteModal open={showInvite} onClose={() => setShowInvite(false)} onInvited={handleInviteMember} />
      <ConfirmDialog open={!!revokeTarget} title="Revoke API Key" message={`Are you sure you want to revoke "${revokeTarget?.name}"? Any integrations using this key will stop working immediately.`} confirmLabel="Revoke Key" destructive onConfirm={handleRevokeKey} onCancel={() => setRevokeTarget(null)} />
      <ConfirmDialog open={!!removeTarget} title="Remove Team Member" message={`Are you sure you want to remove ${removeTarget?.name} (${removeTarget?.email}) from the team?`} confirmLabel="Remove Member" destructive onConfirm={handleRemoveMember} onCancel={() => setRemoveTarget(null)} />
    </div>
  );
}

// ===========================================================================
// General Tab
// ===========================================================================

function GeneralTab({ general, setGeneral, saving, onSave }: { general: GeneralSettings; setGeneral: (g: GeneralSettings) => void; saving: boolean; onSave: () => void }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="rounded-xl border border-zinc-800 bg-surface-1 p-6">
        <h3 className="mb-4 text-sm font-semibold text-zinc-100">Workspace</h3>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Workspace name</label>
            <input type="text" value={general.workspaceName} onChange={(e) => setGeneral({ ...general, workspaceName: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Workspace ID</label>
            <div className="flex gap-2">
              <input type="text" value={general.workspaceId} readOnly className="flex-1 rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-500 outline-none cursor-default font-mono" />
              <button onClick={() => { navigator.clipboard.writeText(general.workspaceId); }} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-surface-3">
                <Copy className="h-3.5 w-3.5" />Copy
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-surface-1 p-6">
        <h3 className="mb-4 text-sm font-semibold text-zinc-100">Defaults</h3>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Default model preference</label>
            <select value={general.defaultModel} onChange={(e) => setGeneral({ ...general, defaultModel: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30">
              <option value="auto">Auto (recommended)</option>
              <option value="reasoning-large">Reasoning Large</option>
              <option value="reasoning-small">Reasoning Small</option>
              <option value="chat-large">Chat Large</option>
              <option value="chat-small">Chat Small</option>
              <option value="code-large">Code Large</option>
            </select>
            <p className="mt-1 text-xs text-zinc-600">The model router will use this preference unless overridden per-agent.</p>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Default isolation class</label>
            <select value={general.defaultIsolation} onChange={(e) => setGeneral({ ...general, defaultIsolation: e.target.value })}
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30">
              <option value="trusted">Trusted -- runs in shared namespace</option>
              <option value="standard">Standard -- runs in isolated pod</option>
              <option value="untrusted">Untrusted -- runs in microVM (Firecracker)</option>
            </select>
            <p className="mt-1 text-xs text-zinc-600">Untrusted code always runs in a microVM regardless of this setting.</p>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button onClick={onSave} disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed">
          {saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving...</> : <><Save className="h-3.5 w-3.5" />Save Changes</>}
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// API Keys Tab
// ===========================================================================

function ApiKeysTab({ keys, copiedKeyId, onCreateClick, onCopyPrefix, onRevokeClick }: { keys: StoredApiKey[]; copiedKeyId: string | null; onCreateClick: () => void; onCopyPrefix: (key: StoredApiKey) => void; onRevokeClick: (key: StoredApiKey) => void }) {
  const activeKeys = keys.filter((k) => k.status === "active");
  const revokedKeys = keys.filter((k) => k.status === "revoked");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">API Keys</h3>
          <p className="mt-0.5 text-xs text-zinc-500">Manage keys used to authenticate with the Lantern API.</p>
        </div>
        <button onClick={onCreateClick} className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-lantern-400">Create API Key</button>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
        <table className="data-table">
          <thead><tr><th>Name</th><th>Key Prefix</th><th>Scopes</th><th>Created</th><th>Last Used</th><th>Status</th><th className="w-24"></th></tr></thead>
          <tbody>
            {activeKeys.length === 0 && <tr><td colSpan={7} className="text-center text-zinc-500 py-8">No active API keys. Create one to get started.</td></tr>}
            {activeKeys.map((key) => (
              <tr key={key.id}>
                <td className="font-medium text-zinc-300">{key.name}</td>
                <td>
                  <div className="flex items-center gap-1.5">
                    <code className="rounded bg-surface-3 px-2 py-0.5 font-mono text-xs text-zinc-400">{key.prefix}...</code>
                    <button onClick={() => onCopyPrefix(key)} className="text-zinc-600 transition-colors hover:text-zinc-400">
                      {copiedKeyId === key.id ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </td>
                <td><div className="flex flex-wrap gap-1">{key.scopes.map((s) => <span key={s} className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-zinc-500">{s}</span>)}</div></td>
                <td className="text-zinc-500">{format(new Date(key.createdAt), "MMM d, yyyy")}</td>
                <td className="text-zinc-500">{key.lastUsed}</td>
                <td><span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Active</span></td>
                <td><button onClick={() => onRevokeClick(key)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-500/10"><Trash2 className="h-3 w-3" />Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {revokedKeys.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Revoked Keys</h4>
          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1 opacity-60">
            <table className="data-table"><tbody>
              {revokedKeys.map((key) => (
                <tr key={key.id}><td className="font-medium text-zinc-500">{key.name}</td><td><code className="rounded bg-surface-3 px-2 py-0.5 font-mono text-xs text-zinc-600 line-through">{key.prefix}...</code></td><td className="text-zinc-600">Revoked</td></tr>
              ))}
            </tbody></table>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Providers Tab
// ===========================================================================

function ProvidersTab({ providers, saving, onKeyChange, onTest, onSave }: { providers: ProviderSettings; saving: boolean; onKeyChange: (p: keyof ProviderSettings, k: string) => void; onTest: (p: keyof ProviderSettings) => Promise<boolean>; onSave: () => void }) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">LLM Providers</h3>
        <p className="mt-0.5 text-xs text-zinc-500">Configure API keys for LLM providers. The model router maps capability requests to these.</p>
      </div>

      <ProviderCard name="OpenAI" description="GPT-4o, GPT-4, o3, and more" icon={<span className="text-sm font-bold text-emerald-400">AI</span>} apiKey={providers.openai.key} status={providers.openai.status} onApiKeyChange={(k) => onKeyChange("openai", k)} onTest={() => onTest("openai")} />
      <ProviderCard name="Anthropic" description="Claude Opus, Sonnet, Haiku" icon={<span className="text-sm font-bold text-orange-400">A</span>} apiKey={providers.anthropic.key} status={providers.anthropic.status} onApiKeyChange={(k) => onKeyChange("anthropic", k)} onTest={() => onTest("anthropic")} />
      <ProviderCard name="Google AI" description="Gemini Pro, Gemini Ultra" icon={<span className="text-sm font-bold text-blue-400">G</span>} apiKey={providers.google.key} status={providers.google.status} onApiKeyChange={(k) => onKeyChange("google", k)} onTest={() => onTest("google")} />

      <div className="rounded-lg border border-zinc-800 bg-surface-2 px-4 py-3">
        <p className="text-xs text-zinc-500">Keys are encrypted at rest and only decrypted inside the microVM runtime at execution time.</p>
      </div>

      <div className="flex justify-end">
        <button onClick={onSave} disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed">
          {saving ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving...</> : <><Save className="h-3.5 w-3.5" />Save Changes</>}
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Team Tab
// ===========================================================================

function TeamTab({ members, onInviteClick, onChangeRole, onRemoveClick }: { members: StoredMember[]; onInviteClick: () => void; onChangeRole: (id: string, role: string) => void; onRemoveClick: (m: StoredMember) => void }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Team Members</h3>
          <p className="mt-0.5 text-xs text-zinc-500">Manage who has access and their permissions.</p>
        </div>
        <button onClick={onInviteClick} className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3">Invite Member</button>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
        <table className="data-table">
          <thead><tr><th>Member</th><th>Email</th><th>Role</th><th>Joined</th><th className="w-20"></th></tr></thead>
          <tbody>
            {members.length === 0 && <tr><td colSpan={5} className="text-center text-zinc-500 py-8">No team members yet. Invite someone to collaborate on your agents.</td></tr>}
            {members.map((member) => (
              <tr key={member.id}>
                <td>
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-3 text-xs font-medium text-zinc-400">{member.name.split(" ").map((n) => n[0]).join("")}</div>
                    <span className="font-medium text-zinc-200">{member.name}</span>
                  </div>
                </td>
                <td className="text-zinc-400">{member.email}</td>
                <td>
                  {member.role === "owner" ? (
                    <span className={clsx("rounded-full px-2.5 py-0.5 text-xs font-medium", roleBadgeColors[member.role])}>Owner</span>
                  ) : (
                    <select value={member.role} onChange={(e) => onChangeRole(member.id, e.target.value)}
                      className="rounded-lg border border-zinc-700 bg-surface-2 px-2 py-1 text-xs text-zinc-300 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30">
                      <option value="admin">Admin</option><option value="member">Developer</option><option value="viewer">Viewer</option>
                    </select>
                  )}
                </td>
                <td className="text-zinc-500">{format(new Date(member.joinedAt), "MMM d, yyyy")}</td>
                <td>{member.role !== "owner" && <button onClick={() => onRemoveClick(member)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-500/10"><Trash2 className="h-3 w-3" />Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===========================================================================
// Billing Tab
// ===========================================================================

const usageData = [
  { label: "LLM Tokens", used: 2_100_000, limit: 5_000_000, format: (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${(n / 1_000).toFixed(0)}k` },
  { label: "Compute Hours", used: 18.4, limit: 50, format: (n: number) => `${n.toFixed(1)}h` },
  { label: "Runs", used: 348, limit: 1000, format: (n: number) => String(Math.round(n)) },
  { label: "Storage", used: 2.3, limit: 10, format: (n: number) => `${n.toFixed(1)} GB` },
];

const costByAgent = [
  { agent: "research-agent", runs: 142, tokens: "1.2M", cost: "$6.84" },
  { agent: "code-reviewer", runs: 98, tokens: "620k", cost: "$3.21" },
  { agent: "customer-support", runs: 86, tokens: "240k", cost: "$1.58" },
  { agent: "data-pipeline", runs: 22, tokens: "40k", cost: "$0.84" },
];

function BillingTab({ billing, setBilling, onSetBudget, onToggleHardLimit }: { billing: BillingSettings; setBilling: (b: BillingSettings) => void; onSetBudget: () => void; onToggleHardLimit: () => void }) {
  const plans = [
    { name: "Personal", price: "$0/mo", features: ["1 user", "100 runs/mo", "1M tokens/mo"], current: billing.plan === "Personal" },
    { name: "Team", price: "$49/mo", features: ["5 users", "1,000 runs/mo", "5M tokens/mo"], current: billing.plan === "Team" },
    { name: "Enterprise", price: "Custom", features: ["Unlimited users", "Unlimited runs", "Custom limits"], current: billing.plan === "Enterprise" },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Plans */}
      <div>
        <h3 className="mb-4 text-sm font-semibold text-zinc-100">Current Plan</h3>
        <div className="grid grid-cols-3 gap-4">
          {plans.map((plan) => (
            <div key={plan.name} className={clsx("rounded-xl border p-5 transition-colors", plan.current ? "border-lantern-500 bg-lantern-500/5" : "border-zinc-800 bg-surface-1")}>
              <div className="flex items-start justify-between">
                <div><p className="text-sm font-semibold text-zinc-100">{plan.name}</p><p className="mt-0.5 text-lg font-bold text-lantern-400">{plan.price}</p></div>
                {plan.current && <span className="rounded-full bg-lantern-500/10 px-2 py-0.5 text-xs font-medium text-lantern-400">Current</span>}
              </div>
              <ul className="mt-3 space-y-1">{plan.features.map((f) => <li key={f} className="text-xs text-zinc-500">{f}</li>)}</ul>
              {!plan.current && <button className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"><ArrowUpRight className="h-3 w-3" />{plan.name === "Enterprise" ? "Contact Sales" : "Upgrade"}</button>}
            </div>
          ))}
        </div>
      </div>

      {/* Usage */}
      <div>
        <div className="mb-4 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-zinc-100">Usage This Month</h3>
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">Sample data</span>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-surface-1 p-6">
          <div className="grid grid-cols-2 gap-6">
            {usageData.map((item) => {
              const pct = Math.min((item.used / item.limit) * 100, 100);
              return (
                <div key={item.label}>
                  <div className="flex items-baseline justify-between"><p className="text-sm font-medium text-zinc-300">{item.label}</p><p className="text-xs text-zinc-500">{item.format(item.used)} / {item.format(item.limit)}</p></div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-3"><div className={clsx("h-full rounded-full transition-all", pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-lantern-500")} style={{ width: `${pct}%` }} /></div>
                  <p className="mt-1 text-right text-[11px] text-zinc-600">{pct.toFixed(0)}% used</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Cost breakdown */}
      <div>
        <h3 className="mb-4 text-sm font-semibold text-zinc-100">Cost Breakdown by Agent</h3>
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
          <table className="data-table">
            <thead><tr><th>Agent</th><th>Runs</th><th>Tokens</th><th>Cost</th></tr></thead>
            <tbody>
              {costByAgent.map((row) => <tr key={row.agent}><td className="font-medium text-zinc-300">{row.agent}</td><td className="text-zinc-400">{row.runs}</td><td className="text-zinc-400">{row.tokens}</td><td className="font-medium text-zinc-200">{row.cost}</td></tr>)}
              <tr className="border-t border-zinc-700"><td className="font-semibold text-zinc-100">Total</td><td className="text-zinc-400">348</td><td className="text-zinc-400">2.1M</td><td className="font-semibold text-lantern-400">$12.47</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Budget */}
      <div>
        <h3 className="mb-4 text-sm font-semibold text-zinc-100">Budget Controls</h3>
        <div className="rounded-xl border border-zinc-800 bg-surface-1 p-6 space-y-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">Monthly budget limit</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-500">$</span>
                <input type="number" value={billing.budgetLimit} onChange={(e) => setBilling({ ...billing, budgetLimit: e.target.value })}
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 pl-7 pr-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30" />
              </div>
              <button onClick={onSetBudget} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3">Set Budget</button>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-surface-2 px-4 py-3">
            <div><p className="text-sm font-medium text-zinc-200">Hard limit</p><p className="text-xs text-zinc-500">Pause all agents when budget is exceeded.</p></div>
            <button onClick={onToggleHardLimit} className="text-zinc-400 transition-colors hover:text-zinc-200">
              {billing.hardLimit ? <ToggleRight className="h-8 w-8 text-lantern-500" /> : <ToggleLeft className="h-8 w-8" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
