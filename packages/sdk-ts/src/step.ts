import type { StepOptions } from "./types.js";

type StepFn<T> = () => Promise<T>;

interface StepAPI {
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

function createStepProxy(): StepAPI {
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

  return handler as StepAPI;
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

export const step: StepAPI = createStepProxy();
