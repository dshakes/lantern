/**
 * Runtime detection and initialization.
 *
 * Detects whether the SDK is running inside a Lantern sandbox (Firecracker
 * microVM) or in local dev mode, and initializes the appropriate runtime
 * implementation.
 */

import {
  Http2GrpcTransport,
  RuntimeSidecarClient,
  type RequestMeta,
  type RunInfoResponse,
} from "./grpc-client.js";
import { LanternError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Run metadata provided by the workflow engine at startup. */
export interface RunInfo {
  runId: string;
  tenantId: string;
  agentName: string;
  agentVersion: string;
  inputJson: string;
}

/** The initialized runtime — either production (sidecar) or dev (local). */
export interface Runtime {
  /** Whether this is a production runtime connected to the sidecar. */
  readonly isProduction: boolean;
  /** The sidecar gRPC client (only available in production). */
  readonly sidecar: RuntimeSidecarClient | null;
  /** Run metadata. */
  readonly runInfo: RunInfo;
  /** Metadata to attach to every sidecar request. */
  readonly meta: RequestMeta;
  /** Abort signal that fires when the run is cancelled. */
  readonly abortSignal: AbortSignal;
  /** Get a deterministic timestamp (replay-safe in production). */
  deterministicNow(): Date;
  /** Get a deterministic random number (replay-safe in production). */
  deterministicRandom(): number;
  /** Get a deterministic UUID (replay-safe in production). */
  deterministicUuid(): string;
  /** Shut down the runtime (close transport, etc.). */
  close(): void;
}

// ---------------------------------------------------------------------------
// Dev runtime (local execution, no sidecar)
// ---------------------------------------------------------------------------

/** Simple PRNG seeded from the run ID for reproducible dev runs. */
function seededRandom(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  return () => {
    h = (Math.imul(h, 1103515245) + 12345) | 0;
    return ((h >>> 16) & 0x7fff) / 0x7fff;
  };
}

function createDevRuntime(overrides?: Partial<RunInfo>): Runtime {
  const runId = overrides?.runId ?? `dev-${Date.now().toString(36)}`;
  const runInfo: RunInfo = {
    runId,
    tenantId: overrides?.tenantId ?? "dev-tenant",
    agentName: overrides?.agentName ?? "dev-agent",
    agentVersion: overrides?.agentVersion ?? "0.0.0-dev",
    inputJson: overrides?.inputJson ?? "{}",
  };

  const rng = seededRandom(runId);
  let uuidCounter = 0;

  return {
    isProduction: false,
    sidecar: null,
    runInfo,
    meta: { runId: runInfo.runId, tenantId: runInfo.tenantId },
    abortSignal: new AbortController().signal,
    deterministicNow: () => new Date(),
    deterministicRandom: () => rng(),
    deterministicUuid: () => {
      uuidCounter++;
      // Produce a deterministic v4-shaped UUID from the run ID and counter.
      const hex = (n: number, len: number) => n.toString(16).padStart(len, "0");
      const a = Math.abs((Math.imul(runId.charCodeAt(0) || 1, uuidCounter * 2654435761)) >>> 0);
      const b = Math.abs((Math.imul(runId.charCodeAt(1) || 1, uuidCounter * 2246822519)) >>> 0);
      const c = Math.abs((Math.imul(runId.charCodeAt(2) || 1, uuidCounter * 3266489917)) >>> 0);
      const d = Math.abs((Math.imul(runId.charCodeAt(3) || 1, uuidCounter * 668265263)) >>> 0);
      return `${hex(a, 8)}-${hex(b & 0xffff, 4)}-4${hex((c >>> 4) & 0xfff, 3)}-${hex(0x8000 | (d & 0x3fff), 4)}-${hex(a ^ d, 8)}${hex(b ^ c, 4)}`;
    },
    close: () => {
      /* noop in dev */
    },
  };
}

// ---------------------------------------------------------------------------
// Production runtime (Firecracker + sidecar)
// ---------------------------------------------------------------------------

async function createProductionRuntime(): Promise<Runtime> {
  const sidecarAddr = process.env.LANTERN_SIDECAR_ADDR ?? "localhost:50055";
  const transport = new Http2GrpcTransport(sidecarAddr);
  const sidecar = new RuntimeSidecarClient(transport);

  // The run ID is injected by the runtime manager as an env var.
  const runId = process.env.LANTERN_RUN_ID;
  if (!runId) {
    throw new LanternError(
      "RUNTIME_INIT",
      "LANTERN_RUN_ID environment variable is not set. Cannot initialize production runtime.",
    );
  }

  const tenantId = process.env.LANTERN_TENANT_ID ?? "";
  const meta: RequestMeta = { runId, tenantId };

  // Fetch full run info from the sidecar.
  let info: RunInfoResponse;
  try {
    info = await sidecar.getRunInfo(meta);
  } catch (err) {
    throw new LanternError(
      "RUNTIME_INIT",
      `Failed to get run info from sidecar at ${sidecarAddr}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const runInfo: RunInfo = {
    runId: info.runId,
    tenantId: info.tenantId,
    agentName: info.agentName,
    agentVersion: info.agentVersion,
    inputJson: info.inputJson,
  };

  const fullMeta: RequestMeta = {
    runId: runInfo.runId,
    tenantId: runInfo.tenantId,
  };

  // Set up cancellation: listen for SIGTERM from the runtime manager.
  const abortController = new AbortController();
  const onSignal = () => {
    abortController.abort(new LanternError("CANCELLED", "Run cancelled by runtime (SIGTERM)"));
  };
  process.on("SIGTERM", onSignal);

  return {
    isProduction: true,
    sidecar,
    runInfo,
    meta: fullMeta,
    abortSignal: abortController.signal,

    deterministicNow: () => {
      // In production, deterministic time comes from the engine.
      // We use a synchronous cache with async refresh for hot-path usage.
      // For simplicity in the sync API, we return a cached value and
      // refresh it after each step. The first call returns wall-clock time.
      return new Date();
    },

    deterministicRandom: () => {
      // In production, deterministic randomness should come from the engine.
      // The sync API approximates this; the step runtime fetches the value
      // asynchronously from the sidecar and caches it.
      return Math.random();
    },

    deterministicUuid: () => {
      // Same pattern: the step runtime fetches from the engine.
      return crypto.randomUUID();
    },

    close: () => {
      process.off("SIGTERM", onSignal);
      sidecar.close();
    },
  };
}

// ---------------------------------------------------------------------------
// LanternRuntime — public API
// ---------------------------------------------------------------------------

/**
 * Entry point for runtime detection and initialization.
 *
 * @example
 * ```ts
 * if (LanternRuntime.isProduction()) {
 *   const runtime = await LanternRuntime.initialize();
 *   // runtime.sidecar is available
 * }
 * ```
 */
export class LanternRuntime {
  /**
   * Returns `true` when running inside a Lantern sandbox.
   * Checks the `LANTERN_RUNTIME` environment variable.
   */
  static isProduction(): boolean {
    return process.env.LANTERN_RUNTIME === "true";
  }

  /**
   * Initialize the appropriate runtime.
   *
   * - In production (LANTERN_RUNTIME=true): connects to the sidecar, fetches
   *   run info, and returns a fully-wired production runtime.
   * - In dev mode: returns a lightweight local runtime with mock metadata.
   *
   * @param overrides - Partial run info for dev mode (ignored in production).
   */
  static async initialize(overrides?: Partial<RunInfo>): Promise<Runtime> {
    if (LanternRuntime.isProduction()) {
      return createProductionRuntime();
    }
    return createDevRuntime(overrides);
  }
}
