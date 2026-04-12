# Streaming — End-to-End, No Buffering

> **What this is:** how token streams, tool-call events, step events, and log lines flow from the agent process all the way to the user's eyeballs without any service buffering them. Read this if you're touching the gateway, the workflow engine, the SDK, or the dashboard.
>
> **Why it matters:** streaming is the difference between an AI product that feels alive and one that feels broken. The first byte must arrive within ~150ms of the user pressing Enter. Token-by-token output must flow with no perceptible stutter. Reconnects must resume mid-stream.

---

## The invariant

> **No service in the data path may buffer a complete response before forwarding it.**

This is in `CLAUDE.md` as architectural invariant #4. It is load-bearing. If a service ever needs to "collect, transform, then send", it has to do so as a streaming transform with bounded buffer.

---

## Protocols

| Hop | Wire | Why |
|---|---|---|
| Provider → Model Router | OpenAI Chat Completions SSE / Anthropic Messages SSE / vLLM SSE / native | What providers give us |
| Model Router → Workflow Engine | gRPC server-streaming | mTLS, backpressure, multiplexing |
| Workflow Engine → Runtime Manager | gRPC bidi (the agent process talks back) | Bidi for `step()` round-trips |
| Runtime Manager → Gateway | gRPC server-streaming | Same |
| Gateway → SDK | **SSE** (default), **WebSocket** (when bidi needed), **gRPC-Web** (TS) | SSE is universal and HTTP/2-friendly |
| Gateway → Dashboard | SSE for run inspector; WebSocket for live multi-stream | Browsers; React Server Components |

We pick one wire per hop and stick with it. The model router normalizes all upstream provider formats to a single normalized stream that everything downstream consumes.

---

## The unified event envelope

Every streamed event flows through the same envelope:

```protobuf
message StreamEvent {
  // Identity
  string  run_id      = 1;
  string  step_id     = 2;
  uint64  seq         = 3;          // monotonic per (run_id, step_id)
  google.protobuf.Timestamp ts = 4;

  // Discriminator
  oneof payload {
    LlmDelta       llm_delta       = 10;   // token chunk from a model call
    LlmComplete    llm_complete    = 11;   // model call finished
    ToolCall       tool_call       = 12;   // model decided to call a tool
    ToolResult     tool_result     = 13;   // tool returned
    StepStarted    step_started    = 14;
    StepCompleted  step_completed  = 15;
    StepFailed     step_failed     = 16;
    LogLine        log             = 17;
    ScreenFrame    screen_frame    = 18;   // for computer-use agents
    Question       question        = 19;   // ctx.ask waiting on user
    ApprovalGate   approval        = 20;   // ctx.approval.request
    Heartbeat      heartbeat       = 21;
    StreamEnd      end             = 22;
  }
}
```

The same envelope shape is used over gRPC (binary protobuf) and SSE (the protobuf is JSON-encoded with one event per `data:` line). The dashboard and SDK have one decoder that handles either.

---

## SSE format (the wire most clients see)

```
event: stream_event
id: 4711
retry: 1500
data: {"run_id":"r_01HX...","step_id":"plan","seq":12,"ts":"2026-04-11T22:14:33Z","llm_delta":{"text":" hello"}}

event: stream_event
id: 4712
data: {"run_id":"r_01HX...","step_id":"plan","seq":13,"ts":"...","llm_delta":{"text":" world"}}

event: stream_event
id: 4713
data: {"run_id":"r_01HX...","seq":14,"ts":"...","heartbeat":{}}

...

event: stream_event
id: 5000
data: {"run_id":"r_01HX...","seq":99,"ts":"...","end":{"reason":"completed"}}
```

Each event has a unique `id` (the `seq` from the envelope), so SSE's native `Last-Event-ID` reconnect header lets the client resume after a network blip. The gateway honors `Last-Event-ID` by replaying buffered events from Redis (last 5 minutes of stream is buffered per run).

---

## Backpressure end to end

A naive streaming chain breaks when the slowest hop falls behind: producers blast bytes, intermediate buffers fill, latency explodes, OOMs follow.

We honor backpressure at every hop:

| Hop | Mechanism |
|---|---|
| Provider → Model Router | The router reads as fast as it can; bounded `tokio::mpsc` to the next hop |
| Model Router → Workflow Engine | gRPC server-streaming with HTTP/2 flow control. Bounded `tokio::mpsc` (1024 events) |
| Engine → Runtime Manager | bidi gRPC; the runtime manager pulls at its own rate |
| Runtime Manager → Gateway | gRPC server-streaming, bounded channel |
| Gateway → SDK | SSE writes block on the OS socket buffer; gateway's send loop yields when full |
| SDK → user code | Async iterator (`for await`) — user code pulls naturally |

When any hop slows, backpressure propagates upstream. The model router's read from the provider stops, which throttles the provider's TCP send window, which throttles the upstream model. **No data is dropped, no buffer grows unbounded.**

The exception is **screen frame** events for computer-use agents — they're frame-droppable. If the dashboard can't keep up, we drop intermediate frames and forward only the latest. This is the only frame-dropping path; everything else is lossless.

---

## Reconnect / resume

Three resume mechanisms, in order of preference:

1. **SSE `Last-Event-ID`**: the client sends the last seq it saw; the gateway replays from Redis buffer. Works for ≤ 5 min disconnects.

2. **`generation_id` from the model router**: the model router emits a `generation_id` on the first token chunk of every LLM call. If a downstream client reconnects, it can ask the router to resume from that generation. The router forwards the resume request to the provider — Anthropic and OpenAI both support this. If the provider doesn't, the router replays its own buffered response (last 60s).

3. **Run-level resume**: the SDK supports `runs.events(run_id, { from_seq: N })` to fetch any historical run's event stream from the journal. This works indefinitely — old runs can be replayed for the dashboard inspector months later.

---

## Heartbeats

Every 15 seconds (configurable), the gateway sends a `heartbeat` event to every active stream. This serves three purposes:

1. **Keep-alive** through corporate proxies and CDNs that drop idle HTTP connections after 30-60s.
2. **Health signal** — if the client doesn't see a heartbeat for 30s, it knows the connection is dead and triggers reconnect.
3. **Liveness signal** — if the agent has been silently working on a long step, the client sees regular heartbeats and knows something is happening.

Heartbeats carry no payload other than the timestamp, so they're cheap.

---

## In the SDK (consumer side)

```ts
const stream = await lantern.runs.create({
  agent: "research-agent",
  input: { query: "..." },
  stream: true,
});

for await (const event of stream) {
  switch (event.kind) {
    case "llm_delta":
      process.stdout.write(event.text);
      break;
    case "tool_call":
      console.log(`\n[tool: ${event.tool} ${JSON.stringify(event.args)}]\n`);
      break;
    case "step_completed":
      console.log(`\n✓ ${event.step_id}`);
      break;
    case "end":
      return event.reason;
  }
}
```

The async iterator handles:
- Connection reconnect with `Last-Event-ID`
- Heartbeat detection
- Backpressure (the producer pauses when the consumer falls behind)
- Cancellation (`stream.return()` sends a cancel to the gateway)

---

## In the dashboard (React Server Components)

Next.js 15 RSC + streaming maps perfectly onto SSE:

```tsx
async function RunInspector({ runId }: { runId: string }) {
  const events = await lantern.runs.events(runId, { live: true });
  return (
    <Suspense fallback={<RunSkeleton />}>
      <StreamingEvents events={events} />
    </Suspense>
  );
}
```

The `events` stream is consumed inside an RSC; each event chunk re-renders just the affected card. No client-side WebSocket library, no Redux, no manual subscription management. The dashboard is essentially a streaming HTML page.

For cases that need bidi (the user typing back at a `ctx.ask` prompt while the agent is running), the dashboard uses a WebSocket parallel to the SSE stream — outbound only.

---

## Model-call streaming specifics

LLM token streams are the primary thing users see. The chain:

```
provider SSE/binary → model-router (decode + normalize)
                              │
                              ▼
                     normalized LlmDelta events
                              │
                              ▼
              workflow-engine (annotate with step_id, seq)
                              │
                              ▼
                  runtime-manager (forwards as-is)
                              │
                              ▼
                       gateway (SSE encode)
                              │
                              ▼
                          SDK / dashboard
```

Latency budget for the first token (TTFT, time-to-first-token):

| Component | Budget |
|---|---|
| Network to provider | varies (provider-dependent) |
| Provider TTFT | 200-2000ms (model-dependent) |
| Model router decode + normalize | < 5ms |
| Workflow engine annotate + forward | < 5ms |
| Runtime manager forward | < 1ms |
| Gateway SSE encode + send | < 5ms |
| **Lantern overhead total** | **< 20ms** |

So if Claude Sonnet has 600ms TTFT, the user sees the first token at ~620ms. Lantern adds nothing meaningful to perceived latency.

---

## Tool-call streaming

When the model decides to call a tool:

1. The model emits a `tool_call` event with the tool name and arguments (often as JSON deltas across multiple chunks for streaming-aware providers).
2. The model router accumulates the JSON until valid, then emits a `tool_call` envelope.
3. The workflow engine wraps the tool call in a `step()` (idempotency + replay).
4. The runtime manager invokes the tool in the sandbox.
5. The result streams back as `tool_result`.
6. The model continues with the result in its context.

**The user sees every step of this in the dashboard.** Each tool call is a card; each result is a child card; expanded views show the JSON. This is critical for debugging multi-step agents.

---

## Computer-use frame stream

For agents that drive a desktop:

- Frame format: VP9 (preferred) or H.264, 5-10 FPS, downscaled to 720p
- Encoded by the runtime manager (FFmpeg in a sidecar)
- Streamed as `screen_frame` events with frame data in a side channel (binary, not JSON-encoded)
- Frame-droppable: the gateway only forwards the latest frame if the consumer is behind
- Bandwidth: ~250-500 kbps per stream, fine on cellular

The mobile app and dashboard have a `<ScreenStream runId={...}/>` component that subscribes to a session's frames and displays them with low-latency canvas rendering.

Inputs (mouse, keyboard, taps) flow back via WebSocket — the user can take over with a tap.

---

## Cancellation

The user hits "cancel" in the dashboard. Flow:

```
dashboard → SDK → gateway: POST /v1/runs/{id}/cancel
                  gateway: forward to control plane
                  control plane: forward to workflow engine
                  workflow engine: write run.cancelled journal event
                  workflow engine: SIGTERM the runtime manager's stream
                  runtime manager: SIGTERM the agent process
                  runtime manager: emits step.cancelled events
                  workflow engine: forwards as stream events
                  gateway: forwards SSE
                  dashboard: shows cancelled state
```

Cancellation is **cooperative**: the agent code can run cleanup in a `finally` block before exiting. Hard kill happens after a configurable grace period (default 5s).

---

## Failure modes

| Failure | Recovery |
|---|---|
| Network blip between SDK and gateway | SSE reconnect with `Last-Event-ID`; resume from buffer |
| Gateway crash | New gateway picks up the stream from Redis buffer; client reconnects |
| Workflow engine crash mid-stream | Run goes through normal durable resume; new stream resumes from journal |
| Provider stream stall | Model router timeout (configurable); failover to next provider; agent gets a continued stream |
| Slow consumer (dashboard tab in background) | Backpressure; producer slows; no data loss |
| Consumer abandons stream | TCP RST; gateway notices in send loop; cancels upstream |

---

## What's intentionally NOT here

- **No buffer-and-batch.** No service ever holds 200ms of tokens to "make the stream smoother." Smoothness comes from low overhead, not from buffering.
- **No proprietary streaming protocol.** SSE for clients (universal), gRPC streaming internally (standard).
- **No special "low-latency" tier.** All streams are low-latency by default.

---

## See also

- [`06-model-router.md`](06-model-router.md) — generation IDs and provider failover
- [`12-control-surfaces.md`](12-control-surfaces.md) — how SSE flows to mobile/chat surfaces
- [`adr/0004-streaming-protocol.md`](../adr/0004-streaming-protocol.md) — why SSE not WebSocket for the default
