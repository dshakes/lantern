import Link from "next/link";

export default function RuntimeSessionsAndMemoryPage() {
  return (
    <>
      <h1>Sessions &amp; Memory</h1>
      <p>
        Sessions are interactive, multi-turn conversations with an agent.
        Memory distillates are the long-term memory layer: durable facts and
        preferences distilled by the LLM from raw session transcripts and
        timeline events, stored and re-injected into future sessions.
      </p>

      <h2 id="sessions">Sessions</h2>
      <p>
        Every session runs on the <strong>shared tier</strong> (inline executor).
        Each message turn triggers one inline run using the plain-LLM tool-use
        loop. Sessions maintain a <code>messages</code> JSONB column on the{" "}
        <code>sessions</code> table; the full history is passed as context on
        each turn.
      </p>

      <h3 id="lifecycle">Lifecycle</h3>
      <pre><code>{`# Create a session
POST /v1/sessions
{ "agentName": "my-agent" }
→ { "id": "sess_abc123", "status": "active" }

# Send a message (streams events on GET /v1/sessions/{id}/events)
POST /v1/sessions/sess_abc123/messages
{ "content": "What can you help me with?" }

# Stop the session (cancels any in-flight turn)
POST /v1/sessions/sess_abc123/stop

# Delete
DELETE /v1/sessions/sess_abc123`}</code></pre>

      <h3 id="streaming">Token streaming</h3>
      <p>
        Session replies stream via <code>GET /v1/sessions/&#123;id&#125;/events</code>{" "}
        (SSE). The three named events — <code>message_delta</code>,{" "}
        <code>message_completed</code>, <code>message_error</code> — and the
        TypeScript SDK <code>sessions.streamMessage()</code> async iterator are
        covered in full in{" "}
        <Link href="/runtime/streaming">Token streaming</Link>.
      </p>

      <h3 id="durability">Durability</h3>
      <p>
        The same durability primitives that apply to headless runs apply to
        sessions. Each turn&apos;s LLM call carries an idempotency key derived
        from <code>(run_id, step_id, attempt)</code>. The result is journaled in{" "}
        <code>journal_events</code>. If the control-plane crashes mid-turn, the
        recovery sweep re-drives the run; the{" "}
        <code>checkCachedLLMStep</code> cache returns the prior response so the
        LLM is not re-called.
      </p>

      <h3 id="sdk-sessions">SDK</h3>
      <pre><code>{`const client = new LanternClient({ apiKey: "..." });

// Create
const session = await client.sessions.create({ agentName: "my-agent" });

// Send (waits for the full response)
await client.sessions.sendMessage(session.id, { content: "Hello" });

// Send + stream tokens
for await (const event of client.sessions.streamMessage(session.id, {
  content: "Summarise the quarter.",
})) {
  if (event.type === "delta") process.stdout.write(event.delta);
}

// Clean up
await client.sessions.delete(session.id);`}</code></pre>

      <h3 id="session-vms">Session-scoped microVMs (flag-gated)</h3>
      <p>
        When an agent declares <code>isolation: "microvm"</code>, sessions
        optionally reuse a single long-lived VM across all turns
        (<em>session-scoped microVMs</em>, ADR 0022). The VM is spawned on the
        first turn and kept alive between turns so subsequent messages pay only
        warm-path latency (~150ms) rather than a cold boot (~1.5s) per turn.
        The VM is terminated when the session is deleted or stopped.
      </p>

      <h2 id="memory">Memory distillates</h2>
      <div className="callout callout-warning">
        <strong>Flag-gated, default OFF.</strong> Set{" "}
        <code>LANTERN_MEMORY_DISTILL=1</code> to enable. When unset, the
        distillation loop is a no-op and the endpoints return empty responses.
        Zero behavior change when the flag is off.
      </div>
      <p>
        Raw timeline events (stored by <code>memory_ingest.go</code> and{" "}
        <code>identity.go</code>) and recent session transcripts accumulate over
        time. The memory distillation pass runs every 6 hours by default
        (override: <code>LANTERN_MEMORY_DISTILL_INTERVAL</code>, Go duration
        string; minimum 1 minute) and uses the LLM to extract durable facts,
        preferences, and relationship notes — one compact row per (topic,
        person) in the <code>memory_distillates</code> table.
      </p>

      <h3 id="quality-bar">Quality bar</h3>
      <p>
        The LLM is called via the provider-failover chain (never a hardcoded
        vendor — invariant #6). Items are only persisted when the LLM returns:
      </p>
      <ul>
        <li>
          <code>confidence &ge; 0.60</code> (the prompt&apos;s own stated
          minimum)
        </li>
        <li>
          A non-empty <code>topic</code> and <code>content</code>
        </li>
      </ul>
      <p>
        Any error (DB, LLM, parse) → no writes, never a crash. PII in session
        content is never logged above debug level (invariant #10).
      </p>

      <h3 id="distillate-schema">Distillate shape</h3>
      <pre><code>{`{
  "id":         "mem_abc123",
  "topic":      "preferred communication style",
  "content":    "Prefers short, direct replies. No bullet lists.",
  "confidence": 0.87,
  "personHint": "Shekhar",
  "sourceKind": "session",
  "createdAt":  "2026-07-23T10:00:00Z",
  "updatedAt":  "2026-07-23T18:00:00Z"
}`}</code></pre>

      <h3 id="distillate-endpoints">Endpoints</h3>
      <table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>GET</code></td>
            <td><code>/v1/memory/distillates</code></td>
            <td>List active (non-superseded) distillates for the tenant. Returns <code>{"{ enabled: false }"}</code> when flag is off.</td>
          </tr>
          <tr>
            <td><code>POST</code></td>
            <td><code>/v1/memory/distill</code></td>
            <td>Trigger a distillation pass now. Returns <code>{"{ found: N }"}</code> where N is the number of items persisted.</td>
          </tr>
        </tbody>
      </table>

      <h3 id="env-vars">Environment variables</h3>
      <table>
        <thead>
          <tr><th>Variable</th><th>Default</th><th>Purpose</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>LANTERN_MEMORY_DISTILL</code></td>
            <td>off</td>
            <td><code>1</code> / <code>true</code> / <code>on</code> enables the distillation loop and endpoints.</td>
          </tr>
          <tr>
            <td><code>LANTERN_MEMORY_DISTILL_INTERVAL</code></td>
            <td><code>6h</code></td>
            <td>Go duration string for how often the loop runs. Minimum 1 minute.</td>
          </tr>
        </tbody>
      </table>

      <h3 id="rls">RLS and multi-tenancy</h3>
      <p>
        The <code>memory_distillates</code> table is RLS-enforced (migration
        0013). All DB writes use <code>db.WithTenantConn</code>; reads use{" "}
        <code>srv.WithTenant</code>. No cross-tenant data can be read or written
        by the distillation pass.
      </p>

      <div className="callout callout-info">
        Related:{" "}
        <Link href="/runtime/streaming">Token streaming</Link> — the event
        contract for session turns.{" "}
        <Link href="/api">API reference</Link> — full session and memory
        endpoint shapes.
      </div>
    </>
  );
}
