import { z } from "zod";

export type Capability =
  | "reasoning-frontier"
  | "reasoning-large"
  | "reasoning-small"
  | "chat-large"
  | "chat-small"
  | "chat-edge"
  | "vision-large"
  | "vision-small"
  | "code-large"
  | "code-small"
  | "embed-large"
  | "embed-small"
  | "rerank"
  | "transcribe"
  | "tts"
  | "auto";

export type OptimizeTarget =
  | "cheap"
  | "fast"
  | "best"
  | "balanced"
  | { cost_weight: number; latency_weight: number; accuracy_weight: number };

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TriggerKind =
  | "api"
  | "schedule"
  | "webhook"
  | "surface"
  | "a2a"
  | "connector"
  | "manual";

export type IsolationClass =
  | "trusted"
  | "standard"
  | "untrusted"
  | "hostile"
  | "wasm"
  | "devcontainer";

export type PrivacyLevel = "standard" | "private" | "audit";

export interface GuardrailConfig {
  /** Block messages containing PII (emails, phone numbers, SSNs, etc.). */
  blockPII?: boolean;
  /** Enable content filtering for harmful or inappropriate content. */
  contentFilter?: boolean;
  /** List of topics the agent should refuse to engage with. */
  blockedTopics?: string[];
  /** Custom guardrail function evaluated before each LLM call. */
  custom?: (messages: Message[]) => Promise<{ allow: boolean; reason?: string }>;
}

export interface SessionConfig {
  /** Whether this agent supports interactive multi-turn sessions. */
  enabled: boolean;
  /** Maximum number of messages retained in session history. */
  maxMessages?: number;
  /** Session idle timeout (e.g. "30m", "2h"). Session is closed after this period of inactivity. */
  idleTimeout?: string;
  /** Whether to persist sessions across restarts. Defaults to true. */
  durable?: boolean;
}

export interface AgentConfig<TInput = unknown, TOutput = unknown> {
  name: string;
  version?: string;
  description?: string;
  model?: Capability | "auto";
  tools?: ToolDef[];
  memory?: MemoryConfig[];
  limits?: ResourceLimits;
  isolation?: { class: IsolationClass };
  labels?: Record<string, string>;

  /** High-level instructions defining the agent's goals, scope, and constraints. */
  instructions?: string;
  /** System prompt defining personality, tone, and output format. */
  systemPrompt?: string;
  /** Guardrail configuration for PII blocking, content filtering, and topic restrictions. */
  guardrails?: GuardrailConfig;
  /** Privacy level: "standard" (encrypted at rest), "private" (E2E encrypted), "audit" (full audit trail). */
  privacy?: PrivacyLevel;
  /** Session configuration for interactive multi-turn conversations. */
  session?: SessionConfig;
  /** Connectors this agent requires (e.g. ["gmail", "slack", "github"]). */
  connectors?: string[];

  init?(): Promise<void>;
  run(params: { input: TInput; ctx: AgentContext }): Promise<TOutput>;
}

export interface AgentContext {
  runId: string;
  tenantId: string;
  agentName: string;
  agentVersion: string;

  llm: LlmClient;
  tools: ToolClient;
  mem: MemoryClient;
  connectors: ConnectorClient;
  log: Logger;
  cost: CostTracker;
  signal: AbortSignal;

  approval: ApprovalClient;
  ask: AskFn;
  notify: NotifyFn;
  screen: ScreenClient;

  mcp: McpClient;
  a2a: A2aClient;
  subagent: SubagentFn;

  now(): Date;
  random(): number;
  uuid(): string;

  context: ContextManager;
}

/** Result of a grounded completion — the reply plus the sources it was told to
 *  ground on. `grounded` is true when sources were supplied (the model was held
 *  to the ground-or-abstain contract); false means it ran as a plain completion. */
export interface GroundedResult {
  text: string;
  grounded: boolean;
  sources: string[];
}

export interface LlmClient {
  complete(opts: LlmOptions): Promise<string>;
  /** Complete under a ground-or-abstain contract: the model may assert only what
   *  the supplied `sources` support, and must say it doesn't know (or state
   *  intent) rather than invent facts/numbers/dates/actions. The platform's
   *  server-side action guard still applies on top; this adds the citation
   *  contract at the agent's own boundary. */
  completeGrounded(opts: LlmOptions & { sources: string[] }): Promise<GroundedResult>;
  json<T>(opts: LlmJsonOptions<T>): Promise<T>;
  stream(opts: LlmStreamOptions): AsyncIterable<string>;
  embed(texts: string[], capability?: Capability): Promise<number[][]>;
}

export interface LlmOptions {
  prompt?: string;
  messages?: Message[];
  capability?: Capability;
  optimize?: OptimizeTarget;
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  noCache?: boolean;
}

export interface LlmJsonOptions<T = unknown> extends LlmOptions {
  schema: z.ZodType<T>;
}

export interface LlmStreamOptions extends LlmOptions {}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCalls?: ToolCallMessage[];
  toolCallId?: string;
}

export interface ToolCallMessage {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StepOptions {
  retry?: RetryPolicy;
  timeout?: string;
}

export interface RetryPolicy {
  maxAttempts?: number;
  initialInterval?: string;
  backoff?: number;
  maxInterval?: string;
  nonRetryable?: string[];
}

export interface MemoryConfig {
  kind: "vector" | "kv";
  name: string;
  scope: "tenant" | "user" | "agent" | "run";
  embedding?: Capability;
}

export interface ResourceLimits {
  cpu?: string;
  memory?: string;
  gpu?: string;
  timeout?: string;
  maxSteps?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export type MemoryTier = "core" | "recall" | "archival";

export interface ApprovalRequest {
  reason: string;
  approvers?: string[];
  quorum?: number;
  expiresAt?: string;
  policy?: string;
}

export interface AskOptions {
  surface?: string;
  message: string;
  options?: string[];
  timeout?: string;
}

export type AskFn = (opts: AskOptions) => Promise<string>;
export type NotifyFn = (opts: { channel: string; message: string; attachments?: unknown[] }) => Promise<void>;
export type SubagentFn = <T = unknown>(agent: string, input: unknown) => Promise<T>;

export interface ApprovalClient {
  request(opts: ApprovalRequest): Promise<void>;
}

export interface ConnectorAction {
  (input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ToolClient {
  web: { search(query: string): Promise<unknown>; fetch(url: string): Promise<string> };
  python: { exec(code: string): Promise<unknown> };
  fs: { read(path: string): Promise<string>; write(path: string, content: string): Promise<void> };
}

export interface ConnectorClient {
  [connectorId: string]: {
    [actionId: string]: ConnectorAction;
  };
}

export interface MemoryClient {
  core: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
  recall: { search(query: string, opts?: { topK?: number }): Promise<MemoryEntry[]> };
  archival: { search(query: string, opts?: { topK?: number }): Promise<MemoryEntry[]>; add(text: string, metadata?: Record<string, unknown>): Promise<void> };
}

export interface MemoryEntry {
  id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

export interface CostTracker {
  estimateUsd(): number;
  tokensIn(): number;
  tokensOut(): number;
}

export interface ScreenClient {
  share(opts: { fps?: number; region?: string; allowTakeover?: boolean }): Promise<void>;
}

export interface McpClient {
  (serverId: string): { call(method: string, params?: Record<string, unknown>): Promise<unknown>; resource(uri: string): Promise<unknown> };
}

export interface A2aClient {
  (agentCardUrl: string): { submit(opts: { input: unknown; timeout?: string }): Promise<unknown> };
}

export interface ContextManager {
  configure(opts: ContextConfig): void;
  build(opts: ContextBuildOpts): BuiltContext;
  pin(turn: Message): void;
}

export interface ContextConfig {
  budget?: { maxInputTokens?: number; targetInputTokens?: number; keepRecentN?: number; reserveForOutput?: number };
  compaction?: { freshForTurns?: number; compactForTurns?: number; sketchForTurns?: number };
  recall?: { topK?: number; threshold?: number };
  prefixCache?: "anthropic" | "openai" | "auto";
}

export interface ContextBuildOpts {
  system: string;
  tools?: ToolDef[];
  history: Message[];
  newUserMessage: string;
  resources?: unknown[];
  budget?: ContextConfig["budget"];
}

export interface BuiltContext {
  messages: Message[];
  tokensEstimate: number;
  droppedCount: number;
  compactedCount: number;
  prefixCacheTokens: number;
}

export interface StreamEvent {
  runId: string;
  stepId?: string;
  seq: number;
  ts: Date;
  kind:
    | "llm_delta"
    | "llm_complete"
    | "tool_call"
    | "tool_result"
    | "step_started"
    | "step_completed"
    | "step_failed"
    | "log"
    | "question"
    | "approval"
    | "heartbeat"
    | "end";
  data: Record<string, unknown>;
}

export interface Run {
  id: string;
  tenantId: string;
  agentId: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: { code: string; message: string; stepId?: string };
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  labels: Record<string, string>;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  currentVersionId?: string;
  createdAt: Date;
  labels: Record<string, string>;
}
