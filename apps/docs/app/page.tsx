import Link from "next/link";

export default function DocsHome() {
  return (
    <>
      <h1>Lantern Documentation</h1>
      <p>
        Build, deploy, and operate AI agents in production — multi-model, crash-proof, running in your cloud.
      </p>

      <div className="card-grid">
        <Link href="/installation" className="card">
          <div className="card-title">Installation</div>
          <div className="card-desc">Clone, three commands, running in under 2 minutes.</div>
        </Link>
        <Link href="/quickstart" className="card">
          <div className="card-title">Quickstart</div>
          <div className="card-desc">Create an agent, run it, watch the event stream.</div>
        </Link>
        <Link href="/agents" className="card">
          <div className="card-title">Agents</div>
          <div className="card-desc">Instructions, tools, visual editor, guardrails.</div>
        </Link>
        <Link href="/runtime" className="card">
          <div className="card-title">Runtime</div>
          <div className="card-desc">MicroVM isolation, durable execution, receipts.</div>
        </Link>
      </div>

      <h2 id="what">What is Lantern?</h2>
      <p>
        Lantern is an open-source platform for running AI agents reliably. Agents survive crashes via step journaling, route to any model by capability, connect to 17 built-in APIs, and execute inside isolated microVMs in your VPC. Control plane manages scheduling; your cloud runs the code.
      </p>

      <h2 id="concepts">Core concepts</h2>
      <ul>
        <li><strong>Agent</strong> — named, versioned config: instructions, model tier, tools, guardrails.</li>
        <li><strong>Run</strong> — single execution; journaled step-by-step, replayable after crash.</li>
        <li><strong>Session</strong> — long-lived interactive conversation; survives disconnects; streams via SSE.</li>
        <li><strong>Connector</strong> — links external services (Gmail, Slack, GitHub) to agents via OAuth or API key.</li>
        <li><strong>Surface</strong> — inbound channel: WhatsApp, Slack, Telegram, web chat widget.</li>
        <li><strong>Data plane</strong> — your VPC; agent code and data never leave it.</li>
      </ul>
    </>
  );
}
