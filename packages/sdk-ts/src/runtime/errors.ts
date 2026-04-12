/**
 * Typed error classes for the Lantern SDK runtime.
 *
 * Every runtime operation throws one of these instead of a bare Error,
 * giving callers a reliable `instanceof` check and structured metadata.
 */

/** Base class for all Lantern SDK errors. */
export class LanternError extends Error {
  /** Machine-readable error code. */
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LanternError";
    this.code = code;
  }
}

/** Raised when a gRPC call to the runtime sidecar fails. */
export class LanternGrpcError extends LanternError {
  /** gRPC status code (0=OK, 1=CANCELLED, etc.). */
  public readonly grpcStatus: number;
  /** Optional upstream details returned by the sidecar. */
  public readonly details: string | undefined;

  constructor(grpcStatus: number, message: string, details?: string) {
    super("GRPC_ERROR", `gRPC error (status=${grpcStatus}): ${message}`);
    this.name = "LanternGrpcError";
    this.grpcStatus = grpcStatus;
    this.details = details;
  }
}

/** Raised when a workflow step fails (execution error or timeout). */
export class LanternStepError extends LanternError {
  /** Fully-qualified step name (e.g. "summarize.chunk-3"). */
  public readonly stepName: string;
  /** Which attempt failed (1-based). */
  public readonly attempt: number;
  /** Whether the engine considers this retryable. */
  public readonly retryable: boolean;

  constructor(
    stepName: string,
    attempt: number,
    retryable: boolean,
    message: string,
  ) {
    super("STEP_FAILED", `Step "${stepName}" attempt ${attempt} failed: ${message}`);
    this.name = "LanternStepError";
    this.stepName = stepName;
    this.attempt = attempt;
    this.retryable = retryable;
  }
}

/** Raised when an LLM call fails (model error, quota, content filter, etc.). */
export class LanternLlmError extends LanternError {
  /** Provider-specific error code when available. */
  public readonly providerCode: string | undefined;
  /** Whether a retry with the same request might succeed. */
  public readonly retryable: boolean;

  constructor(message: string, providerCode?: string, retryable = false) {
    super("LLM_ERROR", message);
    this.name = "LanternLlmError";
    this.providerCode = providerCode;
    this.retryable = retryable;
  }
}

/** Raised when an LLM JSON response fails to parse or validate against the provided Zod schema. */
export class LanternLlmJsonError extends LanternLlmError {
  /** The raw text that failed validation. */
  public readonly rawOutput: string;
  /** Zod validation issues as a human-readable string. */
  public readonly validationErrors: string;

  constructor(rawOutput: string, validationErrors: string) {
    super(
      `LLM output failed schema validation: ${validationErrors}`,
      undefined,
      true,
    );
    this.name = "LanternLlmJsonError";
    this.rawOutput = rawOutput;
    this.validationErrors = validationErrors;
  }
}

/** Raised when a tool invocation fails. */
export class LanternToolError extends LanternError {
  /** Tool identifier (e.g. "lantern.web", "lantern.python"). */
  public readonly toolName: string;

  constructor(toolName: string, message: string) {
    super("TOOL_ERROR", `Tool "${toolName}" failed: ${message}`);
    this.name = "LanternToolError";
    this.toolName = toolName;
  }
}

/** Raised when a memory operation fails. */
export class LanternMemoryError extends LanternError {
  /** Memory tier that failed (core, recall, archival). */
  public readonly tier: string;

  constructor(tier: string, message: string) {
    super("MEMORY_ERROR", `Memory tier "${tier}" error: ${message}`);
    this.name = "LanternMemoryError";
    this.tier = tier;
  }
}

/** Raised when a connector invocation fails. */
export class LanternConnectorError extends LanternError {
  /** Connector identifier (e.g. "github", "slack"). */
  public readonly connectorId: string;
  /** Action name that failed (e.g. "getPullRequest"). */
  public readonly actionId: string;

  constructor(connectorId: string, actionId: string, message: string) {
    super(
      "CONNECTOR_ERROR",
      `Connector "${connectorId}.${actionId}" failed: ${message}`,
    );
    this.name = "LanternConnectorError";
    this.connectorId = connectorId;
    this.actionId = actionId;
  }
}

/** Raised when a step times out. */
export class LanternTimeoutError extends LanternStepError {
  /** The configured timeout string (e.g. "30s"). */
  public readonly timeout: string;

  constructor(stepName: string, attempt: number, timeout: string) {
    super(stepName, attempt, true, `Step timed out after ${timeout}`);
    this.name = "LanternTimeoutError";
    this.code = "STEP_TIMEOUT";
    this.timeout = timeout;
  }
}

/** Raised when the run's abort signal fires (user cancellation, cost limit, etc.). */
export class LanternCancelledError extends LanternError {
  constructor(reason?: string) {
    super("CANCELLED", reason ?? "Run was cancelled");
    this.name = "LanternCancelledError";
  }
}
