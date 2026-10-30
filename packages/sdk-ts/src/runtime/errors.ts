/**
 * Typed error classes for the PAL SDK runtime.
 *
 * Every runtime operation throws one of these instead of a bare Error,
 * giving callers a reliable `instanceof` check and structured metadata.
 */

/** Base class for all PAL SDK errors. */
export class PalError extends Error {
  /** Machine-readable error code. */
  public code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PalError";
    this.code = code;
  }
}

/** Raised when a gRPC call to the runtime sidecar fails. */
export class PalGrpcError extends PalError {
  /** gRPC status code (0=OK, 1=CANCELLED, etc.). */
  public readonly grpcStatus: number;
  /** Optional upstream details returned by the sidecar. */
  public readonly details: string | undefined;

  constructor(grpcStatus: number, message: string, details?: string) {
    super("GRPC_ERROR", `gRPC error (status=${grpcStatus}): ${message}`);
    this.name = "PalGrpcError";
    this.grpcStatus = grpcStatus;
    this.details = details;
  }
}

/** Raised when a workflow step fails (execution error or timeout). */
export class PalStepError extends PalError {
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
    this.name = "PalStepError";
    this.stepName = stepName;
    this.attempt = attempt;
    this.retryable = retryable;
  }
}

/** Raised when an LLM call fails (model error, quota, content filter, etc.). */
export class PalLlmError extends PalError {
  /** Provider-specific error code when available. */
  public readonly providerCode: string | undefined;
  /** Whether a retry with the same request might succeed. */
  public readonly retryable: boolean;

  constructor(message: string, providerCode?: string, retryable = false) {
    super("LLM_ERROR", message);
    this.name = "PalLlmError";
    this.providerCode = providerCode;
    this.retryable = retryable;
  }
}

/** Raised when an LLM JSON response fails to parse or validate against the provided Zod schema. */
export class PalLlmJsonError extends PalLlmError {
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
    this.name = "PalLlmJsonError";
    this.rawOutput = rawOutput;
    this.validationErrors = validationErrors;
  }
}

/** Raised when a tool invocation fails. */
export class PalToolError extends PalError {
  /** Tool identifier (e.g. "lantern.web", "lantern.python"). */
  public readonly toolName: string;

  constructor(toolName: string, message: string) {
    super("TOOL_ERROR", `Tool "${toolName}" failed: ${message}`);
    this.name = "PalToolError";
    this.toolName = toolName;
  }
}

/** Raised when a memory operation fails. */
export class PalMemoryError extends PalError {
  /** Memory tier that failed (core, recall, archival). */
  public readonly tier: string;

  constructor(tier: string, message: string) {
    super("MEMORY_ERROR", `Memory tier "${tier}" error: ${message}`);
    this.name = "PalMemoryError";
    this.tier = tier;
  }
}

/** Raised when a connector invocation fails. */
export class PalConnectorError extends PalError {
  /** Connector identifier (e.g. "github", "slack"). */
  public readonly connectorId: string;
  /** Action name that failed (e.g. "getPullRequest"). */
  public readonly actionId: string;

  constructor(connectorId: string, actionId: string, message: string) {
    super(
      "CONNECTOR_ERROR",
      `Connector "${connectorId}.${actionId}" failed: ${message}`,
    );
    this.name = "PalConnectorError";
    this.connectorId = connectorId;
    this.actionId = actionId;
  }
}

/** Raised when a step times out. */
export class PalTimeoutError extends PalStepError {
  /** The configured timeout string (e.g. "30s"). */
  public readonly timeout: string;

  constructor(stepName: string, attempt: number, timeout: string) {
    super(stepName, attempt, true, `Step timed out after ${timeout}`);
    this.name = "PalTimeoutError";
    this.code = "STEP_TIMEOUT";
    this.timeout = timeout;
  }
}

/** Raised when the run's abort signal fires (user cancellation, cost limit, etc.). */
export class PalCancelledError extends PalError {
  constructor(reason?: string) {
    super("CANCELLED", reason ?? "Run was cancelled");
    this.name = "PalCancelledError";
  }
}
