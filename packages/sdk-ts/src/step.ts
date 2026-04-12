import type { StepOptions } from "./types.js";
import { LanternRuntime } from "./runtime/runtime.js";
import type { Runtime } from "./runtime/runtime.js";
import { createProductionStepProxy } from "./runtime/step-runtime.js";
import type { StepAPI } from "./runtime/step-runtime.js";

type StepFn<T> = () => Promise<T>;

interface DevStepAPI {
  <T>(name: string, fn: StepFn<T>, opts?: StepOptions): Promise<T>;
  map<TItem, TResult>(
    name: string,
    items: TItem[],
    fn: (item: TItem, index: number) => Promise<TResult>,
    opts?: StepOptions & { concurrency?: number },
  ): Promise<TResult[]>;
  race<T>(
    name: string,
    fns: Array<() => Promise<T>>,
    opts?: StepOptions,
  ): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
  signal<T = unknown>(name: string, opts?: { timeout?: string }): Promise<T>;
}

/**
 * Create the dev-mode step proxy.
 *
 * In dev mode, steps execute directly without journal replay, the
 * workflow engine, or durable timers. This is the default behavior
 * when LANTERN_RUNTIME is not set.
 */
function createDevStepProxy(): DevStepAPI {
  const handler = async <T>(
    name: string,
    fn: StepFn<T>,
    _opts?: StepOptions,
  ): Promise<T> => {
    // In dev mode: execute directly.
    // In production: the runtime intercepts step() calls over gRPC
    // and checks the journal for cached results before executing.
    // This is the stub implementation for local dev / testing.
    return fn();
  };

  handler.map = async <TItem, TResult>(
    _name: string,
    items: TItem[],
    fn: (item: TItem, index: number) => Promise<TResult>,
    opts?: StepOptions & { concurrency?: number },
  ): Promise<TResult[]> => {
    const concurrency = opts?.concurrency ?? items.length;
    const results: TResult[] = new Array(items.length);
    const queue = [...items.entries()];

    const worker = async () => {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry) break;
        const [i, item] = entry;
        results[i] = await fn(item, i);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () =>
        worker(),
      ),
    );

    return results;
  };

  handler.race = async <T>(
    _name: string,
    fns: Array<() => Promise<T>>,
    _opts?: StepOptions,
  ): Promise<T> => {
    return Promise.race(fns.map((fn) => fn()));
  };

  handler.sleep = async (_name: string, duration: string): Promise<void> => {
    const ms = parseDuration(duration);
    await new Promise((resolve) => setTimeout(resolve, ms));
  };

  handler.signal = async <T = unknown>(
    _name: string,
    _opts?: { timeout?: string },
  ): Promise<T> => {
    throw new Error(
      "step.signal() is only available in the Lantern runtime. " +
        "In local dev, use a mock or test fixture.",
    );
  };

  return handler as DevStepAPI;
}

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: ${s}`);
  const [, val, unit] = match;
  const n = parseInt(val!, 10);
  switch (unit) {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}

// ---------------------------------------------------------------------------
// Runtime-aware step proxy factory
// ---------------------------------------------------------------------------

/** Production runtime reference, set by `setStepRuntime`. */
let _productionRuntime: Runtime | null = null;

/**
 * Inject the production runtime into the step module.
 *
 * Called by the runner when initializing a production execution.
 * Once set, all subsequent `step()` calls route through the
 * production step proxy (journal-aware, sidecar-backed).
 *
 * @param runtime - The production runtime.
 */
export function setStepRuntime(runtime: Runtime): void {
  _productionRuntime = runtime;
}

/**
 * Create the appropriate step proxy based on the current environment.
 *
 * - If a production runtime has been injected via `setStepRuntime`,
 *   returns the production step proxy.
 * - If LANTERN_RUNTIME=true but no runtime injected yet, returns
 *   a deferred proxy that throws helpful errors.
 * - Otherwise, returns the dev-mode step proxy.
 */
function createStepProxy(): StepAPI {
  if (_productionRuntime) {
    return createProductionStepProxy(_productionRuntime);
  }

  if (LanternRuntime.isProduction()) {
    // Production mode but runtime not yet injected.
    // Return a proxy that defers to the production runtime once available.
    return createDeferredStepProxy();
  }

  return createDevStepProxy() as unknown as StepAPI;
}

/**
 * Create a deferred step proxy for production mode.
 *
 * This proxy holds step calls until the production runtime is
 * initialized. Once `setStepRuntime` is called, all pending and
 * future calls go through the production proxy.
 */
function createDeferredStepProxy(): StepAPI {
  const getProxy = (): StepAPI => {
    if (_productionRuntime) {
      return createProductionStepProxy(_productionRuntime);
    }
    throw new Error(
      "step() called in production mode before the runtime was initialized. " +
        "Ensure the runner has called setStepRuntime() before invoking agent.run().",
    );
  };

  const handler = async <T>(
    name: string,
    fn: StepFn<T>,
    opts?: StepOptions,
  ): Promise<T> => {
    return getProxy()(name, fn, opts);
  };

  handler.map = async <TItem, TResult>(
    name: string,
    items: TItem[],
    fn: (item: TItem, index: number) => Promise<TResult>,
    opts?: StepOptions & { concurrency?: number },
  ): Promise<TResult[]> => {
    return getProxy().map(name, items, fn, opts);
  };

  handler.race = async <T>(
    name: string,
    fns: Array<() => Promise<T>>,
    opts?: StepOptions,
  ): Promise<T> => {
    return getProxy().race(name, fns, opts);
  };

  handler.sleep = async (name: string, duration: string): Promise<void> => {
    return getProxy().sleep(name, duration);
  };

  handler.signal = async <T = unknown>(
    name: string,
    opts?: { timeout?: string },
  ): Promise<T> => {
    return getProxy().signal(name, opts);
  };

  return handler as StepAPI;
}

export const step: StepAPI = createStepProxy();
