import type { Logger } from "pino";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

import { authedFetch, authEnabled, apiBaseUrl, currentToken } from "./auth";

const SSE_TIMEOUT_MS = 90_000;

export class AgentClient {
  private agentName: string;
  private logger: Logger;
  private sessionsFile: string;
  // jid -> sessionId
  private sessions: Map<string, string> = new Map();
  // jid -> pending reply resolver (prevents overlapping requests from one contact)
  private inflight: Map<string, Promise<string | null>> = new Map();
  // Cached per-agent style prompt fetched from the control-plane. Refreshed
  // lazily with a small TTL so edits to the "my voice" textarea on the
  // dashboard show up within ~30s without a per-turn round trip.
  private cachedStylePrompt: string | undefined = undefined;
  private styleFetchedAt = 0;
  private static readonly STYLE_TTL_MS = 30_000;

  constructor(logger: Logger, tenantAuthDir: string) {
    this.agentName = process.env.LANTERN_AGENT_NAME || "whatsapp-assistant";
    this.logger = logger.child({ component: "agent" });
    this.sessionsFile = join(tenantAuthDir, "agent_sessions.json");
    this.loadSessions();
  }

  enabled(): boolean {
    return authEnabled();
  }

  async respondTo(
    jid: string,
    userText: string,
    systemHint?: string
  ): Promise<string | null> {
    if (!this.enabled()) return null;

    // Serialize per-contact so messages in quick succession don't race.
    const prev = this.inflight.get(jid) ?? Promise.resolve<string | null>(null);
    const next = prev.then(() => this.runTurn(jid, userText, systemHint)).catch((err) => {
      this.logger.error({ err, jid }, "turn errored");
      return null;
    });
    this.inflight.set(jid, next);
    const reply = await next;
    if (this.inflight.get(jid) === next) this.inflight.delete(jid);
    return reply;
  }

  private async runTurn(
    jid: string,
    userText: string,
    systemHint?: string
  ): Promise<string | null> {
    const sessionId = await this.ensureSession(jid);
    if (!sessionId) return null;

    // Open SSE first so we don't miss the response event.
    const sseCtrl = new AbortController();
    const ssePromise = this.waitForAgentMessage(sessionId, sseCtrl.signal);

    // systemHint, when present, replaces the agent's stored system prompt
    // for this turn only — used by the bridge to ship the natural-texting
    // persona with thread-specific style cues.
    const postBody: Record<string, unknown> = { content: userText };
    if (systemHint) postBody.systemHint = systemHint;

    const postRes = await authedFetch(
      `/v1/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody),
      }
    );

    if (!postRes.ok) {
      sseCtrl.abort();
      const body = await postRes.text().catch(() => "");
      this.logger.error(
        { status: postRes.status, body: body.slice(0, 300), sessionId },
        "send message failed"
      );
      // Treat a 404 as a stale session — drop it so next turn re-creates.
      if (postRes.status === 404) {
        this.sessions.delete(jid);
        this.saveSessions();
      }
      return null;
    }

    const reply = await ssePromise;
    return reply;
  }

  private async ensureSession(jid: string): Promise<string | null> {
    const existing = this.sessions.get(jid);
    if (existing) return existing;

    const res = await authedFetch(`/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName: this.agentName }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.logger.error(
        { status: res.status, body: body.slice(0, 300), jid },
        "create session failed"
      );
      return null;
    }

    const data = (await res.json()) as { id?: string };
    if (!data.id) return null;
    this.sessions.set(jid, data.id);
    this.saveSessions();
    return data.id;
  }

  private async waitForAgentMessage(
    sessionId: string,
    signal: AbortSignal
  ): Promise<string | null> {
    const ctrl = new AbortController();
    signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    const timeoutId = setTimeout(() => ctrl.abort(), SSE_TIMEOUT_MS);

    try {
      const res = await authedFetch(
        `/v1/sessions/${sessionId}/events`,
        {
          headers: { Accept: "text/event-stream" },
          signal: ctrl.signal,
        }
      );

      if (!res.ok || !res.body) {
        this.logger.error({ status: res.status, sessionId }, "SSE stream failed");
        return null;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) return null;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLine = raw
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const evt = JSON.parse(dataLine.slice(6)) as {
              type?: string;
              data?: { content?: string };
            };
            if (evt.type === "agent.message" && evt.data?.content) {
              ctrl.abort();
              return evt.data.content;
            }
          } catch {
            // ignore malformed frames
          }
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        this.logger.error({ err, sessionId }, "SSE read errored");
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  clearHistory(jid: string) {
    this.sessions.delete(jid);
    this.saveSessions();
  }

  // Fetch the agent's style_prompt from the control-plane, cached for
  // STYLE_TTL_MS. Returns undefined when not set or unreachable.
  async getStylePrompt(): Promise<string | undefined> {
    if (!this.enabled()) return undefined;
    if (Date.now() - this.styleFetchedAt < AgentClient.STYLE_TTL_MS) {
      return this.cachedStylePrompt;
    }
    try {
      const res = await authedFetch(
        `/v1/agents/${encodeURIComponent(this.agentName)}`,
        { headers: { Accept: "application/json" } }
      );
      if (!res.ok) {
        this.styleFetchedAt = Date.now();
        return this.cachedStylePrompt;
      }
      const data = (await res.json()) as { stylePrompt?: string };
      this.cachedStylePrompt = data.stylePrompt?.trim() || undefined;
      this.styleFetchedAt = Date.now();
      return this.cachedStylePrompt;
    } catch (err) {
      this.logger.warn({ err }, "fetch agent stylePrompt failed");
      this.styleFetchedAt = Date.now();
      return this.cachedStylePrompt;
    }
  }

  private loadSessions() {
    if (!existsSync(this.sessionsFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.sessionsFile, "utf8")) as Record<string, string>;
      this.sessions = new Map(Object.entries(data));
    } catch (err) {
      this.logger.warn({ err }, "could not load agent_sessions.json, starting fresh");
    }
  }

  private saveSessions() {
    try {
      const obj = Object.fromEntries(this.sessions);
      writeFileSync(this.sessionsFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      this.logger.warn({ err }, "could not persist agent_sessions.json");
    }
  }
}
