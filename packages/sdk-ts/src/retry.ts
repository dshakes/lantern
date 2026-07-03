// Bounded exponential backoff retry helper for LanternClient's HTTP calls.
//
// Mirrors packages/bridge-core/src/retry.ts (full-jitter exponential
// backoff). Duplicated locally rather than imported because sdk-ts is a
// standalone published package and must not depend on the bridge's
// internal package.

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default 3. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Default 500. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default 4000. */
  maxDelayMs?: number;
  /** Return true if this error warrants a retry. */
  shouldRetry: (err: unknown) => boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Full-jitter exponential backoff: delay = random(0, min(cap, base * 2^attempt)).
 */
function backoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.random() * ceiling;
}

/**
 * Call `fn` up to `maxAttempts` times, retrying when `shouldRetry` returns
 * true. Re-throws the last error when all attempts are exhausted.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
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
 * True for network-layer failures fetch throws as a TypeError (message
 * varies by runtime: "fetch failed", "Failed to fetch", "ECONNREFUSED", …).
 */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
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
