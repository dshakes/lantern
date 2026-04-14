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
      <pre>
        <code>{`┌─────────────────────────────────┐
│  Control Plane (Lantern SaaS)   │
│  Scheduling · Routing · UI      │
│  Workflow engine · Billing       │
└──────────┬──────────────────────┘
           │ gRPC tunnel (mTLS)
┌──────────▼──────────────────────┐
│  Data Plane (Your VPC)          │
│  Firecracker microVMs           │
│  K8s / Kata pods                │
│  Secrets · Agent data           │
│  ← data never leaves here       │
└─────────────────────────────────┘`}</code>
      </pre>

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
          Register your data plane in the Lantern dashboard under{" "}
          <strong>Settings &gt; Data Plane</strong>
        </li>
        <li>
          The data plane establishes a gRPC tunnel to the control plane using
          mutual TLS
        </li>
        <li>
          Agent runs execute in your VPC; the control plane orchestrates
          remotely
        </li>
      </ol>

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
    </>
  );
}
