// Unit tests for the bridge retry helper (retry.ts).
// Run: cd packages/bridge-core && npx tsx --test src/retry.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { withRetry, isTransientError, TransientHttpError } from "./retry.ts";

// ---------------------------------------------------------------------------
// withRetry — happy path (succeeds on first try)
// ---------------------------------------------------------------------------

test("withRetry: returns result immediately when fn succeeds first time", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      return "ok";
    },
    {
      shouldRetry: () => true,
    },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// withRetry — retries on transient error, eventually succeeds
// ---------------------------------------------------------------------------

test("withRetry: retries on TransientHttpError (429) then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 2) throw new TransientHttpError(429, "rate limited");
      return "reply";
    },
    {
      maxAttempts: 3,
      baseDelayMs: 0, // no delay in tests
      maxDelayMs: 0,
      shouldRetry: isTransientError,
    },
  );
  assert.equal(result, "reply");
  assert.equal(calls, 2, "should have needed exactly 2 calls");
});

test("withRetry: retries on network TypeError (ECONNREFUSED) then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed: ECONNREFUSED");
      return "recovered";
    },
    {
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      shouldRetry: isTransientError,
    },
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 3);
});

// ---------------------------------------------------------------------------
// withRetry — exhausts attempts and surfaces error
// ---------------------------------------------------------------------------

test("withRetry: throws after maxAttempts exhausted", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new TransientHttpError(503, "service unavailable");
        },
        {
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
          shouldRetry: isTransientError,
        },
      ),
    (err: unknown) => {
      assert.ok(err instanceof TransientHttpError, "should re-throw the last TransientHttpError");
      assert.equal((err as TransientHttpError).status, 503);
      return true;
    },
  );
  assert.equal(calls, 3, "should have attempted exactly 3 times");
});

// ---------------------------------------------------------------------------
// withRetry — does NOT retry non-transient errors
// ---------------------------------------------------------------------------

test("withRetry: does not retry on 401 (non-transient error type)", async () => {
  let calls = 0;
  // A plain Error (not TransientHttpError, not network TypeError) is not transient.
  const authError = new Error("HTTP 401 Unauthorized");
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw authError;
        },
        {
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
          shouldRetry: isTransientError,
        },
      ),
    (err: unknown) => {
      assert.equal(err, authError);
      return true;
    },
  );
  assert.equal(calls, 1, "should not have retried a non-transient error");
});

test("withRetry: does not retry on 404 (non-transient error type)", async () => {
  let calls = 0;
  const notFound = new Error("HTTP 404 Not Found");
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw notFound;
        },
        {
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
          shouldRetry: isTransientError,
        },
      ),
  );
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// isTransientError
// ---------------------------------------------------------------------------

test("isTransientError: true for TransientHttpError (any status)", () => {
  assert.ok(isTransientError(new TransientHttpError(429, "")));
  assert.ok(isTransientError(new TransientHttpError(503, "")));
});

test("isTransientError: true for network TypeErrors", () => {
  assert.ok(isTransientError(new TypeError("fetch failed")));
  assert.ok(isTransientError(new TypeError("Failed to fetch")));
  assert.ok(isTransientError(new TypeError("connect ECONNREFUSED 127.0.0.1:8080")));
  assert.ok(isTransientError(new TypeError("socket hang up")));
  assert.ok(isTransientError(new TypeError("read ETIMEDOUT")));
  assert.ok(isTransientError(new TypeError("read ECONNRESET")));
  assert.ok(isTransientError(new TypeError("network error")));
});

test("isTransientError: false for plain Error (not a network or TransientHttpError)", () => {
  assert.equal(isTransientError(new Error("HTTP 401")), false);
  assert.equal(isTransientError(new Error("something else")), false);
  assert.equal(isTransientError("string error"), false);
  assert.equal(isTransientError(null), false);
  assert.equal(isTransientError(undefined), false);
});

test("isTransientError: false for TypeError with non-network message", () => {
  // A TypeError from a programming error (e.g., Cannot read property) is not transient.
  assert.equal(isTransientError(new TypeError("Cannot read properties of undefined")), false);
});

// ---------------------------------------------------------------------------
// TransientHttpError
// ---------------------------------------------------------------------------

test("TransientHttpError: carries status and body", () => {
  const err = new TransientHttpError(429, "rate limit exceeded");
  assert.equal(err.status, 429);
  assert.equal(err.body, "rate limit exceeded");
  assert.equal(err.name, "TransientHttpError");
  assert.ok(err instanceof Error);
});
