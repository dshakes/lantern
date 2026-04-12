"use client";

import { useState } from "react";
import { X, Copy, AlertTriangle, Loader2, Check } from "lucide-react";

const SCOPE_OPTIONS = [
  { id: "agents:read", label: "Read agents", group: "Agents" },
  { id: "agents:write", label: "Write agents", group: "Agents" },
  { id: "runs:read", label: "Read runs", group: "Runs" },
  { id: "runs:write", label: "Write runs", group: "Runs" },
  { id: "runs:execute", label: "Execute runs", group: "Runs" },
];

const EXPIRY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
];

export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  fullKey: string;
  scopes: string[];
  expiry: string;
  createdAt: Date;
  lastUsed: string;
  status: "active";
}

interface ApiKeyModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (key: CreatedApiKey) => void;
}

export function ApiKeyModal({ open, onClose, onCreated }: ApiKeyModalProps) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["agents:read", "runs:read"]);
  const [expiry, setExpiry] = useState("90");
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const toggleScope = (scope: string) => {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  };

  const handleCreate = async () => {
    if (!name.trim() || scopes.length === 0) return;
    setCreating(true);

    // Simulate API call
    await new Promise((r) => setTimeout(r, 800));

    const randomHex = () =>
      Array.from({ length: 4 }, () =>
        Math.floor(Math.random() * 16).toString(16)
      ).join("");

    const fullKey = `ltn_live_${randomHex()}${randomHex()}${randomHex()}${randomHex()}${randomHex()}${randomHex()}${randomHex()}${randomHex()}`;
    const prefix = `ltn_live_${fullKey.slice(9, 13)}`;

    const key: CreatedApiKey = {
      id: `key_${Date.now()}`,
      name: name.trim(),
      prefix,
      fullKey,
      scopes,
      expiry,
      createdAt: new Date(),
      lastUsed: "Never",
      status: "active",
    };

    setCreatedKey(key);
    setCreating(false);
    onCreated(key);
  };

  const handleCopy = async () => {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey.fullKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClose = () => {
    setName("");
    setScopes(["agents:read", "runs:read"]);
    setExpiry("90");
    setCreatedKey(null);
    setCopied(false);
    onClose();
  };

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={handleClose}>
      <div className="modal-content w-full max-w-lg rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <h2 className="text-lg font-semibold text-zinc-100">
            {createdKey ? "API Key Created" : "Create API Key"}
          </h2>
          <button
            onClick={handleClose}
            className="rounded-lg p-1 text-zinc-500 hover:bg-surface-3 hover:text-zinc-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {createdKey ? (
          /* Key created view */
          <div className="px-6 py-5">
            <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div>
                <p className="text-sm font-medium text-amber-400">
                  Save this key — you won&apos;t see it again
                </p>
                <p className="mt-0.5 text-xs text-amber-400/70">
                  Copy it now and store it in a secure location like a secrets manager.
                </p>
              </div>
            </div>

            <label className="mb-1.5 block text-sm font-medium text-zinc-300">
              Your API key
            </label>
            <div className="flex gap-2">
              <code className="flex-1 rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2.5 font-mono text-xs text-zinc-100 break-all select-all">
                {createdKey.fullKey}
              </code>
              <button
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="text-emerald-400">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </>
                )}
              </button>
            </div>

            <div className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-500">Name</span>
                <span className="text-zinc-300">{createdKey.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Scopes</span>
                <span className="text-zinc-300">{createdKey.scopes.join(", ")}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Expiry</span>
                <span className="text-zinc-300">
                  {EXPIRY_OPTIONS.find((o) => o.value === createdKey.expiry)?.label}
                </span>
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={handleClose}
                className="rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          /* Create form */
          <>
            <div className="space-y-5 px-6 py-5">
              {/* Name */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                  Key name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Production API, CI/CD Pipeline"
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
                />
              </div>

              {/* Scopes */}
              <div>
                <label className="mb-2 block text-sm font-medium text-zinc-300">
                  Scopes
                </label>
                <div className="space-y-2">
                  {SCOPE_OPTIONS.map((scope) => (
                    <label
                      key={scope.id}
                      className="flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800 bg-surface-2 px-3 py-2.5 transition-colors hover:border-zinc-600"
                    >
                      <input
                        type="checkbox"
                        checked={scopes.includes(scope.id)}
                        onChange={() => toggleScope(scope.id)}
                        className="h-4 w-4 rounded border-zinc-600 bg-surface-3 text-lantern-500 accent-lantern-500 focus:ring-lantern-500/30"
                      />
                      <div>
                        <span className="text-sm text-zinc-200">{scope.label}</span>
                        <span className="ml-2 font-mono text-xs text-zinc-500">
                          {scope.id}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Expiry */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                  Expiration
                </label>
                <select
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500"
                >
                  {EXPIRY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
              <button
                onClick={handleClose}
                className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!name.trim() || scopes.length === 0 || creating}
                className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create API Key"
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
