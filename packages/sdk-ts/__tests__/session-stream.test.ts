// Tests for sessions.streamMessage — the token-streaming async iterator.
// Mocks both the POST /v1/sessions/{id}/messages response and the SSE
// stream on GET /v1/sessions/{id}/events so we never hit a real server.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LanternClient, MessageStreamError } from "../src/client.js";
import type { SessionStreamEvent } from "../src/types.js";

const realFetch = globalThis.fetch;

// Build a minimal ReadableStream that emits the given SSE chunks in sequence.
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

// Serialise a named SSE event block.
function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Set up fetch to:
 *  1st call  → POST sendMessage  → 200 { status: "ok" }
 *  2nd call  → GET SSE events    → 200 text/event-stream with sseChunks
 */
function mockStreamFetch(sseChunks: string[]) {
  let callCount = 0;
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    callCount++;
    if (callCount === 1) {
      // SSE connection (opened first by streamSessionMessage)
      return new Response(sseStream(sseChunks), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    // sendMessage POST
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("sessions.streamMessage", () => {
  let client: LanternClient;

  beforeEach(() => {
    client = new LanternClient({ apiKey: "k", baseUrl: "http://localhost:9" });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("yields delta events and a completed event in order", async () => {
    const chunks = [
      sseEvent("message_delta", { seq: 1, delta: "Hello" }),
      sseEvent("message_delta", { seq: 2, delta: " world" }),
      sseEvent("message_completed", {
        text: "Hello world",
        usage: { tokensIn: 5, tokensOut: 10, costUsd: 0.001 },
      }),
    ];
    mockStreamFetch(chunks);

    const events: SessionStreamEvent[] = [];
    for await (const e of client.sessions.streamMessage("s1", { content: "hi" })) {
      events.push(e);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "delta", delta: "Hello" });
    expect(events[1]).toEqual({ type: "delta", delta: " world" });
    expect(events[2]).toEqual({
      type: "completed",
      text: "Hello world",
      usage: { tokensIn: 5, tokensOut: 10, costUsd: 0.001 },
    });
  });

  it("buffers and yields out-of-order deltas in seq order", async () => {
    // seq 2 arrives before seq 1
    const chunks = [
      sseEvent("message_delta", { seq: 2, delta: " world" }),
      sseEvent("message_delta", { seq: 1, delta: "Hello" }),
      sseEvent("message_completed", {
        text: "Hello world",
        usage: { tokensIn: 5, tokensOut: 10, costUsd: 0.001 },
      }),
    ];
    mockStreamFetch(chunks);

    const deltas: string[] = [];
    for await (const e of client.sessions.streamMessage("s1", { content: "hi" })) {
      if (e.type === "delta") deltas.push(e.delta);
    }

    // Even though seq 2 arrived first, seq 1 is yielded first.
    expect(deltas).toEqual(["Hello", " world"]);
  });

  it("skips duplicate seq numbers", async () => {
    const chunks = [
      sseEvent("message_delta", { seq: 1, delta: "Hello" }),
      sseEvent("message_delta", { seq: 1, delta: "Hello" }), // duplicate
      sseEvent("message_delta", { seq: 2, delta: "!" }),
      sseEvent("message_completed", {
        text: "Hello!",
        usage: { tokensIn: 2, tokensOut: 3, costUsd: 0 },
      }),
    ];
    mockStreamFetch(chunks);

    const deltas: string[] = [];
    for await (const e of client.sessions.streamMessage("s1", { content: "hi" })) {
      if (e.type === "delta") deltas.push(e.delta);
    }

    expect(deltas).toEqual(["Hello", "!"]);
  });

  it("throws MessageStreamError on message_error event", async () => {
    const chunks = [
      sseEvent("message_delta", { seq: 1, delta: "Hello" }),
      sseEvent("message_error", { error: "rate limit exceeded" }),
    ];
    mockStreamFetch(chunks);

    const collected: SessionStreamEvent[] = [];
    await expect(async () => {
      for await (const e of client.sessions.streamMessage("s1", { content: "hi" })) {
        collected.push(e);
      }
    }).rejects.toThrow(MessageStreamError);

    // The delta before the error was still yielded.
    expect(collected[0]).toEqual({ type: "delta", delta: "Hello" });
  });

  it("ignores unknown event kinds (unknown-event-tolerant)", async () => {
    const chunks = [
      "event: agent.thinking\ndata: {}\n\n",
      sseEvent("message_delta", { seq: 1, delta: "Hi" }),
      "event: agent.tool_call_started\ndata: {\"name\":\"search\"}\n\n",
      sseEvent("message_completed", {
        text: "Hi",
        usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
      }),
    ];
    mockStreamFetch(chunks);

    const events: SessionStreamEvent[] = [];
    for await (const e of client.sessions.streamMessage("s1", { content: "hi" })) {
      events.push(e);
    }

    // Only delta + completed, not the unknown events.
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("delta");
    expect(events[1].type).toBe("completed");
  });

  it("handles chunks split across multiple reads (fragmented SSE)", async () => {
    // The SSE event arrives in two separate reads.
    const encoder = new TextEncoder();
    const full = sseEvent("message_delta", { seq: 1, delta: "frag" }) +
      sseEvent("message_completed", { text: "frag", usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 } });
    // Split in the middle of the first event
    const half = Math.floor(full.length / 2);
    const part1 = full.slice(0, half);
    const part2 = full.slice(half);

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(sseStream([part1, part2]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const events: SessionStreamEvent[] = [];
    for await (const e of client.sessions.streamMessage("s1", { content: "hi" })) {
      events.push(e);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", delta: "frag" });
    expect(events[1].type).toBe("completed");
  });
});
