import Link from "next/link";

export default function QuickStartPage() {
  return (
    <>
      <h1>Quickstart</h1>
      <p>
        Create an agent, run it, and watch the real-time event stream — in 5 minutes.
      </p>

      <div className="callout callout-info">
        <strong>Need the stack running first?</strong> Follow the <Link href="/installation">Installation guide</Link> (2 min), then return here.
      </div>

      <div className="steps">

        <div className="step">
          <h3>Get a token</h3>
          <p>The dev stack seeds an admin account. Export a JWT:</p>
          <pre><code>{`export LANTERN_TOKEN=$(curl -s -X POST http://localhost:8080/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"admin@lantern.dev","password":"lantern"}' \\
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

echo $LANTERN_TOKEN   # should print a JWT`}</code></pre>
        </div>

        <div className="step">
          <h3>Add an LLM provider</h3>
          <p>Lantern routes all model calls through its model router — add at least one key:</p>
          <pre><code>{`curl -s -X POST http://localhost:8080/v1/settings/llm-providers \\
  -H "Authorization: Bearer $LANTERN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"provider":"anthropic","api_key":"sk-ant-YOUR_KEY_HERE"}'

# Verify
curl -s -X POST http://localhost:8080/v1/settings/llm-providers/anthropic/test \\
  -H "Authorization: Bearer $LANTERN_TOKEN"
# → {"ok":true}`}</code></pre>
          <div className="callout callout-tip">
            <strong>OpenAI works too.</strong> Use <code>"provider":"openai"</code> with your OpenAI key. Any configured provider is available.
          </div>
        </div>

        <div className="step">
          <h3>Create an agent</h3>
          <pre><code>{`curl -s -X POST http://localhost:8080/v1/agents \\
  -H "Authorization: Bearer $LANTERN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "my-first-agent",
    "instructions": "Answer questions clearly and concisely.",
    "model": "auto"
  }' | jq .`}</code></pre>
          <div className="callout callout-tip">
            <strong><code>"model":"auto"</code></strong> lets the router pick the best available model. Use <code>"reasoning-large"</code> or <code>"reasoning-small"</code> for capability tiers. Never hard-code vendor model names — the router handles that mapping.
          </div>
        </div>

        <div className="step">
          <h3>Run the agent</h3>
          <pre><code>{`export RUN_ID=$(curl -s -X POST http://localhost:8080/v1/runs \\
  -H "Authorization: Bearer $LANTERN_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_name": "my-first-agent",
    "input": {"message": "What are the three laws of thermodynamics?"}
  }' | jq -r '.id')

echo "Run ID: $RUN_ID"`}</code></pre>
        </div>

        <div className="step">
          <h3>Stream the events</h3>
          <p>Every run emits live events over SSE — tool calls, model responses, completions:</p>
          <pre><code>{`curl -N http://localhost:8080/v1/runs/$RUN_ID/events \\
  -H "Authorization: Bearer $LANTERN_TOKEN" \\
  -H "Accept: text/event-stream"`}</code></pre>
          <pre><code>{`data: {"kind":"run_started","run_id":"...","seq":1}
data: {"kind":"step_started","step_id":"...","seq":2}
data: {"kind":"step_completed","step_id":"...","output":"...","seq":3}
data: {"kind":"run_completed","cost_usd":0.0004,"tokens_in":45,"tokens_out":120,"seq":4}`}</code></pre>
          <div className="callout callout-tip">
            <strong>Dashboard view:</strong> open <a href="http://localhost:3001/runs" target="_blank" rel="noopener noreferrer">localhost:3001/runs</a> to see the waterfall timeline, cost breakdown, and full event log.
          </div>
        </div>

      </div>

      <h2 id="next">What&apos;s next</h2>
      <div className="card-grid">
        <Link href="/agents" className="card">
          <div className="card-title">Agents</div>
          <div className="card-desc">Instructions, tools, visual editor, guardrails.</div>
        </Link>
        <Link href="/connectors" className="card">
          <div className="card-title">Connectors</div>
          <div className="card-desc">Gmail, Slack, GitHub, Stripe, and 13 more.</div>
        </Link>
        <Link href="/scheduling" className="card">
          <div className="card-title">Scheduling</div>
          <div className="card-desc">Cron triggers, event triggers, email delivery.</div>
        </Link>
        <Link href="/runtime" className="card">
          <div className="card-title">Runtime</div>
          <div className="card-desc">MicroVM isolation, durable execution, receipts.</div>
        </Link>
      </div>
    </>
  );
}
