"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import React from "react";
import { api } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfiguredProvider {
  provider: string;
  status: string;
  keyMasked: string;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Model capability names used by the router. */
export type ModelCapability =
  | "auto"
  | "reasoning-frontier"
  | "reasoning-large"
  | "reasoning-small"
  | "chat-large"
  | "chat-small"
  | "code-large"
  | "vision-large";

export interface ModelOption {
  value: ModelCapability;
  label: string;
  /** Whether this model requires at least one configured provider to function. */
  requiresProvider: boolean;
}

/** All capabilities the platform knows about. */
export const ALL_MODELS: ModelOption[] = [
  { value: "auto", label: "Auto (recommended)", requiresProvider: true },
  { value: "reasoning-frontier", label: "Reasoning Frontier — Claude Opus 4", requiresProvider: true },
  { value: "reasoning-large", label: "Reasoning Large — Claude Sonnet 4", requiresProvider: true },
  { value: "reasoning-small", label: "Reasoning Small — Claude Haiku 4", requiresProvider: true },
  { value: "chat-large", label: "Chat Large — GPT-4o", requiresProvider: true },
  { value: "chat-small", label: "Chat Small — GPT-4o Mini", requiresProvider: true },
  { value: "code-large", label: "Code Large — Claude Sonnet 4", requiresProvider: true },
  { value: "vision-large", label: "Vision Large — Gemini 2.5 Pro", requiresProvider: true },
];

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ModelContextValue {
  /** Configured LLM providers loaded from the API. */
  providers: ConfiguredProvider[];
  /** The user's default model preference. */
  defaultModel: string;
  /** True when at least one provider has a valid key. */
  isConfigured: boolean;
  /** True while the initial fetch is in-flight. */
  loading: boolean;
  /** Available models based on configured providers. */
  availableModels: ModelOption[];
  /** Set the default model preference. */
  setDefaultModel: (model: string) => void;
  /** Reload providers from the API. */
  refresh: () => void;
}

const ModelContext = createContext<ModelContextValue | null>(null);

export function useModels(): ModelContextValue {
  const ctx = useContext(ModelContext);
  if (!ctx) {
    throw new Error("useModels must be used inside <ModelProvider>");
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ModelProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [defaultModel, setDefaultModel] = useState("auto");

  const fetchProviders = useCallback(async () => {
    try {
      const data = await api.listLlmProviders();
      if (data && data.length > 0) {
        setProviders(data);
        setLoading(false);
        return;
      }
    } catch {
      // API unavailable — fall through to localStorage
    }
    // Fallback: read from localStorage (Settings page saves here)
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem("lantern_settings_providers") : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        const localProviders: ConfiguredProvider[] = Object.entries(parsed)
          .filter(([, v]: [string, any]) => v.key && v.key.length > 10)
          .map(([k, v]: [string, any]) => ({
            provider: k,
            status: v.status === "connected" ? "active" : v.status || "active",
            keyMasked: v.key ? `${v.key.slice(0, 6)}****` : "",
            source: "local",
          }));
        setProviders(localProviders);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  // Also check localStorage as fallback (Settings page saves there when API is down)
  const localConfigured = typeof window !== "undefined" && (() => {
    try {
      const raw = localStorage.getItem("lantern_settings_providers");
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return Object.values(parsed).some((p: any) => p.key && p.key.length > 10 && !p.key.includes("****"));
    } catch { return false; }
  })();

  const isConfigured = providers.some(
    (p) => p.status === "configured" || p.status === "active" || p.status === "valid" || p.status === "connected",
  ) || !!localConfigured;

  // When providers are configured, all models are available.
  // When none are configured, still show all models (they'll use the router)
  // but mark them as unavailable in the UI.
  const availableModels = ALL_MODELS;

  const refresh = useCallback(() => {
    setLoading(true);
    fetchProviders();
  }, [fetchProviders]);

  const value: ModelContextValue = {
    providers,
    defaultModel,
    isConfigured,
    loading,
    availableModels,
    setDefaultModel,
    refresh,
  };

  return React.createElement(ModelContext.Provider, { value }, children);
}
