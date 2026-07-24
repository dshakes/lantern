import Link from "next/link";
import { Diagram } from "../_components/Diagram";

// Tier comparison — reuses .prose table styles, no new CSS needed.
function TierTable() {
  const rows: [string, string, string][] = [
    ["Declared as", '"shared" (default, or absent)', '"microvm"'],
    ["Executor", "Goroutine inside control-plane (executeRunInlineSync)", "Scheduler → manager → Firecracker / Kata / K8s Job"],
    ["Isolation", "Same OS process — trust first-party code", "Separate kernel (gVisor) or hypervisor (Kata)"],
    ["Latency to first token", "~50–200 ms", "~150 ms warm  /  ~1.5 s cold-boot"],
    ["Egress", "Unrestricted (trusted code)", "Harness allowlist; deny-default; iptables REDIRECT required in prod"],
    ["Crash resume", "30 s recovery sweep + CompletedStep journal replay", "VM lifecycle; scheduler reschedules idempotent VMs"],
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
        (the inline executor inside the control-plane) or{" "}
        <strong>microVM</strong> (the W12 Kubernetes/Firecracker/Kata stack).
        The tier is a property of the agent version, declared in{" "}
        <code>manifest.isolation</code>. It cannot be changed by the caller at
        run time.
      </p>

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
        run fails with code <code>microvm_unavailable</code>. It never falls
        back to the shared tier — that isolation declaration is a security
        boundary.
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
        <code>exec</code> arbitrary tools, or load untrusted packages. It is the
        architectural answer to invariant #5 ("untrusted code runs in a
        microVM"). Declare it in the manifest:
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

      <h2 id="model">Two-tier routing diagram</h2>
      <Diagram
        name="runtime-two-tier"
        caption="The isolation gate reads manifest.isolation from the resolved agent version. Both tiers write to the shared journal at the bottom."
      />
      <p>
        The control-plane is the gatekeeper: it stamps <code>tenant_id</code>,
        checks quota, and forwards to the scheduler. The runtime-manager runs
        inside your VPC and never accepts requests directly from the caller.
      </p>

      <h2 id="health-sweep">Service-health sweep</h2>
      <p>
        A background loop in the control-plane TCP-probes its peer services
        every 60 s (configurable via <code>LANTERN_HEALTH_SWEEP_INTERVAL</code>).
        After 3 consecutive failures it declares the peer <strong>DOWN</strong>{" "}
        and texts the owner&apos;s self-chat — once, on the first transition, no
        storms. It recovers with a single UP notification.
      </p>
      <p>
        Services probed (only when their address env var is set):{" "}
        <code>model-router</code>, <code>runtime-scheduler</code>,{" "}
        <code>runtime-manager</code>, <code>workflow-engine</code>. Read the
        current snapshot:
      </p>
      <pre><code>{`GET /v1/system/health    # JWT-authed`}</code></pre>
      <pre><code>{`{
  "services": [
    {
      "name": "runtime-manager",
      "addr": "localhost:50054",
      "up": false,
      "consecutiveFailures": 5,
      "lastChecked": "2026-07-23T10:00:00Z",
      "lastTransition": "2026-07-23T09:57:00Z"
    }
  ]
}`}</code></pre>

      <h2 id="principles">What makes it different</h2>

      <h3>Durable by default</h3>
      <p>
        Work is event-sourced into <code>journal_events</code>. If the process
        crashes mid-step, the run resumes from the last{" "}
        <code>step_completed</code> — it does not re-spend tokens or re-fire
        side effects.{" "}
        <Link href="/runtime/durable-execution">Read how</Link>.
      </p>

      <h3>Isolation is a manifest declaration</h3>
      <p>
        Isolation strength is declared in the agent version, not chosen by the
        caller. Untrusted and hostile classes{" "}
        <strong>fail closed</strong> — they refuse to run without the hardened
        RuntimeClass, never silently downgrading.{" "}
        <Link href="/runtime/isolation">Read how</Link>.
      </p>

      <h3>Per-instance identity (microVM tier)</h3>
      <p>
        Each spawn is issued its own <strong>Ed25519 keypair</strong>. The
        instance authenticates secret-vending calls with it and is externally
        verifiable. <Link href="/runtime/identity">Read how</Link>.
      </p>

      <h3>One trace per spawn</h3>
      <p>
        Every run emits a single OTel trace correlated by{" "}
        <code>lantern.tenant_id</code>, <code>lantern.run_id</code>, and{" "}
        <code>lantern.step_id</code>. On the microVM tier the trace also carries{" "}
        <code>vm_id</code>, <code>isolation_class</code>, and{" "}
        <code>agent_instance_id</code> (per-spawn identity) with a W3C{" "}
        <code>traceparent</code> propagated from the control-plane through
        scheduler → manager → harness.{" "}
        <Link href="/runtime/observability">Read how</Link>.
      </p>

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
