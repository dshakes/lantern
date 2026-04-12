"use client";

import type {
  Agent,
  Run,
  RunStatus,
  StreamEvent,
  ApiKey,
} from "@/lib/mock-data";
import {
  agents as mockAgents,
  runs as mockRuns,
  sampleRunEvents,
  apiKeys as mockApiKeys,
  getAgentByName,
  getRunsForAgent,
  getRunById,
} from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  name: string;
  tenantId: string;
  role: "owner" | "admin" | "member" | "viewer";
}

export interface CreateAgentInput {
  name: string;
  description: string;
  template?: string;
  model?: string;
}

export interface RunFilters {
  agentName?: string;
  status?: RunStatus | "all";
  search?: string;
}

export interface CreateRunInput {
  agentName: string;
  input: unknown;
  model?: string;
  stream?: boolean;
}

export interface CreateApiKeyInput {
  name: string;
  scopes: string[];
}

export interface UsageData {
  plan: string;
  planCostUsd: number;
  currentMonthCostUsd: number;
  currentMonthRuns: number;
  currentMonthTokens: number;
  paymentMethod: string;
}

export interface SettingsInput {
  openaiApiKey?: string;
  anthropicApiKey?: string;
}

// ---------------------------------------------------------------------------
// Demo user (used when gateway is unavailable)
// ---------------------------------------------------------------------------

export const DEMO_USER: User = {
  id: "usr_demo",
  email: "demo@lantern.dev",
  name: "Demo User",
  tenantId: "t_acme",
  role: "owner",
};

// ---------------------------------------------------------------------------
// LanternAPI
// ---------------------------------------------------------------------------

class LanternAPI {
  private baseUrl: string;
  private _token: string | null = null;

  constructor() {
    this.baseUrl =
      (typeof window !== "undefined"
        ? (window as unknown as Record<string, unknown>).__NEXT_PUBLIC_API_URL
        : undefined) as string | undefined ??
      process.env.NEXT_PUBLIC_API_URL ??
      "http://localhost:8443";
  }

  // ---- token management ---------------------------------------------------

  get token(): string | null {
    return this._token;
  }

  setToken(token: string | null) {
    this._token = token;
    if (typeof window !== "undefined") {
      if (token) {
        localStorage.setItem("lantern_token", token);
        document.cookie = `lantern_token=${token}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
      } else {
        localStorage.removeItem("lantern_token");
        document.cookie =
          "lantern_token=; path=/; max-age=0; SameSite=Lax";
      }
    }
  }

  restoreToken(): string | null {
    if (typeof window === "undefined") return null;
    const stored = localStorage.getItem("lantern_token");
    if (stored) {
      this._token = stored;
    }
    return this._token;
  }

  // ---- internal fetch helper ----------------------------------------------

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> | undefined),
    };
    if (this._token) {
      headers["Authorization"] = `Bearer ${this._token}`;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `API ${res.status}: ${body || res.statusText}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  // ---- Auth ---------------------------------------------------------------

  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; user: User }> {
    try {
      const data = await this.request<{ token: string; user: User }>(
        "/api/v1/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ email, password }),
        },
      );
      this.setToken(data.token);
      return data;
    } catch {
      console.warn(
        "[lantern] Gateway unavailable, using demo login",
      );
      // Demo mode fallback
      if (email === "demo@lantern.dev" || password === "demo") {
        const demoToken = "demo_token_" + Date.now();
        this.setToken(demoToken);
        return { token: demoToken, user: DEMO_USER };
      }
      throw new Error("Invalid credentials");
    }
  }

  logout(): void {
    this.setToken(null);
  }

  // ---- Agents -------------------------------------------------------------

  async listAgents(): Promise<Agent[]> {
    try {
      return await this.request<Agent[]>("/api/v1/agents");
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for listAgents, using mock data",
      );
      return [...mockAgents];
    }
  }

  async getAgent(name: string): Promise<Agent> {
    try {
      return await this.request<Agent>(`/api/v1/agents/${encodeURIComponent(name)}`);
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for getAgent, using mock data",
      );
      const agent = getAgentByName(name);
      if (!agent) throw new Error(`Agent '${name}' not found`);
      return agent;
    }
  }

  async createAgent(data: CreateAgentInput): Promise<Agent> {
    try {
      return await this.request<Agent>("/api/v1/agents", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for createAgent, simulating locally",
      );
      // Simulate agent creation with mock data
      const agent: Agent = {
        id: `ag_${Date.now()}`,
        name: data.name
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "-"),
        description:
          data.description ||
          `Agent created from ${data.template ?? "blank"} template`,
        currentVersionId: "v_initial",
        createdAt: new Date(),
        labels: {},
        status: "active",
      };
      return agent;
    }
  }

  async deleteAgent(name: string): Promise<void> {
    try {
      await this.request<void>(
        `/api/v1/agents/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for deleteAgent, simulating locally",
      );
      // Simulate success in demo mode
    }
  }

  // ---- Runs ---------------------------------------------------------------

  async listRuns(filters?: RunFilters): Promise<Run[]> {
    try {
      const params = new URLSearchParams();
      if (filters?.agentName && filters.agentName !== "all")
        params.set("agent", filters.agentName);
      if (filters?.status && filters.status !== "all")
        params.set("status", filters.status);
      if (filters?.search) params.set("q", filters.search);
      const qs = params.toString();
      return await this.request<Run[]>(
        `/api/v1/runs${qs ? `?${qs}` : ""}`,
      );
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for listRuns, using mock data",
      );
      let result = [...mockRuns];
      if (filters?.agentName && filters.agentName !== "all") {
        result = result.filter(
          (r) => r.agentName === filters.agentName,
        );
      }
      if (filters?.status && filters.status !== "all") {
        result = result.filter(
          (r) => r.status === filters.status,
        );
      }
      if (filters?.search) {
        const q = filters.search.toLowerCase();
        result = result.filter(
          (r) =>
            r.id.toLowerCase().includes(q) ||
            r.agentName.toLowerCase().includes(q),
        );
      }
      return result;
    }
  }

  async getRun(id: string): Promise<Run> {
    try {
      return await this.request<Run>(`/api/v1/runs/${encodeURIComponent(id)}`);
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for getRun, using mock data",
      );
      const run = getRunById(id);
      if (!run) throw new Error(`Run '${id}' not found`);
      return run;
    }
  }

  async createRun(data: CreateRunInput): Promise<Run> {
    try {
      return await this.request<Run>("/api/v1/runs", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for createRun, simulating locally",
      );
      const run: Run = {
        id: `run_${Date.now()}`,
        tenantId: "t_acme",
        agentId: "ag_simulated",
        agentName: data.agentName,
        status: "queued",
        input: data.input,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        createdAt: new Date(),
        labels: { trigger: "manual" },
      };
      return run;
    }
  }

  async cancelRun(id: string, reason?: string): Promise<Run> {
    try {
      return await this.request<Run>(
        `/api/v1/runs/${encodeURIComponent(id)}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({ reason }),
        },
      );
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for cancelRun, simulating locally",
      );
      const run = getRunById(id);
      if (!run) throw new Error(`Run '${id}' not found`);
      return { ...run, status: "cancelled", finishedAt: new Date() };
    }
  }

  // ---- Streaming ----------------------------------------------------------

  streamRunEvents(runId: string): {
    subscribe: (cb: (event: StreamEvent) => void) => void;
    close: () => void;
  } {
    let onEvent: ((event: StreamEvent) => void) | null = null;
    let closed = false;

    // Try real SSE first
    try {
      const url = `${this.baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/events`;
      const es = new EventSource(
        this._token ? `${url}?token=${this._token}` : url,
      );

      es.onmessage = (msg) => {
        if (closed) return;
        try {
          const event = JSON.parse(msg.data) as StreamEvent;
          event.ts = new Date(event.ts);
          onEvent?.(event);
        } catch {
          // Ignore malformed events
        }
      };

      es.onerror = () => {
        // If SSE fails, fall back to mock events
        es.close();
        if (!closed) {
          console.warn(
            "[lantern] SSE unavailable, falling back to mock events",
          );
          emitMockEvents();
        }
      };

      return {
        subscribe: (cb) => {
          onEvent = cb;
        },
        close: () => {
          closed = true;
          es.close();
        },
      };
    } catch {
      // EventSource not supported or URL fails — use mock
      console.warn(
        "[lantern] SSE unavailable, falling back to mock events",
      );
    }

    function emitMockEvents() {
      const events =
        runId === "run_01hqa1b2c3d4" ? [...sampleRunEvents] : [];
      let idx = 0;
      const interval = setInterval(() => {
        if (closed || idx >= events.length) {
          clearInterval(interval);
          return;
        }
        onEvent?.(events[idx]);
        idx++;
      }, 300);
    }

    // Fallback path
    return {
      subscribe: (cb) => {
        onEvent = cb;
        emitMockEvents();
      },
      close: () => {
        closed = true;
      },
    };
  }

  // ---- Runs for a specific agent (helper) ---------------------------------

  async getRunsForAgent(agentName: string): Promise<Run[]> {
    try {
      return await this.request<Run[]>(
        `/api/v1/runs?agent=${encodeURIComponent(agentName)}`,
      );
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for getRunsForAgent, using mock data",
      );
      return getRunsForAgent(agentName);
    }
  }

  // ---- Agent Versions (helper) --------------------------------------------

  async getAgentVersions(
    agentName: string,
  ): Promise<import("@/lib/mock-data").AgentVersion[]> {
    try {
      return await this.request<import("@/lib/mock-data").AgentVersion[]>(
        `/api/v1/agents/${encodeURIComponent(agentName)}/versions`,
      );
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for getAgentVersions, using mock data",
      );
      const { agentVersions } = await import("@/lib/mock-data");
      return agentVersions[agentName] ?? [];
    }
  }

  // ---- Settings -----------------------------------------------------------

  async listApiKeys(): Promise<ApiKey[]> {
    try {
      return await this.request<ApiKey[]>("/api/v1/settings/api-keys");
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for listApiKeys, using mock data",
      );
      return [...mockApiKeys];
    }
  }

  async createApiKey(
    data: CreateApiKeyInput,
  ): Promise<ApiKey & { secret: string }> {
    try {
      return await this.request<ApiKey & { secret: string }>(
        "/api/v1/settings/api-keys",
        {
          method: "POST",
          body: JSON.stringify(data),
        },
      );
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for createApiKey, simulating locally",
      );
      const key: ApiKey & { secret: string } = {
        id: `key_${Date.now()}`,
        name: data.name,
        prefix: `ltn_${Math.random().toString(36).slice(2, 6)}`,
        scopes: data.scopes,
        createdAt: new Date(),
        secret: `ltn_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
      };
      return key;
    }
  }

  async revokeApiKey(id: string): Promise<void> {
    try {
      await this.request<void>(
        `/api/v1/settings/api-keys/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for revokeApiKey, simulating locally",
      );
    }
  }

  async getUsage(): Promise<UsageData> {
    try {
      return await this.request<UsageData>("/api/v1/settings/usage");
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for getUsage, using mock data",
      );
      return {
        plan: "Pro",
        planCostUsd: 49,
        currentMonthCostUsd: 12.47,
        currentMonthRuns: 348,
        currentMonthTokens: 2_100_000,
        paymentMethod: "Visa ending in 4242",
      };
    }
  }

  async updateSettings(data: SettingsInput): Promise<void> {
    try {
      await this.request<void>("/api/v1/settings", {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for updateSettings, simulating locally",
      );
    }
  }
}

export const api = new LanternAPI();
