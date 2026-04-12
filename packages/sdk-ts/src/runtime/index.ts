/**
 * Runtime module barrel export.
 *
 * Re-exports the public API of the Lantern SDK runtime subsystem.
 */

export { LanternRuntime } from "./runtime.js";
export type { Runtime, RunInfo } from "./runtime.js";

export {
  RuntimeSidecarClient,
  Http2GrpcTransport,
} from "./grpc-client.js";
export type {
  GrpcTransport,
  RequestMeta,
  StepRequest,
  StepResponse,
  CompleteRequest,
  CompleteResponse,
  CompleteChunk,
  EmbedRequest,
  EmbedResponse,
  ToolInvokeRequest,
  ToolInvokeResponse,
  MemoryGetRequest,
  MemoryGetResponse,
  MemorySetRequest,
  MemorySearchRequest,
  MemorySearchResponse,
  MemoryAddRequest,
  ConnectorInvokeRequest,
  ConnectorInvokeResponse,
  SignalWaitRequest,
  SignalWaitResponse,
  RunInfoResponse,
} from "./grpc-client.js";

export { createProductionStepProxy, resetStepCounter } from "./step-runtime.js";
export type { StepAPI } from "./step-runtime.js";

export { RuntimeLlmClient } from "./llm-client.js";
export { RuntimeToolClient } from "./tool-client.js";
export type { SearchResult, PythonResult } from "./tool-client.js";
export { RuntimeMemoryClient } from "./memory-client.js";
export { createConnectorProxy } from "./connector-proxy.js";
export { buildContext } from "./context.js";

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
} from "./errors.js";

export { getTracer, traced } from "./tracing.js";
export type { Span, Tracer } from "./tracing.js";
