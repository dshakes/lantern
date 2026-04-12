import type { Agent, Run, StreamEvent } from "./types.js";

export interface LanternClientConfig {
  baseUrl?: string;
  apiKey?: string;
}

export class LanternClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: LanternClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? process.env.LANTERN_API_URL ?? "https://api.lantern.run";
    this.apiKey = config.apiKey ?? process.env.LANTERN_API_KEY ?? "";
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...init?.headers },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new LanternApiError(res.status, body);
    }
    return res.json() as Promise<T>;
  }

  readonly agents = {
    create: (params: { name: string; description?: string; labels?: Record<string, string> }): Promise<Agent> =>
      this.fetch("/v1/agents", { method: "POST", body: JSON.stringify(params) }),

    get: (name: string): Promise<Agent> =>
      this.fetch(`/v1/agents/${encodeURIComponent(name)}`),

    list: (params?: { pageSize?: number; pageToken?: string }): Promise<{ agents: Agent[]; nextPageToken?: string }> =>
      this.fetch(`/v1/agents?${new URLSearchParams(params as Record<string, string>)}`),

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
        body: JSON.stringify({
          agent_name: params.agent,
          input: params.input,
          labels: params.labels,
          idempotency_key: params.idempotencyKey,
        }),
      });
    },

    get: (id: string): Promise<Run> =>
      this.fetch(`/v1/runs/${id}`),

    list: (params?: {
      agent?: string;
      status?: string;
      pageSize?: number;
      pageToken?: string;
    }): Promise<{ runs: Run[]; nextPageToken?: string }> =>
      this.fetch(`/v1/runs?${new URLSearchParams(params as Record<string, string>)}`),

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
  };

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
        agent_name: params.agent,
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
