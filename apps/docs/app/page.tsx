export default function DocsHome() {
  return (
    <>
      <h1>Lantern Documentation</h1>
      <p>Lantern is an open-source platform for building, deploying, and operating AI agents in production. Multi-model, crash-proof, deployed in your cloud.</p>


      <h2 id="what">What is Lantern?</h2>
      <p>Lantern lets you build AI agents that:</p>
      <ul>
        <li><strong>Survive crashes</strong> — durable execution with step journaling and replay</li>
        <li><strong>Route to any model</strong> — Claude, GPT-4o, Gemini, or auto-pick</li>
        <li><strong>Connect to your tools</strong> — 17 connectors (Gmail, Slack, GitHub, Stripe)</li>
        <li><strong>Run on schedule</strong> — cron triggers with email delivery</li>
        <li><strong>Stay secure</strong> — PII blocking, guardrails, encryption, audit logging</li>
        <li><strong>Deploy anywhere</strong> — AWS, GCP, Azure via Helm</li>
      </ul>

      <h2 id="who">Who is it for?</h2>
      <table>
        <thead><tr><th>User</th><th>What they do</th></tr></thead>
        <tbody>
          <tr><td><strong>Business users</strong></td><td>Create agents with AI wizard — no code needed</td></tr>
          <tr><td><strong>Developers</strong></td><td>Build with TypeScript/Python SDK, visual editor, or API</td></tr>
          <tr><td><strong>Platform teams</strong></td><td>Deploy control + data plane into own infra</td></tr>
        </tbody>
      </table>

      <h2 id="concepts">Core concepts</h2>
      <h3>Agent</h3>
      <p>A configured AI entity with instructions, system prompt, tools, and guardrails.</p>
      <h3>Session</h3>
      <p>A long-lived interactive conversation. Durable — survives disconnects. Events stream via SSE.</p>
      <h3>Run</h3>
      <p>A single agent execution with status tracking, cost metrics, and step-by-step log.</p>
      <h3>Connector</h3>
      <p>Links external services (Gmail, Slack) to agents. Per-tenant config, per-agent assignment.</p>
      <h3>Surface</h3>
      <p>Communication channel — WhatsApp, Slack, Discord, Telegram, email, web chat.</p>

      <h2 id="architecture">Architecture</h2>
      <pre><code>{`Control Plane (:8080)
├── Dashboard (:3001)
├── Sessions · Agents · Runs · Connectors
├── Model Router → Claude / GPT / Gemini
└── Scheduler → Cron + Email Delivery

Data Plane (your cloud)
├── Workflow Engine
├── Runtime Manager
└── Firecracker / K8s / Docker`}</code></pre>

      <h2 id="next">Get started</h2>
      <p>→ <a href="/quickstart">Quick Start guide</a> — running in 5 minutes</p>
      <p>→ <a href="/agents">Agent guide</a> — create and configure agents</p>
      <p>→ <a href="/api">API reference</a> — all REST endpoints</p>
    </>
  );
}
