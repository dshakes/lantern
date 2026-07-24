import Link from "next/link";
import { Diagram } from "../../_components/Diagram";
import { Concept } from "../../_components/Concept";

export default function RuntimeStreamingPage() {
  return (
    <>
      <h1>Token Streaming</h1>
      <p>
        Session replies are streamed token-by-token from the model provider
        through the control-plane to the client. The streaming contract is a
        sequence of three named SSE events on{" "}
        <code>GET /v1/sessions/&#123;id&#125;/events</code>.
      </p>

      <Concept>
        Streaming is why chat UIs feel alive: instead of waiting ten seconds
        for a finished answer, words appear as the model writes them. Lantern
        passes each fragment (&quot;token&quot;) straight through to your app
        the moment it arrives — nothing along the path holds the response back
        to deliver it in one lump. Your app listens on a single long-lived
        HTTP connection (&quot;SSE&quot; — server-sent events, the same
        technique every chat product uses) and receives three kinds of
        messages: a fragment arrived, the reply finished, or something went
        wrong.
      </Concept>

      <Diagram
        name="streaming-sequence"
        caption="Provider deltas flow through the control-plane and Redis pub/sub to connected SSE clients. Tool-using turns buffer; tool-free turns stream every token."
      />

      <div className="callout callout-info">
        <strong>Shared tier only.</strong> Sessions run on the shared tier
        (inline executor). The streaming contract described here covers
        interactive sessions. Headless microVM runs stream{" "}
        <code>step_started</code> / <code>step_completed</code> / {" "}
        <code>step_failed</code> events, not token deltas.
      </div>

      <h2 id="events">The three events</h2>
      <p>
        A single assistant turn produces events in this order:
      </p>

      <h3 id="message_delta">
        <code>message_delta</code>
      </h3>
      <p>
        Emitted for each token chunk during streaming. Not emitted for
        tool-bearing turns (see limitation below).
      </p>
      <pre><code>{`{
  "sessionId": "sess_abc123",
  "turnId":    "tur_xyz789",    // stable across all events in this turn
  "seq":       1,               // monotone per-turn counter; starts at 1
  "delta":     "Hello"          // text fragment; one or more tokens
}`}</code></pre>

      <h3 id="message_completed">
        <code>message_completed</code>
      </h3>
      <p>
        Emitted exactly once per turn, after all deltas (or immediately for
        tool-bearing turns that do not stream). Contains the full assembled
        text and usage metadata.
      </p>
      <pre><code>{`{
  "sessionId": "sess_abc123",
  "turnId":    "tur_xyz789",
  "text":      "Hello, how can I help you today?",
  "usage": {
    "tokensIn":  42,
    "tokensOut": 12,
    "costUsd":   0.000018
  }
}`}</code></pre>

      <h3 id="message_error">
        <code>message_error</code>
      </h3>
      <p>
        Emitted when the LLM call fails mid-stream after at least one delta has
        been sent. Clients should discard any partial response accumulated so
        far for this <code>turnId</code>.
      </p>
      <pre><code>{`{
  "sessionId": "sess_abc123",
  "turnId":    "tur_xyz789",
  "error":     "provider error — partial response discarded"
}`}</code></pre>

      <p>
        The <code>turnId</code> is stable across all three event types for the
        same assistant turn. Clients can use it to correlate deltas to their
        final <code>message_completed</code>, and to discard in-progress buffers
        when a <code>message_error</code> arrives.
      </p>

      <div className="callout callout-warning">
        <strong>Tool-bearing turns do not stream deltas.</strong> When the
        session has tools attached, the LLM call runs through a non-streaming
        tool-use loop (up to 5 rounds). For those turns the client receives a
        single <code>message_completed</code> without any preceding{" "}
        <code>message_delta</code> events.
      </div>

      <h2 id="sdk">SDK: <code>sessions.streamMessage()</code></h2>
      <p>
        The TypeScript SDK exposes token streaming as an async iterator. It
        handles sequence reordering, unknown event filtering, and legacy
        server compatibility automatically.
      </p>
      <pre><code>{`import { LanternClient } from "@lantern/sdk";

const client = new LanternClient({ apiKey: "..." });

for await (const event of client.sessions.streamMessage(sessionId, {
  content: "Summarise the last quarter in 3 bullets.",
})) {
  if (event.type === "delta") {
    process.stdout.write(event.delta);        // stream tokens as they arrive
  } else if (event.type === "completed") {
    console.log("\\nTotal cost:", event.usage.costUsd);
  }
}`}</code></pre>

      <p>
        The iterator yields a discriminated-union type{" "}
        <code>SessionStreamEvent</code>:
      </p>
      <pre><code>{`type SessionStreamEvent =
  | { type: "delta";     delta: string }
  | { type: "completed"; text: string; usage: { tokensIn: number; tokensOut: number; costUsd: number } };`}</code></pre>

      <p>
        Out-of-order <code>seq</code> values are buffered and yielded in order.
        A <code>message_error</code> from the server throws a typed{" "}
        <code>MessageStreamError</code>. Unknown event kinds are silently
        ignored so old and new server versions are both handled.
      </p>

      <h2 id="sse">SSE transport</h2>
      <p>
        Named SSE events are delivered on the existing session event stream:
      </p>
      <pre><code>{`GET /v1/sessions/{id}/events
Authorization: Bearer <token>

# Server-sent events:
event: message_delta
data: {"sessionId":"...","turnId":"...","seq":1,"delta":"Hello"}

event: message_delta
data: {"sessionId":"...","turnId":"...","seq":2,"delta":", world"}

event: message_completed
data: {"sessionId":"...","turnId":"...","text":"Hello, world","usage":{...}}`}</code></pre>
      <p>
        Legacy clients that subscribe to <code>agent.message</code> events
        continue to receive them — the new named events are additive. The{" "}
        <code>_event</code> key in the payload tells the session event bus which
        SSE event name to emit.
      </p>

      <h2 id="provider">Provider streaming</h2>
      <p>
        The control-plane calls the model provider in streaming mode via{" "}
        <code>streamWithFailover</code>. Each chunk from the provider triggers
        an <code>onDelta</code> callback that publishes a{" "}
        <code>message_delta</code> to the Redis session channel, which the SSE
        handler fans out to connected clients. The{" "}
        <code>Idempotency-Key</code> header is set on the provider request
        (invariant #8) so a crash-retry dedups at the provider.
      </p>
      <p>
        Provider failover: if the primary provider fails before any deltas have
        been sent, the failover chain retries on the next configured provider.
        If the primary fails after deltas have been sent, a{" "}
        <code>message_error</code> is emitted and the partial response is
        discarded.
      </p>

      <h2 id="dashboard">Dashboard and webchat</h2>
      <p>
        The dashboard session chat and the embedded webchat widget both consume
        these events. The webchat widget — served at <code>/widget.js</code> —
        renders token-by-token as deltas arrive and flips to the final text on{" "}
        <code>message_completed</code>.
      </p>

      <div className="callout callout-info">
        Related: <Link href="/runtime/sessions-and-memory">Sessions &amp; memory</Link>{" "}
        covers how sessions are created and managed.{" "}
        <Link href="/runtime/observability">Observability</Link> covers the OTel
        span attributes set on LLM calls.
      </div>
    </>
  );
}
