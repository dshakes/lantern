export default function DocsHome() {
  return (
    <>
      <h1>Lantern Documentation</h1>
      <p>
        Lantern is an open-source platform for building, deploying, and operating
        AI agents in production. Multi-model, crash-proof, deployed in your cloud.
      </p>

      {/* Hero CTA strip */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "0.75rem",
        marginBottom: "2rem",
        marginTop: "1.5rem",
      }}>
        <a href="/installation" style={{
          display: "block",
          background: "#0d0d12",
          border: "1px solid #f59e0b",
          borderRadius: "10px",
          padding: "1rem 1.25rem",
          textDecoration: "none",
          transition: "border-color 0.15s",
        }}>
          <div style={{ color: "#f59e0b", fontWeight: 700, fontSize: "0.85rem", marginBottom: "0.3rem" }}>
            Installation
          </div>
          <div style={{ color: "#71717a", fontSize: "0.75rem", lineHeight: 1.5 }}>
            Clone, start three commands, running in under 2 minutes.
          </div>
          <div style={{ color: "#f59e0b", fontSize: "0.72rem", marginTop: "0.5rem" }}>Start here →</div>
        </a>
        <a href="/quickstart" style={{
          display: "block",
          background: "#0d0d12",
          border: "1px solid #8b5cf6",
          borderRadius: "10px",
          padding: "1rem 1.25rem",
          textDecoration: "none",
          transition: "border-color 0.15s",
        }}>
          <div style={{ color: "#8b5cf6", fontWeight: 700, fontSize: "0.85rem", marginBottom: "0.3rem" }}>
            Quickstart
          </div>
          <div style={{ color: "#71717a", fontSize: "0.75rem", lineHeight: 1.5 }}>
            Create an agent, run it, watch the real-time event stream.
          </div>
          <div style={{ color: "#8b5cf6", fontSize: "0.72rem", marginTop: "0.5rem" }}>5 minutes →</div>
        </a>
      </div>

      {/* Platform overview diagram */}
      <div style={{
        background: "#0d0d12",
        border: "1px solid #1e2235",
        borderRadius: "12px",
        padding: "1.5rem",
        marginBottom: "2rem",
        fontFamily: "var(--font-mono)",
        fontSize: "0.72rem",
      }}>
        <div style={{ color: "#71717a", marginBottom: "1rem", fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Platform at a glance
        </div>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          {[
            { label: "Dashboard :3001", color: "#38bdf8" },
            { label: "REST API :8080", color: "#38bdf8" },
            { label: "gRPC :50051", color: "#38bdf8" },
          ].map(s => (
            <span key={s.label} style={{
              background: "#0a1420",
              border: `1px solid ${s.color}`,
              color: s.color,
              borderRadius: "5px",
              padding: "0.2rem 0.6rem",
            }}>{s.label}</span>
          ))}
        </div>
        <div style={{ color: "#52525b", marginLeft: "1rem", marginBottom: "0.4rem" }}>│</div>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          {[
            { label: "Model Router :50053", color: "#f59e0b" },
            { label: "Workflow Engine :50052", color: "#f59e0b" },
            { label: "Scheduler :50055", color: "#f59e0b" },
          ].map(s => (
            <span key={s.label} style={{
              background: "#100e04",
              border: `1px solid ${s.color}`,
              color: s.color,
              borderRadius: "5px",
              padding: "0.2rem 0.6rem",
            }}>{s.label}</span>
          ))}
        </div>
        <div style={{ color: "#52525b", marginLeft: "1rem", marginBottom: "0.4rem" }}>│ your VPC</div>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          {[
            { label: "Firecracker", color: "#34d399" },
            { label: "Kata / K8s", color: "#34d399" },
            { label: "Wasmtime", color: "#34d399" },
            { label: "devcontainer", color: "#34d399" },
          ].map(s => (
            <span key={s.label} style={{
              background: "#050f0c",
              border: `1px solid ${s.color}`,
              color: s.color,
              borderRadius: "5px",
              padding: "0.2rem 0.6rem",
            }}>{s.label}</span>
          ))}
        </div>
        <div style={{ marginTop: "0.75rem", color: "#52525b", fontSize: "0.65rem" }}>
          Postgres · Redis · MinIO — local or cloud-managed
        </div>
      </div>

      <h2 id="what">What is Lantern?</h2>
      <p>Lantern lets you build AI agents that:</p>
      <ul>
        <li><strong>Survive crashes</strong> — durable execution with step journaling and replay</li>
        <li><strong>Route to any model</strong> — Claude, GPT-4o, Gemini, or auto-pick by capability</li>
        <li><strong>Connect to your tools</strong> — 17 connectors (Gmail, Slack, GitHub, Stripe)</li>
        <li><strong>Run on schedule</strong> — cron triggers with email delivery</li>
        <li><strong>Stay secure</strong> — PII blocking, guardrails, encryption, audit logging</li>
        <li><strong>Deploy anywhere</strong> — AWS, GCP, Azure via Helm; or managed Lantern Cloud</li>
      </ul>

      <h2 id="who">Who is it for?</h2>
      <table>
        <thead><tr><th>User</th><th>What they do</th></tr></thead>
        <tbody>
          <tr><td><strong>Business users</strong></td><td>Create agents with the AI wizard — no code needed</td></tr>
          <tr><td><strong>Developers</strong></td><td>Build with TypeScript/Python SDK, visual editor, or REST API</td></tr>
          <tr><td><strong>Platform teams</strong></td><td>Deploy control + data plane into own infra; agent data never leaves the VPC</td></tr>
        </tbody>
      </table>

      <h2 id="concepts">Core concepts</h2>
      <h3>Agent</h3>
      <p>A configured AI entity with instructions, system prompt, tools, and guardrails. Versioned; immutable bundles.</p>
      <h3>Session</h3>
      <p>A long-lived interactive conversation. Durable — survives disconnects. Events stream via SSE.</p>
      <h3>Run</h3>
      <p>A single agent execution: status tracking, cost metrics, and a step-by-step journal that is replayable after a crash.</p>
      <h3>Connector</h3>
      <p>Links external services (Gmail, Slack) to agents. Per-tenant config, per-agent assignment, OAuth or API-key.</p>
      <h3>Surface</h3>
      <p>Communication channel — WhatsApp, Slack, Telegram, web chat widget. Agents reply through whatever surface the message arrived on.</p>

      <h2 id="next">Get started</h2>
      <p>→ <a href="/installation"><strong>Installation</strong></a> — prerequisites, clone, <code>lantern dev</code>, service ports, dev credentials</p>
      <p>→ <a href="/quickstart"><strong>Quickstart</strong></a> — create an agent, run it, watch the event stream (5 minutes)</p>
      <p>→ <a href="/agents">Agent guide</a> — configure instructions, tools, visual editor</p>
      <p>→ <a href="/api">API reference</a> — all REST endpoints</p>
      <p>→ <a href="/runtime">Headless runtime</a> — microVM isolation, durable execution, verifiable receipts</p>
    </>
  );
}
