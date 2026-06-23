import { Code2, MessagesSquare, Boxes, Database } from "lucide-react";

// A clean system-context diagram (C4-ish): who talks to Lantern, the two trust
// boundaries (control plane / your VPC), and what they depend on.
export function SystemDiagram() {
  return (
    <div className="sys">
      {/* Actors */}
      <div className="sys-actors">
        <div className="sys-actor">
          <Code2 className="h-4 w-4 text-lantern-300" />
          <div><div className="sys-actor-name">Developers</div><div className="sys-actor-sub">SDK · CLI · REST</div></div>
        </div>
        <div className="sys-actor">
          <MessagesSquare className="h-4 w-4 text-sky-300" />
          <div><div className="sys-actor-name">End users</div><div className="sys-actor-sub">WhatsApp · Slack · Web · Voice</div></div>
        </div>
      </div>

      <div className="sys-conn"><span>requests</span></div>

      {/* Control plane boundary */}
      <div className="sys-boundary sys-cp">
        <div className="sys-tag">Lantern Control Plane · SaaS</div>
        <div className="sys-chips">
          <span>API &amp; Auth</span>
          <span>Model Router</span>
          <span>Scheduler</span>
          <span>Evals &amp; Budgets</span>
          <span>Observability</span>
        </div>
        <div className="sys-note">Never touches your code.</div>
      </div>

      {/* Tunnel */}
      <div className="sys-tunnel"><span>↑ outbound-only mTLS tunnel · metadata only ↑</span></div>

      {/* Data plane boundary */}
      <div className="sys-boundary sys-dp">
        <div className="sys-tag sys-tag-dp">Your VPC · Data Plane</div>
        <div className="sys-chips">
          <span>Runtime Manager</span>
          <span>Agent microVMs</span>
          <span>Harness</span>
        </div>
        <div className="sys-note">Code, prompts &amp; data never leave.</div>
      </div>

      <div className="sys-conn"><span>calls out</span></div>

      {/* Dependencies */}
      <div className="sys-actors">
        <div className="sys-actor">
          <Boxes className="h-4 w-4 text-emerald-300" />
          <div><div className="sys-actor-name">LLM providers</div><div className="sys-actor-sub">OpenAI · Anthropic · local</div></div>
        </div>
        <div className="sys-actor">
          <Database className="h-4 w-4 text-amber-300" />
          <div><div className="sys-actor-name">Your APIs &amp; data</div><div className="sys-actor-sub">in your network</div></div>
        </div>
      </div>
    </div>
  );
}
