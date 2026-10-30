// Deprecated Lantern* aliases (ADR 0032). Same class objects, so instanceof keeps working.
import { PalClient, PalApiError } from "./client.js";

/** @deprecated use PalClient (ADR 0032) */
export const LanternClient = PalClient;
/** @deprecated use PalClient (ADR 0032) */
export type LanternClient = PalClient;

/** @deprecated use PalApiError (ADR 0032) */
export const LanternApiError = PalApiError;
/** @deprecated use PalApiError (ADR 0032) */
export type LanternApiError = PalApiError;

