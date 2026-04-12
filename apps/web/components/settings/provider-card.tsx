"use client";

import { useState } from "react";
import { Eye, EyeOff, Loader2, CheckCircle2, XCircle, Circle } from "lucide-react";
import clsx from "clsx";

export type ProviderStatus = "connected" | "not_configured" | "error";

interface ProviderCardProps {
  name: string;
  description: string;
  icon: React.ReactNode;
  apiKey: string;
  status: ProviderStatus;
  onApiKeyChange: (key: string) => void;
  onTest: () => Promise<boolean>;
}

export function ProviderCard({
  name,
  description,
  icon,
  apiKey,
  status,
  onApiKeyChange,
  onTest,
}: ProviderCardProps) {
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    await onTest();
    setTesting(false);
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-3">
            {icon}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">{name}</h3>
            <p className="text-xs text-zinc-500">{description}</p>
          </div>
        </div>
        <StatusIndicator status={status} />
      </div>

      <div className="mt-4 flex gap-2">
        <div className="relative flex-1">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={`Enter ${name} API key`}
            className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 pr-10 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30 font-mono"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <button
          onClick={handleTest}
          disabled={!apiKey.trim() || testing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {testing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Testing...
            </>
          ) : (
            "Test Connection"
          )}
        </button>
      </div>
    </div>
  );
}

function StatusIndicator({ status }: { status: ProviderStatus }) {
  return (
    <div
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        status === "connected" && "bg-emerald-500/10 text-emerald-400",
        status === "not_configured" && "bg-zinc-500/10 text-zinc-400",
        status === "error" && "bg-red-500/10 text-red-400"
      )}
    >
      {status === "connected" && <CheckCircle2 className="h-3 w-3" />}
      {status === "not_configured" && <Circle className="h-3 w-3" />}
      {status === "error" && <XCircle className="h-3 w-3" />}
      {status === "connected" && "Connected"}
      {status === "not_configured" && "Not configured"}
      {status === "error" && "Error"}
    </div>
  );
}
