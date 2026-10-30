# Credential-free plan of the GKE data plane (all providers mocked).
# Run: terraform init -backend=false && terraform test

mock_provider "google" {
  mock_data "google_container_cluster" {
    defaults = {
      endpoint    = "203.0.113.10"
      master_auth = [{ cluster_ca_certificate = "Y2E=" }]
    }
  }
  mock_resource "google_service_account" {
    defaults = {
      email = "mock@example-project.iam.gserviceaccount.com"
      name  = "projects/example-project/serviceAccounts/mock@example-project.iam.gserviceaccount.com"
    }
  }
}
mock_provider "kubernetes" {}
mock_provider "helm" {}

variables {
  project_id  = "example-project"
  tenant_id   = "00000000-0000-0000-0000-000000000001"
  agent_token = "example-token"
}

run "new_cluster" {
  command = plan

  assert {
    condition     = length(google_container_cluster.this) == 1 && google_container_cluster.this[0].workload_identity_config[0].workload_pool == "example-project.svc.id.goog"
    error_message = "a new cluster must have Workload Identity on"
  }
  assert {
    condition     = google_storage_bucket_iam_member.data_plane_bundles.role == "roles/storage.objectAdmin"
    error_message = "data-plane storage access must be bucket-scoped"
  }
  assert {
    condition     = !contains([for m in google_project_iam_member.nodes : m.role], "roles/storage.objectAdmin")
    error_message = "the node account must not get storage admin"
  }
  assert {
    condition     = google_storage_bucket.bundles.public_access_prevention == "enforced"
    error_message = "bundles bucket must enforce public access prevention"
  }
  assert {
    condition     = helm_release.pal_data_plane.dependency_update
    error_message = "the local chart's Bitnami deps are not vendored; dependency_update must be on"
  }
}

run "existing_cluster" {
  command = plan
  variables {
    existing_cluster_name = "prod-gke"
  }
  assert {
    condition     = length(google_container_cluster.this) == 0 && length(google_compute_network.this) == 0
    error_message = "an existing cluster must not create a cluster or network"
  }
}
