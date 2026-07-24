import Link from "next/link";
import {
  Clock, ShieldCheck, Layers, BarChart2, FlaskConical, Zap,
  FileCheck, Lock, Cpu,
} from "lucide-react";
import { Diagram } from "./_components/Diagram";

// ponytail: all facts are grounded in the codebase — no invented metrics.
const facts = [
  {
    num: "17",
    unit: "connectors",
    sub: "OAuth + API-key; install with POST /v1/connectors/install",
  },
  {
    num: "5",
    unit: "isolation backends",
    sub: "runc · gVisor · Kata · Firecracker · Wasm — declared at publish time",
  },
  {
    num: "402",
    unit: "hard-budget HTTP status",
    sub: "blocked before a single token is billed",
  },
  {
    num: "30 s",
    unit: "crash-recovery sweep",
    sub: "LANTERN_RECOVERY_INTERVAL default; resumes from the journal",
  },
  {
    num: "Ed25519",
    unit: "signed receipts",
    sub: "verify offline — no server, no SDK, just the key fingerprint",
  },
  {
    num: "2 + 1",
    unit: "tiers, one journal",
    sub: "shared tier · microVM tier · same durable Postgres event log",
  },
];

const pillars: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}[] = [
  {
    icon: Clock,
    title: "Runs complete or resume.",
    body: "Every step is journaled to Postgres before it executes. A process restart resumes at the first incomplete step and skips the rest — no re-spent tokens, no double webhooks.",
  },
  {
    icon: Lock,
    title: "Isolation is declared, not guessed.",
    body: "Agents set manifest.isolation at publish time. Untrusted code, browser automation, and package installs land in a microVM — Firecracker or Kata. The runtime never downgrades silently.",
  },
  {
    icon: FileCheck,
    title: "Every run leaves evidence.",
    body: "A SHA-256 chain over the full journal is Ed25519-signed at completion. Verify the receipt offline with the key fingerprint from /.well-known/lantern-receipts — no server required.",
  },
];

const features: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  href: string;
  desc: string;
}[] = [
  {
    icon: Clock,
    title: "Durable execution",
    href: "/runtime/durable-execution",
    desc: "Crash mid-step? The recovery sweep re-drives the run from the journal and skips completed steps. Idempotency key sha256(run_id|step_id|attempt) blocks double-execution at the provider.",
  },
  {
    icon: Layers,
    title: "Isolation ladder",
    href: "/runtime/isolation",
    desc: "Five classes: runc → gVisor → Kata → Firecracker → Wasm. Declared in the agent manifest. Never a bare pod for untrusted code — and if the microVM tier is unavailable, the run fails explicitly.",
  },
  {
    icon: Zap,
    title: "End-to-end streaming",
    href: "/runtime/streaming",
    desc: "Token deltas flow runtime → gateway → SDK the moment they arrive. Subscribe with GET /v1/runs/{id}/events (SSE). No buffering points, no polling, no extra infra.",
  },
  {
    icon: BarChart2,
    title: "Observability built in",
    href: "/runtime/observability",
    desc: "Every OTel span carries tenant_id, run_id, and step_id. Emit lantern.run.* metrics to any OTLP endpoint. No-op when LANTERN_OTEL_ENABLED is unset — zero overhead until you need it.",
  },
  {
    icon: ShieldCheck,
    title: "Budgets that block",
    href: "/budgets",
    desc: "PUT /v1/agents/{name}/budget sets hard limits on cost/day, cost/run, tokens/day, and per-tool rates. A run that would exceed the limit returns HTTP 402 before a single token is billed.",
  },
  {
    icon: FlaskConical,
    title: "Eval-in-CI + rehearsals",
    href: "/evaluations",
    desc: "Pin a branch baseline and gate merges on regression — a score drop returns HTTP 422. Replay past failed or low-score production runs as synthetic tests before promoting a new version.",
  },
];

export default function DocsHome() {
  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <p className="lp-kicker">The production runtime for AI agents</p>
      <h1>
        Durable runs.
        <br />
        Hard budgets.
        <br />
        Fail-closed isolation.
      </h1>
      <p className="lead">
        Your prompts, tokens, and data never leave your VPC.
        The control plane orchestrates by metadata — your cloud executes.
      </p>
      <p>
        <strong>What is Lantern?</strong> It&apos;s the infrastructure that runs
        your AI agents in production — so you don&apos;t have to build crash
        recovery, spending limits, sandboxing, or audit trails yourself. You
        write the agent; Lantern makes sure it finishes what it started, never
        overspends, can&apos;t escape its sandbox, and can prove what it did.
      </p>

      <pre>
        <code>{`lantern dev      # Postgres · Redis · API · dashboard · a live agent`}</code>
      </pre>

      <div className="lp-ctas">
        <Link href="/quickstart" className="lp-cta-primary">
          Get started in 5 minutes →
        </Link>
        <Link href="/runtime" className="lp-cta-ghost">
          How the runtime works →
        </Link>
      </div>

      {/* ── Three pillars ────────────────────────────────────────────── */}
      <div className="card-grid lp-pillars">
        {pillars.map((p) => (
          <div key={p.title} className="card">
            <div className="card-title">
              <p.icon className="w-4 h-4 text-lantern-400" />
              {p.title}
            </div>
            <div className="card-desc">{p.body}</div>
          </div>
        ))}
      </div>

      {/* ── Facts band ────────────────────────────────────────────────── */}
      <div className="lp-facts">
        {facts.map((f) => (
          <div key={f.unit} className="lp-fact">
            <span className="lp-fact-num">{f.num}</span>
            <span className="lp-fact-unit">{f.unit}</span>
            <span className="lp-fact-sub">{f.sub}</span>
          </div>
        ))}
      </div>

      {/* ── Run lifecycle diagram ──────────────────────────────────────── */}
      <Diagram
        name="run-lifecycle-live"
        caption="POST /v1/runs → auth + budget gates → shared or microVM tier → journal → signed receipt. Every box is real code."
      />

      {/* ── Feature grid ──────────────────────────────────────────────── */}
      <h2 id="features">What the runtime gives you</h2>
      <p>
        Six things every production agent needs and almost nobody wants to
        build: the ability to survive a crash, a safe place to run untrusted
        code, live output as it happens, visibility into what ran, a spending
        cap that actually stops a run, and a way to catch quality regressions
        before your users do.
      </p>
      <div className="card-grid">
        {features.map((f) => (
          <Link key={f.href} href={f.href} className="card lp-feature-card">
            <div className="card-title">
              <f.icon className="w-4 h-4 text-lantern-400" />
              {f.title}
            </div>
            <div className="card-desc">{f.desc}</div>
            <div className="lp-card-arrow">→</div>
          </Link>
        ))}
      </div>

      {/* ── Five modules overview ──────────────────────────────────────── */}
      <h2 id="modules">Five modules, one runtime</h2>
      <p>
        Every module — the personal agent, the eval suite, the marketplace,
        the voice channel — is a lens on the same durable, budgeted,
        multi-tenant core. Nothing is a bolt-on.
      </p>
      <Diagram
        name="modules"
        caption="Agent Runtime · Personal Agent · Trust & Governance · Channels & Reach · Developer Experience — all event-sourced through the same journal."
      />

      {/* ── How it fits ───────────────────────────────────────────────── */}
      <h2 id="how">Control plane orchestrates. Your cloud executes.</h2>
      <p>
        The control plane authenticates, budgets, and dispatches via an outbound
        gRPC tunnel — no inbound ports on your side. Agents run in microVMs on
        your nodes. Keys, prompts, and run data stay in your cluster.
      </p>
      <div className="arch">
        <div className="arch-row">
          <div className="arch-node arch-cp">
            <div className="arch-kicker">Control plane · SaaS</div>
            <div className="arch-name">Orchestrates</div>
            <div className="arch-sub">
              Schedules runs, routes model calls by capability, enforces budgets
              and eval gates. Speaks gRPC to your data plane over an outbound
              tunnel — no inbound ports opened on your side.
            </div>
          </div>
          <div className="arch-link">
            <div className="arch-link-label lp-teal-label">outbound tunnel</div>
            <div className="arch-link-sub">no inbound ports</div>
          </div>
          <div className="arch-node arch-dp">
            <div className="arch-kicker">Your VPC · data plane</div>
            <div className="arch-name">Executes</div>
            <div className="arch-sub">
              Agents run in microVMs on your nodes — Firecracker or Kata for
              untrusted code, runc for trusted workflows. Keys, prompts, and run
              data stay in your cluster.
            </div>
          </div>
          <div className="arch-link">
            <div className="arch-link-label">Ed25519</div>
            <div className="arch-link-sub">signed receipt</div>
          </div>
          <div className="arch-node arch-cp">
            <div className="arch-kicker">Verifiable proof</div>
            <div className="arch-name">Attests</div>
            <div className="arch-sub">
              Every completed run gets an Ed25519 signature over its journal
              hash. Verify offline with{" "}
              <code>POST /v1/runs/receipts/verify</code> — no live server
              required.
            </div>
          </div>
        </div>
      </div>

      {/* ── Footer CTA ────────────────────────────────────────────────── */}
      <div className="lp-footer-cta">
        <Link href="/quickstart" className="lp-footer-link">
          Get started in 5 minutes →
        </Link>
        <span className="lp-footer-sep">·</span>
        <Link href="/runtime" className="lp-footer-link">
          Runtime deep dive →
        </Link>
        <span className="lp-footer-sep">·</span>
        <a
          href="https://github.com/dshakes/lantern"
          target="_blank"
          rel="noopener noreferrer"
          className="lp-footer-link"
        >
          GitHub ↗
        </a>
      </div>
    </>
  );
}
