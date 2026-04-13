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
  getEventsForRun,
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

// ---------------------------------------------------------------------------
// Agent spec types (AI-generated agent specification)
// ---------------------------------------------------------------------------

export interface AgentSpecStep {
  name: string;
  type: "llm" | "tool" | "connector" | "condition" | "loop" | "approval";
  description: string;
  config: Record<string, unknown>;
}

export interface AgentSpecTrigger {
  type: "manual" | "schedule" | "webhook" | "surface";
  config: Record<string, unknown>;
}

export interface AgentSpecLimits {
  timeout: string;
  maxTokens: number;
  maxCostUsd: number;
}

export interface AgentSpec {
  name: string;
  description: string;
  model: string;
  steps: AgentSpecStep[];
  tools: string[];
  connectors: string[];
  surfaces: string[];
  triggers: AgentSpecTrigger[];
  isolation: "trusted" | "standard" | "untrusted";
  limits: AgentSpecLimits;
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

// ---------------------------------------------------------------------------
// Connector types
// ---------------------------------------------------------------------------

export interface ConnectorInstall {
  id: string;
  tenantId: string;
  connectorId: string;
  displayName: string;
  status: string;
  config: Record<string, unknown>;
  scopes?: string[];
  installedBy?: string;
  installedAt: string;
  updatedAt: string;
}

export interface InstallConnectorInput {
  connectorId: string;
  displayName: string;
  config?: Record<string, unknown>;
  scopes?: string[];
}

// ---------------------------------------------------------------------------
// Surface types
// ---------------------------------------------------------------------------

export interface SurfaceConfigRecord {
  id: string;
  tenantId: string;
  surfaceId: string;
  displayName: string;
  status: string;
  config: Record<string, unknown>;
  webhookUrl?: string;
  connectedAt?: string;
  updatedAt: string;
}

export interface ConfigureSurfaceInput {
  surfaceId: string;
  displayName: string;
  config?: Record<string, unknown>;
  webhookUrl?: string;
}

export interface UpdateSurfaceInput {
  displayName?: string;
  config?: Record<string, unknown>;
  webhookUrl?: string;
}

// ---------------------------------------------------------------------------
// Deployment types
// ---------------------------------------------------------------------------

export interface Deployment {
  id: string;
  tenantId: string;
  agentName: string;
  version: string;
  environment: string;
  status: string;
  deployedBy?: string;
  message?: string;
  logs?: string[];
  createdAt: string;
  finishedAt?: string;
}

export interface CreateDeploymentInput {
  agentName: string;
  version: string;
  environment?: string;
  message?: string;
}

export interface DataPlane {
  id: string;
  tenantId: string;
  name: string;
  cloud: string;
  region: string;
  clusterName?: string;
  status: string;
  agentCount: number;
  lastHeartbeat?: string;
  config?: Record<string, unknown>;
  createdAt: string;
}

export interface RegisterDataPlaneInput {
  name: string;
  cloud: string;
  region: string;
  clusterName?: string;
  config?: Record<string, unknown>;
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
    // In the browser, use the Next.js proxy to avoid CORS. Server-side, call
    // the control-plane directly (docker-compose service name or env var).
    if (typeof window !== "undefined") {
      // Browser: use relative URL so Next.js rewrites proxy to the backend.
      this.baseUrl =
        (window as unknown as Record<string, unknown>).__NEXT_PUBLIC_API_URL as string | undefined ??
        process.env.NEXT_PUBLIC_API_URL ??
        "http://localhost:8080";
    } else {
      this.baseUrl =
        process.env.LANTERN_API_URL ??
        process.env.NEXT_PUBLIC_API_URL ??
        "http://localhost:8080";
    }
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
    // Ensure token is loaded from localStorage if not already set
    if (!this._token && typeof window !== "undefined") {
      this.restoreToken();
    }
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

  async signup(
    email: string,
    password: string,
    name: string,
  ): Promise<{ token: string; user: User }> {
    try {
      const data = await this.request<{ token: string; user: User }>(
        "/auth/signup",
        {
          method: "POST",
          body: JSON.stringify({ email, password, name }),
        },
      );
      this.setToken(data.token);
      return data;
    } catch (err) {
      console.warn(
        "[lantern] Signup failed",
        err,
      );
      throw err;
    }
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; user: User }> {
    try {
      const data = await this.request<{ token: string; user: User }>(
        "/auth/login",
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

  async getMe(): Promise<User> {
    return this.request<User>("/auth/me");
  }

  async oauthStart(provider: string): Promise<{ redirect_url: string }> {
    return this.request<{ redirect_url: string }>(`/auth/oauth/${provider}/start`);
  }

  logout(): void {
    this.setToken(null);
  }

  // ---- Agents -------------------------------------------------------------

  async listAgents(): Promise<Agent[]> {
    return await this.request<Agent[]>("/v1/agents");
  }

  async getAgent(name: string): Promise<Agent> {
    try {
      return await this.request<Agent>(`/v1/agents/${encodeURIComponent(name)}`);
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
      return await this.request<Agent>("/v1/agents", {
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

  async updateAgent(
    name: string,
    data: { description?: string; systemPrompt?: string; model?: string; isolation?: string; timeout?: string; maxTokens?: number; maxCostUsd?: number; cron?: string },
  ): Promise<Agent> {
    try {
      return await this.request<Agent>(
        `/v1/agents/${encodeURIComponent(name)}`,
        {
          method: "PUT",
          body: JSON.stringify(data),
        },
      );
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for updateAgent, saving to localStorage",
      );
      // Save to localStorage as fallback
      if (typeof window !== "undefined") {
        const key = `lantern_agent_settings_${name}`;
        const existing = localStorage.getItem(key);
        const current = existing ? JSON.parse(existing) : {};
        const merged = { ...current, ...data };
        localStorage.setItem(key, JSON.stringify(merged));
      }
      // Return a simulated agent
      const agent = await this.getAgent(name);
      return { ...agent, description: data.description ?? agent.description };
    }
  }

  async deleteAgent(name: string): Promise<void> {
    try {
      await this.request<void>(
        `/v1/agents/${encodeURIComponent(name)}`,
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
    const params = new URLSearchParams();
    if (filters?.agentName && filters.agentName !== "all")
      params.set("agent", filters.agentName);
    if (filters?.status && filters.status !== "all")
      params.set("status", filters.status);
    if (filters?.search) params.set("q", filters.search);
    const qs = params.toString();
    return await this.request<Run[]>(
      `/v1/runs${qs ? `?${qs}` : ""}`,
    );
  }

  async getRun(id: string): Promise<Run> {
    try {
      return await this.request<Run>(`/v1/runs/${encodeURIComponent(id)}`);
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
      return await this.request<Run>("/v1/runs", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch (err) {
      console.warn("[lantern] createRun failed:", err);
      // Re-throw so the caller can handle it (e.g., redirect to playground)
      throw err;
    }
  }

  async cancelRun(id: string, reason?: string): Promise<Run> {
    try {
      return await this.request<Run>(
        `/v1/runs/${encodeURIComponent(id)}/cancel`,
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
      const url = `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`;
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
      // Use getEventsForRun to resolve mock events for any known mock run ID
      const resolved = getEventsForRun(runId);
      const events = resolved.length > 0 ? [...resolved] : [...sampleRunEvents];
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
        `/v1/runs?agent=${encodeURIComponent(agentName)}`,
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
        `/v1/agents/${encodeURIComponent(agentName)}/versions`,
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
      return await this.request<ApiKey[]>("/v1/settings/api-keys");
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
        "/v1/settings/api-keys",
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
        `/v1/settings/api-keys/${encodeURIComponent(id)}`,
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
      return await this.request<UsageData>("/v1/settings/usage");
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
      await this.request<void>("/v1/settings", {
        method: "PATCH",
        body: JSON.stringify(data),
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for updateSettings, simulating locally",
      );
    }
  }

  // ---- Connectors ----------------------------------------------------------

  async listConnectors(): Promise<ConnectorInstall[]> {
    try {
      return await this.request<ConnectorInstall[]>("/v1/connectors");
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for listConnectors, using localStorage fallback",
      );
      return [];
    }
  }

  async installConnector(data: InstallConnectorInput): Promise<ConnectorInstall> {
    try {
      return await this.request<ConnectorInstall>("/v1/connectors/install", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for installConnector, simulating locally",
      );
      return {
        id: `ci_${Date.now()}`,
        tenantId: "t_acme",
        connectorId: data.connectorId,
        displayName: data.displayName,
        status: "connected",
        config: data.config ?? {},
        scopes: data.scopes,
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async uninstallConnector(id: string): Promise<void> {
    try {
      await this.request<void>(`/v1/connectors/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for uninstallConnector, simulating locally",
      );
    }
  }

  async testConnector(id: string): Promise<{ success: boolean; message: string }> {
    try {
      return await this.request<{ success: boolean; message: string }>(
        `/v1/connectors/${encodeURIComponent(id)}/test`,
        { method: "POST" },
      );
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for testConnector, simulating locally",
      );
      return { success: true, message: "Connection verified (simulated)" };
    }
  }

  async startOAuth(connectorId: string): Promise<{ redirectUrl: string; state: string }> {
    try {
      return await this.request<{ redirectUrl: string; state: string }>(
        `/v1/connectors/oauth/start?connector=${encodeURIComponent(connectorId)}`,
        { method: "POST" },
      );
    } catch (err) {
      console.warn(
        "[lantern] Gateway unavailable for startOAuth, simulating locally",
        err,
      );
      throw err;
    }
  }

  // ---- Surfaces -------------------------------------------------------------

  async listSurfaces(): Promise<SurfaceConfigRecord[]> {
    try {
      return await this.request<SurfaceConfigRecord[]>("/v1/surfaces");
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for listSurfaces, using localStorage fallback",
      );
      return [];
    }
  }

  async configureSurface(data: ConfigureSurfaceInput): Promise<SurfaceConfigRecord> {
    try {
      return await this.request<SurfaceConfigRecord>("/v1/surfaces", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for configureSurface, simulating locally",
      );
      return {
        id: `sc_${Date.now()}`,
        tenantId: "t_acme",
        surfaceId: data.surfaceId,
        displayName: data.displayName,
        status: "connected",
        config: data.config ?? {},
        webhookUrl: data.webhookUrl,
        connectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async updateSurface(id: string, data: UpdateSurfaceInput): Promise<SurfaceConfigRecord> {
    try {
      return await this.request<SurfaceConfigRecord>(
        `/v1/surfaces/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          body: JSON.stringify(data),
        },
      );
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for updateSurface, simulating locally",
      );
      return {
        id,
        tenantId: "t_acme",
        surfaceId: "unknown",
        displayName: data.displayName ?? "Surface",
        status: "connected",
        config: data.config ?? {},
        webhookUrl: data.webhookUrl,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async removeSurface(id: string): Promise<void> {
    try {
      await this.request<void>(`/v1/surfaces/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for removeSurface, simulating locally",
      );
    }
  }

  async testSurface(id: string): Promise<{ success: boolean; message: string }> {
    try {
      return await this.request<{ success: boolean; message: string }>(
        `/v1/surfaces/${encodeURIComponent(id)}/test`,
        { method: "POST" },
      );
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for testSurface, simulating locally",
      );
      return { success: true, message: "Test message sent (simulated)" };
    }
  }

  // ---- API Keys (real endpoints) -------------------------------------------

  async listApiKeysReal(): Promise<Array<{
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    status: string;
    createdAt: string;
    lastUsedAt?: string;
    revokedAt?: string;
  }>> {
    try {
      return await this.request("/v1/api-keys");
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for listApiKeysReal, falling back",
      );
      throw new Error("API unavailable");
    }
  }

  async createApiKeyReal(data: CreateApiKeyInput): Promise<{
    key: { id: string; name: string; prefix: string; scopes: string[]; createdAt: string };
    rawKey: string;
  }> {
    try {
      return await this.request("/v1/api-keys", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for createApiKeyReal, falling back",
      );
      throw new Error("API unavailable");
    }
  }

  async revokeApiKeyReal(id: string): Promise<void> {
    try {
      await this.request<void>(`/v1/api-keys/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for revokeApiKeyReal, falling back",
      );
      throw new Error("API unavailable");
    }
  }

  // ---- Deployments ----------------------------------------------------------

  async listDeployments(): Promise<Deployment[]> {
    try {
      return await this.request<Deployment[]>("/v1/deployments");
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for listDeployments, using localStorage fallback",
      );
      return [];
    }
  }

  async createDeployment(data: CreateDeploymentInput): Promise<Deployment> {
    try {
      return await this.request<Deployment>("/v1/deployments", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for createDeployment, simulating locally",
      );
      return {
        id: `dep_${Date.now()}`,
        tenantId: "t_acme",
        agentName: data.agentName,
        version: data.version,
        environment: data.environment ?? "development",
        status: "deploying",
        message: data.message,
        logs: ["Deployment initiated (simulated)"],
        createdAt: new Date().toISOString(),
      };
    }
  }

  async getDeployment(id: string): Promise<Deployment> {
    return this.request<Deployment>(`/v1/deployments/${encodeURIComponent(id)}`);
  }

  async listDataPlanes(): Promise<DataPlane[]> {
    try {
      return await this.request<DataPlane[]>("/v1/data-planes");
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for listDataPlanes, using localStorage fallback",
      );
      return [];
    }
  }

  async registerDataPlane(data: RegisterDataPlaneInput): Promise<DataPlane> {
    try {
      return await this.request<DataPlane>("/v1/data-planes", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for registerDataPlane, simulating locally",
      );
      return {
        id: `dp_${Date.now()}`,
        tenantId: "t_acme",
        name: data.name,
        cloud: data.cloud,
        region: data.region,
        clusterName: data.clusterName,
        status: "provisioning",
        agentCount: 0,
        createdAt: new Date().toISOString(),
      };
    }
  }

  async removeDataPlane(id: string): Promise<void> {
    try {
      await this.request<void>(`/v1/data-planes/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch {
      console.warn(
        "[lantern] Gateway unavailable for removeDataPlane, simulating locally",
      );
    }
  }

  // ---- Agent AI Generation ---------------------------------------------------

  /** Agent spec shape returned by the generate-spec endpoint. */
  async generateAgentSpec(description: string): Promise<AgentSpec> {
    const res = await this.complete({
      messages: [
        {
          role: "system",
          content: `You are Lantern's agent architect. Given a user's description, generate a structured agent specification.

Output ONLY valid JSON with this exact structure (no markdown, no backticks, no explanation):
{
  "name": "kebab-case-name",
  "description": "One sentence description",
  "model": "auto",
  "steps": [
    { "name": "step-name", "type": "llm", "description": "What this step does", "config": {} }
  ],
  "tools": [],
  "connectors": [],
  "surfaces": [],
  "triggers": [{ "type": "manual", "config": {} }],
  "isolation": "standard",
  "limits": { "timeout": "5m", "maxTokens": 100000, "maxCostUsd": 1.0 }
}

Valid step types: llm, tool, connector, condition, loop, approval
Valid tools: web-search, python-exec, fs-read, fs-write, browser, code-interpreter
Valid connectors: gmail, slack, github, linear, notion, stripe, google-calendar, jira, discord
Valid surfaces: whatsapp, slack, discord, telegram, twilio, email, webchat
Valid trigger types: manual, schedule, webhook, surface
Valid isolation levels: trusted, standard, untrusted
Valid models: auto, reasoning-large, reasoning-small, chat-large, chat-small, code-large

Generate a thoughtful, well-structured agent with appropriate steps for the task described. Use descriptive step names in kebab-case.`,
        },
        { role: "user", content: description },
      ],
      model: "auto",
      temperature: 0.7,
      maxTokens: 4096,
    });

    if (!res.ok) {
      throw new Error("Failed to generate agent spec");
    }

    const data = await res.json();
    const content: string = data.content ?? "";

    // Extract JSON from the response (handle potential markdown wrapping)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Could not parse agent spec from LLM response");
    }

    return JSON.parse(jsonMatch[0]) as AgentSpec;
  }

  async generateAgentCode(spec: AgentSpec): Promise<{ code: string; yaml: string }> {
    const res = await this.complete({
      messages: [
        {
          role: "system",
          content: `You are Lantern's code generator. Given an agent specification JSON, generate production-ready TypeScript agent code using the @lantern/sdk.

Output ONLY valid JSON with this exact structure (no markdown, no backticks):
{
  "code": "// TypeScript code here",
  "yaml": "// YAML config as a string"
}

The TypeScript code should:
- Import from "@lantern/sdk"
- Use the Agent class with proper typing
- Implement each step using the step() function for durability
- Use ctx.llm.generate() for LLM calls (never call models directly)
- Use ctx.connectors.<name>.<action>() for connector calls
- Use ctx.mcp("<tool>").call() for tool invocations
- Include proper error handling
- Be clean, well-commented, production-quality code

The YAML should be a valid agent.yaml configuration matching the spec.

Ensure the code string and yaml string are properly escaped for JSON (newlines as \\n, quotes escaped, etc).`,
        },
        { role: "user", content: JSON.stringify(spec) },
      ],
      model: "auto",
      temperature: 0.4,
      maxTokens: 8192,
    });

    if (!res.ok) {
      throw new Error("Failed to generate agent code");
    }

    const data = await res.json();
    const content: string = data.content ?? "";

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Could not parse generated code from LLM response");
    }

    return JSON.parse(jsonMatch[0]) as { code: string; yaml: string };
  }

  // ---- LLM Completions ------------------------------------------------------

  /**
   * Send a completion request to the LLM proxy. Returns the raw Response so
   * the caller can handle SSE streaming or read JSON directly.
   */
  async complete(params: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    stream?: boolean;
    temperature?: number;
    maxTokens?: number;
  }): Promise<Response> {
    // Ensure token is loaded (complete() bypasses this.request() so we must check)
    if (!this._token) {
      this.restoreToken();
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this._token) {
      headers["Authorization"] = `Bearer ${this._token}`;
    }
    return fetch(`${this.baseUrl}/v1/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(params),
    });
  }

  // ---- LLM Provider Settings ------------------------------------------------

  async listLlmProviders(): Promise<
    Array<{
      provider: string;
      status: string;
      keyMasked: string;
      source?: string;
      createdAt?: string;
      updatedAt?: string;
    }>
  > {
    return this.request("/v1/settings/llm-providers");
  }

  async saveLlmProvider(provider: string, apiKey: string): Promise<{ status: string; provider: string }> {
    return this.request("/v1/settings/llm-providers", {
      method: "POST",
      body: JSON.stringify({ provider, apiKey }),
    });
  }

  async testLlmProvider(provider: string): Promise<{ success: boolean; message?: string; error?: string }> {
    return this.request(`/v1/settings/llm-providers/${encodeURIComponent(provider)}/test`, {
      method: "POST",
    });
  }
}

export const api = new LanternAPI();
