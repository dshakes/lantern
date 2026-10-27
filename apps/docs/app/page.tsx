import Link from "next/link";
import { Clock, ShieldCheck, Layers, BarChart2, FlaskConical, Zap, Code, FileCode, Terminal, Webhook, UserPlus, Laptop, Brain, Plug, Camera } from "lucide-react";
import { Diagram } from "./_components/Diagram";
import { ArchitectureExplorer } from "./_components/interactive/ArchitectureExplorer";

// Docs home: get a reader onto the right path in one click, then show the
// shape of the system. Every claim maps to code on master.

const paths = [
  {
    href: "/quickstart",
    color: "var(--lx-ink-2)",
    title: "Run it locally",
    body: "make dev, then lantern onboard: a running agent and the dashboard on localhost:3001.",
  },
  {
    href: "/runtime/quickstart",
    color: "var(--lx-glass)",
    title: "Run code in a sandbox",
    body: "Write an agent.yaml, pick an isolation class, and lantern run it in a microVM.",
  },
  {
    href: "/runtime/egress",
    color: "var(--lx-flame)",
    title: "Understand the security model",
    body: "What the workload can reach, where credentials live, and which boundary checks what.",
  },
  {
    href: "/deployment",
    color: "var(--lx-patina)",
    title: "Ship to your cloud",
    body: "Control plane and data plane on your Kubernetes, with Helm and Terraform.",
  },
];

const features = [
  { icon: Clock, title: "Durable execution", href: "/runtime/durable-execution", desc: "A crash mid-step resumes from the journal. Completed steps are skipped and idempotency keys stop double side effects." },
  { icon: Layers, title: "Isolation classes", href: "/runtime/isolation", desc: "runc, gVisor, Kata and Firecracker by declared class. Untrusted code is refused rather than downgraded when the hardened runtime is missing." },
  { icon: Zap, title: "Token streaming", href: "/runtime/streaming", desc: "Session replies stream token by token over SSE, with no buffering between provider and client. Tool-using turns return one completed message." },
  { icon: BarChart2, title: "Observability", href: "/runtime/observability", desc: "Control-plane HTTP/gRPC and step spans carry tenant_id, run_id and step_id; the trace context propagates into the in-VM harness." },
  { icon: ShieldCheck, title: "Budgets", href: "/budgets", desc: "Hard caps on cost, tokens and runs per day, per agent and tenant-wide; over the cap, the call returns HTTP 402 before the model is called. Workflow runs also stop mid-run at the per-run cap, and tool nodes respect per-tool limits." },
  { icon: FlaskConical, title: "Evaluations", href: "/evaluations", desc: "Pin a baseline per branch and fail CI on regression with HTTP 422. Replay past failures before promoting a version." },
];

// Shipped after v0.2.0. Keep in step with CHANGELOG [Unreleased].
const recent = [
  { icon: Webhook, title: "Webhook triggers", href: "/triggers", desc: "A signed public URL per agent. GitHub, Sentry, PagerDuty or any HMAC sender starts a run; duplicates are deduplicated." },
  { icon: UserPlus, title: "Accounts & sign-up", href: "/accounts", desc: "Gated sign-up, email verification, password reset, invite codes, captcha, data export and workspace deletion." },
  { icon: ShieldCheck, title: "Budgets, enforced", href: "/budgets#matrix", desc: "Tokens per day, per-run caps inside workflows, per-tool limits, and fail-closed 503 when a hard-fail budget cannot be read." },
  { icon: Brain, title: "Capability names", href: "/models#capabilities", desc: "Every capability and optimize target, and the model it resolves to per provider." },
  { icon: Plug, title: "Connector actions", href: "/connectors#new-actions", desc: "Slack thread replies, GitHub PR comments, Sentry issues, Calendar events, PagerDuty, and a recorded test mode." },
  { icon: Camera, title: "Disk snapshots", href: "/runtime/sandbox-lifecycle#snapshots", desc: "Snapshots capture the VM disk; restore and fork stage from it." },
  { icon: Laptop, title: "Real microVMs on a Mac", href: "/runtime/local-microvms", desc: "Firecracker on KVM inside a Lima guest, on Apple Silicon." },
  { icon: FlaskConical, title: "End-to-end tests", href: "/testing", desc: "make test-e2e against a live stack, with a spend policy and make e2e-clean." },
];

const reference = [
  { icon: Code, title: "REST API", href: "/api", desc: "Every endpoint on the control plane." },
  { icon: FileCode, title: "SDKs", href: "/sdk", desc: "TypeScript, Python and Go." },
  { icon: Terminal, title: "CLI", href: "/cli", desc: "onboard, doctor, run, vm and more." },
];

export default function DocsHome() {
  return (
    <>
      <h1>Run agents in production, on infrastructure you control.</h1>
      <p className="lead">
        Lantern is the self-hosted runtime for AI agents. The agent loop runs on your control plane; untrusted code
        runs in its own microVM. Durable runs, hard budgets, capability-routed models and signed receipts come with it.
      </p>

      <div className="home-paths" role="list">
        {paths.map((p) => (
          <Link key={p.href} href={p.href} className="home-path" role="listitem" style={{ ["--path" as string]: p.color }}>
            <b>{p.title}</b>
            <span>{p.body}</span>
          </Link>
        ))}
      </div>

      <h2 id="shape">The shape of the system</h2>
      <p>
        The control plane owns the agent: workflow interpreter, journal, model router and budgets. When a durable{" "}
        <code>tool_call</code> step runs code, the workflow engine calls <code>ExecTool</code> on the runtime-manager on a data-plane host, which runs the code inside a
        microVM whose PID 1 is the Lantern harness.{" "}
        <span>
          In broker mode (<code>LANTERN_EGRESS_MODE=broker</code>, opt-in, Firecracker only) the VM has no network
          device; its requests leave over vsock through a host broker that checks the allowlist and adds the credential.
        </span>
      </p>
      <Diagram
        name="hero-architecture"
        caption="Agent loop outside, untrusted code inside. In broker mode, credentials are added at the host boundary, never inside the VM."
      />

      <h2 id="features">What the runtime gives you</h2>
      <div className="card-grid">
        {features.map((f) => (
          <Link key={f.href} href={f.href} className="card">
            <div className="card-title">
              <f.icon className="h-4 w-4" />
              {f.title}
            </div>
            <div className="card-desc">{f.desc}</div>
          </Link>
        ))}
      </div>

      <h2 id="new">New since 0.2.0</h2>
      <div className="card-grid">
        {recent.map((f) => (
          <Link key={f.href} href={f.href} className="card">
            <div className="card-title">
              <f.icon className="h-4 w-4" />
              {f.title}
            </div>
            <div className="card-desc">{f.desc}</div>
          </Link>
        ))}
      </div>

      <h2 id="how">Control plane orchestrates. Your cloud executes.</h2>
      <p>
        The data-plane agent dials out to the control plane, so your VPC opens no inbound ports. Untrusted code and its data
        run in your cluster; self-host the control plane too and prompts, keys and run data never leave your
        infrastructure.
      </p>
      <Diagram name="cp-dp-architecture" />
      <ArchitectureExplorer />
      <p>
        Open it full width, with every sequence diagram, in the <Link href="/architecture">architecture explorer</Link>.
      </p>

      <h2 id="reference">Reference</h2>
      <div className="card-grid">
        {reference.map((r) => (
          <Link key={r.href} href={r.href} className="card">
            <div className="card-title">
              <r.icon className="h-4 w-4" />
              {r.title}
            </div>
            <div className="card-desc">{r.desc}</div>
          </Link>
        ))}
      </div>
    </>
  );
}
