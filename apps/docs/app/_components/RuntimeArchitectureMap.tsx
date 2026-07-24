import Link from "next/link";
import type { ReactNode } from "react";
import {
  ShieldCheck,
  Gauge,
  Cpu,
  DatabaseZap,
  Activity,
  FileCheck,
  ArrowDownToLine,
} from "lucide-react";

type Cell = { name: string; sub: string; href: string };

function Cells({ items }: { items: Cell[] }) {
  return (
    <div className="harness-cells">
      {items.map((c) => (
        <Link key={c.name} href={c.href} className="harness-cell">
          <b>{c.name}</b>
          <span>{c.sub}</span>
        </Link>
      ))}
    </div>
  );
}

type LayerProps = {
  tone: "sky" | "amber" | "violet" | "emerald";
  icon: ReactNode;
  num: string;
  title: string;
  tagline: string;
  items: Cell[];
  emphasis?: boolean;
  substrate?: string;
  pill?: string;
};

function Layer({ tone, icon, num, title, tagline, items, emphasis, substrate, pill }: LayerProps) {
  return (
    <div className={`harness-layer harness-${tone}${emphasis ? " harness-emph" : ""}`}>
      <div className="harness-layer-head">
        <span className="harness-layer-icon">{icon}</span>
        <span className="harness-layer-num">{num}</span>
        <span className="harness-layer-title">{title}</span>
        <span className="harness-layer-tag">{tagline}</span>
        {emphasis && pill && <span className="harness-store-pill">{pill}</span>}
      </div>
      <Cells items={items} />
      {substrate && <div className="harness-substrate-note">{substrate}</div>}
    </div>
  );
}

// The agent runtime in the same interactive, clickable style as the
// personal-harness architecture: entry points at the ingress edge, the run
// pipeline as stacked layers (gate → execute → survive → observe → prove),
// a cross-cutting fail-closed security rail, and the data-plane services as
// the substrate underneath. Every cell links to its deep-dive page or section.
export function RuntimeArchitectureMap() {
  return (
    <div className="harness">
      {/* Top edge — how a run arrives */}
      <div className="harness-edge">
        <div className="harness-edge-label">
          <ArrowDownToLine className="h-3.5 w-3.5 text-sky-300" />
          Entry points · every one becomes the same kind of run
        </div>
        <div className="harness-edge-cells">
          <Link href="/api" className="harness-surface">POST /v1/runs</Link>
          <Link href="/runtime/sessions-and-memory" className="harness-surface">Sessions</Link>
          <Link href="/scheduling" className="harness-surface">Schedules</Link>
          <Link href="/surfaces" className="harness-surface">Channels</Link>
          <Link href="/marketplace" className="harness-surface">A2A</Link>
        </div>
      </div>

      <div className="harness-body">
        <div className="harness-stack">
          <Layer
            tone="sky"
            icon={<Gauge className="h-4 w-4" />}
            num="1 · Gate"
            title="Before a single token is spent"
            tagline="auth, money, and trust — checked up front"
            items={[
              { name: "Auth & tenancy", sub: "JWT / API key · every row tenant-fenced", href: "/security" },
              { name: "Budget gate", sub: "hard caps → HTTP 402, run never starts", href: "/budgets" },
              { name: "Isolation gate", sub: "manifest declares the sandbox — caller can't override", href: "/runtime/isolation" },
            ]}
          />

          <Layer
            tone="violet"
            icon={<Cpu className="h-4 w-4" />}
            num="2 · Execute"
            title="Two tiers, one contract"
            tagline="trusted code runs fast · untrusted runs in a microVM"
            items={[
              { name: "Shared tier", sub: "inline executor — LLM loop + workflow graphs", href: "/runtime#shared" },
              { name: "MicroVM tier", sub: "scheduler → manager → Firecracker / Kata", href: "/runtime#microvm" },
              { name: "Model router", sub: "capability-addressed — never a hardcoded vendor", href: "/models" },
              { name: "In-guest harness", sub: "PID 1 · egress allowlist · tool runner", href: "/runtime/identity" },
            ]}
          />

          <Layer
            tone="amber"
            emphasis
            pill="the durability spine"
            icon={<DatabaseZap className="h-4 w-4" />}
            num="3 · Survive"
            title="The journal — every step written down first"
            tagline="crash mid-run? resume, don't restart"
            substrate="Substrate: one Postgres journal_events log — both tiers, the waterfall, receipts, and replay all read it."
            items={[
              { name: "Event-sourced journal", sub: "step_started → step_completed, always", href: "/runtime/durable-execution#journal" },
              { name: "Crash recovery", sub: "30 s sweep re-drives from the last checkpoint", href: "/runtime/durable-execution" },
              { name: "Replay cache", sub: "finished steps skipped — no re-spent tokens", href: "/runtime/durable-execution" },
              { name: "Idempotency keys", sub: "side effects fire once, even on retry", href: "/runtime/durable-execution" },
            ]}
          />

          <Layer
            tone="emerald"
            icon={<Activity className="h-4 w-4" />}
            num="4 · Observe"
            title="Watch it live"
            tagline="what is it doing right now?"
            items={[
              { name: "Token streaming", sub: "SSE deltas the moment they arrive", href: "/runtime/streaming" },
              { name: "OTel traces", sub: "tenant · run · step on every span", href: "/runtime/observability" },
              { name: "Run waterfall", sub: "per-step timing + cost in the dashboard", href: "/runtime/observability" },
              { name: "Health sweep", sub: "peer probes · alerts on transition", href: "/runtime#health-sweep" },
            ]}
          />

          <Layer
            tone="sky"
            icon={<FileCheck className="h-4 w-4" />}
            num="5 · Prove"
            title="Evidence, not vibes"
            tagline="what did it do — and can you prove it?"
            items={[
              { name: "Signed receipts", sub: "Ed25519 over the journal — verify offline", href: "/runtime/receipts" },
              { name: "Cost attribution", sub: "tokens + USD per run, per day", href: "/budgets" },
              { name: "Evals & rehearsals", sub: "regressions blocked in CI (HTTP 422)", href: "/evaluations" },
            ]}
          />
        </div>
      </div>

      {/* Fail-closed rail — applies across every layer */}
      <Link href="/security" className="harness-rail">
        <div className="harness-rail-head">
          <ShieldCheck className="h-4 w-4 text-rose-300" />
          <span>Fail-closed by design</span>
          <span className="harness-rail-sub">when a guarantee can&apos;t be met, the run fails loudly — never downgrades silently</span>
        </div>
        <ul className="harness-rail-list">
          <li>Never a bare pod</li>
          <li>Deny-default egress</li>
          <li>Secrets vended, never baked in</li>
          <li>VM reports bound to their own run</li>
          <li>microvm_unavailable, not a quiet fallback</li>
        </ul>
      </Link>

      {/* Bottom substrate — the services that make it real */}
      <div className="harness-base">
        <div className="harness-base-label">Data plane · your VPC</div>
        <div className="harness-base-cells">
          <Link href="/runtime#microvm" className="harness-base-cell">runtime-scheduler <span>:50055 · placement</span></Link>
          <Link href="/runtime#microvm" className="harness-base-cell">runtime-manager <span>:50054 · spawn</span></Link>
          <Link href="/runtime/identity" className="harness-base-cell">harness <span>in-VM · PID 1</span></Link>
          <Link href="/runtime/quickstart" className="harness-base-cell">agent.yaml <span>your spec</span></Link>
          <Link href="/deployment" className="harness-base-cell">Helm / Terraform <span>deploy it</span></Link>
        </div>
      </div>
    </div>
  );
}
