# 17 — Deployment Model: Control Plane / Data Plane Split

> **Status:** Accepted
> **Depends on:** [01-overview](01-overview.md), [04-runtime-isolation](04-runtime-isolation.md), [10-security](10-security.md)

## Summary

Lantern deploys as two logically and physically separable planes:

1. **Control Plane** — the "brain." Dashboard, API gateway, model router, control-plane service, surface gateway, billing, and scheduler. Manages tenant configuration, agent definitions, routing decisions, and billing. Hosted by Lantern SaaS at `lantern.run` or self-hosted by the customer.

2. **Data Plane** — the "muscle." Workflow engine, runtime manager, Firecracker/Kata/Wasm sandboxes, and agent execution. All user code runs here. All user data stays here. Deployed into the customer's own cloud infrastructure (EKS, GKE, AKS, or bare metal).

A lightweight **data plane agent** maintains an outbound gRPC tunnel from the data plane to the control plane. The customer never opens inbound firewall rules.

This split is the primary deployment model for Team and Enterprise tiers and is the foundation of Lantern's data sovereignty, compliance, and low-latency execution story.

---

## Why this split matters

### Data sovereignty and compliance

Regulated industries (finance, healthcare, government, legal) require that customer data — including the prompts, agent code, tool outputs, and LLM responses that flow through an agent platform — never leave the customer's VPC. The data plane runs entirely within the customer's infrastructure. No agent code, no run inputs, no run outputs, no secrets, and no LLM response tokens transit the control plane. The control plane sees only metadata: run IDs, status transitions, timing, and metering counters.

This architecture enables compliance with:
- **SOC 2 Type II** — clear boundary between Lantern-managed and customer-managed components
- **HIPAA** — PHI never leaves the customer's VPC; BAA covers only the control plane SaaS
- **GDPR / CCPA** — data residency is guaranteed by deploying the data plane in the customer's chosen region
- **FedRAMP** — self-hosted control plane option satisfies IL4/IL5 requirements
- **PCI DSS** — cardholder data stays within the customer's CDE

### Latency

Agent execution benefits from proximity to the customer's own databases, APIs, and internal services. A data plane running in `us-east-1` calling the customer's own PostgreSQL in `us-east-1` avoids cross-region hops. The control plane can run anywhere — it handles only metadata, which is small and latency-tolerant.

### Operational independence

A transient control plane outage does not halt running agents. The data plane caches enough state to continue executing in-flight runs. New runs queue at the data plane agent and dispatch once connectivity is restored. The workflow engine's event journal is stored locally in the data plane's Postgres instance, so replay and recovery are fully local.

### Cost optimization

Customers choose their own instance types, reserved instances, savings plans, and spot configurations. Lantern does not mark up compute. The control plane is a lean SaaS with predictable per-tenant pricing.

---

## Architecture diagram

```
+---------------------------------------------------------+
|                  LANTERN CONTROL PLANE                   |
|               (lantern.run or self-hosted)               |
|                                                          |
|  +----------+  +----------+  +-------------------+      |
|  | Dashboard |  | Gateway  |  |   Control Plane   |      |
|  | (Next.js) |  | (Rust)   |  |   Service (Go)    |      |
|  +----------+  +----------+  +-------------------+      |
|  +----------+  +----------+  +-------------------+      |
|  | Model    |  | Surface  |  |   Billing /        |      |
|  | Router   |  | Gateway  |  |   Scheduler        |      |
|  +----------+  +----------+  +-------------------+      |
|                      ^                                   |
|                      | gRPC tunnel (mTLS)                |
+----------------------|-----------------------------------+
                       |
   ============ CUSTOMER VPC BOUNDARY ============
                       |
+----------------------|-----------------------------------+
|                      v                                   |
|              LANTERN DATA PLANE                          |
|           (customer's EKS / GKE / AKS)                  |
|                                                          |
|  +-----------------+  +-------------------------+        |
|  | Data Plane      |  |   Workflow Engine       |        |
|  | Agent (Go)      |  |   (Go)                  |        |
|  +-----------------+  +-------------------------+        |
|                          |                               |
|          +---------------+---------------+               |
|          v               v               v               |
|  +--------------+ +--------------+ +------------+        |
|  | Firecracker  | |  K8s Jobs    | |   Wasm     |        |
|  | MicroVMs     | |  (trusted)   | |  (pure fn) |        |
|  +--------------+ +--------------+ +------------+        |
|                                                          |
|  +--------------+  +--------------+                      |
|  |  Postgres    |  |    Redis     |  <- customer-        |
|  |  (pgvector)  |  |              |     managed or       |
|  +--------------+  +--------------+     Lantern-         |
|                                          provisioned     |
+----------------------------------------------------------+
```

---

## Three deployment modes

### Mode 1: Fully managed

Both control plane and data plane are hosted by Lantern. The customer does not manage any infrastructure. Agent code runs on Lantern's multi-tenant Kubernetes clusters with Firecracker isolation between tenants.

**Best for:** Startups, personal projects, teams that want zero ops burden and do not have data residency requirements.

**Characteristics:**
- Single Helm chart (`lantern`) deployed to Lantern-operated clusters
- Multi-tenant: all tenants share the same control plane and data plane infrastructure
- Isolation is per-run via Firecracker microVMs (tenant A's code cannot observe tenant B)
- Lantern manages upgrades, scaling, backups, and incident response
- Data resides in Lantern's AWS accounts in the customer's chosen region

### Mode 2: Hybrid (the main product)

Control plane is hosted by Lantern SaaS. Data plane is deployed into the customer's own cloud infrastructure. This is the primary enterprise deployment model.

**Best for:** Teams and enterprises that need data sovereignty, compliance, or low-latency access to internal services.

**Characteristics:**
- Control plane: `lantern-control-plane` Helm chart on Lantern's infrastructure
- Data plane: `lantern-data-plane` Helm chart on the customer's EKS / GKE / AKS cluster
- The data plane agent initiates an outbound gRPC connection to the control plane — no inbound firewall rules required on the customer's VPC
- Customer data (agent code, run inputs/outputs, secrets, tool results) never leaves the customer's VPC
- Control plane receives only metadata (run IDs, status, timing, metering)
- Customer provisions their own Postgres and Redis (or Lantern's Terraform modules provision them)
- Upgrades: Lantern upgrades the control plane transparently; the customer upgrades the data plane via `lantern infra upgrade` or Helm

**Installation flow:**
1. Customer signs up at `lantern.run` and creates a tenant
2. Customer runs `lantern infra install --cloud aws --region us-east-1`
3. CLI generates Terraform configuration for the customer's cloud
4. Customer reviews and applies the Terraform (or Lantern applies it via a guided flow)
5. Terraform provisions EKS cluster (or uses existing), installs the `lantern-data-plane` Helm chart
6. Data plane agent connects to `api.lantern.run`, registers, begins receiving run assignments

### Mode 3: Self-hosted

Both control plane and data plane are deployed into the customer's own infrastructure. Nothing touches Lantern's servers.

**Best for:** Enterprises with strict compliance requirements (FedRAMP, air-gapped environments, government), or organizations that want full control.

**Characteristics:**
- Both `lantern-control-plane` and `lantern-data-plane` Helm charts deployed to customer infrastructure
- Customer manages all upgrades, backups, and scaling
- License key required (validated offline via cryptographic signature, no phone-home)
- Lantern provides support via a private channel; no telemetry leaves the customer's network unless explicitly configured
- Can run in air-gapped environments with pre-pulled container images

---

## The gRPC tunnel

The data plane agent maintains a persistent, bidirectional gRPC stream to the control plane. This is the sole communication channel between planes.

### Why outbound-only

Enterprise network security policies strongly prefer outbound connections over inbound. Opening an inbound port in a production VPC requires firewall changes, security review, and ongoing audit. An outbound HTTPS connection to a known endpoint (`api.lantern.run:443`) is typically allowed by default and requires no firewall changes.

### Connection lifecycle

```
Data Plane Agent                    Control Plane
      |                                   |
      |--- TLS handshake (mTLS) --------->|
      |<-- TLS handshake (mTLS) ----------|
      |                                   |
      |--- Register(tenant_id, token) --->|
      |<-- RegisterAck(plane_id) ---------|
      |                                   |
      |--- Heartbeat (every 30s) -------->|
      |<-- HeartbeatAck + config ---------|
      |                                   |
      |<-- RunAssignment(run_id, ...) ----|  (server push via bidi stream)
      |--- RunAccepted(run_id) ---------->|
      |                                   |
      |--- RunStatusUpdate(run_id, ...) ->|  (repeated as run progresses)
      |--- RunCompleted(run_id, ...) ---->|
      |                                   |
      |--- Metrics(counters, ...) ------->|  (periodic, every 60s)
      |                                   |
```

### Authentication

1. **Initial registration:** The data plane agent authenticates with a short-lived token provisioned by Lantern during `lantern infra install`. This token is a signed JWT with claims `{tenant_id, plane_id, exp}`.
2. **mTLS:** After registration, the control plane issues a client certificate for the data plane. Subsequent connections use mutual TLS. Certificates are rotated automatically every 24 hours.
3. **Token refresh:** The data plane agent refreshes its token before expiry. If the token expires (e.g., due to prolonged disconnection), the agent falls back to the initial registration token stored as a Kubernetes secret.

### Reconnection

The data plane agent uses exponential backoff with jitter for reconnection:
- Initial delay: 1 second
- Maximum delay: 60 seconds
- Jitter: +/- 20%
- Maximum reconnection attempts: unlimited (the agent never gives up)

During disconnection:
- In-flight runs continue executing (the workflow engine is self-sufficient)
- Completed runs queue locally and report status when connectivity is restored
- New runs queue at the data plane agent and dispatch once connected
- The control plane marks the data plane as `degraded` after 3 missed heartbeats and `offline` after 10

---

## What flows over the tunnel (and what does not)

### Crosses the tunnel (metadata only)

| Direction | Data |
|---|---|
| Control -> Data | Run assignments (run_id, agent_version_id, input schema reference, config) |
| Control -> Data | Configuration updates (routing rules, model policies, tenant config) |
| Control -> Data | Heartbeat acknowledgments |
| Data -> Control | Run status transitions (queued, running, completed, failed, cancelled) |
| Data -> Control | Metering events (CPU-seconds, memory-seconds, token counts by model) |
| Data -> Control | Heartbeats (data plane health, capacity, queue depth) |
| Data -> Control | Agent version pull requests (the data plane pulls bundles from S3/GCS/AzBlob, not from the control plane) |

### Never crosses the tunnel

| Data | Where it stays |
|---|---|
| Agent source code | Customer's S3/GCS/AzBlob bucket, customer's data plane |
| Run inputs and outputs | Customer's data plane Postgres |
| LLM prompts and responses | Customer's data plane (model router runs in data plane in hybrid mode, or customer configures direct provider access) |
| Secrets and API keys | Customer's data plane, resolved from customer's KMS |
| Tool call results | Customer's data plane |
| Memory (core, recall, archival) | Customer's data plane Postgres + pgvector |
| Logs and traces | Customer's data plane (exported to customer's own observability stack) |

---

## Data plane components

### Data plane agent (`services/data-plane-agent/`)

A small Go service that runs as a single-replica deployment in the customer's cluster.

**Responsibilities:**
- Maintain the gRPC tunnel to the control plane
- Register the data plane and report health via heartbeats
- Receive run assignments from the control plane and dispatch them to the local workflow engine via `WorkflowEngineService.ExecuteRun` (server-streaming gRPC); the dispatcher consumes the resulting `StreamEvent` stream and drives run-status transitions through to completion or failure
- Report run status transitions and metering events back to the control plane
- Cache configuration received from the control plane (routing rules, model policies)

**Non-responsibilities:**
- Does NOT execute agent code (that is the workflow engine + runtime manager)
- Does NOT store any user data (that is Postgres + Redis + S3)
- Does NOT proxy LLM calls (that is the model router or direct provider access)

### Workflow engine (data plane instance)

Same binary as the control plane's workflow engine, but configured to:
- Use the local Postgres for its event journal
- Accept run assignments from the data plane agent (not from the control plane service)
- Report events to the data plane agent (which forwards metadata to the control plane)

### Runtime manager (data plane instance)

Same binary as the control plane's runtime manager. Manages Firecracker microVMs, K8s Jobs, and Wasm runtimes on the customer's nodes.

### Postgres and Redis

The data plane requires its own Postgres (with pgvector) and Redis instances. These can be:
- **Lantern-provisioned:** Terraform modules create RDS/Cloud SQL/Azure Database and ElastiCache/Memorystore/Azure Cache
- **Customer-managed:** The customer provides connection strings for their existing instances

---

## Cloud-specific considerations

### AWS (EKS)

- **Instance types for Firecracker:** Requires bare-metal instances (`m5.metal`, `m6i.metal`, `m7i.metal`) or instances with nested virtualization support. For development/testing, `m5.xlarge` with Kata containers as a fallback.
- **Networking:** Data plane runs in customer's VPC. Outbound HTTPS to `api.lantern.run:443` must be allowed. No inbound rules needed.
- **Storage:** S3 bucket for agent bundles and snapshots. EBS for Postgres persistence.
- **IAM:** Terraform creates an IAM role for the data plane service account (IRSA) with least-privilege access to S3 and KMS.
- **Provisioning:** Terraform module at `infra/terraform/aws/` creates EKS cluster, node group, VPC (optional), IAM roles, S3 bucket, and deploys the Helm chart.

### GCP (GKE)

- **Instance types for Firecracker:** `n2-standard-*` with nested virtualization enabled (GCE supports this natively). Or `c2d-metal-*` for bare metal.
- **Networking:** Data plane runs in customer's VPC. Outbound HTTPS to `api.lantern.run:443`. Cloud NAT for outbound if nodes are private.
- **Storage:** GCS bucket for bundles and snapshots. Persistent Disk for Postgres.
- **IAM:** Workload Identity for GKE service account to GCP service account binding.
- **Provisioning:** Terraform module at `infra/terraform/gcp/`.

### Azure (AKS)

- **Instance types for Firecracker:** `Standard_D*_v5` with nested virtualization. Or dedicated hosts for bare metal.
- **Networking:** Data plane runs in customer's VNet. Outbound HTTPS to `api.lantern.run:443`. Azure NAT Gateway for outbound.
- **Storage:** Azure Blob Storage for bundles and snapshots. Azure Managed Disk for Postgres.
- **IAM:** Managed identity with federated credentials for pod identity.
- **Provisioning:** Terraform module at `infra/terraform/azure/`.

### Bare metal / on-premises

- **Requirements:** Kubernetes 1.28+, containerd, KVM support (`/dev/kvm`), persistent storage (local-path or NFS).
- **Networking:** Outbound HTTPS to `api.lantern.run:443` (or self-hosted control plane endpoint).
- **Installation:** Manual Helm install of `lantern-data-plane` chart. No Terraform module — the customer manages their own cluster.

---

## Security model

### Mutual TLS

All communication between the data plane agent and the control plane uses mTLS. The data plane agent holds a client certificate issued by the control plane's internal CA. Certificates are short-lived (24 hours) and rotated automatically.

### Short-lived tokens

The initial registration token is a signed JWT with a 1-hour expiry. After registration, the data plane agent receives a refresh token with a 7-day expiry. The agent rotates tokens proactively before expiry.

### No secrets cross the boundary

Customer secrets (LLM API keys, database credentials, tool credentials) are stored in the customer's own secret manager (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, or Kubernetes Secrets). The runtime manager resolves secrets at execution time using the `lantern.secret/...` reference form. The control plane never sees secret values.

### Network isolation

The data plane agent is the only component that communicates with the control plane. All other data plane components (workflow engine, runtime manager, Postgres, Redis) have no external network access except:
- Outbound to LLM providers (if using direct provider access)
- Outbound to the customer's internal services (as configured per agent)

NetworkPolicies enforce this isolation.

### Audit trail

The data plane agent logs every message sent to and received from the control plane. These logs are stored in the customer's own logging infrastructure and are available for compliance audit.

---

## Helm charts

### `infra/helm/lantern/` (all-in-one)

The existing unified chart deploys all components into a single cluster. Used for:
- Local development (`values-dev.yaml`)
- Self-hosted deployments where simplicity is preferred over separation
- CI/CD environments

### `infra/helm/lantern-control-plane/`

Deploys only control plane components: gateway, control-plane service, model router, surface gateway, dashboard, billing, scheduler. Includes Postgres, Redis, and MinIO/S3 dependencies. This is what Lantern runs as SaaS.

### `infra/helm/lantern-data-plane/`

Deploys only data plane components: data plane agent, workflow engine, runtime manager. Configured with a `controlPlane.endpoint` that points to the control plane (either `api.lantern.run` or a self-hosted URL). Optionally provisions Postgres and Redis, or accepts external connection strings.

---

## Upgrade strategy

### Control plane upgrades (Lantern-managed)

Lantern performs rolling upgrades of the control plane with zero downtime. The gRPC tunnel protocol is versioned; the control plane maintains backward compatibility with data planes up to 2 minor versions behind.

### Data plane upgrades (customer-managed)

1. `lantern infra upgrade` checks the current data plane version against the latest compatible version.
2. The CLI generates an updated Helm values file and presents a diff.
3. The customer reviews and applies the upgrade via `helm upgrade`.
4. The data plane agent reconnects and re-registers with the new version.
5. In-flight runs complete on the old version; new runs use the new version.

### Version compatibility

The control plane and data plane must be within 2 minor versions of each other. The data plane agent reports its version during registration; the control plane rejects connections from incompatible versions with a clear error message indicating the required upgrade.

---

## Observability

### Data plane metrics (reported to control plane)

- Data plane health status (healthy, degraded, offline)
- Queue depth (pending run assignments)
- Active runs count
- Resource utilization (CPU, memory, disk, GPU)
- Firecracker pool size (warm, cold, total)

### Data plane metrics (local, customer-owned)

- Full OTel traces for every run (spans for each step, tool call, LLM call)
- Structured logs from all data plane components
- Prometheus metrics exported to the customer's monitoring stack
- Run replay data in the local Postgres event journal

The control plane dashboard shows a summary view of data plane health and run status. For detailed debugging, the customer uses their own observability stack with the full trace data that stays in their VPC.

---

## Disaster recovery

### Control plane failure

If the Lantern-hosted control plane goes down:
- In-flight runs on the data plane continue to completion
- The data plane agent queues status updates and delivers them when connectivity is restored
- New runs cannot be triggered via the dashboard or API (they queue at the control plane)
- The data plane is self-sufficient for execution — it has its own Postgres, Redis, and runtime infrastructure

### Data plane failure

If the customer's data plane goes down:
- The control plane marks it as offline after missed heartbeats
- Pending run assignments are held until the data plane recovers
- The customer is notified via their configured notification channels
- On recovery, the workflow engine replays its event journal and resumes in-flight runs

### Multi-data-plane

An enterprise customer can deploy multiple data planes:
- Different regions (e.g., `us-east-1` and `eu-west-1`) for data residency per agent
- Different environments (e.g., `staging` and `production`)
- The control plane routes run assignments to the appropriate data plane based on agent configuration

---

## Related documents

- [01-overview.md](01-overview.md) — Architecture overview
- [04-runtime-isolation.md](04-runtime-isolation.md) — Firecracker, Kata, Wasm isolation
- [10-security.md](10-security.md) — Full security model and threat analysis
- `infra/helm/lantern-control-plane/` — Control plane Helm chart
- `infra/helm/lantern-data-plane/` — Data plane Helm chart
- `services/data-plane-agent/` — Data plane agent service
- `infra/terraform/aws/` — AWS Terraform module
- `infra/terraform/gcp/` — GCP Terraform module
- `infra/terraform/azure/` — Azure Terraform module
