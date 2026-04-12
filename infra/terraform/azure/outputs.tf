output "cluster_name" {
  description = "Name of the AKS cluster."
  value       = local.cluster_name
}

output "cluster_endpoint" {
  description = "FQDN of the AKS cluster API server."
  value       = data.azurerm_kubernetes_cluster.target.fqdn
}

output "kubeconfig_command" {
  description = "Command to configure kubectl for the AKS cluster."
  value       = "az aks get-credentials --resource-group ${local.rg_name} --name ${local.cluster_name}"
}

output "data_plane_status" {
  description = "Instructions to verify the data plane connection."
  value       = <<-EOT
    Data plane deployed to AKS cluster: ${local.cluster_name}
    Control plane endpoint: ${var.lantern_control_plane_endpoint}
    Tenant ID: ${var.tenant_id}

    Verify the connection:
      ${self.kubeconfig_command}
      kubectl -n lantern logs -l app.kubernetes.io/component=data-plane-agent -f
      kubectl -n lantern port-forward svc/lantern-dp-lantern-data-plane-data-plane-agent 8090:8090
      curl http://localhost:8090/status
  EOT
}

output "storage_account" {
  description = "Azure Storage Account for agent bundles and snapshots."
  value       = azurerm_storage_account.bundles.name
}

output "managed_identity_client_id" {
  description = "Client ID of the managed identity for the data plane."
  value       = azurerm_user_assigned_identity.data_plane.client_id
}

output "resource_group" {
  description = "Azure resource group name."
  value       = local.rg_name
}
