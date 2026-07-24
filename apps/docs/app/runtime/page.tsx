import Link from "next/link";
import { ShieldCheck, Lock, Activity } from "lucide-react";
import { Diagram } from "../_components/Diagram";

// Tier comparison — reuses .prose table styles, no new CSS needed.
function TierTable() {
  const rows: [string, string, string][] = [
    ["Declared as", '"shared" (default, or absent)', '"microvm"'],
    ["Executor", "Goroutine inside control-plane (executeRunInlineSync)", "Scheduler → manager → Firecracker / Kata / K8s Job"],
    ["Isolation", "Same OS process — trust first-party code", "Separate kernel (gVisor) or hypervisor (Kata)"],
    ["Latency to first token", "~50–200 ms", "~150 ms warm  /  ~1.5 s cold-boot"],
    ["Egress", "Unrestricted (trusted code)", "Harness allowlist; deny-default; iptables REDIRECT required in prod"],
    ["Crash resume", "30 s recovery sweep + CompletedStep journal replay", "VM lifecycle; recovery sweep re-schedules (≤ 3 attempts)"],
    ["Secret delivery", "Resolved inline at step time, never logged", "Short-TTL JWT over vsock; args stripped from audit"],
    ["Use case", "Loop agents, bridge replies, dashboard runs, trusted workflows", "User-supplied code, exec tools, untrusted packages"],
    ["Downgrade safety", "N/A", "Never falls back to shared — failure is explicit (microvm_unavailable)"],
  ];
  return (
    <table>
      <thead>
        <tr>
          <th></th>
          <th>Shared tier</th>
          <th>MicroVM tier</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, shared, micro]) => (
          <tr key={label}>
            <td><strong>{label}</strong></td>
            <td>{shared}</td>
            <td>{micro}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function RuntimeOverviewPage() {
  return (
    <>
      <h1>Agent Runtime</h1>
      <p>
        Every Lantern run executes in one of two tiers — <strong>shared</strong>{" "}
        (inline executor inside the control-plane) or{" "}
        <strong>microVM</strong> (W12 Kubernetes/Firecracker/Kata stack) —
        declared in the agent version&apos;s{" "}
        <code>manifest.isolation</code> at publish time, not overridable by the
        caller.
      </p>

      {/* Hero diagram — clickable runtime map */}
      <Diagram
        name="runtime-map"
        caption="The runtime in one view — gated, executed, made durable, and proven. Every card links to its deep-dive page."
      />

      {/* Detailed lifecycle view */}
      <Diagram
        name="run-lifecycle-live"
        caption="The same story in full detail: POST /v1/runs through auth, budget, and isolation gates to the tier that executes, the status machine, and a signed receipt — every box is real code."
      />

      <h2 id="tiers">Two tiers, one journal</h2>
      <p>
        Both tiers write to the same <code>journal_events</code> table. The run
        waterfall, Ed25519 receipts, and crash-replay are tier-agnostic — there
        is no second event store.
      </p>
      <TierTable />

      <h2 id="routing">How routing works</h2>
      <p>
        When <code>POST /v1/runs</code> arrives, the control-plane reads{" "}
        <code>manifest.isolation</code> from the resolved agent version and
        dispatches to either <code>executeRunInline</code> (shared) or{" "}
        <code>scheduleAgentSpec</code> (microVM). The caller supplies only the
        input; the tier comes from the manifest.
      </p>
      <p>
        Unknown values in <code>manifest.isolation</code> are rejected at{" "}
        <strong>agent-version publish time</strong> with HTTP 400 — a typo fails
        at deploy, not at run time.
      </p>
      <div className="callout callout-warning">
        <strong>No silent downgrade.</strong> If the microVM tier is
        unavailable (scheduler unreachable, quota exceeded, manager down), the
        run fails with code <code>microvm_unavailable</code>. A VM that exits
        unexpectedly produces <code>microvm_exit</code>; exhausting the 3-attempt
        resume limit produces <code>microvm_resume_exhausted</code>. None of
        these ever fall back to the shared tier — the isolation declaration is a
        security boundary.
      </div>

      <h2 id="shared">Shared tier</h2>
      <p>
        The shared tier is a goroutine inside the control-plane. Every live
        Lantern run today executes here: loop agents, bridge replies, dashboard
        runs, cron-triggered runs, and sessions. It drives either the{" "}
        <strong>plain-LLM tool-use loop</strong> (for agents with no{" "}
        <code>workflow</code> JSONB) or the{" "}
        <strong>workflow interpreter</strong> (for agents with a graph saved in
        the visual editor). Crash-resume is handled by the recovery sweep — see{" "}
        <Link href="/runtime/durable-execution">Durable execution</Link>.
      </p>
      <p>
        Entry points: <code>POST /v1/runs</code>, <code>POST /v1/sessions/{"{id}"}/messages</code>,
        cron scheduler, loop agent tick, bridge-triggered run.
      </p>

      <h2 id="microvm">MicroVM tier</h2>
      <p>
        The microVM tier is required for agents that run user-supplied code,{" "}
        <code>exec</code> arbitrary tools, or load untrusted packages. Declare
        it in the manifest:
      </p>
      <pre><code>{`manifest:
  isolation: microvm          # routes this agent version to the W12 stack
  image_digest: …@sha256:…
  limits: { vcpu: "250m", memory: "128Mi", timeout: "60s" }
  egress_rules: [{ host: "api.openai.com" }]
  idempotent: true`}</code></pre>
      <p>
        The in-guest tool runner (shipped 2026-07-23) gives the harness a typed
        tool registry — <code>shell_exec</code> and <code>http_fetch</code> — so
        workflow-graph agents can route to the microVM tier as a real step
        executor.
      </p>

      <h2 id="health-sweep">Service-health sweep</h2>
      <p>
        A background loop TCP-probes peer services every 60 s (
        <code>LANTERN_HEALTH_SWEEP_INTERVAL</code>). After 3 consecutive
        failures it declares the peer <strong>DOWN</strong> and texts the
        owner&apos;s self-chat — once on transition, no storms. Read the current
        snapshot:
      </p>
      <pre><code>{`GET /v1/system/health    # JWT-authed`}</code></pre>
      <pre><code>{`{
  "services": [
    {
      "name": "runtime-manager",
      "addr": "localhost:50054",
      "up": false,
      "consecutiveFailures": 5,
      "lastChecked": "2026-07-23T10:00:00Z"
    }
  ]
}`}</code></pre>

      <h2 id="architecture">System architecture</h2>
      <p>
        The technical view — how the control-plane, scheduler, runtime-manager,
        and in-VM harness collaborate across both tiers on the same{" "}
        <code>journal_events</code> substrate.
      </p>
      <Diagram
        name="runtime-two-tier"
        caption="The isolation gate reads manifest.isolation from the resolved agent version. Both tiers checkpoint to the same journal_events substrate."
      />

      <h2 id="principles">What makes it different</h2>
      <div className="card-grid">
        <Link href="/runtime/durable-execution" className="card">
          <div className="card-title">
            <ShieldCheck className="w-4 h-4 text-emerald-400" /> Durable by default
          </div>
          <div className="card-desc">
            Every step is journaled. A crash-replay skips completed nodes and replays cached LLM outputs — no re-spent tokens, no double side-effects.
          </div>
        </Link>
        <Link href="/runtime/isolation" className="card">
          <div className="card-title">
            <Lock className="w-4 h-4 text-sky-400" /> Isolation by manifest
          </div>
          <div className="card-desc">
            Isolation strength is declared in the agent version, not chosen by the caller. Fail-closed: untrusted workloads are refused without the hardened RuntimeClass, never silently downgraded.
          </div>
        </Link>
        <Link href="/runtime/observability" className="card">
          <div className="card-title">
            <Activity className="w-4 h-4 text-lantern-400" /> One observability contract
          </div>
          <div className="card-desc">
            One OTel trace per spawn, W3C traceparent end-to-end, five{" "}
            <code>lantern.run.*</code> metrics, and a shared span-attribute
            contract from HTTP entry to harness exit.
          </div>
        </Link>
      </div>

      <h2 id="guides">In this section</h2>
      <ul>
        <li><Link href="/runtime/quickstart"><strong>Headless agent quickstart</strong></Link> — write your first <code>agent.yaml</code> and run it end-to-end in ~15 minutes</li>
        <li><Link href="/runtime/isolation"><strong>Isolation classes</strong></Link> — the decision tree from <code>trusted</code> to <code>hostile</code>, and the fail-closed gate</li>
        <li><Link href="/runtime/durable-execution"><strong>Durable execution</strong></Link> — exactly-once under crash: journal, replay, per-step retry, idempotency keys</li>
        <li><Link href="/runtime/streaming"><strong>Token streaming</strong></Link> — <code>message_delta</code> / <code>message_completed</code> / <code>message_error</code> contract and the SDK async iterator</li>
        <li><Link href="/runtime/sessions-and-memory"><strong>Sessions &amp; memory</strong></Link> — interactive multi-turn sessions on the shared tier, and LLM-distilled long-term memory</li>
        <li><Link href="/runtime/observability"><strong>Observability</strong></Link> — OTel span attributes, the five <code>lantern.run.*</code> metrics, service-health sweep</li>
        <li><Link href="/runtime/identity"><strong>Identity &amp; secrets</strong></Link> — per-instance Ed25519 keys and short-TTL secret vending (microVM tier)</li>
        <li><Link href="/runtime/receipts"><strong>Verifiable receipts</strong></Link> — signed, offline-verifiable proof of what ran</li>
      </ul>

      <div className="callout callout-info">
        <strong>Interactive agents use sessions, not runs.</strong> For
        multi-turn conversations see <Link href="/agents">Agents</Link>; for the
        full REST surface see the <Link href="/api">API reference</Link>.
        Sessions execute on the shared tier.
      </div>
    </>
  );
}
