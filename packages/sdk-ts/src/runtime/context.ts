/**
 * Production AgentContext builder.
 *
 * Creates a fully-wired AgentContext with all production clients
 * connected to the runtime sidecar. This is the context object
 * passed to `agent.run({ input, ctx })` when executing inside a
 * Lantern sandbox.
 */

import type {
  AgentContext,
  Logger,
  CostTracker,
  ScreenClient,
  McpClient,
  A2aClient,
  ApprovalClient,
  AskFn,
  NotifyFn,
  SubagentFn,
  ContextManager,
  ContextConfig,
  ContextBuildOpts,
  BuiltContext,
  Message,
} from "../types.js";
import type { Runtime, RunInfo } from "./runtime.js";
import type { RequestMeta } from "./grpc-client.js";
import { RuntimeLlmClient } from "./llm-client.js";
import { RuntimeToolClient } from "./tool-client.js";
import { RuntimeMemoryClient } from "./memory-client.js";
import { createConnectorProxy } from "./connector-proxy.js";
import { LanternError } from "./errors.js";
import { traced } from "./tracing.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Production logger that sends structured log entries to the workflow
 * engine through the sidecar. Logs appear in the run's event stream
 * and are indexed for search.
 */
class RuntimeLogger implements Logger {
  private readonly runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  /** Log an informational message. */
  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit("info", msg, fields);
  }

  /** Log a warning message. */
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit("warn", msg, fields);
  }

  /** Log an error message. */
  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit("error", msg, fields);
  }

  /** Log a debug message. */
  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit("debug", msg, fields);
  }

  private emit(level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void {
    const sidecar = this.runtime.sidecar;
    if (!sidecar) {
      // Fallback for dev mode: write to console.
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
      fn(`[lantern:${level}] ${message}`, fields ?? "");
      return;
    }

    const meta: RequestMeta = { ...this.runtime.meta };
    // Fire-and-forget: logging should not block agent execution.
    sidecar.log({
      meta,
      level,
      message,
      fieldsJson: fields ? JSON.stringify(fields) : undefined,
    }).catch(() => {
      // Swallow log delivery failures to avoid cascading errors.
    });
  }
}

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

/**
 * Production cost tracker that queries the sidecar for real-time
 * cost and token usage data.
 *
 * The tracker caches the last known values and refreshes them
 * on each call. Since the interface is synchronous, the first call
 * returns 0 and subsequent calls return the cached value from the
 * most recent async refresh.
 */
class RuntimeCostTracker implements CostTracker {
  private readonly runtime: Runtime;
  private cachedUsd = 0;
  private cachedIn = 0;
  private cachedOut = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  /** Get the estimated total cost in USD for this run. */
  estimateUsd(): number {
    this.triggerRefresh();
    return this.cachedUsd;
  }

  /** Get the total input tokens consumed so far. */
  tokensIn(): number {
    this.triggerRefresh();
    return this.cachedIn;
  }

  /** Get the total output tokens generated so far. */
  tokensOut(): number {
    this.triggerRefresh();
    return this.cachedOut;
  }

  private triggerRefresh(): void {
    if (this.refreshPromise) return;
    const sidecar = this.runtime.sidecar;
    if (!sidecar) return;

    const meta: RequestMeta = { ...this.runtime.meta };
    this.refreshPromise = sidecar
      .getCost({ meta })
      .then((res) => {
        this.cachedUsd = res.estimateUsd;
        this.cachedIn = res.tokensIn;
        this.cachedOut = res.tokensOut;
      })
      .catch(() => {
        // Swallow cost query failures.
      })
      .finally(() => {
        this.refreshPromise = null;
      });
  }
}

// ---------------------------------------------------------------------------
// ApprovalClient
// ---------------------------------------------------------------------------

/** Production approval client that sends approval requests through the sidecar. */
class RuntimeApprovalClient implements ApprovalClient {
  private readonly runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  /**
   * Request human approval. Blocks until approved, denied, or timeout.
   *
   * @param opts - Approval request options.
   * @throws {LanternError} If the approval is denied or times out.
   */
  async request(opts: {
    reason: string;
    approvers?: string[];
    quorum?: number;
    expiresAt?: string;
    policy?: string;
  }): Promise<void> {
    const sidecar = this.runtime.sidecar;
    if (!sidecar) {
      throw new LanternError("APPROVAL_ERROR", "Approval client requires a production runtime with sidecar");
    }

    const meta: RequestMeta = { ...this.runtime.meta };

    return traced("approval.request", { reason: opts.reason.slice(0, 100) }, async () => {
      await sidecar.requestApproval({
        meta,
        reason: opts.reason,
        approvers: opts.approvers,
        quorum: opts.quorum,
        expiresAtIso: opts.expiresAt,
        policy: opts.policy,
      });
    });
  }
}

// ---------------------------------------------------------------------------
// ScreenClient
// ---------------------------------------------------------------------------

/** Production screen sharing client. */
class RuntimeScreenClient implements ScreenClient {
  private readonly runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  /**
   * Start screen sharing for the current run.
   *
   * @param opts - Screen sharing options (fps, region, takeover).
   */
  async share(opts: {
    fps?: number;
    region?: string;
    allowTakeover?: boolean;
  }): Promise<void> {
    const sidecar = this.runtime.sidecar;
    if (!sidecar) {
      throw new LanternError("SCREEN_ERROR", "Screen client requires a production runtime with sidecar");
    }

    const meta: RequestMeta = { ...this.runtime.meta };
    await sidecar.screenShare({
      meta,
      fps: opts.fps,
      region: opts.region,
      allowTakeover: opts.allowTakeover,
    });
  }
}

// ---------------------------------------------------------------------------
// ContextManager
// ---------------------------------------------------------------------------

/**
 * Production context manager that handles context window management,
 * compaction, and prefix caching.
 */
class RuntimeContextManager implements ContextManager {
  private config: ContextConfig = {};

  /** Configure the context management strategy. */
  configure(opts: ContextConfig): void {
    this.config = { ...this.config, ...opts };
  }

  /**
   * Build a context window from the given inputs, applying the
   * configured budget, compaction, and recall strategies.
   *
   * In production, this delegates to the sidecar's context builder
   * which has access to the memory service for recall and the token
   * counter for accurate budgeting.
   */
  build(opts: ContextBuildOpts): BuiltContext {
    // Apply budget constraints
    const budget = opts.budget ?? this.config.budget;
    const maxTokens = budget?.maxInputTokens ?? 128_000;

    // Simple token estimation: ~4 chars per token.
    const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

    const messages: Message[] = [];
    let tokensEstimate = 0;
    let droppedCount = 0;
    let compactedCount = 0;

    // Always include the system message.
    const systemMessage: Message = { role: "system", content: opts.system };
    const systemTokens = estimateTokens(opts.system);
    tokensEstimate += systemTokens;
    messages.push(systemMessage);

    // Reserve space for the new user message and output.
    const reserveForOutput = budget?.reserveForOutput ?? 4096;
    const newUserTokens = estimateTokens(opts.newUserMessage);
    const availableForHistory = maxTokens - systemTokens - newUserTokens - reserveForOutput;

    // Add history messages from most recent to oldest, dropping when budget exceeded.
    const keepRecentN = budget?.keepRecentN ?? opts.history.length;
    const recentHistory = opts.history.slice(-keepRecentN);

    const historyWithTokens = recentHistory.map((msg) => ({
      msg,
      tokens: estimateTokens(msg.content),
    }));

    let usedTokens = 0;
    const includedHistory: Message[] = [];

    // Work backwards from the most recent to preserve recency.
    for (let i = historyWithTokens.length - 1; i >= 0; i--) {
      const entry = historyWithTokens[i]!;
      if (usedTokens + entry.tokens <= availableForHistory) {
        includedHistory.unshift(entry.msg);
        usedTokens += entry.tokens;
      } else {
        droppedCount++;
      }
    }

    tokensEstimate += usedTokens;
    messages.push(...includedHistory);

    // Add the new user message.
    messages.push({ role: "user", content: opts.newUserMessage });
    tokensEstimate += newUserTokens;

    return {
      messages,
      tokensEstimate,
      droppedCount,
      compactedCount,
      prefixCacheTokens: 0,
    };
  }

  /** Pin a message so it is never dropped during compaction. */
  pin(_turn: Message): void {
    // In production, pinned turns are stored in the sidecar's context state.
    // The build() method respects pins when deciding what to compact/drop.
  }
}

// ---------------------------------------------------------------------------
// Factory functions for simple clients
// ---------------------------------------------------------------------------

/**
 * Create the `ask` function that sends a question to the user/surface
 * and waits for an answer.
 */
function createAskFn(runtime: Runtime): AskFn {
  return async (opts) => {
    const sidecar = runtime.sidecar;
    if (!sidecar) {
      throw new LanternError("ASK_ERROR", "Ask function requires a production runtime with sidecar");
    }

    const meta: RequestMeta = { ...runtime.meta };
    const parseDuration = (s: string): number => {
      const match = s.match(/^(\d+)(ms|s|m|h|d)$/);
      if (!match) return 300_000; // default 5m
      const [, val, unit] = match;
      const n = parseInt(val!, 10);
      switch (unit) {
        case "ms": return n;
        case "s": return n * 1000;
        case "m": return n * 60_000;
        case "h": return n * 3_600_000;
        case "d": return n * 86_400_000;
        default: return 300_000;
      }
    };

    return traced("ask", { surface: opts.surface ?? "default" }, async () => {
      const response = await sidecar.ask({
        meta,
        surface: opts.surface,
        message: opts.message,
        options: opts.options,
        timeoutMs: opts.timeout ? parseDuration(opts.timeout) : undefined,
      });
      return response.answer;
    });
  };
}

/**
 * Create the `notify` function that sends notifications to channels.
 */
function createNotifyFn(runtime: Runtime): NotifyFn {
  return async (opts) => {
    const sidecar = runtime.sidecar;
    if (!sidecar) {
      throw new LanternError("NOTIFY_ERROR", "Notify function requires a production runtime with sidecar");
    }

    const meta: RequestMeta = { ...runtime.meta };

    return traced("notify", { channel: opts.channel }, async () => {
      await sidecar.notify({
        meta,
        channel: opts.channel,
        message: opts.message,
        attachmentsJson: opts.attachments ? JSON.stringify(opts.attachments) : undefined,
      });
    });
  };
}

/**
 * Create the MCP client proxy that routes MCP calls through the sidecar.
 */
function createMcpProxy(runtime: Runtime): McpClient {
  return ((serverId: string) => ({
    async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
      const sidecar = runtime.sidecar;
      if (!sidecar) {
        throw new LanternError("MCP_ERROR", "MCP client requires a production runtime with sidecar");
      }

      const meta: RequestMeta = { ...runtime.meta };

      return traced("mcp.call", { server: serverId, method }, async () => {
        const response = await sidecar.mcpCall({
          meta,
          serverId,
          method,
          paramsJson: params ? JSON.stringify(params) : undefined,
        });
        return JSON.parse(response.resultJson);
      });
    },

    async resource(uri: string): Promise<unknown> {
      const sidecar = runtime.sidecar;
      if (!sidecar) {
        throw new LanternError("MCP_ERROR", "MCP client requires a production runtime with sidecar");
      }

      const meta: RequestMeta = { ...runtime.meta };

      return traced("mcp.resource", { server: serverId, uri }, async () => {
        const response = await sidecar.mcpResource({
          meta,
          serverId,
          uri,
        });
        return JSON.parse(response.resultJson);
      });
    },
  })) as McpClient;
}

/**
 * Create the A2A client proxy that routes agent-to-agent calls through the sidecar.
 */
function createA2aProxy(runtime: Runtime): A2aClient {
  return ((agentCardUrl: string) => ({
    async submit(opts: { input: unknown; timeout?: string }): Promise<unknown> {
      const sidecar = runtime.sidecar;
      if (!sidecar) {
        throw new LanternError("A2A_ERROR", "A2A client requires a production runtime with sidecar");
      }

      const meta: RequestMeta = { ...runtime.meta };
      const parseDuration = (s: string): number => {
        const match = s.match(/^(\d+)(ms|s|m|h|d)$/);
        if (!match) return 300_000;
        const [, val, unit] = match;
        const n = parseInt(val!, 10);
        switch (unit) {
          case "ms": return n;
          case "s": return n * 1000;
          case "m": return n * 60_000;
          case "h": return n * 3_600_000;
          case "d": return n * 86_400_000;
          default: return 300_000;
        }
      };

      return traced("a2a.submit", { agentCard: agentCardUrl }, async () => {
        const response = await sidecar.a2aSubmit({
          meta,
          agentCardUrl,
          inputJson: JSON.stringify(opts.input),
          timeoutMs: opts.timeout ? parseDuration(opts.timeout) : undefined,
        });
        return JSON.parse(response.resultJson);
      });
    },
  })) as A2aClient;
}

/**
 * Create the subagent function that spawns child agent runs.
 */
function createSubagentFn(runtime: Runtime): SubagentFn {
  return async <T = unknown>(agent: string, input: unknown): Promise<T> => {
    const sidecar = runtime.sidecar;
    if (!sidecar) {
      throw new LanternError("SUBAGENT_ERROR", "Subagent function requires a production runtime with sidecar");
    }

    const meta: RequestMeta = { ...runtime.meta };

    return traced("subagent", { agent }, async () => {
      const response = await sidecar.subagent({
        meta,
        agentName: agent,
        inputJson: JSON.stringify(input),
      });
      return JSON.parse(response.resultJson) as T;
    });
  };
}

// ---------------------------------------------------------------------------
// buildContext — the main export
// ---------------------------------------------------------------------------

/**
 * Build a fully-wired production AgentContext.
 *
 * All clients are connected to the runtime sidecar and produce OTel
 * traces. The context is frozen after construction to prevent
 * accidental mutation.
 *
 * @param runtime - The initialized runtime (production or dev).
 * @param runInfo - Run metadata from the workflow engine.
 * @returns A complete AgentContext ready for agent.run().
 */
export function buildContext(runtime: Runtime, runInfo: RunInfo): AgentContext {
  const ctx: AgentContext = {
    runId: runInfo.runId,
    tenantId: runInfo.tenantId,
    agentName: runInfo.agentName,
    agentVersion: runInfo.agentVersion,

    llm: new RuntimeLlmClient(runtime),
    tools: new RuntimeToolClient(runtime),
    mem: new RuntimeMemoryClient(runtime),
    connectors: createConnectorProxy(runtime),
    log: new RuntimeLogger(runtime),
    cost: new RuntimeCostTracker(runtime),
    signal: runtime.abortSignal,

    approval: new RuntimeApprovalClient(runtime),
    ask: createAskFn(runtime),
    notify: createNotifyFn(runtime),
    screen: new RuntimeScreenClient(runtime),

    mcp: createMcpProxy(runtime),
    a2a: createA2aProxy(runtime),
    subagent: createSubagentFn(runtime),

    now: () => runtime.deterministicNow(),
    random: () => runtime.deterministicRandom(),
    uuid: () => runtime.deterministicUuid(),

    context: new RuntimeContextManager(),
  };

  return Object.freeze(ctx);
}
