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
  | "reasoning-large"
  | "reasoning-small"
  | "chat-large"
  | "chat-small"
  | "code-large";

export interface ModelOption {
  value: ModelCapability;
  label: string;
  /** Whether this model requires at least one configured provider to function. */
  requiresProvider: boolean;
}

/** All capabilities the platform knows about. */
export const ALL_MODELS: ModelOption[] = [
  { value: "auto", label: "Auto (recommended)", requiresProvider: true },
  { value: "reasoning-large", label: "Reasoning Large", requiresProvider: true },
  { value: "reasoning-small", label: "Reasoning Small", requiresProvider: true },
  { value: "chat-large", label: "Chat Large", requiresProvider: true },
  { value: "chat-small", label: "Chat Small", requiresProvider: true },
  { value: "code-large", label: "Code Large", requiresProvider: true },
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
      setProviders(data ?? []);
    } catch {
      // If the API is unavailable, leave providers empty.
      setProviders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const isConfigured = providers.some(
    (p) => p.status === "configured" || p.status === "active" || p.status === "valid",
  );

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
