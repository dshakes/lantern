import { z } from "zod";
import type {
  Agent,
  BudgetPolicy,
  ConnectorInfo,
  ConnectorResult,
  EvalBaseline,
  EvalCase,
  EvalCaseResult,
  EvalRun,
  EvalSuite,
  Experiment,
  FeedbackEntry,
  FeedbackSummary,
  ForecastResult,
  MarketplaceAgent,
  McpAttachment,
  McpServer,
  ReceiptVerifyResult,
  RehearseResponse,
  Run,
  Session,
  SessionEvent,
  SessionStreamEvent,
  SignedReceipt,
  StreamEvent,
} from "./types.js";
import { isNetworkError, withRetry } from "./retry.js";

// ---------------------------------------------------------------------------
// Zod schemas for session streaming events (untrusted SSE data)
// ---------------------------------------------------------------------------

const messageDeltaSchema = z.object({
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  seq: z.number().int().positive(),
  delta: z.string(),
});

const messageCompletedSchema = z.object({
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  text: z.string(),
  usage: z.object({
    tokensIn: z.number(),
    tokensOut: z.number(),
    costUsd: z.number(),
  }),
});

const messageErrorSchema = z.object({
  turnId: z.string().optional(),
  error: z.string(),
});

export interface LanternClientConfig {
  baseUrl?: string;
  /** Alias for baseUrl (matches the README's casing). Either works. */
  baseURL?: string;
  apiKey?: string;
}

export class LanternClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: LanternClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? config.baseURL ?? process.env.LANTERN_API_URL ?? "https://api.lantern.run";
    this.apiKey = config.apiKey ?? process.env.LANTERN_API_KEY ?? "";
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    return withRetry(
      async () => {
        const res = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: { ...this.headers(), ...init?.headers },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new LanternApiError(res.status, body);
        }
        if (res.status === 204) return undefined as T;
        return res.json() as Promise<T>;
      },
      {
        // 429/503 only — never 4xx auth/validation, never other 5xx.
        shouldRetry: (err) =>
          (err instanceof LanternApiError && (err.status === 429 || err.status === 503)) || isNetworkError(err),
      },
    );
  }

  /** Builds a `?a=1&b=2` query string, dropping undefined/null values. */
  private qs(params?: Record<string, string | number | boolean | undefined | null>): string {
    if (!params) return "";
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) usp.set(k, String(v));
    }
    const s = usp.toString();
    return s ? `?${s}` : "";
  }

  readonly agents = {
    create: (params: { name: string; description?: string; labels?: Record<string, string> }): Promise<Agent> =>
      this.fetch("/v1/agents", { method: "POST", body: JSON.stringify(params) }),

    get: (name: string): Promise<Agent> =>
      this.fetch(`/v1/agents/${encodeURIComponent(name)}`),

    // ListAgents (rest.go) writes a BARE JSON array, not `{agents:[...]}`.
    // pageSize/pageToken aren't read server-side yet; sent for forward-compat.
    list: async (params?: { pageSize?: number; pageToken?: string }): Promise<{ agents: Agent[]; nextPageToken?: string }> => ({
      agents: await this.fetch<Agent[]>(`/v1/agents${this.qs(params)}`),
    }),

    delete: (name: string): Promise<void> =>
      this.fetch(`/v1/agents/${encodeURIComponent(name)}`, { method: "DELETE" }),
  };

  readonly runs = {
    create: async (params: {
      agent: string;
      input: unknown;
      stream?: boolean;
      labels?: Record<string, string>;
      idempotencyKey?: string;
    }): Promise<Run | AsyncIterable<StreamEvent>> => {
      if (params.stream) {
        return this.streamRun(params);
      }
      return this.fetch<Run>("/v1/runs", {
        method: "POST",
        // Field names must match the control-plane handler's camelCase
        // contract (rest.go CreateRun: agentName/input/sessionId).
        body: JSON.stringify({
          agentName: params.agent,
          input: params.input,
          labels: params.labels,
          idempotency_key: params.idempotencyKey,
        }),
      });
    },

    get: (id: string): Promise<Run> =>
      this.fetch(`/v1/runs/${id}`),

    // ListRuns (rest.go) writes a BARE JSON array, not `{runs:[...]}`.
    // pageSize/pageToken aren't read server-side yet; sent for forward-compat.
    list: async (params?: {
      agent?: string;
      status?: string;
      pageSize?: number;
      pageToken?: string;
    }): Promise<{ runs: Run[]; nextPageToken?: string }> => ({
      runs: await this.fetch<Run[]>(`/v1/runs${this.qs(params)}`),
    }),

    cancel: (id: string, reason?: string): Promise<Run> =>
      this.fetch(`/v1/runs/${id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),

    events: (runId: string, opts?: { fromSeq?: number; live?: boolean }): AsyncIterable<StreamEvent> =>
      this.sseStream(`/v1/runs/${runId}/events?from_seq=${opts?.fromSeq ?? 0}&live=${opts?.live ?? true}`),

    signal: (runId: string, name: string, value?: unknown): Promise<void> =>
      this.fetch(`/v1/runs/${runId}/signals/${name}`, {
        method: "POST",
        body: JSON.stringify({ value }),
      }),

    /** Pre-run cost/token forecast. `wouldExceedBudget` is set when a
     *  hard-fail budget would block this run. */
    forecast: (params: { agentName: string; input: string; model?: string }): Promise<ForecastResult> =>
      this.fetch("/v1/runs/forecast", {
        method: "POST",
        body: JSON.stringify(params),
      }),
  };

  readonly sessions = {
    create: (params: { agent: string; environment?: Record<string, string> }): Promise<{ id: string; status: string }> =>
      this.fetch("/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ agentName: params.agent, environment: params.environment ?? {} }),
      }),

    get: (id: string): Promise<Session> => this.fetch(`/v1/sessions/${encodeURIComponent(id)}`),

    // ListSessions (sessions.go) writes a BARE JSON array. agent/status/paging
    // filters aren't read server-side yet; sent for forward-compat.
    list: async (params?: {
      agent?: string;
      status?: string;
      pageSize?: number;
      pageToken?: string;
    }): Promise<{ sessions: Session[]; nextPageToken?: string }> => ({
      sessions: await this.fetch<Session[]>(`/v1/sessions${this.qs(params)}`),
    }),

    /** Appends the message and kicks off the LLM turn asynchronously — the
     *  reply arrives via `sessions.events()`, not this call's return value. */
    sendMessage: (
      sessionId: string,
      params: {
        content: string;
        attachments?: string[];
        systemHint?: string;
        turnHint?: string;
        noTools?: boolean;
        readOnlyTools?: boolean;
      },
    ): Promise<{ status: string }> =>
      this.fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        body: JSON.stringify(params),
      }),

    events: (sessionId: string): AsyncIterable<SessionEvent> =>
      this.sessionSSE(`/v1/sessions/${encodeURIComponent(sessionId)}/events`),

    /** Posts the message, then yields streaming chunks as the assistant replies.
     *  Yields `{type:"delta", delta}` per token and a final
     *  `{type:"completed", text, usage}` when the turn is done.
     *  Throws `MessageStreamError` on `message_error` events.
     *
     *  Out-of-order seq values are buffered and yielded in order. Unknown
     *  event kinds (including all pre-existing session events) are silently
     *  ignored so old and new servers are both handled. */
    streamMessage: (
      sessionId: string,
      params: {
        content: string;
        attachments?: string[];
        systemHint?: string;
        turnHint?: string;
        noTools?: boolean;
        readOnlyTools?: boolean;
      },
    ): AsyncIterable<SessionStreamEvent> => this.streamSessionMessage(sessionId, params),

    stop: (sessionId: string): Promise<{ status: string }> =>
      this.fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST" }),

    delete: (sessionId: string): Promise<void> =>
      this.fetch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),

    /** Deprecated alias for delete() — the route is DELETE, not POST /close. */
    close: (sessionId: string): Promise<void> => this.sessions.delete(sessionId),
  };

  readonly connectors = {
    // ListConnectors writes a BARE JSON array.
    list: (): Promise<ConnectorInfo[]> => this.fetch("/v1/connectors"),

    get: (connectorId: string): Promise<ConnectorInfo> =>
      this.fetch(`/v1/connectors/${encodeURIComponent(connectorId)}`),

    /** `action` is sent as a query param; `params` is the raw JSON body
     *  (no wrapper — see connector_executor.go Execute). */
    execute: (connectorId: string, action: string, params?: Record<string, unknown>): Promise<ConnectorResult> =>
      this.fetch(`/v1/connectors/${encodeURIComponent(connectorId)}/execute${this.qs({ action })}`, {
        method: "POST",
        body: JSON.stringify(params ?? {}),
      }),

    test: (connectorId: string): Promise<Record<string, unknown>> =>
      this.fetch(`/v1/connectors/${encodeURIComponent(connectorId)}/test`, { method: "POST" }),

    uninstall: (connectorId: string): Promise<void> =>
      this.fetch(`/v1/connectors/${encodeURIComponent(connectorId)}`, { method: "DELETE" }),
  };

  readonly budgets = {
    upsert: (
      agentName: string,
      params: {
        maxCostUsdPerDay?: number;
        maxCostUsdPerRun?: number;
        maxTokensPerDay?: number;
        maxRunsPerDay?: number;
        toolLimits?: Record<string, number>;
        hardFail?: boolean;
        notifyAtPct?: number;
      },
    ): Promise<{ status: string }> =>
      this.fetch(`/v1/agents/${encodeURIComponent(agentName)}/budget`, {
        method: "PUT",
        body: JSON.stringify({ hardFail: false, ...params }),
      }),

    get: (agentName: string): Promise<BudgetPolicy> =>
      this.fetch(`/v1/agents/${encodeURIComponent(agentName)}/budget`),

    delete: (agentName: string): Promise<void> =>
      this.fetch(`/v1/agents/${encodeURIComponent(agentName)}/budget`, { method: "DELETE" }),

    // ListBudgets writes a BARE JSON array.
    list: (): Promise<BudgetPolicy[]> => this.fetch("/v1/budgets"),
  };

  readonly evalSuites = {
    upsert: (params: { agentName: string; name: string; cases: EvalCase[]; description?: string }): Promise<{ id: string }> =>
      this.fetch("/v1/eval-suites", { method: "POST", body: JSON.stringify(params) }),

    // ListSuites writes a BARE JSON array.
    list: (params?: { agentName?: string }): Promise<EvalSuite[]> =>
      this.fetch(`/v1/eval-suites${this.qs(params)}`),

    get: (id: string): Promise<EvalSuite> => this.fetch(`/v1/eval-suites/${encodeURIComponent(id)}`),

    delete: (id: string): Promise<void> =>
      this.fetch(`/v1/eval-suites/${encodeURIComponent(id)}`, { method: "DELETE" }),
  };

  readonly evalRuns = {
    /** Returns HTTP 422 (thrown as LanternApiError) if regressed vs. the
     *  branch baseline. */
    record: (params: {
      suiteId: string;
      caseResults: EvalCaseResult[];
      agentVersion?: string;
      commitSha?: string;
      branch?: string;
      durationMs?: number;
      totalCostUsd?: number;
    }): Promise<EvalRun> =>
      this.fetch("/v1/eval-runs", {
        method: "POST",
        body: JSON.stringify({ durationMs: 0, totalCostUsd: 0, ...params }),
      }),

    // ListRuns writes a BARE JSON array.
    list: (params?: { suiteId?: string; agentName?: string; branch?: string }): Promise<EvalRun[]> =>
      this.fetch(`/v1/eval-runs${this.qs(params)}`),
  };

  readonly evalBaselines = {
    set: (params: { agentName: string; branch: string; evalRunId: string }): Promise<{ status: string }> =>
      this.fetch("/v1/eval-baselines", { method: "POST", body: JSON.stringify(params) }),

    get: (params: { agentName: string; branch: string }): Promise<EvalBaseline> =>
      this.fetch(`/v1/eval-baselines${this.qs(params)}`),
  };

  readonly experiments = {
    create: (params: {
      agentName: string;
      name: string;
      variantAVersion: string;
      variantBVersion: string;
      trafficSplitB?: number;
      evalSuiteId?: string;
      autoPromote?: boolean;
      minRunsToPromote?: number;
    }): Promise<{ id: string }> =>
      this.fetch("/v1/experiments", {
        method: "POST",
        body: JSON.stringify({ trafficSplitB: 50, autoPromote: false, minRunsToPromote: 0, ...params }),
      }),

    // List writes a BARE JSON array.
    list: (): Promise<Experiment[]> => this.fetch("/v1/experiments"),

    get: (id: string): Promise<Experiment> => this.fetch(`/v1/experiments/${encodeURIComponent(id)}`),

    recordOutcome: (id: string, params: { variant: "a" | "b"; score: number }): Promise<void> =>
      this.fetch(`/v1/experiments/${encodeURIComponent(id)}/record`, {
        method: "POST",
        body: JSON.stringify(params),
      }),

    conclude: (id: string, params: { winner: "a" | "b" | "tie"; promote?: boolean }): Promise<void> =>
      this.fetch(`/v1/experiments/${encodeURIComponent(id)}/conclude`, {
        method: "POST",
        body: JSON.stringify({ promote: false, ...params }),
      }),
  };

  readonly marketplace = {
    // List writes a BARE JSON array.
    list: (params?: { category?: string; query?: string }): Promise<MarketplaceAgent[]> =>
      this.fetch(`/v1/marketplace${this.qs({ category: params?.category, q: params?.query })}`),

    get: (slug: string): Promise<MarketplaceAgent> => this.fetch(`/v1/marketplace/${encodeURIComponent(slug)}`),

    /** Slug is server-generated (`<tenant-slug>-<agentName>`, see marketplace.go
     *  Publish) — there is no client-supplied slug to pass in. */
    publish: (params: {
      agentName: string;
      category: string;
      tags?: string[];
      description?: string;
      readme?: string;
    }): Promise<{ id: string; slug: string; url: string }> =>
      this.fetch("/v1/marketplace/publish", {
        method: "POST",
        body: JSON.stringify({ tags: [], ...params }),
      }),

    fork: (slug: string, newName: string): Promise<{ agentId: string; agentName: string }> =>
      this.fetch(`/v1/marketplace/${encodeURIComponent(slug)}/fork`, {
        method: "POST",
        body: JSON.stringify({ newName }),
      }),

    star: (slug: string): Promise<{ starred: boolean }> =>
      this.fetch(`/v1/marketplace/${encodeURIComponent(slug)}/star`, { method: "POST" }),

    unstar: (slug: string): Promise<{ starred: boolean }> =>
      this.fetch(`/v1/marketplace/${encodeURIComponent(slug)}/star`, { method: "DELETE" }),
  };

  readonly mcp = {
    // ListServers writes a BARE JSON array.
    listServers: (params?: { category?: string; query?: string }): Promise<McpServer[]> =>
      this.fetch(`/v1/mcp/servers${this.qs({ category: params?.category, q: params?.query })}`),

    getServer: (slug: string): Promise<McpServer> => this.fetch(`/v1/mcp/servers/${encodeURIComponent(slug)}`),

    attach: (agentName: string, slug: string, config?: Record<string, unknown>): Promise<{ status: string }> =>
      this.fetch(`/v1/agents/${encodeURIComponent(agentName)}/mcp-servers`, {
        method: "POST",
        body: JSON.stringify({ serverSlug: slug, config: config ?? {} }),
      }),

    detach: (agentName: string, slug: string): Promise<void> =>
      this.fetch(`/v1/agents/${encodeURIComponent(agentName)}/mcp-servers/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      }),

    // ListAttachments writes a BARE JSON array.
    listAttachments: (agentName: string): Promise<McpAttachment[]> =>
      this.fetch(`/v1/agents/${encodeURIComponent(agentName)}/mcp-servers`),
  };

  readonly receipts = {
    issue: (runId: string): Promise<SignedReceipt> =>
      this.fetch(`/v1/runs/${encodeURIComponent(runId)}/receipt`, { method: "POST" }),

    /** No auth required — verifies the signature against the embedded payload. */
    verify: (receipt: SignedReceipt): Promise<ReceiptVerifyResult> =>
      this.fetch("/v1/runs/receipts/verify", { method: "POST", body: JSON.stringify(receipt) }),
  };

  readonly feedback = {
    submit: (
      runId: string,
      params: { score: number; comment?: string; preferredOutput?: string; source?: string },
    ): Promise<void> =>
      this.fetch(`/v1/runs/${encodeURIComponent(runId)}/feedback`, {
        method: "POST",
        body: JSON.stringify({ source: "sdk", ...params }),
      }),

    // ListFeedback writes a BARE JSON array.
    listForRun: (runId: string): Promise<FeedbackEntry[]> =>
      this.fetch(`/v1/runs/${encodeURIComponent(runId)}/feedback`),

    summaryForAgent: (agentName: string): Promise<FeedbackSummary> =>
      this.fetch(`/v1/agents/${encodeURIComponent(agentName)}/feedback`),
  };

  readonly rehearsals = {
    /** Pulls past failed/low-score runs as synthetic test cases — replay them
     *  and post the results through evalRuns.record() to gate a merge. */
    pull: (params: {
      agentName: string;
      window?: string;
      includeFailures?: boolean;
      includeLowScore?: boolean;
      limit?: number;
    }): Promise<RehearseResponse> =>
      this.fetch("/v1/runs/rehearse", {
        method: "POST",
        body: JSON.stringify({ includeFailures: true, includeLowScore: true, ...params }),
      }),
  };

  private async *streamSessionMessage(
    sessionId: string,
    params: {
      content: string;
      attachments?: string[];
      systemHint?: string;
      turnHint?: string;
      noTools?: boolean;
      readOnlyTools?: boolean;
    },
  ): AsyncIterable<SessionStreamEvent> {
    // Open the SSE connection before posting so we don't miss early deltas.
    const sseUrl = `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`;
    const sseRes = await fetch(sseUrl, {
      headers: { ...this.headers(), Accept: "text/event-stream" },
    });
    if (!sseRes.ok) {
      const body = await sseRes.text().catch(() => "");
      throw new LanternApiError(sseRes.status, body);
    }

    // Post the message to trigger the turn.
    await this.sessions.sendMessage(sessionId, params);

    // Buffer for out-of-order deltas: seq → delta string.
    const pending = new Map<number, string>();
    let nextSeq = 1;

    for await (const { event, data } of this.rawSSEWithEvent(sseRes)) {
      if (event === "message_delta") {
        let parsed: { seq: number; delta: string };
        try {
          parsed = messageDeltaSchema.parse(JSON.parse(data));
        } catch {
          continue; // malformed — skip
        }
        pending.set(parsed.seq, parsed.delta);
        // Yield all contiguous buffered deltas in seq order.
        while (pending.has(nextSeq)) {
          yield { type: "delta", delta: pending.get(nextSeq)! };
          pending.delete(nextSeq);
          nextSeq++;
        }
      } else if (event === "message_completed") {
        let parsed: { text: string; usage: { tokensIn: number; tokensOut: number; costUsd: number } };
        try {
          parsed = messageCompletedSchema.parse(JSON.parse(data));
        } catch {
          return; // malformed completed — stop without error
        }
        yield { type: "completed", text: parsed.text, usage: parsed.usage };
        return;
      } else if (event === "message_error") {
        let detail = "stream error";
        try {
          detail = messageErrorSchema.parse(JSON.parse(data)).error;
        } catch { /* use default */ }
        throw new MessageStreamError(detail);
      }
      // All other event kinds (agent.message, agent.thinking, etc.) are ignored
      // so the iterator is forward-compatible with unknown event types.
    }
  }

  private async *streamRun(params: {
    agent: string;
    input: unknown;
    labels?: Record<string, string>;
    idempotencyKey?: string;
  }): AsyncIterable<StreamEvent> {
    const res = await fetch(`${this.baseUrl}/v1/runs`, {
      method: "POST",
      headers: { ...this.headers(), Accept: "text/event-stream" },
      body: JSON.stringify({
        agentName: params.agent,
        input: params.input,
        stream: true,
        labels: params.labels,
        idempotency_key: params.idempotencyKey,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LanternApiError(res.status, body);
    }

    yield* this.parseSSE(res);
  }

  private async *sseStream(path: string): AsyncIterable<StreamEvent> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { ...this.headers(), Accept: "text/event-stream" },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LanternApiError(res.status, body);
    }

    yield* this.parseSSE(res);
  }

  private async *parseSSE(res: Response): AsyncIterable<StreamEvent> {
    for await (const data of this.rawSSELines(res)) {
      try {
        const event = JSON.parse(data) as StreamEvent;
        event.ts = new Date(event.ts as unknown as string);
        yield event;
        if (event.kind === "end") return;
      } catch {
        // skip malformed events
      }
    }
  }

  /** Session events (`{type,data,timestamp}`) are shaped differently from
   *  run StreamEvents and the stream has no "end" sentinel — it stays open
   *  until the caller cancels (see sessions.go GetEvents). */
  private async *sessionSSE(path: string): AsyncIterable<SessionEvent> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { ...this.headers(), Accept: "text/event-stream" },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LanternApiError(res.status, body);
    }

    for await (const data of this.rawSSELines(res)) {
      try {
        yield JSON.parse(data) as SessionEvent;
      } catch {
        // skip malformed events
      }
    }
  }

  /** Parses an SSE response body, yielding `{event, data}` pairs per SSE
   *  block. Tracks the `event:` field so named events are attributed
   *  correctly; defaults to `"message"` (the SSE spec default) when the
   *  block has no `event:` line. */
  private async *rawSSEWithEvent(res: Response): AsyncIterable<{ event: string; data: string }> {
    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";
    let pendingEvent = "message";
    let pendingData = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const raw of lines) {
          const line = raw.trimEnd(); // strip \r from CRLF lines
          if (line === "") {
            // Blank line dispatches the accumulated event block.
            if (pendingData !== "") {
              yield { event: pendingEvent, data: pendingData };
            }
            pendingEvent = "message";
            pendingData = "";
          } else if (line.startsWith("event:")) {
            pendingEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            pendingData = line.slice(5).trim();
          }
          // comment lines (":" prefix) and unknown fields are silently ignored
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Reads an SSE response body and yields each `data: ` line's payload
   *  (raw string, un-parsed). Stops on `[DONE]` or stream end. */
  private async *rawSSELines(res: Response): AsyncIterable<string> {
    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "[DONE]") return;
            yield data;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export class LanternApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Lantern API error ${status}: ${body.slice(0, 200)}`);
    this.name = "LanternApiError";
  }
}

/** Thrown by `sessions.streamMessage()` when the server emits a
 *  `message_error` event on the SSE stream. */
export class MessageStreamError extends Error {
  constructor(public readonly detail: string) {
    super(`Session stream error: ${detail}`);
    this.name = "MessageStreamError";
  }
}
