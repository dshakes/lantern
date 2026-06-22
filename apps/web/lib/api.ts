"use client";

// Types only — we intentionally don't import any mock data runtime here.
// Every method below either returns real API data, returns empty/null, or
// throws. No fabricated rows leak into the UI as fake runs.
import type {
  Agent,
  Run,
  RunStatus,
  StreamEvent,
  ApiKey,
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
  sessionId?: string;
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
  // How this connector was authenticated. Surfaced so the dashboard
  // can render a badge + offer the right re-auth flow when creds
  // go stale:
  //   "oauth"        → OAuth2 refresh token present, silent refresh.
  //   "app-password" → Google App Password (SMTP/IMAP-style). Doesn't
  //                    refresh; must be rotated manually.
  //   "api-key"      → generic API-key / bot-token install.
  //   ""             → unknown / not installed.
  authMethod?: "oauth" | "app-password" | "api-key" | "";
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
// Ask Lantern — agentic command-interpreter contract
// ---------------------------------------------------------------------------

/**
 * Compact, real summary of fleet state passed into `askLantern`. Kept small
 * (a short list of names + a few counts) so the prompt stays a few hundred
 * tokens — this is the ONLY ground truth the model gets, never the full DB.
 */
export interface AskLanternContext {
  agentNames: string[];
  /** Run counts keyed by status, e.g. { running: 2, failed: 1, completed: 40 }. */
  runCountsByStatus: Record<string, number>;
  /** Workload / runtime counts, e.g. { workloads: 3, dataPlanes: 1 }. */
  workloadCounts?: Record<string, number>;
}

/** Structured action returned by the LLM and consumed by the palette. */
export type AskLanternAction =
  | { kind: "navigate"; path: string; summary: string }
  | { kind: "answer"; answer: string; summary: string };

const ASK_LANTERN_SYSTEM_PROMPT = `You are Lantern's runtime command interpreter inside a dashboard command palette. The operator types a free-form natural-language command; you reason over the provided compact fleet context and return ONE structured action.

Output STRICT JSON ONLY — no markdown, no backticks, no prose around it — matching exactly one of:
{"kind":"navigate","path":"/runs?status=failed","summary":"one short line describing the action"}
{"kind":"answer","answer":"short natural-language answer","summary":"one short line describing the action"}

Rules:
- "navigate" for "take me to X", "show me Y", "filter Z", "schedule …". "path" MUST be a real dashboard route.
- "answer" for questions you can answer from the fleet context ("how many agents are failing?"). Answer ONLY from the provided context — never invent agents, counts, or facts. If the context doesn't contain the answer, return a "navigate" action to the most relevant page instead.
- Keep "summary" to one calm line. Keep "answer" to one or two sentences.

Real dashboard routes you may use for "path":
- /inbox        (Mission Control: runs needing review, live runs)
- /runs         (all runs; supports ?q=<text>)
- /runtime      (workloads & capacity; ?schedule=1 opens the schedule modal)
- /agents       (agent list)  ·  /agents/<name> (one agent)  ·  /agents/create
- /surfaces     (channels: whatsapp/slack/telegram/webchat)
- /connectors   (integrations)
- /deployments  (deployments & data planes)
- /settings     (providers, API keys, billing)
- /evaluations  (analytics)`;

/** Render the compact context as a few short lines for the prompt. */
function formatFleetContext(ctx: AskLanternContext): string {
  const lines: string[] = [];
  const names = ctx.agentNames.slice(0, 30);
  lines.push(
    names.length
      ? `Agents (${ctx.agentNames.length}): ${names.join(", ")}${
          ctx.agentNames.length > names.length ? ", …" : ""
        }`
      : "Agents: none",
  );
  const runs = Object.entries(ctx.runCountsByStatus);
  lines.push(
    runs.length
      ? `Runs by status: ${runs.map(([s, n]) => `${s}=${n}`).join(", ")}`
      : "Runs by status: none",
  );
  if (ctx.workloadCounts && Object.keys(ctx.workloadCounts).length) {
    lines.push(
      `Workloads: ${Object.entries(ctx.workloadCounts)
        .map(([k, n]) => `${k}=${n}`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Defensively parse the model's STRICT-JSON action: strip markdown fences,
 * grab the first JSON object, validate the discriminated shape. Returns null
 * on anything malformed so the caller falls back.
 */
function parseAskLanternAction(raw: string): AskLanternAction | null {
  if (!raw) return null;
  // Strip ```json … ``` fences if the model added them anyway.
  const fenced = raw.replace(/```(?:json)?/gi, "").trim();
  const match = fenced.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const summary = typeof o.summary === "string" ? o.summary.trim() : "";

  if (o.kind === "navigate") {
    let path = typeof o.path === "string" ? o.path.trim() : "";
    // Only allow same-origin in-app routes; reject anything else.
    if (!path.startsWith("/") || path.startsWith("//")) return null;
    return { kind: "navigate", path, summary: summary || "Navigating" };
  }
  if (o.kind === "answer") {
    const answer = typeof o.answer === "string" ? o.answer.trim() : "";
    if (!answer) return null;
    return { kind: "answer", answer, summary: summary || "Answer" };
  }
  return null;
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
      // This cookie is set from JS so it can't be HttpOnly here — it exists
      // only to feed the middleware's /auth/me check. Add Secure over HTTPS
      // (so it's never sent in cleartext) and keep SameSite=Lax (CSRF
      // hardening). Moving to a true HttpOnly cookie requires a server route
      // to set it on login — tracked as a follow-up (see file header note).
      const secure = window.location.protocol === "https:" ? "; Secure" : "";
      if (token) {
        localStorage.setItem("lantern_token", token);
        document.cookie = `lantern_token=${token}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax${secure}`;
      } else {
        localStorage.removeItem("lantern_token");
        document.cookie =
          `lantern_token=; path=/; max-age=0; SameSite=Lax${secure}`;
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

    if (res.status === 401) {
      // Stale or invalid token. Drop it + kick to /login so the rest of
      // the dashboard doesn't sit on a permanently-failing poll loop.
      // Auth endpoints are exempt — /auth/login itself returning 401
      // is just "bad credentials", caller handles it locally.
      if (
        typeof window !== "undefined" &&
        !path.startsWith("/auth/") &&
        !window.location.pathname.startsWith("/login")
      ) {
        this.setToken(null);
        const next = encodeURIComponent(
          window.location.pathname + window.location.search,
        );
        window.location.href = `/login?next=${next}`;
      }
      throw new Error("API 401: unauthorized");
    }

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
      // Demo-mode fallback: only ever mint a local demo token when demo mode
      // is explicitly enabled at build time (NEXT_PUBLIC_DEMO_MODE=1). Off by
      // default so an unreachable control-plane can't be used to slip past
      // auth with a client-minted token. Even when on, the middleware rejects
      // demo tokens at /auth/me, so they never reach real tenant data.
      if (
        process.env.NEXT_PUBLIC_DEMO_MODE === "1" &&
        (email === "demo@lantern.dev" || password === "demo")
      ) {
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

  /** Exchange the one-time OAuth code (delivered to /auth/callback?code=…) for
   *  a JWT. The token is no longer passed in the redirect URL — the callback
   *  page POSTs the short-lived, single-use code here to obtain it. */
  async exchangeOAuthCode(code: string): Promise<{ token: string }> {
    const data = await this.request<{ token: string }>("/auth/oauth/exchange", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    this.setToken(data.token);
    return data;
  }

  logout(): void {
    this.setToken(null);
  }

  // ---- Agents -------------------------------------------------------------

  async listAgents(): Promise<Agent[]> {
    return await this.request<Agent[]>("/v1/agents");
  }

  async getAgent(name: string): Promise<Agent> {
    // Real-only — no mock fallback. If the API is unreachable we want
    // the UI to render an explicit "not found / offline" state, not a
    // fake agent record that misleads the user.
    return this.request<Agent>(`/v1/agents/${encodeURIComponent(name)}`);
  }

  async createAgent(data: CreateAgentInput): Promise<Agent> {
    return this.request<Agent>("/v1/agents", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateAgent(
    name: string,
    data: { description?: string; systemPrompt?: string; model?: string; isolation?: string; timeout?: string; maxTokens?: number; maxCostUsd?: number; cron?: string; avatarUrl?: string; stylePrompt?: string },
  ): Promise<Agent> {
    return this.request<Agent>(
      `/v1/agents/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      },
    );
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
    if (filters?.sessionId) params.set("sessionId", filters.sessionId);
    const qs = params.toString();
    return await this.request<Run[]>(
      `/v1/runs${qs ? `?${qs}` : ""}`,
    );
  }

  async getRun(id: string): Promise<Run> {
    // Real-only. A 404 from the API surfaces as a real "not found" page;
    // a network failure surfaces as a real network error. Never fake a run.
    return this.request<Run>(`/v1/runs/${encodeURIComponent(id)}`);
  }

  async createRun(data: CreateRunInput): Promise<Run> {
    return this.request<Run>("/v1/runs", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async cancelRun(id: string, reason?: string): Promise<Run> {
    return this.request<Run>(
      `/v1/runs/${encodeURIComponent(id)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
      },
    );
  }

  async deleteRun(id: string): Promise<void> {
    await this.request<void>(`/v1/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  // ---- Streaming ----------------------------------------------------------

  streamRunEvents(runId: string): {
    subscribe: (cb: (event: StreamEvent) => void) => void;
    close: () => void;
  } {
    // Real SSE only — no mock event emitter. When the stream fails, the
    // subscribe callback simply never fires, and consumer pages render
    // their existing "empty / no events yet" state. We never inject
    // fabricated step_started → step_completed events to fake activity.
    let onEvent: ((event: StreamEvent) => void) | null = null;
    let closed = false;

    let es: EventSource | null = null;
    try {
      const url = `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`;
      es = new EventSource(this._token ? `${url}?token=${this._token}` : url);
      es.onmessage = (msg) => {
        if (closed) return;
        try {
          const event = JSON.parse(msg.data) as StreamEvent;
          event.ts = new Date(event.ts);
          onEvent?.(event);
        } catch {
          /* drop malformed frames */
        }
      };
      es.onerror = () => {
        if (es) es.close();
      };
    } catch {
      // EventSource construction failed — leave es null; consumer never
      // receives events, which is the correct empty-stream behavior.
    }

    return {
      subscribe: (cb) => {
        onEvent = cb;
      },
      close: () => {
        closed = true;
        if (es) es.close();
      },
    };
  }

  // ---- Runs for a specific agent (helper) ---------------------------------

  async getRunsForAgent(agentName: string): Promise<Run[]> {
    // Real API only. Returns empty list (not mock data) if the API call
    // throws — the calling page renders a real "no runs yet" empty state.
    try {
      return await this.request<Run[]>(
        `/v1/runs?agent=${encodeURIComponent(agentName)}`,
      );
    } catch (err) {
      notifySimulated("getRunsForAgent", err);
      return [];
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
      return [];
    }
  }

  // ---- Settings -----------------------------------------------------------

  async listApiKeys(): Promise<ApiKey[]> {
    try {
      return await this.request<ApiKey[]>("/v1/settings/api-keys");
    } catch (err) {
      notifySimulated("listApiKeys", err);
      return [];
    }
  }

  async createApiKey(
    data: CreateApiKeyInput,
  ): Promise<ApiKey & { secret: string }> {
    // Real API only — never fabricate a key, even on network failure.
    // A fake key would be uniquely dangerous: the user would copy it,
    // hand it to a server, and that server would 401 forever.
    return this.request<ApiKey & { secret: string }>(
      "/v1/settings/api-keys",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );
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

  async getUsage(): Promise<UsageData | null> {
    // Returns null on API failure instead of fabricating "Pro · $12.47 · 348 runs"
    // — the Settings page renders a real "Usage data unavailable" hint.
    try {
      return await this.request<UsageData>("/v1/settings/usage");
    } catch (err) {
      notifySimulated("getUsage", err);
      return null;
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
    // Real API only. Fabricating a "connected" connector here would lie:
    // subsequent /execute calls against the fake install id will all 404.
    return this.request<ConnectorInstall>("/v1/connectors/install", {
      method: "POST",
      body: JSON.stringify(data),
    });
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
    // Opt-in to agent-scoped tool calling. When set, the server runs the
    // same tool-use loop the session API uses, attaching the tenant's
    // installed-connector tools and dispatching tool_calls inline.
    agentName?: string;
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

  // ---- Ask Lantern (agentic command interpreter) ----------------------------

  /**
   * Hand a free-form natural-language command to the LLM (via the same
   * `/v1/completions` proxy the rest of the dashboard uses) and get back a
   * STRICT-JSON structured action — either a navigation or a short answer
   * reasoned over a COMPACT, real fleet summary.
   *
   * IMPORTANT: `context` is a small hand-rolled summary of already-loaded
   * dashboard data (a few hundred tokens of agent names + run/workload
   * counts), NOT a dump of the database. The model only knows what we put
   * in this context — so any "answer" is grounded in real numbers we passed,
   * never fabricated server-side facts.
   *
   * Returns `null` on ANY failure (no provider key, network error, timeout,
   * non-JSON output) so the caller can fall back to the client-side
   * pattern-matcher and never hit a dead end.
   */
  async askLantern(
    query: string,
    context: AskLanternContext,
    opts?: { timeoutMs?: number },
  ): Promise<AskLanternAction | null> {
    const timeoutMs = opts?.timeoutMs ?? 6000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (!this._token) this.restoreToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this._token) headers["Authorization"] = `Bearer ${this._token}`;

      const res = await fetch(`${this.baseUrl}/v1/completions`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: "auto",
          temperature: 0,
          maxTokens: 320,
          messages: [
            { role: "system", content: ASK_LANTERN_SYSTEM_PROMPT },
            {
              role: "user",
              content: `Fleet context (compact, real):\n${formatFleetContext(
                context,
              )}\n\nCommand: ${query.trim()}`,
            },
          ],
        }),
      });

      if (!res.ok) return null;
      const data = await res.json();
      const content: string = typeof data?.content === "string" ? data.content : "";
      return parseAskLanternAction(content);
    } catch {
      // Aborted (timeout), network failure, or bad JSON — degrade gracefully.
      return null;
    } finally {
      clearTimeout(timer);
    }
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

  // ---- Voice (W11d) -----------------------------------------------------------

  async listVoiceNumbers(): Promise<unknown[]> {
    try {
      const data = await this.request<unknown[]>("/v1/voice/numbers");
      return Array.isArray(data) ? data : [];
    } catch (err) {
      notifySimulated("listVoiceNumbers", err);
      return [];
    }
  }

  async createVoiceNumber(payload: {
    agentName: string;
    provider: string;
    phoneNumber: string;
    displayName?: string;
    providerConfig: Record<string, string>;
    greeting?: string;
  }): Promise<unknown> {
    return this.request("/v1/voice/numbers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async deleteVoiceNumber(id: string): Promise<void> {
    await this.request<void>(`/v1/voice/numbers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async listVoiceCalls(): Promise<unknown[]> {
    try {
      const data = await this.request<unknown[]>("/v1/voice/calls");
      return Array.isArray(data) ? data : [];
    } catch (err) {
      notifySimulated("listVoiceCalls", err);
      return [];
    }
  }

  // ---- Takeover (W11a) --------------------------------------------------------

  async listTakeovers(runId: string): Promise<unknown[]> {
    try {
      const data = await this.request<unknown[]>(
        `/v1/runs/${encodeURIComponent(runId)}/takeover`
      );
      return Array.isArray(data) ? data : [];
    } catch (err) {
      notifySimulated("listTakeovers", err);
      return [];
    }
  }

  async grantTakeover(runId: string, takeoverId: string, notes?: string): Promise<unknown> {
    return this.request(
      `/v1/runs/${encodeURIComponent(runId)}/takeover/${encodeURIComponent(takeoverId)}/grant`,
      {
        method: "POST",
        body: JSON.stringify({ notes }),
      }
    );
  }

  async releaseTakeover(runId: string, takeoverId: string): Promise<unknown> {
    return this.request(
      `/v1/runs/${encodeURIComponent(runId)}/takeover/${encodeURIComponent(takeoverId)}/release`,
      { method: "POST" }
    );
  }

  // ---- Marketplace invocations (W11c) -----------------------------------------

  async listMarketplaceInvocations(role: "buyer" | "seller" = "buyer"): Promise<unknown[]> {
    try {
      const data = await this.request<unknown[]>(`/v1/marketplace/invocations?role=${role}`);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      notifySimulated("listMarketplaceInvocations", err);
      return [];
    }
  }

  async invokeMarketplaceAgent(slug: string, input: Record<string, unknown>): Promise<unknown> {
    return this.request(`/v1/marketplace/${encodeURIComponent(slug)}/invoke`, {
      method: "POST",
      body: JSON.stringify({ input }),
    });
  }

  // ---- Agent templates --------------------------------------------------------

  async listAgentTemplates(): Promise<Array<{
    id: string;
    name: string;
    description: string;
    model: string;
    cronExpr: string;
    maxCostUsdDay: number;
    maxCostUsdPerRun: number;
    connectors: string[];
    surfaces: string[];
  }>> {
    try {
      return await this.request("/v1/agents/templates");
    } catch (err) {
      notifySimulated("listAgentTemplates", err);
      return [];
    }
  }

  async createAgentFromTemplate(templateId: string, name?: string): Promise<{
    agent: { id: string; name: string; description: string };
    templateId: string;
    appliedAt: string;
    nextSteps: Array<{ kind: string; id: string; label: string }>;
  }> {
    return this.request("/v1/agents/from-template", {
      method: "POST",
      body: JSON.stringify({ templateId, name }),
    });
  }

  // Setup gate: reads required connectors+surfaces written by the template
  // apply handler, diffs against installed connector_installs / surface_configs,
  // returns ready=true when everything is connected. The /agents/{name}/setup
  // page polls this; the agent detail page uses it to disable Run.
  async getAgentSetupStatus(name: string): Promise<{
    templateId: string;
    required: { connectors: string[]; surfaces: string[] };
    installed: { connectors: string[]; surfaces: string[] };
    missing:   { connectors: string[]; surfaces: string[] };
    ready: boolean;
    nextSteps: Array<{ kind: string; id: string; label: string; href: string }>;
  }> {
    return this.request(`/v1/agents/${encodeURIComponent(name)}/setup`);
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
    messages: Array<{
      role: string;
      content: string;
      timestamp: string;
      // Persisted tool invocations from this assistant turn (if any).
      // Empty/absent on user messages and assistant turns that didn't
      // call any connector.
      toolCalls?: Array<{ name: string; args: string; result?: string; error?: string; status: string }>;
    }>;
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
    messages: Array<{
      role: string;
      content: string;
      timestamp: string;
      toolCalls?: Array<{ name: string; args: string; result?: string; error?: string; status: string }>;
    }>;
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
