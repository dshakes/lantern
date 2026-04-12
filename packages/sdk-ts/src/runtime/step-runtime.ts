/**
 * Production step implementation with journal-aware replay.
 *
 * When running inside a Lantern sandbox, every step call goes through
 * the workflow engine's journal. If a step has already executed (e.g.
 * during a replay after a crash), the cached result is returned
 * immediately. Otherwise the step function executes, the result is
 * journaled, and then returned.
 *
 * Retry policies are enforced by the engine, not the SDK. The SDK
 * reports failures and lets the engine decide whether to retry.
 */

import type { StepOptions, RetryPolicy } from "../types.js";
import type { Runtime } from "./runtime.js";
import type { RequestMeta } from "./grpc-client.js";
import {
  LanternStepError,
  LanternTimeoutError,
  LanternCancelledError,
} from "./errors.js";
import { traced } from "./tracing.js";

// ---------------------------------------------------------------------------
// Duration parser (shared with dev mode step.ts)
// ---------------------------------------------------------------------------

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
// Retry policy conversion
// ---------------------------------------------------------------------------

function toGrpcRetryPolicy(policy: RetryPolicy | undefined) {
  if (!policy) return undefined;
  return {
    maxAttempts: policy.maxAttempts ?? 3,
    initialIntervalMs: policy.initialInterval
      ? parseDuration(policy.initialInterval)
      : 1000,
    backoff: policy.backoff ?? 2,
    maxIntervalMs: policy.maxInterval
      ? parseDuration(policy.maxInterval)
      : 60_000,
    nonRetryable: policy.nonRetryable ?? [],
  };
}

// ---------------------------------------------------------------------------
// Step ID generation
// ---------------------------------------------------------------------------

let stepCounter = 0;

/**
 * Generate a unique step ID for this execution.
 * Format: `<stepName>-<counter>` to ensure uniqueness within a run.
 */
function nextStepId(name: string): string {
  stepCounter++;
  return `${name}-${stepCounter}`;
}

/** Reset the step counter (called at the start of each run). */
export function resetStepCounter(): void {
  stepCounter = 0;
}

// ---------------------------------------------------------------------------
// StepAPI interface (same shape as the dev-mode one in step.ts)
// ---------------------------------------------------------------------------

type StepFn<T> = () => Promise<T>;

export interface StepAPI {
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

// ---------------------------------------------------------------------------
// Production step proxy
// ---------------------------------------------------------------------------

/**
 * Create a production step proxy that routes all step operations
 * through the runtime sidecar and workflow engine journal.
 */
export function createProductionStepProxy(runtime: Runtime): StepAPI {
  const sidecar = runtime.sidecar;
  if (!sidecar) {
    throw new LanternStepError("__init__", 0, false, "Production step proxy requires a sidecar connection");
  }

  /**
   * Execute a single step with journal-aware replay.
   *
   * 1. Check if the step result exists in the journal (replay).
   * 2. If yes: return the cached result immediately.
   * 3. If no: execute the step function, journal the result.
   * 4. On failure: report to the engine, which decides retry/propagate.
   */
  const handler = async <T>(
    name: string,
    fn: StepFn<T>,
    opts?: StepOptions,
  ): Promise<T> => {
    const stepId = nextStepId(name);
    const meta: RequestMeta = {
      ...runtime.meta,
      stepId,
      idempotencyKey: `${runtime.meta.runId}:${stepId}`,
    };

    return traced("step.execute", { step: name, stepId }, async (span) => {
      // Check abort signal before starting.
      if (runtime.abortSignal.aborted) {
        throw new LanternCancelledError(
          runtime.abortSignal.reason instanceof Error
            ? runtime.abortSignal.reason.message
            : "Run cancelled",
        );
      }

      // 1. Check journal for cached result (replay path).
      const lookup = await sidecar.journalLookup({ meta, stepName: name });
      if (lookup.found && lookup.resultJson !== undefined) {
        span.setAttribute("cached", true);
        return JSON.parse(lookup.resultJson) as T;
      }

      // 2. Execute the step function.
      const startMs = Date.now();
      let result: T;
      try {
        if (opts?.timeout) {
          result = await executeWithTimeout(fn, parseDuration(opts.timeout), name);
        } else {
          result = await fn();
        }
      } catch (err) {
        // 4. On failure: journal the error, let the engine decide retry.
        const durationMs = Date.now() - startMs;
        const errorMessage = err instanceof Error ? err.message : String(err);

        await sidecar.journalWrite({
          meta,
          stepName: name,
          resultJson: "null",
          attempt: 1,
          durationMs,
          error: errorMessage,
        });

        if (err instanceof LanternStepError || err instanceof LanternTimeoutError) {
          throw err;
        }
        throw new LanternStepError(name, 1, true, errorMessage);
      }

      // 3. Journal the successful result.
      const durationMs = Date.now() - startMs;
      const resultJson = JSON.stringify(result);
      await sidecar.journalWrite({
        meta,
        stepName: name,
        resultJson,
        attempt: 1,
        durationMs,
      });

      span.setAttribute("cached", false);
      span.setAttribute("durationMs", durationMs);
      return result;
    });
  };

  /**
   * step.map: execute a step for each item in parallel, respecting concurrency.
   *
   * Each item becomes its own journaled sub-step so that partial progress
   * survives a replay.
   */
  handler.map = async <TItem, TResult>(
    name: string,
    items: TItem[],
    fn: (item: TItem, index: number) => Promise<TResult>,
    opts?: StepOptions & { concurrency?: number },
  ): Promise<TResult[]> => {
    return traced("step.map", { step: name, count: items.length }, async () => {
      const concurrency = opts?.concurrency ?? items.length;
      const results: TResult[] = new Array(items.length);
      const queue = [...items.entries()];

      const worker = async () => {
        while (queue.length > 0) {
          if (runtime.abortSignal.aborted) {
            throw new LanternCancelledError();
          }
          const entry = queue.shift();
          if (!entry) break;
          const [i, item] = entry;
          results[i] = await handler(
            `${name}[${i}]`,
            () => fn(item, i),
            opts,
          );
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
      );

      return results;
    });
  };

  /**
   * step.race: execute multiple step functions in parallel, return the first
   * successful result, and cancel the others.
   *
   * The winning result is journaled; losers are discarded.
   */
  handler.race = async <T>(
    name: string,
    fns: Array<() => Promise<T>>,
    opts?: StepOptions,
  ): Promise<T> => {
    return traced("step.race", { step: name, count: fns.length }, async () => {
      // Check journal first: if the race already completed, return cached.
      const raceStepId = nextStepId(`${name}:race`);
      const raceMeta: RequestMeta = {
        ...runtime.meta,
        stepId: raceStepId,
        idempotencyKey: `${runtime.meta.runId}:${raceStepId}`,
      };

      const lookup = await sidecar.journalLookup({ meta: raceMeta, stepName: `${name}:race` });
      if (lookup.found && lookup.resultJson !== undefined) {
        return JSON.parse(lookup.resultJson) as T;
      }

      // Run all contestants. Use an AbortController so we can cancel losers.
      const raceController = new AbortController();

      const contestants = fns.map((fn, i) =>
        handler(`${name}:contestant-${i}`, async () => {
          if (raceController.signal.aborted) {
            throw new LanternCancelledError("Race contestant cancelled");
          }
          return fn();
        }, opts),
      );

      try {
        const result = await Promise.race(contestants);
        raceController.abort();

        // Journal the winning result.
        await sidecar.journalWrite({
          meta: raceMeta,
          stepName: `${name}:race`,
          resultJson: JSON.stringify(result),
          attempt: 1,
          durationMs: 0,
        });

        return result;
      } catch (err) {
        raceController.abort();
        throw err;
      }
    });
  };

  /**
   * step.sleep: suspend execution for a duration.
   *
   * In production this sends a sleep request to the workflow engine,
   * which persists the timer durably. The microVM may be snapshotted
   * and restored when the timer fires.
   */
  handler.sleep = async (name: string, duration: string): Promise<void> => {
    const stepId = nextStepId(`${name}:sleep`);
    const meta: RequestMeta = {
      ...runtime.meta,
      stepId,
      idempotencyKey: `${runtime.meta.runId}:${stepId}`,
    };

    return traced("step.sleep", { step: name, duration }, async () => {
      // Check journal: if the sleep already completed, return immediately.
      const lookup = await sidecar.journalLookup({ meta, stepName: `${name}:sleep` });
      if (lookup.found) {
        return;
      }

      const durationMs = parseDuration(duration);
      await sidecar.sleep({ meta, stepName: `${name}:sleep`, durationMs });

      // Journal the completion so replays skip the sleep.
      await sidecar.journalWrite({
        meta,
        stepName: `${name}:sleep`,
        resultJson: "null",
        attempt: 1,
        durationMs,
      });
    });
  };

  /**
   * step.signal: wait for an external signal.
   *
   * The workflow engine blocks until a matching signal is delivered
   * (via the API or another agent) or the timeout expires.
   */
  handler.signal = async <T = unknown>(
    name: string,
    opts?: { timeout?: string },
  ): Promise<T> => {
    const stepId = nextStepId(`${name}:signal`);
    const meta: RequestMeta = {
      ...runtime.meta,
      stepId,
      idempotencyKey: `${runtime.meta.runId}:${stepId}`,
    };

    return traced("step.signal", { step: name }, async () => {
      // Check journal for cached signal value.
      const lookup = await sidecar.journalLookup({ meta, stepName: `${name}:signal` });
      if (lookup.found && lookup.resultJson !== undefined) {
        return JSON.parse(lookup.resultJson) as T;
      }

      const timeoutMs = opts?.timeout ? parseDuration(opts.timeout) : undefined;
      const response = await sidecar.waitForSignal({
        meta,
        signalName: name,
        timeoutMs,
      });

      const value = JSON.parse(response.valueJson) as T;

      // Journal the signal value for replay.
      await sidecar.journalWrite({
        meta,
        stepName: `${name}:signal`,
        resultJson: response.valueJson,
        attempt: 1,
        durationMs: 0,
      });

      return value;
    });
  };

  return handler as StepAPI;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Execute a function with a timeout. Throws LanternTimeoutError if the
 * function does not complete within the given duration.
 */
async function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  stepName: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new LanternTimeoutError(stepName, 1, `${timeoutMs}ms`));
      }
    }, timeoutMs);

    fn().then(
      (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      },
    );
  });
}
