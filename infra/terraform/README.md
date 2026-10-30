# Data plane Terraform (EKS / GKE / AKS)

One root module per cloud. Each provisions (or attaches to) a managed Kubernetes
cluster, a node pool, object storage for agent bundles, a workload identity for
the data plane, and installs `infra/helm/pal-data-plane` into namespace
`lantern` (docs/architecture/17-deployment-model.md, customer-cloud mode).

| Module | Creates when `existing_cluster_name` is empty | Workload identity |
|---|---|---|
| `aws/` | VPC (3 private + 3 public subnets, NAT), EKS, IAM OIDC provider | IRSA role trusted for `system:serviceaccount:lantern:pal-data-plane` |
| `gcp/` | VPC + subnet (pods/services ranges), Cloud NAT, private GKE | GSA bound via Workload Identity; nodes run as a separate logs/metrics-only GSA |
| `azure/` | resource group, VNet + subnet, NAT gateway, AKS (OIDC + WI on) | user-assigned identity + federated credential (new **and** existing clusters) |

## Use

```bash
cd infra/terraform/aws          # or gcp / azure
terraform init
terraform plan \
  -var tenant_id=<your tenant id> \
  -var agent_token=<data-plane agent token> \
  -var pal_control_plane_endpoint=https://api.your-pal.example.com
# gcp also needs -var project_id=<project>
# existing cluster: -var existing_cluster_name=<name> (aws: + existing_subnet_ids,
#                   azure: + existing_resource_group)
```

`kubernetes_version` defaults to `null` (the cloud's current default) — pin it
explicitly for production. `pal_version` (deprecated alias `lantern_version`) sets the data-plane image tag.

## What is verified (and what is not)

Verified in CI (`sdlc · lint`) and locally with Terraform 1.9.8:

- `terraform fmt -check -recursive`
- `terraform init -backend=false` + `terraform validate` for all three modules
- `terraform test` (`<module>/tests/plan.tftest.hcl`): a full **plan** of each
  module with example inputs against **mocked providers** (no cloud
  credentials), for both the new-cluster and existing-cluster paths, asserting
  the security-relevant wiring: IRSA federates the OIDC provider ARN, GCS
  access is bucket-scoped, Azure storage blocks public containers, every path
  gets a workload-identity binding, and the chart's unvendored Bitnami deps are
  fetched (`dependency_update`).

**Not verified:** a real `plan` against cloud APIs (needs credentials) and any
`apply`. Mocked plans prove the graph and the wiring, not that a given cloud
account, quota or region accepts it. `tflint` has not been run.

Known limits: the GKE control-plane endpoint is public (no
`master_authorized_networks`); AKS kubeconfig uses the cluster's client
certificate (fails if local accounts are disabled); Firecracker needs bare-metal
or nested-virt node types (`firecracker_enabled`).
