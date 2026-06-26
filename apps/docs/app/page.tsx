import Link from "next/link";
import { Download, Rocket, Bot, Server, ShieldCheck, Boxes, Cloud, Activity } from "lucide-react";
import { SystemDiagram } from "./_components/SystemDiagram";
import { CodeTabs } from "./_components/CodeTabs";

export default function DocsHome() {
  return (
    <>
      <h1>The runtime for production AI agents</h1>
      <p>
        An agent demo takes an afternoon; agents in <em>production</em> take a year —
        durable execution, a cost cap finance will sign, an eval gate in CI, real
        isolation for untrusted code, and the channels your users actually live on.
        <strong>Lantern is the runtime that solves the production half — in your
        own cloud.</strong> Your prompts, tokens, and data never leave your VPC.
        Open-source, Apache-2.0 — one command boots the whole stack.
      </p>
      <p>
        The same primitives power a headless backend worker and a personal agent
        that texts on your real number — so you build the runtime once and get both.
      </p>

      <pre><code>{`git clone https://github.com/dshakes/lantern && cd lantern
lantern dev      # Postgres + Redis + API + dashboard + a live agent`}</code></pre>

      <div className="card-grid">
        <Link href="/installation" className="card">
          <div className="card-title"><Download className="w-4 h-4 text-lantern-400" /> Install</div>
          <div className="card-desc">Boot the full stack locally in under two minutes.</div>
        </Link>
        <Link href="/quickstart" className="card">
          <div className="card-title"><Rocket className="w-4 h-4 text-lantern-400" /> Quickstart</div>
          <div className="card-desc">First agent running, with a live event stream, in 5 min.</div>
        </Link>
        <Link href="/agents" className="card">
          <div className="card-title"><Bot className="w-4 h-4 text-lantern-400" /> Agents</div>
          <div className="card-desc">Instructions, tools, the visual editor, guardrails.</div>
        </Link>
        <Link href="/runtime" className="card">
          <div className="card-title"><Server className="w-4 h-4 text-lantern-400" /> Runtime</div>
          <div className="card-desc">MicroVM isolation, durable execution, signed receipts.</div>
        </Link>
      </div>

      <h2 id="how">How it works</h2>
      <SystemDiagram />

      <h2 id="run">Run an agent</h2>
      <p>One authenticated call kicks off a run — from your shell, your app, or a script.</p>
      <CodeTabs
        tabs={[
          {
            label: "curl",
            lang: "bash",
            code: `curl -X POST http://localhost:8080/v1/runs \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"agentName": "support", "input": {"prompt": "Summarize ticket #4821"}}'`,
          },
          {
            label: "TypeScript",
            lang: "typescript",
            code: `const res = await fetch("http://localhost:8080/v1/runs", {
  method: "POST",
  headers: { Authorization: \`Bearer \${token}\`, "Content-Type": "application/json" },
  body: JSON.stringify({ agentName: "support", input: { prompt: "Summarize ticket #4821" } }),
});
const run = await res.json();`,
          },
          {
            label: "Python",
            lang: "python",
            code: `import requests

run = requests.post(
    "http://localhost:8080/v1/runs",
    headers={"Authorization": f"Bearer {token}"},
    json={"agentName": "support", "input": {"prompt": "Summarize ticket #4821"}},
).json()`,
          },
        ]}
      />

      <h2 id="why">Why developers choose Lantern</h2>
      <div className="card-grid">
        <div className="card">
          <div className="card-title"><ShieldCheck className="w-4 h-4 text-emerald-400" /> Crash-proof</div>
          <div className="card-desc">Every step is journaled. A run resumes exactly where it died — no double side-effects.</div>
        </div>
        <div className="card">
          <div className="card-title"><Boxes className="w-4 h-4 text-sky-400" /> Any model</div>
          <div className="card-desc">Address models by capability (<code>auto</code>, <code>reasoning-large</code>); the router picks the vendor.</div>
        </div>
        <div className="card">
          <div className="card-title"><Cloud className="w-4 h-4 text-lantern-400" /> Your cloud</div>
          <div className="card-desc">Agents execute in your VPC over an outbound-only tunnel. Your keys, your data.</div>
        </div>
        <div className="card">
          <div className="card-title"><Activity className="w-4 h-4 text-amber-400" /> Governed</div>
          <div className="card-desc">Per-agent budgets (402), eval-in-CI gates (422), Ed25519-signed receipts.</div>
        </div>
      </div>

      <h2 id="concepts">Core concepts</h2>
      <ul>
        <li><strong>Agent</strong> — named, versioned config: instructions, model tier, tools, guardrails.</li>
        <li><strong>Run</strong> — a single execution; journaled step-by-step, replayable after a crash.</li>
        <li><strong>Session</strong> — a long-lived conversation; survives disconnects, streams over SSE.</li>
        <li><strong>Connector</strong> — links external services (Gmail, Slack, GitHub) via OAuth or API key.</li>
        <li><strong>Surface</strong> — an inbound channel: WhatsApp, Slack, Telegram, web chat.</li>
        <li><strong>Data plane</strong> — your VPC; agent code and data never leave it.</li>
      </ul>
    </>
  );
}
