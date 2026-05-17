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
// Demo user + simulated-data telemetry
// ---------------------------------------------------------------------------

// DEMO_USER is the synthetic identity used when the gateway is unreachable.
// Its tenantId is also the canonical sentinel for every "fallback path" in
// this module — never inline the literal string; reference DEMO_USER.tenantId
// so the demo footprint is grep-able from one place.
export const DEMO_USER: User = {
  id: "usr_demo",
  email: "demo@lantern.dev",
  name: "Demo User",
  tenantId: "t_acme",
  role: "owner",
};

// ApiUnavailableError marks an upstream gateway failure. Components can
// catch it to render an explicit "service offline" state instead of the
// generic Error string. We continue to fall back to mock data inside the
// API methods (to keep the dashboard explorable offline), but every fall-
// back fires `notifySimulated` so the dashboard surfaces a "Demo data"
// banner — the data is no longer silently wrong.
export class ApiUnavailableError extends Error {
  readonly operation: string;
  readonly cause?: unknown;
  constructor(operation: string, cause?: unknown) {
    super(`Lantern API unavailable for ${operation}`);
    this.name = "ApiUnavailableError";
    this.operation = operation;
    this.cause = cause;
  }
}

// Module-scoped "simulated data was returned recently" state. Subscribers
// (the dashboard banner) re-render when notifySimulated fires. We keep the
// last 25 operations so we can show the user *what* is being faked, not
// just "something is."
type SimulatedEvent = { operation: string; at: number };
const simulatedListeners = new Set<(events: SimulatedEvent[]) => void>();
const simulatedHistory: SimulatedEvent[] = [];
const SIMULATED_HISTORY_MAX = 25;

export function notifySimulated(operation: string, cause?: unknown): void {
  // Keep the warning in the console for devs, but make it scannable.
  if (typeof console !== "undefined") {
    console.warn(`[lantern] Simulated: ${operation}`, cause);
  }
  simulatedHistory.unshift({ operation, at: Date.now() });
  if (simulatedHistory.length > SIMULATED_HISTORY_MAX) {
    simulatedHistory.length = SIMULATED_HISTORY_MAX;
  }
  for (const fn of simulatedListeners) fn(simulatedHistory.slice());
}

export function subscribeSimulated(
  fn: (events: SimulatedEvent[]) => void
): () => void {
  simulatedListeners.add(fn);
  // Replay current state so newly-mounted listeners see history.
  fn(simulatedHistory.slice());
  return () => simulatedListeners.delete(fn);
}

export function getSimulatedHistory(): SimulatedEvent[] {
  return simulatedHistory.slice();
}

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
    } catch (err) {
      notifySimulated("login", err);
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
    } catch (err) {
      notifySimulated("getAgent", err);
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
    } catch (err) {
      notifySimulated("createAgent", err);
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
    } catch (err) {
      notifySimulated("updateAgent", err);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only swallow network errors (API down). Re-throw real API errors.
      if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || err instanceof TypeError) {
        notifySimulated("deleteAgent");
        return; // silent success in demo mode
      }
      throw err;
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
    } catch (err) {
      notifySimulated("getRun", err);
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
      notifySimulated("createRun");
      // Re-throw so the caller can handle it
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
    } catch (err) {
      notifySimulated("cancelRun", err);
      const run = getRunById(id);
      if (!run) throw new Error(`Run '${id}' not found`);
      return { ...run, status: "cancelled", finishedAt: new Date() };
    }
  }

  async deleteRun(id: string): Promise<void> {
    await this.request<void>(`/v1/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
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
          notifySimulated("streamRunEvents");
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
      notifySimulated("streamRunEvents");
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
    } catch (err) {
      notifySimulated("getRunsForAgent", err);
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
    } catch (err) {
      notifySimulated("getAgentVersions", err);
      const { agentVersions } = await import("@/lib/mock-data");
      return agentVersions[agentName] ?? [];
    }
  }

  // ---- Settings -----------------------------------------------------------

  async listApiKeys(): Promise<ApiKey[]> {
    try {
      return await this.request<ApiKey[]>("/v1/settings/api-keys");
    } catch (err) {
      notifySimulated("listApiKeys", err);
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
    } catch (err) {
      notifySimulated("createApiKey", err);
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
    } catch (err) {
      notifySimulated("revokeApiKey", err);
    }
  }

  async getUsage(): Promise<UsageData> {
    try {
      return await this.request<UsageData>("/v1/settings/usage");
    } catch (err) {
      notifySimulated("getUsage", err);
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
    } catch (err) {
      notifySimulated("updateSettings", err);
    }
  }

  // ---- Connectors ----------------------------------------------------------

  async listConnectors(): Promise<ConnectorInstall[]> {
    try {
      return await this.request<ConnectorInstall[]>("/v1/connectors");
    } catch (err) {
      notifySimulated("listConnectors", err);
      return [];
    }
  }

  async installConnector(data: InstallConnectorInput): Promise<ConnectorInstall> {
    try {
      return await this.request<ConnectorInstall>("/v1/connectors/install", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only simulate locally for network errors (API completely down)
      if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || err instanceof TypeError) {
        notifySimulated("installConnector");
        return {
          id: `ci_local_${Date.now()}`,
          tenantId: DEMO_USER.tenantId,
          connectorId: data.connectorId,
          displayName: data.displayName,
          status: "connected",
          config: data.config ?? {},
          scopes: data.scopes,
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      // Re-throw real API errors
      throw err;
    }
  }

  async uninstallConnector(id: string): Promise<void> {
    try {
      await this.request<void>(`/v1/connectors/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch (err) {
      notifySimulated("uninstallConnector", err);
    }
  }

  async testConnector(id: string): Promise<{ success: boolean; message: string }> {
    try {
      return await this.request<{ success: boolean; message: string }>(
        `/v1/connectors/${encodeURIComponent(id)}/test`,
        { method: "POST" },
      );
    } catch (err) {
      notifySimulated("testConnector", err);
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
    } catch (err) {
      notifySimulated("listSurfaces", err);
      return [];
    }
  }

  async configureSurface(data: ConfigureSurfaceInput): Promise<SurfaceConfigRecord> {
    try {
      return await this.request<SurfaceConfigRecord>("/v1/surfaces", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch (err) {
      notifySimulated("configureSurface", err);
      return {
        id: `sc_${Date.now()}`,
        tenantId: DEMO_USER.tenantId,
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
    } catch (err) {
      notifySimulated("updateSurface", err);
      return {
        id,
        tenantId: DEMO_USER.tenantId,
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
    } catch (err) {
      notifySimulated("removeSurface", err);
    }
  }

  async testSurface(id: string): Promise<{ success: boolean; message: string }> {
    try {
      return await this.request<{ success: boolean; message: string }>(
        `/v1/surfaces/${encodeURIComponent(id)}/test`,
        { method: "POST" },
      );
    } catch (err) {
      notifySimulated("testSurface", err);
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
    } catch (err) {
      notifySimulated("listApiKeysReal", err);
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
    } catch (err) {
      notifySimulated("createApiKeyReal", err);
      throw new Error("API unavailable");
    }
  }

  async revokeApiKeyReal(id: string): Promise<void> {
    try {
      await this.request<void>(`/v1/api-keys/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch (err) {
      notifySimulated("revokeApiKeyReal", err);
      throw new Error("API unavailable");
    }
  }

  // ---- Deployments ----------------------------------------------------------

  async listDeployments(): Promise<Deployment[]> {
    try {
      return await this.request<Deployment[]>("/v1/deployments");
    } catch (err) {
      notifySimulated("listDeployments", err);
      return [];
    }
  }

  async createDeployment(data: CreateDeploymentInput): Promise<Deployment> {
    try {
      return await this.request<Deployment>("/v1/deployments", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch (err) {
      notifySimulated("createDeployment", err);
      return {
        id: `dep_${Date.now()}`,
        tenantId: DEMO_USER.tenantId,
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
    } catch (err) {
      notifySimulated("listDataPlanes", err);
      return [];
    }
  }

  async registerDataPlane(data: RegisterDataPlaneInput): Promise<DataPlane> {
    try {
      return await this.request<DataPlane>("/v1/data-planes", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch (err) {
      notifySimulated("registerDataPlane", err);
      return {
        id: `dp_${Date.now()}`,
        tenantId: DEMO_USER.tenantId,
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
    } catch (err) {
      notifySimulated("removeDataPlane", err);
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

  // ---- Schedules --------------------------------------------------------------

  async createSchedule(data: {
    agentName: string;
    cronExpr: string;
    inputTemplate?: Record<string, unknown>;
    deliveryEmail?: string;
    enabled?: boolean;
  }): Promise<{
    id: string;
    agentName: string;
    cronExpr: string;
    deliveryEmail?: string;
    enabled: boolean;
    nextFireAt?: string;
  }> {
    try {
      return await this.request("/v1/schedules", {
        method: "POST",
        body: JSON.stringify(data),
      });
    } catch (err) {
      notifySimulated("createSchedule");
      throw err;
    }
  }

  async listSchedules(): Promise<
    Array<{
      id: string;
      tenantId: string;
      agentName: string;
      cronExpr: string;
      inputTemplate?: Record<string, unknown>;
      deliveryEmail?: string;
      enabled: boolean;
      nextFireAt?: string;
      lastFiredAt?: string;
      createdAt: string;
      updatedAt: string;
    }>
  > {
    try {
      return await this.request("/v1/schedules");
    } catch {
      notifySimulated("listSchedules");
      return [];
    }
  }

  async updateSchedule(
    id: string,
    data: { cronExpr?: string; deliveryEmail?: string; enabled?: boolean },
  ): Promise<{ id: string; cronExpr: string; enabled: boolean; nextFireAt?: string }> {
    return this.request(`/v1/schedules/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteSchedule(id: string): Promise<void> {
    try {
      await this.request<void>(`/v1/schedules/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch {
      notifySimulated("deleteSchedule");
    }
  }

  // ---- Gmail connector -------------------------------------------------------

  async fetchGmailMessages(limit = 20): Promise<{
    messages: Array<{
      from: string;
      subject: string;
      snippet: string;
      date: string;
      body: string;
    }>;
    count: number;
  }> {
    return this.request(`/v1/connectors/gmail/messages?limit=${limit}`);
  }

  // ---- Generic Connector Executor -------------------------------------------

  /**
   * Execute a connector action. For read-only actions (list_*, get_*) uses GET;
   * for actions that require parameters uses POST with a JSON body.
   */
  async executeConnector(
    connectorId: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<{ connector: string; action: string; data: unknown }> {
    const encodedId = encodeURIComponent(connectorId);
    const encodedAction = encodeURIComponent(action);
    const url = `/v1/connectors/${encodedId}/execute?action=${encodedAction}`;
    if (params && Object.keys(params).length > 0) {
      return this.request(url, {
        method: "POST",
        body: JSON.stringify(params),
      });
    }
    return this.request(url);
  }

  // ---- Sessions (interactive, long-lived agent sessions) ---------------------

  async createSession(agentName: string): Promise<{ id: string; status: string }> {
    return this.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ agentName }),
    });
  }

  async sendSessionMessage(sessionId: string, content: string): Promise<void> {
    await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  async getSession(sessionId: string): Promise<{
    id: string;
    tenantId: string;
    agentName: string;
    status: string;
    messages: Array<{ role: string; content: string; timestamp: string }>;
    createdAt: string;
    updatedAt: string;
  }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async listSessions(): Promise<Array<{
    id: string;
    tenantId: string;
    agentName: string;
    status: string;
    messages: Array<{ role: string; content: string; timestamp: string }>;
    createdAt: string;
    updatedAt: string;
  }>> {
    try {
      return await this.request("/v1/sessions");
    } catch {
      notifySimulated("listSessions");
      return [];
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: "POST",
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }

  // ---- A2A (Agent-to-Agent) Protocol (Gap 4) ---------------------------------

  async getAgentCard(agentName: string): Promise<{
    name: string;
    description: string;
    version: string;
    capabilities: string[];
    endpoint: string;
    auth: { type: string; description: string };
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    provider: { name: string; url: string };
  }> {
    try {
      return await this.request(`/v1/agents/${encodeURIComponent(agentName)}/card`);
    } catch {
      notifySimulated("getAgentCard");
      return {
        name: agentName,
        description: "Agent card unavailable",
        version: "0.1.0",
        capabilities: ["text-generation"],
        endpoint: `https://api.lantern.run/v1/agents/${agentName}/a2a/invoke`,
        auth: { type: "bearer", description: "Lantern API key" },
        inputSchema: { type: "object", properties: { message: { type: "string" } } },
        outputSchema: { type: "object", properties: { result: { type: "string" } } },
        provider: { name: "Lantern", url: "https://lantern.run" },
      };
    }
  }

  async getAgentDirectory(): Promise<{
    agents: Array<{
      name: string;
      description: string;
      version: string;
      capabilities: string[];
      endpoint: string;
      auth: { type: string; description: string };
      inputSchema: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
      provider: { name: string; url: string };
    }>;
    provider: { name: string; url: string };
  }> {
    try {
      return await this.request("/.well-known/agent.json");
    } catch {
      notifySimulated("getAgentDirectory");
      return { agents: [], provider: { name: "Lantern", url: "https://lantern.run" } };
    }
  }

  async invokeAgentA2A(agentName: string, message: string): Promise<{
    id: string;
    agentName: string;
    status: string;
    result: string;
    input: Record<string, unknown>;
    createdAt: string;
  }> {
    try {
      return await this.request(`/v1/agents/${encodeURIComponent(agentName)}/a2a/invoke`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
    } catch (err) {
      notifySimulated("invokeAgentA2A", err);
      return {
        id: `a2a_${Date.now()}`,
        agentName,
        status: "completed",
        result: `Simulated A2A response from ${agentName}. In production, this would execute the agent.`,
        input: { message },
        createdAt: new Date().toISOString(),
      };
    }
  }

  // ---- Workflow persistence (visual editor) -----------------------------------

  async saveWorkflow(agentName: string, workflow: unknown): Promise<{ status: string }> {
    try {
      return await this.request(`/v1/agents/${encodeURIComponent(agentName)}/workflow`, {
        method: "PUT",
        body: JSON.stringify(workflow),
      });
    } catch {
      notifySimulated("saveWorkflow");
      return { status: "saved_locally" };
    }
  }

  async getWorkflow(agentName: string): Promise<unknown | null> {
    try {
      return await this.request(`/v1/agents/${encodeURIComponent(agentName)}/workflow`);
    } catch {
      return null;
    }
  }

  // ---- Cloud Deploy (Gap 5: Managed Hosting) --------------------------------

  async deployAgent(agentName: string): Promise<{
    id: string;
    tenantId: string;
    agentName: string;
    status: string;
    url: string;
    environment: string;
    deployedAt: string;
  }> {
    try {
      return await this.request(`/v1/agents/${encodeURIComponent(agentName)}/deploy`, {
        method: "POST",
      });
    } catch {
      notifySimulated("deployAgent");
      const deployUrl = typeof window !== "undefined" && window.location.hostname === "localhost"
        ? `http://localhost:8080/v1/agents/${agentName}/a2a/invoke`
        : `https://agents.lantern.run/${agentName}`;
      return {
        id: `dep_${Date.now()}`,
        tenantId: DEMO_USER.tenantId,
        agentName,
        status: "live",
        url: deployUrl,
        environment: "cloud",
        deployedAt: new Date().toISOString(),
      };
    }
  }

  async getCloudDeployment(agentName: string): Promise<{
    id?: string;
    tenantId?: string;
    agentName?: string;
    status: string;
    url?: string;
    environment?: string;
    deployedAt?: string;
    stoppedAt?: string;
  }> {
    try {
      return await this.request(`/v1/agents/${encodeURIComponent(agentName)}/deploy`);
    } catch {
      notifySimulated("getCloudDeployment");
      return { status: "not_deployed" };
    }
  }

  async stopCloudDeployment(agentName: string): Promise<void> {
    try {
      await this.request(`/v1/agents/${encodeURIComponent(agentName)}/deploy/stop`, {
        method: "POST",
      });
    } catch {
      notifySimulated("stopCloudDeployment");
    }
  }

  connectSessionEvents(sessionId: string): EventSource {
    // Ensure token is loaded
    if (!this._token) {
      this.restoreToken();
    }
    const url = `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`;
    return new EventSource(this._token ? `${url}?token=${this._token}` : url);
  }

  // ---- Marketplace (real /v1/marketplace backend) --------------------------

  async listMarketplaceAgents(opts?: {
    category?: string;
    q?: string;
  }): Promise<MarketplaceAgent[]> {
    const qs = new URLSearchParams();
    if (opts?.category) qs.set("category", opts.category);
    if (opts?.q) qs.set("q", opts.q);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request<MarketplaceAgent[]>(`/v1/marketplace${suffix}`);
  }

  async getMarketplaceAgent(slug: string): Promise<MarketplaceAgent> {
    return this.request<MarketplaceAgent>(`/v1/marketplace/${encodeURIComponent(slug)}`);
  }

  async publishMarketplaceAgent(body: {
    agentName: string;
    description: string;
    category?: string;
    tags?: string[];
    readme?: string;
  }): Promise<{ id: string; slug: string; url: string }> {
    return this.request(`/v1/marketplace/publish`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async unpublishMarketplaceAgent(slug: string): Promise<{ status: string }> {
    return this.request(`/v1/marketplace/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
  }

  async forkMarketplaceAgent(
    slug: string,
    newName?: string,
  ): Promise<{ agentId: string; agentName: string }> {
    return this.request(`/v1/marketplace/${encodeURIComponent(slug)}/fork`, {
      method: "POST",
      body: JSON.stringify({ newName: newName ?? "" }),
    });
  }

  async starMarketplaceAgent(slug: string): Promise<{ starred: boolean }> {
    return this.request(`/v1/marketplace/${encodeURIComponent(slug)}/star`, {
      method: "POST",
    });
  }

  async unstarMarketplaceAgent(slug: string): Promise<{ starred: boolean }> {
    return this.request(`/v1/marketplace/${encodeURIComponent(slug)}/star`, {
      method: "DELETE",
    });
  }

  // ---- Budgets (policy-as-code) --------------------------------------------

  async getBudget(agentName: string): Promise<Budget | null> {
    try {
      return await this.request<Budget>(
        `/v1/agents/${encodeURIComponent(agentName)}/budget`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("API 404")) return null;
      throw err;
    }
  }

  async upsertBudget(agentName: string, budget: BudgetInput): Promise<{ status: string }> {
    return this.request(`/v1/agents/${encodeURIComponent(agentName)}/budget`, {
      method: "PUT",
      body: JSON.stringify(budget),
    });
  }

  async deleteBudget(agentName: string): Promise<{ status: string }> {
    return this.request(`/v1/agents/${encodeURIComponent(agentName)}/budget`, {
      method: "DELETE",
    });
  }

  async listBudgets(): Promise<Budget[]> {
    return this.request<Budget[]>(`/v1/budgets`);
  }

  // ---- Forecast (pre-run cost) ---------------------------------------------

  async forecastRun(body: {
    agentName: string;
    input: string;
    model?: string;
  }): Promise<ForecastResult> {
    return this.request<ForecastResult>(`/v1/runs/forecast`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // ---- Eval suites + runs + baselines --------------------------------------

  async listEvalSuites(agentName?: string): Promise<EvalSuite[]> {
    const qs = agentName ? `?agentName=${encodeURIComponent(agentName)}` : "";
    return this.request<EvalSuite[]>(`/v1/eval-suites${qs}`);
  }

  async upsertEvalSuite(suite: EvalSuiteInput): Promise<{ id: string }> {
    return this.request(`/v1/eval-suites`, {
      method: "POST",
      body: JSON.stringify(suite),
    });
  }

  async deleteEvalSuite(id: string): Promise<{ status: string }> {
    return this.request(`/v1/eval-suites/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async listEvalRuns(opts?: {
    agentName?: string;
    suiteId?: string;
    branch?: string;
  }): Promise<EvalRun[]> {
    const qs = new URLSearchParams();
    if (opts?.agentName) qs.set("agentName", opts.agentName);
    if (opts?.suiteId) qs.set("suiteId", opts.suiteId);
    if (opts?.branch) qs.set("branch", opts.branch);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request<EvalRun[]>(`/v1/eval-runs${suffix}`);
  }

  async setEvalBaseline(body: {
    agentName: string;
    branch: string;
    evalRunId: string;
  }): Promise<{ status: string }> {
    return this.request(`/v1/eval-baselines`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getEvalBaseline(
    agentName: string,
    branch: string,
  ): Promise<EvalBaseline | null> {
    const qs = `agentName=${encodeURIComponent(agentName)}&branch=${encodeURIComponent(branch)}`;
    try {
      return await this.request<EvalBaseline>(`/v1/eval-baselines?${qs}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("API 404")) return null;
      throw err;
    }
  }

  // ---- A/B experiments -----------------------------------------------------

  async listExperiments(agentName?: string): Promise<Experiment[]> {
    const qs = agentName ? `?agentName=${encodeURIComponent(agentName)}` : "";
    return this.request<Experiment[]>(`/v1/experiments${qs}`);
  }

  async getExperiment(id: string): Promise<Experiment> {
    return this.request<Experiment>(`/v1/experiments/${encodeURIComponent(id)}`);
  }

  async createExperiment(body: ExperimentInput): Promise<Experiment> {
    return this.request<Experiment>(`/v1/experiments`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async concludeExperiment(
    id: string,
    body: { winner: "a" | "b"; promote: boolean },
  ): Promise<{ status: string }> {
    return this.request(`/v1/experiments/${encodeURIComponent(id)}/conclude`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // ---- MCP server registry -------------------------------------------------

  async listMcpServers(opts?: { category?: string; q?: string }): Promise<McpServer[]> {
    const qs = new URLSearchParams();
    if (opts?.category) qs.set("category", opts.category);
    if (opts?.q) qs.set("q", opts.q);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request<McpServer[]>(`/v1/mcp/servers${suffix}`);
  }

  async attachMcpServer(
    agentName: string,
    body: { slug: string; config?: Record<string, unknown> },
  ): Promise<{ status: string }> {
    return this.request(`/v1/agents/${encodeURIComponent(agentName)}/mcp-servers`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async listAgentMcpServers(agentName: string): Promise<McpServer[]> {
    return this.request<McpServer[]>(
      `/v1/agents/${encodeURIComponent(agentName)}/mcp-servers`,
    );
  }

  async detachMcpServer(agentName: string, slug: string): Promise<{ status: string }> {
    return this.request(
      `/v1/agents/${encodeURIComponent(agentName)}/mcp-servers/${encodeURIComponent(slug)}`,
      { method: "DELETE" },
    );
  }

  // ---- Verifiable receipts -------------------------------------------------

  async issueReceipt(runId: string): Promise<SignedReceipt> {
    return this.request<SignedReceipt>(`/v1/runs/${encodeURIComponent(runId)}/receipt`, {
      method: "POST",
    });
  }

  async verifyReceipt(receipt: SignedReceipt): Promise<{
    valid: boolean;
    reason?: string;
    runId?: string;
    issuedAt?: string;
    tenantId?: string;
  }> {
    return this.request(`/v1/runs/receipts/verify`, {
      method: "POST",
      body: JSON.stringify(receipt),
    });
  }

  // ---- Run feedback (RLHF) -------------------------------------------------

  async submitRunFeedback(
    runId: string,
    body: {
      score: number;
      comment?: string;
      preferredOutput?: string;
      source?: "dashboard" | "sdk" | "surface";
    },
  ): Promise<{ status: string }> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/feedback`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async listRunFeedback(runId: string): Promise<RunFeedback[]> {
    return this.request<RunFeedback[]>(
      `/v1/runs/${encodeURIComponent(runId)}/feedback`,
    );
  }

  async getAgentFeedbackSummary(agentName: string): Promise<FeedbackSummary> {
    return this.request<FeedbackSummary>(
      `/v1/agents/${encodeURIComponent(agentName)}/feedback`,
    );
  }

  // ---- Rehearsals (replay past failures) -----------------------------------

  async rehearse(body: {
    agentName: string;
    window?: string;
    includeFailures?: boolean;
    includeLowScore?: boolean;
    limit?: number;
  }): Promise<RehearseResponse> {
    return this.request<RehearseResponse>(`/v1/runs/rehearse`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

// ---------------------------------------------------------------------------
// Types for the new backends
// ---------------------------------------------------------------------------

export interface MarketplaceAgent {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  manifest: Record<string, unknown>;
  card: Record<string, unknown>;
  readme?: string;
  forksCount: number;
  starsCount: number;
  starred: boolean;
  publishedAt: string;
  author: string;
}

export interface Budget {
  agentName: string;
  maxCostUsdPerDay?: number;
  maxCostUsdPerRun?: number;
  maxTokensPerDay?: number;
  maxRunsPerDay?: number;
  toolLimits?: Record<string, number>;
  hardFail: boolean;
  notifyAtPct: number;
  updatedAt?: string;
}

export type BudgetInput = Omit<Budget, "updatedAt">;

export interface ForecastResult {
  agentName: string;
  model: string;
  provider: string;
  estimatedTokensIn: number;
  estimatedTokensOut: number;
  estimatedCostUsd: number;
  confidence: number;
  reasoning: Record<string, unknown>;
  budget?: {
    maxCostUsdPerDay?: number;
    maxCostUsdPerRun?: number;
    spentTodayUsd: number;
    remainingTodayUsd: number;
    runsToday: number;
    maxRunsPerDay?: number;
    notifyAtPct: number;
    hardFail: boolean;
  };
  wouldExceedBudget: boolean;
  blockReason?: string;
}

export interface EvalCase {
  name: string;
  input: string;
  expected?: string;
  assert?: Record<string, unknown>;
  weight?: number;
}

export interface EvalSuite {
  id: string;
  agentName: string;
  name: string;
  description?: string;
  cases: EvalCase[];
  createdAt: string;
  updatedAt: string;
}

export type EvalSuiteInput = Omit<EvalSuite, "id" | "createdAt" | "updatedAt">;

export interface EvalRun {
  id: string;
  suiteId: string;
  agentName: string;
  agentVersion?: string;
  commitSha?: string;
  branch?: string;
  passed: boolean;
  score: number;
  casesTotal: number;
  casesPassed: number;
  durationMs: number;
  totalCostUsd: number;
  createdAt: string;
  baselineScore?: number | null;
  regressed?: boolean;
}

export interface EvalBaseline {
  agentName: string;
  branch: string;
  evalRunId: string;
  score: number;
  setAt: string;
}

export interface Experiment {
  id: string;
  agentName: string;
  name: string;
  variantAVersion: string;
  variantBVersion: string;
  trafficSplitB: number;
  evalSuiteId?: string;
  autoPromote: boolean;
  minRunsToPromote: number;
  status: string;
  winner?: string;
  aRuns: number;
  bRuns: number;
  aScore?: number | null;
  bScore?: number | null;
  startedAt: string;
  concludedAt?: string;
}

export interface ExperimentInput {
  agentName: string;
  name: string;
  variantAVersion: string;
  variantBVersion: string;
  trafficSplitB: number;
  evalSuiteId?: string;
  autoPromote: boolean;
  minRunsToPromote: number;
}

export interface McpServer {
  id?: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  endpoint?: string;
  tools?: string[];
  installsCount?: number;
}

export interface ReceiptPayload {
  runId: string;
  tenantId: string;
  agentName: string;
  agentVersion?: string;
  model?: string;
  provider?: string;
  status: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  journalHash: string;
  issuedAt: string;
  version: number;
}

export interface SignedReceipt {
  payload: ReceiptPayload;
  signature: string;
  algorithm: string;
}

export interface RunFeedback {
  runId: string;
  agentName?: string;
  score: number;
  comment?: string;
  preferredOutput?: string;
  source: string;
  createdAt: string;
}

export interface FeedbackSummary {
  agentName: string;
  totalFeedback: number;
  avgScore: number;
  thumbsUp: number;
  thumbsDown: number;
  runsWithPreferredOutput: number;
  last7DaysAvgScore: number;
}

export interface RehearseCase {
  originalRunId: string;
  originalAgentVersion?: string;
  originalStatus: string;
  originalScore?: number | null;
  input: unknown;
  expectedOutput?: unknown;
  originalCostUsd: number;
  originalAt: string;
}

export interface RehearseResponse {
  agentName: string;
  window: string;
  cases: RehearseCase[];
  count: number;
  reason?: string;
}

export const api = new LanternAPI();
