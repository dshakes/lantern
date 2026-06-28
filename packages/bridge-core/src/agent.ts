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

import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import type { Logger } from "pino";

import { authedFetch, authEnabled } from "./auth.js";
import { withRetry, isTransientError, TransientHttpError } from "./retry.js";

// Tool-driven owner queries can chain search_personal_files →
// read_personal_file (with OCR for scanned PDFs, 5-10s each) → maybe a
// Gmail search → another read. 90s was tight; 180s gives the model
// headroom on multi-tool flows without leaving the user waiting
// indefinitely on the rare runaway.
const SSE_TIMEOUT_MS = Number(process.env.LANTERN_BRIDGE_AGENT_TIMEOUT_MS || "180000");

// Transient-error retry config for agent HTTP calls (429, 503, ECONNREFUSED).
// Override via env if needed; defaults are conservative for a chat bridge.
const RETRY_MAX_ATTEMPTS = Number(process.env.LANTERN_BRIDGE_RETRY_ATTEMPTS || "3");
const RETRY_BASE_DELAY_MS = Number(process.env.LANTERN_BRIDGE_RETRY_BASE_MS || "500");
const RETRY_MAX_DELAY_MS = Number(process.env.LANTERN_BRIDGE_RETRY_MAX_MS || "4000");

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

  // `withTools=true` opts INTO the tenant's installed connector
  // tools (Gmail / Calendar / etc.). Default off because pulling
  // every installed connector's schema into the prompt is expensive
  // and is wrong for personal-docs replies where the prompt is
  // already large with OCR context. The bridges' natural-chat path
  // sets this to true so the bot can actually use Gmail when asked.
  async respondTo(jid: string, userText: string, systemHint?: string, opts?: { withTools?: boolean; readOnlyTools?: boolean; turnHint?: string }): Promise<string | null> {
    if (!this.enabled()) return null;
    // readOnlyTools implies the catalog loads (withTools), but the control
    // plane filters it to read-only actions. Used on the contact reply path
    // for logistics inbound so a contact can't drive a connector write.
    const withTools = opts?.withTools === true || opts?.readOnlyTools === true;
    const prev = this.inflight.get(jid) ?? Promise.resolve<string | null>(null);
    const next = prev.then(() => this.runTurn(jid, userText, systemHint, withTools, opts?.turnHint, opts?.readOnlyTools === true)).catch((err) => {
      this.logger.error({ err, jid }, "turn errored");
      return null;
    });
    this.inflight.set(jid, next);
    const reply = await next;
    if (this.inflight.get(jid) === next) this.inflight.delete(jid);
    return reply;
  }

  private async runTurn(jid: string, userText: string, systemHint?: string, withTools = false, turnHint?: string, readOnlyTools = false): Promise<string | null> {
    // Up to ONE retry on dead-session errors. A prior turn that got
    // SSE-aborted (timeout, network hiccup) leaves the control-plane
    // session in "ended" state — the next POST then 409s with
    // "session is not active" and EVERY subsequent message fails until
    // the bridge restarts. We detect that, drop the stale id, and
    // recreate ONCE so the user's next message lands clean.
    for (let attempt = 0; attempt < 2; attempt++) {
      const sessionId = await this.ensureSession(jid);
      if (!sessionId) return null;

      const sseCtrl = new AbortController();
      const ssePromise = this.waitForAgentMessage(sessionId, sseCtrl.signal);

      const postBody: Record<string, unknown> = {
        content: userText,
        // noTools=true is the default for auto-reply paths (replying
        // to a friend, generating a doc-query answer) where the
        // bridge has already loaded heavy context and the LLM
        // shouldn't be invoking unrelated connectors. The natural-
        // chat path explicitly opts INTO tools so the bot can use
        // Gmail / Calendar / etc. when the owner asks.
        noTools: !withTools,
      };
      // Contact logistics path: load the catalog but ask the control plane to
      // keep only read-only actions (Calendar/Gmail reads) — never writes.
      if (readOnlyTools) postBody.readOnlyTools = true;
      if (systemHint) postBody.systemHint = systemHint;
      // Optional complexity floor. The personal-chat reply path passes
      // "balanced" so the owner's outgoing texts are never drafted by the
      // weakest (trivial-tier) model, even for short inbounds. Omitted on
      // cheap auxiliary calls (episode extraction) which can use any tier.
      if (turnHint) postBody.turnHint = turnHint;

      let postRes: Response;
      try {
        postRes = await withRetry(
          async () => {
            const r = await authedFetch(`/v1/sessions/${sessionId}/messages`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(postBody),
            });
            // Throw a sentinel so withRetry sees 429/503 as retryable.
            if (r.status === 429 || r.status === 503) {
              const errBody = await r.text().catch(() => "");
              throw new TransientHttpError(r.status, errBody);
            }
            return r;
          },
          {
            maxAttempts: RETRY_MAX_ATTEMPTS,
            baseDelayMs: RETRY_BASE_DELAY_MS,
            maxDelayMs: RETRY_MAX_DELAY_MS,
            shouldRetry: isTransientError,
          },
        );
      } catch (err) {
        sseCtrl.abort();
        if (err instanceof TransientHttpError) {
          this.logger.error(
            { status: err.status, body: err.body.slice(0, 300), sessionId, attempt },
            "send message failed after retries",
          );
        } else {
          this.logger.error({ err, sessionId, attempt }, "send message network error after retries");
        }
        return null;
      }

      if (postRes.ok) {
        return await ssePromise;
      }

      sseCtrl.abort();
      const body = await postRes.text().catch(() => "");
      const isDead =
        postRes.status === 404 ||
        postRes.status === 409 ||
        /session\s+is\s+not\s+active|session\s+(?:not\s+found|ended|expired)/i.test(body);
      this.logger.error(
        { status: postRes.status, body: body.slice(0, 300), sessionId, attempt, isDead },
        "send message failed",
      );
      if (isDead && attempt === 0) {
        this.sessions.delete(jid);
        this.saveSessions();
        continue; // recreate session + retry the same user message once
      }
      return null;
    }
    return null;
  }

  private async ensureSession(jid: string): Promise<string | null> {
    const existing = this.sessions.get(jid);
    if (existing) return existing;
    let res: Response;
    try {
      res = await withRetry(
        async () => {
          const r = await authedFetch(`/v1/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentName: this.agentName }),
          });
          if (r.status === 429 || r.status === 503) {
            const errBody = await r.text().catch(() => "");
            throw new TransientHttpError(r.status, errBody);
          }
          return r;
        },
        {
          maxAttempts: RETRY_MAX_ATTEMPTS,
          baseDelayMs: RETRY_BASE_DELAY_MS,
          maxDelayMs: RETRY_MAX_DELAY_MS,
          shouldRetry: isTransientError,
        },
      );
    } catch (err) {
      if (err instanceof TransientHttpError) {
        this.logger.error(
          { status: err.status, body: err.body.slice(0, 300), jid },
          "create session failed after retries",
        );
      } else {
        this.logger.error({ err, jid }, "create session network error after retries");
      }
      return null;
    }
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

  // STREAMING variant. Calls /v1/jarvis/stream-completion (no tools)
  // and surfaces text deltas via onDelta as they arrive. Returns the
  // full assembled text when done. For bridge UX like "send first
  // sentence as soon as it lands, send the rest at end".
  //
  // NO tool loop — for tool-using flows use respondTo() which goes
  // through /v1/sessions/{id}/messages.
  async respondToStream(
    systemPrompt: string,
    userPrompt: string,
    onDelta: (chunk: string) => void,
    opts: { model?: string; signal?: AbortSignal } = {},
  ): Promise<string> {
    const body = JSON.stringify({
      systemPrompt,
      userPrompt,
      model: opts.model || "auto",
    });
    const ctrl = new AbortController();
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    const timeoutId = setTimeout(() => ctrl.abort(), SSE_TIMEOUT_MS);
    let full = "";
    try {
      const res = await authedFetch("/v1/jarvis/stream-completion", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        this.logger.error({ status: res.status }, "stream-completion: HTTP error");
        return "";
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are \n\n delimited. Each frame can have multiple
        // `data: ...\n` lines (we re-assemble).
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          // Concatenate every `data: ` line in this frame.
          const lines = raw.split("\n").filter((l) => l.startsWith("data: "));
          if (lines.length === 0) continue;
          const chunk = lines.map((l) => l.slice(6)).join("\n");
          if (chunk === "[DONE]") {
            return full;
          }
          full += chunk;
          onDelta(chunk);
        }
      }
      return full;
    } catch (err) {
      if (!ctrl.signal.aborted) this.logger.error({ err }, "stream-completion: exception");
      return full;
    } finally {
      clearTimeout(timeoutId);
    }
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
      // Keys are contact JIDs (phone numbers) — PII at rest. Owner-only
      // (0600), matching the OCR-cache / memory-JSONL standard.
      writeFileSync(this.sessionsFile, JSON.stringify(obj, null, 2), { mode: 0o600 });
      try { chmodSync(this.sessionsFile, 0o600); } catch { /* best-effort */ }
    } catch (err) {
      this.logger.warn({ err }, "could not persist agent_sessions.json");
    }
  }
}
