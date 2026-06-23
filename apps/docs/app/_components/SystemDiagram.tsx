import { Code2, MessagesSquare, Boxes, Database } from "lucide-react";

type Comp = { name: string; sub: string };

function Grid({ items }: { items: Comp[] }) {
  return (
    <div className="sys-grid">
      {items.map((c) => (
        <div key={c.name} className="sys-comp">
          <b>{c.name}</b>
          <span>{c.sub}</span>
        </div>
      ))}
    </div>
  );
}

// System-context diagram: actors → control-plane boundary (its real services) →
// outbound tunnel → your-VPC boundary → dependencies.
export function SystemDiagram() {
  return (
    <div className="sys">
      <div className="sys-actors">
        <div className="sys-actor">
          <Code2 className="h-4 w-4 text-lantern-300" />
          <div><div className="sys-actor-name">Developers</div><div className="sys-actor-sub">SDK · CLI · REST · dashboard</div></div>
        </div>
        <div className="sys-actor">
          <MessagesSquare className="h-4 w-4 text-sky-300" />
          <div><div className="sys-actor-name">End users</div><div className="sys-actor-sub">WhatsApp · Slack · Telegram · Web · Voice</div></div>
        </div>
      </div>

      <div className="sys-conn"><span>requests</span></div>

      <div className="sys-boundary sys-cp">
        <div className="sys-tag">Lantern Control Plane · SaaS</div>
        <Grid items={[
          { name: "Gateway & Auth", sub: "TLS · JWT/API-key · streaming" },
          { name: "API & RBAC", sub: "agents · runs · sessions" },
          { name: "Model Router", sub: "capability routing · cache" },
          { name: "Workflow Engine", sub: "durable steps · replay" },
          { name: "Scheduler", sub: "cron · fair-share · retries" },
          { name: "Evals & Budgets", sub: "402 / 422 CI gates" },
          { name: "Marketplace & MCP", sub: "agents · tools · A2A" },
          { name: "Observability", sub: "OTel traces · metrics" },
        ]} />
        <div className="sys-note">Multi-tenant. Never touches your code.</div>
      </div>

      <div className="sys-tunnel"><span>↑ outbound-only mTLS tunnel · metadata only ↑</span></div>

      <div className="sys-boundary sys-dp">
        <div className="sys-tag sys-tag-dp">Your VPC · Data Plane</div>
        <Grid items={[
          { name: "Runtime Manager", sub: "builds pods · isolation tier" },
          { name: "Agent microVMs", sub: "Firecracker · Kata · K8s" },
          { name: "Harness", sub: "egress allowlist · secret vending" },
          { name: "Data stores", sub: "Postgres · Redis · S3" },
        ]} />
        <div className="sys-note">Code, prompts &amp; data never leave your network.</div>
      </div>

      <div className="sys-conn"><span>calls out</span></div>

      <div className="sys-actors">
        <div className="sys-actor">
          <Boxes className="h-4 w-4 text-emerald-300" />
          <div><div className="sys-actor-name">LLM providers</div><div className="sys-actor-sub">OpenAI · Anthropic · local</div></div>
        </div>
        <div className="sys-actor">
          <Database className="h-4 w-4 text-amber-300" />
          <div><div className="sys-actor-name">Your APIs &amp; data</div><div className="sys-actor-sub">17 connectors · in your network</div></div>
        </div>
      </div>
    </div>
  );
}
