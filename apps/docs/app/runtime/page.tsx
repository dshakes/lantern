export default function RuntimeOverviewPage() {
  return (
    <>
      <h1>Headless Agent Runtime</h1>
      <p>
        The runtime is where headless agents actually execute. You hand Lantern
        an <code>agent.yaml</code> — an image, an isolation class, resource
        limits, egress rules, and secret refs — and the platform schedules it,
        boots it, streams its logs and traces back, meters its cost, and tears
        it down. Every spawn runs <strong>in your own VPC</strong>, on your
        Kubernetes cluster.
      </p>

      <h2 id="model">The model in one picture</h2>
      <pre><code>{`lantern run agent.yaml
        │
        ▼
Control plane (:8080)        — RBAC + quota gate, schedules the spec
        │  gRPC
        ▼
runtime-scheduler (:50055)   — picks a node (warm-pool / region / cost / health)
        │  gRPC
        ▼
runtime-manager (:50054)     — builds the pod spec, sets runtimeClassName
        │
        ▼
Kubernetes pod (your VPC)    — RuntimeClass = isolation tier
        │
        ▼
harness (PID 1, baked in)    — egress allowlist, secret vending, heartbeats, logs`}</code></pre>

      <h2 id="principles">What makes it different</h2>

      <h3>Kubernetes-default substrate</h3>
      <p>
        Every isolation class runs as a <strong>Kubernetes pod</strong>. There
        is no separate microVM fleet to provision for the common case — the
        data plane is already K8s in your VPC, and the runtime rides the same
        substrate. See <a href="/runtime/isolation">Isolation classes</a> and{" "}
        <a href="https://github.com/dshakes/lantern/blob/master/docs/adr/0009-kubernetes-default-runtime-substrate.md" target="_blank" rel="noopener noreferrer">ADR 0009</a>.
      </p>

      <h3>Isolation is a RuntimeClass tier</h3>
      <p>
        Isolation strength is selected by <code>runtimeClassName</code>, not by
        a separate orchestration backend. A reviewer reads{" "}
        <code>isolation: untrusted</code> in the spec and knows exactly what
        kernel boundary the workload runs behind. Untrusted and hostile classes{" "}
        <strong>fail closed</strong> — they refuse to run on a node that does
        not advertise the hardened RuntimeClass, never downgrading to a bare
        pod.
      </p>

      <h3>Durable execution</h3>
      <p>
        Work is event-sourced into a journal. If a node dies mid-run, the agent
        resumes from the last <code>step_completed</code> on another node — it
        does not re-spend tokens or re-fire side effects.{" "}
        <a href="/runtime/durable-execution">Read how</a>.
      </p>

      <h3>Per-instance identity</h3>
      <p>
        Each spawn is issued its own <strong>Ed25519 keypair</strong>. The
        instance authenticates secret-vending calls with it and is externally
        verifiable. <a href="/runtime/identity">Read how</a>.
      </p>

      <h3>One trace per spawn</h3>
      <p>
        Every spawn emits a single OTel trace correlated by{" "}
        <code>(tenant_id, run_id, step_id, agent_instance_id, trace_id)</code>,
        with GenAI semantic-convention attributes for token and cost telemetry.{" "}
        <a href="/runtime/observability">Read how</a>.
      </p>

      <h2 id="guides">In this section</h2>
      <ul>
        <li><a href="/runtime/quickstart"><strong>Headless agent quickstart</strong></a> — write your first <code>agent.yaml</code> and run it end-to-end in ~15 minutes</li>
        <li><a href="/runtime/isolation"><strong>Isolation classes</strong></a> — the decision tree from <code>trusted</code> to <code>hostile</code>, and the fail-closed gate</li>
        <li><a href="/runtime/durable-execution"><strong>Durable execution</strong></a> — exactly-once under crash: journal, replay, idempotency keys</li>
        <li><a href="/runtime/observability"><strong>Observability</strong></a> — one trace per spawn, OTel wiring, the metrics endpoint</li>
        <li><a href="/runtime/identity"><strong>Identity &amp; secrets</strong></a> — per-instance keys and short-TTL secret vending</li>
        <li><a href="/runtime/receipts"><strong>Verifiable receipts</strong></a> — signed, offline-verifiable proof of what ran</li>
      </ul>

      <div className="callout callout-info">
        <strong>Note:</strong> The runtime is the headless (autonomous,
        non-interactive) execution path. For interactive multi-turn agents see{" "}
        <a href="/agents">Agents</a>; for the control-plane REST surface see the{" "}
        <a href="/api">API reference</a>.
      </div>
    </>
  );
}
