import Link from "next/link";

export default function RuntimeQuickstartPage() {
  return (
    <>
      <h1>Headless Agent Quickstart</h1>
      <p>
        Write your first <code>agent.yaml</code>, pick an isolation class, run
        it, watch its logs / traces / cost, then terminate it — end to end in
        about 15 minutes. The four worked demos in{" "}
        <a href="https://github.com/dshakes/lantern/tree/master/examples/headless-agents" target="_blank" rel="noopener noreferrer"><code>examples/headless-agents/</code></a>{" "}
        are the reference; this page builds the smallest one from scratch.
      </p>

      <h2 id="prerequisites">Prerequisites</h2>
      <p>
        Have the runtime services running. From the repo root, in separate
        terminals:
      </p>
      <pre><code>{`make dev-infra            # Postgres + Redis + MinIO
make run-runtime-manager  # runtime-manager on :50054
make run-scheduler        # scheduler on :50055 / :8085
make run-api-runtime      # control-plane wired to the scheduler, :8080`}</code></pre>
      <p>
        Docker on the host is enough for the <code>trusted</code> and{" "}
        <code>standard</code> classes. You also need an API token exported as{" "}
        <code>LANTERN_API_TOKEN</code> for the REST calls below.
      </p>

      <h2 id="write">1. Write the spec</h2>
      <p>
        An <code>agent.yaml</code> declares the image, the isolation class,
        limits, and any egress / secrets. Here is the minimal one — a
        first-party script that only writes to stdout, so it picks{" "}
        <code>trusted</code> and asks for no network:
      </p>
      <pre><code>{`apiVersion: lantern.dev/v1
kind: AgentSpec

metadata:
  name: hello
  labels:
    owner: lantern-team

spec:
  image_digest: lantern/demos/hello@sha256:0000...0001
  isolation: trusted        # first-party, no package loading

  limits:
    vcpu: "100m"            # 0.1 vCPU
    memory: "64Mi"
    timeout: 30s
    scratch_size: "16Mi"

  network: none             # stdout only, no egress
  secrets: []
  egress_rules: []
  idempotent: true`}</code></pre>
      <div className="callout callout-info">
        <strong>Note:</strong> <code>image_digest</code> is pinned by digest,
        not a tag — the runtime runs exactly the bytes you signed. Choosing the
        isolation class is the one decision that matters most; the{" "}
        <Link href="/runtime/isolation">isolation classes</Link> guide is the
        decision tree.
      </div>

      <h2 id="pick">2. Pick the isolation class</h2>
      <p>
        Rule of thumb: <strong>first-party signed code →{" "}
        <code>trusted</code></strong>, <strong>your own code, default →{" "}
        <code>standard</code></strong>, <strong>loads internet packages or
        drives a browser → <code>untrusted</code></strong>,{" "}
        <strong>adversarial input → <code>hostile</code></strong>. Demo 02
        (<code>web-scraper</code>) uses <code>untrusted</code> precisely because
        it pulls <code>requests</code> + <code>beautifulsoup4</code> from PyPI.
        Full tree in <Link href="/runtime/isolation">Isolation classes</Link>.
      </p>

      <h2 id="run">3. Run it</h2>
      <p>The CLI schedules the spec and tails the logs:</p>
      <pre><code>{`lantern run examples/headless-agents/01-hello/agent.yaml \\
  --input '{"name": "Ada"}'`}</code></pre>
      <p>Or POST the spec directly to the control plane:</p>
      <pre><code>{`curl -X POST http://localhost:8080/v1/runtime/schedule \\
  -H "Authorization: Bearer $LANTERN_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d @examples/headless-agents/01-hello/spec.json`}</code></pre>
      <p>
        The response carries a <code>vm_id</code>. If you are over your
        per-tenant quota the call returns <strong>HTTP 402</strong> instead of
        scheduling.
      </p>

      <h2 id="watch">4. Watch logs, traces &amp; cost</h2>
      <p>Stream the harness log lines over SSE:</p>
      <pre><code>{`curl -N http://localhost:8080/v1/runtime/vms/<vm_id>/logs \\
  -H "Authorization: Bearer $LANTERN_API_TOKEN"`}</code></pre>
      <p>Inspect the instance and its recent audit events:</p>
      <pre><code>{`curl http://localhost:8080/v1/runtime/vms/<vm_id> \\
  -H "Authorization: Bearer $LANTERN_API_TOKEN"`}</code></pre>
      <p>
        Or open <a href="http://localhost:3001/runtime" target="_blank" rel="noopener noreferrer">localhost:3001/runtime</a>{" "}
        — the dashboard shows the live instance, its log stream, resource usage,
        and lets you exec in for debugging. If you have an OTel collector wired
        (<Link href="/runtime/observability">Observability</Link>) you get one trace
        per spawn with token + cost telemetry; aggregate counters are at{" "}
        <code>GET /v1/runtime/metrics</code>.
      </p>

      <h2 id="terminate">5. Terminate</h2>
      <p>
        A clean-exiting workload is torn down automatically. To drain and stop
        one early:
      </p>
      <pre><code>{`curl -X DELETE "http://localhost:8080/v1/runtime/vms/<vm_id>?grace=30s" \\
  -H "Authorization: Bearer $LANTERN_API_TOKEN"`}</code></pre>
      <p>
        The instance drains for the grace period, the manager tears down the
        pod, and the scheduler marks its state <code>terminated</code>.
      </p>

      <h2 id="next">What&apos;s next</h2>
      <ul>
        <li><Link href="/runtime/isolation">Isolation classes</Link> — pick the right boundary for the workload</li>
        <li><Link href="/runtime/durable-execution">Durable execution</Link> — what happens when a node dies mid-run</li>
        <li><Link href="/runtime/identity">Identity &amp; secrets</Link> — vend a real secret into the workload (demo 02)</li>
        <li><Link href="/runtime/observability">Observability</Link> — wire an OTel collector and read the trace</li>
      </ul>
    </>
  );
}
