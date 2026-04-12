export { agent } from "./agent.js";
export { step, setStepRuntime } from "./step.js";
export { LanternClient } from "./client.js";
export { tool } from "./tools.js";

// Runtime subsystem
export { LanternRuntime } from "./runtime/runtime.js";
export type { Runtime, RunInfo } from "./runtime/runtime.js";
export { RuntimeLlmClient } from "./runtime/llm-client.js";
export { RuntimeToolClient } from "./runtime/tool-client.js";
export type { SearchResult, PythonResult } from "./runtime/tool-client.js";
export { RuntimeMemoryClient } from "./runtime/memory-client.js";
export { createConnectorProxy } from "./runtime/connector-proxy.js";
export { buildContext } from "./runtime/context.js";
export {
  RuntimeSidecarClient,
  Http2GrpcTransport,
} from "./runtime/grpc-client.js";
export type { GrpcTransport, RequestMeta } from "./runtime/grpc-client.js";
export { createProductionStepProxy, resetStepCounter } from "./runtime/step-runtime.js";
export type { StepAPI } from "./runtime/step-runtime.js";

// Runner
export { executeAgent, main as runAgent } from "./runner.js";

// Errors
export {
  LanternError,
  LanternGrpcError,
  LanternStepError,
  LanternLlmError,
  LanternLlmJsonError,
  LanternToolError,
  LanternMemoryError,
  LanternConnectorError,
  LanternTimeoutError,
  LanternCancelledError,
} from "./runtime/errors.js";

// Tracing
export { getTracer, traced } from "./runtime/tracing.js";
export type { Span, Tracer } from "./runtime/tracing.js";

// Types (re-export everything)
export type {
  AgentConfig,
  AgentContext,
  StepOptions,
  LlmOptions,
  LlmJsonOptions,
  LlmStreamOptions,
  ConnectorAction,
  MemoryTier,
  ApprovalRequest,
  AskOptions,
  Capability,
  OptimizeTarget,
  StreamEvent,
  Run,
  Agent as AgentInfo,
  LlmClient,
  ToolClient,
  ConnectorClient,
  MemoryClient,
  MemoryEntry,
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
  ToolDef,
  RetryPolicy,
  MemoryConfig,
  ResourceLimits,
  RunStatus,
  TriggerKind,
  IsolationClass,
  ToolCallMessage,
} from "./types.js";
