// Bounded exponential backoff retry helper for bridge HTTP calls.
//
// CLAUDE.md mandates @lantern/retry — that package does not yet exist in
// this repo. This local helper fills the gap until the canonical package
// is created. When @lantern/retry ships, replace the import in agent.ts
// and delete this file.
//
// Usage:
//   const result = await withRetry(() => fetch(...), {
//     shouldRetry: isTransientError,
//   });

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default 3. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Default 500. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default 4000. */
  maxDelayMs?: number;
  /** Return true if this error/response warrants a retry. */
  shouldRetry: (err: unknown) => boolean;
}

/** Sleep for `ms` milliseconds. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Full-jitter exponential backoff: delay = random(0, min(cap, base * 2^attempt)).
 * Spreads thundering-herd retries across the retry window.
 */
function backoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.random() * ceiling;
}

/**
 * Call `fn` up to `maxAttempts` times, retrying when `shouldRetry` returns
 * true. Re-throws the last error when all attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 4000;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt + 1 >= maxAttempts || !opts.shouldRetry(err)) throw err;
      await sleep(backoffMs(attempt, baseDelayMs, maxDelayMs));
    }
  }
  // Unreachable but satisfies TypeScript.
  throw lastErr;
}

/**
 * Returns true for HTTP status codes and network errors that are safe to
 * retry (transient): 429 Too Many Requests, 503 Service Unavailable, and
 * network-layer failures (ECONNREFUSED, fetch-failed, etc.).
 *
 * Returns false for 4xx auth/validation errors (401, 403, 404, 409) and
 * any 2xx/3xx (should not be reaching this in the error path anyway).
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof TransientHttpError) return true;
  // Network errors: fetch throws a TypeError with a message that varies
  // by runtime ("fetch failed", "Failed to fetch", "ECONNREFUSED …").
  if (err instanceof TypeError) {
    const msg = (err.message ?? "").toLowerCase();
    return (
      msg.includes("fetch failed") ||
      msg.includes("failed to fetch") ||
      msg.includes("econnrefused") ||
      msg.includes("network") ||
      msg.includes("socket") ||
      msg.includes("etimedout") ||
      msg.includes("econnreset")
    );
  }
  return false;
}

/**
 * Sentinel error thrown by `fetchWithRetry` when the server returns a
 * retryable HTTP status (429, 503). This keeps the retry logic outside
 * the `Response` value so `withRetry` can see it uniformly.
 */
export class TransientHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`HTTP ${status}`);
    this.name = "TransientHttpError";
  }
}
