# Credential-free plan of the AKS data plane (all providers mocked).
# Run: terraform init -backend=false && terraform test

mock_provider "azurerm" {
  mock_data "azurerm_subscription" {
    defaults = { subscription_id = "00000000-0000-0000-0000-0000000000aa" }
  }
  mock_data "azurerm_kubernetes_cluster" {
    defaults = {
      id              = "/subscriptions/00000000-0000-0000-0000-0000000000aa/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/aks"
      oidc_issuer_url = "https://eastus.oic.prod-aks.azure.com/tenant/issuer/"
      kube_config = [{
        host                   = "https://aks.example.azmk8s.io"
        client_certificate     = "Y2VydA=="
        client_key             = "a2V5"
        cluster_ca_certificate = "Y2E="
      }]
    }
  }
  mock_resource "azurerm_resource_group" {
    defaults = { name = "pal-data-plane-rg", location = "eastus" }
  }
  mock_resource "azurerm_subnet" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-0000000000aa/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/s" }
  }
  mock_resource "azurerm_user_assigned_identity" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-0000000000aa/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/dp" }
  }
  mock_resource "azurerm_storage_account" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-0000000000aa/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/sa" }
  }
  mock_resource "azurerm_nat_gateway" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-0000000000aa/resourceGroups/rg/providers/Microsoft.Network/natGateways/n" }
  }
  mock_resource "azurerm_public_ip" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-0000000000aa/resourceGroups/rg/providers/Microsoft.Network/publicIPAddresses/p" }
  }
}
mock_provider "kubernetes" {}
mock_provider "helm" {}

variables {
  tenant_id   = "00000000-0000-0000-0000-000000000001"
  agent_token = "example-token"
}

run "new_cluster" {
  command = plan

  assert {
    condition     = can(regex("^[a-z0-9]{3,24}$", azurerm_storage_account.bundles.name))
    error_message = "storage account name must be 3-24 lowercase alphanumerics"
  }
  assert {
    condition     = azurerm_storage_account.bundles.allow_nested_items_to_be_public == false
    error_message = "blob containers must not be publicly readable"
  }
  assert {
    condition     = azurerm_federated_identity_credential.data_plane.subject == "system:serviceaccount:pal:pal-data-plane"
    error_message = "workload identity must federate the chart's service account"
  }
}

run "existing_cluster_still_federates" {
  command = plan
  variables {
    existing_cluster_name   = "prod-aks"
    existing_resource_group = "prod-rg"
  }
  assert {
    condition     = length(azurerm_kubernetes_cluster.this) == 0 && azurerm_federated_identity_credential.data_plane.issuer == "https://eastus.oic.prod-aks.azure.com/tenant/issuer/"
    error_message = "an existing cluster must still get a federated credential from its OIDC issuer"
  }
}
