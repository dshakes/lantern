export default function QuickStartPage() {
  return (
    <>
      <h1>Quickstart</h1>
      <p>
        Your first agent, running in production-quality infrastructure, in 5
        minutes. You will create an agent via the API, run it, and watch the
        real-time event stream.
      </p>

      {/* ── ToC ── */}
      <div className="toc">
        <p className="toc-title">On this page</p>
        <ul>
          <li><a href="#prerequisites">Prerequisites</a></li>
          <li><a href="#step1">Step 1 — Start the stack</a></li>
          <li><a href="#step2">Step 2 — Add an LLM provider</a></li>
          <li><a href="#step3">Step 3 — Create an agent</a></li>
          <li><a href="#step4">Step 4 — Run the agent</a></li>
          <li><a href="#step5">Step 5 — Stream the events</a></li>
          <li><a href="#step6">Step 6 — (Optional) Pair a channel</a></li>
          <li><a href="#next">What&apos;s next</a></li>
        </ul>
      </div>

      {/* ── Prerequisites ── */}
      <h2 id="prerequisites">Prerequisites</h2>
      <p>
        You need a running local stack. If you haven&apos;t done that yet, follow
        the <a href="/installation">Installation guide</a> first (takes about 2
        minutes). Then come back here.
      </p>
      <p>
        You also need a JWT token for the API. The dev stack seeds a pre-built
        admin account — get a token:
      </p>
      <pre><code>{`export LANTERN_TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"admin@lantern.dev","password":"lantern"}' \\
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

echo $LANTERN_TOKEN   # should print a JWT`}</code></pre>

      <div className="callout callout-tip">
        <strong>Using the dashboard instead?</strong> Open{" "}
        <a href="http://localhost:3001" target="_blank" rel="noopener noreferrer">localhost:3001</a>,
        sign in with <code>admin@lantern.dev</code> / <code>lantern</code>, and
        follow the same steps in the UI. The API calls below are exactly what the
        dashboard sends.
      </div>

      {/* ── Step 1 ── */}
      <h2 id="step1">Step 1 — Start the stack</h2>

      {/* Step-strip diagram */}
      <div style={{
        display: "flex",
        gap: "0",
        marginBottom: "1.5rem",
        borderRadius: "10px",
        overflow: "hidden",
        border: "1px solid #1e2235",
      }}>
        {[
          { n: "1", label: "Start stack", color: "#f59e0b", active: true },
          { n: "2", label: "Add LLM key", color: "#38bdf8", active: false },
          { n: "3", label: "Create agent", color: "#8b5cf6", active: false },
          { n: "4", label: "Run it", color: "#34d399", active: false },
          { n: "5", label: "Stream events", color: "#34d399", active: false },
        ].map((s, i) => (
          <div key={s.n} style={{
            flex: 1,
            background: s.active ? "#0d0d12" : "#0a0a0f",
            borderRight: i < 4 ? "1px solid #1e2235" : "none",
            padding: "0.75rem 0.5rem",
            textAlign: "center",
          }}>
            <div style={{
              width: "24px",
              height: "24px",
              borderRadius: "50%",
              background: s.active ? s.color : "#1e2235",
              color: s.active ? "#000" : "#52525b",
              fontSize: "0.7rem",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 0.35rem",
            }}>{s.n}</div>
            <div style={{ fontSize: "0.65rem", color: s.active ? "#e4e4e7" : "#52525b" }}>{s.label}</div>
          </div>
        ))}
      </div>

      <pre><code>{`# If dev-infra isn't running yet:
make dev-infra

# In a second terminal:
make run-api

# Verify the API is up:
curl -s http://localhost:8080/healthz`}</code></pre>

      <p>
        You should see <code>{`{"status":"ok"}`}</code>. The API is ready.
      </p>

      {/* ── Step 2 ── */}
      <h2 id="step2">Step 2 — Add an LLM provider</h2>
      <p>
        Lantern routes all LLM calls through the model router — you never call
        OpenAI or Anthropic directly. Add at least one key:
      </p>
      <pre><code>{`# Add an Anthropic key
curl -s -X POST http://localhost:8080/v1/settings/llm-providers \\
  -H "Authorization: Bearer $LANTERN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "provider": "anthropic",
    "api_key": "sk-ant-YOUR_KEY_HERE"
  }'

# Test it
curl -s -X POST http://localhost:8080/v1/settings/llm-providers/anthropic/test \\
  -H "Authorization: Bearer $LANTERN_TOKEN"`}</code></pre>

      <p>
        The test endpoint returns <code>{`{"ok":true}`}</code> on success.
      </p>

      <div className="callout callout-info">
        <strong>OpenAI works too.</strong> Swap{" "}
        <code>&quot;provider&quot;: &quot;anthropic&quot;</code> for{" "}
        <code>&quot;provider&quot;: &quot;openai&quot;</code> and use your OpenAI
        key. Lantern automatically routes to whichever providers you&apos;ve
        configured.
      </div>

      {/* ── Step 3 ── */}
      <h2 id="step3">Step 3 — Create an agent</h2>
      <p>
        An agent is a named, versioned configuration: instructions, model
        capability, tools, and guardrails. Create your first one:
      </p>
      <pre><code>{`curl -s -X POST http://localhost:8080/v1/agents \\
  -H "Authorization: Bearer $LANTERN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "my-first-agent",
    "instructions": "You are a helpful assistant. Answer questions clearly and concisely.",
    "model": "auto",
    "labels": {}
  }' | jq .`}</code></pre>

      <p>You should see a response like:</p>
      <pre><code>{`{
  "name": "my-first-agent",
  "current_version_id": "...",
  "tenant_id": "00000000-0000-0000-0000-000000000001",
  "created_at": "2026-06-22T..."
}`}</code></pre>

      <div className="callout callout-tip">
        <strong><code>model: &quot;auto&quot;</code></strong> lets the model router
        pick the best available model based on the task. You can also specify a
        capability tier: <code>&quot;reasoning-large&quot;</code>,{" "}
        <code>&quot;reasoning-small&quot;</code>, or a concrete model name.
        Hard-coding vendor model names (e.g. <code>gpt-4o</code>) in agent
        configs is not recommended — the router handles that mapping.
      </div>

      {/* ── Step 4 ── */}
      <h2 id="step4">Step 4 — Run the agent</h2>
      <p>
        A run is a single execution. Trigger one now:
      </p>
      <pre><code>{`export RUN_ID=$(curl -s -X POST http://localhost:8080/v1/runs \\
  -H "Authorization: Bearer $LANTERN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_name": "my-first-agent",
    "input": {
      "message": "What are the three laws of thermodynamics?"
    }
  }' | jq -r '.id')

echo "Run ID: $RUN_ID"`}</code></pre>

      <p>Fetch the run status at any point:</p>
      <pre><code>{`curl -s http://localhost:8080/v1/runs/$RUN_ID \\
  -H "Authorization: Bearer $LANTERN_TOKEN" | jq '{status, cost_usd, output}'`}</code></pre>

      {/* ── Step 5 ── */}
      <h2 id="step5">Step 5 — Stream the events</h2>
      <p>
        Every run emits a real-time event stream over SSE. Each event is a
        step in the agent&apos;s execution — tool calls, model responses,
        completions:
      </p>
      <pre><code>{`curl -N http://localhost:8080/v1/runs/$RUN_ID/events \\
  -H "Authorization: Bearer $LANTERN_TOKEN" \\
  -H "Accept: text/event-stream"`}</code></pre>

      <p>You will see events like:</p>
      <pre><code>{`data: {"kind":"run_started","run_id":"...","seq":1}

data: {"kind":"step_started","step_id":"...","seq":2}

data: {"kind":"step_completed","step_id":"...","output":"...","seq":3}

data: {"kind":"run_completed","cost_usd":0.0004,"tokens_in":45,"tokens_out":120,"seq":4}`}</code></pre>

      {/* Event-flow diagram */}
      <div style={{
        background: "#0d0d12",
        border: "1px solid #1e2235",
        borderRadius: "10px",
        padding: "1.25rem 1.5rem",
        marginBottom: "1.5rem",
        fontFamily: "var(--font-mono)",
        fontSize: "0.72rem",
      }}>
        <div style={{ color: "#71717a", marginBottom: "0.6rem", fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Run event flow
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          {[
            { label: "POST /v1/runs", color: "#f59e0b" },
            { label: "→" },
            { label: "run_started", color: "#38bdf8" },
            { label: "→" },
            { label: "step_started", color: "#8b5cf6" },
            { label: "→" },
            { label: "step_completed", color: "#8b5cf6" },
            { label: "→" },
            { label: "run_completed", color: "#34d399" },
          ].map((item, i) =>
            item.label === "→" ? (
              <span key={i} style={{ color: "#52525b" }}>→</span>
            ) : (
              <span key={i} style={{
                background: "#0f1117",
                border: `1px solid ${item.color}`,
                color: item.color,
                borderRadius: "5px",
                padding: "0.15rem 0.5rem",
              }}>{item.label}</span>
            )
          )}
        </div>
        <div style={{ color: "#52525b", marginTop: "0.75rem", fontSize: "0.65rem" }}>
          Stream persists in journal_events (run_id, seq) · Replayable after crash · SSE closes on run_completed or run_failed
        </div>
      </div>

      <div className="callout callout-tip">
        <strong>Dashboard view:</strong> open{" "}
        <a href="http://localhost:3001/runs" target="_blank" rel="noopener noreferrer">localhost:3001/runs</a>{" "}
        and click your run to see the waterfall timeline, cost breakdown, and
        full event log in the browser.
      </div>

      {/* ── Step 6 ── */}
      <h2 id="step6">Step 6 — (Optional) Pair a channel</h2>
      <p>
        Agents can receive messages from WhatsApp, Slack, Telegram, or a web
        chat widget and reply through the same channel. To wire up WhatsApp:
      </p>

      <ol>
        <li>
          Start the bridge:{" "}
          <pre><code>{`make run-whatsapp-bridge`}</code></pre>
        </li>
        <li>
          Open the dashboard at{" "}
          <a href="http://localhost:3001/surfaces" target="_blank" rel="noopener noreferrer">localhost:3001/surfaces</a>{" "}
          → <strong>WhatsApp</strong> → <strong>Scan QR</strong>.
        </li>
        <li>
          In WhatsApp on your phone: <strong>Linked devices → Link a device</strong>,
          then scan the QR.
        </li>
        <li>
          Once paired, messages to that number are routed through your agent and
          replies go back to the sender.
        </li>
      </ol>

      <div className="callout callout-info">
        <strong>Other channels:</strong> Slack, Telegram, and the embedded web
        chat widget are configured the same way under{" "}
        <a href="http://localhost:3001/surfaces" target="_blank" rel="noopener noreferrer">Surfaces</a>.
        See the <a href="/surfaces">Surfaces guide</a> for details.
      </div>

      {/* ── What's next ── */}
      <h2 id="next">What&apos;s next</h2>
      <ul>
        <li>
          <a href="/agents"><strong>Agent configuration</strong></a> — instructions,
          system prompt, tools, visual editor, guardrails
        </li>
        <li>
          <a href="/connectors"><strong>Connectors</strong></a> — give your agent
          access to Gmail, Slack, GitHub, Stripe, and more
        </li>
        <li>
          <a href="/scheduling"><strong>Scheduling</strong></a> — run your agent on
          a cron, trigger on events, deliver output by email
        </li>
        <li>
          <a href="/models"><strong>Models</strong></a> — capability routing,
          auto mode, and adding provider keys
        </li>
        <li>
          <a href="/runtime"><strong>Headless runtime</strong></a> — microVM
          isolation, durable execution, verifiable receipts
        </li>
        <li>
          <a href="/deployment"><strong>Deployment</strong></a> — production with
          Helm, Terraform, or the managed Lantern Cloud
        </li>
      </ul>
    </>
  );
}
