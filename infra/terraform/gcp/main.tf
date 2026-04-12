terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.12"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.25"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  create_cluster = var.existing_cluster_name == ""
  cluster_name   = local.create_cluster ? var.cluster_name : var.existing_cluster_name
  location       = var.zone != "" ? var.zone : var.region
}

# ---------------------------------------------------------------------------
# VPC Network
# ---------------------------------------------------------------------------

resource "google_compute_network" "this" {
  count = local.create_cluster ? 1 : 0

  name                    = var.network
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "this" {
  count = local.create_cluster ? 1 : 0

  name          = var.subnetwork
  ip_cidr_range = var.subnet_cidr
  region        = var.region
  network       = google_compute_network.this[0].id

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }
}

# Cloud NAT for outbound connectivity (data plane agent -> control plane).
resource "google_compute_router" "this" {
  count = local.create_cluster ? 1 : 0

  name    = "${var.cluster_name}-router"
  region  = var.region
  network = google_compute_network.this[0].id
}

resource "google_compute_router_nat" "this" {
  count = local.create_cluster ? 1 : 0

  name                               = "${var.cluster_name}-nat"
  router                             = google_compute_router.this[0].name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# ---------------------------------------------------------------------------
# Service Account
# ---------------------------------------------------------------------------

resource "google_service_account" "data_plane" {
  account_id   = "${var.cluster_name}-dp"
  display_name = "Lantern Data Plane Service Account"
}

resource "google_project_iam_member" "data_plane_storage" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.data_plane.email}"
}

# ---------------------------------------------------------------------------
# GCS Bucket for agent bundles and snapshots
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "bundles" {
  name          = "${var.project_id}-lantern-bundles"
  location      = var.region
  force_destroy = false

  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  encryption {
    default_kms_key_name = ""  # Uses Google-managed encryption by default.
  }

  labels = var.labels
}

# ---------------------------------------------------------------------------
# GKE Cluster (created only if no existing cluster is provided)
# ---------------------------------------------------------------------------

resource "google_container_cluster" "this" {
  count = local.create_cluster ? 1 : 0

  name     = var.cluster_name
  location = local.location

  network    = google_compute_network.this[0].id
  subnetwork = google_compute_subnetwork.this[0].id

  # Use a separately managed node pool.
  remove_default_node_pool = true
  initial_node_count       = 1

  min_master_version = var.kubernetes_version

  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # Private cluster: nodes have no public IPs, use Cloud NAT for outbound.
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  release_channel {
    channel = "REGULAR"
  }

  resource_labels = var.labels
}

# ---------------------------------------------------------------------------
# GKE Node Pool
# ---------------------------------------------------------------------------

resource "google_container_node_pool" "lantern" {
  name     = "lantern-nodes"
  location = local.location
  cluster  = local.create_cluster ? google_container_cluster.this[0].name : var.existing_cluster_name

  initial_node_count = var.node_count

  autoscaling {
    min_node_count = var.node_min_count
    max_node_count = var.node_max_count
  }

  node_config {
    machine_type = var.machine_type

    service_account = google_service_account.data_plane.email
    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]

    labels = {
      "lantern.run/component" = "data-plane"
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

# ---------------------------------------------------------------------------
# Workload Identity binding
# ---------------------------------------------------------------------------

resource "google_service_account_iam_member" "workload_identity" {
  service_account_id = google_service_account.data_plane.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[lantern/lantern-data-plane]"
}

# ---------------------------------------------------------------------------
# Kubernetes and Helm providers
# ---------------------------------------------------------------------------

data "google_container_cluster" "target" {
  name     = local.cluster_name
  location = local.location

  depends_on = [google_container_cluster.this]
}

data "google_client_config" "current" {}

provider "kubernetes" {
  host                   = "https://${data.google_container_cluster.target.endpoint}"
  token                  = data.google_client_config.current.access_token
  cluster_ca_certificate = base64decode(data.google_container_cluster.target.master_auth[0].cluster_ca_certificate)
}

provider "helm" {
  kubernetes {
    host                   = "https://${data.google_container_cluster.target.endpoint}"
    token                  = data.google_client_config.current.access_token
    cluster_ca_certificate = base64decode(data.google_container_cluster.target.master_auth[0].cluster_ca_certificate)
  }
}

# ---------------------------------------------------------------------------
# Namespace
# ---------------------------------------------------------------------------

resource "kubernetes_namespace" "lantern" {
  metadata {
    name = "lantern"

    labels = {
      "app.kubernetes.io/part-of"    = "lantern-data-plane"
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  depends_on = [google_container_node_pool.lantern]
}

# ---------------------------------------------------------------------------
# Deploy lantern-data-plane Helm chart
# ---------------------------------------------------------------------------

resource "helm_release" "lantern_data_plane" {
  name       = "lantern-dp"
  namespace  = kubernetes_namespace.lantern.metadata[0].name
  chart      = "${path.module}/../../helm/lantern-data-plane"
  version    = var.lantern_version
  wait       = true
  timeout    = 600

  set {
    name  = "controlPlane.endpoint"
    value = var.lantern_control_plane_endpoint
  }

  set {
    name  = "controlPlane.tenantId"
    value = var.tenant_id
  }

  set_sensitive {
    name  = "controlPlane.agentToken"
    value = var.agent_token
  }

  set {
    name  = "runtimeManager.firecrackerEnabled"
    value = tostring(var.firecracker_enabled)
  }

  set {
    name  = "serviceAccount.annotations.iam\\.gke\\.io/gcp-service-account"
    value = google_service_account.data_plane.email
  }

  # Use GCS instead of MinIO in production.
  set {
    name  = "minio.enabled"
    value = "false"
  }

  set {
    name  = "minio.external.endpoint"
    value = "https://storage.googleapis.com"
  }

  set {
    name  = "minio.external.bucket"
    value = google_storage_bucket.bundles.name
  }

  depends_on = [
    kubernetes_namespace.lantern,
    google_container_node_pool.lantern,
  ]
}
