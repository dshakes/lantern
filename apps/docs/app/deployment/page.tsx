import Link from "next/link";

export default function DeploymentPage() {
  return (
    <>
      <h1>Deployment</h1>
      <p>
        Lantern splits into a <strong>control plane</strong> (scheduling, routing, dashboard) and a <strong>data plane</strong> (microVMs, execution, secrets). The data plane runs in your cloud — agent data never leaves your VPC.
      </p>

      {/* CP/DP split diagram — simplified */}
      <div style={{
        background: "#0d0d12",
        border: "1px solid #1e2235",
        borderRadius: "12px",
        padding: "1.5rem",
        marginBottom: "2rem",
        fontFamily: "var(--font-mono)",
        fontSize: "0.75rem",
      }}>
        <div style={{
          border: "1px solid #f59e0b",
          borderRadius: "8px",
          padding: "0.75rem 1rem",
          background: "#0f0e06",
          marginBottom: "0.5rem",
        }}>
          <span style={{ color: "#f59e0b", fontWeight: 700 }}>Control Plane</span>
          <span style={{ color: "#71717a", marginLeft: "0.75rem", fontSize: "0.7rem" }}>Lantern SaaS or self-hosted · Scheduling · Routing · Dashboard</span>
        </div>
        <div style={{ textAlign: "center", color: "#38bdf8", padding: "0.4rem 0", fontSize: "0.65rem", letterSpacing: "0.06em" }}>
          ⇅ outbound-only gRPC (mTLS) · :50051 · data plane dials OUT, no inbound ports needed
        </div>
        <div style={{
          border: "1px solid #34d399",
          borderRadius: "8px",
          padding: "0.75rem 1rem",
          background: "#050f0c",
        }}>
          <span style={{ color: "#34d399", fontWeight: 700 }}>Data Plane</span>
          <span style={{ color: "#71717a", marginLeft: "0.75rem", fontSize: "0.7rem" }}>Your VPC (AWS / GCP / Azure) · microVMs · secrets · run payloads</span>
        </div>
      </div>

      <h2>Deployment options</h2>

      <h3>Fully managed (Lantern Cloud)</h3>
      <p>Both planes hosted by Lantern. No infrastructure to manage. Sign up at lantern.run, create agents from the dashboard, everything runs on Lantern infrastructure.</p>
      <div className="callout callout-info">
        <strong>Best for:</strong> getting started and workloads without strict data residency requirements.
      </div>

      <h3>Hybrid (recommended for production)</h3>
      <p>Control plane hosted by Lantern; data plane in your cloud. Agent data stays in your VPC.</p>
      <ol>
        <li>Deploy the data plane Helm chart into your cluster (see below).</li>
        <li>Register via <code>POST /v1/data-planes</code> or <strong>Settings → Data Planes</strong>. This mints a one-time 32-byte bootstrap token — store it immediately.</li>
        <li>The data plane dials <strong>out</strong> to <code>:50051</code> (gRPC), sends the bootstrap token via <code>Register</code> RPC, and receives a short-lived session JWT (1 h TTL, auto-rotated via <code>RefreshToken</code>).</li>
        <li>The data plane opens a persistent <code>RunStream</code> bidi RPC. The control plane pushes run assignments; the agent reports status and completion back. Only run metadata crosses the boundary.</li>
      </ol>

      <h4>Tunnel RPCs</h4>
      <p>Defined in <code>packages/proto/lantern/v1/dataplane.proto</code>, served on the control plane&apos;s <code>:50051</code> listener.</p>
      <table>
        <thead><tr><th>RPC</th><th>Direction</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><code>Register</code></td><td>agent → CP</td><td>Exchange bootstrap token for session JWT</td></tr>
          <tr><td><code>Heartbeat</code></td><td>agent → CP</td><td>Liveness (every 30 s); learns drain orders</td></tr>
          <tr><td><code>ReportMetrics</code></td><td>agent → CP</td><td>CPU / memory / active-run pressure (every 60 s)</td></tr>
          <tr><td><code>RefreshToken</code></td><td>agent → CP</td><td>Rotate session JWT before 1 h expiry</td></tr>
          <tr><td><code>RunStream</code> (bidi)</td><td>agent ↔ CP</td><td>CP pushes assignments; agent reports accepted / completed</td></tr>
        </tbody>
      </table>
      <div className="callout callout-info">
        <strong>Per-tenant cap:</strong> up to <code>LANTERN_DP_MAX_STREAMS_PER_TENANT</code> concurrent <code>RunStream</code> connections (default 10). Excess connections return gRPC <code>RESOURCE_EXHAUSTED</code>.
      </div>

      <h3>Fully self-hosted</h3>
      <p>Both planes in your infrastructure. Full control, full responsibility.</p>
      <div className="callout callout-warning">
        <strong>Operational overhead:</strong> you manage Postgres, Redis, and Kubernetes. Ensure your team has the capacity before choosing this path.
      </div>

      <h2 id="helm">Helm</h2>
      <pre><code>{`helm repo add lantern https://charts.lantern.run && helm repo update

# Data plane only (hybrid mode)
helm install lantern-data-plane lantern/data-plane \\
  --namespace lantern --create-namespace \\
  --set controlPlane.endpoint=https://api.lantern.run \\
  --set controlPlane.token=$LANTERN_DATA_PLANE_TOKEN \\
  --set firecracker.enabled=true

# Full self-hosted stack
helm install lantern lantern/lantern \\
  --namespace lantern --create-namespace \\
  --values values.yaml`}</code></pre>

      <pre><code>{`# values.yaml
controlPlane:
  replicas: 3
  database:
    host: your-postgres-host
    name: lantern
    user: lantern
    passwordSecret: lantern-db-credentials
  redis:
    host: your-redis-host

dataPlane:
  firecracker:
    enabled: true
    snapshotBucket: s3://your-bucket/snapshots
  resources:
    limits:
      cpu: "4"
      memory: "8Gi"

ingress:
  enabled: true
  host: lantern.yourcompany.com
  tls:
    enabled: true`}</code></pre>

      <h2 id="terraform">Terraform</h2>

      <h3>AWS</h3>
      <pre><code>{`module "lantern" {
  source  = "lantern-ai/lantern/aws"
  version = "~> 0.1"

  cluster_name       = "lantern-production"
  vpc_id             = module.vpc.vpc_id
  subnet_ids         = module.vpc.private_subnets
  db_instance_class  = "db.r6g.large"
  node_instance_type = "m6i.xlarge"
  node_count         = 3
  snapshot_bucket    = "my-lantern-snapshots"
}`}</code></pre>

      <h3>GCP</h3>
      <pre><code>{`module "lantern" {
  source             = "lantern-ai/lantern/gcp"
  version            = "~> 0.1"
  project_id         = "my-project"
  region             = "us-central1"
  db_tier            = "db-custom-4-16384"
  node_machine_type  = "e2-standard-4"
  node_count         = 3
}`}</code></pre>

      <h3>Azure</h3>
      <pre><code>{`module "lantern" {
  source         = "lantern-ai/lantern/azure"
  version        = "~> 0.1"
  resource_group = "lantern-production"
  location       = "eastus"
  db_sku_name    = "GP_Standard_D4s_v3"
  node_vm_size   = "Standard_D4s_v3"
  node_count     = 3
}`}</code></pre>

      <h2 id="namespace">Namespace isolation</h2>
      <p>
        Each tenant gets its own Kubernetes namespace: <code>lantern-t-&lt;tenant_id&gt;</code>. Provides network isolation, per-tenant resource quotas, and separate service accounts and secrets.
      </p>

      <h2 id="monitoring">Monitoring</h2>
      <p>
        Every service emits OTel traces tagged with <code>tenant_id</code>, <code>run_id</code>, <code>step_id</code>, and <code>agent_version</code>. Compatible with Grafana + Tempo, Datadog, New Relic, Jaeger, and any OTel backend. Production alert rules, Grafana dashboards, and runbooks live in <code>infra/monitoring/</code> and <code>docs/runbooks/</code>. See <Link href="/runtime/observability">Observability</Link> for details.
      </p>

      <h2 id="migrations">Database migrations</h2>
      <p>
        The control plane manages its Postgres schema via <strong>golang-migrate</strong>. Migrations are embedded SQL shipped inside the binary.
      </p>
      <ul>
        <li><strong>Fresh databases</strong> — migration <code>0001</code> creates the full schema on first boot.</li>
        <li><strong>Existing databases</strong> — <code>0001</code> is fully <code>IF NOT EXISTS</code>; running it records version 1 in <code>schema_migrations</code> with no DDL changes.</li>
        <li><strong>New changes</strong> — sequential pairs (<code>0002_*.up.sql</code> / <code>0002_*.down.sql</code>). Down migrations required after the baseline.</li>
      </ul>
      <div className="callout callout-info">
        <strong>Only the control plane runs migrations.</strong> Other services read and write tables but never apply schema changes.
      </div>
    </>
  );
}
