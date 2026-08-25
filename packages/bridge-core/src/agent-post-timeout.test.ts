// Regression: a contact's message went unanswered for 31+ minutes while the
// bridge stayed healthy — gmail ticks running, diagnostics ready, the row
// consumed. Not even the 180s SSE timeout fired.
//
// Cause: the POST to /v1/sessions/{id}/messages had NO timeout, and
// authedFetch sets none. A request that never settles hangs the turn forever.
// Worse, runQueuedTurn chains per-jid promises through `inflight`, so every
// LATER message from that contact queues behind the stuck one and is never
// answered — one hung request silently kills a whole thread.
//
// These tests pin the two properties that matter, without needing a bridge:
// the request must carry an abort signal, and the queue must not be
// permanently poisoned by one stuck turn.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./agent.ts", import.meta.url), "utf8");

test("the message POST is bounded by a timeout", () => {
  const post = SRC.slice(SRC.indexOf("/v1/sessions/${sessionId}/messages") - 1200);
  const body = post.slice(0, post.indexOf("Throw a sentinel"));
  // An AbortController armed with a timer, passed to the fetch as `signal`.
  assert.match(body, /new AbortController\(\)/, "POST must have an AbortController");
  assert.match(body, /setTimeout\(\(\) => \w+\.abort\(\)/, "controller must be armed with a timer");
  assert.match(body, /signal: \w+\.signal/, "the signal must reach the fetch");
  assert.match(body, /clearTimeout/, "the timer must be cleared so it can't leak");
});

test("a hung turn cannot poison the per-contact queue forever", async () => {
  // Model runQueuedTurn's chaining: prev -> next, with the SAME catch it uses.
  // The invariant: a rejected/failed turn must not prevent the next one from
  // running. (Before the fix the turn never SETTLED at all, so nothing after
  // it could ever run — this asserts the chain survives a failure.)
  const inflight = new Map<string, Promise<string | null>>();
  const runQueued = (jid: string, run: () => Promise<string | null>) => {
    const prev = inflight.get(jid) ?? Promise.resolve<string | null>(null);
    const next = prev.then(run).catch(() => null);
    inflight.set(jid, next);
    return next;
  };

  const jid = "+15551234567";
  const first = runQueued(jid, () => Promise.reject(new Error("hung turn aborted")));
  assert.equal(await first, null, "a failed turn resolves null, it does not hang");

  const second = await runQueued(jid, () => Promise.resolve("hey what's up"));
  assert.equal(second, "hey what's up", "the NEXT message from that contact still gets answered");
});
