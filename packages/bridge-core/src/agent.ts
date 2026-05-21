// Shared AgentClient — both bridges talk to the control-plane's
// /v1/sessions API the same way: create a session per contact, post
// content, await SSE for the agent.message event. The previous
// per-bridge copies were 95% identical (the only difference was the
// agent-name default and whether sessions persisted to disk).
//
// Construction options:
//   - agentName: which agent name to create sessions against. WhatsApp
//     uses 'whatsapp-assistant'; iMessage uses 'imessage-assistant' so
//     the user can give them distinct persona prompts in the dashboard.
//   - sessionsFile: optional path to a JSON file the client should
//     persist its jid→sessionId map to. iMessage doesn't persist
//     (sessions are short-lived anyway).

import { existsSync, readFileSync, writeFileSync } from "fs";
import type { Logger } from "pino";

import { authedFetch, authEnabled } from "./auth.js";

const SSE_TIMEOUT_MS = 90_000;

export interface AgentClientOptions {
  agentName: string;
  sessionsFile?: string;
}

export class AgentClient {
  private agentName: string;
  private logger: Logger;
  private sessionsFile?: string;
  private sessions: Map<string, string> = new Map();
  private inflight: Map<string, Promise<string | null>> = new Map();
  private cachedStylePrompt: string | undefined = undefined;
  private styleFetchedAt = 0;
  private static readonly STYLE_TTL_MS = 30_000;

  constructor(logger: Logger, opts: AgentClientOptions) {
    this.agentName = opts.agentName;
    this.sessionsFile = opts.sessionsFile;
    this.logger = logger.child({ component: "agent", agent: this.agentName });
    if (this.sessionsFile) this.loadSessions();
  }

  enabled(): boolean { return authEnabled(); }

  async respondTo(jid: string, userText: string, systemHint?: string): Promise<string | null> {
    if (!this.enabled()) return null;
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

  private async runTurn(jid: string, userText: string, systemHint?: string): Promise<string | null> {
    const sessionId = await this.ensureSession(jid);
    if (!sessionId) return null;

    const sseCtrl = new AbortController();
    const ssePromise = this.waitForAgentMessage(sessionId, sseCtrl.signal);

    const postBody: Record<string, unknown> = { content: userText };
    if (systemHint) postBody.systemHint = systemHint;

    const postRes = await authedFetch(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(postBody),
    });
    if (!postRes.ok) {
      sseCtrl.abort();
      const body = await postRes.text().catch(() => "");
      this.logger.error({ status: postRes.status, body: body.slice(0, 300), sessionId }, "send message failed");
      if (postRes.status === 404) {
        this.sessions.delete(jid);
        this.saveSessions();
      }
      return null;
    }
    return await ssePromise;
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
      this.logger.error({ status: res.status, body: body.slice(0, 300), jid }, "create session failed");
      return null;
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) return null;
    this.sessions.set(jid, data.id);
    this.saveSessions();
    return data.id;
  }

  private async waitForAgentMessage(sessionId: string, signal: AbortSignal): Promise<string | null> {
    const ctrl = new AbortController();
    signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    const timeoutId = setTimeout(() => ctrl.abort(), SSE_TIMEOUT_MS);
    try {
      const res = await authedFetch(`/v1/sessions/${sessionId}/events`, {
        headers: { Accept: "text/event-stream" },
        signal: ctrl.signal,
      });
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
          const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const evt = JSON.parse(dataLine.slice(6)) as { type?: string; data?: { content?: string } };
            if (evt.type === "agent.message" && evt.data?.content) {
              ctrl.abort();
              return evt.data.content;
            }
          } catch {}
        }
      }
    } catch (err) {
      if (!signal.aborted) this.logger.error({ err, sessionId }, "SSE read errored");
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  clearHistory(jid: string) {
    this.sessions.delete(jid);
    this.saveSessions();
  }

  async getStylePrompt(): Promise<string | undefined> {
    if (!this.enabled()) return undefined;
    if (Date.now() - this.styleFetchedAt < AgentClient.STYLE_TTL_MS) return this.cachedStylePrompt;
    try {
      const res = await authedFetch(`/v1/agents/${encodeURIComponent(this.agentName)}`, {
        headers: { Accept: "application/json" },
      });
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

  private loadSessions(): void {
    if (!this.sessionsFile || !existsSync(this.sessionsFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.sessionsFile, "utf8")) as Record<string, string>;
      this.sessions = new Map(Object.entries(data));
    } catch (err) {
      this.logger.warn({ err }, "could not load agent_sessions.json, starting fresh");
    }
  }

  private saveSessions(): void {
    if (!this.sessionsFile) return;
    try {
      const obj = Object.fromEntries(this.sessions);
      writeFileSync(this.sessionsFile, JSON.stringify(obj, null, 2));
    } catch (err) {
      this.logger.warn({ err }, "could not persist agent_sessions.json");
    }
  }
}
