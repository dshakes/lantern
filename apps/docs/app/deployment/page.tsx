import Link from "next/link";
import { Diagram } from "../_components/Diagram";
import { Concept } from "../_components/Concept";
import { pageMeta } from "../_meta";

export const metadata = pageMeta("/deployment");

export default function DeploymentPage() {
  return (
    <>
      <h1>Deployment</h1>
      <p>
        Lantern splits into a <strong>control plane</strong> (scheduling, routing, dashboard) and a <strong>data plane</strong> (microVMs, execution, secrets). The data plane runs in your cloud — agent data never leaves your VPC.
      </p>

      <Concept>
        Two halves: the <em>control plane</em> is the brain (dashboards,
        scheduling, budgets — it decides what should run), and the{" "}
        <em>data plane</em> is the muscle (where agent code actually executes,
        with your API keys and your data). The point of the split: you can keep
        the muscle inside your own cloud account, so prompts, credentials, and
        customer data never leave your infrastructure — while the brain is run
        for you as a service. Pick the mix that fits: fully managed, hybrid, or
        everything self-hosted.
      </Concept>

      <h2 id="architecture">Architecture — the CP/DP split</h2>
      <Diagram
        name="lantern-architecture"
        caption="The full system: channels → gateways → control plane → your data plane. The control plane never runs user code."
      />
      <Diagram
        name="cp-dp-architecture"
        caption="What crosses the boundary: specs, identity, and trace context go down; heartbeats, step events, and audit come back. Token-authenticated (mTLS hardening planned) — prompts and data never leave your VPC."
      />

      <h2>Deployment options</h2>

      <h3>Fully managed (Lantern Cloud)</h3>
      <p>Both planes hosted by Lantern. No infrastructure to manage. Everything runs on Lantern infrastructure.</p>
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
      <p>
        The repo ships one chart, <code>infra/helm/lantern</code>, with <code>values-dev.yaml</code>,{" "}
        <code>values-staging.yaml</code> and <code>values-prod.yaml</code>. It deploys the gateway, control plane, model
        router, workflow engine, runtime manager, runtime scheduler, surface gateway and dashboard, with in-cluster Postgres and S3-compatible storage for development and a Redis subchart. The
        chart defaults <code>LANTERN_ENV=production</code>, so the production startup guards are on.
      </p>
      <pre><code>{`helm install lantern ./infra/helm/lantern \\
  --namespace lantern --create-namespace \\
  --values infra/helm/lantern/values-prod.yaml`}</code></pre>
      <p>
        Top-level values keys: <code>global</code>, <code>gateway</code>, <code>controlPlane</code>,{" "}
        <code>modelRouter</code>, <code>workflowEngine</code>, <code>runtimeManager</code>, <code>runtimeScheduler</code>,{" "}
        <code>surfaceGateway</code>, <code>dashboard</code>, <code>postgresql</code>, <code>redis</code>, <code>minio</code>,{" "}
        <code>ingress</code>, <code>networkPolicy</code>, <code>backup</code>, <code>secrets</code>,{" "}
        <code>serviceAccount</code>. There is no separate data-plane chart yet; for a data plane in another cloud, use the
        Terraform path below.
      </p>
      <h3>Production settings</h3>
      <ul>
        <li><strong>Autoscaling and disruption</strong> — <code>&lt;component&gt;.autoscaling.enabled</code> adds a CPU-based HPA (needs metrics-server) for the control plane, gateway, model router, workflow engine and dashboard; <code>values-prod.yaml</code> turns it on. Components with more than one replica get a PodDisruptionBudget.</li>
        <li><strong>NetworkPolicy</strong> — <code>networkPolicy.enabled=true</code> denies all traffic in the release, then allows only the service-to-service flows the platform needs, DNS, and scrapes of <code>/metrics</code> from <code>networkPolicy.metricsFrom</code>. Only the control plane, model router, workflow engine, runtime scheduler, runtime manager, surface gateway and backup job may leave the cluster; use <code>networkPolicy.extraEgress</code> for managed Postgres or Redis on private IPs. Your CNI must enforce policy (Calico, Cilium).</li>
        <li><strong>Secrets you must supply</strong> — <code>secrets.jwtSecret</code>, <code>credentialKey</code>, <code>receiptSecret</code>, <code>grpcServiceToken</code>, <code>schedulerNodeToken</code>, <code>appDbPassword</code>, and with managed stores <code>postgresPassword</code> and <code>minioPassword</code> (the S3 secret key). The control plane also refuses to start in production without its gRPC TLS cert and the runtime-manager mTLS client cert; the chart cannot create these, so mount them with <code>controlPlane.extraVolumes</code> and <code>extraEnv</code>.</li>
        <li><strong>Backups</strong> — <code>backup.enabled=true</code> adds a CronJob that writes a gzipped <code>pg_dump</code> to <code>s3://&lt;backup.s3Bucket&gt;/postgres/</code> and prunes dumps older than <code>backup.retentionDays</code>. Prove a dump restores with <code>scripts/db-restore-drill.sh &lt;dump.sql.gz&gt;</code>; see <code>docs/runbooks/db-restore.md</code>. This is a floor; managed Postgres with point-in-time recovery is the recommended production path.</li>
      </ul>
      <div className="callout callout-info">
        <strong>Limits:</strong> the scheduler&apos;s readiness probe uses <code>/healthz</code> by default because <code>/readyz</code> stays unready until a runtime-manager node registers.
      </div>

      <h3 id="dependencies">In-cluster dependencies (dev) vs managed (prod)</h3>
      <p>
        Lantern needs Postgres with the <code>pgvector</code> extension, an S3-compatible object store and Redis. The chart
        can run them for you, which is what you want on kind or a laptop, but production should use managed services.
      </p>
      <table>
        <thead><tr><th></th><th>Dev / kind / evaluation (default)</th><th>Production (<code>values-prod.yaml</code>)</th></tr></thead>
        <tbody>
          <tr><td>Postgres</td><td><code>postgresql.enabled=true</code>: one <code>pgvector/pgvector</code> StatefulSet with a PVC. Password is <code>secrets.postgresPassword</code>.</td><td><code>postgresql.enabled=false</code> and <code>externalDatabase.host</code> (plus <code>port</code>, <code>sslmode</code>). User and database names still come from <code>postgresql.auth</code>. Provision <code>pgvector</code> and the <code>lantern_app</code> role yourself.</td></tr>
          <tr><td>Object store</td><td><code>minio.enabled=true</code>: one SeaweedFS StatefulSet with a PVC, one identity built from <code>minio.auth.rootUser</code> and <code>secrets.minioPassword</code>. Buckets in <code>minio.defaultBuckets</code> are created by a post-install Job.</td><td><code>minio.enabled=false</code> and <code>externalS3.endpoint</code>, <code>accessKeyId</code>, <code>bucket</code> and <code>region</code> (must match the bucket&apos;s region); the secret key is <code>secrets.minioPassword</code>.</td></tr>
          <tr><td>Redis</td><td>Bitnami subchart (<code>redis.enabled</code>).</td><td>Same subchart for now.</td></tr>
        </tbody>
      </table>
      <p>
        With the in-cluster stores off, <code>helm template</code> fails unless <code>externalDatabase.host</code> and{" "}
        <code>externalS3.endpoint</code> are set, so a production install cannot silently fall back to a single-pod database.
      </p>
      <div className="callout callout-warning">
        <strong>Dev stores are not production storage.</strong> They are single replicas with no replication, point-in-time
        recovery or lifecycle rules. Image tags are pinned in <code>values.yaml</code> (<code>postgresql.image</code>, <code>minio.image</code>).
        Earlier versions of the chart used Bitnami subcharts for Postgres and MinIO; those crash-looped on the pgvector image and their MinIO images are no longer published. The new Postgres and object-store StatefulSets keep the old names but use different selectors, which Kubernetes will not patch in place: to move an existing release, take a dump (<code>docs/runbooks/db-restore.md</code>), uninstall, install, and restore.
      </div>

      <h2 id="terraform">Terraform</h2>
      <p>
        <code>lantern infra install --cloud aws|gcp|azure</code> generates Terraform for a data-plane cluster. Flags
        include <code>--tenant-id</code> (required), <code>--region</code>, <code>--cluster-name</code>, <code>--existing-cluster</code>,{" "}
        <code>--instance-type</code> and <code>--node-count</code>. The modules live in <code>infra/terraform/</code> and are
        not published to the Terraform Registry. Review the output, then apply.
      </p>
      <pre><code>{`lantern infra install --cloud aws --region us-east-1 --tenant-id <tenant-id>   # generates terraform/ in the current directory
cd terraform
terraform init
terraform plan
terraform apply`}</code></pre>

      <h2 id="namespace">Namespace isolation</h2>
      <p>
        Each tenant gets its own Kubernetes namespace: <code>lantern-t-&lt;tenant_id&gt;</code>. Provides network isolation, per-tenant resource quotas, and separate service accounts and secrets.
      </p>

      <h2 id="monitoring">Monitoring</h2>
      <p>
        Every service emits OTel traces tagged with <code>tenant_id</code>, <code>run_id</code>, <code>step_id</code>, and <code>agent_version</code>. Compatible with Grafana + Tempo, Datadog, New Relic, Jaeger, and any OTel backend. The control plane also serves Prometheus metrics at <code>:8080/metrics</code> (HTTP request duration by status, run totals, budget blocks), unauthenticated, so scrape it only from inside the cluster. Alert rules and Grafana dashboards live in <code>infra/monitoring/</code>; runbooks in <code>docs/runbooks/</code>. See <Link href="/runtime/observability">Observability</Link> for details.
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
