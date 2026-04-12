output "cluster_name" {
  description = "Name of the GKE cluster."
  value       = local.cluster_name
}

output "cluster_endpoint" {
  description = "Endpoint of the GKE cluster API server."
  value       = data.google_container_cluster.target.endpoint
}

output "kubeconfig_command" {
  description = "Command to configure kubectl for the GKE cluster."
  value       = "gcloud container clusters get-credentials ${local.cluster_name} --region ${local.location} --project ${var.project_id}"
}

output "data_plane_status" {
  description = "Instructions to verify the data plane connection."
  value       = <<-EOT
    Data plane deployed to GKE cluster: ${local.cluster_name}
    Control plane endpoint: ${var.lantern_control_plane_endpoint}
    Tenant ID: ${var.tenant_id}

    Verify the connection:
      ${self.kubeconfig_command}
      kubectl -n lantern logs -l app.kubernetes.io/component=data-plane-agent -f
      kubectl -n lantern port-forward svc/lantern-dp-lantern-data-plane-data-plane-agent 8090:8090
      curl http://localhost:8090/status
  EOT
}

output "gcs_bucket" {
  description = "GCS bucket for agent bundles and snapshots."
  value       = google_storage_bucket.bundles.name
}

output "service_account_email" {
  description = "Email of the GCP service account for the data plane."
  value       = google_service_account.data_plane.email
}
