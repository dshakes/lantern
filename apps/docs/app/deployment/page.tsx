import Link from "next/link";

export default function DeploymentPage() {
  return (
    <>
      <h1>Deployment</h1>
      <p>
        Lantern uses a <strong>control plane / data plane</strong> split
        architecture. The control plane (scheduling, routing, dashboard) can be
        hosted by Lantern or self-hosted. The data plane (microVMs, agent
        execution, secrets) runs in YOUR cloud -- agent data never leaves your
        VPC.
      </p>

      <h2 id="architecture">Architecture overview</h2>

      {/* CP/DP split + outbound-tunnel diagram */}
      <div style={{
        background: "#0d0d12",
        border: "1px solid #1e2235",
        borderRadius: "12px",
        padding: "1.5rem",
        marginBottom: "1.5rem",
        fontFamily: "var(--font-mono)",
        fontSize: "0.75rem",
      }}>
        {/* Control plane box */}
        <div style={{
          border: "1px solid #f59e0b",
          borderRadius: "8px",
          padding: "0.75rem 1rem",
          background: "#0f0e06",
          marginBottom: "0",
        }}>
          <div style={{ color: "#f59e0b", fontWeight: 700, marginBottom: "0.4rem" }}>
            Control Plane (Lantern SaaS or self-hosted)
          </div>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            {["Scheduling", "Routing", "Dashboard", "Workflow engine", "Billing"].map(s => (
              <span key={s} style={{
                background: "#1a1507",
                border: "1px solid #78350f",
                color: "#fbbf24",
                borderRadius: "4px",
                padding: "0.1rem 0.45rem",
                fontSize: "0.65rem",
              }}>{s}</span>
            ))}
          </div>
        </div>

        {/* Tunnel arrow */}
        <div style={{ textAlign: "center", padding: "0.5rem 0", color: "#52525b" }}>
          <div style={{ fontSize: "0.65rem", color: "#38bdf8", letterSpacing: "0.06em" }}>
            outbound-only · gRPC (mTLS) · :50051
          </div>
          <div style={{ color: "#38bdf8", fontSize: "1.1rem" }}>⇅</div>
          <div style={{ fontSize: "0.6rem", color: "#52525b" }}>
            data plane dials OUT — no inbound ports required in your VPC
          </div>
        </div>

        {/* Data plane box */}
        <div style={{
          border: "1px solid #34d399",
          borderRadius: "8px",
          padding: "0.75rem 1rem",
          background: "#050f0c",
        }}>
          <div style={{ color: "#34d399", fontWeight: 700, marginBottom: "0.4rem" }}>
            Data Plane (your VPC — AWS / GCP / Azure)
          </div>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
            {["Firecracker microVMs", "K8s / Kata pods", "Wasmtime", "devcontainer"].map(s => (
              <span key={s} style={{
                background: "#071a13",
                border: "1px solid #065f46",
                color: "#6ee7b7",
                borderRadius: "4px",
                padding: "0.1rem 0.45rem",
                fontSize: "0.65rem",
              }}>{s}</span>
            ))}
          </div>
          <div style={{ color: "#10b981", fontSize: "0.65rem" }}>
            Agent data · Secrets · Run payloads — none of this crosses the boundary
          </div>
        </div>
      </div>

      {/* Run routing flow */}
      <div style={{
        background: "#0d0d12",
        border: "1px solid #1e2235",
        borderRadius: "10px",
        padding: "1rem 1.25rem",
        marginBottom: "1.5rem",
        fontFamily: "var(--font-mono)",
        fontSize: "0.72rem",
      }}>
        <div style={{ color: "#71717a", marginBottom: "0.6rem", fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Run routing
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
          {[
            { label: "POST /v1/runs", color: "#f59e0b" },
            { label: "→" },
            { label: "data plane connected?", color: "#38bdf8" },
            { label: "→ YES →" },
            { label: "dispatch via RunStream", color: "#34d399" },
          ].map((item, i) =>
            item.label.startsWith("→") ? (
              <span key={i} style={{ color: "#52525b" }}>{item.label}</span>
            ) : (
              <span key={i} style={{
                background: "#0f1117",
                border: `1px solid ${item.color}`,
                color: item.color,
                borderRadius: "5px",
                padding: "0.15rem 0.5rem",
              }}>{item.label}</span>
            )
          )}
        </div>
        <div style={{ marginTop: "0.5rem", display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
          <span style={{ color: "#52525b" }}>→ NO (no plane / channel full) →</span>
          <span style={{
            background: "#0f1117",
            border: "1px solid #8b5cf6",
            color: "#8b5cf6",
            borderRadius: "5px",
            padding: "0.15rem 0.5rem",
          }}>inline execution (managed-cloud fallback)</span>
        </div>
      </div>

      <h2>Deployment options</h2>

      <h3>1. Fully managed (Lantern Cloud)</h3>
      <p>
        The simplest option. Both control plane and data plane are hosted by
        Lantern. No infrastructure to manage.
      </p>
      <ul>
        <li>Sign up at lantern.run</li>
        <li>Create agents from the dashboard</li>
        <li>Everything runs on Lantern infrastructure</li>
      </ul>

      <div className="callout callout-info">
        <strong>Note:</strong> Fully managed mode is ideal for getting started
        and for workloads that do not have strict data residency requirements.
      </div>

      <h3>2. Hybrid (recommended for production)</h3>
      <p>
        Control plane hosted by Lantern, data plane in your cloud. This gives
        you the convenience of managed scheduling and UI with the security of
        keeping agent data in your VPC.
      </p>
      <ol>
        <li>
          Deploy the data plane agent in your cloud (see Helm or Terraform
          below)
        </li>
        <li>
          Register your data plane via <code>POST /v1/data-planes</code> (or
          the dashboard under <strong>Settings &gt; Data Planes</strong>). This
          mints a one-time 32-byte bootstrap token returned in the response —
          store it; it is not recoverable after the response is closed.
        </li>
        <li>
          The data plane agent dials <strong>out</strong> to the control plane
          at <code>:50051</code> (gRPC) — no inbound ports are needed in your
          VPC. It sends the bootstrap token in a{" "}
          <code>Register</code> RPC, which returns a short-lived session JWT (
          <code>typ=dataplane-session</code>, 1 h TTL). The agent rotates it
          with <code>RefreshToken</code> before expiry.
        </li>
        <li>
          Once registered, the data plane opens a persistent{" "}
          <code>RunStream</code> bidirectional RPC. The control plane pushes run
          assignments down this stream; the agent reports acceptance, status
          updates, and completion back up. Agent runs execute inside your VPC;
          only run metadata crosses the boundary.
        </li>
      </ol>

      <h4>Tunnel RPCs at a glance</h4>
      <p>
        All RPCs are defined in{" "}
        <code>packages/proto/lantern/v1/dataplane.proto</code> and served on
        the control plane&apos;s existing <code>:50051</code> gRPC listener.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>RPC</th>
              <th>Direction</th>
              <th>Auth</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>Register</code></td>
              <td>agent → CP</td>
              <td>bootstrap token (one-time)</td>
              <td>Exchange bootstrap token for a session JWT; record hostname / region / cloud</td>
            </tr>
            <tr>
              <td><code>Heartbeat</code></td>
              <td>agent → CP</td>
              <td>plane_id + session JWT</td>
              <td>Liveness probe (every 30 s); learns of drain orders</td>
            </tr>
            <tr>
              <td><code>ReportMetrics</code></td>
              <td>agent → CP</td>
              <td>plane_id + session JWT</td>
              <td>CPU / memory / active-run pressure (every 60 s)</td>
            </tr>
            <tr>
              <td><code>RefreshToken</code></td>
              <td>agent → CP</td>
              <td>current session JWT</td>
              <td>Rotate the session JWT before the 1 h expiry</td>
            </tr>
            <tr>
              <td><code>RunStream</code> (bidi)</td>
              <td>agent ↔ CP</td>
              <td>DpHello first frame (session JWT)</td>
              <td>CP pushes run assignments; agent reports accepted / status / completed</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="callout callout-info">
        <strong>Per-tenant connection cap:</strong> up to{" "}
        <code>LANTERN_DP_MAX_STREAMS_PER_TENANT</code> concurrent{" "}
        <code>RunStream</code> connections are allowed per tenant (default 10).
        Excess connections are rejected with gRPC <code>RESOURCE_EXHAUSTED</code>.
      </div>

      <h4>Run routing</h4>
      <p>
        When <code>POST /v1/runs</code> is called:
      </p>
      <ul>
        <li>
          If the tenant has at least one data plane with an active{" "}
          <code>RunStream</code> connected, the run is dispatched to that plane.
          The run&apos;s <code>data_plane_id</code> column is pinned at dispatch
          time; the plane reports completion back over the stream.
        </li>
        <li>
          If <strong>no</strong> data plane is connected (or delivery fails
          because the assignment channel is full), the run falls back to inline
          execution inside the control plane — the managed-cloud model. The pin
          is rolled back so the inline path&apos;s writes are not blocked by a
          stale plane scope.
        </li>
      </ul>

      <h3>3. Fully self-hosted</h3>
      <p>
        Both control plane and data plane run in your infrastructure. Full
        control, full responsibility.
      </p>

      <div className="callout callout-warning">
        <strong>Warning:</strong> Self-hosted deployments require you to manage
        Postgres, Redis, and Kubernetes. Make sure your team has the operational
        capacity before choosing this option.
      </div>

      <h2 id="helm">Helm charts</h2>
      <p>
        Lantern provides Helm charts for Kubernetes deployment:
      </p>
      <pre>
        <code>{`# Add the Lantern Helm repository
helm repo add lantern https://charts.lantern.run
helm repo update

# Install the data plane
helm install lantern-data-plane lantern/data-plane \\
  --namespace lantern \\
  --create-namespace \\
  --set controlPlane.endpoint=https://api.lantern.run \\
  --set controlPlane.token=$LANTERN_DATA_PLANE_TOKEN \\
  --set firecracker.enabled=true

# Install the full stack (self-hosted)
helm install lantern lantern/lantern \\
  --namespace lantern \\
  --create-namespace \\
  --values values.yaml`}</code>
      </pre>

      <h3>Key Helm values</h3>
      <pre>
        <code>{`# values.yaml
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
    enabled: true`}</code>
      </pre>

      <h2 id="terraform">Terraform modules</h2>
      <p>
        For infrastructure provisioning, Lantern provides Terraform modules for
        AWS, GCP, and Azure:
      </p>

      <h3>AWS</h3>
      <pre>
        <code>{`module "lantern" {
  source  = "lantern-ai/lantern/aws"
  version = "~> 0.1"

  cluster_name    = "lantern-production"
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnets

  # RDS for Postgres
  db_instance_class = "db.r6g.large"

  # EKS for the data plane
  node_instance_type = "m6i.xlarge"
  node_count         = 3

  # S3 for snapshots and artifacts
  snapshot_bucket = "my-lantern-snapshots"
}`}</code>
      </pre>

      <h3>GCP</h3>
      <pre>
        <code>{`module "lantern" {
  source  = "lantern-ai/lantern/gcp"
  version = "~> 0.1"

  project_id  = "my-project"
  region      = "us-central1"

  # Cloud SQL for Postgres
  db_tier = "db-custom-4-16384"

  # GKE for the data plane
  node_machine_type = "e2-standard-4"
  node_count        = 3
}`}</code>
      </pre>

      <h3>Azure</h3>
      <pre>
        <code>{`module "lantern" {
  source  = "lantern-ai/lantern/azure"
  version = "~> 0.1"

  resource_group = "lantern-production"
  location       = "eastus"

  # Azure Database for PostgreSQL
  db_sku_name = "GP_Standard_D4s_v3"

  # AKS for the data plane
  node_vm_size = "Standard_D4s_v3"
  node_count   = 3
}`}</code>
      </pre>

      <h2 id="docker">Docker Compose</h2>
      <p>
        For local development and small deployments, use Docker Compose:
      </p>
      <pre>
        <code>{`# Start the full stack
docker compose -f infra/docker/docker-compose.yml up --build

# Or start only infrastructure (Postgres, Redis, MinIO)
make dev-infra`}</code>
      </pre>

      <div className="callout callout-tip">
        <strong>Tip:</strong> Docker Compose is great for local development
        but not recommended for production. Use Kubernetes with Helm charts
        for production deployments.
      </div>

      <h2>Namespace isolation</h2>
      <p>
        In multi-tenant deployments, each tenant gets its own Kubernetes
        namespace: <code>lantern-t-&lt;tenant_id&gt;</code>. This provides:
      </p>
      <ul>
        <li>Network isolation between tenants</li>
        <li>Resource quotas per tenant</li>
        <li>Separate service accounts and secrets</li>
      </ul>

      <h2>Monitoring</h2>
      <p>
        Lantern exports OpenTelemetry traces and metrics from every service.
        Every trace includes <code>tenant_id</code>, <code>run_id</code>,{" "}
        <code>step_id</code>, and <code>agent_version</code>. Compatible with:
      </p>
      <ul>
        <li>Grafana + Tempo</li>
        <li>Datadog</li>
        <li>New Relic</li>
        <li>Jaeger</li>
        <li>Any OTel-compatible backend</li>
      </ul>
      <p>
        Production alert rules, Grafana dashboards, and operator runbooks are
        in{" "}
        <a href="https://github.com/dshakes/lantern/blob/master/infra/monitoring/prometheus/alerts.yml">
          <code>infra/monitoring/prometheus/</code>
        </a>{" "}
        and{" "}
        <a href="https://github.com/dshakes/lantern/blob/master/docs/runbooks/README.md">
          <code>docs/runbooks/</code>
        </a>
        . See <Link href="/runtime/observability">Observability</Link> for details.
      </p>

      <h2 id="migrations">Database migrations</h2>
      <p>
        The control plane manages its own Postgres schema via{" "}
        <strong>golang-migrate</strong> (
        <a href="https://github.com/dshakes/lantern/blob/master/docs/adr/0010-versioned-db-migrations.md">
          ADR 0010
        </a>
        ). Migrations are embedded SQL files shipped inside the binary — no
        files to mount in the container.
      </p>
      <ul>
        <li>
          <strong>Fresh databases</strong> — migration <code>0001</code> creates
          the full schema on first boot.
        </li>
        <li>
          <strong>Existing databases</strong> — <code>0001</code> is fully{" "}
          <code>IF NOT EXISTS</code>; running it against a database already
          created by the previous startup runner records version 1 in the{" "}
          <code>schema_migrations</code> ledger and makes no DDL changes.
          No manual step or downtime required on upgrade.
        </li>
        <li>
          <strong>New changes</strong> — added as sequentially numbered pairs (
          <code>0002_*.up.sql</code> / <code>0002_*.down.sql</code>). Down
          migrations are required for every change after the baseline.
        </li>
      </ul>
      <div className="callout callout-info">
        <strong>Only the control plane runs migrations.</strong> Other services
        read and write tables but never apply schema changes. The{" "}
        <code>schema_migrations</code> ledger is visible to any Postgres client
        and is the authoritative record of schema version.
      </div>
    </>
  );
}
