// Deprecated Lantern* aliases (ADR 0032). Same class objects, so instanceof keeps working.
import { PalError, PalGrpcError, PalStepError, PalLlmError, PalLlmJsonError, PalToolError, PalMemoryError, PalConnectorError, PalTimeoutError, PalCancelledError } from "./errors.js";
import { PalRuntime } from "./runtime.js";

/** @deprecated use PalError (ADR 0032) */
export const LanternError = PalError;
/** @deprecated use PalError (ADR 0032) */
export type LanternError = PalError;

/** @deprecated use PalGrpcError (ADR 0032) */
export const LanternGrpcError = PalGrpcError;
/** @deprecated use PalGrpcError (ADR 0032) */
export type LanternGrpcError = PalGrpcError;

/** @deprecated use PalStepError (ADR 0032) */
export const LanternStepError = PalStepError;
/** @deprecated use PalStepError (ADR 0032) */
export type LanternStepError = PalStepError;

/** @deprecated use PalLlmError (ADR 0032) */
export const LanternLlmError = PalLlmError;
/** @deprecated use PalLlmError (ADR 0032) */
export type LanternLlmError = PalLlmError;

/** @deprecated use PalLlmJsonError (ADR 0032) */
export const LanternLlmJsonError = PalLlmJsonError;
/** @deprecated use PalLlmJsonError (ADR 0032) */
export type LanternLlmJsonError = PalLlmJsonError;

/** @deprecated use PalToolError (ADR 0032) */
export const LanternToolError = PalToolError;
/** @deprecated use PalToolError (ADR 0032) */
export type LanternToolError = PalToolError;

/** @deprecated use PalMemoryError (ADR 0032) */
export const LanternMemoryError = PalMemoryError;
/** @deprecated use PalMemoryError (ADR 0032) */
export type LanternMemoryError = PalMemoryError;

/** @deprecated use PalConnectorError (ADR 0032) */
export const LanternConnectorError = PalConnectorError;
/** @deprecated use PalConnectorError (ADR 0032) */
export type LanternConnectorError = PalConnectorError;

/** @deprecated use PalTimeoutError (ADR 0032) */
export const LanternTimeoutError = PalTimeoutError;
/** @deprecated use PalTimeoutError (ADR 0032) */
export type LanternTimeoutError = PalTimeoutError;

/** @deprecated use PalCancelledError (ADR 0032) */
export const LanternCancelledError = PalCancelledError;
/** @deprecated use PalCancelledError (ADR 0032) */
export type LanternCancelledError = PalCancelledError;

/** @deprecated use PalRuntime (ADR 0032) */
export const LanternRuntime = PalRuntime;
/** @deprecated use PalRuntime (ADR 0032) */
export type LanternRuntime = PalRuntime;

