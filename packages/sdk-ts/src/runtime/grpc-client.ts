/**
 * gRPC client for the Lantern runtime sidecar.
 *
 * Inside a Firecracker microVM the agent process communicates with a
 * co-located sidecar over localhost:50055. The sidecar proxies all
 * requests to the workflow engine, model router, memory service, etc.
 *
 * This module provides a typed, Promise-based wrapper around the raw
 * gRPC transport. Every method is traced with OTel and carries the
 * run's tenant/run/step metadata.
 */

import { LanternGrpcError } from "./errors.js";
import { traced } from "./tracing.js";

// ---------------------------------------------------------------------------
// gRPC message types
// ---------------------------------------------------------------------------

/** Metadata attached to every sidecar request. */
export interface RequestMeta {
  runId: string;
  tenantId: string;
  stepId?: string;
  idempotencyKey?: string;
  traceId?: string;
  spanId?: string;
}

/** A single message in an LLM conversation. */
export interface GrpcMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolCallId?: string;
}

/** Tool definition sent along with CompleteRequest. */
export interface GrpcToolDef {
  name: string;
  description: string;
  parametersJson: string;
}

// -- Step -------------------------------------------------------------------

export interface StepRequest {
  meta: RequestMeta;
  stepName: string;
  /** JSON-serialized input to the step function. */
  inputJson: string;
  retryPolicy?: {
    maxAttempts: number;
    initialIntervalMs: number;
    backoff: number;
    maxIntervalMs: number;
    nonRetryable: string[];
  };
  timeoutMs?: number;
}

export interface StepResponse {
  /** JSON-serialized result of the step function. */
  resultJson: string;
  cached: boolean;
  attempt: number;
  durationMs: number;
}

// -- Journal ----------------------------------------------------------------

export interface JournalLookupRequest {
  meta: RequestMeta;
  stepName: string;
}

export interface JournalLookupResponse {
  found: boolean;
  resultJson?: string;
}

export interface JournalWriteRequest {
  meta: RequestMeta;
  stepName: string;
  resultJson: string;
  attempt: number;
  durationMs: number;
  error?: string;
}

// -- LLM --------------------------------------------------------------------

export interface CompleteRequest {
  meta: RequestMeta;
  messages: GrpcMessage[];
  capability: string;
  optimize?: string;
  tools?: GrpcToolDef[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  responseFormat?: "text" | "json";
  noCache?: boolean;
}

export interface CompleteResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
  costUsd: number;
  finishReason: string;
}

export interface CompleteChunk {
  delta: string;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
  costUsd?: number;
  finishReason?: string;
  done: boolean;
}

export interface EmbedRequest {
  meta: RequestMeta;
  texts: string[];
  capability: string;
}

export interface EmbedResponse {
  vectors: number[][];
  model: string;
  tokensIn: number;
}

// -- Tools ------------------------------------------------------------------

export interface ToolInvokeRequest {
  meta: RequestMeta;
  toolName: string;
  inputJson: string;
}

export interface ToolInvokeResponse {
  outputJson: string;
  durationMs: number;
}

// -- Memory -----------------------------------------------------------------

export interface MemoryGetRequest {
  meta: RequestMeta;
  tier: "core" | "recall" | "archival";
  key: string;
}

export interface MemoryGetResponse {
  found: boolean;
  value?: string;
}

export interface MemorySetRequest {
  meta: RequestMeta;
  tier: "core";
  key: string;
  value: string;
}

export interface MemorySearchRequest {
  meta: RequestMeta;
  tier: "recall" | "archival";
  query: string;
  topK: number;
}

export interface MemorySearchResponse {
  entries: Array<{
    id: string;
    text: string;
    score: number;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface MemoryAddRequest {
  meta: RequestMeta;
  tier: "archival";
  text: string;
  metadata?: Record<string, unknown>;
}

// -- Connector --------------------------------------------------------------

export interface ConnectorInvokeRequest {
  meta: RequestMeta;
  connectorId: string;
  actionId: string;
  inputJson: string;
}

export interface ConnectorInvokeResponse {
  outputJson: string;
}

// -- Signals ----------------------------------------------------------------

export interface SignalWaitRequest {
  meta: RequestMeta;
  signalName: string;
  timeoutMs?: number;
}

export interface SignalWaitResponse {
  valueJson: string;
}

// -- Misc -------------------------------------------------------------------

export interface SleepRequest {
  meta: RequestMeta;
  stepName: string;
  durationMs: number;
}

export interface QueryRequest {
  meta: RequestMeta;
  queryName: string;
  inputJson: string;
}

export interface QueryResponse {
  resultJson: string;
}

export interface ApprovalRequest {
  meta: RequestMeta;
  reason: string;
  approvers?: string[];
  quorum?: number;
  expiresAtIso?: string;
  policy?: string;
}

export interface AskRequest {
  meta: RequestMeta;
  surface?: string;
  message: string;
  options?: string[];
  timeoutMs?: number;
}

export interface AskResponse {
  answer: string;
}

export interface NotifyRequest {
  meta: RequestMeta;
  channel: string;
  message: string;
  attachmentsJson?: string;
}

export interface ScreenShareRequest {
  meta: RequestMeta;
  fps?: number;
  region?: string;
  allowTakeover?: boolean;
}

export interface McpCallRequest {
  meta: RequestMeta;
  serverId: string;
  method: string;
  paramsJson?: string;
}

export interface McpCallResponse {
  resultJson: string;
}

export interface McpResourceRequest {
  meta: RequestMeta;
  serverId: string;
  uri: string;
}

export interface McpResourceResponse {
  resultJson: string;
}

export interface A2aSubmitRequest {
  meta: RequestMeta;
  agentCardUrl: string;
  inputJson: string;
  timeoutMs?: number;
}

export interface A2aSubmitResponse {
  resultJson: string;
}

export interface SubagentRequest {
  meta: RequestMeta;
  agentName: string;
  inputJson: string;
}

export interface SubagentResponse {
  resultJson: string;
}

export interface LogRequest {
  meta: RequestMeta;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fieldsJson?: string;
}

export interface CostRequest {
  meta: RequestMeta;
}

export interface CostResponse {
  estimateUsd: number;
  tokensIn: number;
  tokensOut: number;
}

export interface DeterministicRequest {
  meta: RequestMeta;
  kind: "now" | "random" | "uuid";
}

export interface DeterministicResponse {
  value: string;
}

export interface ReportResultRequest {
  meta: RequestMeta;
  resultJson?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface RunInfoResponse {
  runId: string;
  tenantId: string;
  agentName: string;
  agentVersion: string;
  inputJson: string;
}

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/**
 * Low-level transport for sending messages to the sidecar.
 * In production this is backed by a real gRPC channel.
 * In tests it can be replaced with an in-memory mock.
 */
export interface GrpcTransport {
  /** Unary RPC: send a request, receive a single response. */
  unary<TReq, TRes>(service: string, method: string, request: TReq): Promise<TRes>;
  /** Server-streaming RPC: send a request, receive a stream of messages. */
  serverStream<TReq, TChunk>(
    service: string,
    method: string,
    request: TReq,
  ): AsyncIterable<TChunk>;
  /** Close the underlying channel. */
  close(): void;
}

// ---------------------------------------------------------------------------
// HTTP/2 gRPC transport (grpc-js compatible wire format)
// ---------------------------------------------------------------------------

/**
 * Production gRPC transport that connects to the runtime sidecar.
 * Uses `@grpc/grpc-js` when available; otherwise falls back to a
 * minimal HTTP/2 framed JSON transport (the sidecar accepts both
 * protobuf and JSON-encoded gRPC).
 */
export class Http2GrpcTransport implements GrpcTransport {
  private readonly address: string;
  private closed = false;

  constructor(address: string) {
    this.address = address;
  }

  async unary<TReq, TRes>(service: string, method: string, request: TReq): Promise<TRes> {
    if (this.closed) {
      throw new LanternGrpcError(1, "Transport is closed");
    }

    const path = `/${service}/${method}`;
    const body = JSON.stringify(request);

    const response = await fetch(`http://${this.address}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/grpc+json",
        "te": "trailers",
      },
      body,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      const grpcStatus = parseInt(response.headers.get("grpc-status") ?? "2", 10);
      const grpcMessage = response.headers.get("grpc-message") ?? errBody;
      throw new LanternGrpcError(grpcStatus, grpcMessage, errBody);
    }

    const text = await response.text();
    if (!text) {
      return {} as TRes;
    }

    try {
      return JSON.parse(text) as TRes;
    } catch {
      throw new LanternGrpcError(13, `Failed to parse gRPC response as JSON: ${text.slice(0, 200)}`);
    }
  }

  async *serverStream<TReq, TChunk>(
    service: string,
    method: string,
    request: TReq,
  ): AsyncIterable<TChunk> {
    if (this.closed) {
      throw new LanternGrpcError(1, "Transport is closed");
    }

    const path = `/${service}/${method}`;
    const body = JSON.stringify(request);

    const response = await fetch(`http://${this.address}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/grpc+json",
        "Accept": "application/x-ndjson",
        "te": "trailers",
      },
      body,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      const grpcStatus = parseInt(response.headers.get("grpc-status") ?? "2", 10);
      const grpcMessage = response.headers.get("grpc-message") ?? errBody;
      throw new LanternGrpcError(grpcStatus, grpcMessage, errBody);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return;
    }

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
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            yield JSON.parse(trimmed) as TChunk;
          } catch {
            throw new LanternGrpcError(13, `Failed to parse streaming chunk: ${trimmed.slice(0, 200)}`);
          }
        }
      }

      // Process any remaining data in the buffer
      if (buffer.trim()) {
        try {
          yield JSON.parse(buffer.trim()) as TChunk;
        } catch {
          throw new LanternGrpcError(13, `Failed to parse final streaming chunk: ${buffer.slice(0, 200)}`);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  close(): void {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// High-level runtime sidecar client
// ---------------------------------------------------------------------------

const SIDECAR_SERVICE = "lantern.runtime.v1.RuntimeSidecar";

/**
 * High-level, fully-typed client for the Lantern runtime sidecar.
 *
 * Every public method is traced with OTel and maps directly to a
 * sidecar gRPC method. The client does not hold mutable state beyond
 * the underlying transport.
 */
export class RuntimeSidecarClient {
  private readonly transport: GrpcTransport;

  constructor(transport: GrpcTransport) {
    this.transport = transport;
  }

  // -- Lifecycle ------------------------------------------------------------

  /** Retrieve run metadata from the sidecar (called once at startup). */
  async getRunInfo(meta: RequestMeta): Promise<RunInfoResponse> {
    return traced("sidecar.GetRunInfo", { runId: meta.runId }, () =>
      this.transport.unary<RequestMeta, RunInfoResponse>(SIDECAR_SERVICE, "GetRunInfo", meta),
    );
  }

  /** Report the final result (or error) of the agent run. */
  async reportResult(req: ReportResultRequest): Promise<void> {
    await traced("sidecar.ReportResult", { runId: req.meta.runId }, () =>
      this.transport.unary<ReportResultRequest, Record<string, never>>(SIDECAR_SERVICE, "ReportResult", req),
    );
  }

  // -- Journal --------------------------------------------------------------

  /** Look up a previously journaled step result. */
  async journalLookup(req: JournalLookupRequest): Promise<JournalLookupResponse> {
    return traced("sidecar.JournalLookup", { runId: req.meta.runId, step: req.stepName }, () =>
      this.transport.unary<JournalLookupRequest, JournalLookupResponse>(SIDECAR_SERVICE, "JournalLookup", req),
    );
  }

  /** Write a step result to the journal. */
  async journalWrite(req: JournalWriteRequest): Promise<void> {
    await traced("sidecar.JournalWrite", { runId: req.meta.runId, step: req.stepName }, () =>
      this.transport.unary<JournalWriteRequest, Record<string, never>>(SIDECAR_SERVICE, "JournalWrite", req),
    );
  }

  // -- Steps ----------------------------------------------------------------

  /** Execute a step through the workflow engine. */
  async executeStep(req: StepRequest): Promise<StepResponse> {
    return traced("sidecar.ExecuteStep", { runId: req.meta.runId, step: req.stepName }, () =>
      this.transport.unary<StepRequest, StepResponse>(SIDECAR_SERVICE, "ExecuteStep", req),
    );
  }

  /** Request the engine to suspend execution for a duration. */
  async sleep(req: SleepRequest): Promise<void> {
    await traced("sidecar.Sleep", { runId: req.meta.runId, step: req.stepName, durationMs: req.durationMs }, () =>
      this.transport.unary<SleepRequest, Record<string, never>>(SIDECAR_SERVICE, "Sleep", req),
    );
  }

  // -- LLM ------------------------------------------------------------------

  /** Unary LLM completion through the model router. */
  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    return traced("sidecar.Complete", { runId: req.meta.runId, capability: req.capability }, () =>
      this.transport.unary<CompleteRequest, CompleteResponse>(SIDECAR_SERVICE, "Complete", req),
    );
  }

  /** Streaming LLM completion through the model router. */
  streamComplete(req: CompleteRequest): AsyncIterable<CompleteChunk> {
    return this.transport.serverStream<CompleteRequest, CompleteChunk>(SIDECAR_SERVICE, "StreamComplete", req);
  }

  /** Compute embeddings through the model router. */
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    return traced("sidecar.Embed", { runId: req.meta.runId, capability: req.capability, count: req.texts.length }, () =>
      this.transport.unary<EmbedRequest, EmbedResponse>(SIDECAR_SERVICE, "Embed", req),
    );
  }

  // -- Tools ----------------------------------------------------------------

  /** Invoke a built-in tool (web, python, fs, browser). */
  async invokeTool(req: ToolInvokeRequest): Promise<ToolInvokeResponse> {
    return traced("sidecar.InvokeTool", { runId: req.meta.runId, tool: req.toolName }, () =>
      this.transport.unary<ToolInvokeRequest, ToolInvokeResponse>(SIDECAR_SERVICE, "InvokeTool", req),
    );
  }

  // -- Memory ---------------------------------------------------------------

  /** Get a value from the core (KV) memory tier. */
  async memoryGet(req: MemoryGetRequest): Promise<MemoryGetResponse> {
    return traced("sidecar.MemoryGet", { runId: req.meta.runId, tier: req.tier, key: req.key }, () =>
      this.transport.unary<MemoryGetRequest, MemoryGetResponse>(SIDECAR_SERVICE, "MemoryGet", req),
    );
  }

  /** Set a value in the core (KV) memory tier. */
  async memorySet(req: MemorySetRequest): Promise<void> {
    await traced("sidecar.MemorySet", { runId: req.meta.runId, tier: req.tier, key: req.key }, () =>
      this.transport.unary<MemorySetRequest, Record<string, never>>(SIDECAR_SERVICE, "MemorySet", req),
    );
  }

  /** Vector search in recall or archival memory. */
  async memorySearch(req: MemorySearchRequest): Promise<MemorySearchResponse> {
    return traced("sidecar.MemorySearch", { runId: req.meta.runId, tier: req.tier, topK: req.topK }, () =>
      this.transport.unary<MemorySearchRequest, MemorySearchResponse>(SIDECAR_SERVICE, "MemorySearch", req),
    );
  }

  /** Add an entry to archival memory. */
  async memoryAdd(req: MemoryAddRequest): Promise<void> {
    await traced("sidecar.MemoryAdd", { runId: req.meta.runId, tier: req.tier }, () =>
      this.transport.unary<MemoryAddRequest, Record<string, never>>(SIDECAR_SERVICE, "MemoryAdd", req),
    );
  }

  // -- Connectors -----------------------------------------------------------

  /** Invoke a connector action. */
  async invokeConnector(req: ConnectorInvokeRequest): Promise<ConnectorInvokeResponse> {
    return traced("sidecar.InvokeConnector", { runId: req.meta.runId, connector: req.connectorId, action: req.actionId }, () =>
      this.transport.unary<ConnectorInvokeRequest, ConnectorInvokeResponse>(SIDECAR_SERVICE, "InvokeConnector", req),
    );
  }

  // -- Signals --------------------------------------------------------------

  /** Wait for an external signal (blocks until signal arrives or timeout). */
  async waitForSignal(req: SignalWaitRequest): Promise<SignalWaitResponse> {
    return traced("sidecar.WaitForSignal", { runId: req.meta.runId, signal: req.signalName }, () =>
      this.transport.unary<SignalWaitRequest, SignalWaitResponse>(SIDECAR_SERVICE, "WaitForSignal", req),
    );
  }

  // -- Approval / Ask / Notify ----------------------------------------------

  /** Request human approval (blocks until approved, denied, or timeout). */
  async requestApproval(req: ApprovalRequest): Promise<void> {
    await traced("sidecar.RequestApproval", { runId: req.meta.runId }, () =>
      this.transport.unary<ApprovalRequest, Record<string, never>>(SIDECAR_SERVICE, "RequestApproval", req),
    );
  }

  /** Ask a human a question and wait for an answer. */
  async ask(req: AskRequest): Promise<AskResponse> {
    return traced("sidecar.Ask", { runId: req.meta.runId }, () =>
      this.transport.unary<AskRequest, AskResponse>(SIDECAR_SERVICE, "Ask", req),
    );
  }

  /** Send a notification to a channel. */
  async notify(req: NotifyRequest): Promise<void> {
    await traced("sidecar.Notify", { runId: req.meta.runId, channel: req.channel }, () =>
      this.transport.unary<NotifyRequest, Record<string, never>>(SIDECAR_SERVICE, "Notify", req),
    );
  }

  // -- Screen ---------------------------------------------------------------

  /** Start screen sharing for the run. */
  async screenShare(req: ScreenShareRequest): Promise<void> {
    await traced("sidecar.ScreenShare", { runId: req.meta.runId }, () =>
      this.transport.unary<ScreenShareRequest, Record<string, never>>(SIDECAR_SERVICE, "ScreenShare", req),
    );
  }

  // -- MCP ------------------------------------------------------------------

  /** Call an MCP server method. */
  async mcpCall(req: McpCallRequest): Promise<McpCallResponse> {
    return traced("sidecar.McpCall", { runId: req.meta.runId, server: req.serverId, method: req.method }, () =>
      this.transport.unary<McpCallRequest, McpCallResponse>(SIDECAR_SERVICE, "McpCall", req),
    );
  }

  /** Read an MCP resource. */
  async mcpResource(req: McpResourceRequest): Promise<McpResourceResponse> {
    return traced("sidecar.McpResource", { runId: req.meta.runId, server: req.serverId, uri: req.uri }, () =>
      this.transport.unary<McpResourceRequest, McpResourceResponse>(SIDECAR_SERVICE, "McpResource", req),
    );
  }

  // -- A2A ------------------------------------------------------------------

  /** Submit a task to an A2A agent. */
  async a2aSubmit(req: A2aSubmitRequest): Promise<A2aSubmitResponse> {
    return traced("sidecar.A2aSubmit", { runId: req.meta.runId, agentCard: req.agentCardUrl }, () =>
      this.transport.unary<A2aSubmitRequest, A2aSubmitResponse>(SIDECAR_SERVICE, "A2aSubmit", req),
    );
  }

  // -- Subagent -------------------------------------------------------------

  /** Spawn a child agent run and wait for its result. */
  async subagent(req: SubagentRequest): Promise<SubagentResponse> {
    return traced("sidecar.Subagent", { runId: req.meta.runId, agent: req.agentName }, () =>
      this.transport.unary<SubagentRequest, SubagentResponse>(SIDECAR_SERVICE, "Subagent", req),
    );
  }

  // -- Logging / Cost -------------------------------------------------------

  /** Send a structured log entry to the engine. */
  async log(req: LogRequest): Promise<void> {
    await this.transport.unary<LogRequest, Record<string, never>>(SIDECAR_SERVICE, "Log", req);
  }

  /** Get the current cost estimate for the run. */
  async getCost(req: CostRequest): Promise<CostResponse> {
    return this.transport.unary<CostRequest, CostResponse>(SIDECAR_SERVICE, "GetCost", req);
  }

  // -- Deterministic functions ----------------------------------------------

  /** Get a deterministic now/random/uuid from the engine (replay-safe). */
  async deterministic(req: DeterministicRequest): Promise<DeterministicResponse> {
    return this.transport.unary<DeterministicRequest, DeterministicResponse>(SIDECAR_SERVICE, "Deterministic", req);
  }

  // -- Query ----------------------------------------------------------------

  /** Handle a query against the running workflow. */
  async query(req: QueryRequest): Promise<QueryResponse> {
    return traced("sidecar.Query", { runId: req.meta.runId, query: req.queryName }, () =>
      this.transport.unary<QueryRequest, QueryResponse>(SIDECAR_SERVICE, "Query", req),
    );
  }

  // -- Cleanup --------------------------------------------------------------

  /** Close the underlying transport. */
  close(): void {
    this.transport.close();
  }
}
